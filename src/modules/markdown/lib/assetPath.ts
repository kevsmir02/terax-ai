// Pure helpers for pointing a markdown file's relative images at disk.

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Absolute path of `src` as the markdown file at `base` would resolve it, or
 * null when `src` is not a plain relative reference (remote, data:, anchor,
 * root-relative or empty). Query and fragment are dropped and percent escapes
 * decoded, as a browser would before asking the file system.
 */
export function resolveRelativeAsset(base: string, src: string): string | null {
  const bare = src.trim().split(/[?#]/)[0];
  if (!bare || bare.startsWith("/") || bare.startsWith("\\")) return null;
  if (WINDOWS_DRIVE.test(bare)) return null;
  if (URL_SCHEME.test(bare)) return null;

  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    /* keep the raw text */
  }

  const backslashes = base.includes("\\") && !base.includes("/");
  const dirEnd = Math.max(base.lastIndexOf("/"), base.lastIndexOf("\\"));
  if (dirEnd < 0) return null;
  const [root, ...stack] = base.slice(0, dirEnd).replace(/\\/g, "/").split("/");

  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const joined = [root, ...stack].join("/");
  return backslashes ? joined.replace(/\//g, "\\") : joined;
}

const LOCAL_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "ico",
]);

const ASSET_URL = /^(?:asset:|(?:https?:)?\/\/asset\.localhost)/i;

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Collapses `.`/`..` and duplicate separators without touching the file
 * system. A path is compared in this form so a spelling such as
 * `/project/../outside/readme.md` is never mistaken for a document inside
 * `/project`.
 */
function normalizePath(path: string): string {
  const posix = toPosix(path);
  const drive = posix.match(/^[a-zA-Z]:/)?.[0] ?? "";
  const rest = drive ? posix.slice(drive.length) : posix;
  const absolute = rest.startsWith("/");
  const stack: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!absolute) stack.push("..");
    } else {
      stack.push(part);
    }
  }
  const joined = stack.join("/");
  if (drive) return `${drive}/${joined}`;
  return absolute ? `/${joined}` : joined || ".";
}

function dirOf(path: string): string {
  const posix = toPosix(path);
  const i = posix.lastIndexOf("/");
  return i <= 0 ? posix.slice(0, i + 1) : posix.slice(0, i);
}

/** Lexical containment of two normalized paths. */
export function isInsideRoot(root: string, abs: string): boolean {
  let r = normalizePath(root).replace(/\/+$/, "");
  let a = normalizePath(abs);
  if (/^[a-zA-Z]:/.test(r)) {
    r = r.toLowerCase();
    a = a.toLowerCase();
  }
  return a.startsWith(`${r}/`);
}

/**
 * The tree a preview may load images from: the workspace root when the
 * document lives in it, otherwise the document's own folder.
 */
export function previewBoundary(
  docPath: string,
  workspaceRoot: string | null,
): string {
  return workspaceRoot && isInsideRoot(workspaceRoot, docPath)
    ? normalizePath(workspaceRoot)
    : dirOf(normalizePath(docPath));
}

export type LocalImagePolicy = {
  boundary: string;
  /** False for secret paths; the shared read guard in production (`modules/workspace/policy`). */
  isReadable: (absolutePath: string) => boolean;
  /**
   * Absolute paths the person explicitly allowed for this document. A grant can
   * widen the boundary for one file but never bypasses `isReadable`, so a
   * protected path stays blocked even if a document names it.
   */
  granted?: ReadonlySet<string>;
  /**
   * True only after the person chose to load this document's remote images.
   * Without it neither an `<img>` nor a blocked placeholder references the
   * network, so rendering a document never fetches anything.
   */
  allowRemote?: boolean;
};

function imageExtension(path: string): string | null {
  const name = toPosix(path).split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
}

function isImagePath(abs: string): boolean {
  const ext = imageExtension(abs);
  return ext !== null && LOCAL_IMAGE_EXTENSIONS.has(ext);
}

/**
 * What a document's `<img src>` points at, relative to the document and the
 * boundary it may load from. Classification never resolves symlinks; the
 * native asset grant is the authority for canonical containment.
 */
export type ImageReference =
  | { kind: "local"; absolutePath: string }
  | { kind: "outside"; absolutePath: string }
  | { kind: "protected"; absolutePath: string }
  | { kind: "unsupported"; reference: string }
  | { kind: "remote"; url: string }
  | { kind: "inline" }
  | { kind: "injected" }
  | { kind: "none" };

/**
 * Classifies one image reference. `local` loads automatically, `outside` needs
 * an explicit grant, `protected` is never offered, `remote` needs deliberate
 * consent and `injected`/`unsupported`/`none` are left for the transform to
 * drop or ignore.
 */
export function classifyImageReference(
  basePath: string,
  src: string,
  policy: LocalImagePolicy,
): ImageReference {
  const trimmed = src.trim();
  if (!trimmed) return { kind: "none" };
  if (ASSET_URL.test(trimmed)) return { kind: "injected" };
  if (/^data:/i.test(trimmed)) return { kind: "inline" };
  if (/^https?:/i.test(trimmed) || trimmed.startsWith("//")) {
    return { kind: "remote", url: trimmed };
  }
  // Absolute and drive-rooted references are not automatic embeds: they are
  // left as written, never turned into an asset URL.
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    WINDOWS_DRIVE.test(trimmed)
  ) {
    return { kind: "unsupported", reference: trimmed };
  }
  const resolved = resolveRelativeAsset(basePath, trimmed);
  if (!resolved) return { kind: "none" };
  const absolutePath = normalizePath(resolved);
  if (!isImagePath(absolutePath)) {
    return { kind: "unsupported", reference: trimmed };
  }
  if (!policy.isReadable(absolutePath)) {
    return { kind: "protected", absolutePath };
  }
  return isInsideRoot(policy.boundary, absolutePath)
    ? { kind: "local", absolutePath }
    : { kind: "outside", absolutePath };
}

/**
 * The asset protocol is scoped to the whole disk, so a preview may only turn a
 * path into an asset URL when it stays under `boundary`, is an image type and
 * is not a secret path. Symlinks are not resolved here.
 */
export function isAllowedLocalImage(
  abs: string,
  policy: LocalImagePolicy,
): boolean {
  return (
    isImagePath(abs) &&
    isInsideRoot(policy.boundary, abs) &&
    policy.isReadable(abs)
  );
}

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
  /** Offset of the node in the source; stable across re-renders and blocks. */
  position?: {
    start?: { line?: number; column?: number; offset?: number };
  };
};

const BLOCKED_IMAGE_REASON: Record<string, string> = {
  remote: "remote image blocked",
  outside: "image outside the project folder blocked",
  protected: "protected image blocked",
};

/**
 * Replaces an image the policy will not load with visible text, so the reader
 * learns why it is missing instead of seeing a broken icon or a blank space.
 * The element is app-created (never document HTML) and carries no URL.
 */
/**
 * Stable identity for one rendered image. Streamdown transforms each block
 * separately (and may serve a block from its HTML cache), so a per-transform
 * counter would move between renders. The source offset is stable, and the
 * fallback counter only covers a synthetic tree that has no positions.
 */
function imageKey(node: HastNode, keyFor: (src: string) => string): string {
  const start = node.position?.start;
  if (typeof start?.offset === "number") return `o${start.offset}`;
  if (typeof start?.line === "number" && typeof start?.column === "number") {
    return `l${start.line}c${start.column}`;
  }
  const src =
    typeof node.properties?.src === "string" ? node.properties.src : "";
  return keyFor(src);
}

function blockImage(
  node: HastNode,
  kind: keyof typeof BLOCKED_IMAGE_REASON,
): void {
  const src =
    typeof node.properties?.src === "string" ? node.properties.src : "";
  const alt =
    typeof node.properties?.alt === "string" ? node.properties.alt.trim() : "";
  const subject = (alt || src).replace(/\s+/g, " ").slice(0, 160);
  node.tagName = "span";
  node.properties = { className: ["terax-md-blocked-asset"] };
  node.children = [
    { type: "text", value: `[${BLOCKED_IMAGE_REASON[kind]}: ${subject}]` },
  ];
}

/**
 * Tags an image the bounded inline-image surface manages. The path comes from
 * the policy decision above, never from document HTML; `key` distinguishes
 * repeated references so each rendered image owns its own admission slot.
 */
function markManagedImage(
  node: HastNode,
  kind: "file" | "remote" | "data",
  key: string,
  absolutePath?: string,
  guard?: string,
): void {
  if (!node.properties) node.properties = {};
  node.properties["data-terax-image"] = kind;
  node.properties["data-terax-image-key"] = key;
  if (absolutePath) node.properties["data-terax-image-path"] = absolutePath;
  // Only an automatic local image carries the document boundary. An outside
  // file the person granted is probed under that explicit consent instead.
  if (guard) node.properties["data-terax-image-guard"] = guard;
}

/**
 * Rehype plugin that rewrites relative `<img src>` to `toUrl(absolutePath)` when
 * `policy` allows it. Every other reference is handled explicitly:
 *
 * - a relative image beyond the boundary is replaced by a notice unless the
 *   person granted that exact file for this document;
 * - a protected (secret) path is never rewritten, even when "granted";
 * - a remote image is left out until `allowRemote` says the person consented;
 * - a non-image or absolute reference keeps its text (it will not load), and a
 *   document-supplied asset-protocol URL is dropped outright.
 *
 * An allowed image is tagged with the source the bounded inline-image surface
 * needs: the absolute path for a local file, the reference kind otherwise.
 *
 * It has to run after sanitize (which strips the asset scheme) and before
 * harden (which would block a relative URL it cannot resolve).
 */
export function rehypeLocalImages(
  basePath: string,
  toUrl: (absolutePath: string) => string | undefined,
  policy: LocalImagePolicy,
) {
  const rewrite = (node: HastNode, keyFor: (src: string) => string): void => {
    if (node.type === "element" && node.tagName === "img") {
      const src = node.properties?.src;
      if (typeof src === "string" && node.properties) {
        const ref = classifyImageReference(basePath, src, policy);
        switch (ref.kind) {
          case "local": {
            const url = toUrl(ref.absolutePath);
            node.properties.src = url ?? "data:,";
            if (url) {
              markManagedImage(
                node,
                "file",
                imageKey(node, keyFor),
                ref.absolutePath,
                policy.boundary,
              );
            }
            break;
          }
          case "outside": {
            if (policy.granted?.has(ref.absolutePath)) {
              const url = toUrl(ref.absolutePath);
              node.properties.src = url ?? "data:,";
              if (url) {
                markManagedImage(
                  node,
                  "file",
                  imageKey(node, keyFor),
                  ref.absolutePath,
                );
              }
            } else {
              blockImage(node, "outside");
            }
            break;
          }
          case "protected":
            blockImage(node, "protected");
            break;
          case "remote":
            if (!policy.allowRemote) blockImage(node, "remote");
            else markManagedImage(node, "remote", imageKey(node, keyFor));
            break;
          case "injected":
            delete node.properties.src;
            break;
          case "inline":
            markManagedImage(node, "data", imageKey(node, keyFor));
            break;
          case "unsupported":
          case "none":
            break;
        }
      }
    }
    node.children?.forEach((child) => {
      rewrite(child, keyFor);
    });
  };
  // Streamdown keys its rendered-HTML cache by a plugin's *function name*
  // (`plugin.name`), not by the closure. Two policies with the same name would
  // therefore share cached HTML: a document rendered before a grant landed
  // would keep its blocked placeholders after consent, and two documents with
  // the same text could reuse each other's asset URLs. Encode the policy and
  // the resolver identity in the name so the cache follows the actual policy.
  const plugin = () => {
    // One counter per rendered policy, so a repeated reference gets a distinct
    // key without depending on where the block boundary fell.
    const seen = new Map<string, number>();
    const keyFor = (src: string): string => {
      const next = (seen.get(src) ?? 0) + 1;
      seen.set(src, next);
      return `${src}#${next}`;
    };
    return (tree: unknown) => rewrite(tree as HastNode, keyFor);
  };
  Object.defineProperty(plugin, "name", {
    value: `rehypeLocalImages(${policySignature(basePath, toUrl, policy)})`,
  });
  return plugin;
}

let nextResolverId = 0;
const resolverIds = new WeakMap<object, number>();

/** Stable id for one `toUrl` function identity (it changes when a grant lands). */
function resolverId(
  resolver: (absolutePath: string) => string | undefined,
): number {
  let id = resolverIds.get(resolver);
  if (id === undefined) {
    id = ++nextResolverId;
    resolverIds.set(resolver, id);
  }
  return id;
}

function policySignature(
  basePath: string,
  toUrl: (absolutePath: string) => string | undefined,
  policy: LocalImagePolicy,
): string {
  const granted = policy.granted ? [...policy.granted].sort().join(";") : "";
  return [
    basePath,
    policy.boundary,
    policy.allowRemote ? "remote" : "local",
    granted,
    resolverId(toUrl),
  ].join("|");
}

/**
 * Image routing and measured runtime decode support.
 *
 * These are two different facts and this module keeps them apart:
 *
 * - **Routing** is the extension table the editor uses to send a file to the
 *   image surface instead of the binary notice. It is a guess based on the
 *   name, nothing more.
 * - **Decode support** is whether the WebKitGTK build actually rendered a
 *   representative file of that format. It was measured, not inferred, on the
 *   primary Fedora host (see `evidence` per format). A routed extension with no
 *   measurement must never be presented as supported.
 *
 * The decoded-byte ceiling only applies to raster formats. SVG is a vector
 * document: the browser rasterizes it at the displayed size, so it does not
 * allocate an intrinsic raster the 64 MiB contract can measure.
 */

export type ImageFormat =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "bmp"
  | "ico"
  | "avif"
  | "svg";

export type ImageDecodeSupport = "verified" | "unsupported";

export type ImageFormatInfo = {
  /** Canonical id, matching the native probe's `format` string. */
  readonly id: ImageFormat;
  readonly extensions: readonly string[];
  readonly mime: string;
  /** Raster formats consume decoded bytes; vectors do not. */
  readonly kind: "raster" | "vector";
  /** True when an explicitly opened file is handed to the image surface. */
  readonly routed: boolean;
  readonly decode: ImageDecodeSupport;
  /** Where the decode support was measured, never an extension assumption. */
  readonly evidence: string;
  /** Why an unrouted format still has a measured decode, when it does. */
  readonly note?: string;
};

const FEDORA_EVIDENCE =
  "Fedora 44 KDE Wayland, WebKitGTK 2.54.2: decoded by the real app-lab run " +
  "(2026-11-12) and by an engine probe with naturalWidth 64x64";

export const IMAGE_FORMATS: Record<ImageFormat, ImageFormatInfo> = {
  png: {
    id: "png",
    extensions: ["png"],
    mime: "image/png",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  jpeg: {
    id: "jpeg",
    extensions: ["jpg", "jpeg"],
    mime: "image/jpeg",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  gif: {
    id: "gif",
    extensions: ["gif"],
    mime: "image/gif",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  webp: {
    id: "webp",
    extensions: ["webp"],
    mime: "image/webp",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  bmp: {
    id: "bmp",
    extensions: ["bmp"],
    mime: "image/bmp",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  ico: {
    id: "ico",
    extensions: ["ico"],
    mime: "image/x-icon",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  avif: {
    id: "avif",
    extensions: ["avif"],
    mime: "image/avif",
    kind: "raster",
    routed: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  svg: {
    id: "svg",
    extensions: ["svg"],
    mime: "image/svg+xml",
    kind: "vector",
    // SVG is editable text in a file tab; the webview decodes it inline, but
    // an explicitly opened .svg stays in the editor rather than the viewer.
    routed: false,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured as inline/embedded SVG; an explicitly opened .svg remains an editable text tab",
  },
};

const BY_EXTENSION: ReadonlyMap<string, ImageFormatInfo> = new Map(
  Object.values(IMAGE_FORMATS).flatMap((info) =>
    info.extensions.map((extension) => [extension, info] as const),
  ),
);

/** Every extension routed to the image surface (lowercase, no dot). */
export function routedImageExtensions(): readonly string[] {
  return [...BY_EXTENSION.entries()]
    .filter(([, info]) => info.routed)
    .map(([extension]) => extension);
}

/**
 * The format a path routes to, or null when the file is not routed as an
 * image. This is the routing decision only; callers must still check
 * {@link imageDecodeSupport} before claiming the file can be shown.
 */
export function imageFormatForPath(path: string): ImageFormat | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const info = BY_EXTENSION.get(extension);
  return info?.routed ? info.id : null;
}

/**
 * Format of an image embedded in a document. Unlike {@link imageFormatForPath}
 * this includes SVG: an explicitly opened `.svg` stays an editable text tab,
 * but the same file referenced by a Markdown document is rendered as an
 * inline vector (measured in the `images` app-lab scenario).
 */
export function imageFormatForEmbeddedPath(path: string): ImageFormat | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase())?.id ?? null;
}

/** The table entry for a canonical format id, or null when unmeasured. */
export function imageFormatInfo(format: string): ImageFormatInfo | null {
  return format in IMAGE_FORMATS ? IMAGE_FORMATS[format as ImageFormat] : null;
}

/**
 * Measured runtime decode support for a format id. Anything the table does not
 * carry is `unsupported`: routing an extension is not evidence the webview can
 * decode the file.
 */
export function imageDecodeSupport(format: string): ImageDecodeSupport {
  return imageFormatInfo(format)?.decode ?? "unsupported";
}

/** True when decoded bytes are the right resource to bound for this format. */
export function isRasterImageFormat(format: string): boolean {
  return imageFormatInfo(format)?.kind === "raster";
}

const LABELS: Record<ImageFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  gif: "GIF",
  webp: "WebP",
  bmp: "BMP",
  ico: "ICO",
  avif: "AVIF",
  svg: "SVG",
};

/** Human name for a format id; unknown ids are uppercased, never hidden. */
export function imageFormatLabel(format: string): string {
  return format in LABELS
    ? LABELS[format as ImageFormat]
    : format.toUpperCase();
}

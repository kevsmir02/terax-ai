// Pure analysis of the image references a Markdown document contains.
//
// Rendering never fetches a remote resource and never loads a local file beyond
// the document's boundary on its own. This scan produces the counts and the
// candidates the interface may offer as an *explicit* choice; the rehype
// transform remains authoritative, so a reference this scan misses is simply
// left blocked rather than loaded.

import { classifyImageReference, type LocalImagePolicy } from "./assetPath";

/** A Markdown inline/reference image destination or a raw `<img src>`. */
const INLINE_IMAGE =
  /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+["'(][^)]*)?\s*\)/g;
const HTML_IMAGE =
  /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export type DocumentAssetSummary = {
  /** Distinct readable image files beyond the boundary the person may allow. */
  readonly outside: readonly string[];
  /** Distinct remote image URLs that need deliberate consent. */
  readonly remote: readonly string[];
  /** Distinct protected (secret-path) images that can never be allowed. */
  readonly blocked: number;
};

export const EMPTY_DOCUMENT_ASSETS: DocumentAssetSummary = {
  outside: [],
  remote: [],
  blocked: 0,
};

/**
 * Image syntax inside a fenced code block is example text, not a reference the
 * renderer acts on. Dropping fences keeps the notice's counts aligned with what
 * the transform actually sees.
 */
function withoutFencedCode(content: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence !== null) {
      if (marker && marker[1].startsWith(fence[0])) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function references(content: string): string[] {
  const found: Array<{ at: number; src: string }> = [];
  const body = withoutFencedCode(content);
  for (const match of body.matchAll(INLINE_IMAGE)) {
    const src = match[1] ?? match[2];
    if (src) found.push({ at: match.index ?? 0, src });
  }
  for (const match of body.matchAll(HTML_IMAGE)) {
    const src = match[1] ?? match[2] ?? match[3];
    if (src) found.push({ at: match.index ?? 0, src });
  }
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.src);
}

/**
 * Summarises what a document would load from disk or the network. `boundary` is
 * the document's resolution root (`previewBoundary`): the configured Space
 * project root when the document lives inside it, otherwise the document's own
 * directory. A terminal cwd never participates.
 */
export function documentAssetSummary(
  content: string,
  basePath: string,
  policy: LocalImagePolicy,
): DocumentAssetSummary {
  const outside = new Set<string>();
  const remote = new Set<string>();
  const blocked = new Set<string>();
  for (const src of references(content)) {
    const ref = classifyImageReference(basePath, src, policy);
    if (ref.kind === "outside") outside.add(ref.absolutePath);
    else if (ref.kind === "remote") remote.add(ref.url);
    else if (ref.kind === "protected") blocked.add(ref.absolutePath);
  }
  return { outside: [...outside], remote: [...remote], blocked: blocked.size };
}

/** What the person has explicitly allowed for one document. */
export type DocumentAssetConsent = {
  readonly remote: boolean;
  readonly granted: readonly string[];
};

export const NO_DOCUMENT_ASSET_CONSENT: DocumentAssetConsent = {
  remote: false,
  granted: [],
};

/**
 * Applies one explicit choice. Only files the summary classified as `outside`
 * are ever granted, so a protected path cannot be admitted by consent.
 */
export function grantDocumentAssets(
  summary: DocumentAssetSummary,
  current: DocumentAssetConsent,
  choice: "outside" | "remote",
): DocumentAssetConsent {
  if (choice === "remote") {
    return summary.remote.length > 0 ? { ...current, remote: true } : current;
  }
  if (summary.outside.length === 0) return current;
  return {
    ...current,
    granted: [...new Set([...current.granted, ...summary.outside])],
  };
}

/**
 * Identity of the *rendered policy* for one document. Streamdown memoises on
 * the Markdown text alone, so this key forces a remount when a grant lands, a
 * consent choice changes or the document/boundary changes.
 */
export function markdownRenderKey(input: {
  readonly path: string;
  readonly boundary: string;
  readonly allowRemote: boolean;
  readonly granted: ReadonlySet<string> | undefined;
  readonly assetVersion: number;
}): string {
  const granted = input.granted ? [...input.granted].sort().join(";") : "";
  return [
    input.path,
    input.boundary,
    input.allowRemote ? "remote" : "local",
    granted,
    input.assetVersion,
  ].join("\u0000");
}

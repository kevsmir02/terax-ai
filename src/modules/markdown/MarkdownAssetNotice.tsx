// The explicit-consent surface for document assets.
//
// A document never triggers a network fetch or reaches outside its boundary on
// its own. What it references is summarised here, and only a button the person
// presses turns those references into a load. Protected paths are named as
// blocked and get no button at all.

import type {
  DocumentAssetConsent,
  DocumentAssetSummary,
} from "./lib/documentAssets";

type Props = {
  summary: DocumentAssetSummary;
  consent: DocumentAssetConsent;
  /** The folder automatic local images come from. */
  boundary: string;
  onAllowOutside: () => void;
  onLoadRemote: () => void;
};

function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

export function MarkdownAssetNotice({
  summary,
  consent,
  boundary,
  onAllowOutside,
  onLoadRemote,
}: Props) {
  const outside = summary.outside.filter(
    (path) => !consent.granted.includes(path),
  );
  const remote = consent.remote ? 0 : summary.remote.length;
  const blocked = summary.blocked;
  if (outside.length === 0 && remote === 0 && blocked === 0) return null;

  return (
    <div
      role="note"
      data-markdown-asset-notice
      className="mb-4 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      {remote > 0 && (
        <p>
          This document references{" "}
          {count(remote, "1 remote image", "remote images")}. Nothing has been
          fetched.
        </p>
      )}
      {outside.length > 0 && (
        <p>
          {count(outside.length, "1 image is", "images are")} outside{" "}
          <span className="font-mono text-foreground/80">{boundary}</span> and
          not loaded.
        </p>
      )}
      {blocked > 0 && (
        <p>
          {count(blocked, "1 protected image stays", "protected images stay")}{" "}
          blocked.
        </p>
      )}
      {(remote > 0 || outside.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {remote > 0 && (
            <button
              type="button"
              onClick={onLoadRemote}
              className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-accent"
            >
              Load {count(remote, "1 remote image", `${remote} remote images`)}
            </button>
          )}
          {outside.length > 0 && (
            <button
              type="button"
              onClick={onAllowOutside}
              className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-accent"
            >
              Allow{" "}
              {count(outside.length, "1 image", `${outside.length} images`)}{" "}
              outside
            </button>
          )}
        </div>
      )}
    </div>
  );
}

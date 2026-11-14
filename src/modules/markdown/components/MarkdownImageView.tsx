// Presentational half of a bounded Markdown inline image.
//
// The container (`MarkdownImage`) wires the native header probe, the shared
// decoded ceiling and the decoded-viewer table; this component only draws the
// state. Keeping it presentational means every outcome (probing, refused,
// waiting for admission, released for budget, ready) is asserted in a plain
// render test, and the over-ceiling case can prove no `<img>` exists.

import { ALTERNATIVE_LABELS } from "@/modules/preview/AssetDeliveryNotice";
import type { LimitAlternative } from "@/modules/preview/lib/limits";
import type {
  MarkdownImageSource,
  MarkdownImageState,
} from "../lib/inlineImage";
import { markdownImageMounts } from "../lib/inlineImage";

type Props = {
  state: MarkdownImageState;
  source: MarkdownImageSource;
  /** The resolved URL (asset protocol for a local file, the reference itself otherwise). */
  src: string;
  alt?: string;
  title?: string;
  onLoaded?: (size: { width: number; height: number }) => void;
  onDecodeFailed?: () => void;
  onRetry?: () => void;
};

type Notice = {
  readonly title: string;
  readonly reason: string;
  readonly alternatives: readonly LimitAlternative[];
  readonly retry: boolean;
};

function noticeFor(state: MarkdownImageState): Notice | null {
  switch (state.kind) {
    case "unsupported-format":
      return {
        title: "Image format not supported",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: false,
      };
    case "corrupt":
      return {
        title: "Image could not be decoded",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: state.retryable,
      };
    case "unreadable":
      return {
        title: "Image could not be read",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: true,
      };
    case "oversized":
      return {
        title: "Image too large to decode",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: false,
      };
    case "admission-refused":
      return {
        title: "No room for another decoded preview",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: false,
      };
    case "evicted":
      return {
        title: "Image released to keep memory bounded",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: false,
      };
    case "decode-error":
      return {
        title: "Image could not be rendered",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: state.retryable,
      };
    case "file-too-large":
      return {
        title: "Image file too large to preview",
        reason: state.reason,
        alternatives: state.alternatives,
        retry: false,
      };
    default:
      return null;
  }
}

export function MarkdownImageView({
  state,
  source,
  src,
  alt,
  title,
  onLoaded,
  onDecodeFailed,
  onRetry,
}: Props) {
  const mounted = markdownImageMounts(source, state);
  const notice = noticeFor(state);
  return (
    <span
      data-markdown-image-state={state.kind}
      data-markdown-image-src={src}
      data-markdown-image-alt={alt ?? ""}
      className="my-2 inline-block max-w-full align-top"
    >
      {mounted ? (
        <img
          data-streamdown="image"
          data-markdown-image=""
          data-markdown-image-bytes={
            state.kind === "ready" ? state.decodedBytes : undefined
          }
          src={src}
          alt={alt ?? ""}
          title={title}
          width={
            state.kind === "ready" && state.width !== null
              ? state.width
              : undefined
          }
          height={
            state.kind === "ready" && state.height !== null
              ? state.height
              : undefined
          }
          loading="lazy"
          decoding="async"
          className="h-auto max-w-full rounded-md border border-border"
          onLoad={(event) => {
            const element = event.currentTarget;
            onLoaded?.({
              width: element.naturalWidth,
              height: element.naturalHeight,
            });
          }}
          onError={onDecodeFailed}
        />
      ) : notice ? (
        <span
          role="note"
          data-markdown-image-notice={state.kind}
          className="block rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          <span className="font-medium text-foreground">{notice.title}</span>{" "}
          {notice.reason}
          {notice.alternatives.length > 0 && (
            <span className="block text-[11px] text-muted-foreground/80">
              {notice.alternatives
                .map((alternative) => ALTERNATIVE_LABELS[alternative])
                .join(" · ")}
            </span>
          )}
          {notice.retry && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent"
            >
              Retry
            </button>
          )}
        </span>
      ) : state.kind === "probing" || state.kind === "admitting" ? (
        <span className="text-xs text-muted-foreground">Loading image…</span>
      ) : null}
    </span>
  );
}

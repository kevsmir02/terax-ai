import { AssetDeliveryNotice } from "./AssetDeliveryNotice";
import { mediaKind, mediaSupportSummary } from "./lib/mediaFormats";
import type { MediaErrorCode, MediaViewerState } from "./lib/mediaViewer";

export type MediaElementEvent =
  | { type: "loadedmetadata"; duration: number | null }
  | { type: "error"; code: MediaErrorCode; message: string | null }
  | { type: "play" }
  | { type: "pause" }
  | { type: "ended" };

type Props = {
  state: MediaViewerState;
  path: string;
  url: string | undefined;
  visible: boolean;
  onMediaRef: (element: HTMLMediaElement | null) => void;
  onOpenExternally: () => void;
  onRetry: () => void;
  onStopOtherPlayback: () => void;
  onElementEvent: (event: MediaElementEvent) => void;
};

/**
 * The media surface's rendered states. Kept presentational so every honest
 * outcome (unsupported container, corrupt bytes, name/container mismatch, a
 * real codec error, a playback-policy refusal, hidden tab) can be asserted
 * without a browser.
 *
 * A loaded element stays mounted while its tab is hidden — that is what keeps
 * the playback position — but it is hidden from presentation and paused. No
 * state in this view calls `play()`: returning to a tab never resumes media the
 * person paused.
 */
export function MediaPreviewView({
  state,
  path,
  url,
  visible,
  onMediaRef,
  onOpenExternally,
  onRetry,
  onStopOtherPlayback,
  onElementEvent,
}: Props) {
  const mounted =
    state.kind === "loading" ||
    state.kind === "ready" ||
    state.kind === "blocked";
  const Media =
    state.kind === "loading" ||
    state.kind === "ready" ||
    state.kind === "blocked"
      ? mediaKind(state.format) === "audio"
        ? "audio"
        : "video"
      : "video";
  const summary =
    state.kind === "ready" || state.kind === "blocked"
      ? mediaSupportSummary(state.format, state.codecs)
      : null;

  return (
    <div
      data-media-viewer=""
      data-media-state={state.kind}
      data-media-error-code={
        state.kind === "load-error" ? state.code : undefined
      }
      data-media-src={url}
      className="flex h-full w-full flex-col items-center justify-center gap-2 overflow-auto bg-background p-4"
    >
      {state.kind === "hidden" && (
        <p className="text-xs text-muted-foreground">
          Media preview is unloaded while this tab is not on screen.
        </p>
      )}
      {state.kind === "probing" && (
        <p className="text-xs text-muted-foreground">
          Reading the media header…
        </p>
      )}
      {state.kind === "preparing" && (
        <p className="text-xs text-muted-foreground">
          Preparing bounded media delivery…
        </p>
      )}
      {state.kind === "loading" && (
        <p className="text-xs text-muted-foreground">Loading media…</p>
      )}

      {state.kind === "unsupported-format" && (
        <AssetDeliveryNotice
          title="Media format not supported"
          reason={state.reason}
          alternatives={state.alternatives}
          onOpenExternally={onOpenExternally}
        />
      )}
      {state.kind === "corrupt" && (
        <AssetDeliveryNotice
          title="Media could not be read"
          reason={state.reason}
          alternatives={state.alternatives}
          onRetry={state.retryable ? onRetry : undefined}
          onOpenExternally={onOpenExternally}
        />
      )}
      {state.kind === "mismatch" && (
        <AssetDeliveryNotice
          title="Container does not match its name"
          reason={state.reason}
          alternatives={state.alternatives}
          onOpenExternally={onOpenExternally}
        />
      )}
      {state.kind === "unreadable" && (
        <AssetDeliveryNotice
          title="Media file could not be read"
          reason={state.reason}
          alternatives={state.alternatives}
          onRetry={state.retryable ? onRetry : undefined}
          onOpenExternally={onOpenExternally}
        />
      )}
      {state.kind === "load-error" && (
        <AssetDeliveryNotice
          title={
            state.code === 4
              ? "Media codec not supported"
              : "Media could not be played"
          }
          reason={state.reason}
          alternatives={state.alternatives}
          onRetry={state.retryable ? onRetry : undefined}
          onOpenExternally={onOpenExternally}
        />
      )}
      {state.kind === "blocked" && (
        <AssetDeliveryNotice
          title="Playback limit reached"
          reason={state.reason}
          alternatives={state.alternatives}
          onStopOtherPlayback={onStopOtherPlayback}
        />
      )}

      {mounted && (
        <Media
          ref={(element) => onMediaRef(element as HTMLMediaElement | null)}
          controls
          preload="metadata"
          src={url}
          hidden={!visible}
          data-media-player=""
          data-media-kind={Media}
          data-media-format={
            state.kind === "loading" ||
            state.kind === "ready" ||
            state.kind === "blocked"
              ? state.format
              : undefined
          }
          data-media-codecs={
            state.kind === "loading" ||
            state.kind === "ready" ||
            state.kind === "blocked"
              ? state.codecs.join(",")
              : undefined
          }
          data-media-duration={
            state.kind === "ready" || state.kind === "blocked"
              ? (state.durationSeconds ?? undefined)
              : undefined
          }
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            onElementEvent({
              type: "loadedmetadata",
              duration: Number.isFinite(duration) ? duration : null,
            });
          }}
          onError={(event) => {
            const error = event.currentTarget.error;
            onElementEvent({
              type: "error",
              code: (error?.code ?? 0) as MediaErrorCode,
              message: error?.message ? error.message : null,
            });
          }}
          onPlay={() => onElementEvent({ type: "play" })}
          onPause={() => onElementEvent({ type: "pause" })}
          onEnded={() => onElementEvent({ type: "ended" })}
          className={
            Media === "video" ? "max-h-full max-w-full" : "w-full max-w-md"
          }
          title={path.split("/").pop()}
        />
      )}

      {summary && (
        <p
          data-media-support=""
          className="max-w-md text-center text-[11px] leading-relaxed text-muted-foreground"
        >
          {summary} · decode reported by WebKitGTK in this build
        </p>
      )}
      {state.kind === "ready" && !visible && (
        <p
          data-media-paused-by-visibility=""
          className="text-[11px] text-muted-foreground"
        >
          Paused while this tab is not on screen; it will not resume on its own.
        </p>
      )}
    </div>
  );
}

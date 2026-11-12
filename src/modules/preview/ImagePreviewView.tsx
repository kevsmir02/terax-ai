import { AssetDeliveryNotice } from "./AssetDeliveryNotice";
import type { ImageViewerState } from "./lib/imageViewer";

type Props = {
  state: ImageViewerState;
  path: string;
  url: string | undefined;
  onOpenExternally: () => void;
  onRetry: () => void;
  onDecodeFailed: () => void;
};

/**
 * The image surface's rendered states. Kept presentational so every honest
 * outcome (unsupported, corrupt, oversized, admission refusal, released
 * raster, hidden tab) can be asserted without a browser; the container only
 * wires the native probe and the admission table to it.
 */
export function ImagePreviewView({
  state,
  path,
  url,
  onOpenExternally,
  onRetry,
  onDecodeFailed,
}: Props) {
  return (
    <div
      data-image-viewer=""
      data-image-state={state.kind}
      className="flex h-full w-full flex-col items-center justify-center overflow-auto bg-background p-4"
    >
      {state.kind === "ready" ? (
        <img
          data-image-preview=""
          data-image-format={state.format}
          data-image-width={state.width ?? undefined}
          data-image-height={state.height ?? undefined}
          src={url}
          alt={path.split("/").pop()}
          decoding="async"
          onError={onDecodeFailed}
          className="max-h-full max-w-full rounded-md border border-border object-contain shadow-sm"
          style={{
            backgroundImage:
              "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
            backgroundSize: "20px 20px",
          }}
        />
      ) : state.kind === "hidden" ? (
        <p className="text-xs text-muted-foreground">
          Image preview is unloaded while this tab is not on screen.
        </p>
      ) : state.kind === "probing" ? (
        <p className="text-xs text-muted-foreground">
          Reading the image header…
        </p>
      ) : state.kind === "admitting" ? (
        <p className="text-xs text-muted-foreground">
          Reserving a decoded-preview slot…
        </p>
      ) : state.kind === "oversized" ? (
        <AssetDeliveryNotice
          title="Image too large to decode"
          reason={state.reason}
          alternatives={state.alternatives}
          onOpenExternally={onOpenExternally}
        />
      ) : state.kind === "admission-refused" ? (
        <AssetDeliveryNotice
          title="No room for another decoded preview"
          reason={state.reason}
          alternatives={state.alternatives}
          onOpenExternally={onOpenExternally}
        />
      ) : state.kind === "evicted" ? (
        <AssetDeliveryNotice
          title="Preview released to keep memory bounded"
          reason={state.reason}
          alternatives={state.alternatives}
          onOpenExternally={onOpenExternally}
        />
      ) : state.kind === "corrupt" ? (
        <AssetDeliveryNotice
          title="Image could not be decoded"
          reason={state.reason}
          alternatives={state.alternatives}
          onRetry={state.retryable ? onRetry : undefined}
          onOpenExternally={onOpenExternally}
        />
      ) : state.kind === "decode-error" ? (
        <AssetDeliveryNotice
          title="Image could not be rendered"
          reason={state.reason}
          alternatives={state.alternatives}
          onRetry={onRetry}
          onOpenExternally={onOpenExternally}
        />
      ) : state.kind === "unreadable" ? (
        <AssetDeliveryNotice
          title="Image could not be read"
          reason={state.reason}
          alternatives={state.alternatives}
          onRetry={onRetry}
          onOpenExternally={onOpenExternally}
        />
      ) : (
        <AssetDeliveryNotice
          title="Image format not supported"
          reason={state.reason}
          alternatives={state.alternatives}
          onOpenExternally={onOpenExternally}
        />
      )}
    </div>
  );
}

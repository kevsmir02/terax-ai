import { openPath } from "@tauri-apps/plugin-opener";
import { useCallback, useState } from "react";
import { MediaPreview } from "@/modules/editor/MediaPreview";
import { AssetDeliveryNotice } from "./AssetDeliveryNotice";
import {
  type AssetKind,
  assetDeliveryDecision,
  assetFailureNotice,
  assetUrlWithOverride,
} from "./lib/assetDelivery";
import { ImagePreview } from "./ImagePreview";

type Props = {
  path: string;
  tabId: number;
  kind: AssetKind;
  /** Known file size; the native reader reports it even for binary files. */
  bytes: number;
  /** Grant URL, or undefined while the grant is pending. */
  url: string | undefined;
  grantError: string | undefined;
  onRetryGrant: () => void;
  visible: boolean;
  mediaActive: boolean;
};

/**
 * The delivery gate every local preview asset goes through.
 *
 * It applies the approved read ceilings *before* the element loads (so an
 * oversized file is never a blank/broken element), offers the explicit
 * "load anyway" choice up to the approved override, and hands the actual
 * rendering to the per-format surface. Audio/video stream through bounded
 * ranges; images and PDFs are whole-file loads and are bounded here.
 */
export function AssetPreview({
  path,
  tabId,
  kind,
  bytes,
  url,
  grantError,
  onRetryGrant,
  visible,
  mediaActive,
}: Props) {
  const [override, setOverride] = useState(false);
  const openExternally = useCallback(() => {
    void openPath(path).catch((error: unknown) => {
      console.error("open externally failed:", error);
    });
  }, [path]);

  const failure = assetFailureNotice(grantError);
  if (failure) {
    return (
      <AssetDeliveryNotice
        title="Preview unavailable"
        reason={failure.reason}
        alternatives={failure.alternatives}
        onRetry={failure.retryable ? onRetryGrant : undefined}
        onOpenExternally={openExternally}
      />
    );
  }
  if (!url) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Loading media preview…
      </div>
    );
  }

  const decision = assetDeliveryDecision(bytes, kind, { override });
  if (decision.kind === "confirm") {
    return (
      <AssetDeliveryNotice
        title="Large file needs an explicit choice"
        reason={decision.reason}
        alternatives={decision.alternatives}
        onLoadAnyway={() => setOverride(true)}
        onOpenExternally={openExternally}
      />
    );
  }
  if (decision.kind === "refuse") {
    return (
      <AssetDeliveryNotice
        title="File too large to preview"
        reason={decision.reason}
        alternatives={decision.alternatives}
        onOpenExternally={openExternally}
      />
    );
  }

  const source = assetUrlWithOverride(url, override);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center overflow-auto bg-background p-4">
      {kind === "image" && (
        <ImagePreview
          path={path}
          tabId={tabId}
          url={source}
          visible={visible}
          onOpenExternally={openExternally}
        />
      )}
      {(kind === "video" || kind === "audio") && (
        <MediaPreview kind={kind} src={source} active={mediaActive} />
      )}
      {kind === "pdf" && (
        <iframe
          src={source}
          className="h-full w-full border-none"
          title={path.split("/").pop()}
        />
      )}
    </div>
  );
}

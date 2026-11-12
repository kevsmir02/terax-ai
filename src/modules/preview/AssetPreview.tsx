import { openPath } from "@tauri-apps/plugin-opener";
import { type ComponentType, useCallback, useEffect, useState } from "react";
import { AssetDeliveryNotice } from "./AssetDeliveryNotice";
import { ImagePreview } from "./ImagePreview";
import { MediaPreview } from "./MediaPreview";
import {
  type AssetKind,
  assetDeliveryDecision,
  assetFailureNotice,
  assetUrlWithOverride,
} from "./lib/assetDelivery";

type Props = {
  path: string;
  tabId: number;
  kind: AssetKind;
  /** Known file size; the native reader reports it even for binary files. */
  bytes: number;
  /** Grant URL, or undefined while the grant is pending. */
  url: string | undefined;
  /** The grant token, for a surface that reads bytes through IPC or loopback. */
  token?: string | undefined;
  grantError: string | undefined;
  onRetryGrant: () => void;
  visible: boolean;
  mediaActive: boolean;
};

type PdfReaderComponent = ComponentType<{
  path: string;
  tabId: number;
  bytes: number;
  token: string | undefined;
  visible: boolean;
  onOpenExternally: () => void;
}>;

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
  token,
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

  // The PDF reader owns the whole PDF contract, including the gate's explicit
  // choice: its state machine applies the same `assetDeliveryDecision` before
  // any byte is read (issue #30 handed *file bytes* to the delivery gate, and
  // issue #31 keeps that decision while giving the reader the failure surface).
  if (kind === "pdf") {
    return (
      <PdfSurface
        path={path}
        tabId={tabId}
        bytes={bytes}
        token={token}
        visible={visible}
        onOpenExternally={openExternally}
      />
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
        <MediaPreview
          path={path}
          tabId={tabId}
          token={token}
          visible={visible && mediaActive}
          onOpenExternally={openExternally}
        />
      )}
    </div>
  );
}

/**
 * Loads the reader chunk on demand and mounts it.
 *
 * The import happens only for a visible PDF that passed the delivery gate, so
 * no PDF code is fetched at startup and a hidden tab pays nothing. A plain
 * `import()` (not `React.lazy`) keeps the surface renderable in the static
 * tests and gives the app-lab driver a real element to find while it loads.
 */
function PdfSurface({
  path,
  tabId,
  bytes,
  token,
  visible,
  onOpenExternally,
}: {
  path: string;
  tabId: number;
  bytes: number;
  token: string | undefined;
  visible: boolean;
  onOpenExternally: () => void;
}) {
  const [Reader, setReader] = useState<PdfReaderComponent | null>(null);

  useEffect(() => {
    if (!visible || Reader) return;
    let mounted = true;
    void import("./PdfReader").then((module) => {
      if (mounted) setReader(() => module.default);
    });
    return () => {
      mounted = false;
    };
  }, [visible, Reader]);

  if (!visible) {
    return (
      <div
        data-pdf-state="hidden"
        data-pdf-reader=""
        className="flex h-full w-full items-center justify-center p-4"
      >
        <p className="text-xs text-muted-foreground">
          The PDF reader is unloaded while this tab is not on screen.
        </p>
      </div>
    );
  }
  if (!Reader) {
    return (
      <div
        data-pdf-reader=""
        data-pdf-state="loading-reader"
        className="flex h-full w-full items-center justify-center p-4"
      >
        <p className="text-xs text-muted-foreground">Loading the PDF reader…</p>
      </div>
    );
  }
  return (
    <Reader
      path={path}
      tabId={tabId}
      bytes={bytes}
      token={token}
      visible={visible}
      onOpenExternally={onOpenExternally}
    />
  );
}

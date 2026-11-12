import { useState } from "react";
import { AssetDeliveryNotice } from "./AssetDeliveryNotice";
import { imageBudgetDecision } from "./lib/limits";
import { useDecodedViewer } from "./lib/useDecodedViewer";

type Props = {
  path: string;
  tabId: number;
  url: string | undefined;
  visible: boolean;
  onOpenExternally: () => void;
};

/**
 * The bounded image surface.
 *
 * `<img>` decodes at intrinsic size, so the raster is measured as soon as it
 * loads and then either admitted against the 64 MiB per-image ceiling and the
 * 192 MiB / four-viewer decoded budget, or replaced by an explicit refusal. The
 * admission table never evicts a visible viewer; a hidden one may be released
 * and reports why its raster disappeared. Issue #28 adds genuine reduced-size
 * decoding; this surface refuses instead of silently allocating a bigger raster.
 */
export function ImagePreview({
  path,
  tabId,
  url,
  visible,
  onOpenExternally,
}: Props) {
  const [intrinsic, setIntrinsic] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A vector image has no intrinsic raster to budget: the browser rasterizes it
  // at the displayed size, so the decoded-image ceiling does not apply.
  const vector = path.toLowerCase().endsWith(".svg");

  const budget =
    !vector && intrinsic
      ? imageBudgetDecision(intrinsic.width, intrinsic.height)
      : null;
  const decodedBytes = budget?.kind === "allow" ? budget.decodedBytes : 0;
  const viewer = useDecodedViewer({
    id: `image:${tabId}:${path}`,
    tabId: String(tabId),
    decodedBytes,
    visible,
    enabled: budget?.kind === "allow",
  });

  if (failed) {
    return (
      <AssetDeliveryNotice
        title="Image could not be decoded"
        reason="This file may use an unsupported image format or be corrupt. Open it in an external viewer, or retry."
        alternatives={["open-externally"]}
        onRetry={() => {
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
        onOpenExternally={onOpenExternally}
      />
    );
  }
  if (budget?.kind === "refuse") {
    return (
      <AssetDeliveryNotice
        title="Image too large to decode"
        reason={budget.reason}
        alternatives={budget.alternatives}
        onOpenExternally={onOpenExternally}
      />
    );
  }
  if (viewer.admission?.kind === "refuse") {
    return (
      <AssetDeliveryNotice
        title="No room for another decoded preview"
        reason={viewer.admission.reason}
        alternatives={viewer.admission.alternatives}
        onOpenExternally={onOpenExternally}
      />
    );
  }
  if (viewer.evicted) {
    return (
      <AssetDeliveryNotice
        title="Preview released to keep memory bounded"
        reason="Another preview needed the decoded-asset budget, so this image was released while its tab was hidden. Open it again once another large preview is closed."
        alternatives={["close-another-viewer", "open-externally"]}
        onOpenExternally={onOpenExternally}
      />
    );
  }
  return (
    <img
      key={attempt}
      src={url}
      alt={path.split("/").pop()}
      loading={visible ? "eager" : "lazy"}
      decoding="async"
      className="max-h-full max-w-full rounded-md border border-border object-contain shadow-sm"
      style={{
        backgroundImage:
          "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
        backgroundSize: "20px 20px",
      }}
      onLoad={(event) =>
        setIntrinsic({
          width: event.currentTarget.naturalWidth,
          height: event.currentTarget.naturalHeight,
        })
      }
      onError={() => setFailed(true)}
    />
  );
}

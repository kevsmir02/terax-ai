import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { LimitAlternative } from "./lib/limits";

const ALTERNATIVE_LABELS: Record<LimitAlternative, string> = {
  "open-externally": "Open externally",
  downscale: "Show a smaller version",
  "reduce-zoom": "Reduce the zoom",
  "close-another-viewer": "Close another preview",
  "stop-other-playback": "Stop other playback",
};

type Props = {
  title: string;
  reason: string;
  /** Alternatives this surface can offer a button for. */
  alternatives?: readonly LimitAlternative[];
  /** Shows "Load anyway" for the explicit override choice. */
  onLoadAnyway?: () => void;
  onRetry?: () => void;
  onOpenExternally?: () => void;
};

/**
 * One refusal surface for preview assets.
 *
 * Every ceiling outcome in the approved contract must be explicit: a reason
 * plus a safe alternative, never a blank pane or a silent retry loop. The
 * alternatives the surface cannot perform itself (closing another viewer,
 * stopping other playback) are still named, because the person has to do that
 * action.
 */
export function AssetDeliveryNotice({
  title,
  reason,
  alternatives = [],
  onLoadAnyway,
  onRetry,
  onOpenExternally,
}: Props) {
  const canOpenExternally =
    alternatives.includes("open-externally") && onOpenExternally;
  const hints = alternatives.filter(
    (alternative) => alternative !== "open-externally" || !onOpenExternally,
  );
  return (
    <div
      role="alert"
      className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <div className="flex items-center gap-2 text-sm text-foreground">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-amber-500"
        />
        <span>{title}</span>
      </div>
      <p className="max-w-md text-xs text-muted-foreground">{reason}</p>
      {hints.length > 0 && (
        <p className="max-w-md text-[11px] text-muted-foreground/80">
          {hints
            .map((alternative) => ALTERNATIVE_LABELS[alternative])
            .join(" · ")}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {onLoadAnyway && (
          <button
            type="button"
            onClick={onLoadAnyway}
            className="rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
          >
            Load anyway
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent"
          >
            Retry
          </button>
        )}
        {canOpenExternally && (
          <button
            type="button"
            onClick={onOpenExternally}
            className="rounded-md border border-border px-3 py-1 text-xs text-foreground hover:bg-accent"
          >
            Open externally
          </button>
        )}
      </div>
    </div>
  );
}

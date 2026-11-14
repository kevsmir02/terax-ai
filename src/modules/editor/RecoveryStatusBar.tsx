import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RecoveryStatus } from "./lib/recovery/manager";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The visible recovery state. There is no implicit success claim here: only the
 * `durable` state means the current text is protected, and `failed`, `paused`
 * and `unavailable` stay on screen with the reason instead of disappearing.
 */
export function RecoveryStatusBar({
  status,
  onRetry,
}: {
  status: RecoveryStatus;
  onRetry: () => void;
}) {
  if (
    status.kind === "off" ||
    status.kind === "idle" ||
    status.kind === "excluded"
  ) {
    return null;
  }

  const tone =
    status.kind === "durable"
      ? "text-muted-foreground"
      : status.kind === "pending"
        ? "text-muted-foreground"
        : "text-destructive";

  const label = (() => {
    switch (status.kind) {
      case "pending":
        // `scheduled` is what separates an in-progress coalesced write from a
        // stall: claiming progress on unscheduled text would hide lost
        // protection behind "Saving draft…" forever.
        return status.scheduled
          ? "Saving draft…"
          : "Draft not being saved yet (not scheduled)";
      case "durable":
        return `Draft saved · ${formatBytes(status.bytes)}`;
      case "failed":
        return `Draft not saved: ${status.message ?? "write failed"}`;
      case "paused":
        return status.message ?? "Recovery paused";
      case "unavailable":
        return `Recovery unavailable: ${status.message ?? "private storage unreachable"}`;
      default:
        return "";
    }
  })();

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex h-6 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 text-[11px]",
        tone,
      )}
    >
      <span aria-hidden className="text-[9px]">
        {status.kind === "durable" ? "●" : "○"}
      </span>
      <span className="truncate">{label}</span>
      {/* Retry is offered for every state where recovery is not making
          progress on its own, including a pending write with no scheduler. */}
      {(status.kind === "failed" ||
        status.kind === "unavailable" ||
        status.kind === "paused" ||
        (status.kind === "pending" && !status.scheduled)) && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-2 text-[11px]"
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}

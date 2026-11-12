/**
 * The quit-time flush: the recovery manager's writes, bounded so a stalled
 * disk cannot hold the window open forever.
 *
 * The rule the report encodes is the one the recovery contract already states:
 * **only a durable revision counts as saved**. A `flushAll()` that resolves is
 * not the same as "every buffer's newest text is on disk" — text typed while a
 * write was in flight is newer than the revision that write acknowledged, and a
 * write that failed leaves the older record (status `failed`) or pauses the
 * feature (status `paused`). Both are reported here so quit can ask.
 *
 * A bound is a *stop waiting*, not a cancellation: the underlying write keeps
 * going, and Retry observes it once it settles. Reporting "saved" on a timeout
 * would be the silent loss this ticket exists to prevent.
 */

import type {
  RecoveryStatus,
  RecoveryStatusKind,
} from "@/modules/editor/lib/recovery/manager";

export type QuitDraftState =
  | "pending"
  | "unsettled"
  | "failed"
  | "paused"
  | "unavailable";

export type QuitDraft = {
  bufferId: string;
  spaceId: string;
  title: string;
  state: QuitDraftState;
  message?: string;
};

export type QuitFlushOutcome = "settled" | "timeout" | "failed";

export type QuitFlushReport = {
  outcome: QuitFlushOutcome;
  /**
   * Drafts whose newest text is *not* durable. Empty with a `settled` outcome
   * means every protected buffer's latest revision reached private storage.
   */
  drafts: QuitDraft[];
};

/** Default bound on the quit flush. Long enough for a slow disk, short enough
 * that a hung write cannot look like a frozen application. */
export const QUIT_FLUSH_TIMEOUT_MS = 3000;

export type FlushRecoveryDeps = {
  /** `RecoveryManager.flushAll`. */
  flush: () => Promise<Map<string, RecoveryStatus>>;
  /**
   * Current statuses, read only when the bound wins or the flush throws: they
   * are the only evidence of which buffers had text at stake.
   */
  statuses: () => Map<string, RecoveryStatus>;
  timeoutMs?: number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** Display identity of a buffer, for naming the file that is not saved. */
  identify?: (bufferId: string) => { spaceId: string; title: string };
};

const BLOCKING: Partial<Record<RecoveryStatusKind, QuitDraftState>> = {
  pending: "pending",
  failed: "failed",
  paused: "paused",
  unavailable: "unavailable",
};

/**
 * Whether this status means the buffer's newest text is not durable.
 *
 * `off`, `excluded` and `idle` are not losses: recovery is not protecting that
 * buffer at all, so there is no draft whose absence would be a surprise. A
 * `durable` status still loses when a newer revision exists — that is the
 * coalescer's tail, not a saved draft.
 */
function draftStateOf(
  status: RecoveryStatus,
  unsettled: boolean,
): QuitDraftState | null {
  if (
    status.kind === "off" ||
    status.kind === "excluded" ||
    status.kind === "idle"
  ) {
    return null;
  }
  if (status.kind === "durable") {
    const newer =
      status.bufferRevision !== null &&
      status.durableRevision !== null &&
      status.bufferRevision > status.durableRevision;
    return newer ? "pending" : null;
  }
  if (unsettled) return "unsettled";
  return BLOCKING[status.kind] ?? null;
}

function draftsFrom(
  statuses: Map<string, RecoveryStatus>,
  unsettled: boolean,
  identify: (bufferId: string) => { spaceId: string; title: string },
): QuitDraft[] {
  const drafts: QuitDraft[] = [];
  for (const [bufferId, status] of statuses) {
    const state = draftStateOf(status, unsettled);
    if (state === null) continue;
    const identity = identify(bufferId);
    drafts.push({
      bufferId,
      spaceId: identity.spaceId,
      title: identity.title,
      state,
      ...(status.message !== undefined && { message: status.message }),
    });
  }
  // Stable order keeps the dialog from reshuffling between retries.
  drafts.sort((a, b) => a.bufferId.localeCompare(b.bufferId));
  return drafts;
}

const identityOf = (bufferId: string) => ({ spaceId: "", title: bufferId });

/**
 * Classifies current statuses into drafts that are not durable. Shared with the
 * quit survey so the pre-quit summary and the flush failure name the same
 * buffers. `unsettled` is for a write whose outcome is unknown (the bound won).
 */
export function quitDraftsFromStatuses(
  statuses: Map<string, RecoveryStatus>,
  identify: (bufferId: string) => {
    spaceId: string;
    title: string;
  } = identityOf,
  unsettled = false,
): QuitDraft[] {
  return draftsFrom(statuses, unsettled, identify);
}

export async function flushRecovery(
  deps: FlushRecoveryDeps,
): Promise<QuitFlushReport> {
  const {
    flush,
    statuses,
    timeoutMs = QUIT_FLUSH_TIMEOUT_MS,
    schedule,
    cancel,
    identify = identityOf,
  } = deps;

  const run = flush();
  let timer: unknown;
  const bound = new Promise<"timeout">((resolve) => {
    timer = schedule(() => resolve("timeout"), timeoutMs);
  });

  let winner:
    | { kind: "settled"; statuses: Map<string, RecoveryStatus> }
    | { kind: "failed" }
    | "timeout";
  try {
    winner = await Promise.race([
      run.then(
        (settled) => ({ kind: "settled" as const, statuses: settled }),
        () => ({ kind: "failed" as const }),
      ),
      bound,
    ]);
  } finally {
    cancel(timer);
  }

  if (winner === "timeout") {
    // A write is still in flight. The buffer statuses are the honest picture:
    // whatever was pending is unsettled, and "unsettled" never means saved.
    // Nobody waits for the write any more, but its rejection is still handled.
    void run.catch(() => undefined);
    return {
      outcome: "timeout",
      drafts: draftsFrom(statuses(), true, identify),
    };
  }
  if (winner.kind === "failed") {
    return {
      outcome: "failed",
      drafts: draftsFrom(statuses(), true, identify),
    };
  }
  return {
    outcome: "settled",
    drafts: draftsFrom(winner.statuses, false, identify),
  };
}

/** True when the report means quit cannot proceed without an explicit choice. */
export function flushBlocksQuit(report: QuitFlushReport): boolean {
  return report.outcome !== "settled" || report.drafts.length > 0;
}

import type { CheckFailure, CheckOutcome } from "./checkForUpdate";
import {
  type HandoffApproval,
  type HandoffWork,
  decideHandoff,
  type HandoffHazard,
} from "./handoffReadiness";
import type { AvailableRelease } from "./releaseManifest";
import type { DownloadRequestResult } from "./requestDownload";

/**
 * The updater state machine.
 *
 * The states are deliberately honest about what this build can do:
 * - `up-to-date`, `update-available` and `check-failed` are the three discovery results;
 * - `handoff-checking`, `handoff-blocked` and `handed-off` are the package-tool handoff
 *   (#39): an explicit approval starts a live readiness check, work in progress blocks
 *   the handoff, and a clear check ends at `handed-off`. There is no `installed`/`ready`
 *   state, because the app gives the artifact and command to the person and never sees
 *   the transaction's result;
 * - `handoff-unavailable` is kept for the in-app download seam, which stays
 *   `not-implemented`: nothing here may download;
 * - a download can only be requested from `update-available` (a discovered release) and
 *   only through an explicit user action. No event and no background path starts one.
 */
export type UpdaterState =
  | { kind: "idle" }
  | {
      kind: "checking";
      manual: boolean;
      startedAt: number;
      /** A release discovered before this check, kept so a failure does not hide it. */
      knownRelease?: AvailableRelease;
    }
  | { kind: "up-to-date"; checkedAt: number; latestVersion: string }
  | { kind: "update-available"; checkedAt: number; release: AvailableRelease }
  | {
      kind: "check-failed";
      checkedAt: number;
      failure: CheckFailure;
      /** A release discovered by an earlier successful check, kept for the retry UI. */
      knownRelease?: AvailableRelease;
    }
  | {
      kind: "handoff-unavailable";
      release: AvailableRelease;
      ticket: number;
      detail: string;
    }
  | {
      kind: "handoff-checking";
      release: AvailableRelease;
      /** The approval being checked, bound to the snapshot it was taken against. */
      approval: HandoffApproval;
    }
  | {
      kind: "handoff-blocked";
      release: AvailableRelease;
      /** The approval that was checked (and is now stale for this work). */
      approval: HandoffApproval;
      assessedAt: number;
      hazards: HandoffHazard[];
      startedAfterApproval: boolean;
      summary: string;
    }
  | {
      kind: "handed-off";
      release: AvailableRelease;
      approvedAt: number;
      handedOffAt: number;
    };

export type UpdaterEvent =
  | { type: "check-started"; manual: boolean; at: number }
  | { type: "check-settled"; outcome: CheckOutcome; at: number }
  | { type: "download-requested"; result: DownloadRequestResult; at: number }
  | { type: "handoff-approved"; approval: HandoffApproval }
  | {
      type: "handoff-assessed";
      at: number;
      approval: HandoffApproval;
      /** Live evidence re-read immediately before the handoff. */
      work: HandoffWork;
    }
  | { type: "dismissed" };

export const initialUpdaterState: UpdaterState = { kind: "idle" };

export function reduceUpdaterState(
  state: UpdaterState,
  event: UpdaterEvent,
): UpdaterState {
  switch (event.type) {
    case "check-started":
      // A second automatic check never stacks on a running one.
      if (state.kind === "checking") return state;
      return {
        kind: "checking",
        manual: event.manual,
        startedAt: event.at,
        knownRelease: knownReleaseOf(state),
      };

    case "check-settled": {
      const { outcome } = event;
      if (outcome.kind === "no-update") {
        return {
          kind: "up-to-date",
          checkedAt: outcome.checkedAt,
          latestVersion: outcome.latestVersion,
        };
      }
      if (outcome.kind === "available") {
        return {
          kind: "update-available",
          checkedAt: outcome.checkedAt,
          release: outcome.release,
        };
      }
      return {
        kind: "check-failed",
        checkedAt: outcome.checkedAt,
        failure: outcome.failure,
        knownRelease: knownReleaseOf(state),
      };
    }

    case "download-requested": {
      // Only an explicitly discovered release can be handed off, and the result decides
      // whether this build actually has a handoff. A refusal or an unimplemented handoff
      // is never rendered as an install.
      if (state.kind !== "update-available") return state;
      if (event.result.kind === "refused") return state;
      return {
        kind: "handoff-unavailable",
        release: state.release,
        ticket: event.result.ticket,
        detail: event.result.detail,
      };
    }

    case "dismissed":
      return initialUpdaterState;

    case "handoff-approved": {
      // An approval is the person's explicit click on a discovered update, or a
      // second click after a blocked check. It never starts from anywhere else,
      // and it is only ever valid for the snapshot it carries.
      if (
        state.kind !== "update-available" &&
        state.kind !== "handoff-blocked"
      ) {
        return state;
      }
      return {
        kind: "handoff-checking",
        release: state.release,
        approval: event.approval,
      };
    }

    case "handoff-assessed": {
      // Only the check that belongs to the current approval may settle it; a
      // result that lands after a newer approval is late and changes nothing.
      if (state.kind !== "handoff-checking") return state;
      if (state.approval.at !== event.approval.at) return state;
      const decision = decideHandoff(event.approval, event.work);
      if (decision.kind === "handoff") {
        return {
          kind: "handed-off",
          release: state.release,
          approvedAt: decision.approvedAt,
          handedOffAt: event.at,
        };
      }
      return {
        kind: "handoff-blocked",
        release: state.release,
        approval: event.approval,
        assessedAt: event.at,
        hazards: decision.hazards,
        startedAfterApproval: decision.startedAfterApproval,
        summary: decision.summary,
      };
    }

    default:
      return state;
  }
}

/** True when the UI may offer the explicit "get this update" action. */
export function canRequestDownload(state: UpdaterState): boolean {
  return state.kind === "update-available";
}

/** True when the UI may offer the package-tool handoff (first time or again). */
export function canRequestHandoff(
  state: UpdaterState,
): state is Extract<
  UpdaterState,
  { kind: "update-available" } | { kind: "handoff-blocked" }
> {
  return state.kind === "update-available" || state.kind === "handoff-blocked";
}

/** The most recently discovered release carried across checks, if any. */
function knownReleaseOf(state: UpdaterState): AvailableRelease | undefined {
  switch (state.kind) {
    case "update-available":
    case "handoff-unavailable":
      return state.release;
    case "check-failed":
    case "checking":
      return state.knownRelease;
    default:
      return undefined;
  }
}

export interface ThrottleOptions {
  lastCheckedAt: number | null;
  now: number;
  intervalMs: number;
  /** An explicit user request is never throttled. */
  manual?: boolean;
}

/** Bounded automatic checks: at most one per interval unless the user asks. */
export function shouldRunCheck({
  lastCheckedAt,
  now,
  intervalMs,
  manual = false,
}: ThrottleOptions): boolean {
  if (manual) return true;
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= intervalMs;
}

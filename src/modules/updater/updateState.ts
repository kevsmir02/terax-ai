import type { CheckFailure, CheckOutcome } from "./checkForUpdate";
import type { AvailableRelease } from "./releaseManifest";
import type { DownloadRequestResult } from "./requestDownload";

/**
 * The updater state machine.
 *
 * The states are deliberately honest about what this build can do:
 * - `up-to-date`, `update-available` and `check-failed` are the three discovery results;
 * - `handoff-unavailable` means the user asked for the discovered update and this build
 *   cannot hand it to a package tool yet (#39). There is no `installed`/`ready` state, so
 *   the UI can never claim an install that did not happen;
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
    };

export type UpdaterEvent =
  | { type: "check-started"; manual: boolean; at: number }
  | { type: "check-settled"; outcome: CheckOutcome; at: number }
  | { type: "download-requested"; result: DownloadRequestResult; at: number }
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

    default:
      return state;
  }
}

/** True when the UI may offer the explicit "get this update" action. */
export function canRequestDownload(state: UpdaterState): boolean {
  return state.kind === "update-available";
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

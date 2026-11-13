import type { CheckFailure } from "./checkForUpdate";
import type { AvailableRelease } from "./releaseManifest";
import type { UpdaterState } from "./updateState";

/**
 * User-facing copy for every updater state.
 *
 * This build discovers updates; it does not download, install or relaunch. The copy is
 * therefore explicit about the difference between "found", "handed off to your package
 * tool" and "failed", and there is no wording that claims an installation happened.
 */
export interface CopySummary {
  title: string;
  detail: string;
  action: "check" | "request-update" | "request-handoff" | "dismiss" | null;
}

export function trustNote(release: AvailableRelease): string {
  if (release.trust === "verified") return "";
  return (
    "Development fixture release: its artifact is not cryptographically verified. " +
    "Never install a fixture package on a machine you rely on."
  );
}

export function failureSummary(failure: CheckFailure): string {
  switch (failure.reason) {
    case "offline":
      return "The release feed is unreachable (offline or blocked). Nothing was changed.";
    case "timeout":
      return "The release feed timed out. Nothing was changed; you can retry later.";
    case "rate-limited":
      return "The release feed is rate limiting this client (slow down). Retry later.";
    case "server-error":
      return `The release feed answered with an error (${failure.detail}). Retry later.`;
    case "bad-payload":
      return "The release feed sent an invalid or unexpected payload, so it was ignored.";
    case "unsupported-channel":
      return "The release feed offered a version outside the stable channel, so it was ignored.";
    case "unsupported-target":
      return "The release feed has no package for this platform/target, so there is nothing to offer.";
    case "signature":
      return (
        "Update verification failed, so the release was not trusted and no update is offered. " +
        `(${failure.detail})`
      );
    case "no-endpoint":
      return "No release endpoint is configured for this build, so nothing was checked.";
    case "misconfigured":
      return `The update configuration is invalid, so the check did not run. (${failure.detail})`;
    default:
      return "The update check failed. Nothing was changed.";
  }
}

function failureTitle(failure: CheckFailure): string {
  switch (failure.reason) {
    case "signature":
      return "Update check failed - verification";
    case "offline":
      return "Update check failed - offline";
    case "rate-limited":
      return "Update check failed - rate limited";
    default:
      return "Update check failed";
  }
}

export function checkSummary(state: UpdaterState): CopySummary {
  switch (state.kind) {
    case "idle":
      return {
        title: "Check for updates",
        detail:
          "Codr only reads the release feed; it never downloads or installs on its own.",
        action: "check",
      };
    case "checking":
      return {
        title: "Checking for updates…",
        detail:
          "The check runs in the background and does not interrupt your work.",
        action: null,
      };
    case "up-to-date":
      return {
        title: "You're up to date",
        detail: `No newer stable release than v${state.latestVersion}.`,
        action: "check",
      };
    case "update-available":
      return {
        title: `Codr v${state.release.version} is available`,
        detail:
          "A newer stable release was found. Codr does not download or install it for " +
          "you: update with your package tool, and this app will not restart itself.",
        action: "request-update",
      };
    case "check-failed":
      return {
        title: failureTitle(state.failure),
        detail: failureSummary(state.failure),
        action: "check",
      };
    case "handoff-unavailable":
      return {
        title: `Codr v${state.release.version} needs a package-tool update`,
        detail: `${state.detail} Nothing was downloaded, and no package transaction ran.`,
        action: "dismiss",
      };
    case "handoff-checking":
      return {
        title: "Checking that nothing is in the way…",
        detail:
          "Codr is reading the live state right now: unsaved editor buffers, processes " +
          "your terminals started, and agents that are still working. It does not save, " +
          "close, stop or interrupt anything.",
        action: null,
      };
    case "handoff-blocked":
      return {
        title: `Not handed off - v${state.release.version} waits on your work`,
        detail: state.summary,
        action: "request-handoff",
      };
    case "handed-off":
      return {
        title: `Handed off: Codr v${state.release.version}`,
        detail:
          "Codr gave you the artifact and the command below and stopped there. It did " +
          "not download, install or verify anything, and it cannot confirm the result: " +
          "your package tool owns the transaction.",
        action: "dismiss",
      };
    default:
      return { title: "", detail: "", action: null };
  }
}

/**
 * What the app cannot promise about the transaction the person is about to run.
 *
 * Cancellation, package locks and a failed transaction are the package tool's
 * outcomes, not the app's: there is no rollback to offer and no way to observe the
 * result, so the copy names the recovery path and says exactly what is unknown.
 */
export function handoffRecoveryNote(): string {
  return (
    "If your package tool is cancelled, fails, or reports that the package database is " +
    "locked: nothing is rolled back by Codr. It is safe to close Codr first, wait for " +
    "the running package operation to finish (or remove the stale lock your tool names), " +
    "then run the command again. Codr cannot tell you whether the transaction finished " +
    "and never relaunches itself."
  );
}

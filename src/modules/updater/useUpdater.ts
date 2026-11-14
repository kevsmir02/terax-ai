import namespace from "@/modules/identity/namespace.json";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { checkForUpdate, type CheckOutcome } from "./checkForUpdate";
import { tauriManifestTransport } from "./tauriManifestTransport";
import {
  releaseContract,
  resolveContract,
  type UpdaterContract,
} from "./contract";
import {
  checkHandoff,
  type HandoffHazard,
  type HandoffWork,
} from "./handoffReadiness";
import { createReleaseVerifier } from "./releaseSignature";
import { requestDownload } from "./requestDownload";
import {
  canRequestHandoff,
  initialUpdaterState,
  reduceUpdaterState,
  shouldRunCheck,
} from "./updateState";

/** Namespaced with the fork identity: upstream's throttle key is a different key. */
const LAST_CHECK_KEY = `${namespace.namespace}:updater:last-check`;

function readLastCheck(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastCheck(at: number) {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(at));
  } catch {
    // Storage is a best-effort throttle; a denied localStorage only permits checks.
  }
}

function currentTarget(): string {
  try {
    return `${platform()}-${arch()}`;
  } catch {
    return "linux-x86_64";
  }
}

function failed(
  currentVersion: string,
  reason: "misconfigured",
  detail: string,
): CheckOutcome {
  return {
    kind: "failed",
    currentVersion,
    checkedAt: Date.now(),
    attempts: 0,
    failure: { reason, detail, attempts: 0, retryable: false },
  };
}

async function performCheck(): Promise<CheckOutcome> {
  let currentVersion: string;
  try {
    currentVersion = await getVersion();
  } catch (error) {
    return failed(
      "unknown",
      "misconfigured",
      `cannot read the running version: ${String(error)}`,
    );
  }

  let contract: UpdaterContract;
  try {
    contract = resolveContract({
      devMode: import.meta.env.DEV,
      env: import.meta.env,
    });
  } catch (error) {
    return failed(currentVersion, "misconfigured", String(error));
  }

  return checkForUpdate({
    currentVersion,
    contract,
    target: currentTarget(),
    transport: isTauri() ? tauriManifestTransport : undefined,
    // Discovery never depends on the optional native installer: trust policy is decided
    // by the contract (fail closed until #39 provisions keys), not by an installer choice.
    verify: createReleaseVerifier({ devMode: import.meta.env.DEV, contract }),
  });
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
  /**
   * Live evidence for the handoff readiness check. It is read twice per approval:
   * once to bind the approval to a snapshot, once immediately before the handoff
   * so work that started in between invalidates the approval.
   *
   * A window that cannot read the workspace's live state (the settings window) must
   * leave this out: without it the handoff is refused rather than guessed at.
   */
  readHandoffWork?: () => Promise<HandoffWork>;
  /** Focus the work a blocked check named. Never saves, closes or interrupts it. */
  reviewHandoffWork?: (hazards: readonly HandoffHazard[]) => void;
}

interface RunCheckOptions {
  /** An explicit user request bypasses the interval throttle. */
  manual?: boolean;
}

/**
 * Async, non-blocking, bounded update discovery, plus the package-tool handoff.
 *
 * A check reads the fork-owned stable release manifest and settles into no-update,
 * update-available or check-failed. It never downloads a package, never asks for
 * privilege and never relaunches. `requestHandoff` is the only path toward an
 * update and only runs from an explicit user action: it confirms the in-app
 * download is still unimplemented, binds the approval to a readiness snapshot,
 * re-reads that evidence immediately before handing off, and stops at
 * `handed-off` or `handoff-blocked`. Nothing here installs or verifies anything.
 */
export function useUpdater({
  autoCheck = true,
  readHandoffWork,
  reviewHandoffWork,
}: HookOptions) {
  const [state, dispatch] = useReducer(reduceUpdaterState, initialUpdaterState);
  const autoStarted = useRef(false);

  const runCheck = useCallback(
    async ({ manual = false }: RunCheckOptions = {}) => {
      const now = Date.now();
      if (
        !shouldRunCheck({
          lastCheckedAt: readLastCheck(),
          now,
          intervalMs: releaseContract.check.intervalMs,
          manual,
        })
      ) {
        return;
      }

      dispatch({ type: "check-started", manual, at: now });
      const outcome = await performCheck();
      // Record the attempt even when it failed: the automatic interval must not hammer an
      // unreachable or rate-limited feed. An explicit user check still bypasses it.
      writeLastCheck(Date.now());
      dispatch({ type: "check-settled", outcome, at: Date.now() });
    },
    [],
  );

  const requestHandoff = useCallback(async () => {
    if (!canRequestHandoff(state)) return;

    // The in-app download seam is asked first and is deliberately unimplemented: that
    // answer is what makes this a handoff, and nothing here may reach a native command.
    const download = await requestDownload({
      release: state.release,
      approved: true,
    });
    if (download.kind !== "not-implemented") {
      dispatch({
        type: "download-requested",
        result: download,
        at: Date.now(),
      });
      return;
    }

    // No live evidence means no honest readiness check, so no handoff. The settings
    // window is exactly this case: it cannot see the workspace's buffers or processes.
    if (!readHandoffWork) {
      dispatch({
        type: "download-requested",
        result: {
          kind: "not-implemented",
          ticket: 39,
          detail:
            "This window cannot read the workspace's unsaved buffers, running processes " +
            "and agents, so it cannot check handoff readiness. Start the handoff from the " +
            "update dialog in the main window.",
        },
        at: Date.now(),
      });
      return;
    }

    // The approval is bound to the state it was taken against, and the same
    // evidence is re-read right before the handoff: work that started meanwhile
    // invalidates the approval instead of being handed off over.
    const { approval, work } = await checkHandoff(readHandoffWork);
    dispatch({ type: "handoff-approved", approval });
    dispatch({
      type: "handoff-assessed",
      at: Date.now(),
      approval,
      work,
    });
  }, [state, readHandoffWork]);

  const reviewWork = useCallback(() => {
    if (state.kind !== "handoff-blocked") return;
    reviewHandoffWork?.(state.hazards);
  }, [state, reviewHandoffWork]);

  const dismiss = useCallback(() => {
    dispatch({ type: "dismissed" });
  }, []);

  useEffect(() => {
    if (!autoCheck || autoStarted.current) return;
    autoStarted.current = true;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { state, check: runCheck, requestHandoff, reviewWork, dismiss };
}

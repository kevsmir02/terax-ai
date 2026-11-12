import namespace from "@/modules/identity/namespace.json";
import { getVersion } from "@tauri-apps/api/app";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { checkForUpdate, type CheckOutcome } from "./checkForUpdate";
import {
  releaseContract,
  resolveContract,
  type UpdaterContract,
} from "./contract";
import { createReleaseVerifier } from "./releaseSignature";
import { requestDownload } from "./requestDownload";
import {
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
    // Discovery never depends on the optional native installer: trust policy is decided
    // by the contract (fail closed until #39 provisions keys), not by an installer choice.
    verify: createReleaseVerifier({ devMode: import.meta.env.DEV, contract }),
  });
}

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
}

interface RunCheckOptions {
  /** An explicit user request bypasses the interval throttle. */
  manual?: boolean;
}

/**
 * Async, non-blocking, bounded update discovery.
 *
 * A check reads the fork-owned stable release manifest and settles into no-update,
 * update-available or check-failed. It never downloads a package, never asks for
 * privilege and never relaunches. `requestUpdate` is the only path toward an update and
 * only runs from an explicit user action; this build's handoff is `not-implemented`
 * because ticket #39 owns the install/readiness contract.
 */
export function useUpdater({ autoCheck = true }: HookOptions = {}) {
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

  const requestUpdate = useCallback(async () => {
    if (state.kind !== "update-available") return;
    const result = await requestDownload({
      release: state.release,
      approved: true,
    });
    dispatch({ type: "download-requested", result, at: Date.now() });
  }, [state]);

  const dismiss = useCallback(() => {
    dispatch({ type: "dismissed" });
  }, []);

  useEffect(() => {
    if (!autoCheck || autoStarted.current) return;
    autoStarted.current = true;
    void runCheck();
  }, [autoCheck, runCheck]);

  return { state, check: runCheck, requestUpdate, dismiss };
}

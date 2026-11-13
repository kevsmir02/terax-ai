import type { UpdaterContract } from "./contract";
import {
  compareVersions,
  parseReleaseManifest,
  type AvailableRelease,
} from "./releaseManifest";
import type { ReleaseVerifier } from "./releaseSignature";

/**
 * One bounded, asynchronous check of the fork's stable release feed.
 *
 * Invariants this function is responsible for:
 * - it only ever GETs the manifest endpoint: no artifact URL is opened, so a check can
 *   never download a package, and nothing here invokes privilege;
 * - it is bounded by a timeout, a fixed attempt count and capped backoff;
 * - a failure is classified (offline / timeout / rate-limited / server / bad payload /
 *   channel / target / signature) instead of collapsing into one error string;
 * - it refuses to report an available update without an explicit verifier passing, so
 *   "no trust inputs yet" cannot turn into an installable update.
 */
type CheckFailureReason =
  | "no-endpoint"
  | "misconfigured"
  | "offline"
  | "timeout"
  | "rate-limited"
  | "server-error"
  | "bad-payload"
  | "unsupported-channel"
  | "unsupported-target"
  | "signature";

export interface CheckFailure {
  reason: CheckFailureReason;
  detail: string;
  /** Total attempts performed, including the last failed one. */
  attempts: number;
  /** Whether another attempt could plausibly succeed. */
  retryable: boolean;
  status?: number;
}

export type CheckOutcome =
  | {
      kind: "no-update";
      currentVersion: string;
      checkedAt: number;
      attempts: number;
      latestVersion: string;
    }
  | {
      kind: "available";
      currentVersion: string;
      checkedAt: number;
      attempts: number;
      release: AvailableRelease;
    }
  | {
      kind: "failed";
      currentVersion: string;
      checkedAt: number;
      attempts: number;
      failure: CheckFailure;
    };

export interface CheckForUpdateOptions {
  currentVersion: string;
  contract: UpdaterContract;
  /** Target platform key, e.g. `linux-x86_64`. */
  target?: string;
  /** Injected in tests; defaults to the platform fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Injected in tests so backoff never really sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** Required: the caller decides the trust policy (see `createReleaseVerifier`). */
  verify: ReleaseVerifier;
  /** Injected in tests for a stable `checkedAt`. */
  now?: () => number;
}

const DEFAULT_TARGET = "linux-x86_64";

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type AttemptResult =
  | { kind: "response"; body: string; status: number }
  | {
      kind: "failure";
      failure: Omit<CheckFailure, "attempts">;
      retryable: boolean;
      /** Backoff before the next attempt; absent when the attempt is final. */
      delayMs: number;
    };

function retryAfterMs(
  response: Response,
  maxRetryAfterMs: number,
): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxRetryAfterMs);
}

function backoffMs(attempt: number, contract: UpdaterContract): number {
  const { baseDelayMs, maxDelayMs } = contract.check;
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

async function attemptCheck(
  endpoint: string,
  contract: UpdaterContract,
  fetchImpl: typeof globalThis.fetch,
  attempt: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), contract.check.timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 429) {
        return {
          kind: "failure",
          failure: {
            reason: "rate-limited",
            detail: "release feed asked this client to slow down",
            retryable: true,
            status: response.status,
          },
          retryable: true,
          delayMs:
            retryAfterMs(response, contract.check.maxRetryAfterMs) ??
            backoffMs(attempt, contract),
        };
      }
      if (response.status === 408) {
        return {
          kind: "failure",
          failure: {
            reason: "timeout",
            detail: "release feed timed out",
            retryable: true,
            status: response.status,
          },
          retryable: true,
          delayMs: backoffMs(attempt, contract),
        };
      }
      const retryable = response.status >= 500;
      return {
        kind: "failure",
        failure: {
          reason: "server-error",
          detail: `release feed answered ${response.status}`,
          retryable,
          status: response.status,
        },
        retryable,
        delayMs: backoffMs(attempt, contract),
      };
    }

    return {
      kind: "response",
      body: await response.text(),
      status: response.status,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      kind: "failure",
      failure: {
        reason: aborted ? "timeout" : "offline",
        detail: aborted
          ? `release feed did not answer within ${contract.check.timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
        retryable: true,
      },
      retryable: true,
      delayMs: backoffMs(attempt, contract),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate({
  currentVersion,
  contract,
  target = DEFAULT_TARGET,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  verify,
  now = Date.now,
}: CheckForUpdateOptions): Promise<CheckOutcome> {
  const endpoint = contract.endpoints[0];
  if (!endpoint) {
    return {
      kind: "failed",
      currentVersion,
      checkedAt: now(),
      attempts: 0,
      failure: {
        reason: "no-endpoint",
        detail: "no fork release endpoint is configured",
        attempts: 0,
        retryable: false,
      },
    };
  }

  const fail = (
    failure: Omit<CheckFailure, "attempts">,
    attempts: number,
  ): CheckOutcome => ({
    kind: "failed",
    currentVersion,
    checkedAt: now(),
    attempts,
    failure: { ...failure, attempts },
  });

  let last: {
    failure: Omit<CheckFailure, "attempts">;
    attempts: number;
  } | null = null;

  for (let attempt = 1; attempt <= contract.check.attempts; attempt++) {
    const result = await attemptCheck(endpoint, contract, fetchImpl, attempt);

    if (result.kind === "failure") {
      last = { failure: result.failure, attempts: attempt };
      if (!result.retryable || attempt >= contract.check.attempts) break;
      await sleep(result.delayMs);
      continue;
    }

    const parsed = parseReleaseManifest(result.body, {
      target,
      channel: contract.channel,
    });
    if (!parsed.ok) {
      return fail(
        {
          reason: parsed.failure.reason,
          detail: parsed.failure.detail,
          retryable: false,
        },
        attempt,
      );
    }

    // Trust is only relevant for a release the user could act on; a bad signature on a
    // release that is not newer than the running build changes nothing.
    if (compareVersions(parsed.release.version, currentVersion) <= 0) {
      return {
        kind: "no-update",
        currentVersion,
        checkedAt: now(),
        attempts: attempt,
        latestVersion: parsed.release.version,
      };
    }

    const verified = await verify({ release: parsed.release, contract });
    if (!verified.ok) {
      return fail(
        { reason: "signature", detail: verified.detail, retryable: false },
        attempt,
      );
    }

    return {
      kind: "available",
      currentVersion,
      checkedAt: now(),
      attempts: attempt,
      release: { ...parsed.release, trust: verified.trust },
    };
  }

  const failure = last ?? {
    failure: {
      reason: "offline",
      detail: "release feed was not reachable",
      retryable: true,
    },
    attempts: contract.check.attempts,
  };
  return fail(failure.failure, failure.attempts);
}

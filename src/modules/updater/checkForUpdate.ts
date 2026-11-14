import { invoke, isTauri } from "@tauri-apps/api/core";
import { isLoopbackEndpoint, type UpdaterContract } from "./contract";
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
 * - a failure is classified (offline / blocked / timeout / rate-limited / server /
 *   bad payload / channel / target / signature) instead of collapsing into one error string;
 * - it refuses to report an available update without an explicit verifier passing, so
 *   "no trust inputs yet" cannot turn into an installable update.
 */
export type CheckFailureReason =
  | "no-endpoint"
  | "misconfigured"
  | "offline"
  | "blocked"
  | "timeout"
  | "rate-limited"
  | "server-error"
  | "bad-payload"
  | "unsupported-channel"
  | "unsupported-target"
  | "signature";

export interface ManifestFetchResult {
  status: number;
  retryAfter?: string | null;
  body: string;
}

export type ManifestTransportReason = "offline" | "blocked" | "timeout";

export class ManifestTransportError extends Error {
  readonly reason: ManifestTransportReason;

  constructor(reason: ManifestTransportReason, detail: string) {
    super(detail);
    this.name = "ManifestTransportError";
    this.reason = reason;
  }
}

export type ManifestTransport = (request: {
  endpoint: string;
  timeoutMs: number;
}) => Promise<ManifestFetchResult>;

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
  /** Injected transport double for unit tests or native IPC wiring. */
  transport?: ManifestTransport;
  /** Injected in tests; defaults to the platform fetch or Tauri IPC transport. */
  fetchImpl?: typeof globalThis.fetch;
  /** Injected in tests so backoff never really sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** Required: the caller decides the trust policy (see `createReleaseVerifier`). */
  verify: ReleaseVerifier;
  /** Injected in tests for a stable `checkedAt`. */
  now?: () => number;
}

const DEFAULT_TARGET = "linux-x86_64";

const BLOCKED_ERROR_PATTERN =
  /\b(?:cors|csp|mixed content|certificate|tls|ssl|blocked|policy|permission|denied|not allowed|capability|redirect|size limit)\b/i;

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
  header: string | null | undefined,
  maxRetryAfterMs: number,
): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, maxRetryAfterMs);
}

function backoffMs(attempt: number, contract: UpdaterContract): number {
  const { baseDelayMs, maxDelayMs } = contract.check;
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlockedFetchError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    if (error.name === "SecurityError") return true;
  }
  if (error instanceof Error && error.name === "SecurityError") {
    return true;
  }
  return BLOCKED_ERROR_PATTERN.test(errorMessage(error));
}

export function createFetchManifestTransport(
  fetchImpl: typeof globalThis.fetch,
): ManifestTransport {
  return async ({ endpoint, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      return {
        status: response.status,
        retryAfter: response.headers.get("retry-after"),
        body: await response.text(),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ManifestTransportError(
          "timeout",
          `release feed did not answer within ${timeoutMs}ms`,
        );
      }
      const detail = errorMessage(error);
      if (isBlockedFetchError(error)) {
        throw new ManifestTransportError("blocked", detail);
      }
      throw new ManifestTransportError("offline", detail);
    } finally {
      clearTimeout(timer);
    }
  };
}

function isTransportReason(value: unknown): value is ManifestTransportReason {
  return value === "offline" || value === "blocked" || value === "timeout";
}

function parseTauriTransportError(error: unknown): ManifestTransportError {
  if (error instanceof ManifestTransportError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as { reason?: unknown; detail?: unknown };
    if (isTransportReason(record.reason)) {
      const detail =
        typeof record.detail === "string" ? record.detail : errorMessage(error);
      return new ManifestTransportError(record.reason, detail);
    }
  }
  const detail = errorMessage(error);
  if (BLOCKED_ERROR_PATTERN.test(detail)) {
    return new ManifestTransportError("blocked", detail);
  }
  return new ManifestTransportError("offline", detail);
}

export const tauriManifestTransport: ManifestTransport = async ({
  endpoint,
}) => {
  try {
    return await invoke<ManifestFetchResult>("updater_fetch_manifest", {
      endpointOverride: isLoopbackEndpoint(endpoint) ? endpoint : null,
    });
  } catch (error) {
    throw parseTauriTransportError(error);
  }
};

async function attemptCheck(
  endpoint: string,
  contract: UpdaterContract,
  transport: ManifestTransport,
  attempt: number,
): Promise<AttemptResult> {
  try {
    const response = await transport({
      endpoint,
      timeoutMs: contract.check.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
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
            retryAfterMs(response.retryAfter, contract.check.maxRetryAfterMs) ??
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
      body: response.body,
      status: response.status,
    };
  } catch (error) {
    const classified =
      error instanceof ManifestTransportError
        ? error
        : new ManifestTransportError(
            isBlockedFetchError(error) ? "blocked" : "offline",
            errorMessage(error),
          );
    const retryable = classified.reason !== "blocked";
    return {
      kind: "failure",
      failure: {
        reason: classified.reason,
        detail: classified.message,
        retryable,
      },
      retryable,
      delayMs: retryable ? backoffMs(attempt, contract) : 0,
    };
  }
}

export async function checkForUpdate({
  currentVersion,
  contract,
  target = DEFAULT_TARGET,
  transport,
  fetchImpl,
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

  const resolvedTransport =
    transport ??
    (fetchImpl
      ? createFetchManifestTransport(fetchImpl)
      : isTauri()
        ? tauriManifestTransport
        : createFetchManifestTransport(globalThis.fetch));

  let last: {
    failure: Omit<CheckFailure, "attempts">;
    attempts: number;
  } | null = null;

  for (let attempt = 1; attempt <= contract.check.attempts; attempt++) {
    const result = await attemptCheck(
      endpoint,
      contract,
      resolvedTransport,
      attempt,
    );

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

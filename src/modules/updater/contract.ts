import rawContract from "./releaseContract.json";
import { parseMinisignPublicKey } from "./minisign";

/**
 * The fork-owned release contract.
 *
 * Codr is not upstream Terax: it has its own application identity
 * (`modules/identity/namespace.json`), its own GitHub release feed, and its own minisign
 * trust root. Upstream's feed stays recorded under `upstream` only so tests and contract
 * validation can refuse it.
 */
export interface UpdaterContract {
  provisional: boolean;
  note: string;
  finalTrustTicket: number;
  channel: "stable";
  endpoints: string[];
  check: {
    timeoutMs: number;
    attempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    maxRetryAfterMs: number;
    intervalMs: number;
  };
  trust: {
    provisioned: boolean;
    keyId?: string;
    fingerprint?: string;
    publicKey: string;
    note: string;
  };
  fixtures: {
    directory: string;
    endpointEnv: string;
    devServerCommand: string;
    note: string;
  };
  upstream: { repository: string; baseCommit?: string; endpoints: string[] };
}

export const releaseContract = rawContract as UpdaterContract;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The local development fixture server binds 127.0.0.1 and nothing else. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const parsed = parseUrl(endpoint);
  if (!parsed) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return LOOPBACK_HOSTS.has(parsed.hostname);
}

/**
 * True when the endpoint is an upstream Terax release feed. Upstream's feed is kept in
 * the contract only so this check (and reviewers) can prove it is never queried as if it
 * were ours.
 */
export function isUpstreamEndpoint(endpoint: string): boolean {
  const upstream = releaseContract.upstream;
  if (upstream.endpoints.includes(endpoint)) return true;
  const parsed = parseUrl(endpoint);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") {
    return parsed.pathname.startsWith(`/${upstream.repository}/releases`);
  }
  if (host === "api.github.com") {
    return parsed.pathname.startsWith(`/repos/${upstream.repository}/releases`);
  }
  return false;
}

/** Problems that make the contract unusable. Empty means the contract is coherent. */
export function contractProblems(contract: UpdaterContract): string[] {
  const problems: string[] = [];
  if (contract.channel !== "stable")
    problems.push("only the stable channel is supported");
  if (contract.endpoints.length === 0)
    problems.push("no release endpoint configured");
  for (const endpoint of contract.endpoints) {
    const parsed = parseUrl(endpoint);
    if (!parsed) {
      problems.push(`endpoint is not a URL: ${endpoint}`);
      continue;
    }
    if (isUpstreamEndpoint(endpoint)) {
      problems.push(`endpoint is upstream's release feed: ${endpoint}`);
    }
    if (!contract.provisional && !isLoopbackEndpoint(endpoint)) {
      if (parsed.protocol !== "https:") {
        problems.push(`production endpoint must use HTTPS: ${endpoint}`);
      }
      const host = parsed.hostname.toLowerCase();
      if (
        host.endsWith(".invalid") ||
        host.endsWith(".test") ||
        host.endsWith(".example")
      ) {
        problems.push(
          `finalized contract cannot use reserved placeholder host: ${endpoint}`,
        );
      }
    }
  }
  if (contract.check.attempts < 1 || contract.check.attempts > 5) {
    problems.push("check attempts must stay bounded between 1 and 5");
  }
  if (contract.check.timeoutMs <= 0 || contract.check.timeoutMs > 30_000) {
    problems.push("check timeout must stay bounded at or below 30s");
  }
  if (contract.check.baseDelayMs >= contract.check.maxDelayMs) {
    problems.push("backoff base delay must stay below its ceiling");
  }
  if (!contract.provisional && !contract.trust.provisioned) {
    problems.push("finalized contract requires a provisioned trust root");
  }
  if (contract.trust.provisioned) {
    if (contract.trust.publicKey === "") {
      problems.push("a provisioned trust root needs a public key");
    } else {
      const parsedKey = parseMinisignPublicKey(contract.trust.publicKey);
      if (!parsedKey) {
        problems.push(
          "provisioned trust publicKey is not a valid minisign key",
        );
      } else {
        if (
          contract.trust.keyId &&
          contract.trust.keyId.toUpperCase() !== parsedKey.keyIdHex
        ) {
          problems.push(
            `trust keyId ${contract.trust.keyId} does not match publicKey (${parsedKey.keyIdHex})`,
          );
        }
        if (
          contract.trust.fingerprint &&
          contract.trust.fingerprint.toLowerCase() !== parsedKey.fingerprint
        ) {
          problems.push(
            `trust fingerprint ${contract.trust.fingerprint} does not match publicKey (${parsedKey.fingerprint})`,
          );
        }
      }
    }
  }
  if (!contract.trust.provisioned && contract.trust.publicKey !== "") {
    problems.push("an unprovisioned trust root must not carry a key");
  }
  return problems;
}

export interface ResolveContractOptions {
  /** True in a Vite development build (`import.meta.env.DEV`). */
  devMode: boolean;
  /** Thin seam for tests; production passes `import.meta.env`. */
  env?: Record<string, string | boolean | undefined>;
  /** Test-only structural override (never read from the environment). */
  override?: Partial<UpdaterContract>;
}

/**
 * Resolve the contract for this build. The environment override is a development and
 * test seam only: it is ignored outside development, and a non-loopback value is refused
 * so a stray environment variable cannot silently point a development build at a live
 * feed. Changing the real endpoint is a one-file change in `releaseContract.json`.
 */
export function resolveContract({
  devMode,
  env,
  override,
}: ResolveContractOptions): UpdaterContract {
  const envValue = env?.[releaseContract.fixtures.endpointEnv];
  const overrideEndpoint = typeof envValue === "string" ? envValue.trim() : "";

  let endpoints = releaseContract.endpoints;
  if (overrideEndpoint !== "" && devMode) {
    if (!isLoopbackEndpoint(overrideEndpoint)) {
      throw new Error(
        `${releaseContract.fixtures.endpointEnv} must be a loopback endpoint ` +
          `(the isolated fixture server); got ${overrideEndpoint}`,
      );
    }
    endpoints = [overrideEndpoint];
  } else if (overrideEndpoint !== "" && !devMode) {
    console.warn(
      `${releaseContract.fixtures.endpointEnv} is ignored outside a development build`,
    );
  }

  const resolved: UpdaterContract = {
    ...releaseContract,
    ...override,
    endpoints: override?.endpoints ?? endpoints,
  };

  const problems = contractProblems(resolved);
  if (problems.length > 0) {
    throw new Error(`invalid release contract: ${problems.join("; ")}`);
  }
  return resolved;
}

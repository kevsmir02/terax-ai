import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveContract } from "./contract";
import { checkForUpdate } from "./checkForUpdate";
import { createReleaseVerifier } from "./releaseSignature";

// Discovery is tested against isolated files served by an injected fetch. No test reaches
// the network, a real release, a package download or an installer.
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const ENDPOINT = "http://127.0.0.1:8787/stable.json";
const CURRENT = "0.9.0";

const contract = resolveContract({
  devMode: true,
  env: { VITE_TERAX_WORKSPACE_UPDATE_ENDPOINT: ENDPOINT },
});

const fixtureTrust = createReleaseVerifier({ devMode: true, contract });
const productionTrust = createReleaseVerifier({ devMode: false, contract });

const noSleep = vi.fn(async (_ms: number) => {});

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  method: string;
}

/** A fetch double that records every request and answers from a queue. */
function recordingFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const baseOptions = {
  currentVersion: CURRENT,
  contract,
  target: "linux-x86_64",
  now: () => 1_700_000_000_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
  noSleep.mockClear();
});

describe("checkForUpdate", () => {
  it("reports no update when the stable release is not newer", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable-current.json")),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("no-update");
    if (outcome.kind !== "no-update") return;
    expect(outcome.latestVersion).toBe("0.9.0");
    expect(outcome.checkedAt).toBe(1_700_000_000_000);
    expect(calls).toEqual([{ url: ENDPOINT, method: "GET" }]);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("reports an available stable release with its verified artifact contract", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable.json")),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("available");
    if (outcome.kind !== "available") return;
    expect(outcome.release.version).toBe("0.10.0");
    expect(outcome.release.channel).toBe("stable");
    expect(outcome.release.trust).toBe("fixture-unverified");
    expect(outcome.release.artifact.url).toMatch(/\.deb$/);
    expect(calls).toHaveLength(1);
  });

  it("recovers from a transient offline error with bounded backoff", async () => {
    let attempt = 0;
    const { calls, fetchImpl } = recordingFetch(() => {
      attempt += 1;
      if (attempt < 3) throw new TypeError("fetch failed");
      return jsonResponse(fixture("stable.json"));
    });
    const sleep = vi.fn(async (_ms: number) => {});

    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("available");
    expect(calls).toHaveLength(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      contract.check.baseDelayMs,
      contract.check.baseDelayMs * 2,
    ]);
  });

  it("reports offline after the bounded attempts are exhausted", async () => {
    const { calls, fetchImpl } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });

    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("offline");
    expect(outcome.failure.retryable).toBe(true);
    expect(outcome.failure.attempts).toBe(contract.check.attempts);
    expect(calls).toHaveLength(contract.check.attempts);
  });

  it("honours a rate-limit response and stops at the attempt bound", async () => {
    const { calls, fetchImpl } = recordingFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "120", "content-type": "application/json" },
        }),
    );
    const sleep = vi.fn(async (_ms: number) => {});

    const outcome = await checkForUpdate({
      ...baseOptions,
      contract: { ...contract, check: { ...contract.check, attempts: 3 } },
      fetchImpl,
      sleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("rate-limited");
    expect(outcome.failure.status).toBe(429);
    expect(outcome.failure.retryable).toBe(true);
    expect(outcome.failure.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    // Retry-After is capped by the contract so a hostile header cannot park the check.
    for (const [ms] of sleep.mock.calls) {
      expect(ms).toBe(contract.check.maxRetryAfterMs);
    }
  });

  it("reports a timeout without waiting forever", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const outcome = await checkForUpdate({
      ...baseOptions,
      contract: {
        ...contract,
        check: { ...contract.check, timeoutMs: 10, attempts: 2 },
      },
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("timeout");
    expect(outcome.failure.attempts).toBe(2);
  });

  it("rejects malformed JSON without retrying", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse("{ not json"),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("bad-payload");
    expect(outcome.failure.retryable).toBe(false);
    expect(outcome.failure.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("rejects a payload with no artifact for this target", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(
        JSON.stringify({
          version: "0.10.0",
          channel: "stable",
          platforms: {
            "darwin-aarch64": {
              url: "http://127.0.0.1:8787/x.app.tar.gz",
              signature: "x",
            },
          },
        }),
      ),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("unsupported-target");
  });

  it("fails closed on a bad signature instead of reporting an update", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable-bad-signature.json")),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("signature");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("fails closed when no trust root is provisioned", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable.json")),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: productionTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("signature");
    expect(outcome.failure.detail).toMatch(/trust root/i);
  });

  it("refuses a prerelease payload on the stable channel", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable-prerelease.json")),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("unsupported-channel");
  });

  it("reports an unconfigured endpoint without making a request", async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable.json")),
    );
    const outcome = await checkForUpdate({
      ...baseOptions,
      contract: { ...contract, endpoints: [] },
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.failure.reason).toBe("no-endpoint");
    expect(calls).toHaveLength(0);
  });

  it("never requests a package and never invokes a privileged command", async () => {
    const invoke = vi.fn();
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
    const { calls, fetchImpl } = recordingFetch(() =>
      jsonResponse(fixture("stable.json")),
    );

    const outcome = await checkForUpdate({
      ...baseOptions,
      fetchImpl,
      sleep: noSleep,
      verify: fixtureTrust,
    });

    expect(outcome.kind).toBe("available");
    expect(invoke).not.toHaveBeenCalled();
    // Only the manifest endpoint was read: no artifact URL, no package extension.
    expect(calls.map((c) => c.url)).toEqual([ENDPOINT]);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    for (const { url } of calls) {
      expect(url).not.toMatch(/\.(deb|rpm|AppImage|pkg\.tar\.(gz|zst))($|\?)/i);
    }
  });
});

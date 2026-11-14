import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "./checkForUpdate";
import { releaseContract, resolveContract } from "./contract";
import { createReleaseVerifier } from "./releaseSignature";
import { tauriManifestTransport } from "./tauriManifestTransport";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

const ENDPOINT = "http://127.0.0.1:8787/stable.json";

const devContract = resolveContract({
  devMode: true,
  env: { VITE_CODR_UPDATE_ENDPOINT: ENDPOINT },
});

const fixtureTrust = createReleaseVerifier({
  devMode: true,
  contract: devContract,
});
const productionTrust = createReleaseVerifier({
  devMode: false,
  contract: releaseContract,
});

const noSleep = vi.fn(async (_ms: number) => {});

afterEach(() => {
  vi.unstubAllGlobals();
  noSleep.mockClear();
});

describe("tauriManifestTransport", () => {
  it("routes through updater_fetch_manifest with loopback overrides in dev and null in production", async () => {
    const invoke = vi.fn(async () => ({
      status: 200,
      retryAfter: null,
      body: fixture("stable.json"),
    }));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });

    const loopbackOutcome = await checkForUpdate({
      currentVersion: "0.9.0",
      contract: devContract,
      target: "linux-x86_64",
      transport: tauriManifestTransport,
      sleep: noSleep,
      verify: fixtureTrust,
      now: () => 1_700_000_000_000,
    });
    expect(loopbackOutcome.kind).toBe("available");
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      "updater_fetch_manifest",
      { endpointOverride: ENDPOINT },
    ]);

    invoke.mockClear();
    invoke.mockRejectedValueOnce({
      reason: "blocked",
      detail: "HTTPS redirect downgrade refused",
    });

    const blockedOutcome = await checkForUpdate({
      currentVersion: "0.9.0",
      contract: releaseContract,
      target: "linux-x86_64",
      transport: tauriManifestTransport,
      sleep: noSleep,
      verify: productionTrust,
      now: () => 1_700_000_000_000,
    });
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      "updater_fetch_manifest",
      { endpointOverride: null },
    ]);
    expect(blockedOutcome.kind).toBe("failed");
    if (blockedOutcome.kind !== "failed") return;
    expect(blockedOutcome.failure.reason).toBe("blocked");
    expect(blockedOutcome.failure.retryable).toBe(false);
    expect(blockedOutcome.failure.detail).toContain("downgrade");

    invoke.mockClear();
    invoke.mockRejectedValue({
      reason: "offline",
      detail: "connection refused",
    });

    const offlineOutcome = await checkForUpdate({
      currentVersion: "0.9.0",
      contract: releaseContract,
      target: "linux-x86_64",
      transport: tauriManifestTransport,
      sleep: noSleep,
      verify: productionTrust,
      now: () => 1_700_000_000_000,
    });
    expect(offlineOutcome.kind).toBe("failed");
    if (offlineOutcome.kind !== "failed") return;
    expect(offlineOutcome.failure.reason).toBe("offline");
    expect(offlineOutcome.failure.attempts).toBe(
      releaseContract.check.attempts,
    );
  });

  it("classifies unstructured blocked and offline errors from invoke", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("TLS error"));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    vi.stubGlobal("__TAURI_INTERNALS__", { invoke });

    await expect(
      tauriManifestTransport({ endpoint: ENDPOINT, timeoutMs: 8000 }),
    ).rejects.toMatchObject({ reason: "blocked", message: "TLS error" });

    invoke.mockRejectedValueOnce("socket hang up");
    await expect(
      tauriManifestTransport({ endpoint: ENDPOINT, timeoutMs: 8000 }),
    ).rejects.toMatchObject({ reason: "offline", message: "socket hang up" });
  });
});

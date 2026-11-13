import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  contractProblems,
  isLoopbackEndpoint,
  isUpstreamEndpoint,
  releaseContract,
  resolveContract,
} from "./contract";

// The release contract is fork-owned configuration, not a hardcoded upstream feed. These
// guards are deliberately independent of the implementation: a future edit that points the
// fork at upstream (or at a live endpoint before trust provisioning) fails here.
const root = join(import.meta.dirname, "../../..");
const readJson = <T>(path: string) =>
  JSON.parse(readFileSync(join(root, path), "utf8")) as T;
const readText = (path: string) => readFileSync(join(root, path), "utf8");

/** The upstream minisign public key embedded in the inherited Tauri config. */
const UPSTREAM_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNCQUJGRDhBQjYwRTM0NjkKUldScE5BNjJpdjJyT3dIN0dqbUpHaDA4QW1GaDVmTTllRXdZVk96dFNTRUZ3Y2hiVGszYjFqRloK";

/** Provisioned Codr fork minisign public key (key ID 94097B75DB498B21). */
const FORK_PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk0MDk3Qjc1REI0OThCMjEKUldRaGkwbmJkWHNKbEZ1OWI0OHNtallkdFpLelozQW42cmpoS1J6K2tkTDB0RzhmN0RCSmo4bEwK";

interface TauriConfig {
  plugins?: { updater?: { endpoints?: string[]; pubkey?: string } };
}

const tauriConfig = readJson<TauriConfig>("src-tauri/tauri.conf.json");

describe("fork release contract", () => {
  it("defaults to a stable, provisioned, fork-owned release channel", () => {
    expect(releaseContract.provisional).toBe(false);
    expect(releaseContract.channel).toBe("stable");
    expect(releaseContract.endpoints).toEqual([
      "https://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json",
    ]);
    for (const endpoint of releaseContract.endpoints) {
      const parsed = new URL(endpoint);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname.endsWith(".invalid")).toBe(false);
      expect(isLoopbackEndpoint(endpoint)).toBe(false);
    }
    expect(releaseContract.trust.provisioned).toBe(true);
    expect(releaseContract.trust.publicKey).toBe(FORK_PUBKEY);
    expect(releaseContract.trust.keyId).toBe("94097B75DB498B21");
    expect(releaseContract.trust.fingerprint).toBe(
      "sha256:a02fd6ac492d1f070919bde106c20c0a376fbcdb6db8bc4c17ca0efd68197487",
    );
  });

  it("never names the upstream release feed", () => {
    const upstream = releaseContract.upstream.endpoints;
    expect(upstream.length).toBeGreaterThan(0);
    for (const endpoint of releaseContract.endpoints) {
      expect(upstream).not.toContain(endpoint);
      expect(endpoint.includes("crynta")).toBe(false);
      expect(isUpstreamEndpoint(endpoint)).toBe(false);
    }
    expect(contractProblems(releaseContract)).toEqual([]);
  });

  it("rejects placeholder feeds or unprovisioned trust on a finalized contract", () => {
    expect(
      contractProblems({
        ...releaseContract,
        endpoints: ["https://updates.invalid/codr/stable/latest.json"],
      }),
    ).not.toEqual([]);
    expect(
      contractProblems({
        ...releaseContract,
        endpoints: [
          "http://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json",
        ],
      }),
    ).not.toEqual([]);
    expect(
      contractProblems({
        ...releaseContract,
        trust: { ...releaseContract.trust, provisioned: false, publicKey: "" },
      }),
    ).not.toEqual([]);
    expect(
      contractProblems({
        ...releaseContract,
        trust: { ...releaseContract.trust, publicKey: "not-a-valid-key" },
      }),
    ).not.toEqual([]);
    expect(
      contractProblems({
        ...releaseContract,
        trust: { ...releaseContract.trust, keyId: "0000000000000000" },
      }),
    ).not.toEqual([]);
    expect(
      contractProblems({
        ...releaseContract,
        trust: {
          ...releaseContract.trust,
          fingerprint:
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      }),
    ).not.toEqual([]);
  });

  it("is mirrored into the Tauri updater config instead of upstream's feed", () => {
    const endpoints = tauriConfig.plugins?.updater?.endpoints ?? [];
    expect(endpoints).toEqual(releaseContract.endpoints);
    for (const endpoint of endpoints) {
      expect(isUpstreamEndpoint(endpoint)).toBe(false);
    }
    expect(tauriConfig.plugins?.updater?.pubkey).toBe(
      releaseContract.trust.publicKey,
    );
    expect(tauriConfig.plugins?.updater?.pubkey).toBe(FORK_PUBKEY);
    expect(readText("src-tauri/tauri.conf.json")).not.toContain(
      UPSTREAM_PUBKEY,
    );
  });

  it("bounds the check knobs it hands to the checker", () => {
    const { check } = releaseContract;
    expect(check.timeoutMs).toBeGreaterThan(0);
    expect(check.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(check.attempts).toBeGreaterThanOrEqual(1);
    expect(check.attempts).toBeLessThanOrEqual(5);
    expect(check.baseDelayMs).toBeGreaterThanOrEqual(0);
    expect(check.baseDelayMs).toBeLessThan(check.maxDelayMs);
    expect(check.intervalMs).toBeGreaterThan(0);
    expect(check.intervalMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("accepts a loopback fixture endpoint only in development", () => {
    const fixture = "http://127.0.0.1:8787/stable.json";
    const dev = resolveContract({
      devMode: true,
      env: { VITE_CODR_UPDATE_ENDPOINT: fixture },
    });
    expect(dev.endpoints).toEqual([fixture]);

    const production = resolveContract({
      devMode: false,
      env: { VITE_CODR_UPDATE_ENDPOINT: fixture },
    });
    expect(production.endpoints).toEqual(releaseContract.endpoints);

    expect(() =>
      resolveContract({
        devMode: true,
        env: {
          VITE_CODR_UPDATE_ENDPOINT: "https://releases.example.com/stable.json",
        },
      }),
    ).toThrow(/loopback/i);
  });

  it("keeps the check path free of the native installer plugins", () => {
    // Discovery must not depend on the optional native installer choice (#39 owns it).
    for (const file of [
      "checkForUpdate.ts",
      "useUpdater.ts",
      "contract.ts",
      "releaseManifest.ts",
    ]) {
      const source = readText(`src/modules/updater/${file}`);
      expect(source).not.toContain("@tauri-apps/plugin-updater");
      expect(source).not.toContain("@tauri-apps/plugin-process");
    }
  });
});

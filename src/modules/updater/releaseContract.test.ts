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

interface TauriConfig {
  plugins?: { updater?: { endpoints?: string[]; pubkey?: string } };
}

const tauriConfig = readJson<TauriConfig>("src-tauri/tauri.conf.json");

describe("fork release contract", () => {
  it("defaults to a stable, provisional, non-live channel", () => {
    expect(releaseContract.provisional).toBe(true);
    expect(releaseContract.channel).toBe("stable");
    expect(releaseContract.endpoints.length).toBeGreaterThan(0);
    for (const endpoint of releaseContract.endpoints) {
      // `.invalid` is reserved by RFC 2606 and never resolves: the default cannot be a
      // live release feed that someone accidentally trusts.
      expect(new URL(endpoint).hostname.endsWith(".invalid")).toBe(true);
      expect(isLoopbackEndpoint(endpoint)).toBe(false);
    }
    expect(releaseContract.trust.provisioned).toBe(false);
    expect(releaseContract.trust.publicKey).toBe("");
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

  it("is mirrored into the inert Tauri updater config instead of upstream's feed", () => {
    const endpoints = tauriConfig.plugins?.updater?.endpoints ?? [];
    expect(endpoints).toEqual(releaseContract.endpoints);
    for (const endpoint of endpoints) {
      expect(isUpstreamEndpoint(endpoint)).toBe(false);
    }
    // The inherited upstream signing key is not this fork's trust root. Until #39/#40
    // provision one, an empty key is honest: the native install path cannot verify.
    expect(tauriConfig.plugins?.updater?.pubkey).toBe("");
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
      env: { VITE_TERAX_WORKSPACE_UPDATE_ENDPOINT: fixture },
    });
    expect(dev.endpoints).toEqual([fixture]);

    const production = resolveContract({
      devMode: false,
      env: { VITE_TERAX_WORKSPACE_UPDATE_ENDPOINT: fixture },
    });
    expect(production.endpoints).toEqual(releaseContract.endpoints);

    expect(() =>
      resolveContract({
        devMode: true,
        env: {
          VITE_TERAX_WORKSPACE_UPDATE_ENDPOINT:
            "https://releases.example.com/stable.json",
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

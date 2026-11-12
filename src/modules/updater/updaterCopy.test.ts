import { describe, expect, it } from "vitest";
import type { CheckFailure } from "./checkForUpdate";
import type { AvailableRelease } from "./releaseManifest";
import type { UpdaterState } from "./updateState";
import { checkSummary, failureSummary, trustNote } from "./updaterCopy";

const release: AvailableRelease = {
  version: "0.10.0",
  channel: "stable",
  notes: "Fork stable fixture.",
  publishedAt: "2026-10-01T12:00:00Z",
  trust: "fixture-unverified",
  artifact: {
    url: "http://127.0.0.1:8787/Terax_0.10.0_amd64.deb",
    signature: "untrusted comment: fixture\nAA==\ntrusted comment: fixture",
    size: 1234,
  },
};

const failure = (reason: CheckFailure["reason"]): CheckFailure => ({
  reason,
  detail: "detail",
  attempts: 3,
  retryable: true,
});

describe("updater copy", () => {
  it("says an available update has not been downloaded yet", () => {
    const summary = checkSummary({
      kind: "update-available",
      checkedAt: 1,
      release,
    });
    expect(summary.title).toMatch(/0\.10\.0/);
    expect(summary.detail).toMatch(/package tool|download/i);
    expect(summary.detail).not.toMatch(/downloaded|installing now/i);
  });

  it("labels a handed-off update as not installed", () => {
    const summary = checkSummary({
      kind: "handoff-unavailable",
      release,
      ticket: 39,
      detail: "This build only discovers updates.",
    });
    expect(summary.detail).toContain("This build only discovers updates.");
    expect(summary.action).toBe("dismiss");
    expect(summary.detail).not.toMatch(/installed|restart to finish/i);
  });

  it("marks a fixture release as not cryptographically verified", () => {
    expect(trustNote(release)).toMatch(/not cryptographically verified/i);
    expect(trustNote({ ...release, trust: "verified" })).toBe("");
  });

  it("distinguishes every check failure without claiming success", () => {
    const cases: { reason: CheckFailure["reason"]; match: RegExp }[] = [
      { reason: "offline", match: /offline|not reachable/i },
      { reason: "timeout", match: /timed out/i },
      { reason: "rate-limited", match: /rate limit|slow down/i },
      { reason: "server-error", match: /release feed/i },
      { reason: "bad-payload", match: /invalid|unexpected/i },
      { reason: "unsupported-channel", match: /channel/i },
      { reason: "unsupported-target", match: /platform|target/i },
      { reason: "signature", match: /verif/i },
      { reason: "no-endpoint", match: /no release endpoint/i },
      { reason: "misconfigured", match: /configuration/i },
    ];
    for (const { reason, match } of cases) {
      const text = failureSummary(failure(reason));
      expect(text).toMatch(match);
      expect(text).not.toMatch(/installed|restart to finish/i);
    }
  });

  it("reports the three discovery outcomes separately", () => {
    const states: UpdaterState[] = [
      { kind: "up-to-date", checkedAt: 1, latestVersion: "0.9.0" },
      { kind: "update-available", checkedAt: 1, release },
      {
        kind: "check-failed",
        checkedAt: 1,
        failure: failure("signature"),
      },
    ];
    expect(checkSummary(states[0] as UpdaterState).title).toMatch(
      /up to date/i,
    );
    expect(checkSummary(states[1] as UpdaterState).title).toMatch(/available/i);
    expect(checkSummary(states[2] as UpdaterState).title).toMatch(/failed/i);
  });
});

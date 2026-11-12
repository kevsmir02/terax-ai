import { describe, expect, it } from "vitest";
import type { CheckOutcome } from "./checkForUpdate";
import type { AvailableRelease } from "./releaseManifest";
import {
  canRequestDownload,
  initialUpdaterState,
  reduceUpdaterState,
  shouldRunCheck,
  type UpdaterEvent,
  type UpdaterState,
} from "./updateState";

const release: AvailableRelease = {
  version: "0.10.0",
  channel: "stable",
  notes: "fixture",
  publishedAt: "2026-10-01T12:00:00Z",
  trust: "fixture-unverified",
  artifact: {
    url: "http://127.0.0.1:8787/Terax_0.10.0_amd64.deb",
    signature: "untrusted comment: fixture\nAA==\ntrusted comment: fixture",
    size: 1234,
  },
};

const available: CheckOutcome = {
  kind: "available",
  currentVersion: "0.9.0",
  checkedAt: 10,
  attempts: 1,
  release,
};

const upToDate: CheckOutcome = {
  kind: "no-update",
  currentVersion: "0.9.0",
  checkedAt: 20,
  attempts: 1,
  latestVersion: "0.9.0",
};

const failed: CheckOutcome = {
  kind: "failed",
  currentVersion: "0.9.0",
  checkedAt: 30,
  attempts: 3,
  failure: {
    reason: "offline",
    detail: "fetch failed",
    attempts: 3,
    retryable: true,
  },
};

const run = (
  events: UpdaterEvent[],
  start: UpdaterState = initialUpdaterState,
) => events.reduce(reduceUpdaterState, start);

describe("updater state machine", () => {
  it("moves from idle to checking to an available update", () => {
    const checking = run([{ type: "check-started", manual: false, at: 5 }]);
    expect(checking).toEqual({ kind: "checking", manual: false, startedAt: 5 });

    const settled = run(
      [{ type: "check-settled", outcome: available, at: 10 }],
      checking,
    );
    expect(settled.kind).toBe("update-available");
    if (settled.kind !== "update-available") return;
    expect(settled.release.version).toBe("0.10.0");
    expect(settled.checkedAt).toBe(10);
    expect(canRequestDownload(settled)).toBe(true);
  });

  it("reports no update separately from a failed check", () => {
    const current = run([
      { type: "check-started", manual: false, at: 1 },
      { type: "check-settled", outcome: upToDate, at: 20 },
    ]);
    expect(current).toEqual({
      kind: "up-to-date",
      checkedAt: 20,
      latestVersion: "0.9.0",
    });

    const failure = run([
      { type: "check-started", manual: false, at: 1 },
      { type: "check-settled", outcome: failed, at: 30 },
    ]);
    expect(failure.kind).toBe("check-failed");
    if (failure.kind !== "check-failed") return;
    expect(failure.failure.reason).toBe("offline");
    expect(failure.knownRelease).toBeUndefined();
    expect(canRequestDownload(failure)).toBe(false);
  });

  it("keeps a previously discovered release when a later check fails", () => {
    const state = run([
      { type: "check-started", manual: true, at: 1 },
      { type: "check-settled", outcome: available, at: 10 },
      { type: "check-started", manual: true, at: 20 },
      { type: "check-settled", outcome: failed, at: 30 },
    ]);
    expect(state.kind).toBe("check-failed");
    if (state.kind !== "check-failed") return;
    expect(state.knownRelease?.version).toBe("0.10.0");
    // A failed check never authorizes a download by itself.
    expect(canRequestDownload(state)).toBe(false);
  });

  it("queues a check while one is running instead of stacking requests", () => {
    const checking = run([{ type: "check-started", manual: false, at: 5 }]);
    const again = run(
      [{ type: "check-started", manual: true, at: 6 }],
      checking,
    );
    expect(again).toBe(checking);
  });

  it("turns a gated download request into an explicit handoff-unavailable state", () => {
    const discovered = run([
      { type: "check-started", manual: true, at: 1 },
      { type: "check-settled", outcome: available, at: 10 },
    ]);

    const requested = run(
      [
        {
          type: "download-requested",
          result: {
            kind: "not-implemented",
            ticket: 39,
            detail: "package handoff lands in #39",
          },
          at: 11,
        },
      ],
      discovered,
    );

    expect(requested.kind).toBe("handoff-unavailable");
    if (requested.kind !== "handoff-unavailable") return;
    expect(requested.release.version).toBe("0.10.0");
    expect(requested.ticket).toBe(39);
    // The UI must never claim an install happened: no "installed"/"ready" state exists.
    expect(["handoff-unavailable", "update-available"]).toContain(
      requested.kind,
    );
  });

  it("ignores a download event without a discovered, approved release", () => {
    const idle = run([
      {
        type: "download-requested",
        result: { kind: "not-implemented", ticket: 39, detail: "no release" },
        at: 3,
      },
    ]);
    expect(idle).toEqual(initialUpdaterState);
  });

  it("returns to idle when dismissed", () => {
    const discovered = run([
      { type: "check-started", manual: true, at: 1 },
      { type: "check-settled", outcome: available, at: 10 },
    ]);
    expect(run([{ type: "dismissed" }], discovered)).toEqual(
      initialUpdaterState,
    );
  });
});

describe("automatic check throttle", () => {
  const intervalMs = 30 * 60 * 1000;

  it("skips an automatic check inside the interval and allows it after", () => {
    expect(
      shouldRunCheck({
        lastCheckedAt: 1_000,
        now: 1_000 + intervalMs - 1,
        intervalMs,
      }),
    ).toBe(false);
    expect(
      shouldRunCheck({
        lastCheckedAt: 1_000,
        now: 1_000 + intervalMs,
        intervalMs,
      }),
    ).toBe(true);
    expect(shouldRunCheck({ lastCheckedAt: null, now: 5, intervalMs })).toBe(
      true,
    );
  });

  it("always lets an explicit user check through", () => {
    expect(
      shouldRunCheck({
        lastCheckedAt: 1_000,
        now: 1_001,
        intervalMs,
        manual: true,
      }),
    ).toBe(true);
  });
});

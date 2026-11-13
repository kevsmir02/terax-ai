import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckOutcome } from "./checkForUpdate";
import {
  type HandoffApproval,
  type HandoffWork,
  handoffSnapshot,
} from "./handoffReadiness";
import type { AvailableRelease } from "./releaseManifest";
import {
  canRequestDownload,
  canRequestHandoff,
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

const nothingAtStake: HandoffWork = { buffers: [], processes: [], agents: [] };

const approvalAt = (at: number): HandoffApproval => ({
  at,
  snapshot: handoffSnapshot(nothingAtStake),
});

const discoveredUpdate = () =>
  run([
    { type: "check-started", manual: true, at: 1 },
    { type: "check-settled", outcome: available, at: 10 },
  ]);

describe("package-tool handoff readiness", () => {
  it("checks the live state on approval and hands off only when the check is clear", () => {
    const checking = run(
      [{ type: "handoff-approved", approval: approvalAt(100) }],
      discoveredUpdate(),
    );
    expect(checking.kind).toBe("handoff-checking");
    if (checking.kind !== "handoff-checking") return;
    expect(checking.approval.at).toBe(100);

    const handedOff = run(
      [
        {
          type: "handoff-assessed",
          at: 101,
          approval: approvalAt(100),
          work: nothingAtStake,
        },
      ],
      checking,
    );
    expect(handedOff).toEqual({
      kind: "handed-off",
      release,
      approvedAt: 100,
      handedOffAt: 101,
    });
    // A handed-off update is the end of the app's involvement: no further approval.
    expect(canRequestHandoff(handedOff)).toBe(false);
  });

  it("blocks the handoff and names the work the readiness check found", () => {
    const checking = run(
      [{ type: "handoff-approved", approval: approvalAt(100) }],
      discoveredUpdate(),
    );
    const blocked = run(
      [
        {
          type: "handoff-assessed",
          at: 101,
          approval: approvalAt(100),
          work: {
            buffers: [{ spaceId: "space-a", tabId: 7, title: "src/app.ts" }],
            processes: [],
            agents: [],
          },
        },
      ],
      checking,
    );
    expect(blocked.kind).toBe("handoff-blocked");
    if (blocked.kind !== "handoff-blocked") return;
    expect(blocked.hazards).toEqual([
      { kind: "buffer", tabId: 7, spaceId: "space-a", title: "src/app.ts" },
    ]);
    expect(blocked.summary).toContain("src/app.ts");
    expect(blocked.startedAfterApproval).toBe(true);
    expect(canRequestHandoff(blocked)).toBe(true);
  });

  it("requires a fresh approval and ignores an assessment taken against the old one", () => {
    const checking = run(
      [{ type: "handoff-approved", approval: approvalAt(100) }],
      discoveredUpdate(),
    );
    const blocked = run(
      [
        {
          type: "handoff-assessed",
          at: 101,
          approval: approvalAt(100),
          work: {
            buffers: [],
            processes: [{ spaceId: "space-a", leafId: 41, state: "running" }],
            agents: [],
          },
        },
      ],
      checking,
    );
    expect(blocked.kind).toBe("handoff-blocked");

    // The old approval cannot carry the work it was blocked on: the person has to
    // approve again, and a late assessment of the previous attempt changes nothing.
    const replayed = run(
      [
        {
          type: "handoff-assessed",
          at: 102,
          approval: approvalAt(100),
          work: nothingAtStake,
        },
      ],
      blocked,
    );
    expect(replayed).toBe(blocked);

    const reapproved = run(
      [{ type: "handoff-approved", approval: approvalAt(200) }],
      blocked,
    );
    expect(reapproved.kind).toBe("handoff-checking");
    if (reapproved.kind !== "handoff-checking") return;
    expect(reapproved.approval.at).toBe(200);

    const handedOff = run(
      [
        {
          type: "handoff-assessed",
          at: 201,
          approval: approvalAt(200),
          work: nothingAtStake,
        },
      ],
      reapproved,
    );
    expect(handedOff.kind).toBe("handed-off");
  });

  it("ignores an assessment that belongs to a superseded approval", () => {
    const checking = run(
      [{ type: "handoff-approved", approval: approvalAt(200) }],
      discoveredUpdate(),
    );
    const late = run(
      [
        {
          type: "handoff-assessed",
          at: 201,
          approval: approvalAt(100),
          work: nothingAtStake,
        },
      ],
      checking,
    );
    expect(late).toBe(checking);
  });

  it("does not accept an approval without a discovered release", () => {
    expect(
      run([{ type: "handoff-approved", approval: approvalAt(1) }]),
    ).toEqual(initialUpdaterState);
  });

  it("has no installed or ready state", () => {
    // The app hands off and stops; only the package tool can install. The union is
    // read from its source so a future `installed`/`ready` member fails here.
    const source = readFileSync(
      join(import.meta.dirname, "updateState.ts"),
      "utf8",
    );
    const union = source.slice(
      source.indexOf("export type UpdaterState"),
      source.indexOf("export type UpdaterEvent"),
    );
    expect(union).toContain('kind: "handed-off"');
    expect(union).not.toMatch(/kind: "installed"/);
    expect(union).not.toMatch(/kind: "ready"/);
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

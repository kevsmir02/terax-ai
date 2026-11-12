import { describe, expect, it } from "vitest";
import type { RecoveryRecord } from "@/modules/editor/lib/recovery/model";
import {
  createRecoveryManager,
  type RecoveryStatus,
  type RecoveryStorage,
  type RecoveryStorageFailure,
} from "@/modules/editor/lib/recovery/manager";
import { flushRecovery } from "./flush";

/** Timers are recorded, never fired: a test fires the bound when it means to. */
function timers() {
  const armed: Array<() => void> = [];
  const cancelled: unknown[] = [];
  return {
    armed,
    schedule: (fn: () => void, _ms: number) => {
      armed.push(fn);
      return armed.length;
    },
    cancel: (handle: unknown) => {
      cancelled.push(handle);
    },
    cancelled,
    fire() {
      for (const fn of armed.splice(0)) fn();
    },
  };
}

class Storage implements RecoveryStorage {
  records = new Map<string, RecoveryRecord>();
  hold: Promise<void> | null = null;
  release: (() => void) | null = null;
  failNext: RecoveryStorageFailure | null = null;

  holdNextWrite(): void {
    this.hold = new Promise((resolve) => {
      this.release = () => {
        this.hold = null;
        this.release = null;
        resolve();
      };
    });
  }

  async list(): Promise<RecoveryRecord[]> {
    return [...this.records.values()];
  }

  async write(record: RecoveryRecord): Promise<{ totalBytes: number }> {
    if (this.hold) await this.hold;
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      throw failure;
    }
    this.records.set(record.bufferId, record);
    return { totalBytes: 0 };
  }

  async remove(): Promise<{ removed: boolean; totalBytes: number }> {
    return { removed: false, totalBytes: 0 };
  }

  async usage(): Promise<number> {
    return 0;
  }
}

function harness() {
  const storage = new Storage();
  const clock = timers();
  const manager = createRecoveryManager({
    storage,
    enabled: () => true,
    now: () => 0,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { storage, manager, clock };
}

const status = (
  bufferId: string,
  overrides: Partial<RecoveryStatus> = {},
): RecoveryStatus => ({
  kind: "durable",
  bufferId,
  bufferRevision: 1,
  durableRevision: 1,
  bytes: 1,
  totalBytes: 1,
  scheduled: false,
  ...overrides,
});

describe("bounded quit flush", () => {
  it("reports a settled flush with nothing left to save", async () => {
    const { manager, clock } = harness();
    const buffer = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/tmp/a.ts",
      diskRevision: null,
    });
    buffer.edit({ text: "one", diskRevision: null });

    const report = await flushRecovery({
      flush: () => manager.flushAll(),
      statuses: () => manager.statuses(),
      timeoutMs: 1000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    expect(report.outcome).toBe("settled");
    expect(report.drafts).toEqual([]);
  });

  it("reports a failed write as a draft that is not saved", async () => {
    const { manager, storage, clock } = harness();
    const buffer = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/tmp/a.ts",
      diskRevision: null,
    });
    storage.failNext = { kind: "failed", message: "disk on fire" };
    buffer.edit({ text: "one", diskRevision: null });

    const report = await flushRecovery({
      flush: () => manager.flushAll(),
      statuses: () => manager.statuses(),
      timeoutMs: 1000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    expect(report.outcome).toBe("settled");
    expect(report.drafts).toEqual([
      expect.objectContaining({
        bufferId: "buf-a",
        state: "failed",
        message: "disk on fire",
      }),
    ]);
  });

  it("stops waiting after the bound and reports the drafts it could not settle", async () => {
    const { manager, storage, clock } = harness();
    const buffer = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/tmp/a.ts",
      diskRevision: null,
    });
    storage.holdNextWrite();
    buffer.edit({ text: "slow", diskRevision: null });

    const flush = manager.flushAll();
    const pending = flushRecovery({
      flush: () => flush,
      statuses: () => manager.statuses(),
      timeoutMs: 3000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    // The write never resolves; the quit path must not wait forever.
    clock.fire();
    const report = await pending;

    expect(report.outcome).toBe("timeout");
    expect(report.drafts).toEqual([
      expect.objectContaining({ bufferId: "buf-a", state: "unsettled" }),
    ]);

    // The write still completes; a retry then sees it as durable.
    storage.release?.();
    await flush;
    expect(buffer.status().kind).toBe("durable");
    const retry = await flushRecovery({
      flush: () => manager.flushAll(),
      statuses: () => manager.statuses(),
      timeoutMs: 3000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(retry.outcome).toBe("settled");
    expect(retry.drafts).toEqual([]);
  });

  it("reports text typed while the flush was in flight as still pending", async () => {
    const { manager, storage, clock } = harness();
    const buffer = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/tmp/a.ts",
      diskRevision: null,
    });
    storage.holdNextWrite();
    buffer.edit({ text: "first", diskRevision: null });

    const pending = flushRecovery({
      flush: () => manager.flushAll(),
      statuses: () => manager.statuses(),
      timeoutMs: 3000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    // Newer text arrives while the first write is still open.
    buffer.edit({ text: "first, plus more", diskRevision: null });
    storage.release?.();
    const report = await pending;

    // The write acknowledged the older revision only, so the newer text is not
    // "saved" just because a write completed.
    expect(report.outcome).toBe("settled");
    expect(report.drafts).toEqual([
      expect.objectContaining({ bufferId: "buf-a", state: "pending" }),
    ]);

    // A retry flushes the newer text; only then is the buffer settled.
    const retry = await flushRecovery({
      flush: () => manager.flushAll(),
      statuses: () => manager.statuses(),
      timeoutMs: 3000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(retry.drafts).toEqual([]);
    expect(storage.records.get("buf-a")?.text).toBe("first, plus more");
  });

  it("does not treat a disabled, excluded or idle buffer as a draft to save", async () => {
    const records: RecoveryStatus[] = [
      status("buf-off", { kind: "off" }),
      status("buf-excluded", { kind: "excluded" }),
      status("buf-idle", { kind: "idle" }),
      status("buf-durable", { kind: "durable" }),
      status("buf-paused", { kind: "paused", reason: "total-limit" }),
      status("buf-unavailable", { kind: "unavailable" }),
    ];
    const clock = timers();
    const report = await flushRecovery({
      flush: async () => new Map(records.map((r) => [r.bufferId, r])),
      statuses: () => new Map(records.map((r) => [r.bufferId, r])),
      timeoutMs: 1000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(report.drafts.map((d) => d.bufferId)).toEqual([
      "buf-paused",
      "buf-unavailable",
    ]);
    expect(report.drafts.map((d) => d.state)).toEqual([
      "paused",
      "unavailable",
    ]);
  });

  it("does not acknowledge a revision the durable record does not cover", async () => {
    const record = status("buf-a", {
      kind: "durable",
      bufferRevision: 3,
      durableRevision: 2,
    });
    const clock = timers();
    const report = await flushRecovery({
      flush: async () => new Map([["buf-a", record]]),
      statuses: () => new Map([["buf-a", record]]),
      timeoutMs: 1000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(report.drafts).toEqual([
      expect.objectContaining({ bufferId: "buf-a", state: "pending" }),
    ]);
  });

  it("reports a buffer that vanished behind the status it returned", async () => {
    const clock = timers();
    const report = await flushRecovery({
      flush: async () =>
        new Map([["buf-a", status("buf-a", { kind: "failed", message: "" })]]),
      statuses: () =>
        new Map([["buf-a", status("buf-a", { kind: "failed", message: "" })]]),
      timeoutMs: 1000,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    expect(report.drafts.map((d) => d.state)).toEqual(["failed"]);
  });
});

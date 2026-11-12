import { describe, expect, it } from "vitest";
import {
  isStaleCompletion,
  planCleanup,
  planRestore,
} from "./cleanup";
import { makeRecord, recordBytes, type RecoveryRecord } from "./model";
import {
  createRecoveryManager,
  type RecoveryStatus,
  type RecoveryStorage,
  type RecoveryStorageFailure,
} from "./manager";

const MiB = 1024 * 1024;

class MemoryStorage implements RecoveryStorage {
  records = new Map<string, RecoveryRecord>();
  /** When set, the next `write` waits for this before touching the map. */
  hold: Promise<void> | null = null;
  release: (() => void) | null = null;
  failNext: RecoveryStorageFailure | null = null;
  writes: RecoveryRecord[] = [];
  removes: Array<{ bufferId: string; upToRevision: number }> = [];

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
    this.writes.push(record);
    this.records.set(record.bufferId, record);
    return { totalBytes: this.totalBytes() };
  }

  async remove(
    bufferId: string,
    upToRevision: number,
  ): Promise<{ removed: boolean; totalBytes: number }> {
    this.removes.push({ bufferId, upToRevision });
    const existing = this.records.get(bufferId);
    if (existing && existing.bufferRevision <= upToRevision) {
      this.records.delete(bufferId);
      return { removed: true, totalBytes: this.totalBytes() };
    }
    return { removed: false, totalBytes: this.totalBytes() };
  }

  async usage(): Promise<number> {
    return this.totalBytes();
  }

  totalBytes(): number {
    let total = 0;
    for (const record of this.records.values()) total += recordBytes(record);
    return total;
  }
}

function harness(options: { enabled?: boolean } = {}) {
  const clock = new FakeClock();
  const storage = new MemoryStorage();
  let enabled = options.enabled ?? true;

  const manager = createRecoveryManager({
    storage,
    enabled: () => enabled,
    now: () => clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  return {
    clock,
    storage,
    manager,
    status(bufferId: string): RecoveryStatus {
      const buf = manager.bufferById(bufferId);
      if (!buf) throw new Error(`no buffer ${bufferId}`);
      return buf.status();
    },
    setEnabled(next: boolean) {
      enabled = next;
      manager.enabledChanged();
    },
    /** Advances virtual time so timers fire and their writes settle. */
    async advance(ms: number): Promise<void> {
      await clock.advanceTo(clock.now + ms);
    },
  };
}

class FakeClock {
  now = 0;
  private nextId = 1;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];

  schedule = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.push({ id, at: this.now + Math.max(0, ms), fn });
    return id;
  };

  cancel = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };

  async advanceTo(target: number): Promise<void> {
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
      await settle();
    }
    this.now = Math.max(this.now, target);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function openBuffer(
  h: ReturnType<typeof harness>,
  input: {
    bufferId: string;
    spaceId?: string;
    path?: string;
    diskRevision?: string | null;
  },
) {
  return h.manager.buffer({
    bufferId: input.bufferId,
    spaceId: input.spaceId ?? "sp-a",
    path: input.path ?? "/home/me/notes.txt",
    diskRevision: input.diskRevision ?? "r1:aa:1:8-9",
  });
}

describe("opt-in", () => {
  it("is off by default and writes nothing", async () => {
    const h = harness({ enabled: false });
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "typing", diskRevision: null });
    await h.advance(5000);
    expect(h.storage.writes).toHaveLength(0);
    expect(h.status("buf-a").kind).toBe("off");
  });

  it("starts writing once the user enables it", async () => {
    const h = harness({ enabled: false });
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "typing", diskRevision: null });
    await h.advance(5000);
    expect(h.storage.writes).toHaveLength(0);

    h.setEnabled(true);
    buf.edit({ text: "typing more", diskRevision: null });
    await h.advance(2000);
    expect(h.storage.writes).toHaveLength(1);
    expect(h.storage.records.get("buf-a")?.text).toBe("typing more");
  });
});

describe("record identity", () => {
  it("persists a stable buffer id, file identity and both revisions", async () => {
    const h = harness();
    const diskRevision = `r1:${"ab".repeat(32)}:8:8-9`;
    const buf = openBuffer(h, { bufferId: "buf-a", diskRevision });
    buf.edit({ text: "one", diskRevision });
    buf.edit({ text: "one two", diskRevision });
    await h.advance(2000);

    const stored = h.storage.records.get("buf-a");
    expect(stored).toBeDefined();
    expect(stored?.bufferId).toBe("buf-a");
    expect(stored?.fileIdentity).toBe("8-9");
    expect(stored?.diskRevision).toBe(diskRevision);
    expect(stored?.bufferRevision).toBeGreaterThanOrEqual(2);
    expect(stored?.text).toBe("one two");
    expect(h.status("buf-a")).toMatchObject({
      kind: "durable",
      bufferRevision: stored?.bufferRevision,
      durableRevision: stored?.bufferRevision,
    });
  });

  it("keeps two Spaces editing one pathname as two independent records", async () => {
    const h = harness();
    const a = openBuffer(h, {
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
    });
    const b = openBuffer(h, {
      bufferId: "buf-b",
      spaceId: "sp-b",
      path: "/home/me/notes.txt",
    });
    a.edit({ text: "from A", diskRevision: null });
    b.edit({ text: "from B", diskRevision: null });
    await h.advance(2000);

    expect(h.storage.records.size).toBe(2);
    expect(h.storage.records.get("buf-a")?.spaceId).toBe("sp-a");
    expect(h.storage.records.get("buf-b")?.spaceId).toBe("sp-b");
    expect(h.storage.records.get("buf-a")?.text).toBe("from A");
    expect(h.storage.records.get("buf-b")?.text).toBe("from B");
  });
});

describe("coalescing", () => {
  it("schedules a write inside two seconds of continuous editing", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    for (let i = 0; i < 20; i += 1) {
      buf.edit({ text: `v${i}`, diskRevision: null });
      await h.advance(200);
    }
    expect(h.storage.writes.length).toBeGreaterThanOrEqual(2);
    expect(h.status("buf-a").kind).toBe("pending");
    await h.advance(2000);
    expect(h.status("buf-a").kind).toBe("durable");
  });
});

describe("quota", () => {
  it("pauses the buffer over the per-file bound and keeps the older record", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "small", diskRevision: null });
    await h.advance(2000);
    const older = h.storage.records.get("buf-a");
    expect(older?.text).toBe("small");

    // 10 MiB of draft text plus the record envelope exceeds the per-file bound.
    buf.edit({ text: "x".repeat(10 * MiB), diskRevision: null });
    await h.advance(5000);

    expect(h.status("buf-a").kind).toBe("paused");
    expect(h.status("buf-a").reason).toBe("file-limit");
    // Nothing was evicted and nothing was written over the valid draft.
    expect(h.storage.records.get("buf-a")?.text).toBe("small");

    // Shrinking the text resumes recovery rather than staying stuck.
    buf.edit({ text: "small again", diskRevision: null });
    await h.advance(2000);
    expect(h.status("buf-a").kind).toBe("durable");
    expect(h.storage.records.get("buf-a")?.text).toBe("small again");
  });

  it("resumes an idle buffer that another buffer's total-bound refusal paused", async () => {
    // Reviewed defect: `pauseAll` stops every coalescer permanently, and resume
    // used to rebuild only buffers with pending text. A buffer that was idle
    // and durable at the pause then never scheduled again — its next edit sat
    // as "pending" until a quit flush, unprotected against a crash.
    const limits = {
      perFileBytes: 10 * MiB,
      totalBytes: 12 * MiB,
      directory: "recovery",
    };
    const clock = new FakeClock();
    const storage = new MemoryStorage();
    const manager = createRecoveryManager({
      storage,
      limits,
      enabled: () => true,
      now: () => clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    const a = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/a.txt",
      diskRevision: null,
    });
    const b = manager.buffer({
      bufferId: "buf-b",
      spaceId: "sp-a",
      path: "/home/me/b.txt",
      diskRevision: null,
    });

    const eight = "a".repeat(8 * MiB);
    a.edit({ text: eight, diskRevision: null });
    await clock.advanceTo(2000);
    await settle();
    expect(a.status().kind).toBe("durable");

    // B hits the total bound: recovery pauses for every buffer, including the
    // idle-and-durable A.
    b.edit({ text: "b".repeat(8 * MiB), diskRevision: null });
    await clock.advanceTo(4000);
    await settle();
    expect(b.status().kind).toBe("paused");
    expect(a.status().kind).toBe("paused");

    // B's resolution resumes recovery; A's own draft is still durable.
    await b.discard();
    expect(a.status().kind).toBe("durable");

    a.edit({ text: "typed after the pause", diskRevision: null });
    expect(a.status().kind).toBe("pending");
    // A pending write that is actually scheduled is honest progress, not a stall.
    expect(a.status().scheduled).toBe(true);
    await clock.advanceTo(8000);
    await settle();

    expect(a.status().kind).toBe("durable");
    expect(a.status().scheduled).toBe(false);
    expect(storage.records.get("buf-a")?.text).toBe("typed after the pause");
  });

  it("pauses every buffer at the total bound and resumes when a draft is resolved", async () => {
    const limits = {
      perFileBytes: 10 * MiB,
      totalBytes: 12 * MiB,
      directory: "recovery",
    };
    const clock = new FakeClock();
    const storage = new MemoryStorage();
    const manager = createRecoveryManager({
      storage,
      limits,
      enabled: () => true,
      now: () => clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    const a = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/a.txt",
      diskRevision: null,
    });
    const b = manager.buffer({
      bufferId: "buf-b",
      spaceId: "sp-a",
      path: "/home/me/b.txt",
      diskRevision: null,
    });

    a.edit({ text: "a".repeat(8 * MiB), diskRevision: null });
    await clock.advanceTo(2000);
    await settle();
    expect(a.status().kind).toBe("durable");

    // 8 MiB already stored; another 8 MiB would exceed the 12 MiB total.
    b.edit({ text: "b".repeat(8 * MiB), diskRevision: null });
    await clock.advanceTo(6000);
    await settle();
    expect(b.status().kind).toBe("paused");
    expect(b.status().reason).toBe("total-limit");
    expect(storage.records.has("buf-b")).toBe(false);
    // The other buffer's unrecovered draft was not evicted to make room.
    expect(storage.records.get("buf-a")?.text.length).toBe(8 * MiB);

    // Resolving A's draft frees the room; B's pending text resumes.
    await a.saved({ writtenText: "a".repeat(8 * MiB) });
    expect(storage.records.has("buf-a")).toBe(false);
    b.edit({ text: "b".repeat(8 * MiB), diskRevision: null });
    await clock.advanceTo(10_000);
    await settle();
    expect(b.status().kind).toBe("durable");
    expect(storage.records.get("buf-b")?.text.length).toBe(8 * MiB);
  });
});

describe("acknowledgement", () => {
  it("reports pending until the write is durable", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    h.storage.holdNextWrite();
    buf.edit({ text: "typed", diskRevision: null });
    await h.advance(2000);
    // The write is in flight: not acknowledged yet.
    expect(h.status("buf-a").kind).toBe("pending");
    h.storage.release?.();
    await settle();
    expect(h.status("buf-a").kind).toBe("durable");
  });

  it("keeps the older valid record when a write fails and says so", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "valid", diskRevision: null });
    await h.advance(2000);
    expect(h.status("buf-a").kind).toBe("durable");

    h.storage.failNext = { kind: "failed", message: "disk full" };
    buf.edit({ text: "newer", diskRevision: null });
    await h.advance(2000);

    expect(h.status("buf-a").kind).toBe("failed");
    expect(h.status("buf-a").message).toBe("disk full");
    expect(h.status("buf-a").durableRevision).toBe(1);
    expect(h.storage.records.get("buf-a")?.text).toBe("valid");

    // Retrying after the failure persists the newer text.
    buf.retry();
    await h.advance(2000);
    expect(h.status("buf-a").kind).toBe("durable");
    expect(h.storage.records.get("buf-a")?.text).toBe("newer");
  });

  it("shows unavailable storage and recovers from it", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    h.storage.failNext = { kind: "unavailable", message: "read-only" };
    buf.edit({ text: "typed", diskRevision: null });
    await h.advance(2000);
    expect(h.status("buf-a").kind).toBe("unavailable");
    expect(h.status("buf-a").message).toBe("read-only");

    buf.retry();
    await h.advance(2000);
    expect(h.status("buf-a").kind).toBe("durable");
  });
});

describe("cleanup", () => {
  it("keeps newer typing when older text is saved", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "rev one", diskRevision: null });
    await h.advance(2000);
    buf.edit({ text: "rev two", diskRevision: null });
    await h.advance(2000);
    expect(h.storage.records.get("buf-a")?.text).toBe("rev two");

    // The user saves the older snapshot: only that revision is resolved.
    const resolvedRevision = buf.revisionOf("rev one");
    expect(resolvedRevision).not.toBeNull();
    await buf.saved({
      writtenText: "rev one",
      resolvedRevision: resolvedRevision ?? undefined,
    });

    // The newer typing survived the cleanup, and it is already durable.
    expect(h.storage.records.get("buf-a")?.text).toBe("rev two");
    expect(h.status("buf-a").kind).toBe("durable");
    expect(h.status("buf-a").durableRevision).toBe(
      buf.revisionOf("rev two"),
    );
  });

  it("removes only the buffer's resolved revision, never another Space's draft", async () => {
    const h = harness();
    const a = openBuffer(h, { bufferId: "buf-a", spaceId: "sp-a" });
    const b = openBuffer(h, {
      bufferId: "buf-b",
      spaceId: "sp-b",
      path: "/home/me/notes.txt",
    });
    a.edit({ text: "same path", diskRevision: null });
    b.edit({ text: "same path", diskRevision: null });
    await h.advance(2000);
    expect(h.storage.records.size).toBe(2);

    await a.saved({
      writtenText: "same path",
      resolvedRevision: a.revisionOf("same path") ?? undefined,
    });
    expect(h.storage.records.has("buf-a")).toBe(false);
    expect(h.storage.records.get("buf-b")?.text).toBe("same path");
    expect(h.storage.records.get("buf-b")?.spaceId).toBe("sp-b");
  });

  it("drops a write that completes after the text was saved", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "doomed", diskRevision: null });
    h.storage.holdNextWrite();
    await h.advance(2000); // write is in flight
    const revision = buf.revisionOf("doomed") ?? 1;
    // The cleanup waits behind the in-flight write; resolve it after release.
    const saving = buf.saved({ writtenText: "doomed", resolvedRevision: revision });
    h.storage.release?.();
    await saving;
    await h.advance(5000);
    expect(h.storage.records.has("buf-a")).toBe(false);
  });

  it("does not resurrect discarded text with a late completion", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "discarded", diskRevision: null });
    h.storage.holdNextWrite();
    await h.advance(2000);
    const discarding = buf.discard();
    await settle();
    h.storage.release?.();
    await discarding;
    await h.advance(5000);
    expect(h.storage.records.has("buf-a")).toBe(false);
    // A later edit is recoverable again: discarding resolves one revision,
    // it does not disable recovery for the buffer.
    buf.edit({ text: "fresh", diskRevision: null });
    await h.advance(2000);
    expect(h.storage.records.get("buf-a")?.text).toBe("fresh");
  });

  it("never lets a late completion overwrite a newer record", async () => {
    const clock = new FakeClock();
    const storage = new MemoryStorage();
    const manager = createRecoveryManager({
      storage,
      enabled: () => true,
      now: () => clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    const buf = manager.buffer({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/a.txt",
      diskRevision: null,
    });
    buf.edit({ text: "older", diskRevision: null });
    storage.holdNextWrite();
    await clock.advanceTo(2000); // "older" write in flight, held
    buf.edit({ text: "newest", diskRevision: null });
    await clock.advanceTo(3500); // follow-up write queued behind it
    storage.release?.();
    await settle();
    await clock.advanceTo(6000);
    await settle();
    expect(storage.records.get("buf-a")?.text).toBe("newest");
  });

  it("is pure: the selection rule matches the stored records it is given", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "kept", diskRevision: null });
    await h.advance(2000);
    const records = await h.manager.records();
    const plan = planCleanup(records, { bufferId: "buf-a", resolvedRevision: 0 });
    expect(plan.remove).toHaveLength(0);
    expect(plan.keep).toHaveLength(1);
  });
});

describe("Save As retargeting", () => {
  it("retargets the record only after a successful save and keeps newer text", async () => {
    const h = harness();
    const buf = openBuffer(h, {
      bufferId: "buf-a",
      path: "/home/me/old.txt",
      diskRevision: `r1:${"aa".repeat(32)}:8:8-9`,
    });
    buf.edit({
      text: "snapshot",
      diskRevision: `r1:${"aa".repeat(32)}:8:8-9`,
    });
    await h.advance(2000);
    // Newer typing than the text that will be written by Save As.
    buf.edit({
      text: "snapshot plus newer",
      diskRevision: `r1:${"aa".repeat(32)}:8:8-9`,
    });

    buf.retarget({
      path: "/home/me/copy.txt",
      diskRevision: `r1:${"bb".repeat(32)}:9:9-9`,
    });
    await h.advance(2000);

    const stored = h.storage.records.get("buf-a");
    expect(stored?.path).toBe("/home/me/copy.txt");
    expect(stored?.text).toBe("snapshot plus newer");
    expect(stored?.diskRevision).toBe(`r1:${"bb".repeat(32)}:9:9-9`);
    expect(stored?.fileIdentity).toBe("9-9");
  });
});

describe("recovered drafts", () => {
  it("offers a pre-crash draft in the same Space and path, and cleans it after adoption", async () => {
    const h = harness();
    const orphan = makeRecord({
      bufferId: "buf-old",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
      diskRevision: null,
      bufferRevision: 6,
      text: "recovered text",
      updatedAt: 10,
    });
    h.storage.records.set("buf-old", orphan);

    const buf = openBuffer(h, { bufferId: "buf-new", spaceId: "sp-a" });
    const offers = await h.manager.recoverable({
      bufferId: "buf-new",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
    });
    expect(offers.map((r) => r.bufferId)).toEqual(["buf-old"]);
    expect(planRestore(offers[0], { status: "missing" })).toEqual({
      kind: "adopt",
    });

    h.manager.adopt({ record: offers[0], bufferId: "buf-new" });
    buf.edit({ text: "recovered text", diskRevision: null });
    await h.advance(2000);

    // The new buffer owns the text durably, then the orphan is removed.
    expect(h.storage.records.get("buf-new")?.text).toBe("recovered text");
    expect(h.storage.records.has("buf-old")).toBe(false);
  });

  it("keeps the orphan until the adopted text is durable", async () => {
    const h = harness();
    const orphan = makeRecord({
      bufferId: "buf-old",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
      diskRevision: null,
      bufferRevision: 6,
      text: "recovered text",
      updatedAt: 10,
    });
    h.storage.records.set("buf-old", orphan);
    const buf = openBuffer(h, { bufferId: "buf-new" });
    h.manager.adopt({ record: orphan, bufferId: "buf-new" });

    // Crash before any durable write: the draft is still there.
    buf.dispose();
    await h.advance(5000);
    expect(h.storage.records.get("buf-old")?.text).toBe("recovered text");
  });

  it("does not offer a draft from another Space with the same pathname", async () => {
    const h = harness();
    h.storage.records.set(
      "buf-other",
      makeRecord({
        bufferId: "buf-other",
        spaceId: "sp-b",
        path: "/home/me/notes.txt",
        diskRevision: null,
        bufferRevision: 1,
        text: "theirs",
        updatedAt: 1,
      }),
    );
    const offers = await h.manager.recoverable({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
    });
    expect(offers).toEqual([]);
  });
});

describe("exclusions and shutdown", () => {
  it("does not record text from a known-sensitive path", async () => {
    const h = harness();
    const buf = openBuffer(h, {
      bufferId: "buf-a",
      path: "/home/me/.ssh/config",
    });
    buf.edit({ text: "Host *\n", diskRevision: null });
    await h.advance(5000);
    expect(h.storage.writes).toHaveLength(0);
    expect(h.status("buf-a").kind).toBe("excluded");
  });

  it("stops writing when the buffer is disposed and keeps its durable record", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "durable", diskRevision: null });
    await h.advance(2000);
    buf.edit({ text: "unsaved tail", diskRevision: null });
    buf.dispose();
    await h.advance(10_000);
    expect(h.storage.records.get("buf-a")?.text).toBe("durable");
  });

  it("flushes pending text on request (bounded quit flush)", async () => {    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    buf.edit({ text: "pending at quit", diskRevision: null });
    const statuses = await h.manager.flushAll();
    expect(statuses.get("buf-a")?.kind).toBe("durable");
    expect(h.storage.records.get("buf-a")?.text).toBe("pending at quit");
  });

  it("does not resolve anything for a buffer that never recorded text", async () => {
    const h = harness();
    const buf = openBuffer(h, { bufferId: "buf-a" });
    await buf.discard();
    await buf.saved({ writtenText: "never edited" });
    expect(h.storage.removes).toHaveLength(0);
    expect(h.storage.writes).toHaveLength(0);
  });

  it("exposes stale-completion and record helpers consistently", () => {    const record = makeRecord({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/a.txt",
      diskRevision: null,
      bufferRevision: 2,
      text: "x",
      updatedAt: 1,
    });
    expect(
      isStaleCompletion(record, { bufferId: "buf-a", retireThrough: 2 }),
    ).toBe(true);
    expect(recordBytes(record)).toBeGreaterThan(record.bytes);
  });
});

/**
 * The recovery quota-refusal wire contract, checked against the Rust source.
 *
 * The native store is the authoritative quota enforcer, so a refusal it sends
 * has to be understood by the manager as a *pause*. A rename on either side
 * must fail here instead of silently degrading to `failed` with "[object
 * Object]" in the status line — that was the reviewed defect this test locks
 * out. The pattern (parse the Rust source, compare to the TS vocabulary) is the
 * one `src/modules/preview/lib/assetDelivery.test.ts` uses for the asset
 * handler.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecoveryManager, type RecoveryStorage } from "./manager";
import { RECOVERY_LIMITS, type RecoveryRecord } from "./model";

const root = join(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const rust = read("src-tauri/src/modules/recovery.rs");
const quotaSource = read("src/modules/editor/lib/recovery/quota.ts");

/** Variant names of a Rust enum, with the serde rename convention it declares. */
function rustEnum(
  source: string,
  name: string,
): { rename: string; variants: string[] } {
  const block = new RegExp(
    `#\\[serde\\(([^)]*)\\)\\]\\s*pub enum ${name} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!block) throw new Error(`enum ${name} not found in the Rust source`);
  const rename = /rename_all = "([a-z-]+)"/.exec(block[1])?.[1];
  if (!rename) throw new Error(`enum ${name} declares no rename_all`);
  const variants = [...block[2].matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm)].map(
    (match) => match[1],
  );
  return { rename, variants };
}

/** The string serde derives for a variant under the declared convention. */
function wireName(variant: string, rename: string): string {
  switch (rename) {
    case "kebab-case":
      return variant.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    case "lowercase":
      return variant.toLowerCase();
    default:
      throw new Error(`unsupported rename convention ${rename}`);
  }
}

function tsQuotaRefusals(): string[] {
  const union = /export type QuotaRefusal =([^;]+);/.exec(quotaSource);
  if (!union) throw new Error("QuotaRefusal union not found");
  return [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const quotaReason = rustEnum(rust, "QuotaReason");
const storeError = rustEnum(rust, "StoreError");
/** The exact strings the native store puts on the wire today. */
const [perFileWire, totalWire] = quotaReason.variants.map((variant) =>
  wireName(variant, quotaReason.rename),
);
const quotaKind = wireName("Quota", storeError.rename);

class QuotaStorage implements RecoveryStorage {
  records = new Map<string, RecoveryRecord>();
  refusal: unknown = null;

  async list() {
    return [...this.records.values()];
  }
  async write(record: RecoveryRecord) {
    if (this.refusal) throw this.refusal;
    this.records.set(record.bufferId, record);
    return { totalBytes: 0 };
  }
  async remove(bufferId: string, upToRevision: number) {
    const stored = this.records.get(bufferId);
    const removed =
      stored !== undefined && stored.bufferRevision <= upToRevision;
    if (removed) this.records.delete(bufferId);
    return { removed, totalBytes: 0 };
  }
  async usage() {
    return 0;
  }
}

class Clock {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.now = Math.max(this.now, target);
  }
}

function harness() {
  const clock = new Clock();
  const storage = new QuotaStorage();
  const manager = createRecoveryManager({
    storage,
    enabled: () => true,
    now: () => clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const open = (bufferId: string) =>
    manager.buffer({
      bufferId,
      spaceId: "sp-a",
      path: `/home/me/${bufferId}.txt`,
      diskRevision: null,
    });
  return { clock, storage, manager, open };
}

describe("native quota refusal contract", () => {
  it("uses the same reason vocabulary as the frontend", () => {
    expect(new Set([perFileWire, totalWire])).toEqual(
      new Set(tsQuotaRefusals()),
    );
    // The observable vocabulary, not just "some kebab string".
    expect(new Set([perFileWire, totalWire])).toEqual(
      new Set(["file-limit", "total-limit"]),
    );
  });

  it("tags the refusal with a kind the manager recognises", () => {
    expect(quotaKind).toBe("quota");
  });
});

describe("a native refusal is a pause, not a failure", () => {
  it("pauses the refusing buffer at the per-file bound", async () => {
    const h = harness();
    const buf = h.open("buf-a");
    // Small enough to pass the frontend pre-check, so the refusal under test is
    // the native one (that is the authoritative bound).
    h.storage.refusal = { kind: quotaKind, reason: perFileWire };
    buf.edit({ text: "a draft the store refuses", diskRevision: null });
    await h.clock.advanceTo(2000);

    const status = buf.status();
    expect(status.kind).toBe("paused");
    expect(status.reason).toBe(perFileWire);
    // The old "[object Object]" failure state must not appear.
    expect(status).not.toMatchObject({ kind: "failed" });
  });

  it("pauses every buffer at the total bound, including a bystander", async () => {
    const h = harness();
    const a = h.open("buf-a");
    const b = h.open("buf-b");
    a.edit({ text: "small", diskRevision: null });
    await h.clock.advanceTo(2000);
    expect(a.status().kind).toBe("durable");

    h.storage.refusal = { kind: quotaKind, reason: totalWire };
    b.edit({ text: "another draft", diskRevision: null });
    await h.clock.advanceTo(4000);

    expect(b.status().kind).toBe("paused");
    expect(b.status().reason).toBe(totalWire);
    expect(a.status().kind).toBe("paused");
  });

  it("also accepts the refusal under a renamed `paused` tag", async () => {
    // A future rename of the tag must keep pausing; only the vocabulary is
    // pinned above, so the manager tolerates the alias instead of reporting a
    // generic failure.
    const h = harness();
    const a = h.open("buf-a");
    const b = h.open("buf-b");
    a.edit({ text: "already durable", diskRevision: null });
    await h.clock.advanceTo(2000);
    expect(a.status().kind).toBe("durable");

    h.storage.refusal = { kind: "paused", reason: totalWire };
    b.edit({ text: "draft", diskRevision: null });
    await h.clock.advanceTo(4000);
    expect(b.status().kind).toBe("paused");
    // The alias goes through `pauseAll`, so the bystander pauses too.
    expect(a.status().kind).toBe("paused");
  });
});

describe("storage policy stays one source", () => {
  it("matches the approved resource limits from ticket #4", async () => {
    const limits = await import("@/modules/preview/lib/limits");
    expect(RECOVERY_LIMITS.perFileBytes).toBe(
      limits.RECOVERY_DRAFT_LIMIT_BYTES,
    );
    expect(RECOVERY_LIMITS.totalBytes).toBe(limits.RECOVERY_DRAFT_TOTAL_BYTES);
    // The native store reads the same JSON, so the file cannot drift from the
    // approved table without this failing.
    expect(rust).toContain(
      'include_str!("../../../src/modules/editor/lib/recovery/policy.json")',
    );
  });
});

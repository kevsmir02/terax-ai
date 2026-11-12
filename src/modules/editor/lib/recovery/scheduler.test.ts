import { describe, expect, it } from "vitest";
import { createCoalescer, RECOVERY_COALESCE_MS } from "./scheduler";

const COALESCE = RECOVERY_COALESCE_MS;

/**
 * Manual clock + timer queue. The scheduler takes its timing primitives by
 * injection so "within two seconds of continuous editing" is asserted in
 * virtual time instead of by sleeping in a test.
 */
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

  get armed(): number {
    return this.timers.length;
  }

  /** Fires every timer due at or before `target`, in order. */
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

/** Lets every already-resolved promise chain run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness() {
  const clock = new Clock();
  const writes: Array<{ at: number; text: string }> = [];
  let text = "";
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  const errors: unknown[] = [];

  const coalescer = createCoalescer({
    delayMs: COALESCE,
    schedule: clock.schedule,
    cancel: clock.cancel,
    run: async () => {
      const snapshot = text;
      // A held run models a slow durable write.
      if (gate) await gate;
      writes.push({ at: clock.now, text: snapshot });
    },
    onError: (error) => errors.push(error),
  });

  return {
    clock,
    coalescer,
    writes,
    errors,
    edit(next: string) {
      text = next;
      coalescer.touch();
    },
    /** Holds the next write open until `release()`. */
    hold() {
      gate = new Promise((resolve) => {
        releaseGate = () => {
          gate = null;
          releaseGate = null;
          resolve();
        };
      });
    },
    release() {
      releaseGate?.();
    },
  };
}

describe("recovery coalescing", () => {
  it("is inside the two-second budget the spec requires", () => {
    expect(RECOVERY_COALESCE_MS).toBeGreaterThan(0);
    expect(RECOVERY_COALESCE_MS).toBeLessThanOrEqual(2000);
  });

  it("writes continuously edited text within two seconds, not on idle forever", async () => {
    const h = harness();
    // Typing every 200 ms for 6 s: a debounce would never fire.
    for (let t = 0; t <= 6000; t += 200) {
      h.edit(`v${t}`);
      await h.clock.advanceTo(t);
      if (t === 0) {
        // Nothing is written before the coalescing window elapses.
        expect(h.writes).toHaveLength(0);
      }
    }
    expect(h.writes.length).toBeGreaterThanOrEqual(3);
    // First persistence lands inside the first two seconds of the burst.
    expect(h.writes[0].at).toBeLessThanOrEqual(2000);
    // Let virtual time run past the last edit's budget, then check coverage.
    await h.clock.advanceTo(6000 + 2000);
    // Every edit is covered within two seconds: by then a write exists whose
    // snapshot is at least as new as the edit (coalescing may merge edits, it
    // may not delay the newest text).
    for (let t = 0; t <= 6000; t += 200) {
      const covering = h.writes.filter((w) => w.at <= t + 2000);
      expect(covering.length, `nothing durable by ${t + 2000}`).toBeGreaterThan(
        0,
      );
      const newest = Math.max(
        ...covering.map((w) => Number(w.text.slice(1))),
      );
      expect(newest, `edit at ${t} not durable by ${t + 2000}`).toBeGreaterThanOrEqual(
        t,
      );
    }
  });

  it("coalesces a burst into one write carrying the latest text", async () => {
    const h = harness();
    h.edit("a");
    await h.clock.advanceTo(100);
    h.edit("ab");
    await h.clock.advanceTo(700);
    h.edit("abc");
    await h.clock.advanceTo(COALESCE - 1);
    expect(h.writes).toHaveLength(0);
    await h.clock.advanceTo(COALESCE);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].text).toBe("abc");
    // One timer for the whole burst: a touch must not push the deadline out.
    expect(h.clock.armed).toBe(0);
  });

  it("does not lose the tail typed while a write is in flight", async () => {
    const h = harness();
    h.edit("first");
    h.hold();
    await h.clock.advanceTo(COALESCE);
    await settle();
    expect(h.writes).toHaveLength(0);
    // A slow write is in flight; keep typing.
    h.edit("second");
    h.release();
    await settle();
    // The follow-up write is armed and carries the newer text.
    await h.clock.advanceTo(h.clock.now);
    await settle();
    expect(h.writes.map((w) => w.text)).toEqual(["first", "second"]);
  });

  it("stops writing once cancelled (buffer closed)", async () => {
    const h = harness();
    h.edit("gone");
    h.coalescer.cancel();
    await h.clock.advanceTo(10_000);
    expect(h.writes).toHaveLength(0);
  });

  it("keeps scheduling after a failed write", async () => {
    const clock = new Clock();
    let attempts = 0;
    const errors: unknown[] = [];
    const coalescer = createCoalescer({
      delayMs: COALESCE,
      schedule: clock.schedule,
      cancel: clock.cancel,
      run: async () => {
        attempts += 1;
        throw new Error("disk full");
      },
      onError: (error) => errors.push(error),
    });
    coalescer.touch();
    await clock.advanceTo(COALESCE);
    await settle();
    coalescer.touch();
    await clock.advanceTo(COALESCE * 3);
    await settle();
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(2);
  });
});

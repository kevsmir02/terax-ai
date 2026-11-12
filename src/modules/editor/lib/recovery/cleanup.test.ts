import { describe, expect, it } from "vitest";
import { makeRecord, type RecoveryRecord } from "./model";
import {
  findRecoverable,
  isStaleCompletion,
  newerThan,
  planCleanup,
  planRestore,
} from "./cleanup";

function record(overrides: Partial<RecoveryRecord> = {}): RecoveryRecord {
  return {
    ...makeRecord({
      bufferId: "buf-a",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
      diskRevision: `r1:${"ab".repeat(32)}:8:8-9`,
      bufferRevision: 3,
      text: "abc",
      updatedAt: 1_000,
    }),
    ...overrides,
  };
}

describe("cleanup selection", () => {
  it("removes only the resolved revision of the resolving buffer", () => {
    const resolved = record({ bufferRevision: 3 });
    const newer = record({ bufferRevision: 4, text: "abcd" });
    const other = record({
      bufferId: "buf-b",
      bufferRevision: 1,
      text: "theirs",
    });

    const plan = planCleanup([resolved, newer, other], {
      bufferId: "buf-a",
      resolvedRevision: 3,
    });

    expect(plan.remove.map((r) => r.bufferId)).toEqual(["buf-a"]);
    expect(plan.remove[0].bufferRevision).toBe(3);
    expect(plan.keep.map((r) => [r.bufferId, r.bufferRevision])).toEqual([
      ["buf-a", 4],
      ["buf-b", 1],
    ]);
  });

  it("never removes another Space's draft of the same pathname", () => {
    const mine = record({ bufferId: "buf-a", spaceId: "sp-a" });
    const theirs = record({ bufferId: "buf-b", spaceId: "sp-b" });

    const plan = planCleanup([mine, theirs], {
      bufferId: "buf-a",
      resolvedRevision: 99,
    });

    expect(plan.remove).toHaveLength(1);
    expect(plan.remove[0].bufferId).toBe("buf-a");
    expect(plan.keep).toHaveLength(1);
    expect(plan.keep[0].spaceId).toBe("sp-b");
  });

  it("removes nothing when the buffer has no record", () => {
    const other = record({ bufferId: "buf-b" });
    expect(
      planCleanup([other], { bufferId: "buf-a", resolvedRevision: 10 }).remove,
    ).toEqual([]);
  });
});

describe("late completions", () => {
  it("drops a write for a revision that was already resolved", () => {
    // Save at revision 3 deleted the record; a write that started before the
    // save completes afterwards and must not resurrect that text.
    expect(
      isStaleCompletion(record({ bufferRevision: 3 }), {
        bufferId: "buf-a",
        retireThrough: 3,
      }),
    ).toBe(true);
    // A discarded buffer retires every revision it ever wrote.
    expect(
      isStaleCompletion(record({ bufferRevision: 9 }), {
        bufferId: "buf-a",
        retireThrough: Number.POSITIVE_INFINITY,
      }),
    ).toBe(true);
  });

  it("accepts a write for a newer revision and for another buffer", () => {
    expect(
      isStaleCompletion(record({ bufferRevision: 4 }), {
        bufferId: "buf-a",
        retireThrough: 3,
      }),
    ).toBe(false);
    expect(
      isStaleCompletion(record({ bufferId: "buf-b", bufferRevision: 1 }), {
        bufferId: "buf-a",
        retireThrough: 3,
      }),
    ).toBe(false);
  });

  it("never lets an older completion overwrite a newer stored record", () => {
    const stored = record({ bufferRevision: 5 });
    const late = record({ bufferRevision: 4 });
    expect(newerThan(late, stored)).toBe(false);
    expect(newerThan({ ...late, bufferRevision: 6 }, stored)).toBe(true);
    expect(newerThan(late, null)).toBe(true);
  });
});

describe("recovered-draft offers", () => {
  it("offers an orphaned record for the same Space and path", () => {
    const orphan = record({ bufferId: "buf-old", bufferRevision: 7 });
    const otherSpace = record({ bufferId: "buf-other", spaceId: "sp-b" });
    const live = record({ bufferId: "buf-now", bufferRevision: 2 });

    const offers = findRecoverable([orphan, otherSpace, live], {
      bufferId: "buf-now",
      spaceId: "sp-a",
      path: "/home/me/notes.txt",
    });

    expect(offers.map((r) => r.bufferId)).toEqual(["buf-old"]);
  });

  it("compares paths without depending on separator style", () => {
    const orphan = record({ bufferId: "buf-old", path: "C:\\work\\a.ts" });
    const offers = findRecoverable([orphan], {
      bufferId: "buf-now",
      spaceId: "sp-a",
      path: "C:/work/a.ts",
    });
    expect(offers).toHaveLength(1);
  });
});

describe("restore plan", () => {
  const diskRevision = `r1:${"ab".repeat(32)}:8:8-9`;

  it("adopts the draft when the original file is unchanged", () => {
    expect(
      planRestore(record(), { status: "present", revision: diskRevision }),
    ).toEqual({ kind: "adopt" });
  });

  it("compares when the original changed, moved or was replaced", () => {
    expect(
      planRestore(record(), {
        status: "present",
        revision: `r1:${"cd".repeat(32)}:8:8-9`,
      }),
    ).toEqual({ kind: "compare", reason: "changed" });
    // Moved/replaced: same bytes under a new file identity is a different
    // revision, so it is a comparison, never an automatic restore-and-save.
    expect(
      planRestore(record(), {
        status: "present",
        revision: `r1:${"ab".repeat(32)}:8:8-10`,
      }),
    ).toEqual({ kind: "compare", reason: "changed" });
  });

  it("compares when the original is missing or unreadable", () => {
    expect(planRestore(record(), { status: "missing" })).toEqual({
      kind: "compare",
      reason: "missing",
    });
    expect(planRestore(record(), { status: "unreadable" })).toEqual({
      kind: "compare",
      reason: "unreadable",
    });
  });

  it("has no plan that writes the original file", () => {
    const plans = [
      planRestore(record(), { status: "present", revision: diskRevision }),
      planRestore(record(), { status: "missing" }),
      planRestore(record(), { status: "unreadable" }),
    ];
    for (const plan of plans) {
      expect(["adopt", "compare"]).toContain(plan.kind);
    }
  });
});

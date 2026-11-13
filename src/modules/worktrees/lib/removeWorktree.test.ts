/**
 * What worktree removal says and what it will not do.
 *
 * The native preflight is the authority on blockers; this module only names
 * them, decides whether `force` may override anything, and flattens exactly the
 * recovery refs of the worktree being removed so an explicit cleanup can never
 * reach another worktree's refs.
 */

import type {
  CheckpointGroups,
  WorktreeRemoveBlocker,
  WorktreeRemoveReport,
} from "@/modules/git/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canForceRemoval,
  forcePolicy,
  hasForceableBlocker,
  recoveryRefsToDelete,
  removalBlockers,
  removalRefusal,
  removalResultText,
} from "./removeWorktree";

const report = (
  patch: Partial<WorktreeRemoveReport> = {},
): WorktreeRemoveReport => ({
  removed: false,
  path: "/work/wt",
  branch: "feature/x",
  blockers: [],
  dirtyFiles: [],
  dirtyTotal: 0,
  untrackedCount: 0,
  unmergedCommits: 0,
  ignoredFiles: [],
  ignoredTotal: 0,
  ignoredRegenerable: 0,
  ignoredIdentical: 0,
  inconclusive: [],
  recovery: { total: 0, manual: 0, turns: 0, safety: 0, sample: [] },
  lockReason: null,
  ...patch,
});

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const groups: CheckpointGroups = {
  manual: [
    {
      ref: "refs/codr/manual-checkpoints/aa",
      id: "aa",
      name: "before refactor",
      commit: "c1",
      tree: "t1",
      parent: "p1",
      createdAtSecs: 1,
      capture: null,
    },
  ],
  turns: [
    {
      ref: "refs/codr/checkpoints/task/2",
      taskId: "task",
      turn: 2,
      commit: "c2",
      tree: "t2",
      parent: "p2",
      createdAtSecs: 2,
    },
  ],
  safety: [
    {
      ref: "refs/codr/checkpoints/task/prerestore-3",
      taskId: "task",
      commit: "c3",
      tree: "t3",
      parent: "p3",
      createdAtSecs: 3,
    },
  ],
  storage: {
    looseObjects: 0,
    looseKib: 0,
    packedObjects: 0,
    packedKib: 0,
    ownedRefs: 3,
    sharedObjects: true,
  },
};

describe("worktree removal blockers", () => {
  it("names what every on-disk blocker would delete", () => {
    const blocked = report({
      blockers: ["dirty", "unmerged", "ignored", "inconclusive"],
      dirtyTotal: 2,
      untrackedCount: 1,
      unmergedCommits: 3,
      ignoredFiles: [".env", "local.sqlite"],
      ignoredTotal: 2,
      ignoredRegenerable: 1,
      ignoredIdentical: 1,
      inconclusive: ["ignored-files"],
    });
    const lines = removalBlockers(blocked).map((line) => line.text);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("2 changed files and 1 untracked file");
    expect(lines[1]).toContain("3 commits");
    expect(lines[1]).toContain("not on any other branch, remote or tag");
    expect(lines[2]).toContain(".env");
    expect(lines[2]).toContain("ignored files");
    expect(lines[2]).toContain("would be deleted");
    expect(lines[3]).toContain("ignored-files");
    expect(lines[3]).toContain("could not finish");
    expect(lines[3]).toContain("unknown");
    // Regenerable/identical counters are context, not blockers: they stay out.
    expect(lines.join(" ")).not.toContain("node_modules");
  });

  it("counts a worktree that only has untracked files", () => {
    const lines = removalBlockers(
      report({ blockers: ["dirty"], untrackedCount: 1 }),
    ).map((line) => line.text);
    expect(lines[0]).toContain("1 untracked file");
    expect(lines[0]).not.toContain("0 changed files");
  });

  it("refuses while recovery points remain and points at explicit cleanup", () => {
    const blocked = report({
      blockers: ["recoveryRefs"],
      recovery: {
        total: 3,
        manual: 1,
        turns: 1,
        safety: 1,
        sample: [
          "refs/codr/manual-checkpoints/aa",
          "refs/codr/checkpoints/task/2",
        ],
      },
    });
    const [line] = removalBlockers(blocked);
    expect(line?.kind).toBe("recoveryRefs");
    expect(line?.text).toContain("3 recovery points");
    expect(line?.text).toContain("1 checkpoint");
    expect(line?.text).toContain("1 turn checkpoint");
    expect(line?.text).toContain("1 restore safety snapshot");
    expect(line?.text).toContain("Delete them explicitly");
    expect(line?.text).toContain("force does not");
  });

  it("refuses a locked worktree without offering a workaround", () => {
    const locked = report({ blockers: ["locked"], lockReason: "in use" });
    const [line] = removalBlockers(locked);
    expect(line?.text).toContain("locked");
    expect(line?.text).toContain("in use");
    expect(canForceRemoval(locked)).toBe(false);
  });

  it("lets force override the on-disk blockers git itself reports", () => {
    expect(
      canForceRemoval(report({ blockers: ["dirty", "unmerged", "ignored"] })),
    ).toBe(true);
    expect(canForceRemoval(report({ blockers: ["inconclusive"] }))).toBe(true);
    // Retirement refs are never a force decision.
    expect(canForceRemoval(report({ blockers: ["recoveryRefs"] }))).toBe(false);
    expect(
      canForceRemoval(report({ blockers: ["dirty", "recoveryRefs"] })),
    ).toBe(false);
  });
});

describe("explicit scoped cleanup", () => {
  it("names exactly the refs of the worktree being removed", () => {
    expect(recoveryRefsToDelete(groups)).toEqual([
      "refs/codr/manual-checkpoints/aa",
      "refs/codr/checkpoints/task/2",
      "refs/codr/checkpoints/task/prerestore-3",
    ]);
    // Nothing is selected by default: an empty listing means no cleanup.
    expect(
      recoveryRefsToDelete({
        ...groups,
        manual: [],
        turns: [],
        safety: [],
      }),
    ).toEqual([]);
  });
});

describe("force policy", () => {
  const documented = () => {
    const doc = read("docs/architecture/worktrees.md");
    const rule =
      /`force` is offered only for the on-disk Git blockers \(([\s\S]*?)\) and never for ([\s\S]*?)\./.exec(
        doc,
      );
    expect(rule, "the documented force rule is missing").not.toBeNull();
    const names = (text: string) =>
      [...text.matchAll(/`(\w+)`/g)].map((match) => match[1]).sort();
    return { offered: names(rule?.[1] ?? ""), never: names(rule?.[2] ?? "") };
  };

  it("comes from the documented rule instead of a list beside it", () => {
    // `docs/architecture/worktrees.md` is the spec for what `force` may
    // override. The map and the documentation cannot drift apart unnoticed.
    const { offered, never } = documented();
    const blockers = Object.keys(forcePolicy) as WorktreeRemoveBlocker[];
    expect(
      blockers
        .filter((blocker) => forcePolicy[blocker] === "overridable")
        .sort(),
    ).toEqual(offered);
    expect(
      blockers.filter((blocker) => forcePolicy[blocker] === "refused").sort(),
    ).toEqual(never);
  });

  it("derives both force decisions from the same map", () => {
    const blockers = Object.keys(forcePolicy) as WorktreeRemoveBlocker[];
    for (const blocker of blockers) {
      const single = report({ blockers: [blocker] });
      const overridable = forcePolicy[blocker] === "overridable";
      expect(canForceRemoval(single), blocker).toBe(overridable);
      expect(hasForceableBlocker(single), blocker).toBe(overridable);
    }
    // A lock is not made forceable by an on-disk blocker beside it, but the
    // dialog still knows force was the choice it is being denied.
    const mixed = report({ blockers: ["dirty", "locked"] });
    expect(canForceRemoval(mixed)).toBe(false);
    expect(hasForceableBlocker(mixed)).toBe(true);
    expect(
      canForceRemoval(report()),
      "a report with no blocker needs no force decision",
    ).toBe(true);
  });
});

describe("refusal and result copy", () => {
  it("a native refusal names the blockers and says nothing was deleted", () => {
    const message = removalRefusal(
      report({
        blockers: ["dirty", "recoveryRefs"],
        dirtyTotal: 1,
        recovery: { total: 1, manual: 1, turns: 0, safety: 0, sample: [] },
      }),
    );
    expect(message).toContain("refused");
    expect(message).toContain("1 changed file");
    expect(message).toContain("1 recovery point");
    expect(message).toContain("Nothing was deleted");
  });

  it("a successful removal says the branch and its commits were kept", () => {
    const message = removalResultText(
      report({
        removed: true,
        branch: "feature/x",
        recovery: { total: 0, manual: 0, turns: 0, safety: 0, sample: [] },
      }),
    );
    expect(message).toContain("/work/wt");
    expect(message).toContain("feature/x");
    expect(message).toContain("kept");
    expect(message).not.toContain("deleted the branch");
  });
});

/**
 * The worktree-removal wire contract.
 *
 * The report is produced by Rust, so its blocker names and field names are
 * parsed from the producer's source instead of being restated: a rename must
 * fail here rather than render an unexplained blocker as if there were none.
 * The argument shapes are pinned so the native preflight is asked about the
 * worktree's own repository and path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));

import { git } from "./api";
import type { WorktreeRemoveBlocker, WorktreeRemoveReport } from "./types";

const workspace = { kind: "local" };
const root = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const worktreeRust = read("src-tauri/src/modules/git/worktree.rs");
const checkpointRust = read("src-tauri/src/modules/git/checkpoint.rs");
const libRust = read("src-tauri/src/lib.rs");

function rustEnum(source: string, name: string): string[] {
  const block = new RegExp(
    `#\\[serde\\(([^)]*)\\)\\]\\s*pub enum ${name} \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!block) throw new Error(`enum ${name} not found in the Rust source`);
  return [...block[2].matchAll(/^\s{4}([A-Z][A-Za-z]*),/gm)].map(
    (match) => match[1],
  );
}

function rustStructFields(source: string, name: string): string[] {
  const block = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
    source,
  );
  if (!block) throw new Error(`struct ${name} not found in the Rust source`);
  return [...block[1].matchAll(/^\s{4}pub (\w+):/gm)].map((match) => match[1]);
}

describe("worktree removal api", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("asks the native preflight instead of guessing from the rendered status", async () => {
    await git.worktreeRemovePreflight("/repo", "/repo/wt");
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      "git_worktree_remove_preflight",
      { repoRoot: "/repo", path: "/repo/wt", workspace },
    );

    await git.worktreeRemove("/repo", "/repo/wt", true);
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_worktree_remove", {
      repoRoot: "/repo",
      path: "/repo/wt",
      force: true,
      workspace,
    });
  });

  it("lists and cleans recovery refs by repository and worktree path", async () => {
    const managed = "/home/me/.local/share/terax/worktrees/repo/wt";
    await git.checkpointGroupsAt("/repo", managed);
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_groups_at", {
      repoRoot: "/repo",
      worktree: managed,
      workspace,
    });

    const refs = [
      "refs/terax-workspace/manual-checkpoints/aa",
      "refs/terax-workspace/checkpoints/task/1",
    ];
    await git.checkpointCleanupAt("/repo", managed, refs);
    expect(mocks.invoke).toHaveBeenLastCalledWith("git_checkpoint_cleanup_at", {
      repoRoot: "/repo",
      worktree: managed,
      refs,
      workspace,
    });
  });
});

describe("worktree removal contract", () => {
  it("keeps every native blocker in step with the TS union", () => {
    const variants = rustEnum(worktreeRust, "RemoveBlocker");
    expect(variants).toEqual([
      "Locked",
      "Dirty",
      "Unmerged",
      "Ignored",
      "RecoveryRefs",
      "Inconclusive",
    ]);
    const expected: WorktreeRemoveBlocker[] = [
      "locked",
      "dirty",
      "unmerged",
      "ignored",
      "recoveryRefs",
      "inconclusive",
    ];
    expect(
      variants.map(
        (variant) => variant.charAt(0).toLowerCase() + variant.slice(1),
      ),
    ).toEqual(expected);
  });

  it("keeps the report fields, including the recovery counts, in step", () => {
    expect(rustStructFields(worktreeRust, "WorktreeRemoveReport")).toEqual([
      "removed",
      "path",
      "branch",
      "blockers",
      "dirty_files",
      "dirty_total",
      "untracked_count",
      "unmerged_commits",
      "ignored_files",
      "ignored_total",
      "ignored_regenerable",
      "ignored_identical",
      "inconclusive",
      "recovery",
      "lock_reason",
    ]);
    expect(rustStructFields(checkpointRust, "OwnedRecoveryRefs")).toEqual([
      "total",
      "manual",
      "turns",
      "safety",
      "sample",
    ]);

    const sample: WorktreeRemoveReport = {
      removed: false,
      path: "/repo/wt",
      branch: "feature/x",
      blockers: ["recoveryRefs"],
      dirtyFiles: [],
      dirtyTotal: 0,
      untrackedCount: 0,
      unmergedCommits: 0,
      ignoredFiles: [],
      ignoredTotal: 0,
      ignoredRegenerable: 0,
      ignoredIdentical: 0,
      inconclusive: [],
      recovery: {
        total: 1,
        manual: 1,
        turns: 0,
        safety: 0,
        sample: ["refs/x"],
      },
      lockReason: null,
    };
    expect(sample.recovery.total).toBe(1);
  });

  it("registers the preflight and the path-scoped cleanup commands", () => {
    for (const command of [
      "git_worktree_remove_preflight",
      "git_checkpoint_groups_at",
      "git_checkpoint_cleanup_at",
    ]) {
      expect(libRust).toContain(command);
    }
  });

  it("removal is not reachable from Space deletion", () => {
    // The Space-delete transaction removes organization and nothing else; the
    // removal dialog is only opened from the repository menu.
    const guards = read("src/app/hooks/spaceDeleteGuards.ts");
    expect(guards).not.toContain("worktree_remove");
    expect(guards).not.toContain("worktreeRemove");
    expect(guards).not.toContain("git worktree remove");

    const app = read("src/app/App.tsx");
    const start = app.indexOf("const commitDeleteSpace");
    const end = app.indexOf("const prepareDiscard", start);
    expect(start).toBeGreaterThan(-1);
    const commit = app.slice(start, end);
    expect(commit).toContain("useSpaces.getState().remove");
    expect(commit).not.toMatch(/worktree/i);
  });
});

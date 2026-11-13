import { Dialog } from "@/components/ui/dialog";
import type {
  CheckpointGroups,
  WorktreeRemoveReport,
} from "@/modules/git/types";
import type { DestructivePlan } from "@/modules/git";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorktreeRemoveBody,
  type WorktreeRemoveBodyProps,
} from "./WorktreeRemoveDialog";

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
  turns: [],
  safety: [],
  storage: {
    looseObjects: 0,
    looseKib: 0,
    packedObjects: 0,
    packedKib: 0,
    ownedRefs: 1,
    sharedObjects: true,
  },
};

const noGroups: CheckpointGroups = {
  ...groups,
  manual: [],
  storage: { ...groups.storage, ownedRefs: 0 },
};

const plan = (patch: Partial<DestructivePlan> = {}): DestructivePlan => ({
  action: {
    kind: "worktreeRemove",
    repoRoot: "/work",
    worktreeRoot: "/work/wt",
  },
  repoRoot: "/work",
  worktreeRoot: "/work/wt",
  canonicalRepoRoot: "/work",
  canonicalWorktreeRoot: "/work/wt",
  affected: [],
  blockers: [],
  activeWork: [],
  uncertain: [],
  force: false,
  fingerprint: "fp",
  requiresAcknowledgement: { unsavedBuffers: false, activeWork: false },
  ...patch,
});

const props = (
  patch: Partial<WorktreeRemoveBodyProps> = {},
): WorktreeRemoveBodyProps => ({
  path: "/work/wt",
  report: report(),
  groups: noGroups,
  plan: plan(),
  acknowledged: { unsavedBuffers: [], activeWork: [], force: false },
  onChange: () => undefined,
  stale: null,
  error: null,
  busy: false,
  cleanupBusy: false,
  removed: null,
  onCancel: () => undefined,
  onConfirm: () => undefined,
  onCleanup: () => undefined,
  ...patch,
});

const render = (patch: Partial<WorktreeRemoveBodyProps> = {}) =>
  renderToStaticMarkup(
    createElement(
      Dialog,
      { open: true },
      createElement(WorktreeRemoveBody, props(patch)),
    ),
  );

function button(markup: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<button[^>]*>(?:\\s|<!--.*?-->)*${escaped}`).exec(
    markup,
  );
  if (!match) throw new Error(`button ${label} not rendered`);
  return match[0];
}

const disabled = (markup: string) => /\sdisabled=""/.test(markup);

describe("worktree removal dialog", () => {
  it("names every blocker and refuses while a recovery point is retained", () => {
    const markup = render({
      report: report({
        blockers: ["dirty", "recoveryRefs"],
        dirtyTotal: 1,
        recovery: { total: 1, manual: 1, turns: 0, safety: 0, sample: [] },
      }),
      groups,
    });
    expect(markup).toContain("Remove worktree");
    expect(markup).toContain('data-worktree-removal-blocker="dirty"');
    expect(markup).toContain('data-worktree-removal-blocker="recoveryRefs"');
    expect(markup).toContain("1 recovery point still belong");
    // The cleanup is offered and names the ref it would delete.
    expect(markup).toContain('data-worktree-removal-cleanup="1"');
    expect(button(markup, "Delete 1 recovery point")).toBeTruthy();
    expect(disabled(button(markup, "Remove worktree"))).toBe(true);
  });

  it("keeps removal disabled when a ref is owned but its name has not loaded", () => {
    const markup = render({
      report: report({
        blockers: ["recoveryRefs"],
        recovery: { total: 1, manual: 1, turns: 0, safety: 0, sample: [] },
      }),
      groups: null,
    });
    expect(markup).toContain('data-worktree-removal-cleanup="0"');
    expect(disabled(button(markup, "Delete 0 recovery points"))).toBe(true);
    expect(disabled(button(markup, "Remove worktree"))).toBe(true);
  });

  it("offers force only for the blockers git itself reports", () => {
    const dirty = render({
      report: report({ blockers: ["dirty"], dirtyTotal: 1 }),
    });
    expect(dirty).toContain("Force removal despite on-disk Git blockers");
    expect(disabled(button(dirty, "Remove worktree"))).toBe(true);

    const forced = render({
      report: report({ blockers: ["dirty"], dirtyTotal: 1 }),
      acknowledged: { unsavedBuffers: [], activeWork: [], force: true },
    });
    expect(disabled(button(forced, "Remove worktree"))).toBe(false);

    const locked = render({
      report: report({ blockers: ["locked"], lockReason: "in use" }),
    });
    expect(locked).not.toContain("Force removal");
    expect(disabled(button(locked, "Remove worktree"))).toBe(true);
  });

  it("requires an acknowledgement for a dirty buffer or a busy terminal in any Space", () => {
    const blocked = render({
      plan: plan({
        blockers: [
          {
            kind: "unsavedBuffer",
            tabId: 7,
            spaceId: "s2",
            spaceName: "Other Space",
            path: "/work/wt/src/a.ts",
            canonicalPath: "/work/wt/src/a.ts",
            outsideSpaceRoot: true,
          },
          {
            kind: "activeTerminal",
            tabId: 9,
            leafId: 3,
            spaceId: "s1",
            spaceName: "Worktree Space",
            cwd: "/work/wt",
            busy: "uncertain",
          },
        ],
      }),
    });
    expect(blocked).toContain("Other Space");
    expect(blocked).toContain("the check did not complete");
    expect(blocked).toContain('data-worktree-removal-ready="false"');

    const acked = render({
      plan: plan({
        blockers: [
          {
            kind: "unsavedBuffer",
            tabId: 7,
            spaceId: "s2",
            spaceName: "Other Space",
            path: "/work/wt/src/a.ts",
            canonicalPath: "/work/wt/src/a.ts",
            outsideSpaceRoot: true,
          },
        ],
      }),
      acknowledged: { unsavedBuffers: [7], activeWork: [], force: false },
    });
    expect(acked).toContain('data-worktree-removal-ready="true"');
  });

  it("shows the native refusal without pretending the worktree went away", () => {
    const markup = render({
      report: report({ blockers: ["locked"] }),
      error: "Removal was refused. This worktree is locked (in use).",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("This worktree is locked");
    expect(markup).not.toContain("data-worktree-removal-done");
  });

  it("reports a completed removal and the branch that stayed", () => {
    const markup = render({
      removed: report({ removed: true }),
    });
    expect(markup).toContain('data-worktree-removal-done="/work/wt"');
    expect(markup).toContain("Branch feature/x and its commits were kept");
    expect(markup).toContain("Nothing else on disk was deleted");
    expect(markup).not.toContain("Remove worktree");
  });
});

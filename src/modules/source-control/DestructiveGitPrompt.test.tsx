import type { DestructivePlan } from "@/modules/git";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DestructiveGitPrompt,
  type DestructivePromptState,
} from "./DestructiveGitPrompt";

const plan: DestructivePlan = {
  action: {
    kind: "worktreeRemove",
    repoRoot: "/work/terax",
    worktreeRoot: "/work/terax-feature",
    force: true,
  },
  repoRoot: "/work/terax",
  worktreeRoot: "/work/terax-feature",
  canonicalRepoRoot: "/work/terax",
  canonicalWorktreeRoot: "/work/terax-feature",
  affected: [
    {
      path: "src/a.ts",
      canonicalPath: "/work/terax-feature/src/a.ts",
      staged: true,
      untracked: false,
      effect: "removed",
      indexEffect: "staysStaged",
    },
  ],
  blockers: [
    {
      kind: "unsavedBuffer",
      tabId: 7,
      spaceId: "space-b",
      spaceName: "Review",
      path: "/work/terax-feature/src/a.ts",
      canonicalPath: "/work/terax-feature/src/a.ts",
      outsideSpaceRoot: true,
    },
    {
      kind: "activeTerminal",
      tabId: 9,
      leafId: 90,
      spaceId: "space-wt",
      spaceName: "Worktree",
      cwd: "/work/terax-feature",
      busy: "uncertain",
    },
  ],
  activeWork: [
    {
      tabId: 9,
      leafId: 90,
      spaceId: "space-wt",
      spaceName: "Worktree",
      cwd: "/work/terax-feature",
      busy: "uncertain",
      blocking: true,
    },
  ],
  uncertain: ["terminal:90"],
  force: true,
  fingerprint: "plan",
  requiresAcknowledgement: { unsavedBuffers: true, activeWork: true },
};

const nothing: DestructivePromptState = {
  unsavedBuffers: [],
  activeWork: [],
  force: false,
};

function render(
  acknowledged: DestructivePromptState = nothing,
  overrides: { stale?: string | null; error?: string | null } = {},
) {
  return renderToStaticMarkup(
    createElement(DestructiveGitPrompt, {
      plan,
      acknowledged,
      onChange: () => {},
      stale: overrides.stale ?? null,
      busy: false,
      error: overrides.error ?? null,
      onCancel: () => {},
      onConfirm: () => {},
      actionLabel: "remove the worktree",
    }),
  )
    .split("<!-- -->")
    .join("");
}

describe("destructive Git prompt", () => {
  it("names affected paths, staging effects and every affected buffer and Space", () => {
    const html = render();

    expect(html).toContain("/work/terax-feature");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("staged copy stays staged");
    expect(html).toContain("Review");
    expect(html).toContain("outside that Space&#x27;s root");
    expect(html).toContain("Worktree");
    expect(html).toContain("the process check did not complete");
  });

  it("does not allow confirmation until unsaved work and active work are acknowledged", () => {
    expect(render()).toContain('data-can-confirm="false"');
    expect(
      render({ unsavedBuffers: [7], activeWork: [], force: false }),
    ).toContain('data-can-confirm="false"');
    expect(
      render({ unsavedBuffers: [7], activeWork: [90], force: true }),
    ).toContain('data-can-confirm="true"');
  });

  it("keeps force a separate choice from unsaved-buffer acknowledgement", () => {
    const html = render({ unsavedBuffers: [], activeWork: [90], force: true });

    expect(html).toContain("does not save or discard any editor buffer");
    expect(html).toContain('data-can-confirm="false"');
  });

  it("shows a refreshed plan after a stale confirmation", () => {
    const html = render(nothing, {
      stale:
        "The affected files, unsaved buffers or active work changed since this confirmation was shown.",
    });

    expect(html).toContain('data-destructive-stale="true"');
    expect(html).toContain("changed since this confirmation was shown");
  });
});

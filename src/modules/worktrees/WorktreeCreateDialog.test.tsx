import { Dialog } from "@/components/ui/dialog";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorktreeDialogBody,
  type WorktreeDialogBodyProps,
} from "./WorktreeCreateDialog";
import { initialWorktreeForm } from "./lib/createWorktree";

const result = {
  added: {
    path: "/work/one/feature-x",
    branch: "feature/x",
    head: "abc123",
    detached: false,
    copied: [".env"],
    skipped: [{ path: "config/local.json", reason: "already-exists" }],
    includeTruncated: true,
  },
  access: "derived" as const,
};

const props = (
  patch: Partial<WorktreeDialogBodyProps> = {},
): WorktreeDialogBodyProps => ({
  form: {
    ...initialWorktreeForm,
    taskSlug: "feature",
    branchName: "feature/x",
  },
  local: [],
  native: [],
  plannedPath: "/work/one/feature",
  collision: null,
  checking: false,
  creating: false,
  error: null,
  result: null,
  repoRoot: "/work/one",
  onField: () => undefined,
  onSubmit: () => undefined,
  onOpenAsSpace: () => undefined,
  onClose: () => undefined,
  ...patch,
});

const render = (patch: Partial<WorktreeDialogBodyProps> = {}) =>
  renderToStaticMarkup(
    createElement(
      Dialog,
      { open: true },
      createElement(WorktreeDialogBody, props(patch)),
    ),
  );

const disabled = (html: string) => /\sdisabled=""/.test(html);

function button(markup: string, label: string): string {
  const match = new RegExp(
    `<button[^>]*>\\s*${label.replace(/[&]/g, "&amp;")}\\s*</button>`,
  ).exec(markup);
  if (!match) throw new Error(`button ${label} not rendered`);
  return match[0];
}

describe("worktree creation dialog", () => {
  it("shows where the worktree will go and why it cannot be created yet", () => {
    const markup = render({
      plannedPath: "/work/one/feature-2",
      collision:
        "/work/one/feature already exists; this worktree will use /work/one/feature-2",
      native: [
        { field: "base", message: "does-not-exist does not name a commit" },
      ],
    });
    expect(markup).toContain("New worktree");
    expect(markup).toContain("/work/one/feature-2");
    expect(markup).toContain("already exists; this worktree will use");
    expect(markup).toContain('data-worktree-problem="base"');
    expect(markup).toContain("does-not-exist does not name a commit");
    expect(disabled(button(markup, "Create worktree"))).toBe(true);
  });

  it("keeps the create button disabled for a local error", () => {
    const local = [{ field: "branch" as const, message: "Name the branch." }];
    const markup = render({ local });
    expect(markup).toContain('data-worktree-problem="branch"');
    expect(disabled(button(markup, "Create worktree"))).toBe(true);
  });

  it("reports every copied and skipped ignored file and the limits", () => {
    const markup = render({ result });
    expect(markup).toContain('data-worktree-created="/work/one/feature-x"');
    expect(markup).toContain("Copied .env");
    expect(markup).toContain(
      "Did not copy config/local.json: already exists in the worktree — left untouched",
    );
    expect(markup).toContain("Nothing was overwritten");
    expect(markup).toContain('data-worktree-access="derived"');
    expect(markup).toContain("derived from the repository");
    expect(disabled(button(markup, "Open as Space"))).toBe(false);
  });

  it("refuses to offer a Space for a folder the app cannot access", () => {
    const markup = render({
      result: { ...result, access: "none" },
    });
    expect(markup).toContain('data-worktree-access="none"');
    expect(markup).toContain("cannot be opened as a Space");
    expect(disabled(button(markup, "Open as Space"))).toBe(true);
  });

  it("shows the native command failure without pretending anything was created", () => {
    const markup = render({
      error: "git worktree add failed: branch feature/x already exists",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("branch feature/x already exists");
    expect(markup).not.toContain("data-worktree-created");
  });
});

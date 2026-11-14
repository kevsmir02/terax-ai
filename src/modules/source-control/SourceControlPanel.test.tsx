// @vitest-environment jsdom
import type { SourceControlSummary } from "@/modules/source-control/useSourceControl";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceControlPanel } from "./SourceControlPanel";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: (index: number) => number;
  }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 30,
        size: estimateSize(index),
      })),
    scrollToIndex: vi.fn(),
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

function createSummary(): SourceControlSummary {
  return {
    contextPath: "/repo",
    repo: {
      repoRoot: "/repo",
      branch: "feat/ticket-61",
      upstream: "origin/feat/ticket-61",
      isDetached: false,
    },
    status: {
      repoRoot: "/repo",
      branch: "feat/ticket-61",
      upstream: "origin/feat/ticket-61",
      ahead: 2,
      behind: 0,
      isDetached: false,
      truncated: false,
      changedFiles: [
        {
          path: "src/app.ts",
          originalPath: null,
          indexStatus: " ",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          statusLabel: "Modified",
        },
        {
          path: "src/main.ts",
          originalPath: null,
          indexStatus: "M",
          worktreeStatus: " ",
          staged: true,
          unstaged: false,
          untracked: false,
          statusLabel: "Modified",
        },
      ],
    },
    changedCount: 2,
    upstream: "origin/feat/ticket-61",
    ahead: 2,
    behind: 0,
    hasRepo: true,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
    applyStatus: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    runRemoteAction: vi.fn().mockResolvedValue({ ok: true, action: "fetch" }),
  };
}

describe("SourceControlPanel", () => {
  it("lifts resting controls, commit box, and selected file row contrast", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SourceControlPanel
          open
          sourceControl={createSummary()}
          onOpenGitGraph={vi.fn()}
          onOpenDiff={vi.fn()}
          repositoryTarget={{ mode: "follow-context" }}
          onFollowRepositoryContext={vi.fn()}
          destructive={{
            usage: () => ({
              buffers: [],
              terminals: [],
              isBusy: async () => false,
            }),
            canonicalize: async (path) => path,
          }}
          worktreeDialogOpen={false}
          onWorktreeDialogOpenChange={vi.fn()}
          onOpenWorktreeAsSpace={vi.fn()}
          worktreeRemoveTarget={null}
          onWorktreeRemoveOpenChange={vi.fn()}
        />,
      );
    });

    const header = container.querySelector("header");
    const headerClasses = (header?.className ?? "").split(/\s+/);
    expect(headerClasses).toContain("border-border");
    expect(headerClasses).not.toContain("border-border/50");

    const branchButton = container.querySelector<HTMLButtonElement>(
      'button[title="/repo"]',
    );
    const branchClasses = (branchButton?.className ?? "").split(/\s+/);
    expect(branchClasses).toContain("border-border");
    expect(branchClasses).toContain("bg-background");
    expect(branchClasses).toContain("text-foreground");
    expect(branchClasses).not.toContain("bg-foreground/5");

    const checkpointsBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Checkpoints"]',
    );
    const refreshBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh source control"]',
    );
    expect((checkpointsBtn?.className ?? "").split(/\s+/)).toContain(
      "text-foreground",
    );
    expect((refreshBtn?.className ?? "").split(/\s+/)).toContain(
      "text-foreground",
    );

    const commitGraphBtn = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("Commit Graph"));
    const graphClasses = (commitGraphBtn?.className ?? "").split(/\s+/);
    expect(graphClasses).toContain("border-border");
    expect(graphClasses).toContain("text-foreground");
    expect(graphClasses).not.toContain("border-border/40");
    expect(graphClasses).not.toContain("hover:bg-foreground/[0.04]");

    const textarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Commit message"]',
    );
    const textareaClasses = (textarea?.className ?? "").split(/\s+/);
    expect(textareaClasses).toContain("placeholder:text-muted-foreground");
    expect(textareaClasses).not.toContain(
      "placeholder:text-muted-foreground/65",
    );

    const textareaFrameClasses = (
      textarea?.parentElement?.className ?? ""
    ).split(/\s+/);
    expect(textareaFrameClasses).toContain("border-border");
    expect(textareaFrameClasses).toContain("bg-background");
    expect(textareaFrameClasses).not.toContain("border-border/45");
    expect(textareaFrameClasses).not.toContain("bg-background/95");

    const fileButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("app.ts"),
    );
    const restingRow = fileButton?.closest<HTMLElement>('[role="option"]');
    expect(restingRow).not.toBeNull();
    expect((restingRow?.className ?? "").split(/\s+/)).toContain(
      "text-foreground",
    );

    act(() => {
      fileButton?.click();
    });

    const selectedRow = container.querySelector<HTMLElement>(
      '[data-selected="true"]',
    );
    const selectedClasses = (selectedRow?.className ?? "").split(/\s+/);
    expect(selectedClasses).toContain("bg-accent");
    expect(selectedClasses).toContain("text-foreground");
    expect(selectedClasses).toContain("ring-1");
    expect(selectedClasses).toContain("ring-inset");
    expect(selectedClasses).toContain("ring-border");
    expect(selectedClasses).not.toContain("bg-accent/55");
  });
});

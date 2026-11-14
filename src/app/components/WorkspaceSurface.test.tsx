// @vitest-environment jsdom

import { WorkspaceSurface } from "@/app/components/WorkspaceSurface";
import type { Tab } from "@/modules/tabs";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/terminal", () => ({
  TerminalStack: () => <div data-testid="stack-terminal" />,
}));

vi.mock("@/modules/editor", () => ({
  EditorStack: () => <div data-testid="stack-editor" />,
  GitDiffStack: () => <div data-testid="stack-git-diff" />,
}));

vi.mock("@/modules/preview", () => ({
  PreviewStack: () => <div data-testid="stack-preview" />,
}));

vi.mock("@/modules/markdown", () => ({
  MarkdownStack: () => <div data-testid="stack-markdown" />,
}));

vi.mock("@/modules/git-history", () => ({
  GitHistoryStack: () => <div data-testid="stack-git-history" />,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
});

function baseProps(
  activeTab: Tab,
  tabs: Tab[] = [activeTab],
): ComponentProps<typeof WorkspaceSurface> {
  return {
    tabs,
    activeId: activeTab.id,
    activeTab,
    activeSpaceId: "default",
    spaceRoots: { default: "/repo" },
    registerTerminalHandle: vi.fn(),
    onSearchReady: vi.fn(),
    onCwd: vi.fn(),
    onExit: vi.fn(),
    onFocusLeaf: vi.fn(),
    registerEditorHandle: vi.fn(),
    onEditorDirtyChange: vi.fn(),
    onEditorCloseTab: vi.fn(),
    registerPreviewHandle: vi.fn(),
    onPreviewUrlChange: vi.fn(),
    onOpenCommitFile: vi.fn(),
    onGitHistorySearchHandle: vi.fn(),
    onSetMarkdownView: vi.fn(),
  };
}

function mountSurface(activeTab: Tab, tabs?: Tab[]) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root?.render(<WorkspaceSurface {...baseProps(activeTab, tabs)} />);
  });
  return host;
}

const TERMINAL_TAB: Tab = {
  id: 1,
  spaceId: "default",
  kind: "terminal",
  title: "zsh",
  paneTree: { kind: "leaf", id: 1 },
  activeLeafId: 1,
};
const EDITOR_TAB: Tab = {
  id: 2,
  spaceId: "default",
  kind: "editor",
  title: "index.ts",
  path: "/repo/index.ts",
  dirty: false,
  preview: false,
};
const PREVIEW_TAB: Tab = {
  id: 3,
  spaceId: "default",
  kind: "preview",
  title: "Preview",
  url: "http://localhost:3000",
};
const MARKDOWN_TAB: Tab = {
  id: 4,
  spaceId: "default",
  kind: "markdown",
  title: "README.md",
  path: "/repo/README.md",
};
const GIT_DIFF_TAB: Tab = {
  id: 5,
  spaceId: "default",
  kind: "git-diff",
  title: "index.ts",
  path: "/repo/index.ts",
  repoRoot: "/repo",
  mode: "+",
  originalPath: null,
  preview: false,
};
const GIT_HISTORY_TAB: Tab = {
  id: 6,
  spaceId: "default",
  kind: "git-history",
  title: "Git Graph",
  repoRoot: "/repo",
};
const GIT_COMMIT_FILE_TAB: Tab = {
  id: 7,
  spaceId: "default",
  kind: "git-commit-file",
  title: "index.ts",
  repoRoot: "/repo",
  sha: "abc1234",
  shortSha: "abc1234",
  subject: "init",
  path: "index.ts",
  originalPath: null,
};

const SAMPLE_TABS: Tab[] = [
  TERMINAL_TAB,
  EDITOR_TAB,
  PREVIEW_TAB,
  MARKDOWN_TAB,
  GIT_DIFF_TAB,
  GIT_HISTORY_TAB,
  GIT_COMMIT_FILE_TAB,
];

describe("WorkspaceSurface", () => {
  it("paints opaque bg-background on the Content stage without floating card chrome", () => {
    const container = mountSurface(EDITOR_TAB, SAMPLE_TABS);
    const stage = container.firstElementChild as HTMLElement | null;
    expect(stage).not.toBeNull();
    const stageClasses = stage?.className.split(/\s+/) ?? [];
    expect(stageClasses).toContain("bg-background");
    expect(stageClasses).not.toContain("terax-pane");
    expect(stageClasses.some((c) => c.startsWith("rounded"))).toBe(false);
  });

  it("renders non-terminal layers full-bleed across Content stage while preserving terminal inset", () => {
    const container = mountSurface(EDITOR_TAB, SAMPLE_TABS);

    const terminalLayer = container.querySelector(
      '[data-testid="stack-terminal"]',
    )?.parentElement as HTMLElement | null;
    expect(terminalLayer?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["absolute", "inset-0", "px-3", "pt-2", "pb-2"]),
    );

    const nonTerminalTestIds = [
      "stack-editor",
      "stack-preview",
      "stack-markdown",
      "stack-git-diff",
      "stack-git-history",
    ];
    for (const testId of nonTerminalTestIds) {
      const layer = container.querySelector(`[data-testid="${testId}"]`)
        ?.parentElement as HTMLElement | null;
      expect(layer).not.toBeNull();
      const layerClasses = layer?.className.split(/\s+/) ?? [];
      expect(layerClasses).toContain("absolute");
      expect(layerClasses).toContain("inset-0");
      expect(
        layerClasses.some(
          (c) =>
            c.startsWith("p-") ||
            c.startsWith("px-") ||
            c.startsWith("py-") ||
            c.startsWith("pl-") ||
            c.startsWith("pr-") ||
            c.startsWith("pt-") ||
            c.startsWith("pb-") ||
            c.startsWith("rounded") ||
            c === "terax-pane",
        ),
      ).toBe(false);
    }

    const activeCases: Array<{ tab: Tab; activeTestId: string }> = [
      { tab: EDITOR_TAB, activeTestId: "stack-editor" },
      { tab: PREVIEW_TAB, activeTestId: "stack-preview" },
      { tab: MARKDOWN_TAB, activeTestId: "stack-markdown" },
      { tab: GIT_DIFF_TAB, activeTestId: "stack-git-diff" },
      { tab: GIT_HISTORY_TAB, activeTestId: "stack-git-history" },
      { tab: GIT_COMMIT_FILE_TAB, activeTestId: "stack-git-diff" },
    ];
    for (const { tab, activeTestId } of activeCases) {
      mountSurface(tab, SAMPLE_TABS);
      for (const testId of ["stack-terminal", ...nonTerminalTestIds]) {
        const layer = container.querySelector(`[data-testid="${testId}"]`)
          ?.parentElement as HTMLElement | null;
        expect(layer?.getAttribute("aria-hidden")).toBe(
          testId === activeTestId ? "false" : "true",
        );
      }
    }
  });
});

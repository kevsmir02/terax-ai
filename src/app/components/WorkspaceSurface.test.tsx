// @vitest-environment jsdom

import { WorkspaceSurface } from "@/app/components/WorkspaceSurface";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import { teraxDefault } from "@/modules/theme/themes/terax-default";
import { act, type ComponentProps, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionContainers = new Map<number, RefObject<HTMLDivElement | null>>();
const sessionBindings = new Map<
  number,
  { spaceId?: string; expectedIsolation?: string }
>();
const leafPtyIds = new Map<number, number>();

vi.mock("@/modules/terminal/ghostty/useGhosttyTerminalSession", () => ({
  useGhosttyTerminalSession: (opts: {
    leafId: number;
    container: RefObject<HTMLDivElement | null>;
    spaceId?: string;
    expectedIsolation?: string;
  }) => {
    sessionContainers.set(opts.leafId, opts.container);
    sessionBindings.set(opts.leafId, {
      spaceId: opts.spaceId,
      expectedIsolation: opts.expectedIsolation,
    });
    return {
      model: null,
      error: null,
      retry: vi.fn(),
      applyTheme: vi.fn(),
      write: vi.fn(),
      writeAtPrompt: vi.fn(async () => false),
      focus: vi.fn(),
      getBuffer: vi.fn(() => null),
      getSelection: vi.fn(() => null),
    };
  },
  ghosttyBlockGeometry: () => null,
  clearGhosttySession: vi.fn(() => false),
  disposeGhosttySession: vi.fn(),
  focusGhosttySession: vi.fn(),
  ghosttyFocusedLeaf: vi.fn(() => null),
  ghosttyLeafHasForegroundProcess: vi.fn(async () => false),
  ghosttyLeafIdForPty: vi.fn(() => null),
  ghosttyCwdForLeaf: vi.fn(() => null),
  ghosttyPtyIdForLeaf: vi.fn(
    (leafId: number) => leafPtyIds.get(leafId) ?? null,
  ),
  ghosttySelectionForLeaf: vi.fn(() => null),
  hasGhosttySession: vi.fn(() => false),
  interruptGhosttySession: vi.fn(),
  pasteIntoGhosttySession: vi.fn(() => false),
  submitToGhosttySession: vi.fn(),
  whenGhosttySessionReady: vi.fn(async () => {}),
  writeToGhosttySession: vi.fn(() => false),
}));

vi.mock("@/modules/terminal/ghostty/GhosttyBlockOverlay", () => ({
  default: ({ leafId }: { leafId: number }) => (
    <div data-testid={`block-overlay-${leafId}`} />
  ),
}));

vi.mock("@/modules/terminal/block/ShellInput", () => ({
  default: ({ leafId, mode }: { leafId: number; mode: string }) => (
    <div data-testid="shell-input" data-leaf-id={leafId} data-mode={mode} />
  ),
}));

vi.mock("@/modules/theme", () => ({
  useTheme: () => ({
    mode: "dark" as const,
    resolvedMode: "dark" as const,
    themeId: teraxDefault.id,
    activeTheme: teraxDefault,
    customThemes: [],
    setMode: vi.fn(),
    setThemeId: vi.fn(),
    previewThemeId: vi.fn(),
  }),
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

beforeEach(() => {
  sessionContainers.clear();
  sessionBindings.clear();
  leafPtyIds.clear();
  useAgentStore.setState({ sessions: {}, notifications: [] });
  useAgentActivityStore.setState({ phases: {}, agents: {} });
  usePreferencesStore.setState({ terminalShell: "" });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

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
  over: Partial<ComponentProps<typeof WorkspaceSurface>> = {},
): ComponentProps<typeof WorkspaceSurface> {
  return {
    tabs,
    activeId: activeTab.id,
    activeTab,
    activeSpaceId: "default",
    spaceRoots: { default: "/repo" },
    spaceIsolations: { default: "default" },
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
    ...over,
  };
}

function ensureMountHost() {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  return host;
}

function mountSurface(
  activeTab: Tab,
  tabs?: Tab[],
  over?: Partial<ComponentProps<typeof WorkspaceSurface>>,
) {
  const container = ensureMountHost();
  act(() => {
    root?.render(<WorkspaceSurface {...baseProps(activeTab, tabs, over)} />);
  });
  return container;
}

async function mountSurfaceAsync(
  activeTab: Tab,
  tabs?: Tab[],
  over?: Partial<ComponentProps<typeof WorkspaceSurface>>,
) {
  const container = ensureMountHost();
  await act(async () => {
    root?.render(<WorkspaceSurface {...baseProps(activeTab, tabs, over)} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
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

  it("frames single terminal tabs inside one unified outlined Terminal card within balanced Content stage margins while leaving non-terminal layers full-bleed", () => {
    const container = mountSurface(TERMINAL_TAB, SAMPLE_TABS);

    const terminalCards = container.querySelectorAll("[data-terminal-card]");
    expect(terminalCards).toHaveLength(1);
    const card = terminalCards[0] as HTMLElement;
    expect(card.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "flex",
        "h-full",
        "min-h-0",
        "flex-col",
        "overflow-hidden",
        "rounded-xl",
        "border",
        "border-border",
        "bg-terminal-background",
      ]),
    );

    const terminalLayer = card.parentElement as HTMLElement | null;
    expect(terminalLayer?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["absolute", "inset-0", "p-3"]),
    );
    expect(terminalLayer?.getAttribute("aria-hidden")).toBe("false");
    expect(card.querySelector("[data-terminal-stack]")).not.toBeNull();
    expect(card.querySelector("[data-terminal-area]")).not.toBeNull();
    expect(card.querySelector('[data-pane-leaf="1"]')).not.toBeNull();

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
            c.startsWith("border") ||
            c === "terax-pane",
        ),
      ).toBe(false);
    }

    const activeCases: Array<{ tab: Tab; activeAttrSelector: string }> = [
      { tab: TERMINAL_TAB, activeAttrSelector: "[data-terminal-card]" },
      { tab: EDITOR_TAB, activeAttrSelector: '[data-testid="stack-editor"]' },
      { tab: PREVIEW_TAB, activeAttrSelector: '[data-testid="stack-preview"]' },
      {
        tab: MARKDOWN_TAB,
        activeAttrSelector: '[data-testid="stack-markdown"]',
      },
      {
        tab: GIT_DIFF_TAB,
        activeAttrSelector: '[data-testid="stack-git-diff"]',
      },
      {
        tab: GIT_HISTORY_TAB,
        activeAttrSelector: '[data-testid="stack-git-history"]',
      },
      {
        tab: GIT_COMMIT_FILE_TAB,
        activeAttrSelector: '[data-testid="stack-git-diff"]',
      },
    ];
    for (const { tab, activeAttrSelector } of activeCases) {
      mountSurface(tab, SAMPLE_TABS);
      for (const selector of [
        "[data-terminal-card]",
        ...nonTerminalTestIds.map((id) => `[data-testid="${id}"]`),
      ]) {
        const layer = container.querySelector(selector)
          ?.parentElement as HTMLElement | null;
        expect(layer?.getAttribute("aria-hidden")).toBe(
          selector === activeAttrSelector ? "false" : "true",
        );
      }
    }
  });

  it("docks the blocks-mode footer inside the Terminal card below [data-terminal-area] on opaque --terminal-header", async () => {
    const plainTab: Tab = {
      id: 10,
      spaceId: "default",
      kind: "terminal",
      title: "zsh",
      paneTree: { kind: "leaf", id: 100 },
      activeLeafId: 100,
    };
    const blocksTab: Tab = {
      id: 11,
      spaceId: "default",
      kind: "terminal",
      title: "zsh",
      paneTree: { kind: "leaf", id: 101 },
      activeLeafId: 101,
      blocks: true,
    };
    const tabs = [plainTab, blocksTab, EDITOR_TAB];

    const container = await mountSurfaceAsync(plainTab, tabs);
    expect(container.querySelector("[data-block-input-bar]")).toBeNull();

    await mountSurfaceAsync(blocksTab, tabs);
    const card = container.querySelector("[data-terminal-card]");
    const area = container.querySelector("[data-terminal-area]");
    const footer = container.querySelector<HTMLElement>(
      "[data-block-input-bar]",
    );
    expect(card).not.toBeNull();
    expect(area).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(card?.contains(footer ?? null)).toBe(true);
    expect(area?.contains(footer ?? null)).toBe(false);
    expect(
      Boolean(
        area &&
          footer &&
          area.compareDocumentPosition(footer) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    const terminalPaneRegion = container.querySelector(
      "[data-terminal-stack]",
    )?.parentElement;
    expect(terminalPaneRegion?.parentElement).toBe(card);
    expect(footer?.parentElement).toBe(card);
    expect(terminalPaneRegion?.nextElementSibling).toBe(footer);
    expect(terminalPaneRegion?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["flex-1", "min-h-0"]),
    );

    const footerClasses = footer?.className.split(/\s+/) ?? [];
    expect(footerClasses).toContain("shrink-0");
    expect(footerClasses).toContain("border-t");
    expect(footerClasses).toContain("border-border");
    expect(footerClasses).toContain("bg-terminal-header");
    expect(footer?.className).not.toContain("border-border/60");
    expect(footer?.className).not.toContain("bg-foreground/[0.02]");

    mountSurface(EDITOR_TAB, tabs);
    expect(container.querySelector("[data-block-input-bar]")).toBeNull();
  });

  it("renders nested split panes inside the single unified Terminal card with opaque bg-border dividers", () => {
    const splitTab: Tab = {
      id: 20,
      spaceId: "default",
      kind: "terminal",
      title: "split",
      paneTree: {
        kind: "split",
        id: 1,
        dir: "row",
        children: [
          { kind: "leaf", id: 10 },
          {
            kind: "split",
            id: 2,
            dir: "col",
            children: [
              { kind: "leaf", id: 11 },
              { kind: "leaf", id: 12 },
            ],
          },
        ],
      },
      activeLeafId: 10,
    };
    const onFocusLeaf = vi.fn();
    const container = mountSurface(splitTab, [splitTab], { onFocusLeaf });

    const cards = container.querySelectorAll("[data-terminal-card]");
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;

    const leaves = Array.from(
      card.querySelectorAll<HTMLElement>("[data-pane-leaf]"),
    );
    expect(leaves.map((el) => el.dataset.paneLeaf)).toEqual(["10", "11", "12"]);
    for (const leaf of leaves) {
      expect(leaf.className).not.toMatch(/\brounded/);
      expect(leaf.parentElement?.className ?? "").not.toMatch(/\brounded/);
    }

    const dividers = Array.from(
      card.querySelectorAll<HTMLElement>('[data-slot="resizable-handle"]'),
    );
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) {
      const classes = divider.className.split(/\s+/);
      expect(classes).toContain("bg-border");
      expect(classes).not.toContain("bg-border/50");
      expect(classes).toContain("hover:bg-ring/70");
      expect(classes).toContain("active:bg-ring");
      expect(classes).toContain("data-[separator=active]:bg-ring");
    }

    const secondLeaf = leaves[1];
    act(() => {
      secondLeaf.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onFocusLeaf).toHaveBeenCalledWith(20, 11);
  });

  it("frames each TerminalPane body with symmetric --terminal-background inset around the mount box and block overlay", async () => {
    const blocksTab: Tab = {
      id: 30,
      spaceId: "default",
      kind: "terminal",
      title: "zsh",
      paneTree: { kind: "leaf", id: 301 },
      activeLeafId: 301,
      blocks: true,
    };
    const container = await mountSurfaceAsync(blocksTab, [blocksTab]);

    const paneRoot = container.querySelector<HTMLElement>(
      "[data-terminal-backend]",
    );
    expect(paneRoot).not.toBeNull();
    expect(paneRoot?.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "flex",
        "h-full",
        "w-full",
        "flex-col",
        "overflow-hidden",
      ]),
    );

    const paneBody = paneRoot?.querySelector<HTMLElement>(
      "[data-terminal-pane-body]",
    );
    expect(paneBody).not.toBeNull();
    expect(paneBody?.parentElement).toBe(paneRoot);
    const bodyClasses = paneBody?.className.split(/\s+/) ?? [];
    expect(bodyClasses).toEqual(
      expect.arrayContaining([
        "relative",
        "flex",
        "min-h-0",
        "flex-1",
        "flex-col",
        "border-8",
        "border-solid",
        "border-terminal-background",
      ]),
    );
    expect(bodyClasses).not.toContain("bg-terminal-background");

    const mountNode = sessionContainers.get(301)?.current;
    const overlay = paneBody?.querySelector(
      '[data-testid="block-overlay-301"]',
    );
    expect(mountNode).not.toBeNull();
    expect(overlay).not.toBeNull();
    expect(mountNode?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["absolute", "inset-0"]),
    );

    const innerStage = mountNode?.parentElement;
    expect(innerStage?.parentElement).toBe(paneBody);
    expect(overlay?.parentElement).toBe(innerStage);
    expect(innerStage?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["relative", "h-full", "w-full"]),
    );

    const paneHeader =
      paneRoot?.querySelector<HTMLElement>("[data-pane-header]");
    expect(paneHeader).not.toBeNull();
    expect(paneRoot?.firstElementChild).toBe(paneHeader);
    expect(paneHeader?.nextElementSibling).toBe(paneBody);
    expect(paneHeader?.contains(mountNode ?? null)).toBe(false);
    expect(paneHeader?.contains(overlay ?? null)).toBe(false);
    expect(paneHeader?.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "shrink-0",
        "border-b",
        "border-border",
        "bg-terminal-header",
      ]),
    );
  });

  it("displays left-side PaneHeader identity in agent > customTitle > shell > Terminal precedence with live phase indicators and ignores OSC 0/2 tab.title churn", () => {
    const noisyTab: Tab = {
      id: 40,
      spaceId: "default",
      kind: "terminal",
      title: "loba@archlinux: ~/some/noisy/osc-prompt-title",
      paneTree: { kind: "leaf", id: 401 },
      activeLeafId: 401,
    };

    const container = mountSurface(noisyTab, [noisyTab]);
    const label = () =>
      container.querySelector<HTMLElement>("[data-pane-label]")?.textContent;

    expect(label()).toBe("Terminal");
    expect(
      container.querySelector('[data-pane-icon="terminal"]'),
    ).not.toBeNull();
    expect(container.querySelector("[data-pane-phase]")).toBeNull();

    act(() => {
      usePreferencesStore.setState({ terminalShell: "/usr/bin/fish" });
    });
    expect(label()).toBe("fish");

    const customTitledTab: Tab = {
      ...noisyTab,
      customTitle: "  Dev Server  ",
    };
    mountSurface(customTitledTab, [customTitledTab]);
    expect(label()).toBe("Dev Server");

    leafPtyIds.set(401, 9001);
    act(() => {
      useAgentActivityStore.setState({
        agents: { 9001: "claude" },
        phases: { 9001: "working" },
      });
    });
    expect(label()).toBe("Claude Code");
    expect(container.querySelector('[data-pane-icon="agent"]')).not.toBeNull();
    const workingPhase =
      container.querySelector<HTMLElement>("[data-pane-phase]");
    expect(workingPhase?.getAttribute("data-pane-phase")).toBe("working");
    expect(workingPhase?.textContent).toBe("Running");

    act(() => {
      useAgentActivityStore.setState({
        agents: { 9001: "claude" },
        phases: { 9001: "attention" },
      });
    });
    const attentionPhase =
      container.querySelector<HTMLElement>("[data-pane-phase]");
    expect(attentionPhase?.getAttribute("data-pane-phase")).toBe("attention");
    expect(attentionPhase?.textContent).toBe("Needs attention");

    leafPtyIds.clear();
    act(() => {
      useAgentActivityStore.setState({ agents: {}, phases: {} });
      useAgentStore.getState().start(401, 40, "codex");
    });
    expect(label()).toBe("Codex");
    const sessionPhase =
      container.querySelector<HTMLElement>("[data-pane-phase]");
    expect(sessionPhase?.getAttribute("data-pane-phase")).toBe("working");
    expect(sessionPhase?.textContent).toBe("Running");
  });

  it("renders a concise read-only tildified and left-truncated cwd in each PaneHeader without leaking tab.cwd across split leaves", () => {
    const singleTabWithTabCwd: Tab = {
      id: 49,
      spaceId: "default",
      kind: "terminal",
      title: "zsh",
      cwd: "/home/loba/terax-ai",
      paneTree: { kind: "leaf", id: 491 },
      activeLeafId: 491,
    };
    const singleContainer = mountSurface(
      singleTabWithTabCwd,
      [singleTabWithTabCwd],
      { home: "/home/loba" },
    );
    const singleCwd = singleContainer.querySelector<HTMLElement>(
      '[data-pane-leaf="491"] [data-pane-cwd]',
    );
    expect(singleCwd?.textContent).toBe("~/terax-ai");

    const splitTab: Tab = {
      id: 50,
      spaceId: "default",
      kind: "terminal",
      title: "zsh",
      cwd: "/home/loba/terax-ai",
      paneTree: {
        kind: "split",
        id: 1,
        dir: "row",
        children: [
          { kind: "leaf", id: 501, cwd: "/home/loba/terax-ai" },
          {
            kind: "leaf",
            id: 502,
            cwd: "/home/loba/Documents/projects/personal/terax-ai/packages/core",
          },
          { kind: "leaf", id: 503 },
        ],
      },
      activeLeafId: 501,
    };

    const container = mountSurface(splitTab, [splitTab], {
      home: "/home/loba",
    });

    const leaf501Cwd = container.querySelector<HTMLElement>(
      '[data-pane-leaf="501"] [data-pane-cwd]',
    );
    const leaf502Cwd = container.querySelector<HTMLElement>(
      '[data-pane-leaf="502"] [data-pane-cwd]',
    );
    const leaf503Cwd = container.querySelector<HTMLElement>(
      '[data-pane-leaf="503"] [data-pane-cwd]',
    );

    expect(leaf501Cwd?.textContent).toBe("~/terax-ai");
    expect(leaf501Cwd?.getAttribute("title")).toBe("~/terax-ai");
    expect(leaf501Cwd?.tagName).toBe("SPAN");
    expect(leaf501Cwd?.querySelector("button")).toBeNull();

    expect(leaf502Cwd?.textContent).toBe("~/.../terax-ai/packages/core");
    expect(leaf502Cwd?.getAttribute("title")).toBe(
      "~/Documents/projects/personal/terax-ai/packages/core",
    );
    expect(leaf503Cwd).toBeNull();
  });

  it("gates the PaneHeader close button on leafCount > 1 and invokes onCloseLeaf without focusing the closing leaf", () => {
    const onCloseLeaf = vi.fn();
    const onFocusLeaf = vi.fn();

    const singleContainer = mountSurface(TERMINAL_TAB, [TERMINAL_TAB], {
      onCloseLeaf,
      onFocusLeaf,
    });
    expect(singleContainer.querySelector("[data-pane-close]")).toBeNull();

    const splitTab: Tab = {
      id: 60,
      spaceId: "default",
      kind: "terminal",
      title: "split",
      paneTree: {
        kind: "split",
        id: 1,
        dir: "row",
        children: [
          { kind: "leaf", id: 601 },
          { kind: "leaf", id: 602 },
        ],
      },
      activeLeafId: 601,
    };

    const splitContainer = mountSurface(splitTab, [splitTab], {
      onCloseLeaf,
      onFocusLeaf,
    });
    const closeButtons =
      splitContainer.querySelectorAll<HTMLButtonElement>("[data-pane-close]");
    expect(closeButtons).toHaveLength(2);

    const unfocusedClose = splitContainer.querySelector<HTMLButtonElement>(
      '[data-pane-leaf="602"] [data-pane-close]',
    );
    expect(unfocusedClose).not.toBeNull();
    act(() => {
      unfocusedClose?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
      unfocusedClose?.click();
    });
    expect(onCloseLeaf).toHaveBeenCalledWith(602);
    expect(onFocusLeaf).not.toHaveBeenCalled();
  });

  it("visually distinguishes the focused split PaneHeader with elevated surface, crisp foreground, and top accent cue while muting unfocused headers and never dimming terminal bodies", () => {
    const splitTab: Tab = {
      id: 70,
      spaceId: "default",
      kind: "terminal",
      title: "split",
      paneTree: {
        kind: "split",
        id: 1,
        dir: "row",
        children: [
          { kind: "leaf", id: 701 },
          { kind: "leaf", id: 702 },
        ],
      },
      activeLeafId: 701,
    };

    const container = mountSurface(splitTab, [splitTab]);
    const focusedHeader = container.querySelector<HTMLElement>(
      '[data-pane-leaf="701"] [data-pane-header]',
    );
    const unfocusedHeader = container.querySelector<HTMLElement>(
      '[data-pane-leaf="702"] [data-pane-header]',
    );
    const focusedBody = container.querySelector<HTMLElement>(
      '[data-pane-leaf="701"] [data-terminal-pane-body]',
    );
    const unfocusedBody = container.querySelector<HTMLElement>(
      '[data-pane-leaf="702"] [data-terminal-pane-body]',
    );

    expect(focusedHeader?.getAttribute("data-pane-focused")).toBe("true");
    expect(focusedHeader?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["bg-terminal-header-focused", "text-foreground"]),
    );
    expect(
      focusedHeader?.querySelector("[data-pane-focus-indicator]"),
    ).not.toBeNull();

    expect(unfocusedHeader?.getAttribute("data-pane-focused")).toBe("false");
    expect(unfocusedHeader?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["bg-terminal-header", "text-muted-foreground"]),
    );
    expect(
      unfocusedHeader?.querySelector("[data-pane-focus-indicator]"),
    ).toBeNull();

    for (const body of [focusedBody, unfocusedBody]) {
      expect(body).not.toBeNull();
      expect(body?.className).not.toMatch(/opacity-|brightness-|contrast-/);
    }
  });

  it("threads each terminal tab's own spaceId and expectedIsolation through to terminal sessions", () => {
    const tabInOtherSpace: Tab = {
      id: 80,
      kind: "terminal",
      spaceId: "sp-client",
      title: "client",
      paneTree: { kind: "leaf", id: 801 },
      activeLeafId: 801,
    };

    mountSurface(tabInOtherSpace, [tabInOtherSpace], {
      activeSpaceId: "default",
      spaceIsolations: { default: "default", "sp-client": "isolated" },
    });

    expect(sessionBindings.get(801)).toEqual({
      spaceId: "sp-client",
      expectedIsolation: "isolated",
    });
  });

  it("keeps existing terminal session context pinned when switching active Spaces", () => {
    const tabA: Tab = {
      id: 90,
      kind: "terminal",
      spaceId: "sp-alpha",
      title: "alpha",
      paneTree: { kind: "leaf", id: 901 },
      activeLeafId: 901,
    };
    const tabB: Tab = {
      id: 91,
      kind: "terminal",
      spaceId: "sp-beta",
      title: "beta",
      paneTree: { kind: "leaf", id: 902 },
      activeLeafId: 902,
    };

    mountSurface(tabA, [tabA, tabB], {
      activeSpaceId: "sp-alpha",
      spaceIsolations: { "sp-alpha": "isolated", "sp-beta": "default" },
    });
    expect(sessionBindings.get(901)).toEqual({
      spaceId: "sp-alpha",
      expectedIsolation: "isolated",
    });

    // Switch active Space to sp-beta: sp-alpha's session stays pinned to its starting context.
    mountSurface(tabB, [tabA, tabB], {
      activeSpaceId: "sp-beta",
      spaceIsolations: { "sp-alpha": "isolated", "sp-beta": "default" },
    });
    expect(sessionBindings.get(901)).toEqual({
      spaceId: "sp-alpha",
      expectedIsolation: "isolated",
    });
    expect(sessionBindings.get(902)).toEqual({
      spaceId: "sp-beta",
      expectedIsolation: "default",
    });
  });
});

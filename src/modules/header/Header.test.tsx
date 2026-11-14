// @vitest-environment jsdom
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ResizeCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver,
) => void;

const observedEntries = new Map<Element, ResizeCallback>();

function installDomStubs(): void {
  observedEntries.clear();

  globalThis.ResizeObserver = class {
    private readonly cb: ResizeCallback;
    constructor(cb: ResizeCallback) {
      this.cb = cb;
    }
    observe(target: Element) {
      observedEntries.set(target, this.cb);
    }
    unobserve(target: Element) {
      observedEntries.delete(target);
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
}

function triggerResize(target: Element, width: number): void {
  const cb = observedEntries.get(target);
  if (!cb) throw new Error("No ResizeObserver registered for target");
  cb(
    [
      {
        target,
        contentRect: { width } as DOMRectReadOnly,
      } as ResizeObserverEntry,
    ],
    {} as ResizeObserver,
  );
}

function makeTerminalTab(id: number, title = `shell-${id}`): Tab {
  return {
    id,
    kind: "terminal",
    spaceId: "space-1",
    title,
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as unknown as Tab;
}

function baseProps(
  over: Partial<ComponentProps<typeof Header>> = {},
): ComponentProps<typeof Header> {
  return {
    tabs: [makeTerminalTab(1), makeTerminalTab(2)],
    activeId: 1,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onNewBlock: vi.fn(),
    onNewPreview: vi.fn(),
    onNewEditor: vi.fn(),
    onNewGitGraph: vi.fn(),
    onLaunchAgents: vi.fn(),
    onClose: vi.fn(),
    onCloseTabsToRight: vi.fn(),
    onCloseOtherTabs: vi.fn(),
    onPin: vi.fn(),
    onRename: vi.fn(),
    onReorder: vi.fn(),
    onOverrideLanguage: vi.fn(),
    onToggleSidebar: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onActivateAgent: vi.fn(),
    onOpenSettings: vi.fn(),
    spaceSwitcher: <div data-testid="space-switcher">Spaces</div>,
    searchTarget: null,
    searchRef: { current: null },
    ...over,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mountHeader(over: Partial<ComponentProps<typeof Header>> = {}) {
  const props = baseProps(over);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Header {...props} />);
  });
  return { container, props };
}

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

function openViewMenu(host: HTMLElement): HTMLElement {
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[title="Open view or agents"]',
  );
  expect(trigger).not.toBeNull();
  act(() => {
    trigger?.focus();
    trigger?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  return menu as HTMLElement;
}

function selectMenuItem(menu: HTMLElement, label: string): void {
  const items = Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  );
  const target = items.find((el) => el.textContent?.includes(label));
  expect(target, `menu item "${label}" should exist`).toBeDefined();
  act(() => {
    target?.click();
  });
}

async function waitForSelector(selector: string): Promise<HTMLElement> {
  return vi.waitFor(
    async () => {
      let el: HTMLElement | null = null;
      await act(async () => {
        el = document.body.querySelector<HTMLElement>(selector);
      });
      if (!el) throw new Error(`Waiting for ${selector}`);
      return el;
    },
    { timeout: 2000, interval: 16 },
  );
}

describe("Header", () => {
  beforeEach(() => {
    installDomStubs();
  });

  it("opens a plain terminal tab on a single click of the left + button without opening a menu", () => {
    const onNew = vi.fn();
    const { container: host } = mountHeader({ onNew });

    const newTabButton = host.querySelector<HTMLButtonElement>(
      'button[title="New tab"]',
    );
    expect(newTabButton).not.toBeNull();

    act(() => {
      newTabButton?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      newTabButton?.click();
    });

    expect(onNew).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("pins the left + button outside the horizontal scroll strip immediately after tabs and before the drag spacer", () => {
    const { container: host } = mountHeader({
      tabs: [
        makeTerminalTab(1),
        makeTerminalTab(2),
        makeTerminalTab(3),
        makeTerminalTab(4),
      ],
    });

    const spaceSwitcher = host.querySelector('[data-testid="space-switcher"]');
    const centerStrip = spaceSwitcher?.parentElement;
    expect(centerStrip).not.toBeNull();

    const scrollStrip =
      centerStrip?.querySelector<HTMLElement>(".overflow-x-auto");
    expect(scrollStrip).not.toBeNull();

    const newTabButton = host.querySelector<HTMLButtonElement>(
      'button[title="New tab"]',
    );
    expect(newTabButton).not.toBeNull();
    expect(scrollStrip?.contains(newTabButton ?? null)).toBe(false);

    const children = Array.from(centerStrip?.children ?? []);
    const spacer = children[children.length - 1] as HTMLElement | undefined;
    expect(spacer?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(
      Boolean(
        scrollStrip &&
          newTabButton &&
          scrollStrip.compareDocumentPosition(newTabButton) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
    expect(
      Boolean(
        spacer &&
          newTabButton &&
          newTabButton.compareDocumentPosition(spacer) &
            Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("renders the right-side view launcher immediately before SearchInline and keeps it visible at compact width", () => {
    const { container: host } = mountHeader();

    const launcherButton = host.querySelector<HTMLButtonElement>(
      'button[title="Open view or agents"]',
    );
    expect(launcherButton).not.toBeNull();
    expect(launcherButton?.className).toContain("size-7");
    expect(launcherButton?.className).toContain("rounded-md");

    const searchInput = host.querySelector<HTMLInputElement>("input");
    expect(searchInput).not.toBeNull();
    const searchWrapper = searchInput?.closest(".relative.h-7");
    expect(searchWrapper).not.toBeNull();

    const launcherSlot = launcherButton?.closest("span.inline-flex");
    expect(launcherSlot?.nextElementSibling).toBe(searchWrapper);

    const headerRoot = host.firstElementChild as Element;
    act(() => {
      triggerResize(headerRoot, 600);
    });

    expect(host.querySelector("input")).toBeNull();
    const collapsedSearchButton = host.querySelector<HTMLButtonElement>(
      'button[title^="Search"]',
    );
    expect(collapsedSearchButton).not.toBeNull();
    const compactLauncher = host.querySelector<HTMLButtonElement>(
      'button[title="Open view or agents"]',
    );
    expect(compactLauncher).not.toBeNull();
  });

  it("groups view menu items with Web Preview and omits Terminal, aligned to end", () => {
    const { container: host } = mountHeader();
    const menu = openViewMenu(host);

    expect(menu.getAttribute("data-align")).toBe("end");

    const children = Array.from(menu.children);
    const orderedKinds = children.map((el) => {
      if (el.getAttribute("role") === "separator") return "---";
      return (
        el.querySelector("span")?.textContent?.trim() ?? el.textContent?.trim()
      );
    });

    expect(orderedKinds).toEqual([
      "Agents",
      "Web Preview",
      "Git Graph",
      "---",
      "Blocks",
      "Editor",
    ]);
    expect(menu.textContent).not.toContain("Terminal");
  });

  it("invokes the matching view callback when selecting each view menu item", () => {
    const onNewPreview = vi.fn();
    const onNewGitGraph = vi.fn();
    const onNewBlock = vi.fn();
    const onNewEditor = vi.fn();
    const { container: host } = mountHeader({
      onNewPreview,
      onNewGitGraph,
      onNewBlock,
      onNewEditor,
    });

    selectMenuItem(openViewMenu(host), "Web Preview");
    expect(onNewPreview).toHaveBeenCalledTimes(1);

    selectMenuItem(openViewMenu(host), "Git Graph");
    expect(onNewGitGraph).toHaveBeenCalledTimes(1);

    selectMenuItem(openViewMenu(host), "Blocks");
    expect(onNewBlock).toHaveBeenCalledTimes(1);

    selectMenuItem(openViewMenu(host), "Editor");
    expect(onNewEditor).toHaveBeenCalledTimes(1);
  });

  it("navigates between the view menu and the end-aligned agent launcher popover and launches agents", async () => {
    usePreferencesStore.setState({ hydrated: true });
    const onLaunchAgents = vi.fn();
    const { container: host } = mountHeader({ onLaunchAgents });

    selectMenuItem(openViewMenu(host), "Agents");
    const popover = await waitForSelector('[data-slot="popover-content"]');
    expect(popover.getAttribute("data-align")).toBe("end");
    expect(popover.textContent).toContain("Launch agents");

    const backButton = popover.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to view menu"]',
    );
    expect(backButton).not.toBeNull();

    act(() => {
      backButton?.click();
    });
    const reopenedMenu = await waitForSelector('[role="menu"]');
    expect(
      document.body.querySelector('[data-slot="popover-content"]'),
    ).toBeNull();

    selectMenuItem(reopenedMenu, "Agents");
    const reopenedPopover = await waitForSelector(
      '[data-slot="popover-content"]',
    );

    const launchForm = reopenedPopover.querySelector<HTMLFormElement>("form");
    expect(launchForm).not.toBeNull();
    act(() => {
      launchForm?.requestSubmit();
    });

    expect(onLaunchAgents).toHaveBeenCalledTimes(1);
    expect(onLaunchAgents).toHaveBeenCalledWith({
      agent: "claude",
      command: "claude",
      instances: 2,
    });
  });
});

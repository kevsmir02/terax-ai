// @vitest-environment jsdom
import type { Tab } from "@/modules/tabs";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpaces } from "./lib/useSpaces";
import { SpaceSwitcher } from "./SpaceSwitcher";

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

function makeTab(id: number, spaceId: string, cwd: string): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: `shell-${id}`,
    cwd,
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
  } as unknown as Tab;
}

describe("SpaceSwitcher", () => {
  it("lifts trigger, active Space row, avatar, badges, and muted labels to crisp contrast", () => {
    useSpaces.getState().hydrate(
      [
        {
          id: "space-1",
          name: "Alpha",
          root: "/work/terax",
          env: LOCAL_WORKSPACE,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "space-2",
          name: "Beta",
          root: "/work/terax",
          env: LOCAL_WORKSPACE,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      "space-1",
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SpaceSwitcher
          open
          onOpenChange={vi.fn()}
          tabs={[
            makeTab(1, "space-1", "/work/terax/src"),
            makeTab(2, "space-2", "/work/terax/docs"),
          ]}
          onNewSpace={vi.fn()}
          onDeleteSpace={vi.fn()}
          onNewTabInSpace={vi.fn()}
          onJumpTab={vi.fn()}
          onCloseTab={vi.fn()}
          onMoveTabToSpace={vi.fn()}
          onReorderTab={vi.fn()}
          onReorderSpaces={vi.fn()}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[title^="Spaces"]',
    );
    expect(trigger).not.toBeNull();
    const triggerClasses = (trigger?.className ?? "").split(/\s+/);
    expect(triggerClasses).toContain("text-foreground");
    expect(triggerClasses).not.toContain("text-muted-foreground/90");
    const triggerChevron = trigger?.querySelector("svg");
    expect(triggerChevron?.getAttribute("class") ?? "").not.toContain(
      "opacity-65",
    );

    const popover = document.body.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    expect(popover).not.toBeNull();

    const activeRow = popover?.querySelector<HTMLElement>(
      '[data-space-id="space-1"]',
    );
    const inactiveRow = popover?.querySelector<HTMLElement>(
      '[data-space-id="space-2"]',
    );
    expect((activeRow?.className ?? "").split(/\s+/)).toContain("bg-accent");
    expect((activeRow?.className ?? "").split(/\s+/)).toContain("ring-border");

    const inactiveAvatar =
      inactiveRow?.querySelector<HTMLElement>("span[aria-hidden]");
    const avatarClasses = (inactiveAvatar?.className ?? "").split(/\s+/);
    expect(avatarClasses).toContain("ring-border");
    expect(avatarClasses).toContain("text-foreground");
    expect(avatarClasses).not.toContain("ring-border/50");

    const sharedNote =
      popover?.querySelector<HTMLElement>("[data-shared-note]");
    const noteClasses = (sharedNote?.className ?? "").split(/\s+/);
    expect(noteClasses).toContain("text-muted-foreground");
    expect(noteClasses).not.toContain("text-muted-foreground/70");
    expect((sharedNote?.parentElement?.className ?? "").split(/\s+/)).toContain(
      "border-border",
    );

    const tabSubtitle = Array.from(
      popover?.querySelectorAll<HTMLElement>('[data-tab-id="1"] span') ?? [],
    ).find((el) => el.textContent === "terax/src");
    expect(tabSubtitle).toBeDefined();
    expect((tabSubtitle?.className ?? "").split(/\s+/)).toContain(
      "text-muted-foreground",
    );
    expect((tabSubtitle?.className ?? "").split(/\s+/)).not.toContain(
      "text-muted-foreground/55",
    );
  });
});

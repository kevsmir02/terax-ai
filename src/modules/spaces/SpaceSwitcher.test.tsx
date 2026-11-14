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
          accountIsolation: "default",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "space-2",
          name: "Beta",
          root: "/work/terax",
          env: LOCAL_WORKSPACE,
          accountIsolation: "default",
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

  it("supports creating an isolated Space and gates isolation toggling on active terminals", async () => {
    useSpaces.getState().hydrate(
      [
        {
          id: "space-1",
          name: "Alpha",
          root: "/work/terax",
          env: LOCAL_WORKSPACE,
          accountIsolation: "default",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "space-2",
          name: "Client",
          root: "/work/client",
          env: LOCAL_WORKSPACE,
          accountIsolation: "isolated",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      "space-1",
    );

    const onNewIsolatedSpace = vi.fn();
    const onToggleSpaceIsolation = vi.fn(async () => {});
    const canToggleSpaceIsolation = vi.fn((spaceId: string) =>
      spaceId === "space-1"
        ? {
            allowed: false as const,
            reason:
              "Close active terminals in this Space before switching Account isolation.",
          }
        : { allowed: true as const },
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SpaceSwitcher
          open
          onOpenChange={vi.fn()}
          tabs={[makeTab(1, "space-1", "/work/terax")]}
          onNewSpace={vi.fn()}
          onNewIsolatedSpace={onNewIsolatedSpace}
          onToggleSpaceIsolation={onToggleSpaceIsolation}
          canToggleSpaceIsolation={canToggleSpaceIsolation}
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

    const popover = document.body.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    expect(popover).not.toBeNull();

    // Isolated Space displays clear indicator badge.
    const isolatedRow = popover?.querySelector<HTMLElement>(
      '[data-space-id="space-2"]',
    );
    expect(
      isolatedRow?.querySelector('[data-space-isolation="isolated"]'),
    ).not.toBeNull();

    // Active Space with open active terminals shows disabled toggle and clear blocked reason.
    const blockedToggle = popover?.querySelector<HTMLButtonElement>(
      '[data-isolation-toggle="space-1"]',
    );
    expect(blockedToggle?.disabled).toBe(true);
    expect(
      popover?.querySelector('[data-isolation-blocked="space-1"]')?.textContent,
    ).toContain("Close active terminals");

    // Expand space-2 (no active terminals) and toggle back cleanly.
    const expandBtn = isolatedRow?.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand"]',
    );
    act(() => {
      expandBtn?.click();
    });

    const allowedToggle = popover?.querySelector<HTMLButtonElement>(
      '[data-isolation-toggle="space-2"]',
    );
    expect(allowedToggle?.disabled).toBe(false);
    await act(async () => {
      allowedToggle?.click();
    });
    expect(onToggleSpaceIsolation).toHaveBeenCalledWith("space-2", "default");

    const newIsolatedBtn = popover?.querySelector<HTMLButtonElement>(
      "[data-new-isolated-space]",
    );
    expect(newIsolatedBtn).not.toBeNull();
    act(() => {
      newIsolatedBtn?.click();
    });
    expect(onNewIsolatedSpace).toHaveBeenCalledTimes(1);
  });

  it("shows retained-profiles badge, Clear private accounts button, redacted cleanupError, and Retry actions", () => {
    const onClearPrivateAccounts = vi.fn();
    const onRetrySpaceCleanup = vi.fn();

    (useSpaces.getState().hydrate as (...args: unknown[]) => void)(
      [
        {
          id: "space-1",
          name: "Alpha",
          root: "/work/alpha",
          env: LOCAL_WORKSPACE,
          accountIsolation: "default",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "space-2",
          name: "Beta",
          root: "/work/beta",
          env: LOCAL_WORKSPACE,
          accountIsolation: "isolated",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      "space-1",
      undefined,
      {
        "space-1": {
          hasRetainedProfiles: true,
          cleanupError: "PermissionDenied: [path]",
        },
        "space-2": {
          hasRetainedProfiles: true,
        },
      },
      {
        "space-deleted": {
          hasRetainedProfiles: true,
          cleanupError: "ResourceBusy: [path]",
        },
      },
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const ExtraPropsSwitcher = SpaceSwitcher as unknown as React.ComponentType<
      React.ComponentProps<typeof SpaceSwitcher> & {
        onClearPrivateAccounts?: (spaceId: string) => void;
        onRetrySpaceCleanup?: (spaceId: string) => void;
      }
    >;

    act(() => {
      root?.render(
        <ExtraPropsSwitcher
          open
          onOpenChange={vi.fn()}
          tabs={[]}
          onNewSpace={vi.fn()}
          onDeleteSpace={vi.fn()}
          onNewTabInSpace={vi.fn()}
          onJumpTab={vi.fn()}
          onCloseTab={vi.fn()}
          onMoveTabToSpace={vi.fn()}
          onReorderTab={vi.fn()}
          onReorderSpaces={vi.fn()}
          onClearPrivateAccounts={onClearPrivateAccounts}
          onRetrySpaceCleanup={onRetrySpaceCleanup}
        />,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[title^="Spaces"]',
    );
    expect(
      trigger?.querySelector('[data-retained-profiles="space-1"]'),
    ).not.toBeNull();

    const popover = document.body.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    expect(popover).not.toBeNull();

    const alphaRow = popover?.querySelector<HTMLElement>(
      '[data-space-id="space-1"]',
    );
    expect(
      alphaRow?.querySelector('[data-retained-profiles="space-1"]'),
    ).not.toBeNull();

    const clearBtn = popover?.querySelector<HTMLButtonElement>(
      '[data-clear-private-accounts="space-1"]',
    );
    expect(clearBtn).not.toBeNull();
    act(() => {
      clearBtn?.click();
    });
    expect(onClearPrivateAccounts).toHaveBeenCalledWith("space-1");

    const errorEl = popover?.querySelector('[data-cleanup-error="space-1"]');
    expect(errorEl?.textContent).toContain("PermissionDenied: [path]");
    const retryBtn = popover?.querySelector<HTMLButtonElement>(
      '[data-cleanup-retry="space-1"]',
    );
    expect(retryBtn).not.toBeNull();
    act(() => {
      retryBtn?.click();
    });
    expect(onRetrySpaceCleanup).toHaveBeenCalledWith("space-1");

    const orphanRetry = popover?.querySelector<HTMLButtonElement>(
      '[data-cleanup-retry="space-deleted"]',
    );
    expect(
      popover?.querySelector('[data-cleanup-error="space-deleted"]')
        ?.textContent,
    ).toContain("ResourceBusy: [path]");
    act(() => {
      orphanRetry?.click();
    });
    expect(onRetrySpaceCleanup).toHaveBeenCalledWith("space-deleted");
  });
});

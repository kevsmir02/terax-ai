// @vitest-environment jsdom
import { SpaceIsolationDialogs } from "@/app/components/SpaceIsolationDialogs";
import { useSpaceIsolationGuards } from "@/app/hooks/useSpaceIsolationGuards";
import { useSpaces } from "@/modules/spaces";
import { useTabs } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal/lib/panes";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  livePtys: new Map<number, number>(),
  busyLeaves: new Set<number>(),
  cwds: new Map<number, string>(),
  disposeSession: vi.fn((leafId: number) => {
    mocks.livePtys.delete(leafId);
  }),
  setSpaceIsolation: vi.fn<
    (
      id: string,
      mode: "default" | "isolated",
    ) => Promise<{
      spaceId: string;
      accountIsolation: "default" | "isolated";
      profileReady: boolean;
      stale: boolean;
      activeRuntimeMode: "default" | "isolated" | null;
    }>
  >(async (id, mode) => ({
    spaceId: id,
    accountIsolation: mode,
    profileReady: mode === "isolated",
    stale: false,
    activeRuntimeMode: null,
  })),
}));

vi.mock("@/modules/terminal/lib/terminalSessionApi", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/modules/terminal/lib/terminalSessionApi")
    >();
  return {
    ...actual,
    disposeSession: mocks.disposeSession,
    leafCwd: (leafId: number) => mocks.cwds.get(leafId) ?? null,
    ptyIdForLeaf: (leafId: number) => mocks.livePtys.get(leafId) ?? null,
    leafHasForegroundProcess: async (leafId: number) =>
      mocks.busyLeaves.has(leafId),
  };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = async () => [];
    set = async () => {};
    delete = async () => {};
  },
}));

vi.mock("@/modules/spaces/lib/isolationSync", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/spaces/lib/isolationSync")>();
  return {
    ...actual,
    setSpaceIsolationMode: (id: string, mode: "default" | "isolated") =>
      mocks.setSpaceIsolation(id, mode),
  };
});

function Harness({
  onReady,
}: {
  onReady: (api: {
    getTabs: () => ReturnType<typeof useTabs>["tabs"];
    getActiveId: () => number;
    requestToggle: (id: string, mode: "default" | "isolated") => Promise<void>;
    requestMove: (tabId: number, targetSpaceId: string) => Promise<void>;
    requestReorder: (
      tabId: number,
      targetTabId: number,
      edge: "top" | "bottom",
    ) => Promise<void>;
    markDirty: (tabId: number, dirty: boolean) => void;
  }) => void;
}) {
  const spaces = useSpaces((s) => s.spaces);
  const {
    tabs,
    activeId,
    moveTabToSpace,
    reorderTab,
    restartSpaceTerminals,
    recreateTerminalInSpace,
    replaceTabs,
  } = useTabs();

  const [initialized, setInitialized] = useState(false);
  if (!initialized) {
    setInitialized(true);
    replaceTabs(
      [
        {
          id: 1,
          kind: "terminal",
          spaceId: "sp-default",
          title: "shell",
          cwd: "/work/terax",
          activeLeafId: 10,
          paneTree: { kind: "leaf", id: 10, cwd: "/work/terax" },
        },
        {
          id: 2,
          kind: "editor",
          spaceId: "sp-default",
          title: "App.tsx",
          path: "/work/terax/App.tsx",
          dirty: true,
          preview: false,
        },
        {
          id: 3,
          kind: "terminal",
          spaceId: "sp-iso-a",
          title: "client-a",
          cwd: "/work/client-a",
          activeLeafId: 20,
          paneTree: { kind: "leaf", id: 20, cwd: "/work/client-a" },
        },
        {
          id: 4,
          kind: "terminal",
          spaceId: "sp-default-2",
          title: "scratch",
          cwd: "/work/scratch",
          activeLeafId: 30,
          paneTree: { kind: "leaf", id: 30, cwd: "/work/scratch" },
        },
      ],
      1,
    );
  }

  const guards = useSpaceIsolationGuards({
    tabs,
    spaces,
    isTabDirty: (id) =>
      Boolean(tabs.find((t) => t.id === id && t.kind === "editor" && t.dirty)),
    saveTab: async (id) => {
      replaceTabs(
        tabs.map((t) =>
          t.id === id && t.kind === "editor" ? { ...t, dirty: false } : t,
        ),
        activeId,
      );
      return true;
    },
    applyIsolationMode: (spaceId, nextMode) =>
      useSpaces.getState().setAccountIsolation(spaceId, nextMode),
    restartSpaceTerminals: (spaceId) =>
      restartSpaceTerminals(
        spaceId,
        (leafId, fallback) => mocks.cwds.get(leafId) ?? fallback,
        (leafId) => mocks.livePtys.has(leafId),
      ),
    moveLive: (action) => {
      if (action.kind === "move") {
        if (moveTabToSpace(action.tabId, action.targetSpaceId)) {
          useSpaces.getState().setActive(action.targetSpaceId);
        }
        return;
      }
      if (reorderTab(action.tabId, action.targetTabId, action.edge)) {
        const target = tabs.find((t) => t.id === action.targetTabId);
        if (target) useSpaces.getState().setActive(target.spaceId);
      }
    },
    recreateInTarget: (action, targetSpaceId) => {
      const targetRoot =
        useSpaces.getState().spaces.find((s) => s.id === targetSpaceId)?.root ??
        undefined;
      const outcome = recreateTerminalInSpace(
        action.tabId,
        targetSpaceId,
        targetRoot,
        action.kind === "reorder"
          ? { targetTabId: action.targetTabId, edge: action.edge }
          : undefined,
      );
      if (outcome.shouldSwitchSpace) {
        useSpaces.getState().setActive(targetSpaceId);
      }
      return outcome.disposeLeafIds;
    },
  });

  onReady({
    getTabs: () => tabs,
    getActiveId: () => activeId,
    requestToggle: guards.requestSpaceIsolationToggle,
    requestMove: guards.requestMoveTabToSpace,
    requestReorder: guards.requestReorderTabAcrossSpaces,
    markDirty: (tabId, dirty) => {
      replaceTabs(
        tabs.map((t) =>
          t.id === tabId && t.kind === "editor" ? { ...t, dirty } : t,
        ),
        activeId,
      );
    },
  });

  return (
    <SpaceIsolationDialogs
      tabs={tabs}
      spaces={spaces}
      pendingIsolationToggle={guards.pendingIsolationToggle}
      isolationToggleBusy={guards.isolationToggleBusy}
      isolationToggleError={guards.isolationToggleError}
      isolationSaveIncomplete={guards.isolationSaveIncomplete}
      onConfirmIsolationToggle={() => void guards.confirmSpaceIsolationToggle()}
      onSaveAndToggleIsolation={() => void guards.saveAndToggleSpaceIsolation()}
      onCancelIsolationToggle={guards.cancelSpaceIsolationToggle}
      pendingCrossSpaceMove={guards.pendingCrossSpaceMove}
      crossSpaceMoveBusy={guards.crossSpaceMoveBusy}
      onConfirmCrossSpaceMove={() => void guards.confirmCrossSpaceMove()}
      onCancelCrossSpaceMove={guards.cancelCrossSpaceMove}
    />
  );
}

describe("useSpaceIsolationGuards & SpaceIsolationDialogs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    mocks.livePtys.clear();
    mocks.livePtys.set(10, 100);
    mocks.livePtys.set(20, 200);
    mocks.livePtys.set(30, 300);
    mocks.busyLeaves.clear();
    mocks.busyLeaves.add(10);
    mocks.cwds.clear();
    mocks.cwds.set(10, "/work/terax/packages/core");
    mocks.disposeSession.mockClear();
    mocks.setSpaceIsolation.mockReset();
    mocks.setSpaceIsolation.mockImplementation(async (id, mode) => ({
      spaceId: id,
      accountIsolation: mode,
      profileReady: mode === "isolated",
      stale: false,
      activeRuntimeMode: null,
    }));

    useSpaces.getState().hydrate(
      [
        {
          id: "sp-default",
          name: "Main",
          root: "/work/terax",
          env: LOCAL_WORKSPACE,
          accountIsolation: "default",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "sp-default-2",
          name: "Scratch",
          root: "/work/scratch",
          env: LOCAL_WORKSPACE,
          accountIsolation: "default",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: "sp-iso-a",
          name: "Client A",
          root: "/work/client-a",
          env: LOCAL_WORKSPACE,
          accountIsolation: "isolated",
          createdAt: 3,
          updatedAt: 3,
        },
        {
          id: "sp-iso-b",
          name: "Client B",
          root: "/work/client-b",
          env: LOCAL_WORKSPACE,
          accountIsolation: "isolated",
          createdAt: 4,
          updatedAt: 4,
        },
      ],
      "sp-default",
    );
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  it("guards active-Space isolation toggles through dialogs, preserves non-terminal tabs, restarts terminal Panes, and gates cross-context terminal moves", async () => {
    let api!: Parameters<typeof Harness>[0]["onReady"] extends (
      a: infer A,
    ) => void
      ? A
      : never;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<Harness onReady={(a) => (api = a)} />);
    });

    // Normal Space focus switches never mutate isolation or terminals.
    act(() => {
      useSpaces.getState().setActive("sp-iso-a");
    });
    expect(mocks.setSpaceIsolation).not.toHaveBeenCalled();
    expect(mocks.disposeSession).not.toHaveBeenCalled();

    // Non-terminal tab moves live between default and isolated Spaces without confirmation.
    await act(async () => {
      await api.requestMove(2, "sp-iso-a");
    });
    expect(
      document.body.querySelector("[data-cross-space-terminal-dialog]"),
    ).toBeNull();
    expect(api.getTabs().find((t) => t.id === 2)?.spaceId).toBe("sp-iso-a");

    // Move non-terminal tab back so sp-default has an unsaved editor before toggle test.
    await act(async () => {
      await api.requestMove(2, "sp-default");
    });
    expect(api.getTabs().find((t) => t.id === 2)?.spaceId).toBe("sp-default");

    // Request isolation toggle on sp-default (1 busy terminal + 1 dirty editor).
    await act(async () => {
      await api.requestToggle("sp-default", "isolated");
    });
    const toggleDialog = document.body.querySelector<HTMLElement>(
      "[data-space-isolation-dialog]",
    );
    expect(toggleDialog).not.toBeNull();
    expect(toggleDialog?.textContent).toContain("App.tsx");
    expect(toggleDialog?.textContent).toContain(
      "1 process may still be running",
    );

    // Cancel keeps prior isolation mode intact and does not dispose terminals.
    const cancelToggleBtn = Array.from(
      toggleDialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Cancel");
    act(() => {
      cancelToggleBtn?.click();
    });
    expect(
      document.body.querySelector("[data-space-isolation-dialog]"),
    ).toBeNull();
    expect(
      useSpaces.getState().spaces.find((s) => s.id === "sp-default")
        ?.accountIsolation,
    ).toBe("default");
    expect(mocks.disposeSession).not.toHaveBeenCalled();

    // Re-request toggle and simulate backend sync failure: leaves prior mode intact and shows error.
    await act(async () => {
      await api.requestToggle("sp-default", "isolated");
    });
    mocks.setSpaceIsolation.mockRejectedValueOnce(new Error("profile error"));
    const retryDialog = document.body.querySelector<HTMLElement>(
      "[data-space-isolation-dialog]",
    );
    const confirmToggleBtn = Array.from(
      retryDialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Restart Terminals & Switch");
    await act(async () => {
      confirmToggleBtn?.click();
    });
    expect(
      document.body.querySelector("[data-space-isolation-dialog]")?.textContent,
    ).toContain("profile error");
    expect(
      useSpaces.getState().spaces.find((s) => s.id === "sp-default")
        ?.accountIsolation,
    ).toBe("default");
    expect(mocks.disposeSession).not.toHaveBeenCalled();

    // Confirm toggle cleanly: updates Space mode, preserves editor tab intact, restarts terminal leaf with preserved cwd.
    const confirmToggleAgain = Array.from(
      document.body
        .querySelector("[data-space-isolation-dialog]")
        ?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Restart Terminals & Switch");
    await act(async () => {
      confirmToggleAgain?.click();
    });
    expect(
      document.body.querySelector("[data-space-isolation-dialog]"),
    ).toBeNull();
    expect(
      useSpaces.getState().spaces.find((s) => s.id === "sp-default")
        ?.accountIsolation,
    ).toBe("isolated");
    expect(mocks.disposeSession).toHaveBeenCalledWith(10);
    const editorAfter = api.getTabs().find((t) => t.id === 2);
    expect(editorAfter?.kind).toBe("editor");
    expect(editorAfter?.kind === "editor" && editorAfter.dirty).toBe(true);
    const termAfter = api.getTabs().find((t) => t.id === 1);
    expect(termAfter?.kind).toBe("terminal");
    if (termAfter?.kind === "terminal") {
      expect(leafIds(termAfter.paneTree)).not.toEqual([10]);
      expect(termAfter.cwd).toBe("/work/terax/packages/core");
    }

    // Cross-context terminal move (sp-default now isolated -> sp-default-2 default) prompts & recreates cleanly on confirm.
    await act(async () => {
      await api.requestMove(1, "sp-default-2");
    });
    const moveDialog = document.body.querySelector<HTMLElement>(
      "[data-cross-space-terminal-dialog]",
    );
    expect(moveDialog).not.toBeNull();
    const cancelMoveBtn = Array.from(
      moveDialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Cancel");
    act(() => {
      cancelMoveBtn?.click();
    });
    expect(api.getTabs().find((t) => t.id === 1)?.spaceId).toBe("sp-default");

    await act(async () => {
      await api.requestMove(1, "sp-default-2");
    });
    const confirmMoveBtn = Array.from(
      document.body
        .querySelector("[data-cross-space-terminal-dialog]")
        ?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Close & Recreate Terminal");
    await act(async () => {
      confirmMoveBtn?.click();
    });
    expect(
      document.body.querySelector("[data-cross-space-terminal-dialog]"),
    ).toBeNull();
    expect(api.getTabs().find((t) => t.id === 1)).toBeUndefined();
    const recreated = api
      .getTabs()
      .find((t) => t.spaceId === "sp-default-2" && t.id !== 4);
    expect(recreated?.kind).toBe("terminal");

    // Cross-Space terminal reorder (sp-iso-a -> before tab 4 in sp-default-2) also prompts and recreates cleanly.
    await act(async () => {
      await api.requestReorder(3, 4, "top");
    });
    const reorderDialog = document.body.querySelector<HTMLElement>(
      "[data-cross-space-terminal-dialog]",
    );
    expect(reorderDialog).not.toBeNull();
    const confirmReorderBtn = Array.from(
      reorderDialog?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Close & Recreate Terminal");
    await act(async () => {
      confirmReorderBtn?.click();
    });
    expect(mocks.disposeSession).toHaveBeenCalledWith(20);
    const tabsAfterReorder = api.getTabs();
    const recreatedIdx = tabsAfterReorder.findIndex(
      (t) =>
        t.spaceId === "sp-default-2" && t.id !== 4 && t.id !== recreated?.id,
    );
    const tab4Idx = tabsAfterReorder.findIndex((t) => t.id === 4);
    expect(recreatedIdx).toBeGreaterThanOrEqual(0);
    expect(recreatedIdx).toBeLessThan(tab4Idx);
  });

  it("saves dirty files cleanly via Save & Switch before switching isolation mode", async () => {
    let api!: Parameters<typeof Harness>[0]["onReady"] extends (
      a: infer A,
    ) => void
      ? A
      : never;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<Harness onReady={(a) => (api = a)} />);
    });

    await act(async () => {
      await api.requestToggle("sp-default", "isolated");
    });
    const saveBtn = Array.from(
      document.body
        .querySelector("[data-space-isolation-dialog]")
        ?.querySelectorAll("button") ?? [],
    ).find((b) => b.textContent === "Save & Switch");
    expect(saveBtn).toBeDefined();

    await act(async () => {
      saveBtn?.click();
    });
    expect(
      document.body.querySelector("[data-space-isolation-dialog]"),
    ).toBeNull();
    const editor = api.getTabs().find((t) => t.id === 2);
    expect(editor?.kind === "editor" && editor.dirty).toBe(false);
    expect(
      useSpaces.getState().spaces.find((s) => s.id === "sp-default")
        ?.accountIsolation,
    ).toBe("isolated");
  });
});

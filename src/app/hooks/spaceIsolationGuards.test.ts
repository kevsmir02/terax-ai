import { describe, expect, it, vi } from "vitest";
import type { SpaceMeta } from "@/modules/spaces";
import type { Tab, TerminalTab } from "@/modules/tabs";
import {
  CrossSpaceTabMoveGuard,
  crossSpaceTerminalMoveMessage,
  SpaceIsolationToggleGuard,
  spaceIsolationToggleMessage,
} from "./spaceIsolationGuards";

function makeSpace(
  id: string,
  name: string,
  accountIsolation: "default" | "isolated",
): SpaceMeta {
  return {
    id,
    name,
    root: `/work/${id}`,
    env: { kind: "local" },
    accountIsolation,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeTerminal(
  id: number,
  spaceId: string,
  leafIds: number[],
  cold = false,
): TerminalTab {
  return {
    id,
    kind: "terminal",
    spaceId,
    cold,
    title: `term-${id}`,
    cwd: `/work/${spaceId}`,
    activeLeafId: leafIds[0],
    paneTree:
      leafIds.length === 1
        ? { kind: "leaf", id: leafIds[0], cwd: `/work/${spaceId}` }
        : {
            kind: "split",
            id: id * 100,
            dir: "row",
            children: leafIds.map((lid) => ({
              kind: "leaf",
              id: lid,
              cwd: `/work/${spaceId}`,
            })),
          },
  };
}

function makeEditor(
  id: number,
  spaceId: string,
  title: string,
  dirty = false,
): Tab {
  return {
    id,
    kind: "editor",
    spaceId,
    title,
    path: `/work/${spaceId}/${title}`,
    dirty,
    preview: false,
  };
}

function makeDiff(id: number, spaceId: string): Tab {
  return {
    id,
    kind: "git-diff",
    spaceId,
    title: "App.tsx",
    path: `/work/${spaceId}/App.tsx`,
    repoRoot: `/work/${spaceId}`,
    mode: "+",
    originalPath: null,
    preview: false,
  };
}

describe("SpaceIsolationToggleGuard", () => {
  it("toggles immediately without confirmation when a Space has only non-terminal clean tabs or cold terminals", async () => {
    const tabs: Tab[] = [
      makeEditor(1, "sp-a", "clean.ts", false),
      makeDiff(2, "sp-a"),
      makeTerminal(3, "sp-a", [30], true),
    ];
    const applyMode = vi.fn(async () => {});
    const restartTerminals = vi.fn();

    const guard = new SpaceIsolationToggleGuard({
      tabs: () => tabs,
      isDirty: (id) =>
        Boolean(
          tabs.find((t) => t.id === id && t.kind === "editor" && t.dirty),
        ),
      hasLivePty: () => false,
      isBusy: async () => false,
      applyMode,
      restartTerminals,
    });

    const result = await guard.request("sp-a", "isolated");
    expect(result).toEqual({
      status: "toggled",
      spaceId: "sp-a",
      nextMode: "isolated",
    });
    expect(guard.current()).toBeNull();
    expect(applyMode).toHaveBeenCalledWith("sp-a", "isolated");
    expect(restartTerminals).not.toHaveBeenCalled();
  });

  it("evaluates dirty files and running processes before confirmation, and keeps prior state intact on cancel or error", async () => {
    let mode: "default" | "isolated" = "default";
    const tabs: Tab[] = [
      makeEditor(1, "sp-a", "notes.md", true),
      makeDiff(2, "sp-a"),
      makeTerminal(3, "sp-a", [31, 32], false),
    ];
    const applyMode = vi.fn<
      (id: string, next: "default" | "isolated") => Promise<void>
    >(async (_id, next) => {
      throw new Error(`ipc failed for ${next}`);
    });
    const restartTerminals = vi.fn();

    const guard = new SpaceIsolationToggleGuard({
      tabs: () => tabs,
      isDirty: (id) => id === 1,
      hasLivePty: (lid) => lid === 31 || lid === 32,
      isBusy: async (lid) => {
        if (lid === 32) throw new Error("probe unavailable");
        return lid === 31;
      },
      applyMode,
      restartTerminals,
    });

    const pendingResult = await guard.request("sp-a", "isolated");
    expect(pendingResult.status).toBe("needs-confirmation");
    expect(guard.current()?.hazards).toEqual({
      dirtyIds: [1],
      busyLeafIds: [31, 32],
    });
    expect(guard.current()?.activeLeafIds).toEqual([31, 32]);
    expect(applyMode).not.toHaveBeenCalled();
    expect(restartTerminals).not.toHaveBeenCalled();

    // Cancel keeps prior isolation mode intact without touching terminals.
    guard.cancel();
    expect(guard.current()).toBeNull();
    expect(mode).toBe("default");
    expect(restartTerminals).not.toHaveBeenCalled();

    // Re-request, then confirm when applyMode rejects: terminals must NOT restart and mode stays intact.
    await guard.request("sp-a", "isolated");
    const failed = await guard.confirm();
    expect(failed.status).toBe("failed");
    expect(mode).toBe("default");
    expect(restartTerminals).not.toHaveBeenCalled();

    // Confirm succeeds after fixing applyMode: restarts terminals after mode change completes.
    applyMode.mockImplementation(async (_id, next) => {
      mode = next;
    });
    const succeeded = await guard.confirm();
    expect(succeeded).toEqual({
      status: "toggled",
      spaceId: "sp-a",
      nextMode: "isolated",
    });
    expect(mode).toBe("isolated");
    expect(applyMode).toHaveBeenCalledTimes(2);
    expect(restartTerminals).toHaveBeenCalledWith("sp-a");
    expect(guard.current()).toBeNull();
  });

  it("re-prompts on confirm if a new busy process or unsaved buffer appears while waiting", async () => {
    let busy = false;
    let dirty = false;
    const tabs: Tab[] = [
      makeEditor(1, "sp-a", "index.ts", false),
      makeTerminal(2, "sp-a", [20], false),
    ];
    const applyMode = vi.fn(async () => {});
    const restartTerminals = vi.fn();

    const guard = new SpaceIsolationToggleGuard({
      tabs: () => tabs,
      isDirty: (id) => id === 1 && dirty,
      hasLivePty: () => true,
      isBusy: async () => busy,
      applyMode,
      restartTerminals,
    });

    await guard.request("sp-a", "isolated");
    expect(guard.current()?.hazards).toEqual({ dirtyIds: [], busyLeafIds: [] });

    busy = true;
    dirty = true;
    const recheck = await guard.confirm();
    expect(recheck.status).toBe("needs-confirmation");
    expect(guard.current()?.hazards).toEqual({
      dirtyIds: [1],
      busyLeafIds: [20],
    });
    expect(applyMode).not.toHaveBeenCalled();
    expect(restartTerminals).not.toHaveBeenCalled();

    const committed = await guard.confirm();
    expect(committed.status).toBe("toggled");
    expect(restartTerminals).toHaveBeenCalledWith("sp-a");
  });

  it("re-prompts when a previously saved buffer is edited again before confirm completes", async () => {
    let dirty = true;
    const tabs: Tab[] = [
      makeEditor(1, "sp-a", "index.ts", true),
      makeTerminal(2, "sp-a", [20], false),
    ];
    const applyMode = vi.fn(async () => {});
    const restartTerminals = vi.fn();

    const guard = new SpaceIsolationToggleGuard({
      tabs: () => tabs,
      isDirty: (id) => id === 1 && dirty,
      hasLivePty: () => true,
      isBusy: async () => false,
      applyMode,
      restartTerminals,
    });

    await guard.request("sp-a", "isolated");
    // Simulate save finished, then user immediately typed more making buffer dirty again.
    dirty = true;
    const recheck = await guard.confirm({ savedDirtyIds: [1] });
    expect(recheck.status).toBe("needs-confirmation");
    expect(applyMode).not.toHaveBeenCalled();
  });

  it("formats toggle message describing non-terminal preservation, terminal restart, dirty buffers, and running processes", () => {
    const tabs: Tab[] = [
      makeEditor(1, "sp-a", "main.rs", true),
      makeTerminal(2, "sp-a", [20, 21], false),
    ];
    const message = spaceIsolationToggleMessage(
      {
        spaceId: "sp-a",
        nextMode: "isolated",
        activeLeafIds: [20, 21],
        hazards: { dirtyIds: [1], busyLeafIds: [20] },
      },
      tabs,
      "Client A",
    );
    expect(message).toContain("Client A");
    expect(message).toContain("isolated");
    expect(message).toContain("Non-terminal tabs");
    expect(message).toContain("main.rs");
    expect(message).toContain("1 process may still be running");
  });
});

describe("CrossSpaceTabMoveGuard", () => {
  const spaces = [
    makeSpace("sp-def-1", "Main", "default"),
    makeSpace("sp-def-2", "Scratch", "default"),
    makeSpace("sp-iso-1", "Client A", "isolated"),
    makeSpace("sp-iso-2", "Client B", "isolated"),
  ];

  it("moves non-terminal tabs live across all isolation pairs and terminal tabs live between default Spaces", async () => {
    const tabs: Tab[] = [
      makeEditor(1, "sp-def-1", "app.ts"),
      makeDiff(2, "sp-iso-1"),
      makeTerminal(3, "sp-def-1", [30], false),
    ];
    const moveLive = vi.fn();
    const recreateInTarget = vi.fn();

    const guard = new CrossSpaceTabMoveGuard({
      tabs: () => tabs,
      spaces: () => spaces,
      hasLivePty: () => true,
      isBusy: async () => true,
      moveLive,
      recreateInTarget,
    });

    expect(
      await guard.request({
        kind: "move",
        tabId: 1,
        targetSpaceId: "sp-iso-1",
      }),
    ).toEqual({ status: "moved" });
    expect(
      await guard.request({
        kind: "move",
        tabId: 2,
        targetSpaceId: "sp-iso-2",
      }),
    ).toEqual({ status: "moved" });
    expect(
      await guard.request({
        kind: "move",
        tabId: 3,
        targetSpaceId: "sp-def-2",
      }),
    ).toEqual({ status: "moved" });

    expect(moveLive).toHaveBeenCalledTimes(3);
    expect(recreateInTarget).not.toHaveBeenCalled();
    expect(guard.current()).toBeNull();
  });

  it("intercepts cross-context terminal moves and reorders with guarded close-and-recreate", async () => {
    const tabs: Tab[] = [
      makeTerminal(10, "sp-def-1", [100], false),
      makeTerminal(11, "sp-iso-1", [110], false),
      makeTerminal(12, "sp-iso-2", [120], false),
    ];
    const moveLive = vi.fn();
    const recreateInTarget = vi.fn();

    const guard = new CrossSpaceTabMoveGuard({
      tabs: () => tabs,
      spaces: () => spaces,
      hasLivePty: () => true,
      isBusy: async (lid) => lid === 100,
      moveLive,
      recreateInTarget,
    });

    // default -> isolated (busy process)
    const pending = await guard.request({
      kind: "move",
      tabId: 10,
      targetSpaceId: "sp-iso-1",
    });
    expect(pending.status).toBe("needs-confirmation");
    expect(guard.current()?.hazards.busyLeafIds).toEqual([100]);
    expect(moveLive).not.toHaveBeenCalled();
    expect(recreateInTarget).not.toHaveBeenCalled();

    // Cancel keeps source tab in source Space unchanged.
    guard.cancel();
    expect(guard.current()).toBeNull();
    expect(recreateInTarget).not.toHaveBeenCalled();

    // isolated A -> isolated B via reorder onto target tab 12
    const crossIsoReorder = await guard.request({
      kind: "reorder",
      tabId: 11,
      targetTabId: 12,
      edge: "bottom",
    });
    expect(crossIsoReorder.status).toBe("needs-confirmation");
    expect(guard.current()?.targetSpaceId).toBe("sp-iso-2");

    const confirmed = await guard.confirm();
    expect(confirmed).toEqual({
      status: "recreated",
      action: { kind: "reorder", tabId: 11, targetTabId: 12, edge: "bottom" },
      targetSpaceId: "sp-iso-2",
    });
    expect(recreateInTarget).toHaveBeenCalledWith(
      { kind: "reorder", tabId: 11, targetTabId: 12, edge: "bottom" },
      "sp-iso-2",
    );
    expect(guard.current()).toBeNull();
  });

  it("formats clear close-and-recreate prompt copy with running process hazards", () => {
    const message = crossSpaceTerminalMoveMessage(
      {
        action: { kind: "move", tabId: 10, targetSpaceId: "sp-iso-1" },
        sourceSpaceId: "sp-def-1",
        targetSpaceId: "sp-iso-1",
        sourceIsolation: "default",
        targetIsolation: "isolated",
        hazards: { dirtyIds: [], busyLeafIds: [100, 101], leafIds: [100, 101] },
      },
      "Main",
      "Client A",
    );
    expect(message).toContain("Main");
    expect(message).toContain("Client A");
    expect(message).toContain("2 processes may still be running");
    expect(message).toContain("fresh terminal");
  });
});

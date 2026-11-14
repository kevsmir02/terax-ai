import { describe, expect, it } from "vitest";
import {
  planSpaceTerminalRestart,
  planTerminalRecreateInSpace,
  type Tab,
  type TerminalTab,
} from "./useTabs";

function makeAlloc(start = 100) {
  let next = start;
  return () => next++;
}

describe("planSpaceTerminalRestart", () => {
  it("preserves non-terminal tabs and cold terminals while restarting active panes with fresh leaf ids", () => {
    const editorTab: Tab = {
      id: 1,
      kind: "editor",
      spaceId: "sp-a",
      title: "App.tsx",
      path: "/work/a/App.tsx",
      dirty: true,
      preview: false,
    };
    const diffTab: Tab = {
      id: 2,
      kind: "git-diff",
      spaceId: "sp-a",
      title: "App.tsx",
      path: "/work/a/App.tsx",
      repoRoot: "/work/a",
      mode: "+",
      originalPath: null,
      preview: false,
    };
    const previewTab: Tab = {
      id: 3,
      kind: "preview",
      spaceId: "sp-a",
      title: "Local",
      url: "http://localhost:3000",
    };
    const warmSplitTab: TerminalTab = {
      id: 4,
      kind: "terminal",
      spaceId: "sp-a",
      title: "shell",
      customTitle: "Agent",
      cwd: "/work/a",
      blocks: true,
      activeLeafId: 12,
      paneTree: {
        kind: "split",
        id: 20,
        dir: "row",
        children: [
          { kind: "leaf", id: 11, slotId: 1, cwd: "/work/a/api" },
          { kind: "leaf", id: 12, slotId: 2, cwd: "/work/a/web" },
        ],
      },
    };
    const liveColdTab: TerminalTab = {
      id: 5,
      kind: "terminal",
      spaceId: "sp-a",
      cold: true,
      title: "cold-live",
      cwd: "/work/a",
      activeLeafId: 13,
      paneTree: { kind: "leaf", id: 13, cwd: "/work/a" },
    };
    const sleepingColdTab: TerminalTab = {
      id: 6,
      kind: "terminal",
      spaceId: "sp-a",
      cold: true,
      title: "cold-idle",
      cwd: "/work/a",
      activeLeafId: 14,
      paneTree: { kind: "leaf", id: 14, cwd: "/work/a" },
    };
    const otherSpaceTab: TerminalTab = {
      id: 7,
      kind: "terminal",
      spaceId: "sp-b",
      title: "other",
      cwd: "/work/b",
      activeLeafId: 15,
      paneTree: { kind: "leaf", id: 15, cwd: "/work/b" },
    };

    const tabs: Tab[] = [
      editorTab,
      diffTab,
      previewTab,
      warmSplitTab,
      liveColdTab,
      sleepingColdTab,
      otherSpaceTab,
    ];

    const plan = planSpaceTerminalRestart(
      tabs,
      "sp-a",
      (leafId, fallback) => (leafId === 11 ? "/work/a/api/src" : fallback),
      (leafId) => leafId === 13,
      makeAlloc(100),
    );

    expect(plan.disposeLeafIds).toEqual([11, 12, 13]);
    expect(plan.restartedTabIds).toEqual([4, 5]);
    expect(plan.tabs[0]).toBe(editorTab);
    expect(plan.tabs[1]).toBe(diffTab);
    expect(plan.tabs[2]).toBe(previewTab);
    expect(plan.tabs[5]).toBe(sleepingColdTab);
    expect(plan.tabs[6]).toBe(otherSpaceTab);

    const restarted = plan.tabs[3] as TerminalTab;
    expect(restarted.id).toBe(4);
    expect(restarted.customTitle).toBe("Agent");
    expect(restarted.blocks).toBe(true);
    expect(restarted.cold).toBe(false);
    expect(restarted.paneTree).toEqual({
      kind: "split",
      id: 100,
      dir: "row",
      children: [
        { kind: "leaf", id: 101, cwd: "/work/a/api/src" },
        { kind: "leaf", id: 102, cwd: "/work/a/web" },
      ],
    });
    expect(restarted.activeLeafId).toBe(102);

    const restartedColdLive = plan.tabs[4] as TerminalTab;
    expect(restartedColdLive.id).toBe(5);
    expect(restartedColdLive.cold).toBe(false);
    expect(restartedColdLive.paneTree).toEqual({
      kind: "leaf",
      id: 103,
      cwd: "/work/a",
    });
    expect(restartedColdLive.activeLeafId).toBe(103);
  });
});

describe("planTerminalRecreateInSpace", () => {
  it("closes the source terminal leaves, creates a fresh terminal in the target Space, and tracks focus", () => {
    const sourceTab: TerminalTab = {
      id: 10,
      kind: "terminal",
      spaceId: "sp-a",
      title: "api",
      customTitle: "Server",
      cwd: "/work/a",
      blocks: true,
      activeLeafId: 22,
      paneTree: {
        kind: "split",
        id: 20,
        dir: "col",
        children: [
          { kind: "leaf", id: 21, cwd: "/work/a" },
          { kind: "leaf", id: 22, cwd: "/work/a/sub" },
        ],
      },
    };
    const otherSourceTab: Tab = {
      id: 11,
      kind: "editor",
      spaceId: "sp-a",
      title: "README.md",
      path: "/work/a/README.md",
      dirty: false,
      preview: false,
    };
    const targetTab: TerminalTab = {
      id: 12,
      kind: "terminal",
      spaceId: "sp-b",
      title: "client",
      cwd: "/work/b",
      activeLeafId: 23,
      paneTree: { kind: "leaf", id: 23, cwd: "/work/b" },
    };

    // Moving the active terminal when source still has another tab falls back to that tab.
    const movedWithFallback = planTerminalRecreateInSpace(
      [sourceTab, otherSourceTab, targetTab],
      10,
      10,
      "sp-b",
      "/work/b",
      makeAlloc(200),
    );
    expect(movedWithFallback).not.toBeNull();
    expect(movedWithFallback?.disposeLeafIds).toEqual([21, 22]);
    expect(movedWithFallback?.closedTabId).toBe(10);
    expect(movedWithFallback?.createdTabId).toBe(200);
    expect(movedWithFallback?.activeId).toBe(11);
    expect(movedWithFallback?.shouldSwitchSpace).toBe(false);
    expect(movedWithFallback?.tabs.map((t) => t.id)).toEqual([11, 12, 200]);

    const created = movedWithFallback?.tabs[2] as TerminalTab;
    expect(created.spaceId).toBe("sp-b");
    expect(created.cwd).toBe("/work/b");
    expect(created.blocks).toBe(true);
    expect(created.paneTree).toEqual({
      kind: "leaf",
      id: 201,
      cwd: "/work/b",
    });
    expect(created.activeLeafId).toBe(201);
    expect(created.cold).toBe(false);

    // Reordering onto top edge of targetTab places recreated tab right before targetTab,
    // and emptying source Space makes the recreated tab active & switches Space.
    const emptiedAndReordered = planTerminalRecreateInSpace(
      [sourceTab, targetTab],
      10,
      10,
      "sp-b",
      undefined,
      makeAlloc(300),
      { targetTabId: 12, edge: "top" },
    );
    expect(emptiedAndReordered?.tabs.map((t) => t.id)).toEqual([300, 12]);
    expect(emptiedAndReordered?.activeId).toBe(300);
    expect(emptiedAndReordered?.shouldSwitchSpace).toBe(true);
    const createdFallbackCwd = emptiedAndReordered?.tabs[0] as TerminalTab;
    expect(createdFallbackCwd.cwd).toBe("/work/a/sub");
    expect(createdFallbackCwd.cold).toBe(false);
  });
});

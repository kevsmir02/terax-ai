import { describe, expect, it } from "vitest";
import { collectHandoffWork, type HandoffWorkSources } from "./handoffWork";
import type { PaneNode } from "@/modules/terminal/lib/panes";

const editorTab = (id: number, title: string) => ({
  kind: "editor" as const,
  id,
  spaceId: "space-a",
  title,
});

const terminalTab = (id: number, leaves: number[]) => ({
  kind: "terminal" as const,
  id,
  spaceId: "space-a",
  paneTree:
    leaves.length === 1
      ? ({ kind: "leaf", id: leaves[0] } as PaneNode)
      : ({
          kind: "split",
          id: 900,
          dir: "row",
          children: leaves.map((leafId) => ({
            kind: "leaf" as const,
            id: leafId,
          })),
        } as PaneNode),
});

function sources(
  overrides: Partial<HandoffWorkSources> = {},
): HandoffWorkSources {
  return {
    tabs: [],
    isTabDirty: () => false,
    probeProcess: async () => false,
    ptyIdForLeaf: (leafId) => leafId + 100,
    agentPhase: () => undefined,
    agentName: () => undefined,
    ...overrides,
  };
}

describe("handoff work collection", () => {
  it("reports a dirty buffer from the live editor handle, not the tab's flag", async () => {
    const work = await collectHandoffWork(
      sources({
        tabs: [editorTab(7, "src/app.ts")],
        // The tab's published flag is behind the editor's live text.
        isTabDirty: (id) => id === 7,
      }),
    );

    expect(work.buffers).toEqual([
      { spaceId: "space-a", tabId: 7, title: "src/app.ts" },
    ]);
    expect(work.processes).toEqual([]);
    expect(work.agents).toEqual([]);
  });

  it("reports an attached process and treats a failed probe as running", async () => {
    const work = await collectHandoffWork(
      sources({
        tabs: [terminalTab(9, [41, 42, 43])],
        probeProcess: async (leafId) => {
          if (leafId === 42) throw new Error("terminal did not answer");
          return leafId === 41;
        },
      }),
    );

    expect(work.processes).toEqual([
      { spaceId: "space-a", leafId: 41, state: "running" },
      // A probe that could not answer is not evidence the pane is idle.
      { spaceId: "space-a", leafId: 42, state: "uncertain" },
    ]);
  });

  it("reports a working agent by name and ignores a finished turn", async () => {
    const work = await collectHandoffWork(
      sources({
        tabs: [terminalTab(9, [41, 42])],
        agentPhase: (ptyId) =>
          ptyId === 141 ? "working" : ptyId === 142 ? "finished" : undefined,
        agentName: (ptyId) => (ptyId === 141 ? "Claude Code" : undefined),
      }),
    );

    expect(work.agents).toEqual([
      {
        spaceId: "space-a",
        tabId: 9,
        leafId: 41,
        agent: "Claude Code",
        state: "working",
      },
    ]);
  });

  it("collects nothing while the window is idle", async () => {
    const work = await collectHandoffWork(
      sources({ tabs: [editorTab(7, "a.ts"), terminalTab(9, [41])] }),
    );
    expect(work).toEqual({ buffers: [], processes: [], agents: [] });
  });
});

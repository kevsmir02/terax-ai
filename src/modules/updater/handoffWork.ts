import type { AgentPhase } from "@/modules/terminal/lib/agentActivity";
import { leafIds, type PaneNode } from "@/modules/terminal/lib/panes";
import type { DirtyBuffer, ProcessHazard } from "@/modules/shutdown";
import type { HandoffWork, RunningAgent } from "./handoffReadiness";

/**
 * The live evidence the handoff readiness check reads, gathered at the moment the
 * person approves the handoff.
 *
 * Nothing here is cached: the editor handle answers for the buffer's current text
 * (a tab's `dirty` flag lags behind it), the terminal is asked whether a process is
 * attached, and the agent phase comes from the terminal's own activity evidence.
 * A probe that throws is reported as `uncertain`, never as idle.
 */
export type HandoffTabLike = {
  kind: string;
  id: number;
  spaceId: string;
  title?: string;
  paneTree?: PaneNode;
};

export type HandoffWorkSources = {
  tabs: readonly HandoffTabLike[];
  /** The editor handle's live answer for that buffer. */
  isTabDirty: (tabId: number) => boolean;
  /** True only when the terminal reports a process attached to the leaf. */
  probeProcess: (leafId: number) => Promise<boolean>;
  /** The leaf's PTY, needed to look up its agent phase. */
  ptyIdForLeaf: (leafId: number) => number | null;
  agentPhase: (ptyId: number) => AgentPhase | undefined;
  agentName: (ptyId: number) => string | undefined;
};

export async function collectHandoffWork(
  sources: HandoffWorkSources,
): Promise<HandoffWork> {
  const buffers: DirtyBuffer[] = [];
  const leaves: { leafId: number; tabId: number; spaceId: string }[] = [];

  for (const tab of sources.tabs) {
    if (tab.kind === "editor") {
      if (!sources.isTabDirty(tab.id)) continue;
      buffers.push({
        spaceId: tab.spaceId,
        tabId: tab.id,
        title: tab.title ?? "an untitled buffer",
      });
      continue;
    }
    if (tab.kind !== "terminal" || !tab.paneTree) continue;
    for (const leafId of leafIds(tab.paneTree)) {
      leaves.push({ leafId, tabId: tab.id, spaceId: tab.spaceId });
    }
  }

  const processes = (
    await Promise.all(
      leaves.map(async (leaf): Promise<ProcessHazard | null> => {
        try {
          const busy = await sources.probeProcess(leaf.leafId);
          return busy
            ? {
                spaceId: leaf.spaceId,
                leafId: leaf.leafId,
                state: "running",
              }
            : null;
        } catch {
          // A probe that failed is not evidence the pane is idle.
          return {
            spaceId: leaf.spaceId,
            leafId: leaf.leafId,
            state: "uncertain",
          };
        }
      }),
    )
  ).filter((hazard): hazard is ProcessHazard => hazard !== null);

  const agents: RunningAgent[] = [];
  for (const leaf of leaves) {
    const ptyId = sources.ptyIdForLeaf(leaf.leafId);
    if (ptyId === null) continue;
    const phase = sources.agentPhase(ptyId);
    // `finished` is the end of a turn and `idle` an acknowledged one: neither is an
    // agent still working, and the process probe already covers a live process.
    if (phase !== "working" && phase !== "attention") continue;
    agents.push({
      spaceId: leaf.spaceId,
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      agent: sources.agentName(ptyId) ?? null,
      state: phase,
    });
  }

  return { buffers, processes, agents };
}

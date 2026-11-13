import type {
  DirtyBuffer,
  ProcessHazard,
  ProcessState,
} from "@/modules/shutdown";

/**
 * Is anything at stake right now, immediately before the package-tool handoff?
 *
 * The handoff is the only supported upgrade path (see
 * `docs/architecture/update-handoff.md`), and it replaces the application on disk
 * while the person still has the old one open. So the check is the same question
 * the quit gate asks, asked at a different moment: unsaved editor buffers, any
 * process the terminals started, and any agent that is still working.
 *
 * Two rules are deliberate:
 *
 * - **The snapshot is the approval.** An approval is only valid for the work it
 *   was taken against. Work that appears afterwards — a buffer that went dirty, a
 *   process, an agent — invalidates it and the person has to approve again.
 * - **Nothing is resolved here.** The app never saves, closes, stops or interrupts
 *   anything to get past this check; the person decides what to finish.
 */

/** An agent whose turn has not ended: `finished`/`idle` phases are not hazards. */
export type RunningAgent = {
  spaceId: string;
  tabId: number;
  leafId: number;
  /** The agent's name from the terminal's activity evidence, when it is known. */
  agent: string | null;
  state: "working" | "attention";
};

/** The live evidence the check reads, gathered at the moment of the handoff. */
export type HandoffWork = {
  buffers: readonly DirtyBuffer[];
  processes: readonly ProcessHazard[];
  agents: readonly RunningAgent[];
};

export type HandoffHazard =
  | { kind: "buffer"; tabId: number; spaceId: string; title: string }
  | { kind: "process"; leafId: number; spaceId: string; state: ProcessState }
  | {
      kind: "agent";
      tabId: number;
      leafId: number;
      spaceId: string;
      agent: string | null;
    };

/** The identities a check saw, per kind. Never a count: a swap is still a change. */
export type HandoffSnapshot = {
  buffers: number[];
  processes: number[];
  agents: number[];
};

/** A person's approval, bound to the snapshot it was taken against. */
export type HandoffApproval = {
  at: number;
  snapshot: HandoffSnapshot;
};

export type HandoffAssessment =
  | { status: "clear"; snapshot: HandoffSnapshot; summary: string }
  | {
      status: "blocked";
      snapshot: HandoffSnapshot;
      hazards: HandoffHazard[];
      summary: string;
    };

export type HandoffDecision =
  | { kind: "handoff"; approvedAt: number }
  | {
      kind: "blocked";
      approvedAt: number;
      hazards: HandoffHazard[];
      /** True when at least one hazard was not in the approved snapshot. */
      startedAfterApproval: boolean;
      summary: string;
    };

export function handoffSnapshot(work: HandoffWork): HandoffSnapshot {
  return {
    buffers: work.buffers.map((buffer) => buffer.tabId),
    processes: work.processes.map((process) => process.leafId),
    agents: work.agents.map((agent) => agent.leafId),
  };
}

function hazardsOf(work: HandoffWork): HandoffHazard[] {
  const hazards: HandoffHazard[] = [];
  for (const buffer of work.buffers) {
    hazards.push({
      kind: "buffer",
      tabId: buffer.tabId,
      spaceId: buffer.spaceId,
      title: buffer.title,
    });
  }
  for (const process of work.processes) {
    hazards.push({
      kind: "process",
      leafId: process.leafId,
      spaceId: process.spaceId,
      state: process.state,
    });
  }
  for (const agent of work.agents) {
    hazards.push({
      kind: "agent",
      tabId: agent.tabId,
      leafId: agent.leafId,
      spaceId: agent.spaceId,
      agent: agent.agent,
    });
  }
  return hazards;
}

export function assessHandoffReadiness(work: HandoffWork): HandoffAssessment {
  const snapshot = handoffSnapshot(work);
  const hazards = hazardsOf(work);
  if (hazards.length === 0) {
    return {
      status: "clear",
      snapshot,
      summary:
        "Nothing is at stake: no unsaved buffers, no running process and no working agent.",
    };
  }
  return {
    status: "blocked",
    snapshot,
    hazards,
    summary: describeHandoffBlock(hazards),
  };
}

/**
 * The approval only covers the snapshot it was taken against. A hazard that was
 * not in that snapshot is new work and invalidates the approval; a hazard that
 * vanished changes nothing, because nothing extra is at stake.
 */
function startedAfterApproval(
  approval: HandoffApproval,
  hazards: readonly HandoffHazard[],
): boolean {
  const buffers = new Set(approval.snapshot.buffers);
  const processes = new Set(approval.snapshot.processes);
  const agents = new Set(approval.snapshot.agents);
  return hazards.some((hazard) =>
    hazard.kind === "buffer"
      ? !buffers.has(hazard.tabId)
      : hazard.kind === "process"
        ? !processes.has(hazard.leafId)
        : !agents.has(hazard.leafId),
  );
}

/**
 * The pure handoff decision: the approval, plus the live evidence re-read right
 * before the handoff. Blocked work is never resolved by the app.
 */
export function decideHandoff(
  approval: HandoffApproval,
  work: HandoffWork,
): HandoffDecision {
  const assessment = assessHandoffReadiness(work);
  if (assessment.status === "clear") {
    return { kind: "handoff", approvedAt: approval.at };
  }
  const stale = startedAfterApproval(approval, assessment.hazards);
  return {
    kind: "blocked",
    approvedAt: approval.at,
    hazards: assessment.hazards,
    startedAfterApproval: stale,
    summary: stale
      ? `${assessment.summary} This work appeared after you approved the handoff, so that approval no longer applies: resolve it, then approve the handoff again.`
      : `${assessment.summary} Resolve it, then approve the handoff again.`,
  };
}

/**
 * The two reads an approval is worth: the snapshot it is bound to, then the live
 * evidence immediately before the handoff. They are separate reads on purpose —
 * work that starts in between makes the approval stale, and the recheck is the
 * only thing that can see it.
 */
export async function checkHandoff(
  readWork: () => Promise<HandoffWork>,
  now: () => number = Date.now,
): Promise<{
  approval: HandoffApproval;
  work: HandoffWork;
  decision: HandoffDecision;
}> {
  const approval: HandoffApproval = {
    at: now(),
    snapshot: handoffSnapshot(await readWork()),
  };
  const work = await readWork();
  return { approval, work, decision: decideHandoff(approval, work) };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function join(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The blocked sentence: what is in the way, named, and what the app will not do. */
export function describeHandoffBlock(
  hazards: readonly HandoffHazard[],
): string {
  const buffers = hazards.filter((hazard) => hazard.kind === "buffer");
  const processes = hazards.filter((hazard) => hazard.kind === "process");
  const agents = hazards.filter((hazard) => hazard.kind === "agent");
  const parts: string[] = [];

  if (buffers.length > 0) {
    parts.push(
      `${buffers.length} ${plural(buffers.length, "file", "files")} with unsaved changes (${join(buffers.map((buffer) => buffer.title))})`,
    );
  }
  const running = processes.filter(
    (process) => process.state === "running",
  ).length;
  if (running > 0) {
    parts.push(`${running} running ${plural(running, "process", "processes")}`);
  }
  const uncertain = processes.length - running;
  if (uncertain > 0) {
    parts.push(
      `${uncertain} ${plural(uncertain, "process", "processes")} that could not be checked (the terminal did not report its state, so treat ${plural(uncertain, "it", "them")} as running)`,
    );
  }
  if (agents.length > 0) {
    const names = agents.map((agent) => agent.agent ?? "an agent");
    parts.push(
      `${agents.length} ${plural(agents.length, "agent", "agents")} still working (${join(names)})`,
    );
  }

  return `Terax did not hand off: ${join(parts)}. Terax does not save, close, stop or interrupt any of it; what to finish or close stays your decision.`;
}

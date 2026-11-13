import { describe, expect, it } from "vitest";
import {
  type HandoffApproval,
  type HandoffWork,
  assessHandoffReadiness,
  checkHandoff,
  decideHandoff,
  describeHandoffBlock,
  handoffSnapshot,
} from "./handoffReadiness";

const nothingHappening: HandoffWork = {
  buffers: [],
  processes: [],
  agents: [],
};

const clean = (at: number): HandoffApproval => ({
  at,
  snapshot: handoffSnapshot(nothingHappening),
});

const dirtyBuffer = {
  spaceId: "space-a",
  tabId: 7,
  title: "src/app.ts",
};

const runningProcess = {
  spaceId: "space-a",
  leafId: 41,
  state: "running" as const,
};

const workingAgent = {
  spaceId: "space-a",
  tabId: 9,
  leafId: 42,
  agent: "Claude Code",
  state: "working" as const,
};

describe("approval and recheck", () => {
  it("re-reads the evidence so work that starts after the approval blocks the handoff", async () => {
    const reads: HandoffWork[] = [
      nothingHappening,
      { ...nothingHappening, buffers: [dirtyBuffer] },
    ];
    let calls = 0;
    const checked = await checkHandoff(
      async () => reads[Math.min(calls++, reads.length - 1)],
      () => 100,
    );

    // The approval only covers the clean snapshot it was taken against...
    expect(checked.approval).toEqual({
      at: 100,
      snapshot: { buffers: [], processes: [], agents: [] },
    });
    // ...so the second read (one per approval per side of the handoff) wins.
    expect(calls).toBe(2);
    expect(checked.decision.kind).toBe("blocked");
    if (checked.decision.kind !== "blocked") return;
    expect(checked.decision.startedAfterApproval).toBe(true);
    expect(checked.work.buffers).toHaveLength(1);
  });

  it("hands off after the recheck when nothing appeared", async () => {
    const checked = await checkHandoff(
      async () => nothingHappening,
      () => 100,
    );
    expect(checked.decision.kind).toBe("handoff");
  });
});

describe("handoff readiness", () => {
  it("hands off when no unsaved work, process or agent is running", () => {
    const assessment = assessHandoffReadiness(nothingHappening);
    expect(assessment.status).toBe("clear");

    const decision = decideHandoff(clean(100), nothingHappening);
    expect(decision.kind).toBe("handoff");
    if (decision.kind !== "handoff") return;
    expect(decision.approvedAt).toBe(100);
  });

  it("blocks the handoff while an editor buffer has unsaved changes and names it", () => {
    const assessment = assessHandoffReadiness({
      ...nothingHappening,
      buffers: [dirtyBuffer],
    });
    expect(assessment.status).toBe("blocked");
    if (assessment.status !== "blocked") return;
    expect(assessment.hazards).toEqual([
      {
        kind: "buffer",
        tabId: 7,
        spaceId: "space-a",
        title: "src/app.ts",
      },
    ]);

    const decision = decideHandoff(clean(100), {
      ...nothingHappening,
      buffers: [dirtyBuffer],
    });
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.summary).toContain("src/app.ts");
    expect(decision.summary).toContain("unsaved changes");
  });

  it("blocks while an agent is working and never offers to interrupt it", () => {
    const decision = decideHandoff(clean(100), {
      ...nothingHappening,
      agents: [workingAgent],
      processes: [runningProcess],
    });
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.hazards.map((hazard) => hazard.kind)).toEqual([
      "process",
      "agent",
    ]);
    // The person decides: nothing here stops, closes or interrupts the agent.
    expect(decision.summary).toMatch(/does not (save|close|stop|interrupt)/i);
    expect(decision.summary).not.toMatch(/will close|will stop|terminating/i);
  });

  it("blocks when a process probe could not answer, as if it were running", () => {
    const assessment = assessHandoffReadiness({
      ...nothingHappening,
      processes: [{ spaceId: "space-a", leafId: 41, state: "uncertain" }],
    });
    expect(assessment.status).toBe("blocked");
    if (assessment.status !== "blocked") return;
    expect(assessment.summary).toMatch(/could not be checked/i);
  });

  it("invalidates an approval when work appears after it was taken", () => {
    const decision = decideHandoff(clean(100), {
      ...nothingHappening,
      buffers: [dirtyBuffer],
    });
    expect(decision.kind).toBe("blocked");
    if (decision.kind !== "blocked") return;
    expect(decision.startedAfterApproval).toBe(true);
    expect(decision.summary).toMatch(
      /started after you approved|after you approved/i,
    );
  });

  it("does not invalidate an approval when work vanished after it was taken", () => {
    // The person approved while a terminal was busy; the process has since exited
    // and the buffer was saved. Nothing new appeared, so the approval still holds.
    const approved: HandoffApproval = {
      at: 100,
      snapshot: { buffers: [7], processes: [41], agents: [42] },
    };
    const decision = decideHandoff(approved, nothingHappening);
    expect(decision.kind).toBe("handoff");
    if (decision.kind !== "handoff") return;
    expect(decision.approvedAt).toBe(100);
  });

  it("names every hazard group in the blocked copy", () => {
    const summary = describeHandoffBlock([
      { kind: "buffer", tabId: 7, spaceId: "space-a", title: "src/app.ts" },
      { kind: "buffer", tabId: 8, spaceId: "space-a", title: "src/other.ts" },
      { kind: "process", leafId: 41, spaceId: "space-a", state: "running" },
      { kind: "agent", ...workingAgent },
    ]);
    expect(summary).toContain("2 files with unsaved changes");
    expect(summary).toContain("src/app.ts");
    expect(summary).toContain("1 running process");
    expect(summary).toContain("Claude Code");
  });
});

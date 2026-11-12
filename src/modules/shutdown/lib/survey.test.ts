import { describe, expect, it } from "vitest";
import {
  canOptOutOfQuitPrompt,
  type DirtyBuffer,
  type DraftHazard,
  describeQuit,
  hasNewQuitHazards,
  type ProcessHazard,
  quitHazardIds,
  quitNeedsResolution,
  surveyQuit,
} from "./survey";

const spaces = [
  { id: "sp-work", name: "Work" },
  { id: "sp-notes", name: "Notes" },
];

const buffer = (
  spaceId: string,
  tabId: number,
  title: string,
): DirtyBuffer => ({
  spaceId,
  tabId,
  title,
});

const running = (spaceId: string, leafId: number): ProcessHazard => ({
  spaceId,
  leafId,
  state: "running",
});

const draft = (
  spaceId: string,
  bufferId: string,
  state: DraftHazard["state"] = "pending",
): DraftHazard => ({
  spaceId,
  bufferId,
  title: bufferId,
  state,
});

describe("quit survey", () => {
  it("reports an idle application as needing no resolution", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [],
      processes: [],
      drafts: [],
    });
    expect(quitNeedsResolution(survey)).toBe(false);
    expect(survey.totals).toEqual({
      buffers: 0,
      processes: 0,
      uncertainProcesses: 0,
      drafts: 0,
    });
  });

  it("groups unsaved buffers, processes and drafts by Space", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [buffer("sp-work", 4, "a.ts"), buffer("sp-notes", 9, "b.md")],
      processes: [running("sp-work", 12), running("sp-notes", 13)],
      drafts: [draft("sp-work", "buf-a")],
    });

    expect(survey.spaces.map((space) => space.id)).toEqual([
      "sp-work",
      "sp-notes",
    ]);
    const work = survey.spaces[0];
    expect(work.name).toBe("Work");
    expect(work.buffers.map((b) => b.title)).toEqual(["a.ts"]);
    expect(work.processes.map((p) => p.leafId)).toEqual([12]);
    expect(work.drafts.map((d) => d.bufferId)).toEqual(["buf-a"]);
    expect(survey.totals).toEqual({
      buffers: 2,
      processes: 2,
      uncertainProcesses: 0,
      drafts: 1,
    });
    expect(quitNeedsResolution(survey)).toBe(true);
  });

  it("keeps a Space that has only unsaved text in the summary", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [buffer("sp-notes", 9, "b.md")],
      processes: [],
      drafts: [],
    });
    expect(survey.spaces.map((space) => space.name)).toEqual(["Notes"]);
    expect(survey.totals.processes).toBe(0);
  });

  it("treats an unavailable process probe as work, not as an idle terminal", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [],
      processes: [{ spaceId: "sp-work", leafId: 7, state: "uncertain" }],
      drafts: [],
    });
    expect(survey.totals.uncertainProcesses).toBe(1);
    expect(quitNeedsResolution(survey)).toBe(true);
    expect(describeQuit(survey)).toMatch(
      /could not be checked|did not report/i,
    );
  });

  it("counts a dirty buffer and its pending draft separately, and names the loss", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [buffer("sp-work", 4, "a.ts")],
      processes: [],
      drafts: [draft("sp-work", "buf-a", "failed")],
    });
    const message = describeQuit(survey);
    expect(message).toContain("Work");
    expect(message).toContain("1");
    expect(message).toMatch(/recovery draft/i);
  });

  it("states that processes started outside the app keep running", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [],
      processes: [running("sp-work", 12)],
      drafts: [],
    });
    // The survey never promises lifecycle control it does not have.
    expect(describeQuit(survey)).toMatch(/outside Terax|detached/i);
  });

  it("compares hazards so a confirmation cannot cover newer work", () => {
    const before = surveyQuit({
      spaces,
      buffers: [buffer("sp-work", 4, "a.ts")],
      processes: [running("sp-work", 12)],
      drafts: [],
    });
    const acknowledged = quitHazardIds(before);
    expect(hasNewQuitHazards(acknowledged, before)).toBe(false);

    const after = surveyQuit({
      spaces,
      buffers: [buffer("sp-work", 4, "a.ts"), buffer("sp-notes", 9, "b.md")],
      processes: [running("sp-work", 12), running("sp-notes", 13)],
      drafts: [],
    });
    expect(hasNewQuitHazards(acknowledged, after)).toBe(true);
  });

  it("does not treat a vanished hazard as a new one", () => {
    const before = surveyQuit({
      spaces,
      buffers: [buffer("sp-work", 4, "a.ts")],
      processes: [running("sp-work", 12)],
      drafts: [],
    });
    const after = surveyQuit({
      spaces,
      buffers: [],
      processes: [running("sp-work", 12)],
      drafts: [],
    });
    expect(hasNewQuitHazards(quitHazardIds(before), after)).toBe(false);
  });
});

/**
 * Ported from the retired `useAppCloseGuard` test: the opt-out keeps its exact
 * meaning (running processes only) now that the prompt also has drafts to show.
 */
describe("quit prompt opt-out", () => {
  it("is offered when a running process is the only blocker", () => {
    const survey = surveyQuit({
      spaces,
      buffers: [],
      processes: [running("sp-work", 12)],
      drafts: [],
    });
    expect(canOptOutOfQuitPrompt(survey)).toBe(true);
  });

  it("is withheld whenever unsaved text or an unsaved draft is also at stake", () => {
    const withBuffer = surveyQuit({
      spaces,
      buffers: [buffer("sp-work", 4, "a.ts")],
      processes: [running("sp-work", 12)],
      drafts: [],
    });
    expect(canOptOutOfQuitPrompt(withBuffer)).toBe(false);

    const withDraft = surveyQuit({
      spaces,
      buffers: [],
      processes: [running("sp-work", 12)],
      drafts: [draft("sp-work", "buf-a")],
    });
    expect(canOptOutOfQuitPrompt(withDraft)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { QuitFlushReport } from "./flush";
import {
  initialQuitState,
  reduceQuit,
  type QuitEffect,
  type QuitEvent,
  type QuitState,
} from "./gate";
import { surveyQuit } from "./survey";

const spaces = [{ id: "sp-a", name: "Work" }];

const quiet = surveyQuit({
  spaces,
  buffers: [],
  processes: [],
  drafts: [],
});

const dirty = surveyQuit({
  spaces,
  buffers: [{ spaceId: "sp-a", tabId: 4, title: "a.ts" }],
  processes: [{ spaceId: "sp-a", leafId: 12, state: "running" }],
  drafts: [],
});

const clean: QuitFlushReport = { outcome: "settled", drafts: [] };
const failed: QuitFlushReport = {
  outcome: "settled",
  drafts: [
    {
      bufferId: "buf-a",
      spaceId: "sp-a",
      title: "a.ts",
      state: "failed",
      message: "disk on fire",
    },
  ],
};
const timedOut: QuitFlushReport = {
  outcome: "timeout",
  drafts: [
    { bufferId: "buf-a", spaceId: "sp-a", title: "a.ts", state: "unsettled" },
  ],
};

/** Applies one event and returns the next state plus the effects it asked for. */
function step(
  state: QuitState,
  event: QuitEvent,
): { state: QuitState; effects: QuitEffect[] } {
  const next = reduceQuit(state, event);
  return { state: next.state, effects: next.effects };
}

const kinds = (effects: QuitEffect[]) => effects.map((effect) => effect.kind);

describe("quit gate", () => {
  it("closes a quiet application without asking, after a graceful pass", () => {
    const surveying = step(initialQuitState, { type: "close-request" });
    expect(surveying.state.phase).toBe("surveying");
    expect(kinds(surveying.effects)).toEqual(["survey"]);

    // Nothing to answer, but the terminals still get SIGTERM: work that started
    // after the probe must not be silently hung up on.
    const closing = step(surveying.state, {
      type: "surveilled",
      survey: quiet,
    });
    expect(closing.state.phase).toBe("terminating");
    expect(kinds(closing.effects)).toEqual(["terminate"]);

    const closed = step(closing.state, { type: "terminated", survivors: [] });
    expect(closed.state.phase).toBe("closing");
    expect(kinds(closed.effects)).toEqual(["close-window"]);
  });

  it("asks before discarding unsaved buffers and running processes", () => {
    const surveyed = step(
      step(initialQuitState, { type: "close-request" }).state,
      { type: "surveilled", survey: dirty },
    );
    expect(surveyed.state.phase).toBe("resolving");
    expect(surveyed.effects).toEqual([]);
    expect(surveyed.state.survey?.totals).toMatchObject({
      buffers: 1,
      processes: 1,
    });
  });

  it("never treats a repeated close request as consent", () => {
    let state = step(initialQuitState, { type: "close-request" }).state;
    const second = step(state, { type: "close-request" });
    expect(second.effects).toEqual([]);
    expect(second.state).toBe(state);

    state = step(state, { type: "surveilled", survey: dirty }).state;
    const third = step(state, { type: "close-request" });
    expect(third.effects).toEqual([]);
    expect(third.state.phase).toBe("resolving");
  });

  it("does not close when the user cancels", () => {
    const resolving = step(
      step(initialQuitState, { type: "close-request" }).state,
      { type: "surveilled", survey: dirty },
    ).state;
    const cancelled = step(resolving, { type: "cancel" });
    expect(cancelled.state.phase).toBe("idle");
    expect(cancelled.effects).toEqual([]);

    // A later request surveys again instead of reusing the old answer.
    const again = step(cancelled.state, { type: "close-request" });
    expect(again.state.phase).toBe("surveying");
    expect(kinds(again.effects)).toEqual(["survey"]);
  });

  it("flushes recovery before terminating anything", () => {
    const resolving = step(
      step(initialQuitState, { type: "close-request" }).state,
      { type: "surveilled", survey: dirty },
    ).state;
    const flushing = step(resolving, { type: "confirm" });
    expect(flushing.state.phase).toBe("flushing");
    expect(kinds(flushing.effects)).toEqual(["flush-recovery"]);
    expect(flushing.state.acknowledged).toEqual({
      buffers: [4],
      processes: [12],
    });
  });

  it("offers retry, cancel and explicit loss when a flush fails", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;

    const blocked = step(flushing, { type: "flushed", report: failed });
    expect(blocked.state.phase).toBe("flush-failed");
    // Nothing may close while drafts are unsaved.
    expect(blocked.effects).toEqual([]);
    expect(blocked.state.flush?.drafts).toHaveLength(1);

    const retry = step(blocked.state, { type: "retry-flush" });
    expect(retry.state.phase).toBe("flushing");
    expect(kinds(retry.effects)).toEqual(["flush-recovery"]);

    const cancel = step(blocked.state, { type: "cancel" });
    expect(cancel.state.phase).toBe("idle");
    expect(cancel.effects).toEqual([]);

    const lose = step(blocked.state, { type: "lose-drafts" });
    expect(lose.state.phase).toBe("terminating");
    expect(kinds(lose.effects)).toEqual(["terminate"]);
  });

  it("never reads a bounded flush that ran out of time as saved", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;
    const blocked = step(flushing, { type: "flushed", report: timedOut });
    expect(blocked.state.phase).toBe("flush-failed");
    expect(blocked.effects).toEqual([]);
  });

  it("tries graceful termination, then asks before forcing", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;
    const verifying = step(flushing, { type: "flushed", report: clean });
    expect(verifying.state.phase).toBe("verifying");
    expect(kinds(verifying.effects)).toEqual(["survey"]);

    const terminating = step(verifying.state, {
      type: "surveilled",
      survey: dirty,
    });
    expect(terminating.state.phase).toBe("terminating");
    expect(kinds(terminating.effects)).toEqual(["terminate"]);

    // Nothing exited: the user is asked, and nothing is killed behind them.
    const survivors = step(terminating.state, {
      type: "terminated",
      survivors: [12],
    });
    expect(survivors.state.phase).toBe("force-prompt");
    expect(survivors.state.survivors).toEqual([12]);
    expect(survivors.effects).toEqual([]);

    const forced = step(survivors.state, { type: "force" });
    expect(forced.state.phase).toBe("closing");
    expect(kinds(forced.effects)).toEqual([
      "force-close-terminals",
      "close-window",
    ]);
  });

  it("closes after a graceful exit that leaves nothing behind", () => {
    const terminating = step(
      step(
        step(
          step(step(initialQuitState, { type: "close-request" }).state, {
            type: "surveilled",
            survey: dirty,
          }).state,
          { type: "confirm" },
        ).state,
        { type: "flushed", report: clean },
      ).state,
      { type: "surveilled", survey: dirty },
    ).state;
    const done = step(terminating, { type: "terminated", survivors: [] });
    expect(done.state.phase).toBe("closing");
    expect(kinds(done.effects)).toEqual(["close-window"]);
  });

  it("reopens the dialogue when new work appears during the flush", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;
    const verifying = step(flushing, { type: "flushed", report: clean }).state;
    const grown = surveyQuit({
      spaces,
      buffers: [
        { spaceId: "sp-a", tabId: 4, title: "a.ts" },
        { spaceId: "sp-a", tabId: 9, title: "b.ts" },
      ],
      processes: [{ spaceId: "sp-a", leafId: 12, state: "running" }],
      drafts: [],
    });
    const reopened = step(verifying, { type: "surveilled", survey: grown });
    expect(reopened.state.phase).toBe("resolving");
    expect(reopened.state.note).toBe("changed");
    expect(reopened.effects).toEqual([]);
  });

  it("keeps the confirmation when only the same hazards remain", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;
    const verifying = step(flushing, { type: "flushed", report: clean }).state;
    const terminating = step(verifying, { type: "surveilled", survey: dirty });
    expect(terminating.state.phase).toBe("terminating");
  });

  it("flushes again when newer draft text appears during termination", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;
    const verifying = step(flushing, { type: "flushed", report: clean }).state;
    const withDraft = surveyQuit({
      spaces,
      buffers: [{ spaceId: "sp-a", tabId: 4, title: "a.ts" }],
      processes: [],
      drafts: [
        { spaceId: "sp-a", bufferId: "buf-a", title: "a.ts", state: "pending" },
      ],
    });
    const again = step(verifying, { type: "surveilled", survey: withDraft });
    expect(again.state.phase).toBe("flushing");
    expect(kinds(again.effects)).toEqual(["flush-recovery"]);
  });

  it("does not quit when a save before quit leaves newer text unsaved", () => {
    const resolving = step(
      step(initialQuitState, { type: "close-request" }).state,
      { type: "surveilled", survey: dirty },
    ).state;
    const saving = step(resolving, { type: "save-all" });
    expect(saving.state.phase).toBe("saving");
    expect(kinds(saving.effects)).toEqual(["save-all"]);

    const incomplete = step(saving.state, { type: "saved", complete: false });
    expect(incomplete.state.phase).toBe("surveying");
    expect(incomplete.state.note).toBe("save-incomplete");
    expect(kinds(incomplete.effects)).toEqual(["survey"]);

    const stillDirty = step(incomplete.state, {
      type: "surveilled",
      survey: dirty,
    });
    expect(stillDirty.state.phase).toBe("resolving");
    expect(stillDirty.state.note).toBe("save-incomplete");
  });

  it("cancelling during a flush keeps the app open and ignores the late report", () => {
    const flushing = step(
      step(step(initialQuitState, { type: "close-request" }).state, {
        type: "surveilled",
        survey: dirty,
      }).state,
      { type: "confirm" },
    ).state;
    const cancelled = step(flushing, { type: "cancel" });
    expect(cancelled.state.phase).toBe("idle");

    const late = step(cancelled.state, { type: "flushed", report: clean });
    expect(late.state.phase).toBe("idle");
    expect(late.effects).toEqual([]);
  });

  it("ignores a late termination report after the user cancelled", () => {
    const terminating = step(
      step(
        step(
          step(step(initialQuitState, { type: "close-request" }).state, {
            type: "surveilled",
            survey: dirty,
          }).state,
          { type: "confirm" },
        ).state,
        { type: "flushed", report: clean },
      ).state,
      { type: "surveilled", survey: dirty },
    ).state;
    const cancelled = step(terminating, { type: "cancel" });
    expect(cancelled.state.phase).toBe("idle");
    const late = step(cancelled.state, { type: "terminated", survivors: [] });
    expect(late.effects).toEqual([]);
    expect(late.state.phase).toBe("idle");
  });

  it("cannot be forced from a phase that never asked", () => {
    const forced = step(initialQuitState, { type: "force" });
    expect(forced.effects).toEqual([]);
    expect(forced.state.phase).toBe("idle");
  });
});

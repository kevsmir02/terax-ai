/**
 * The quit decision, as a pure state machine.
 *
 * Quitting is a sequence of questions, not a boolean. The machine exists so the
 * rules the specification states are testable without a window:
 *
 *  - **A repeated close event is never consent.** `close-request` is only
 *    accepted from `idle`; every other phase ignores it, including the two that
 *    would otherwise be tempting shortcuts (`flush-failed` and `force-prompt`).
 *  - **Nothing is acknowledged that was not asked about.** `confirm` records the
 *    hazard identities it covered, and `verifying` compares a fresh survey
 *    against them: new work reopens the question instead of riding on the old
 *    answer.
 *  - **Only durable drafts are saved.** A flush that failed, paused, timed out
 *    or left newer text in flight goes to `flush-failed`, whose only exits are
 *    retry, cancel, or an explicit "lose the drafts".
 *  - **Graceful first.** Confirmation leads to `terminating` (a SIGTERM pass);
 *    only survivors reach `force-prompt`, and only an explicit `force` there
 *    kills anything.
 *  - **Late results are ignored.** A flush or termination that lands after the
 *    user cancelled changes no state and causes no effect.
 *
 * Effects are returned rather than executed so the caller owns IPC, timers and
 * the window: the same machine can run against the real terminal backend or a
 * test double.
 */

import { type QuitFlushReport, flushBlocksQuit } from "./flush";
import {
  hasNewQuitHazards,
  type QuitHazardIds,
  quitHazardIds,
  quitNeedsResolution,
  type QuitSurvey,
} from "./survey";

/** How long app-owned work gets to honour SIGTERM before quit asks. */
export const QUIT_TERMINATE_GRACE_MS = 2000;

export type QuitPhase =
  | "idle"
  | "surveying"
  | "resolving"
  | "saving"
  | "flushing"
  | "flush-failed"
  | "verifying"
  | "terminating"
  | "force-prompt"
  | "closing";

export type QuitNote = "changed" | "save-incomplete";

export type QuitState = {
  phase: QuitPhase;
  survey: QuitSurvey | null;
  acknowledged: QuitHazardIds;
  flush: QuitFlushReport | null;
  /** Terminal leaves that did not exit after the graceful pass. */
  survivors: number[];
  note: QuitNote | null;
};

export const initialQuitState: QuitState = {
  phase: "idle",
  survey: null,
  acknowledged: { buffers: [], processes: [] },
  flush: null,
  survivors: [],
  note: null,
};

export type QuitEffect =
  /** Collect the evidence: dirty buffers, process probes, draft statuses. */
  | { kind: "survey" }
  | { kind: "flush-recovery" }
  | { kind: "save-all"; tabIds: number[] }
  /** SIGTERM app-owned work and wait the grace period. Never forces. */
  | { kind: "terminate"; graceMs: number }
  /** The explicitly confirmed escalation for survivors. */
  | { kind: "force-close-terminals" }
  | { kind: "close-window" };

export type QuitEvent =
  | { type: "close-request" }
  | { type: "surveilled"; survey: QuitSurvey }
  | { type: "cancel" }
  /** The user answered the summary: quit, discarding what it listed. */
  | { type: "confirm" }
  | { type: "save-all" }
  | { type: "saved"; complete: boolean }
  | { type: "flushed"; report: QuitFlushReport }
  | { type: "retry-flush" }
  /** Explicit close-with-loss after a failed or timed-out flush. */
  | { type: "lose-drafts" }
  | { type: "terminated"; survivors: number[] }
  | { type: "force" };

export type QuitTransition = { state: QuitState; effects: QuitEffect[] };

const stay = (state: QuitState): QuitTransition => ({ state, effects: [] });

function reset(state: QuitState, phase: QuitPhase): QuitState {
  return {
    ...state,
    phase,
    survey: null,
    acknowledged: { buffers: [], processes: [] },
    flush: null,
    survivors: [],
    note: null,
  };
}

const CANCELABLE: ReadonlySet<QuitPhase> = new Set<QuitPhase>([
  "surveying",
  "resolving",
  "saving",
  "flushing",
  "flush-failed",
  "verifying",
  "terminating",
  "force-prompt",
]);

export function reduceQuit(state: QuitState, event: QuitEvent): QuitTransition {
  switch (event.type) {
    case "close-request": {
      // Only a request from rest starts a quit. While any question is open (or
      // in flight) a second close event is the user poking the window again,
      // never an answer to it.
      if (state.phase !== "idle") return stay(state);
      return {
        state: reset(state, "surveying"),
        effects: [{ kind: "survey" }],
      };
    }

    case "surveilled": {
      if (state.phase === "surveying") {
        if (!quitNeedsResolution(event.survey)) {
          // Nothing to answer — but the terminals may still hold work the probe
          // did not see (a process started since), so the graceful pass runs
          // before the window closes. It never forces: survivors are a question.
          return {
            state: { ...state, phase: "terminating", survey: event.survey },
            effects: [{ kind: "terminate", graceMs: QUIT_TERMINATE_GRACE_MS }],
          };
        }
        return {
          state: { ...state, phase: "resolving", survey: event.survey },
          effects: [],
        };
      }
      if (state.phase === "verifying") {
        const drafts = event.survey.totals.drafts;
        if (drafts > 0) {
          // Newer text appeared while the quit was in progress: saving it is
          // the only honest answer, and it is bounded like the first flush.
          return {
            state: { ...state, phase: "flushing", survey: event.survey },
            effects: [{ kind: "flush-recovery" }],
          };
        }
        if (hasNewQuitHazards(state.acknowledged, event.survey)) {
          return {
            state: {
              ...state,
              phase: "resolving",
              survey: event.survey,
              note: "changed",
            },
            effects: [],
          };
        }
        return {
          state: { ...state, phase: "terminating", survey: event.survey },
          effects: [{ kind: "terminate", graceMs: QUIT_TERMINATE_GRACE_MS }],
        };
      }
      return stay(state);
    }

    case "cancel": {
      if (!CANCELABLE.has(state.phase)) return stay(state);
      return { state: reset(state, "idle"), effects: [] };
    }

    case "confirm": {
      if (state.phase !== "resolving" || state.survey === null) {
        return stay(state);
      }
      return {
        state: {
          ...state,
          phase: "flushing",
          acknowledged: quitHazardIds(state.survey),
          flush: null,
          note: null,
        },
        effects: [{ kind: "flush-recovery" }],
      };
    }

    case "save-all": {
      if (state.phase !== "resolving" || state.survey === null) {
        return stay(state);
      }
      const tabIds = state.survey.spaces.flatMap((space) =>
        space.buffers.map((buffer) => buffer.tabId),
      );
      return {
        state: { ...state, phase: "saving" },
        effects: [{ kind: "save-all", tabIds }],
      };
    }

    case "saved": {
      if (state.phase !== "saving") return stay(state);
      // Either way the question is asked again from fresh evidence: a save that
      // did not cover the current text must not be read as one that did.
      return {
        state: {
          ...state,
          phase: "surveying",
          survey: null,
          note: event.complete ? state.note : "save-incomplete",
        },
        effects: [{ kind: "survey" }],
      };
    }

    case "flushed": {
      if (state.phase !== "flushing") return stay(state);
      if (flushBlocksQuit(event.report)) {
        return {
          state: { ...state, phase: "flush-failed", flush: event.report },
          effects: [],
        };
      }
      return {
        state: { ...state, phase: "verifying", flush: event.report },
        effects: [{ kind: "survey" }],
      };
    }

    case "retry-flush": {
      if (state.phase !== "flush-failed") return stay(state);
      return {
        state: { ...state, phase: "flushing", flush: null },
        effects: [{ kind: "flush-recovery" }],
      };
    }

    case "lose-drafts": {
      if (state.phase !== "flush-failed") return stay(state);
      return {
        state: { ...state, phase: "terminating" },
        effects: [{ kind: "terminate", graceMs: QUIT_TERMINATE_GRACE_MS }],
      };
    }

    case "terminated": {
      if (state.phase !== "terminating") return stay(state);
      if (event.survivors.length > 0) {
        return {
          state: {
            ...state,
            phase: "force-prompt",
            survivors: event.survivors,
          },
          effects: [],
        };
      }
      return {
        state: { ...state, phase: "closing", survivors: [] },
        effects: [{ kind: "close-window" }],
      };
    }

    case "force": {
      if (state.phase !== "force-prompt") return stay(state);
      return {
        state: { ...state, phase: "closing" },
        effects: [{ kind: "force-close-terminals" }, { kind: "close-window" }],
      };
    }

    default:
      return stay(state);
  }
}

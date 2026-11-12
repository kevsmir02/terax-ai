import type { AgentStatus } from "./types";

/**
 * What the app may claim about an agent, and where the claim came from.
 *
 * Two independent sources feed the status surfaces:
 *
 * - the **process** lifecycle (shell OSC 133 command boundaries and PTY exit)
 *   proves only that an agent process is running or has exited;
 * - an **event** from the agent itself (an opt-in hook, or the terminal
 *   notification it emitted) proves attention or the end of a turn.
 *
 * A process exit is never a completed turn, and a running process is never
 * evidence of progress, so every label below states which source it used.
 */
export type StatusEvidence = "process" | "event";

export type StatusSignalKind =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "exited";

/** The event a signal proves, when it proves more than "the process is alive". */
export type StatusEvent = "started" | "attention" | "turn-finished" | "exited";

export type SignalStatus = {
  /** Session status after the signal; null when the process ended. */
  status: AgentStatus | null;
  event: StatusEvent | null;
  evidence: StatusEvidence;
  /** True only when an agent event says the turn ended. */
  turnEnded: boolean;
};

const STATUSES: Record<StatusSignalKind, SignalStatus> = {
  // Armed by the shell's command boundary: the process exists, nothing more.
  started: {
    status: "running",
    event: "started",
    evidence: "process",
    turnEnded: false,
  },
  working: {
    status: "running",
    event: null,
    evidence: "process",
    turnEnded: false,
  },
  // Any terminal-notification attention from a running agent.
  attention: {
    status: "attention",
    event: "attention",
    evidence: "event",
    turnEnded: false,
  },
  // A hook or the agent's own finish marker. The process keeps the pane, so it
  // stays "running"; only the turn is over.
  finished: {
    status: "running",
    event: "turn-finished",
    evidence: "event",
    turnEnded: true,
  },
  // The command boundary or the PTY went away: an exit, not a result.
  exited: {
    status: null,
    event: "exited",
    evidence: "process",
    turnEnded: false,
  },
};

export function signalStatus(kind: StatusSignalKind): SignalStatus {
  return STATUSES[kind] ?? STATUSES.working;
}

/** Label for a live session row, phrased by what is actually known. */
export function sessionStatusLabel(status: AgentStatus): string {
  return status === "attention" ? "needs attention" : "running";
}

/** Label for any status/evidence pair, including the ones never shown as a session. */
export function processStatusLabel(
  status: StatusEvent | "running",
  evidence: StatusEvidence,
): string {
  switch (status) {
    case "running":
      return "running";
    case "exited":
      return "process exited";
    case "turn-finished":
      // Only reachable with event evidence; a process exit cannot claim it.
      return evidence === "event" ? "turn finished" : "running";
    case "attention":
      return "needs attention";
    case "started":
      return "running";
  }
}

/**
 * What a live session row may claim.
 *
 * `running` comes from the process lifecycle: an agent command was armed by the
 * shell and its process is still attached to the pane. It is not a claim that
 * the agent is doing anything, only that it has not exited.
 *
 * `attention` comes from an agent event (an opt-in hook, or the notification the
 * agent sent to its terminal). A turn that merely ends is not attention.
 */
export type AgentStatus = "running" | "attention";

export type AgentSource = "terminal" | "local";

type AgentSignalKind =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "exited";

export type AgentSignal = {
  id: number;
  kind: AgentSignalKind;
  agent: string | null;
};

export type AgentSession = {
  leafId: number;
  tabId: number;
  agent: string;
  status: AgentStatus;
  startedAt: number;
  lastActivityAt: number;
  attentionSince: number | null;
};

export type AgentNotification = {
  id: string;
  source: AgentSource;
  leafId: number;
  tabId: number;
  agent: string;
  kind: NotificationKind;
  at: number;
  read: boolean;
};

/**
 * `attention` is an agent asking for the user; `turn-finished` is a completed
 * turn reported by an agent event, not a process that went away; `error` is a
 * failed run.
 */
export type NotificationKind = "attention" | "turn-finished" | "error";

export type LocalAgentState = {
  agent: string;
  status: AgentStatus;
} | null;

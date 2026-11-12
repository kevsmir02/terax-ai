import { invoke } from "@tauri-apps/api/core";

export type HooksAction = "install" | "uninstall";

/** Agents this fork can configure hooks for, in display order. */
export const HOOK_AGENTS = ["claude", "codex", "gemini", "pi"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];

export type HooksSupport = "supported" | "unsupported";

/**
 * What writing a configuration does *not* prove. A configured file is not an
 * active integration: the agent still has to restart, and some versions ask
 * the user to review/trust the hooks before they run.
 */
export type HookActivation = {
  restartRequired: boolean;
  trustRequired: boolean;
  summary: string;
  steps: string[];
  /** False until a real installed CLI version was exercised. */
  verified: boolean;
};

/** What installing or removing an agent's hooks would change. */
export type HooksPlan = {
  agent: string;
  action: HooksAction;
  path: string;
  /** File contents now; null when the file does not exist. */
  before: string | null;
  /** File contents afterwards; null when the file would be removed. */
  after: string | null;
  /** Fingerprint of the observed `before`; echo it back to apply. */
  revision: string;
  changed: boolean;
  /** Hook groups owned by another tool or upstream, left untouched. */
  foreignGroups: number;
  activation: HookActivation;
};

export type HooksConfigState =
  | "installed"
  | "partial"
  | "not-installed"
  | "invalid"
  | "conflict"
  | "unsupported";

export type HooksStatus = {
  agent: string;
  path: string;
  support: HooksSupport;
  configState: HooksConfigState;
  /** The fork's entries are present and current; the agent may still not trust them. */
  installed: boolean;
  revision: string | null;
  foreignGroups: number;
  activation: HookActivation;
  note: string | null;
};

export type HooksApplyOutcome = "applied" | "unchanged" | "stale";

export type HooksApply = {
  outcome: HooksApplyOutcome;
  /** Revision of the file after the call (unchanged for a stale apply). */
  revision: string;
  status: HooksStatus;
};

export function planAgentHooks(
  agent: string,
  action: HooksAction,
): Promise<HooksPlan> {
  return invoke<HooksPlan>("agent_hooks_plan", { agent, action });
}

/**
 * Applies a previewed plan against the revision it was computed from. A file
 * that changed since the preview is refused (`outcome: "stale"`, no write).
 */
export function applyAgentHooksPlan(plan: HooksPlan): Promise<HooksApply> {
  return invoke<HooksApply>("agent_hooks_apply", {
    agent: plan.agent,
    action: plan.action,
    revision: plan.revision,
  });
}

export function agentHooksStatus(agent: string): Promise<HooksStatus> {
  return invoke<HooksStatus>("agent_hooks_status", { agent });
}

import { displayAgent } from "./format";
import type { NotificationKind } from "./types";

/**
 * Default notification copy.
 *
 * The payload is an allowlist: the agent's display name, the kind of attention
 * or completion, and the Space's own name. Nothing from the terminal — no
 * prompt, assistant text, transcript, command or file path — is ever read into
 * it, so a notification cannot reveal project content on a lock screen or in
 * the OS notification centre.
 */
export type AgentNotificationContent = {
  title: string;
  body: string;
};

const KIND_TITLE: Record<NotificationKind, string> = {
  attention: "needs attention",
  "turn-finished": "turn finished",
  error: "run failed",
};

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function agentNotificationContent({
  agent,
  kind,
  spaceName,
}: {
  agent: string;
  kind: NotificationKind;
  /** The Space's own name; never its path, cwd or open files. */
  spaceName?: string | null;
}): AgentNotificationContent {
  const space = spaceName ? oneLine(spaceName) : "";
  return {
    title: `${displayAgent(agent)} ${KIND_TITLE[kind]}`,
    body: space ? `Space: ${space}` : "Workspace",
  };
}

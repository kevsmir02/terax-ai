import { homeRelativePath } from "@/lib/homeRelativePath";
import { displayAgent } from "@/modules/agents/lib/format";
import type { AgentStatus } from "@/modules/agents/lib/types";
import type { AgentPhase } from "@/modules/terminal/lib/agentActivity";

const DEFAULT_MAX_CWD_LENGTH = 32;

export type PaneHeaderIdentity =
  | {
      kind: "agent";
      agent: string;
      label: string;
      phase: AgentPhase;
    }
  | {
      kind: "terminal";
      label: string;
      phase: null;
    };

export type PaneHeaderIdentityInput = {
  activityAgent?: string | null;
  activityPhase?: AgentPhase | null;
  sessionAgent?: string | null;
  sessionStatus?: AgentStatus | null;
  customTitle?: string | null;
  terminalShell?: string;
};

export type PaneHeaderCwd = {
  full: string;
  display: string;
};

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function shellBasename(terminalShell: string): string | null {
  const trimmed = nonEmptyTrimmed(terminalShell);
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  const stripped = last.replace(/\.exe$/i, "");
  return stripped.length > 0 ? stripped : null;
}

export function resolvePaneHeaderIdentity(
  input: PaneHeaderIdentityInput,
): PaneHeaderIdentity {
  const agentName =
    nonEmptyTrimmed(input.activityAgent) ?? nonEmptyTrimmed(input.sessionAgent);
  const phase: AgentPhase | null =
    input.activityPhase ??
    (input.sessionStatus === "attention"
      ? "attention"
      : input.sessionStatus === "running"
        ? "working"
        : null);

  if (agentName || phase === "working" || phase === "attention") {
    const resolvedAgent = agentName ?? "agent";
    return {
      kind: "agent",
      agent: resolvedAgent,
      label: displayAgent(resolvedAgent),
      phase: phase ?? "working",
    };
  }

  const customTitle = nonEmptyTrimmed(input.customTitle);
  if (customTitle) {
    return { kind: "terminal", label: customTitle, phase: null };
  }

  const shell = shellBasename(input.terminalShell ?? "");
  if (shell) {
    return { kind: "terminal", label: shell, phase: null };
  }

  return { kind: "terminal", label: "Terminal", phase: null };
}

function truncateTail(
  prefix: string,
  segments: string[],
  fullTail: string,
  maxLength: number,
  allowSlashBeforeTail: boolean,
): string {
  if (maxLength <= prefix.length) return prefix;

  let tail = "";
  for (let i = segments.length - 1; i >= 0; i--) {
    const next = `/${segments[i]}${tail}`;
    if (prefix.length + next.length > maxLength) break;
    tail = next;
  }
  if (tail.length > 0) return `${prefix}${tail}`;

  const last = segments[segments.length - 1] ?? fullTail;
  if (allowSlashBeforeTail && segments.length > 1) {
    const slashBudget = maxLength - prefix.length - 1;
    if (slashBudget >= 1) {
      return `${prefix}/${last.slice(-slashBudget)}`;
    }
  }
  const budget = maxLength - prefix.length;
  return `${prefix}${last.slice(-budget)}`;
}

export function formatPaneHeaderCwd(
  cwd: string | null | undefined,
  home: string | null | undefined,
  maxLength = DEFAULT_MAX_CWD_LENGTH,
): PaneHeaderCwd | null {
  const trimmed = nonEmptyTrimmed(cwd);
  if (!trimmed) return null;

  const full = homeRelativePath(trimmed, home ?? null);
  if (maxLength <= 0 || full.length <= maxLength) {
    return { full, display: full };
  }

  if (full.startsWith("~/")) {
    const rest = full.slice(2);
    const segments = rest.split("/").filter(Boolean);
    return {
      full,
      display: truncateTail("~/...", segments, rest, maxLength, true),
    };
  }

  const segments = full.split("/").filter(Boolean);
  return {
    full,
    display: truncateTail("...", segments, full, maxLength, false),
  };
}

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { processStatusLabel } from "@/modules/agents/lib/status";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import {
  formatPaneHeaderCwd,
  resolvePaneHeaderIdentity,
} from "@/modules/terminal/lib/paneHeader";
import { ptyIdForLeaf } from "@/modules/terminal/lib/terminalSessionApi";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";

export type PaneHeaderProps = {
  leafId: number;
  focused: boolean;
  leafCount: number;
  cwd?: string | null;
  customTitle?: string | null;
  home?: string | null;
  onClose?: () => void;
};

export const PaneHeader = memo(function PaneHeader({
  leafId,
  focused,
  leafCount,
  cwd,
  customTitle,
  home,
  onClose,
}: PaneHeaderProps) {
  const activity = useAgentActivityStore(
    useShallow((s) => {
      const ptyId = ptyIdForLeaf(leafId);
      if (ptyId === null) return { agent: null, phase: null };
      return {
        agent: s.agents[ptyId] ?? null,
        phase: s.phases[ptyId] ?? null,
      };
    }),
  );
  const session = useAgentStore((s) => s.sessions[leafId] ?? null);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);

  const identity = resolvePaneHeaderIdentity({
    activityAgent: activity.agent,
    activityPhase: activity.phase,
    sessionAgent: session?.agent ?? null,
    sessionStatus: session?.status ?? null,
    customTitle,
    terminalShell,
  });
  const cwdInfo = formatPaneHeaderCwd(cwd, home);
  const isSplit = leafCount > 1;
  const isSplitFocused = isSplit && focused;
  const isSplitUnfocused = isSplit && !focused;

  return (
    <div
      data-pane-header=""
      data-pane-focused={focused ? "true" : "false"}
      className={cn(
        "relative flex h-7 shrink-0 select-none items-center justify-between gap-2 border-b border-border px-2.5 text-xs",
        isSplitFocused
          ? "bg-terminal-header-focused text-foreground"
          : isSplitUnfocused
            ? "bg-terminal-header text-muted-foreground"
            : "bg-terminal-header text-foreground",
      )}
    >
      {isSplitFocused && (
        <span
          data-pane-focus-indicator=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary"
        />
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        {identity.kind === "agent" ? (
          <span data-pane-icon="agent" className="flex shrink-0 items-center">
            <AgentIcon agent={identity.agent} size={13} className="shrink-0" />
          </span>
        ) : (
          <span
            data-pane-icon="terminal"
            className={cn(
              "flex shrink-0 items-center",
              !isSplitFocused && "text-muted-foreground",
            )}
          >
            <HugeiconsIcon
              icon={ComputerTerminal02Icon}
              size={13}
              strokeWidth={1.8}
              className="shrink-0"
            />
          </span>
        )}
        <span data-pane-label="" className="truncate font-medium">
          {identity.label}
        </span>
        {identity.kind === "agent" &&
          (identity.phase === "working" || identity.phase === "attention") && (
            <span
              data-pane-phase={identity.phase}
              role="status"
              aria-label={
                identity.phase === "attention"
                  ? `Agent ${processStatusLabel("attention", "event")}`
                  : `Agent ${processStatusLabel("running", "process")}`
              }
              title={
                identity.phase === "attention"
                  ? `Agent ${processStatusLabel("attention", "event")}`
                  : `Agent ${processStatusLabel("running", "process")}`
              }
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium",
                identity.phase === "attention"
                  ? "bg-primary/15 text-primary"
                  : "bg-foreground/[0.06] text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  identity.phase === "attention"
                    ? "bg-primary terax-attention-pulse"
                    : "bg-emerald-500 animate-pulse",
                )}
              />
              <span>
                {identity.phase === "attention" ? "Needs attention" : "Running"}
              </span>
            </span>
          )}
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-1.5">
        {cwdInfo && (
          <span
            data-pane-cwd=""
            title={cwdInfo.full}
            className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground"
          >
            {cwdInfo.display}
          </span>
        )}
        {isSplit && (
          <button
            type="button"
            data-pane-close=""
            aria-label="Close pane"
            title="Close pane"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onClose?.();
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors duration-[var(--dur-fast)] hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
});

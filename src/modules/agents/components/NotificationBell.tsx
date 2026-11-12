import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  CheckmarkCircle02Icon,
  Notification01Icon,
  Notification03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  agentHooksStatus,
  HOOK_AGENTS,
  type HooksStatus,
} from "@/modules/control/lib/hooksConfig";
import { useMemo, useState } from "react";
import { AgentIcon } from "../lib/agentIcon";
import { displayAgent } from "../lib/format";
import { signalStatusLabel } from "../lib/status";
import type { AgentNotification, AgentStatus } from "../lib/types";
import { useAgentStore } from "../store/agentStore";

type Props = {
  onActivate: (tabId: number, leafId: number) => void;
  onActivateLocal: () => void;
};

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusRow({
  agent,
  status,
  onClick,
}: {
  agent: string;
  status: AgentStatus;
  onClick: () => void;
}) {
  const attention = status === "attention";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <AgentIcon
        agent={agent}
        size={16}
        className="shrink-0 text-muted-foreground"
      />
      <span className="flex-1 truncate text-sm text-foreground">
        {displayAgent(agent)}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          attention ? "font-medium text-primary" : "text-muted-foreground",
        )}
      >
        {attention ? (
          <span className="size-1.5 rounded-full bg-primary" />
        ) : null}
        {signalStatusLabel(status)}
      </span>
    </button>
  );
}

const NOTIF_LABEL: Record<AgentNotification["kind"], string> = {
  attention: "needs attention",
  // A finished turn, reported by the agent, not a process that exited.
  "turn-finished": "turn finished",
  error: "failed",
};

function HookAgentRow({
  id,
  label,
  status,
}: {
  id: string;
  label: string;
  status: HooksStatus | null;
}) {
  const configured = status?.configState === "installed";
  const partial = status?.configState === "partial";
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <AgentIcon
        agent={id}
        size={14}
        className="shrink-0 text-muted-foreground"
      />
      <span className="flex-1 truncate text-[12px] text-muted-foreground">
        {label}
      </span>
      {configured ? (
        <span className="flex items-center gap-1 text-[11px] font-medium text-primary">
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={13}
            strokeWidth={1.75}
          />
          configured
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground/70">
          {partial ? "partly configured" : "not configured"}
        </span>
      )}
    </div>
  );
}

function NotificationRow({
  n,
  onClick,
}: {
  n: AgentNotification;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {n.kind === "turn-finished" ? (
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={15}
            strokeWidth={1.75}
            className="text-muted-foreground"
          />
        ) : (
          <span
            className={cn(
              "size-1.5 rounded-full",
              n.kind === "error" ? "bg-destructive" : "bg-primary",
            )}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {displayAgent(n.agent)}{" "}
        <span className="text-muted-foreground">{NOTIF_LABEL[n.kind]}</span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {relativeTime(n.at)}
      </span>
    </button>
  );
}

export function NotificationBell({ onActivate, onActivateLocal }: Props) {
  const [open, setOpen] = useState(false);
  const [hooks, setHooks] = useState<Record<string, HooksStatus | null>>({});
  const [alertsOpen, setAlertsOpen] = useState(false);
  const sessions = useAgentStore((s) => s.sessions);
  const localAgent = useAgentStore((s) => s.localAgent);
  const notifications = useAgentStore((s) => s.notifications);
  const markAllRead = useAgentStore((s) => s.markAllRead);
  const clearNotifications = useAgentStore((s) => s.clearNotifications);

  const active = useMemo(() => Object.values(sessions), [sessions]);
  const activeCount = active.length + (localAgent ? 1 : 0);
  const waitingCount =
    active.filter((s) => s.status === "attention").length +
    (localAgent?.status === "attention" ? 1 : 0);
  // attention maps to an active attention session, so only completed events add
  // to the badge to avoid double-counting.
  const unreadDone = notifications.filter(
    (n) => !n.read && n.kind !== "attention",
  ).length;
  const badge = waitingCount + unreadDone;
  const enabledCount = HOOK_AGENTS.filter(
    (id) => hooks[id]?.configState === "installed",
  ).length;

  const refreshHooks = () => {
    for (const id of HOOK_AGENTS) {
      agentHooksStatus(id)
        .then((status) => setHooks((h) => ({ ...h, [id]: status })))
        .catch(() => setHooks((h) => ({ ...h, [id]: null })));
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      markAllRead();
      refreshHooks();
    }
  };

  const activate = (tabId: number, leafId: number) => {
    onActivate(tabId, leafId);
    setOpen(false);
  };

  const activateLocal = () => {
    onActivateLocal();
    setOpen(false);
  };

  const activateNotification = (n: AgentNotification) => {
    if (n.source === "local") activateLocal();
    else activate(n.tabId, n.leafId);
  };

  const empty = activeCount === 0 && notifications.length === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Agent notifications"
        >
          <HugeiconsIcon
            icon={Notification01Icon}
            size={16}
            strokeWidth={1.75}
          />
          {badge > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
              {badge > 9 ? "9+" : badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 overflow-hidden p-0 gap-0.5"
      >
        <div className="flex h-10 items-center gap-2 px-3 pt-0.5">
          <span className="flex gap-1 text-[13px] text-foreground">
            Notifications
          </span>
          <div className="ml-auto flex items-center gap-2">
            {activeCount > 0 ? (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {activeCount} active
              </span>
            ) : null}
            {notifications.length > 0 ? (
              <button
                type="button"
                onClick={clearNotifications}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {empty ? (
          <div className="border-t border-border/60 px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No agent activity yet.
            <br />
            Run the Terax agent or a coding agent to track it here.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto border-t border-border/60 p-1">
            {localAgent ? (
              <StatusRow
                agent={localAgent.agent}
                status={localAgent.status}
                onClick={activateLocal}
              />
            ) : null}
            {active.map((s) => (
              <StatusRow
                key={s.leafId}
                agent={s.agent}
                status={s.status}
                onClick={() => activate(s.tabId, s.leafId)}
              />
            ))}
            {activeCount > 0 && notifications.length > 0 ? (
              <div className="mx-2 my-1 h-px bg-border/50" />
            ) : null}
            {notifications.map((n) => (
              <NotificationRow
                key={n.id}
                n={n}
                onClick={() => activateNotification(n)}
              />
            ))}
          </div>
        )}

        <div className="border-t border-border/60 p-1">
          <button
            type="button"
            onClick={() => setAlertsOpen((v) => !v)}
            aria-expanded={alertsOpen}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <HugeiconsIcon
              icon={Notification03Icon}
              size={11}
              strokeWidth={2}
            />
            Agent alerts
            <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal">
              {enabledCount > 0 ? (
                <span className="text-[10px] text-muted-foreground/60">
                  {enabledCount} on
                </span>
              ) : null}
              <HugeiconsIcon
                icon={alertsOpen ? ArrowUp01Icon : ArrowDown01Icon}
                size={13}
                strokeWidth={2}
              />
            </span>
          </button>
          {alertsOpen ? (
            <>
              {HOOK_AGENTS.map((id) => (
                <HookAgentRow
                  key={id}
                  id={id}
                  label={displayAgent(id)}
                  status={hooks[id] ?? null}
                />
              ))}
              <p className="px-2 pt-1 pb-0.5 text-[10px] leading-relaxed text-muted-foreground/70">
                Hooks are opt-in: review, install or remove them in Settings →
                Agents.
              </p>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

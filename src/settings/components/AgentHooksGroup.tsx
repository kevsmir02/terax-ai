import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { displayAgent } from "@/modules/agents/lib/format";
import {
  agentHooksStatus,
  applyAgentHooksPlan,
  HOOK_AGENTS,
  type HooksAction,
  type HooksStatus,
  planAgentHooks,
} from "@/modules/control/lib/hooksConfig";
import {
  confirmable,
  emptyHooksReview,
  hooksReviewReducer,
  hooksReviewSummary,
} from "@/modules/control/lib/hooksInstall";
import { useCallback, useEffect, useReducer, useState } from "react";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATE_LABEL: Record<HooksStatus["configState"], string> = {
  installed: "Configured",
  partial: "Partly configured",
  "not-installed": "Not configured",
  invalid: "Config needs attention",
  conflict: "Config not ours",
  unsupported: "Not supported",
};

function stateLabel(status: HooksStatus | null): string {
  if (!status) return "Unknown";
  const base = STATE_LABEL[status.configState];
  if (!status.installed) return base;
  if (status.activation.trustRequired) return `${base} — trust required`;
  if (status.activation.restartRequired) return `${base} — restart required`;
  return base;
}

/**
 * Opt-in agent hooks: review the exact before/after, then apply. A written
 * configuration is reported as configured, never as an active integration.
 */
export function AgentHooksGroup() {
  const [statuses, setStatuses] = useState<Record<string, HooksStatus | null>>(
    {},
  );
  const [review, setReview] = useState<{
    agent: string;
    action: HooksAction;
  } | null>(null);

  const refresh = useCallback(async () => {
    const entries = await Promise.all(
      HOOK_AGENTS.map(async (agent) => {
        try {
          return [agent, await agentHooksStatus(agent)] as const;
        } catch {
          return [agent, null] as const;
        }
      }),
    );
    setStatuses(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col">
        <Label>Terminal agent hooks</Label>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          Optional per agent and off by default. Nothing is written until you
          review the exact before/after, and a configuration changed behind your
          back is never overwritten. Writing the file configures the agent; it
          does not activate or trust the hooks for you.
        </span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {HOOK_AGENTS.map((agent) => {
          const status = statuses[agent] ?? null;
          const configured =
            status?.configState === "installed" ||
            status?.configState === "partial";
          return (
            <li
              key={agent}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
            >
              <AgentIcon
                agent={agent}
                size={14}
                className="shrink-0 text-muted-foreground"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[12px] font-medium">
                  {displayAgent(agent)}
                </span>
                <span
                  className={cn(
                    "truncate text-[10.5px]",
                    configured
                      ? "text-muted-foreground"
                      : "text-muted-foreground/80",
                  )}
                >
                  {stateLabel(status)}
                  {status?.path ? ` · ${status.path}` : ""}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10.5px]"
                  onClick={() => setReview({ agent, action: "install" })}
                >
                  Review install
                </Button>
                {configured ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10.5px] text-muted-foreground hover:text-destructive"
                    onClick={() => setReview({ agent, action: "uninstall" })}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {review ? (
        <HooksReviewDialog
          request={review}
          onClose={() => setReview(null)}
          onApplied={() => void refresh()}
        />
      ) : null}
    </section>
  );
}

function HooksReviewDialog({
  request,
  onClose,
  onApplied,
}: {
  request: { agent: string; action: HooksAction };
  onClose: () => void;
  onApplied: () => void;
}) {
  const [state, dispatch] = useReducer(hooksReviewReducer, emptyHooksReview);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const plan = await planAgentHooks(request.agent, request.action);
      dispatch({ type: "review", plan });
    } catch (error) {
      setLoadError(message(error));
    } finally {
      setLoading(false);
    }
  }, [request.agent, request.action]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    const plan = state.plan;
    if (!plan || !confirmable(state)) return;
    dispatch({ type: "applying" });
    try {
      const result = await applyAgentHooksPlan(plan);
      dispatch({ type: "applied", result });
      if (result.outcome !== "stale") onApplied();
    } catch (error) {
      dispatch({ type: "failed", error: message(error) });
    }
  };

  const summary = state.plan ? hooksReviewSummary(state.plan) : null;
  const outcome = state.result;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {summary?.actionLabel ?? "Review hooks"} —{" "}
            {displayAgent(request.agent)}
          </DialogTitle>
          <DialogDescription className="break-all font-mono text-[11px]">
            {summary?.path ?? "Computing the exact change…"}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {loadError}
          </p>
        ) : null}

        {state.phase === "stale" ? (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px]">
            <span>
              The file changed after this preview, so nothing was written.
              Review the new configuration before applying.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 self-start px-2 text-[10.5px]"
              onClick={() => void load()}
            >
              Review new configuration
            </Button>
          </div>
        ) : null}

        {state.phase === "failed" ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            {state.error ?? "The configuration could not be applied."}
          </p>
        ) : null}

        {outcome && outcome.outcome !== "stale" && summary ? (
          <div className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-[11px]">
            <span className="font-medium">
              {request.action === "uninstall"
                ? outcome.outcome === "applied"
                  ? "Removed."
                  : "Already removed."
                : `${summary.readyLabel}.`}
            </span>{" "}
            {outcome.outcome === "unchanged"
              ? "Nothing needed to change."
              : "The reviewed change was written."}{" "}
            {outcome.status.installed
              ? outcome.status.activation.summary
              : "A running agent keeps the hooks it started with until it restarts."}
          </div>
        ) : null}

        {loading ? (
          <p className="text-[11px] text-muted-foreground">
            Computing the exact change…
          </p>
        ) : summary ? (
          <div className="flex flex-col gap-3 overflow-y-auto max-h-[calc(100vh-18rem)]">
            <p className="text-[11px] text-muted-foreground">
              {summary.changeLabel}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <PreviewPane label="Before" text={summary.before} />
              <PreviewPane label="After" text={summary.after} />
            </div>
            <ul className="flex flex-col gap-1 text-[10.5px] text-muted-foreground">
              {summary.notes.map((note) => (
                <li key={note}>· {note}</li>
              ))}
            </ul>
            <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-card/40 px-3 py-2">
              {request.action === "install" ? (
                <>
                  <Label>
                    Before {displayAgent(request.agent)} uses these hooks
                  </Label>
                  <ol className="flex list-decimal flex-col gap-1 pl-4 text-[10.5px] leading-relaxed text-muted-foreground">
                    {summary.activation.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                </>
              ) : (
                <span className="text-[10.5px] leading-relaxed text-muted-foreground">
                  Removal deletes only entries that invoke this fork's CLI.
                  Upstream Terax, other tools and your own hooks stay exactly as
                  they are; a running agent keeps its current hooks until it
                  restarts.
                </span>
              )}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={!confirmable(state)}
            onClick={() => void confirm()}
          >
            {summary?.confirmLabel ?? "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewPane({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label>{label}</Label>
      <pre className="max-h-52 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all select-text">
        {text}
      </pre>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

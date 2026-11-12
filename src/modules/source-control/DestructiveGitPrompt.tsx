import type { DestructivePlan } from "@/modules/git";
import { destructivePlanMessage, missingAcknowledgements } from "@/modules/git";

export type DestructivePromptState = {
  unsavedBuffers: number[];
  activeWork: number[];
  force: boolean;
};

type Props = {
  plan: DestructivePlan;
  acknowledged: DestructivePromptState;
  onChange: (next: DestructivePromptState) => void;
  /** Recheck result after the plan this dialog showed went stale. */
  stale: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  actionLabel: string;
};

function toggle(list: number[], id: number, checked: boolean): number[] {
  return checked ? [...list, id] : list.filter((value) => value !== id);
}

/**
 * The destructive-action prompt: affected paths, staging effects, unsaved
 * buffers and active work are shown before anything is mutated. A dirty buffer
 * is a checkbox the user must tick; `force` is a separate checkbox and never
 * clears one of those.
 */
export function DestructiveGitPrompt({
  plan,
  acknowledged,
  onChange,
  stale,
  busy,
  error,
  onCancel,
  onConfirm,
  actionLabel,
}: Props) {
  const missing = missingAcknowledgements(plan, acknowledged);
  const canConfirm =
    !busy &&
    missing.unsavedBuffers.length === 0 &&
    missing.activeWork.length === 0;

  return (
    <div className="grid gap-3 text-sm">
      <p className="text-muted-foreground">{destructivePlanMessage(plan)}</p>
      {stale ? (
        <p
          role="alert"
          data-destructive-stale="true"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-amber-200"
        >
          {stale}
        </p>
      ) : null}
      {plan.blockers.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 font-medium">Work this action affects</legend>
          {plan.blockers.map((blocker) =>
            blocker.kind === "unsavedBuffer" ? (
              <label
                key={`buffer:${blocker.tabId}`}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={acknowledged.unsavedBuffers.includes(blocker.tabId)}
                  onChange={(event) =>
                    onChange({
                      ...acknowledged,
                      unsavedBuffers: toggle(
                        acknowledged.unsavedBuffers,
                        blocker.tabId,
                        event.target.checked,
                      ),
                    })
                  }
                />
                <span>
                  Discard unsaved changes to{" "}
                  <code className="text-xs">{blocker.path}</code> in Space{" "}
                  {blocker.spaceName}
                  {blocker.outsideSpaceRoot
                    ? " (an editor view outside that Space's root)"
                    : ""}
                </span>
              </label>
            ) : (
              <label
                key={`work:${blocker.leafId}`}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={acknowledged.activeWork.includes(blocker.leafId)}
                  onChange={(event) =>
                    onChange({
                      ...acknowledged,
                      activeWork: toggle(
                        acknowledged.activeWork,
                        blocker.leafId,
                        event.target.checked,
                      ),
                    })
                  }
                />
                <span>
                  Continue while a terminal in Space {blocker.spaceName} may
                  still be running
                  {blocker.busy === "uncertain"
                    ? " (the process check did not complete)"
                    : ""}
                </span>
              </label>
            ),
          )}
        </fieldset>
      ) : null}
      {plan.force ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={acknowledged.force}
            onChange={(event) =>
              onChange({ ...acknowledged, force: event.target.checked })
            }
          />
          <span>
            Force {actionLabel} despite on-disk Git blockers. This does not save
            or discard any editor buffer.
          </span>
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          data-can-confirm={canConfirm ? "true" : "false"}
          className="rounded-md bg-destructive px-3 py-1.5 text-destructive-foreground disabled:opacity-50"
          onClick={onConfirm}
          disabled={!canConfirm}
        >
          {busy ? "Working…" : `Continue ${actionLabel}`}
        </button>
      </div>
    </div>
  );
}

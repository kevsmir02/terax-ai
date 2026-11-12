import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { git } from "@/modules/git";
import {
  assessDestructiveAction,
  createDestructiveGitGuard,
  missingAcknowledgements,
  resolveDestructiveUsage,
  type CanonicalizePath,
  type DestructiveGitGuard,
  type DestructivePlan,
  type DestructiveUsageSource,
} from "@/modules/git";
import type {
  CheckpointGroups,
  WorktreeRemoveReport,
} from "@/modules/git/types";
import { FolderRemoveIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  affectedSpaces,
  canForceRemoval,
  hasForceableBlocker,
  recoveryRefsToDelete,
  removalBlockers,
  removalRefusal,
  removalResultText,
} from "./lib/removeWorktree";
import {
  registerWorktreeRemovalBridge,
  type WorktreeRemovalAcknowledgement,
  type WorktreeRemovalBridge,
} from "./worktreeRemovalBridge";

/** The two cross-Space inputs the destructive-action plan needs. */
export type WorktreeRemovalSupport = {
  usage: () => DestructiveUsageSource;
  canonicalize: CanonicalizePath;
};

export type WorktreeRemoveBodyProps = {
  path: string;
  report: WorktreeRemoveReport | null;
  groups: CheckpointGroups | null;
  plan: DestructivePlan | null;
  acknowledged: WorktreeRemovalAcknowledgement;
  onChange: (next: WorktreeRemovalAcknowledgement) => void;
  stale: string | null;
  error: string | null;
  busy: boolean;
  cleanupBusy: boolean;
  removed: WorktreeRemoveReport | null;
  onCancel: () => void;
  onConfirm: () => void;
  onCleanup: () => void;
};

function toggle(list: number[], id: number, checked: boolean): number[] {
  return checked ? [...list, id] : list.filter((value) => value !== id);
}

/**
 * The dialog's markup as a pure function of its state, so the render can be
 * asserted without a DOM and the real-app lab drives the stateful wrapper.
 */
export function WorktreeRemoveBody({
  path,
  report,
  groups,
  plan,
  acknowledged,
  onChange,
  stale,
  error,
  busy,
  cleanupBusy,
  removed,
  onCancel,
  onConfirm,
  onCleanup,
}: WorktreeRemoveBodyProps) {
  const refs = groups ? recoveryRefsToDelete(groups) : [];
  const blockerLines = report ? removalBlockers(report) : [];
  const forceable = report !== null && canForceRemoval(report);
  const locked = report?.blockers.includes("locked") ?? false;
  const retained = (report?.recovery.total ?? 0) > 0 || refs.length > 0;
  const missing = plan
    ? missingAcknowledgements(plan, acknowledged)
    : { unsavedBuffers: [], activeWork: [] };
  const needsForce =
    forceable && hasForceableBlocker(report) && !acknowledged.force;
  const canConfirm =
    !busy &&
    !cleanupBusy &&
    plan !== null &&
    report !== null &&
    !removed &&
    !locked &&
    !retained &&
    !needsForce &&
    missing.unsavedBuffers.length === 0 &&
    missing.activeWork.length === 0;
  const spaces = plan ? affectedSpaces(plan.activeWork) : [];

  if (removed) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon
              icon={FolderRemoveIcon}
              size={16}
              strokeWidth={1.75}
            />
            Worktree removed
          </DialogTitle>
          <DialogDescription>
            The folder is no longer a checkout of this repository.
          </DialogDescription>
        </DialogHeader>
        <p
          data-worktree-removal-done={removed.path}
          className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-[12px] leading-snug"
        >
          {removalResultText(removed)}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Done
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-1.75">
          <HugeiconsIcon icon={FolderRemoveIcon} size={16} strokeWidth={1.75} />
          Remove worktree?
        </DialogTitle>
        <DialogDescription>
          The working folder is deleted from disk. Nothing is changed until the
          blockers below are resolved and the confirmation is rechecked.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
        <code className="break-all text-[12px]" title={path}>
          {path}
        </code>
        <div className="text-[11.5px] text-muted-foreground">
          {report?.branch ? `Branch ${report.branch}` : "Detached HEAD"}
        </div>
      </div>

      {blockerLines.length > 0 ? (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-[12px] font-medium">
            What removal would refuse or lose
          </legend>
          <ul className="grid gap-1 text-[11.5px] leading-snug">
            {blockerLines.map((line) => (
              <li
                key={line.kind}
                data-worktree-removal-blocker={line.kind}
                className={
                  line.kind === "recoveryRefs" || line.kind === "locked"
                    ? "text-amber-500"
                    : "text-muted-foreground"
                }
              >
                {line.text}
              </li>
            ))}
          </ul>
        </fieldset>
      ) : null}

      {report && report.recovery.total > 0 ? (
        <div className="grid gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5">
          <span className="text-[11.5px] font-medium">
            Recovery points this worktree still owns
          </span>
          {report.recovery.sample.length > 0 ? (
            <ul className="grid gap-0.5 text-[11px] leading-snug text-muted-foreground">
              {report.recovery.sample.slice(0, 5).map((reference) => (
                <li key={reference} className="break-all">
                  <code>{reference}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            data-worktree-removal-cleanup={refs.length}
            disabled={cleanupBusy || refs.length === 0}
            onClick={onCleanup}
          >
            {cleanupBusy
              ? "Deleting…"
              : `Delete ${refs.length} recovery point${refs.length === 1 ? "" : "s"}`}
          </Button>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Deletes only this worktree&apos;s refs, which is what unblocks
            removal. Content objects stay until Git itself prunes them; no
            garbage collection runs and no other worktree is touched.
          </p>
        </div>
      ) : null}

      {plan && plan.blockers.length > 0 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[12px] font-medium">
            Work this removal affects in every Space
          </legend>
          {plan.blockers.map((blocker) =>
            blocker.kind === "unsavedBuffer" ? (
              <label
                key={`buffer:${blocker.tabId}`}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5 text-[11.5px]"
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
                  Delete unsaved changes to{" "}
                  <code className="text-[11px]">{blocker.path}</code> in Space{" "}
                  {blocker.spaceName}
                  {blocker.outsideSpaceRoot
                    ? " (an editor view outside that Space's root)"
                    : ""}
                </span>
              </label>
            ) : (
              <label
                key={`work:${blocker.leafId}`}
                className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5 text-[11.5px]"
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
                    ? " (the check did not complete)"
                    : ""}
                </span>
              </label>
            ),
          )}
        </fieldset>
      ) : null}

      {spaces.length > 0 ? (
        <p
          data-worktree-removal-spaces={spaces.join(",")}
          className="text-[11px] leading-snug text-muted-foreground"
        >
          Terminals in {spaces.join(", ")} have a working directory inside this
          worktree. Their Spaces and tabs stay; the folder they point at does
          not.
        </p>
      ) : null}

      {forceable && report !== null && hasForceableBlocker(report) ? (
        <label className="flex items-start gap-2 text-[11.5px]">
          <input
            type="checkbox"
            checked={acknowledged.force}
            onChange={(event) =>
              onChange({ ...acknowledged, force: event.target.checked })
            }
          />
          <span>
            Force removal despite on-disk Git blockers. This never deletes a
            retained recovery point, and it does not save or discard any editor
            buffer.
          </span>
        </label>
      ) : null}

      {stale ? (
        <p
          role="alert"
          data-worktree-removal-stale="true"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11.5px] text-amber-200"
        >
          {stale}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          data-worktree-removal-error="true"
          className="break-words text-[11.5px] leading-snug text-destructive"
        >
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          data-worktree-removal-ready={canConfirm ? "true" : "false"}
          disabled={!canConfirm}
          onClick={onConfirm}
        >
          {busy ? "Removing…" : "Remove worktree"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Which worktree, and the repository that listed it. */
export type WorktreeRemovalTarget = {
  repoRoot: string;
  path: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string | null;
  path: string | null;
  support: WorktreeRemovalSupport;
  onRemoved?: (report: WorktreeRemoveReport) => void;
};

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "The worktree removal failed.";
}

/**
 * The stateful dialog: a native preflight, the destructive-action plan for
 * every Space, one explicit recovery-ref cleanup, then the guarded native
 * removal. The native command stays the authority; a plan that went stale is
 * refused with the refreshed blockers instead of being replayed.
 */
export function WorktreeRemoveDialog({
  open,
  onOpenChange,
  repoRoot,
  path,
  support,
  onRemoved,
}: Props) {
  const [report, setReport] = useState<WorktreeRemoveReport | null>(null);
  const [groups, setGroups] = useState<CheckpointGroups | null>(null);
  const [plan, setPlan] = useState<DestructivePlan | null>(null);
  const [acknowledged, setAcknowledged] =
    useState<WorktreeRemovalAcknowledgement>({
      unsavedBuffers: [],
      activeWork: [],
      force: false,
    });
  const [busy, setBusy] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<WorktreeRemoveReport | null>(null);

  const supportRef = useRef(support);
  supportRef.current = support;
  const removedRef = useRef<WorktreeRemoveReport | null>(null);
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const repoRootRef = useRef(repoRoot);
  repoRootRef.current = repoRoot;

  const guardRef = useRef<DestructiveGitGuard | null>(null);
  const guard =
    guardRef.current ??
    createDestructiveGitGuard({
      inspect: async (action) => {
        const current = supportRef.current;
        // The rendered Source Control status belongs to the repository, so a
        // removal plan asks the target worktree itself. A missing directory has
        // no status: there are no working files left to list.
        const status = await git.status(action.worktreeRoot).catch(() => null);
        return assessDestructiveAction({
          action,
          status,
          usage: await resolveDestructiveUsage(
            current.usage(),
            current.canonicalize,
          ),
          canonicalize: current.canonicalize,
        });
      },
      mutate: async (action) => {
        const root = repoRootRef.current;
        if (!root) throw new Error("The repository is not known.");
        const result = await git.worktreeRemove(
          root,
          action.worktreeRoot,
          action.force === true,
        );
        if (!result.removed)
          throw new Error(errorMessage(removalRefusal(result)));
        removedRef.current = result;
        onRemovedRef.current?.(result);
      },
    });
  guardRef.current = guard;

  const refresh = useCallback(async () => {
    const root = repoRootRef.current;
    if (!root || !path) return;
    try {
      const next = await git.worktreeRemovePreflight(root, path);
      setReport(next);
    } catch (failure) {
      setError(errorMessage(failure));
    }
    try {
      setGroups(await git.checkpointGroupsAt(root, path));
    } catch {
      // No administrative entry means no owned refs to name; the report's
      // counts are still the refusal.
      setGroups(null);
    }
  }, [path]);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setGroups(null);
    setPlan(null);
    setAcknowledged({ unsavedBuffers: [], activeWork: [], force: false });
    setBusy(false);
    setCleanupBusy(false);
    setStale(null);
    setError(null);
    setRemoved(null);
    removedRef.current = null;
    guard.cancel();
  }, [open, guard]);

  // The panel may still be resolving its repository when the dialog opens: the
  // preflight runs as soon as both the path and the repository are known.
  useEffect(() => {
    if (!open || !repoRoot || !path || removed) return;
    void refresh();
  }, [open, repoRoot, path, removed, refresh]);

  const requestPlan = useCallback(
    async (force: boolean) => {
      const root = repoRootRef.current;
      if (!root || !path) return null;
      try {
        const next = await guard.request({
          kind: "worktreeRemove",
          repoRoot: root,
          worktreeRoot: path,
          force,
        });
        setPlan(next);
        return next;
      } catch (failure) {
        setError(errorMessage(failure));
        return null;
      }
    },
    [guard, path],
  );

  useEffect(() => {
    if (!open || !repoRoot || !path || removed) return;
    void requestPlan(acknowledged.force);
  }, [open, repoRoot, path, removed, acknowledged.force, requestPlan]);

  const confirm = useCallback(async () => {
    if (busy || !plan) return;
    setBusy(true);
    setStale(null);
    setError(null);
    try {
      const result = await guard.confirm({
        fingerprint: plan.fingerprint,
        unsavedBuffers: acknowledged.unsavedBuffers,
        activeWork: acknowledged.activeWork,
        force: acknowledged.force,
      });
      switch (result.status) {
        case "done":
          setRemoved(removedRef.current);
          break;
        case "stale":
        case "unacknowledged":
          setPlan(result.plan);
          setStale(result.message);
          break;
        case "failed": {
          // The guard drops its pending plan before mutating, so a refused
          // attempt has to be planned again before it can be confirmed.
          await refresh();
          await requestPlan(acknowledged.force);
          setError(errorMessage(result.error));
          break;
        }
        case "busy":
          setError(result.message);
          break;
        default:
          break;
      }
    } finally {
      setBusy(false);
    }
  }, [acknowledged, busy, guard, plan, refresh, requestPlan]);

  const cleanup = useCallback(async () => {
    const root = repoRootRef.current;
    if (cleanupBusy || !root || !path) return;
    setCleanupBusy(true);
    setError(null);
    setStale(null);
    try {
      // Re-list immediately before deleting: only refs this worktree owns now.
      const fresh = await git.checkpointGroupsAt(root, path);
      const refs = recoveryRefsToDelete(fresh);
      setGroups(fresh);
      if (refs.length > 0) {
        const result = await git.checkpointCleanupAt(root, path, refs);
        setGroups(result.remaining);
        if (result.refused.length > 0) {
          setError(
            `Cleanup kept ${result.refused.length} ref${result.refused.length === 1 ? "" : "s"}: ${result.refused
              .map((entry) => `${entry.ref} (${entry.reason})`)
              .join(", ")}.`,
          );
        }
      }
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
      await refresh();
    } finally {
      setCleanupBusy(false);
    }
  }, [cleanupBusy, path, refresh]);

  const latest = useRef({
    repoRoot,
    path,
    report,
    groups,
    plan,
    acknowledged,
    removed,
    busy,
    cleanupBusy,
    stale,
    error,
    confirm,
    cleanup,
    onOpenChange,
    setAcknowledged,
  });
  latest.current = {
    repoRoot,
    path,
    report,
    groups,
    plan,
    acknowledged,
    removed,
    busy,
    cleanupBusy,
    stale,
    error,
    confirm,
    cleanup,
    onOpenChange,
    setAcknowledged,
  };

  useEffect(() => {
    if (!open || !path) return;
    const bridge: WorktreeRemovalBridge = {
      state: () => {
        const now = latest.current;
        const refs = now.groups ? recoveryRefsToDelete(now.groups) : [];
        const retained =
          (now.report?.recovery.total ?? 0) > 0 || refs.length > 0;
        const missing = now.plan
          ? missingAcknowledgements(now.plan, now.acknowledged)
          : { unsavedBuffers: [], activeWork: [] };
        const forceable = now.report !== null && canForceRemoval(now.report);
        return {
          repoRoot: now.repoRoot,
          path: now.path,
          report: now.report,
          groups: now.groups,
          plan: now.plan,
          acknowledged: now.acknowledged,
          removed: now.removed,
          busy: now.busy,
          cleanupBusy: now.cleanupBusy,
          stale: now.stale,
          error: now.error,
          canConfirm:
            now.plan !== null &&
            now.report !== null &&
            now.removed === null &&
            !now.busy &&
            !now.cleanupBusy &&
            !retained &&
            !(now.report?.blockers.includes("locked") ?? false) &&
            !(
              forceable &&
              now.report !== null &&
              hasForceableBlocker(now.report) &&
              !now.acknowledged.force
            ) &&
            missing.unsavedBuffers.length === 0 &&
            missing.activeWork.length === 0,
        };
      },
      cleanup: () => latest.current.cleanup(),
      setForce: (force) =>
        latest.current.setAcknowledged((current) => ({ ...current, force })),
      confirm: () => latest.current.confirm(),
      close: () => latest.current.onOpenChange(false),
    };
    return registerWorktreeRemovalBridge(bridge);
  }, [open, path]);

  const close = useCallback(() => {
    if (busy || cleanupBusy) return;
    onOpenChange(false);
  }, [busy, cleanupBusy, onOpenChange]);

  const body = useMemo(
    () => (
      <WorktreeRemoveBody
        path={path ?? ""}
        report={report}
        groups={groups}
        plan={plan}
        acknowledged={acknowledged}
        onChange={setAcknowledged}
        stale={stale}
        error={error}
        busy={busy}
        cleanupBusy={cleanupBusy}
        removed={removed}
        onCancel={close}
        onConfirm={() => void confirm()}
        onCleanup={() => void cleanup()}
      />
    ),
    [
      acknowledged,
      busy,
      cleanup,
      cleanupBusy,
      close,
      confirm,
      error,
      groups,
      path,
      plan,
      removed,
      report,
      stale,
    ],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (busy || cleanupBusy)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        {body}
      </DialogContent>
    </Dialog>
  );
}

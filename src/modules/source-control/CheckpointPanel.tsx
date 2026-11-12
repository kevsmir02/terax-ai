import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  assessDestructiveAction,
  git,
  manualRestoreMessage,
  restorableRecoveryRefs,
  restorePrecondition,
  type CheckpointGroups,
  type CheckpointInspection,
  type DestructiveAction,
  type DestructiveGitGuard,
  type DestructivePlan,
  type ManualRestorePreview,
  createDestructiveGitGuard,
  resolveDestructiveUsage,
} from "@/modules/git";
import {
  Clock01Icon,
  Delete02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerCheckpointBridge,
  type CheckpointBridgePending,
} from "./checkpointBridge";
import {
  DestructiveGitPrompt,
  type DestructivePromptState,
} from "./DestructiveGitPrompt";
import type { DestructiveGitSupport } from "./useSourceControlPanel";

type Props = {
  worktree: string | null;
  destructive: DestructiveGitSupport;
  /** The checkout changed: refresh the source-control view and diffs. */
  onMutated: () => void;
};

type PendingRestore = {
  plan: DestructivePlan;
  preview: ManualRestorePreview;
};

const EMPTY_ACK: DestructivePromptState = {
  unsavedBuffers: [],
  activeWork: [],
  force: false,
};

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "The checkpoint action failed.";
}

function shortRef(ref: string): string {
  const id = ref.split("/").pop() ?? ref;
  return id.length > 12 ? id.slice(0, 12) : id;
}

function when(secs: number): string {
  if (!secs) return "unknown time";
  return new Date(secs * 1000).toLocaleString();
}

function captureNote(
  capture: {
    incomplete: boolean;
    warnings: string[];
    ignoredFiles: number;
  } | null,
): string | null {
  if (!capture) return null;
  const parts: string[] = [];
  if (capture.incomplete) parts.push("incomplete capture");
  if (capture.ignoredFiles > 0) {
    parts.push(
      `${capture.ignoredFiles} ignored ${capture.ignoredFiles === 1 ? "entry" : "entries"} not captured`,
    );
  }
  if (capture.warnings.length > 0) parts.push(capture.warnings.join(", "));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The visible checkpoint panel: create, list, inspect, clean up and restore.
 * Restore goes through the same shared destructive guard as every other
 * mutating Git action, after the native preflight names the affected paths and
 * the required safety capture is a precondition.
 */
export function CheckpointPanel({ worktree, destructive, onMutated }: Props) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<CheckpointGroups | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [inspection, setInspection] = useState<CheckpointInspection | null>(
    null,
  );
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [pendingStale, setPendingStale] = useState<string | null>(null);
  const [ack, setAck] = useState<DestructivePromptState>(EMPTY_ACK);

  const worktreeRef = useRef(worktree);
  const destructiveRef = useRef(destructive);
  const groupsRef = useRef<CheckpointGroups | null>(null);
  const pendingRef = useRef<PendingRestore | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<string | null>(null);
  const messageRef = useRef<string | null>(null);
  const onMutatedRef = useRef(onMutated);
  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const openedRef = useRef(false);
  const requestRestoreRef = useRef<(ref: string) => Promise<void>>(
    async () => {},
  );
  const cleanupRef = useRef<(ref: string) => Promise<void>>(async () => {});

  useEffect(() => {
    worktreeRef.current = worktree;
  }, [worktree]);
  useEffect(() => {
    destructiveRef.current = destructive;
  }, [destructive]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);
  useEffect(() => {
    onMutatedRef.current = onMutated;
  }, [onMutated]);

  const reload = useCallback(async (root?: string) => {
    const target = root ?? worktreeRef.current;
    if (!target) {
      setGroups(null);
      return;
    }
    setLoading(true);
    try {
      setGroups(await git.checkpointGroups(target));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);
  reloadRef.current = reload;

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  // A new worktree is a new list.
  useEffect(() => {
    if (open) {
      setInspection(null);
      setGroups(null);
      void reload(worktree ?? undefined);
    }
  }, [worktree, open, reload]);

  const guardRef = useRef<DestructiveGitGuard | null>(null);
  const guard =
    guardRef.current ??
    createDestructiveGitGuard({
      inspect: async (action: DestructiveAction) => {
        const support = destructiveRef.current;
        const fresh = await git.status(action.repoRoot);
        return assessDestructiveAction({
          action,
          status: fresh,
          usage: await resolveDestructiveUsage(
            support.usage(),
            support.canonicalize,
          ),
          canonicalize: support.canonicalize,
        });
      },
      mutate: async (action: DestructiveAction) => {
        if (action.kind !== "restore") return;
        const root = worktreeRef.current;
        if (!root) return;
        const report = await git.checkpointRestoreManual(
          root,
          action.ref,
          action.previewFingerprint,
          action.force === true,
        );
        const text = manualRestoreMessage(report);
        setMessage(report.restored ? text : null);
        setError(report.restored ? null : text);
        await reloadRef.current();
        onMutatedRef.current();
        if (!report.restored) {
          throw new Error(text);
        }
      },
    });
  guardRef.current = guard;

  const requestRestore = useCallback(
    async (ref: string) => {
      const root = worktreeRef.current;
      if (!root || busyRef.current) return;
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const preview = await git.checkpointRestorePreview(root, ref);
        const precondition = restorePrecondition(preview);
        if (precondition) {
          setError(precondition);
          return;
        }
        if (preview.affectedTotal === 0) {
          setMessage(
            "The working tree already matches this checkpoint; nothing to restore.",
          );
          return;
        }
        const action: DestructiveAction = {
          kind: "restore",
          repoRoot: root,
          worktreeRoot: root,
          ref,
          paths: preview.affected.map((path) => path.path),
          previewFingerprint: preview.fingerprint,
        };
        const plan = await guard.request(action);
        if (!plan) {
          setError(
            "Another destructive Git action is starting or running; wait for it to finish.",
          );
          return;
        }
        setAck(EMPTY_ACK);
        setPendingStale(null);
        setPending({ plan, preview });
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [guard],
  );
  requestRestoreRef.current = requestRestore;

  const confirmRestore = useCallback(
    async (confirmation: DestructivePromptState) => {
      if (!pending || busyRef.current) return;
      setBusy(true);
      try {
        const result = await guard.confirm({
          fingerprint: pending.plan.fingerprint,
          unsavedBuffers: confirmation.unsavedBuffers,
          activeWork: confirmation.activeWork,
          force: confirmation.force,
        });
        switch (result.status) {
          case "done":
            setPending(null);
            break;
          case "stale":
          case "unacknowledged":
            setPending({ ...pending, plan: result.plan });
            setPendingStale(result.message);
            setError(result.message);
            break;
          case "failed":
            setPending(null);
            setError(result.error);
            break;
          case "busy":
            setError(result.message);
            break;
          case "idle":
            setPending(null);
            break;
        }
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [guard, pending],
  );

  const cancelRestore = useCallback(() => {
    if (busyRef.current) return;
    guard.cancel();
    setPending(null);
    setPendingStale(null);
  }, [guard]);

  const create = useCallback(async (value: string | null) => {
    const root = worktreeRef.current;
    if (!root) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const created = await git.checkpointManualCreate(
        root,
        value && value.trim() !== "" ? value.trim() : null,
      );
      setMessage(
        `Captured ${created.name ?? "an unnamed checkpoint"} (${created.id.slice(0, 8)}).${
          created.capture?.incomplete
            ? " The capture was incomplete; it is recoverable but not a complete backup."
            : ""
        }`,
      );
      setName("");
      await reloadRef.current();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const inspect = useCallback(async (ref: string) => {
    const root = worktreeRef.current;
    if (!root) return;
    setError(null);
    try {
      const found = await git.checkpointInspect(root, ref);
      setInspection((current) => (current?.ref === ref ? null : found));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const cleanup = useCallback(async (ref: string) => {
    const root = worktreeRef.current;
    if (!root) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const report = await git.checkpointCleanup(root, [ref]);
      setDeleteCandidate(null);
      const removed = report.removed.length;
      const refused = report.refused[0]?.reason;
      setMessage(
        removed === 1
          ? "Deleted the named recovery ref. Its objects remain shared until Git prunes them; this does not promise reclaimed bytes."
          : `The recovery ref was not deleted${refused ? `: ${refused}` : ""}.`,
      );
      setGroups(report.remaining);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  // The real-app lab drives this panel, never a second implementation.
  useEffect(() => {
    cleanupRef.current = cleanup;
    return registerCheckpointBridge({
      mounted: () => worktreeRef.current !== null,
      ready: () => openedRef.current && groupsRef.current !== null,
      open: () => {
        openedRef.current = true;
        setOpen(true);
      },
      close: () => {
        openedRef.current = false;
        setOpen(false);
      },
      create: (value) => create(value),
      groups: () => {
        const current = groupsRef.current;
        return current
          ? {
              manual: current.manual.length,
              safety: current.safety.length,
              turns: current.turns.length,
            }
          : null;
      },
      requestRestore: (ref) =>
        requestRestoreRef.current?.(ref) ?? Promise.resolve(),
      cleanup: (ref) => cleanupRef.current?.(ref) ?? Promise.resolve(),
      pending: (): CheckpointBridgePending | null => {
        const current = pendingRef.current;
        if (!current) return null;
        return {
          kind: "restore",
          ref:
            current.plan.action.kind === "restore"
              ? current.plan.action.ref
              : "",
          fingerprint: current.plan.fingerprint,
          previewFingerprint: current.preview.fingerprint,
          stale: pendingStale,
          affected: current.plan.affected.map((path) => path.path),
          blockers: current.plan.blockers.map((blocker) =>
            blocker.kind === "unsavedBuffer"
              ? {
                  kind: "unsavedBuffer" as const,
                  tabId: blocker.tabId,
                  spaceName: blocker.spaceName,
                  path: blocker.path,
                  outsideSpaceRoot: blocker.outsideSpaceRoot,
                }
              : {
                  kind: "activeTerminal" as const,
                  leafId: blocker.leafId,
                  spaceName: blocker.spaceName,
                  busy: blocker.busy,
                },
          ),
          force: current.plan.force,
          stagedTotal: current.preview.stagedTotal,
          ignoredInTheWay: current.preview.ignoredInTheWay,
          headMoved: current.preview.headMoved,
          requiresSafetyCapture: current.preview.requiresSafetyCapture,
        };
      },
      confirm: async (confirmation) => {
        await confirmRestore({
          unsavedBuffers: confirmation.unsavedBuffers,
          activeWork: confirmation.activeWork,
          force: confirmation.force,
        });
      },
      cancel: () => cancelRestore(),
      busy: () => busyRef.current,
      error: () => errorRef.current,
      message: () => messageRef.current,
    });
  }, [cancelRestore, cleanup, confirmRestore, create, pendingStale]);

  const restorable = groups ? restorableRecoveryRefs(groups) : [];
  const manual = restorable.filter((entry) => entry.kind === "manual");
  const safety = restorable.filter((entry) => entry.kind === "safety");
  const manualRow = (entry: (typeof manual)[number]) => {
    const note = entry.capture ? captureNote(entry.capture) : null;
    return (
      <li
        key={entry.ref}
        className="flex items-center gap-2 rounded-md border border-border/55 px-2 py-1.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium">
              {entry.name ?? "unnamed checkpoint"}
            </span>
            {entry.capture?.incomplete ? (
              <Badge variant="outline" className="text-[9.5px]">
                incomplete
              </Badge>
            ) : null}
          </div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {shortRef(entry.ref)} · {when(entry.createdAtSecs)}
            {note ? ` · ${note}` : ""}
          </div>
        </div>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Inspect checkpoint ${entry.ref}`}
          disabled={busy}
          onClick={() => void inspect(entry.ref)}
        >
          <HugeiconsIcon icon={ViewIcon} size={12} strokeWidth={1.8} />
        </Button>
        <Button
          size="xs"
          variant="secondary"
          aria-label={`Restore checkpoint ${entry.ref}`}
          disabled={busy}
          onClick={() => void requestRestore(entry.ref)}
        >
          Restore
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Delete checkpoint ${entry.ref}`}
          disabled={busy}
          onClick={() => setDeleteCandidate(entry.ref)}
        >
          <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.8} />
        </Button>
      </li>
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label="Checkpoints"
        title="Checkpoints"
        disabled={!worktree}
        onClick={() => setOpen(true)}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.85} />
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          openedRef.current = next;
          setOpen(next);
        }}
      >
        <DialogContent
          className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
          data-checkpoint-panel="true"
        >
          <DialogHeader>
            <DialogTitle>Checkpoints</DialogTitle>
            <DialogDescription>
              Manual recovery points, kept until explicitly deleted. A capture
              is not a complete backup: ignored files, submodule contents and
              staging are not included, and an independent writer is not
              excluded. Restoring publishes a required safety ref before
              changing any file or index entry.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional name"
              aria-label="Checkpoint name"
              className="h-8 text-[12px]"
              onKeyDown={(event) => {
                if (event.key === "Enter") void create(name);
              }}
            />
            <Button
              size="sm"
              disabled={busy || !worktree}
              onClick={() => void create(name)}
            >
              Create checkpoint
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh checkpoints"
              disabled={busy || loading}
              onClick={() => void reload()}
            >
              {loading ? <Spinner className="size-3" /> : "↻"}
            </Button>
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11.5px] text-destructive"
            >
              {error}
            </p>
          ) : null}
          {message ? (
            <p className="rounded-md border border-border/60 bg-foreground/[0.04] px-2 py-1.5 text-[11.5px] text-muted-foreground">
              {message}
            </p>
          ) : null}

          {!worktree ? (
            <p className="text-[11.5px] text-muted-foreground">
              Open a repository to use checkpoints.
            </p>
          ) : loading && !groups ? (
            <p className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <Spinner className="size-3" /> Loading recovery points…
            </p>
          ) : (
            <>
              <section className="space-y-1.5">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Manual checkpoints
                </h3>
                {manual.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    No manual checkpoints in this worktree.
                  </p>
                ) : (
                  <ul className="space-y-1.5">{manual.map(manualRow)}</ul>
                )}
              </section>

              <section className="space-y-1.5">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Restore safety refs
                </h3>
                {safety.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    No restore safety refs yet. Restoring a checkpoint adds one.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {safety.map((entry) => (
                      <li
                        key={entry.ref}
                        className="flex items-center gap-2 rounded-md border border-border/55 px-2 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium">
                            Safety before restore
                          </div>
                          <div className="truncate text-[10.5px] text-muted-foreground">
                            {shortRef(entry.ref)} · {when(entry.createdAtSecs)}{" "}
                            · content only
                          </div>
                        </div>
                        <Button
                          size="xs"
                          variant="secondary"
                          aria-label={`Restore safety ref ${entry.ref}`}
                          disabled={busy}
                          onClick={() => void requestRestore(entry.ref)}
                        >
                          Recover content
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Delete safety ref ${entry.ref}`}
                          disabled={busy}
                          onClick={() => setDeleteCandidate(entry.ref)}
                        >
                          <HugeiconsIcon
                            icon={Delete02Icon}
                            size={12}
                            strokeWidth={1.8}
                          />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {groups && groups.turns.length > 0 ? (
                <p className="text-[10.5px] text-muted-foreground">
                  {groups.turns.length} retained per-turn checkpoint
                  {groups.turns.length === 1 ? "" : "s"} use the retained
                  checkpoint restore path and are not restored here.
                </p>
              ) : null}

              {groups ? (
                <p className="text-[10.5px] leading-snug text-muted-foreground">
                  {groups.storage.ownedRefs} recovery refs this worktree owns.{" "}
                  {groups.storage.looseObjects} loose objects (
                  {groups.storage.looseKib} KiB) are repository-wide and shared;
                  deleting a ref removes reachability, not bytes, and this app
                  never runs Git garbage collection.
                </p>
              ) : null}

              {inspection ? (
                <section className="space-y-1 rounded-md border border-border/60 bg-foreground/[0.03] p-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-[11px] font-semibold">
                      {inspection.name ?? shortRef(inspection.ref)} ·{" "}
                      {inspection.kind}
                    </h3>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setInspection(null)}
                    >
                      Close
                    </Button>
                  </div>
                  <p className="text-[10.5px] text-muted-foreground">
                    {inspection.changedTotal} captured paths
                    {inspection.changedTruncated ? " (list capped)" : ""} · HEAD{" "}
                    {inspection.headMoved ? "moved since capture" : "unchanged"}
                    {inspection.capture
                      ? ` · ignored ${inspection.capture.ignoredFiles}, staged ${inspection.capture.stagedFiles}, submodules ${inspection.capture.submodules} (not captured)`
                      : ""}
                  </p>
                  <ul className="max-h-40 overflow-y-auto text-[10.5px]">
                    {inspection.changedPaths.map((change) => (
                      <li key={change.path} className="truncate">
                        <span className="text-muted-foreground">
                          {change.status}
                        </span>{" "}
                        {change.path}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) cancelRestore();
        }}
      >
        <AlertDialogContent data-checkpoint-pending="true">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore captured content?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing is changed until the affected paths, staging effect and
              active work are reviewed and this confirmation is rechecked. A
              required safety ref is published first; a failed or incomplete
              capture refuses even with force.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending ? (
            <>
              <section className="space-y-1 rounded-md border border-border/60 px-2 py-1.5 text-[11px]">
                <p className="font-medium">
                  {pending.preview.affectedTotal} affected{" "}
                  {pending.preview.affectedTotal === 1 ? "path" : "paths"} ·
                  HEAD unchanged · index entries of touched paths reset to HEAD
                </p>
                <ul className="max-h-32 overflow-y-auto">
                  {pending.preview.affected.slice(0, 12).map((path) => (
                    <li key={path.path} className="truncate">
                      <span className="text-muted-foreground">
                        {path.effect === "removed" ? "remove" : "restore"}
                      </span>{" "}
                      {path.path}
                      {path.staged ? " (staged copy not preserved)" : ""}
                    </li>
                  ))}
                  {pending.preview.affected.length > 12 ? (
                    <li className="text-muted-foreground">
                      and {pending.preview.affected.length - 12} more
                    </li>
                  ) : null}
                </ul>
                <p className="text-muted-foreground">
                  {pending.preview.stagedTotal} staged affected{" "}
                  {pending.preview.stagedTotal === 1 ? "path" : "paths"} ·{" "}
                  {pending.preview.ignoredInTheWay} ignored in the way (left
                  alone) · Safety capture required · not atomic; independent
                  writers are outside the application's control.
                </p>
              </section>
              <DestructiveGitPrompt
                plan={pending.plan}
                acknowledged={ack}
                onChange={setAck}
                stale={pendingStale}
                busy={busy}
                error={null}
                onCancel={cancelRestore}
                onConfirm={() => void confirmRestore(ack)}
                actionLabel="restore"
              />
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteCandidate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this recovery ref?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the named ref is deleted. Its objects remain shared and
              readable until Git itself prunes them; this does not reclaim a
              promised number of bytes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <code className="break-all text-[11px]">{deleteCandidate}</code>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteCandidate(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                deleteCandidate ? void cleanup(deleteCandidate) : undefined
              }
            >
              Delete ref
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

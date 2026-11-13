import {
  assertNoDestructiveMutation,
  assessDestructiveAction,
  createDestructiveGitGuard,
  type CanonicalizePath,
  type DestructiveAction,
  type DestructiveConfirmResult,
  type DestructiveGitGuard,
  type DestructivePlan,
  type DestructiveUsageSource,
  git,
  type GitChangedFile,
  type GitDiscardEntry,
  type GitRepoInfo,
  type GitStatusSnapshot,
  resolveDestructiveUsage,
} from "@/modules/git";
import {
  invalidateDiff,
  invalidateRepoDiffs,
  workingDiffKey,
} from "@/modules/editor/lib/diffCache";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SourceControlSummary } from "./useSourceControl";

type PanelState = "closed" | "loading" | "no-repo" | "ready" | "error";
type DiffMode = "+" | "-";
type SelectionTransition = "none" | "moved-group" | "reset";

const RECONCILE_DEBOUNCE_MS = 180;

type DiffSelection = {
  path: string;
  mode: DiffMode;
};

type SourceControlEntry = {
  key: string;
  path: string;
  mode: DiffMode;
  indexStatus: string;
  worktreeStatus: string;
  statusLabel: string;
  statusCode: string;
  originalPath: string | null;
  untracked: boolean;
};

export type CheckState = "checked" | "indeterminate" | "unchecked";

/** One row per changed file (flat list) — merges the staged/unstaged split. */
export type SourceControlFileEntry = {
  key: string;
  path: string;
  originalPath: string | null;
  statusCode: string;
  statusLabel: string;
  checkState: CheckState;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

/** Everything the destructive-action dialog renders and confirms against. */
export type PendingDestructive = {
  kind: "discard" | "checkout";
  plan: DestructivePlan;
  /** A refreshed plan after a stale or incomplete confirmation. */
  stale: string | null;
};

/**
 * What the panel needs to know about the rest of the application before it may
 * mutate a checkout: every editor buffer and terminal in every Space.
 */
export type DestructiveGitSupport = {
  usage: () => DestructiveUsageSource;
  canonicalize: CanonicalizePath;
};

type SourceControlPanelState = {
  panelState: PanelState;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  selected: DiffSelection | null;
  commitMessage: string;
  actionBusy: string | null;
  statusError: string | null;
  actionError: string | null;
  remoteError: string | null;
  actionMessage: string | null;
  stagedEntries: SourceControlEntry[];
  unstagedEntries: SourceControlEntry[];
  fileEntries: SourceControlFileEntry[];
  headerCheckState: CheckState;
  allClean: boolean;
  canPush: boolean;
  pushHint: string | null;
  selectionTransition: SelectionTransition;
  stagedEmptyText: string;
  unstagedEmptyText: string;
  pendingDestructive: PendingDestructive | null;
  destructiveBusy: boolean;
  requestCheckout: (branch: string, onDone?: () => void) => Promise<void>;
  confirmDestructive: (confirmation: {
    unsavedBuffers: number[];
    activeWork: number[];
    force: boolean;
  }) => Promise<void>;
  cancelDestructive: () => void;
  setCommitMessage: (value: string) => void;
  refresh: () => Promise<void>;
  selectEntry: (entry: SourceControlEntry) => Promise<void>;
  selectFile: (entry: SourceControlFileEntry) => Promise<void>;
  stageEntry: (entry: SourceControlEntry) => Promise<void>;
  unstageEntry: (entry: SourceControlEntry) => Promise<void>;
  toggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  toggleAll: () => Promise<void>;
  requestDiscardEntry: (entry: SourceControlEntry) => void;
  requestDiscardFile: (entry: SourceControlFileEntry) => void;
  requestDiscardPaths: (paths: readonly string[]) => Promise<void>;
  requestDiscardAll: () => void;
  stageAllEntries: () => Promise<void>;
  unstageAllEntries: () => Promise<void>;
  commit: () => Promise<void>;
  push: () => Promise<void>;
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function normalizeStatusCode(status: string): string {
  const code = status.trim().toUpperCase();
  switch (code) {
    case "?":
      return "U";
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    default:
      return code || "M";
  }
}

function statusCodeForMode(mode: DiffMode, file: GitChangedFile): string {
  if (mode === "-" && file.untracked) return "U";
  const primary = mode === "+" ? file.indexStatus : file.worktreeStatus;
  const fallback = mode === "+" ? file.worktreeStatus : file.indexStatus;
  return normalizeStatusCode(primary !== " " ? primary : fallback);
}

function makeEntry(
  path: string,
  mode: DiffMode,
  file: GitChangedFile,
): SourceControlEntry {
  return {
    key: `${mode}:${path}`,
    path,
    mode,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
    statusLabel: file.statusLabel,
    statusCode: statusCodeForMode(mode, file),
    originalPath: file.originalPath,
    untracked: file.untracked,
  };
}

function sameSelection(
  a: DiffSelection | null,
  b: DiffSelection | null,
): boolean {
  return !!a && !!b && a.path === b.path && a.mode === b.mode;
}

function optimisticStage(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next = status.changedFiles.map((file) => {
    if (!paths.has(file.path)) return file;
    if (file.staged && !file.unstaged) return file;
    changed = true;
    const wt =
      file.worktreeStatus !== " " ? file.worktreeStatus : file.indexStatus;
    return {
      ...file,
      indexStatus: wt,
      worktreeStatus: " ",
      staged: true,
      unstaged: false,
      untracked: false,
    };
  });
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

function optimisticUnstage(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next: GitChangedFile[] = [];
  for (const file of status.changedFiles) {
    if (!paths.has(file.path)) {
      next.push(file);
      continue;
    }
    if (!file.staged && file.unstaged) {
      next.push(file);
      continue;
    }
    changed = true;
    const idx =
      file.indexStatus !== " " ? file.indexStatus : file.worktreeStatus;
    if (idx === "R" && file.originalPath) {
      next.push({
        path: file.originalPath,
        originalPath: null,
        indexStatus: " ",
        worktreeStatus: "D",
        staged: false,
        unstaged: true,
        untracked: false,
        statusLabel: "Deleted",
      });
      next.push({
        path: file.path,
        originalPath: null,
        indexStatus: " ",
        worktreeStatus: "?",
        staged: false,
        unstaged: true,
        untracked: true,
        statusLabel: "Untracked",
      });
      continue;
    }
    next.push({
      ...file,
      originalPath: null,
      indexStatus: " ",
      worktreeStatus: idx === "A" ? "?" : idx,
      staged: false,
      unstaged: true,
      untracked: idx === "A",
    });
  }
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

function optimisticDiscard(
  status: GitStatusSnapshot,
  paths: Set<string>,
): GitStatusSnapshot {
  let changed = false;
  const next: GitChangedFile[] = [];
  for (const file of status.changedFiles) {
    if (!paths.has(file.path)) {
      next.push(file);
      continue;
    }
    if (file.staged) {
      changed = true;
      next.push({
        ...file,
        worktreeStatus: " ",
        unstaged: false,
        untracked: false,
      });
    } else {
      changed = true;
    }
  }
  if (!changed) return status;
  return { ...status, changedFiles: next };
}

export function useSourceControlPanel(
  isOpen: boolean,
  summary: SourceControlSummary,
  onOpenDiff:
    | ((input: {
        path: string;
        repoRoot: string;
        mode: DiffMode;
        originalPath: string | null;
        title?: string;
      }) => void)
    | null,
  destructive: DestructiveGitSupport,
): SourceControlPanelState {
  const [panelState, setPanelState] = useState<PanelState>("closed");
  const [repo, setRepo] = useState<GitRepoInfo | null>(null);
  const [status, setStatus] = useState<GitStatusSnapshot | null>(null);
  const [selected, setSelected] = useState<DiffSelection | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [localActionBusy, setLocalActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectionTransition, setSelectionTransition] =
    useState<SelectionTransition>("none");
  const [pendingDestructive, setPendingDestructive] =
    useState<PendingDestructive | null>(null);
  const [destructiveBusy, setDestructiveBusy] = useState(false);
  const selectedRef = useRef<DiffSelection | null>(null);
  const reconcileTimerRef = useRef(0);
  const repoRef = useRef<GitRepoInfo | null>(null);
  const destructiveRef = useRef(destructive);
  const checkoutDoneRef = useRef<(() => void) | null>(null);
  const executeRef = useRef<
    | ((
        busyKey: string,
        optimistic: ((status: GitStatusSnapshot) => GitStatusSnapshot) | null,
        ipc: () => Promise<void>,
        affected: string[],
      ) => Promise<void>)
    | null
  >(null);

  useEffect(() => {
    repoRef.current = repo;
  }, [repo]);
  useEffect(() => {
    destructiveRef.current = destructive;
  }, [destructive]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const stagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.staged)
        .map((file) => makeEntry(file.path, "+", file)),
    [status],
  );

  const unstagedEntries = useMemo(
    () =>
      (status?.changedFiles ?? [])
        .filter((file) => file.unstaged)
        .map((file) => makeEntry(file.path, "-", file)),
    [status],
  );

  const fileEntries = useMemo<SourceControlFileEntry[]>(() => {
    const seen = new Set<string>();
    const out: SourceControlFileEntry[] = [];
    for (const file of status?.changedFiles ?? []) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const checkState: CheckState =
        file.staged && file.unstaged
          ? "indeterminate"
          : file.staged
            ? "checked"
            : "unchecked";
      const statusCode = file.unstaged
        ? statusCodeForMode("-", file)
        : statusCodeForMode("+", file);
      out.push({
        key: file.path,
        path: file.path,
        originalPath: file.originalPath,
        statusCode,
        statusLabel: file.statusLabel,
        checkState,
        staged: file.staged,
        unstaged: file.unstaged,
        untracked: file.untracked,
      });
    }
    return out;
  }, [status]);

  const headerCheckState = useMemo<CheckState>(() => {
    if (fileEntries.length === 0) return "unchecked";
    const allChecked = fileEntries.every((e) => e.checkState === "checked");
    if (allChecked) return "checked";
    const anyStaged = fileEntries.some((e) => e.staged);
    return anyStaged ? "indeterminate" : "unchecked";
  }, [fileEntries]);

  const allClean = stagedEntries.length === 0 && unstagedEntries.length === 0;
  const canPush = !!status?.upstream && status.behind === 0;
  const pushHint = useMemo(() => {
    if (!status) return null;
    if (!status.upstream) {
      return "Configure or publish this branch in the terminal to enable push in this iteration.";
    }
    if (status.behind > 0) {
      return "Pull remote changes before pushing local commits.";
    }
    if (status.ahead === 0) {
      return `No local commits to push to ${status.upstream}.`;
    }
    return `Pushes to ${status.upstream}.`;
  }, [status]);
  const stagedEmptyText = "No staged changes";
  const unstagedEmptyText = "No unstaged changes";

  const cancelReconcile = useCallback(() => {
    if (reconcileTimerRef.current) {
      window.clearTimeout(reconcileTimerRef.current);
      reconcileTimerRef.current = 0;
    }
  }, []);

  const scheduleReconcile = useCallback(() => {
    cancelReconcile();
    reconcileTimerRef.current = window.setTimeout(() => {
      reconcileTimerRef.current = 0;
      void summary.refresh({ remote: "never" });
    }, RECONCILE_DEBOUNCE_MS);
  }, [cancelReconcile, summary]);

  useEffect(() => () => cancelReconcile(), [cancelReconcile]);

  const openSelection = useCallback(
    (
      sel: DiffSelection,
      repoRoot: string,
      file: GitChangedFile | undefined,
    ) => {
      onOpenDiff?.({
        path: sel.path,
        repoRoot,
        mode: sel.mode,
        originalPath: file?.originalPath ?? null,
      });
    },
    [onOpenDiff],
  );

  const refresh = useCallback(async () => {
    if (!isOpen) {
      setPanelState("closed");
      setSelectionTransition("none");
      return;
    }
    if (summary.repo) invalidateRepoDiffs(summary.repo.repoRoot);
    await summary.refresh({ remote: "never" });
  }, [isOpen, summary]);

  useEffect(() => {
    if (!isOpen) {
      setPanelState("closed");
      setSelectionTransition("none");
      return;
    }
    if (summary.isLoading && !summary.hasRepo && !summary.status) {
      setPanelState("loading");
      return;
    }
    if (!summary.hasRepo) {
      setRepo(null);
      setStatus(null);
      setSelected(null);
      setPanelState("no-repo");
      setSelectionTransition("none");
      return;
    }
    if (summary.localError && !summary.status) {
      setRepo(summary.repo);
      setStatus(null);
      setSelected(null);
      setPanelState("error");
      setSelectionTransition("none");
      return;
    }
    if (!summary.repo || !summary.status) {
      if (summary.isLoading) {
        setPanelState("loading");
      }
      return;
    }

    setRepo(summary.repo);
    setStatus(summary.status);
    setPanelState("ready");

    const current = selectedRef.current;
    const exists =
      !!current &&
      summary.status.changedFiles.some((file) => {
        if (file.path !== current.path) return false;
        return current.mode === "+" ? file.staged : file.unstaged;
      });

    if (!exists && current) {
      const samePathOtherMode = summary.status.changedFiles.find(
        (file) =>
          file.path === current.path &&
          (current.mode === "+" ? file.unstaged : file.staged),
      );
      if (samePathOtherMode) {
        const moved: DiffSelection = {
          path: samePathOtherMode.path,
          mode: current.mode === "+" ? "-" : "+",
        };
        setSelected(moved);
        setSelectionTransition("moved-group");
      } else {
        setSelected(null);
        setSelectionTransition("reset");
      }
    } else {
      setSelectionTransition("none");
    }
  }, [
    isOpen,
    summary.hasRepo,
    summary.isLoading,
    summary.localError,
    summary.repo,
    summary.status,
  ]);

  const selectEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const nextSelection: DiffSelection = {
        path: entry.path,
        mode: entry.mode,
      };
      if (sameSelection(selected, nextSelection)) {
        setActionError(null);
        setActionMessage(null);
        setSelectionTransition("none");
        return;
      }
      setSelected(nextSelection);
      setActionError(null);
      setActionMessage(null);
      setSelectionTransition("none");
      const file = status?.changedFiles.find((c) => c.path === entry.path);
      openSelection(nextSelection, repo.repoRoot, file);
    },
    [openSelection, repo, selected, status],
  );

  const executeMutation = useCallback(
    async (
      busyKey: string,
      optimistic: ((status: GitStatusSnapshot) => GitStatusSnapshot) | null,
      ipc: () => Promise<void>,
      affected: string[],
    ) => {
      if (!repo || summary.busyAction) return;
      setLocalActionBusy(busyKey);
      setActionMessage(null);
      setActionError(null);
      if (optimistic) summary.applyStatus(optimistic);
      for (const path of affected) {
        invalidateDiff(workingDiffKey(repo.repoRoot, path, "+"));
        invalidateDiff(workingDiffKey(repo.repoRoot, path, "-"));
      }
      try {
        await ipc();
        scheduleReconcile();
      } catch (error) {
        setActionError(normalizeError(error));
        cancelReconcile();
        await summary.refresh({ remote: "never" }).catch(() => {});
      } finally {
        setLocalActionBusy(null);
      }
    },
    [cancelReconcile, repo, scheduleReconcile, summary],
  );
  useEffect(() => {
    executeRef.current = executeMutation;
  }, [executeMutation]);

  const destructiveGuardRef = useRef<DestructiveGitGuard | null>(null);
  const destructiveGuard =
    destructiveGuardRef.current ??
    createDestructiveGitGuard({
      inspect: async (action: DestructiveAction) => {
        const support = destructiveRef.current;
        // Recheck immediately before the decision: the render-cached status can
        // lag a save, a stage or another Space's mutation by a full refresh.
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
        const execute = executeRef.current;
        if (!execute) return;
        if (action.kind === "discard") {
          const entries: GitDiscardEntry[] = action.entries.map((entry) => ({
            path: entry.path,
            untracked: entry.untracked,
          }));
          const paths = new Set(action.entries.map((entry) => entry.path));
          await execute(
            action.entries.length === 1
              ? `discard:${entries[0]?.path ?? "file"}`
              : "discard:all",
            (snapshot) => optimisticDiscard(snapshot, paths),
            () => git.discard(action.repoRoot, entries),
            [...paths],
          );
          setActionMessage(
            entries.length === 1
              ? "Discarded working changes"
              : `Discarded working changes in ${entries.length} files`,
          );
          return;
        }
        if (action.kind === "checkout") {
          await execute(
            "checkout",
            null,
            () => git.checkoutBranch(action.repoRoot, action.branch),
            [],
          );
          setActionMessage(`Switched to branch ${action.branch}`);
          checkoutDoneRef.current?.();
        }
      },
    });
  destructiveGuardRef.current = destructiveGuard;

  const requestDestructive = useCallback(
    async (
      kind: PendingDestructive["kind"],
      action: DestructiveAction,
      onDone?: () => void,
    ): Promise<void> => {
      if (!repo || summary.busyAction || destructiveBusy) return;
      setActionError(null);
      setActionMessage(null);
      checkoutDoneRef.current = null;
      setDestructiveBusy(true);
      try {
        const plan = await destructiveGuard.request(action);
        if (plan === null) {
          setActionError(
            "Another destructive Git action is starting or running; wait for it to finish.",
          );
          return;
        }
        checkoutDoneRef.current = onDone ?? null;
        setPendingDestructive({ kind, plan, stale: null });
      } catch (error) {
        setActionError(normalizeError(error));
      } finally {
        setDestructiveBusy(false);
      }
    },
    [destructiveBusy, destructiveGuard, repo, summary.busyAction],
  );

  const runMutation = useCallback(
    async (
      busyKey: string,
      optimistic: ((status: GitStatusSnapshot) => GitStatusSnapshot) | null,
      ipc: () => Promise<void>,
      affected: string[],
    ) => {
      if (!repo) return;
      try {
        await assertNoDestructiveMutation(repo.repoRoot);
      } catch (error) {
        setActionError(normalizeError(error));
        return;
      }
      await executeMutation(busyKey, optimistic, ipc, affected);
    },
    [executeMutation, repo],
  );

  const stageEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      await runMutation(
        `stage:${entry.path}`,
        (s) => optimisticStage(s, paths),
        () => git.stage(repo.repoRoot, [entry.path]),
        [entry.path],
      );
    },
    [repo, runMutation],
  );

  const unstageEntry = useCallback(
    async (entry: SourceControlEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      await runMutation(
        `unstage:${entry.path}`,
        (s) => optimisticUnstage(s, paths),
        () => git.unstage(repo.repoRoot, [entry.path]),
        [entry.path],
      );
    },
    [repo, runMutation],
  );

  const requestDiscard = useCallback(
    (entries: readonly SourceControlEntry[]) => {
      if (!repo || summary.busyAction || entries.length === 0) return;
      void requestDestructive("discard", {
        kind: "discard",
        repoRoot: repo.repoRoot,
        worktreeRoot: repo.repoRoot,
        entries: entries.map((entry) => ({
          path: entry.path,
          untracked: entry.untracked,
        })),
      });
    },
    [repo, requestDestructive, summary.busyAction],
  );

  const requestDiscardEntry = useCallback(
    (entry: SourceControlEntry) => requestDiscard([entry]),
    [requestDiscard],
  );

  const requestDiscardPaths = useCallback(
    async (paths: readonly string[]) => {
      const repoRoot = repoRef.current?.repoRoot ?? "";
      if (!repoRoot) return;
      const fresh = await git.status(repoRoot).catch(() => null);
      const entries = paths.flatMap((path) => {
        const file = fresh?.changedFiles.find(
          (candidate) => candidate.path === path,
        );
        if (!file?.unstaged) return [];
        return [makeEntry(path, "-", file)];
      });
      await requestDestructive("discard", {
        kind: "discard",
        repoRoot,
        worktreeRoot: repoRoot,
        entries: entries.map((entry) => ({
          path: entry.path,
          untracked: entry.untracked,
        })),
      });
    },
    [requestDestructive],
  );

  const requestDiscardAll = useCallback(
    () => requestDiscard(unstagedEntries),
    [requestDiscard, unstagedEntries],
  );

  const requestCheckout = useCallback(
    (branch: string, onDone?: () => void) => {
      if (!repo || summary.busyAction) return Promise.resolve();
      return requestDestructive(
        "checkout",
        {
          kind: "checkout",
          repoRoot: repo.repoRoot,
          worktreeRoot: repo.repoRoot,
          branch,
        },
        onDone,
      );
    },
    [repo, requestDestructive, summary.busyAction],
  );

  const cancelDestructive = useCallback(() => {
    if (destructiveBusy) return;
    destructiveGuard.cancel();
    checkoutDoneRef.current = null;
    setPendingDestructive(null);
  }, [destructiveBusy, destructiveGuard]);

  const confirmDestructive = useCallback(
    async (confirmation: {
      unsavedBuffers: number[];
      activeWork: number[];
      force: boolean;
    }) => {
      if (!pendingDestructive || destructiveBusy) return;
      setDestructiveBusy(true);
      try {
        const result: DestructiveConfirmResult = await destructiveGuard.confirm(
          {
            fingerprint: pendingDestructive.plan.fingerprint,
            unsavedBuffers: confirmation.unsavedBuffers,
            activeWork: confirmation.activeWork,
            force: confirmation.force,
          },
        );
        switch (result.status) {
          case "done":
            setPendingDestructive(null);
            checkoutDoneRef.current = null;
            break;
          case "stale":
          case "unacknowledged":
            setPendingDestructive({
              kind: pendingDestructive.kind,
              plan: result.plan,
              stale: result.message,
            });
            setActionError(result.message);
            break;
          case "failed":
            setPendingDestructive(null);
            checkoutDoneRef.current = null;
            setActionError(result.error);
            break;
          case "busy":
            setActionError(result.message);
            break;
          case "idle":
            setPendingDestructive(null);
            break;
        }
      } catch (error) {
        setActionError(normalizeError(error));
      } finally {
        setDestructiveBusy(false);
      }
    },
    [destructiveBusy, destructiveGuard, pendingDestructive],
  );

  const stageAllEntries = useCallback(async () => {
    if (!repo || unstagedEntries.length === 0) return;
    const paths = new Set(unstagedEntries.map((entry) => entry.path));
    await runMutation(
      "stage:all",
      (s) => optimisticStage(s, paths),
      () => git.stage(repo.repoRoot, [...paths]),
      [...paths],
    );
  }, [repo, runMutation, unstagedEntries]);

  const unstageAllEntries = useCallback(async () => {
    if (!repo || stagedEntries.length === 0) return;
    const paths = new Set(stagedEntries.map((entry) => entry.path));
    await runMutation(
      "unstage:all",
      (s) => optimisticUnstage(s, paths),
      () => git.unstage(repo.repoRoot, [...paths]),
      [...paths],
    );
  }, [repo, runMutation, stagedEntries]);

  const selectFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      if (!repo) return;
      const mode: DiffMode = entry.unstaged ? "-" : "+";
      const nextSelection: DiffSelection = { path: entry.path, mode };
      if (sameSelection(selected, nextSelection)) {
        setActionError(null);
        setActionMessage(null);
        setSelectionTransition("none");
        return;
      }
      setSelected(nextSelection);
      setActionError(null);
      setActionMessage(null);
      setSelectionTransition("none");
      const file = status?.changedFiles.find((c) => c.path === entry.path);
      openSelection(nextSelection, repo.repoRoot, file);
    },
    [openSelection, repo, selected, status],
  );

  const toggleStageFile = useCallback(
    async (entry: SourceControlFileEntry) => {
      if (!repo) return;
      const paths = new Set([entry.path]);
      if (entry.checkState === "checked") {
        await runMutation(
          `unstage:${entry.path}`,
          (s) => optimisticUnstage(s, paths),
          () => git.unstage(repo.repoRoot, [entry.path]),
          [entry.path],
        );
      } else {
        await runMutation(
          `stage:${entry.path}`,
          (s) => optimisticStage(s, paths),
          () => git.stage(repo.repoRoot, [entry.path]),
          [entry.path],
        );
      }
    },
    [repo, runMutation],
  );

  const toggleAll = useCallback(async () => {
    if (headerCheckState === "checked") await unstageAllEntries();
    else await stageAllEntries();
  }, [headerCheckState, stageAllEntries, unstageAllEntries]);

  const requestDiscardFile = useCallback(
    (entry: SourceControlFileEntry) => {
      requestDiscard([
        {
          key: `-:${entry.path}`,
          path: entry.path,
          mode: "-",
          indexStatus: " ",
          worktreeStatus: entry.statusCode,
          statusLabel: entry.statusLabel,
          statusCode: entry.statusCode,
          originalPath: entry.originalPath,
          untracked: entry.untracked,
        },
      ]);
    },
    [requestDiscard],
  );

  const commit = useCallback(async () => {
    if (!repo || summary.busyAction) return;
    try {
      await assertNoDestructiveMutation(repo.repoRoot);
    } catch (error) {
      setActionError(normalizeError(error));
      return;
    }
    setLocalActionBusy("commit");
    setActionMessage(null);
    setActionError(null);
    try {
      const result = await git.commit(repo.repoRoot, commitMessage);
      setCommitMessage("");
      setActionMessage(
        `Committed ${result.commitSha.slice(0, 7)} ${result.summary}`,
      );
      invalidateRepoDiffs(repo.repoRoot);
      await summary.refresh({ remote: "never" });
    } catch (error) {
      setActionError(normalizeError(error));
    } finally {
      setLocalActionBusy(null);
    }
  }, [commitMessage, repo, summary]);

  const push = useCallback(async () => {
    if (!repo) return;
    setActionMessage(null);
    setActionError(null);
    const result = await summary.runRemoteAction("push");
    if (result.ok) {
      setActionMessage(
        status?.upstream ? `Pushed to ${status.upstream}` : "Push completed",
      );
      return;
    }
    if (result.error) {
      setActionError(result.error);
    }
  }, [repo, status?.upstream, summary]);

  return {
    panelState,
    repo,
    status,
    selected,
    commitMessage,
    actionBusy: localActionBusy ?? summary.busyAction,
    statusError: summary.localError,
    actionError,
    remoteError: summary.lastRemoteError,
    actionMessage,
    stagedEntries,
    unstagedEntries,
    fileEntries,
    headerCheckState,
    allClean,
    canPush,
    pushHint,
    selectionTransition,
    stagedEmptyText,
    unstagedEmptyText,
    pendingDestructive,
    destructiveBusy,
    requestCheckout,
    confirmDestructive,
    cancelDestructive,
    setCommitMessage,
    refresh,
    selectEntry,
    selectFile,
    stageEntry,
    unstageEntry,
    toggleStageFile,
    toggleAll,
    requestDiscardEntry,
    requestDiscardFile,
    requestDiscardPaths,
    requestDiscardAll,
    stageAllEntries,
    unstageAllEntries,
    commit,
    push,
  };
}

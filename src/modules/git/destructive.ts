/**
 * Destructive Git actions across shared Spaces.
 *
 * A Space is organization, not isolation: two Spaces can point at one checkout
 * and an editor view can live outside its Space's root while still being inside
 * the repository. Before a destructive Git action runs, this module resolves the
 * canonical files it will touch (and the whole worktree when the action is
 * worktree-wide), then matches them against every editor buffer and terminal in
 * every Space. Dirty buffers and live terminals become blockers the user has to
 * acknowledge explicitly; `force` only overrides on-disk Git blockers and never
 * the unsaved-buffer acknowledgement.
 *
 * The confirmation is bound to a fingerprint of everything the plan was based on.
 * Immediately before mutation the plan is rebuilt and a changed fingerprint is
 * refused as stale. While the mutation runs, a mutation scope refuses new
 * app-owned saves, spawns and Git mutations that would conflict with it.
 *
 * Limits, stated instead of hidden: an independent program writing to the same
 * checkout is not locked out, and a change landing between the final recheck and
 * the native command is indistinguishable from one landing immediately after.
 * Space roots are textual identities (see `spaces/lib/sharedRoots.ts`); canonical
 * file identity is what bridges a buffer in one Space to a file another Space
 * named.
 */

import type { GitStatusSnapshot } from "./types";

export type DestructiveAction =
  | {
      kind: "discard";
      repoRoot: string;
      /** The worktree whose files are mutated (the repository's own checkout here). */
      worktreeRoot: string;
      entries: readonly { path: string; untracked: boolean }[];
      force?: boolean;
    }
  | {
      kind: "checkout";
      repoRoot: string;
      worktreeRoot: string;
      branch: string;
      force?: boolean;
    }
  | {
      kind: "restore";
      repoRoot: string;
      worktreeRoot: string;
      ref: string;
      force?: boolean;
    }
  | {
      kind: "worktreeRemove";
      repoRoot: string;
      worktreeRoot: string;
      force?: boolean;
    }
  | {
      kind: "revert";
      repoRoot: string;
      worktreeRoot: string;
      paths: readonly string[];
      force?: boolean;
    };

export type DestructiveBufferUsage = {
  tabId: number;
  spaceId: string;
  spaceName: string;
  /** The Space's saved project root, for the outside-root hint only. */
  spaceRoot: string | null;
  path: string;
  /** Absolute canonical file identity; null when it could not be resolved. */
  canonicalPath: string | null;
  dirty: boolean;
};

export type DestructiveTerminalUsage = {
  tabId: number;
  leafId: number;
  spaceId: string;
  spaceName: string;
  cwd: string;
  canonicalCwd: string | null;
  /** `uncertain`: the busy probe failed, so it is treated as active work. */
  busy: boolean | "uncertain";
};

export type DestructiveUsage = {
  buffers: readonly DestructiveBufferUsage[];
  terminals: readonly DestructiveTerminalUsage[];
};

export type DestructiveAffectedPath = {
  /** Git's spelling, repository-relative. */
  path: string;
  canonicalPath: string;
  staged: boolean;
  untracked: boolean;
  effect: "restored" | "removed" | "checkedOut" | "reverted";
  /** `git restore --worktree` leaves the index alone: a staged copy stays staged. */
  indexEffect: "unchanged" | "staysStaged";
};

export type DestructiveBlocker =
  | {
      kind: "unsavedBuffer";
      tabId: number;
      spaceId: string;
      spaceName: string;
      path: string;
      canonicalPath: string;
      outsideSpaceRoot: boolean;
    }
  | {
      kind: "activeTerminal";
      tabId: number;
      leafId: number;
      spaceId: string;
      spaceName: string;
      cwd: string;
      busy: boolean | "uncertain";
    };

export type DestructiveActiveWork = {
  tabId: number;
  leafId: number;
  spaceId: string;
  spaceName: string;
  cwd: string;
  busy: boolean | "uncertain";
  /** Blocking for worktree-wide actions; informational for single-file ones. */
  blocking: boolean;
};

export type DestructivePlan = {
  action: DestructiveAction;
  repoRoot: string;
  worktreeRoot: string;
  canonicalRepoRoot: string;
  canonicalWorktreeRoot: string;
  affected: DestructiveAffectedPath[];
  blockers: DestructiveBlocker[];
  activeWork: DestructiveActiveWork[];
  uncertain: string[];
  force: boolean;
  /** Everything the confirmation is bound to; a change makes the plan stale. */
  fingerprint: string;
  requiresAcknowledgement: {
    unsavedBuffers: boolean;
    activeWork: boolean;
  };
};

export type DestructiveConfirmation = {
  fingerprint: string;
  /** Tab ids of dirty buffers the user explicitly chose to discard. */
  unsavedBuffers?: readonly number[];
  /** Leaf ids of active terminals the user explicitly accepted. */
  activeWork?: readonly number[];
  /** Only meaningful for actions that support it; never a buffer bypass. */
  force?: boolean;
};

export type DestructiveConfirmResult =
  | { status: "idle" }
  | { status: "busy"; message: string }
  | { status: "stale"; plan: DestructivePlan; message: string }
  | {
      status: "unacknowledged";
      plan: DestructivePlan;
      missing: { unsavedBuffers: number[]; activeWork: number[] };
      message: string;
    }
  | { status: "done"; plan: DestructivePlan }
  | { status: "failed"; plan: DestructivePlan; error: string };

// ----------------------------------------------------------------- paths

/** Both separators, `.` and `..`, as one comparable absolute spelling. */
export function normalizeDestructivePath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const absolute = slashed.startsWith("/");
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (absolute) return joined ? `/${joined}` : "/";
  return joined || ".";
}

export function pathAtOrUnderDestructive(path: string, root: string): boolean {
  const normalized = normalizeDestructivePath(path);
  const normalizedRoot = normalizeDestructivePath(root);
  return (
    normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`) ||
    normalizedRoot === "/"
  );
}

export type CanonicalizePath = (path: string) => Promise<string | null>;

type ResolvedPath = { path: string; canonical: string };

/**
 * Canonical identity for a path that may no longer exist (a discarded file):
 * resolve the parent directory and keep the final segment.
 */
async function resolveDestructivePath(
  path: string,
  canonicalize: CanonicalizePath,
): Promise<ResolvedPath> {
  const normalized = normalizeDestructivePath(path);
  try {
    const canonical = await canonicalize(normalized);
    if (canonical) {
      return {
        path: normalized,
        canonical: normalizeDestructivePath(canonical),
      };
    }
  } catch {
    // Fall through to the parent-directory form.
  }
  const index = normalized.lastIndexOf("/");
  if (index > 0) {
    try {
      const parent = await canonicalize(normalized.slice(0, index));
      if (parent) {
        return {
          path: normalized,
          canonical: normalizeDestructivePath(
            `${parent}/${normalized.slice(index + 1)}`,
          ),
        };
      }
    } catch {
      // The parent is gone too; the textual form is all that is left.
    }
  }
  return { path: normalized, canonical: normalized };
}

// ------------------------------------------------------------- assessment

function describeAction(action: DestructiveAction): string {
  switch (action.kind) {
    case "discard":
      return action.entries.length === 1
        ? `Discard working changes in ${action.entries[0]?.path ?? "1 file"}`
        : `Discard working changes in ${action.entries.length} files`;
    case "checkout":
      return `Switch to branch ${action.branch}`;
    case "restore":
      return `Restore checkpoint ${action.ref}`;
    case "worktreeRemove":
      return `Remove worktree ${action.worktreeRoot}`;
    case "revert":
      return action.paths.length === 1
        ? `Revert hunks in ${action.paths[0] ?? "1 file"}`
        : `Revert hunks in ${action.paths.length} files`;
  }
}

function worktreeWide(action: DestructiveAction): boolean {
  return action.kind !== "discard" && action.kind !== "revert";
}

function affectedPathFor(
  action: DestructiveAction,
  file: GitStatusSnapshot["changedFiles"][number],
  canonicalPath: string,
): DestructiveAffectedPath {
  const effect: DestructiveAffectedPath["effect"] =
    action.kind === "checkout"
      ? "checkedOut"
      : action.kind === "revert"
        ? "reverted"
        : file.untracked && action.kind === "discard"
          ? "removed"
          : "restored";
  return {
    path: file.path,
    canonicalPath,
    staged: file.staged,
    untracked: file.untracked,
    effect,
    indexEffect: file.staged ? "staysStaged" : "unchanged",
  };
}

/**
 * Everyone the action will touch, resolved by canonical file identity rather
 * than by which Space happens to hold the tab.
 */
export async function assessDestructiveAction(input: {
  action: DestructiveAction;
  status: GitStatusSnapshot | null;
  usage: DestructiveUsage;
  canonicalize: CanonicalizePath;
}): Promise<DestructivePlan> {
  const { action, status, usage, canonicalize } = input;
  const repo = await resolveDestructivePath(action.repoRoot, canonicalize);
  const worktree = await resolveDestructivePath(
    action.worktreeRoot,
    canonicalize,
  );
  const whole = worktreeWide(action);

  const changed = status?.changedFiles ?? [];
  const wanted = new Set<string>();
  if (action.kind === "discard") {
    for (const entry of action.entries) wanted.add(entry.path);
  } else if (action.kind === "revert") {
    for (const path of action.paths) wanted.add(path);
  } else {
    for (const file of changed) wanted.add(file.path);
  }

  const affected: DestructiveAffectedPath[] = [];
  for (const file of changed) {
    if (!wanted.has(file.path)) continue;
    if (
      action.kind === "discard" &&
      !action.entries.some((e) => e.path === file.path)
    )
      continue;
    const absolute = `${action.worktreeRoot}/${file.path}`;
    const resolved = await resolveDestructivePath(absolute, canonicalize);
    affected.push(affectedPathFor(action, file, resolved.canonical));
    wanted.delete(file.path);
  }
  // Entries the status snapshot no longer lists (stale view) are still named:
  // refusing to show them would make the dialog lie about the request.
  for (const path of wanted) {
    const entry =
      action.kind === "discard"
        ? action.entries.find((candidate) => candidate.path === path)
        : null;
    const absolute = `${action.worktreeRoot}/${path}`;
    const resolved = await resolveDestructivePath(absolute, canonicalize);
    affected.push({
      path,
      canonicalPath: resolved.canonical,
      staged: false,
      untracked: entry?.untracked ?? false,
      effect:
        action.kind === "revert"
          ? "reverted"
          : action.kind === "checkout"
            ? "checkedOut"
            : entry?.untracked
              ? "removed"
              : "restored",
      indexEffect: "unchanged",
    });
  }
  affected.sort((a, b) => a.path.localeCompare(b.path));

  const blockers: DestructiveBlocker[] = [];
  for (const buffer of usage.buffers) {
    if (!buffer.dirty) continue;
    const canonical = normalizeDestructivePath(
      buffer.canonicalPath ?? buffer.path,
    );
    const textual = normalizeDestructivePath(buffer.path);
    const matches = whole
      ? pathAtOrUnderDestructive(canonical, worktree.canonical) ||
        pathAtOrUnderDestructive(textual, worktree.path)
      : affected.some(
          (path) => path.canonicalPath === canonical || path.path === textual,
        );
    if (!matches) continue;
    blockers.push({
      kind: "unsavedBuffer",
      tabId: buffer.tabId,
      spaceId: buffer.spaceId,
      spaceName: buffer.spaceName,
      path: buffer.path,
      canonicalPath: canonical,
      outsideSpaceRoot: buffer.spaceRoot
        ? !pathAtOrUnderDestructive(textual, buffer.spaceRoot)
        : false,
    });
  }

  const activeWork: DestructiveActiveWork[] = [];
  for (const terminal of usage.terminals) {
    const canonical = normalizeDestructivePath(
      terminal.canonicalCwd ?? terminal.cwd,
    );
    const textual = normalizeDestructivePath(terminal.cwd);
    if (
      !pathAtOrUnderDestructive(canonical, worktree.canonical) &&
      !pathAtOrUnderDestructive(textual, worktree.path)
    ) {
      continue;
    }
    const blocking = whole && terminal.busy !== false;
    activeWork.push({
      tabId: terminal.tabId,
      leafId: terminal.leafId,
      spaceId: terminal.spaceId,
      spaceName: terminal.spaceName,
      cwd: terminal.cwd,
      busy: terminal.busy,
      blocking,
    });
    if (blocking) {
      blockers.push({
        kind: "activeTerminal",
        tabId: terminal.tabId,
        leafId: terminal.leafId,
        spaceId: terminal.spaceId,
        spaceName: terminal.spaceName,
        cwd: terminal.cwd,
        busy: terminal.busy,
      });
    }
  }
  activeWork.sort((a, b) => a.leafId - b.leafId);

  const uncertain = activeWork
    .filter((work) => work.busy === "uncertain")
    .map((work) => `terminal:${work.leafId}`);

  const force = action.force === true;
  const fingerprint = [
    describeAction(action),
    repo.path,
    worktree.path,
    action.kind === "checkout" ? action.branch : "",
    action.kind === "restore" ? action.ref : "",
    force ? "force" : "",
    ...affected.map(
      (path) =>
        `affected:${path.path}:${path.effect}:${path.indexEffect}:${path.staged}:${path.untracked}`,
    ),
    ...blockers
      .map((blocker) =>
        blocker.kind === "unsavedBuffer"
          ? `unsaved:${blocker.tabId}:${blocker.canonicalPath}`
          : `active:${blocker.leafId}:${blocker.busy}:${blocker.cwd}`,
      )
      .sort(),
    ...uncertain,
  ].join("\n");

  return {
    action,
    repoRoot: repo.path,
    worktreeRoot: worktree.path,
    canonicalRepoRoot: repo.canonical,
    canonicalWorktreeRoot: worktree.canonical,
    affected,
    blockers,
    activeWork,
    uncertain,
    force,
    fingerprint,
    requiresAcknowledgement: {
      unsavedBuffers: blockers.some(
        (blocker) => blocker.kind === "unsavedBuffer",
      ),
      activeWork: blockers.some((blocker) => blocker.kind === "activeTerminal"),
    },
  };
}

// ------------------------------------------------------------- live usage

/**
 * What the application can ask itself: every editor buffer and terminal in
 * every Space. Canonical identity is resolved here, once per destructive
 * request, so the assessment itself stays a pure-ish function of the snapshot.
 */
export type DestructiveUsageSource = {
  buffers: readonly {
    tabId: number;
    spaceId: string;
    spaceName: string;
    spaceRoot: string | null;
    path: string;
    dirty: boolean;
  }[];
  terminals: readonly {
    tabId: number;
    leafId: number;
    spaceId: string;
    spaceName: string;
    cwd: string;
  }[];
  isBusy: (leafId: number) => Promise<boolean>;
};

export async function resolveDestructiveUsage(
  source: DestructiveUsageSource,
  canonicalize: CanonicalizePath,
): Promise<DestructiveUsage> {
  const buffers = await Promise.all(
    source.buffers.map(async (buffer) => ({
      ...buffer,
      canonicalPath: await canonicalizeOrNull(buffer.path, canonicalize),
    })),
  );
  const terminals = await Promise.all(
    source.terminals
      .filter((terminal) => terminal.cwd.trim() !== "")
      .map(async (terminal) => {
        let busy: DestructiveTerminalUsage["busy"];
        try {
          busy = await source.isBusy(terminal.leafId);
        } catch {
          // An unavailable probe is not evidence that the pane is idle.
          busy = "uncertain";
        }
        return {
          ...terminal,
          canonicalCwd: await canonicalizeOrNull(terminal.cwd, canonicalize),
          busy,
        };
      }),
  );
  return { buffers, terminals };
}

async function canonicalizeOrNull(
  path: string,
  canonicalize: CanonicalizePath,
): Promise<string | null> {
  try {
    const canonical = await canonicalize(path);
    return canonical ? normalizeDestructivePath(canonical) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ copy

const MAX_PATHS_SHOWN = 8;

function listedPaths(plan: DestructivePlan): string {
  const shown = plan.affected
    .slice(0, MAX_PATHS_SHOWN)
    .map((path) => path.path);
  const rest = plan.affected.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** Dialog copy: what is touched, what staging keeps, and who is still working. */
export function destructivePlanMessage(plan: DestructivePlan): string {
  const parts = [`${describeAction(plan.action)}.`];
  if (plan.affected.length > 0) {
    parts.push(`Affected paths: ${listedPaths(plan)}.`);
  }
  const staged = plan.affected.filter(
    (path) => path.indexEffect === "staysStaged",
  );
  if (staged.length > 0) {
    parts.push(
      `${staged.length === 1 ? "One affected file is staged" : `${staged.length} affected files are staged`}: the staged copy stays staged after the working file changes.`,
    );
  }
  for (const blocker of plan.blockers) {
    if (blocker.kind !== "unsavedBuffer") continue;
    parts.push(
      `"${blocker.path}" has unsaved changes in Space "${blocker.spaceName}"${blocker.outsideSpaceRoot ? " (outside that Space's root)" : ""}.`,
    );
  }
  for (const work of plan.activeWork) {
    const state =
      work.busy === "uncertain"
        ? "may still be running (the check did not complete)"
        : "may still be running";
    parts.push(
      `A terminal in Space "${work.spaceName}" ${state} in this worktree.`,
    );
  }
  if (plan.force) {
    parts.push(
      "Force does not discard or save unsaved editor buffers; those still need explicit acknowledgement.",
    );
  }
  parts.push(
    "Independent programs changing files during this action are outside the application's control.",
  );
  return parts.join(" ");
}

export function missingAcknowledgements(
  plan: DestructivePlan,
  confirmation: Pick<DestructiveConfirmation, "unsavedBuffers" | "activeWork">,
): { unsavedBuffers: number[]; activeWork: number[] } {
  const acknowledgedBuffers = new Set(confirmation.unsavedBuffers ?? []);
  const acknowledgedWork = new Set(confirmation.activeWork ?? []);
  const unsavedBuffers: number[] = [];
  const activeWork: number[] = [];
  for (const blocker of plan.blockers) {
    if (blocker.kind === "unsavedBuffer") {
      if (!acknowledgedBuffers.has(blocker.tabId))
        unsavedBuffers.push(blocker.tabId);
    } else if (!acknowledgedWork.has(blocker.leafId)) {
      activeWork.push(blocker.leafId);
    }
  }
  return { unsavedBuffers, activeWork };
}

function acknowledgementMessage(missing: {
  unsavedBuffers: number[];
  activeWork: number[];
}): string {
  const parts: string[] = [];
  if (missing.unsavedBuffers.length > 0) {
    const count = missing.unsavedBuffers.length;
    parts.push(
      `${count} buffer${count === 1 ? " still has" : "s still have"} unsaved changes`,
    );
  }
  if (missing.activeWork.length > 0) {
    parts.push(
      `${missing.activeWork.length} terminal${missing.activeWork.length === 1 ? "" : "s"} may still be running`,
    );
  }
  return `${parts.join(" and ")}. Acknowledge them before running this action.`;
}

// -------------------------------------------------------- mutation scope

type ActiveMutation = {
  id: number;
  label: string;
  repoRoot: string;
  canonicalRepoRoot: string;
  worktreeRoot: string;
  canonicalWorktreeRoot: string;
  wholeWorktree: boolean;
  affected: string[];
};

const SAVE_REFUSAL =
  "A destructive Git action is running on this file; the save was not started. Try again when it finishes.";
const SPAWN_REFUSAL =
  "A destructive Git action is running in this worktree; the terminal was not started.";
const MUTATION_REFUSAL =
  "A destructive Git action is running in this repository; wait for it to finish.";

export type DestructiveMutationScope = {
  begin(plan: DestructivePlan): { id: number };
  end(id: number): void;
  active(): { label: string } | null;
  /** A save to an affected canonical file must be refused, not raced. */
  saveRefusal(
    path: string,
    canonicalize?: CanonicalizePath,
  ): Promise<string | null>;
  /** A spawn whose cwd is inside the mutating worktree must be refused. */
  spawnRefusal(
    cwd: string,
    canonicalize?: CanonicalizePath,
  ): Promise<string | null>;
  /** Another app-owned Git mutation in the same repository must wait. */
  mutationRefusal(repoRoot: string): string | null;
};

export function createDestructiveMutationScope(): DestructiveMutationScope {
  let active: ActiveMutation | null = null;
  let nextId = 1;

  const canonicalOrNull = async (
    path: string,
    canonicalize?: CanonicalizePath,
  ): Promise<string | null> => {
    if (!canonicalize) return null;
    try {
      const canonical = await canonicalize(path);
      return canonical ? normalizeDestructivePath(canonical) : null;
    } catch {
      return null;
    }
  };

  return {
    begin(plan) {
      const entry: ActiveMutation = {
        id: nextId++,
        label: describeAction(plan.action),
        repoRoot: normalizeDestructivePath(plan.repoRoot),
        canonicalRepoRoot: normalizeDestructivePath(plan.canonicalRepoRoot),
        worktreeRoot: normalizeDestructivePath(plan.worktreeRoot),
        canonicalWorktreeRoot: normalizeDestructivePath(
          plan.canonicalWorktreeRoot,
        ),
        wholeWorktree: worktreeWide(plan.action),
        affected: plan.affected.flatMap((path) => [
          normalizeDestructivePath(path.path),
          normalizeDestructivePath(path.canonicalPath),
        ]),
      };
      active = entry;
      return { id: entry.id };
    },
    end(id) {
      if (active?.id === id) active = null;
    },
    active() {
      return active ? { label: active.label } : null;
    },
    async saveRefusal(path, canonicalize) {
      const current = active;
      if (!current) return null;
      const textual = normalizeDestructivePath(path);
      if (current.wholeWorktree) {
        if (
          pathAtOrUnderDestructive(textual, current.worktreeRoot) ||
          pathAtOrUnderDestructive(textual, current.repoRoot)
        ) {
          return SAVE_REFUSAL;
        }
      } else if (current.affected.includes(textual)) {
        return SAVE_REFUSAL;
      }
      const canonical = await canonicalOrNull(path, canonicalize);
      if (!canonical) return null;
      if (current.wholeWorktree) {
        return pathAtOrUnderDestructive(
          canonical,
          current.canonicalWorktreeRoot,
        ) || pathAtOrUnderDestructive(canonical, current.canonicalRepoRoot)
          ? SAVE_REFUSAL
          : null;
      }
      return current.affected.includes(canonical) ? SAVE_REFUSAL : null;
    },
    async spawnRefusal(cwd, canonicalize) {
      const current = active;
      if (!current) return null;
      const textual = normalizeDestructivePath(cwd);
      if (
        pathAtOrUnderDestructive(textual, current.worktreeRoot) ||
        pathAtOrUnderDestructive(textual, current.repoRoot)
      ) {
        return SPAWN_REFUSAL;
      }
      const canonical = await canonicalOrNull(cwd, canonicalize);
      return canonical &&
        (pathAtOrUnderDestructive(canonical, current.canonicalWorktreeRoot) ||
          pathAtOrUnderDestructive(canonical, current.canonicalRepoRoot))
        ? SPAWN_REFUSAL
        : null;
    },
    mutationRefusal(repoRoot) {
      const current = active;
      if (!current) return null;
      const textual = normalizeDestructivePath(repoRoot);
      return textual === current.repoRoot ||
        textual === current.worktreeRoot ||
        textual === current.canonicalRepoRoot ||
        textual === current.canonicalWorktreeRoot
        ? MUTATION_REFUSAL
        : null;
    },
  };
}

/** The process-wide scope the editor, terminal and Git entry points consult. */
export const destructiveMutationScope = createDestructiveMutationScope();

/** Throws when an app-owned save targets a file the running action mutates. */
export async function assertNoDestructiveSave(
  path: string,
  canonicalize?: CanonicalizePath,
): Promise<void> {
  const refusal = await destructiveMutationScope.saveRefusal(
    path,
    canonicalize,
  );
  if (refusal) throw new Error(refusal);
}

/** Throws when an app-owned spawn would start inside the mutating worktree. */
export async function assertNoDestructiveSpawn(
  cwd: string,
  canonicalize?: CanonicalizePath,
): Promise<void> {
  const refusal = await destructiveMutationScope.spawnRefusal(
    cwd,
    canonicalize,
  );
  if (refusal) throw new Error(refusal);
}

/** Throws when another app-owned Git mutation starts in the same repository. */
export async function assertNoDestructiveMutation(
  repoRoot: string,
): Promise<void> {
  const refusal = destructiveMutationScope.mutationRefusal(repoRoot);
  if (refusal) throw new Error(refusal);
}

// ----------------------------------------------------------------- guard

export type DestructiveGitGuardDeps = {
  inspect: (action: DestructiveAction) => Promise<DestructivePlan>;
  mutate: (action: DestructiveAction, plan: DestructivePlan) => Promise<void>;
  scope?: DestructiveMutationScope;
};

export type DestructiveGitGuard = {
  pending(): { action: DestructiveAction; plan: DestructivePlan } | null;
  request(action: DestructiveAction): Promise<DestructivePlan | null>;
  cancel(): void;
  confirm(
    confirmation: DestructiveConfirmation,
  ): Promise<DestructiveConfirmResult>;
};

export function createDestructiveGitGuard(
  deps: DestructiveGitGuardDeps,
): DestructiveGitGuard {
  const scope = deps.scope ?? destructiveMutationScope;
  let pending: { action: DestructiveAction; plan: DestructivePlan } | null =
    null;
  let confirming = false;

  return {
    pending: () => pending,
    async request(action) {
      if (scope.active() !== null || confirming) return null;
      const plan = await deps.inspect(action);
      pending = { action, plan };
      return plan;
    },
    cancel() {
      pending = null;
    },
    async confirm(confirmation) {
      if (pending === null) return { status: "idle" };
      if (scope.active() !== null || confirming) {
        return {
          status: "busy",
          message:
            "Another destructive Git action is starting or running; wait for it to finish.",
        };
      }
      const acknowledged = pending;
      confirming = true;
      try {
        const current = await deps.inspect(acknowledged.action);
        if (
          confirmation.fingerprint !== acknowledged.plan.fingerprint ||
          current.fingerprint !== acknowledged.plan.fingerprint
        ) {
          pending = { action: acknowledged.action, plan: current };
          return {
            status: "stale",
            plan: current,
            message:
              "The affected files, unsaved buffers or active work changed since this confirmation was shown. Review the refreshed list and confirm again.",
          };
        }
        if (confirmation.force === true && !current.force) {
          pending = { action: acknowledged.action, plan: current };
          return {
            status: "stale",
            plan: current,
            message:
              "This action no longer supports a forced run. Review the refreshed list and confirm again.",
          };
        }
        const missing = missingAcknowledgements(current, confirmation);
        if (
          missing.unsavedBuffers.length > 0 ||
          missing.activeWork.length > 0
        ) {
          pending = { action: acknowledged.action, plan: current };
          return {
            status: "unacknowledged",
            plan: current,
            missing,
            message: acknowledgementMessage(missing),
          };
        }
        pending = null;
        const token = scope.begin(current);
        try {
          await deps.mutate(current.action, current);
          return { status: "done", plan: current };
        } catch (error) {
          return {
            status: "failed",
            plan: current,
            error: errorMessage(error),
          };
        } finally {
          scope.end(token.id);
        }
      } finally {
        confirming = false;
      }
    },
  };
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "The destructive Git action failed.";
}

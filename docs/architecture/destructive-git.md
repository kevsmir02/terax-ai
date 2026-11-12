# Destructive Git actions across Spaces

A Space is organization, not isolation (see `spaces/lib/sharedRoots.ts`). Two Spaces can point at
one checkout, and an editor tab opened outside its Space's root still edits a file inside that
repository. This document defines what the application checks before a destructive Git action
mutates anything, and what it deliberately cannot promise.

## Retained actions and their contract

The Source Control panel performs two destructive actions today:

- discarding working-tree changes (`git_discard` via `Discard`),
- switching branches (`git_checkout_branch` via the branch dropdown).

The same plan/guard types cover `restore` (checkpoint restore), `worktreeRemove` and `revert`
(hunk revert). `worktreeRemove` is wired to `createDestructiveGitGuard` by the worktree removal
dialog (see [`worktrees.md`](worktrees.md)): the dialog supplies the plan (dirty buffers and
terminals in every Space), the guard rechecks the fingerprint and holds the mutation scope, and
the native removal decides the on-disk blockers. Nothing here adds automatic commits or pushes,
and the diff/history/hunk review surface is unchanged.

## Before mutation

`src/modules/git/destructive.ts` builds a plan from:

- a **fresh** `git status` snapshot, not the render-cached one,
- every editor buffer in every Space (dirty state, path, Space name and root),
- every terminal leaf in every Space (cwd, foreground-process state, including `uncertain`).

File identity is canonical (`fs_canonicalize`, with a parent-directory fallback for paths that no
longer exist). That is what connects a buffer in one Space to a file another Space names, and it
catches an editor view outside its Space's root. Space roots themselves stay textual identities,
as the shared-folder indication already says.

The plan contains affected repository-relative paths, their staging effect (`git restore
--worktree` leaves the index alone, so a staged copy stays staged), unsaved buffers, active
terminals (blocking for worktree-wide actions, informational for single-file ones), and probes
that could not finish. The plan message names all of it.

A dirty buffer and a live terminal are **acknowledgements**, not warnings: the dialog requires a
checkbox for each before its button is enabled. `force` is a separate checkbox for on-disk Git
blockers (worktree dirty/locked/ignored). Force never clears, replaces or bypasses the
unsaved-buffer acknowledgement; native force only ever overrides native on-disk blockers.

## Recheck and execution

The confirmation is bound to a fingerprint of the plan. Immediately before mutation the plan is
rebuilt; if the fingerprint changed (a new dirty buffer, a buffer saved, a stage, a terminal
starting work, a path appearing or disappearing), the confirmation is **refused as stale** and
the refreshed plan is shown. Confirming an acknowledgement set that no longer matches the current
blockers is refused the same way. A refused or stale action calls no mutation at all.

While the native mutation runs, a process-wide mutation scope refuses:

- app-owned saves to a canonical file the action covers,
- new terminals/spawns whose cwd lies inside the mutating worktree,
- any other app-owned Git mutation in the same repository.

The scope ends in `finally`, so a failed native command does not leave the app frozen.

## Limits, stated rather than implied

- Independent programs (another kernel, an external editor, an agent in a terminal) are **not**
  locked out. A change landing between the final recheck and the native command is
  indistinguishable from one landing immediately after it. The UI says this instead of claiming
  atomic exclusion.
- A terminal's foreground-process probe can fail; that is reported as `uncertain` and treated as
  active work, not as idle.
- The plan uses the app's own view of open buffers. A dirty file that no app buffer holds is an
  on-disk change, and native blockers (dirty/untracked/ignored) cover what Git itself would drop.
- Force on checkpoint restore still cannot bypass the native "files changed since the latest
  checkpoint" refusal or skip its safety ref; force on worktree removal still cannot remove a
  locked worktree.

## Test seams

- `src/modules/git/destructive.test.ts` — plan, acknowledgement, stale refusal, force semantics,
  mutation scope (saves/spawns/mutations), usage resolution and uncertain probes.
- `src/modules/source-control/DestructiveGitPrompt.test.tsx` — the dialog renders affected paths,
  staging effects, Space names, outside-root hints, force disclosure and the disabled/enabled
  confirmation state.
- `src-tauri/src/modules/git/destructive_guard_tests.rs` — real scratch repositories: a dirty
  worktree-removal refusal and a stale checkpoint-restore refusal leave files, the index and refs
  unchanged; force does not remove a locked worktree.
- `src/modules/worktrees/WorktreeRemoveDialog.test.tsx` — the removal dialog's cross-Space
  acknowledgements and stale/refusal states, sharing the same plan and guard.
- `python3 scripts/app-lab/run.py --scenario git` — the real Linux app: a dirty buffer blocks a
  panel discard, an unacknowledged confirmation and a plan that went stale are refused with the
  file/index unchanged, and a deliberately confirmed discard still restores its file.

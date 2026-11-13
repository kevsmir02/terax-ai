# Worktrees: creating one and opening it as a Space

Worktrees are the fork's answer to "separate file tree", not isolation. A Space is saved
organization (a name, a project root, tabs and layout); several Spaces may share one checkout.
A linked worktree is a real second checkout with its own working files, and opening it as a
Space keeps the existing terminals exactly where they were (see
[`spaces/lib/sharedRoots.ts`](../../src/modules/spaces/lib/sharedRoots.ts) and the
Space lifecycle work in ticket #17).

The retained native commands (`git_worktree_list`, `git_worktree_add`, `git_worktree_remove`,
`git_worktree_prune`) were not replaced. This ticket adds the modest creation UI over them, the
preflight the form needs to explain refusal before it submits, and the access check that lets a
created folder become a Space.

## Create

The Source Control panel's repository menu lists worktrees and offers **New worktree…**. The
dialog collects:

- **location**: the app-managed folder (`<state dir>/worktrees/<project>/<name>`) or a custom
  absolute path;
- **branch**: create a new branch, use an existing one, or detach;
- **start point** (optional, defaults to `HEAD`);
- **ignored files** (optional): repository-relative globs, e.g. `.env`, `apps/*/.env`.

`git_worktree_preflight` answers with the planned location, an optional collision note (the
managed location's first free `-2`, `-3`, … name) and problems keyed to the field they belong
to. It performs no mutation: it only resolves the start point, checks the branch name and
whether it already exists or is checked out in another worktree, checks the target path, and
validates included globs. **`git worktree add` remains authoritative**: the branch can change
between the preflight and the mutation, and only the native refusal (shown in the dialog, with
no directory left behind) prevents that race.

The native add re-checks path overlap and emptiness, creates a new branch only when it does not
exist, and removes a directory it claimed if Git fails.

## Derived authorization

Access is decided by the workspace registry, not by a Space's saved root. When `git_worktree_add`
succeeds, it calls `WorkspaceRegistry::authorize_derived` with the new worktree as the child and
the repository as its parent. A path that is not already inside an authorized folder gets its own
derived grant; removing the worktree revokes it. A path inside an already authorized folder (the
app authorizes the launch directory and the home directory) is covered by that grant instead —
the native call deliberately does not replace a stronger existing grant with a derived one.

The dialog asks `workspace_access` about the folder it just created (without granting anything);
`root`, `derived` and `covered` allow **Open as Space**, while `none` disables it and says the
app has no access. This is why the Space offer is tied to the returned canonical path instead of
a path the UI constructed, and why the UI never calls `workspace_authorize` to force it open.

## Ignored-file inclusion stays bounded

The copy is the retained `worktree::copy_included` path, unchanged:

- at most 64 patterns, 200 files, 8 MiB per file and 64 MiB total; wildcard walks stop at
  100,000 entries and never descend into `.git`, `node_modules`, `target`, `.venv` and the other
  regenerable trees;
- only files Git reports as ignored are copied (`git check-ignore --stdin -z`), so a pattern
  cannot exfiltrate tracked content;
- symlinks are never followed, destinations are opened with `create_new`, and nothing is ever
  overwritten. Existing files are reported as `already-exists` and left untouched;
- every skipped path and reason is shown, and the limit notice says some ignored files were not
  copied rather than claiming success.

Storage is not reclaimed automatically; deleting the worktree is the separate, guarded action in
[Remove](#remove).

## Open as a Space

After creation the result offers **Open as Space**. That creates (or reuses, by normalized root)
a Space rooted at the worktree and adds a terminal there when the Space has none. No existing
tab is moved, closed or re-spawned; a terminal keeps its working directory and its buffer. The
same action is available later from each worktree's submenu in the repository menu.

Space deletion continues to leave project and worktree directories on disk (ticket #17).

## Remove

Each worktree's submenu in the repository menu offers **Remove worktree…**. The dialog runs
`git_worktree_remove_preflight`, which performs every check and mutates nothing, then the same
`git_worktree_remove` command performs the removal. The preflight report is the authority on the
blockers:

| Blocker | Meaning |
| --- | --- |
| `dirty` | changed tracked files, and the count of untracked ones |
| `unmerged` | commits reachable only from this worktree's HEAD |
| `ignored` | ignored files that are not dependency/cache directories and differ from the main checkout |
| `locked` | the worktree is locked (`git worktree lock`) |
| `inconclusive` | a probe (`ignored-files`, `unmerged-commits`) timed out or was cut short |
| `recoveryRefs` | checkpoints or pre-restore safety refs this worktree still owns |

`force` is offered only for the on-disk Git blockers (`dirty`, `unmerged`, `ignored`,
`inconclusive`) and never for `locked` or `recoveryRefs`. Dirty editor buffers and live terminals
in **any** Space are separate acknowledgements, built by the destructive-action plan in
[`destructive-git.md`](destructive-git.md): a terminal whose cwd is inside the worktree, and an
editor view whose canonical path is, must be acknowledged before the button enables. The plan is
rebuilt immediately before removal and a changed fingerprint is refused as stale; the native
command rechecks the on-disk blockers itself and refuses with a fresh report.

### Recovery points are not stranded

A checkpoint commit subject ends with ` wt:<worktree id>`; the id lives in the worktree's private
Git directory. Removing the worktree deletes that marker, so a ref left behind would have no owner
to list, restore or clean it. Removal therefore refuses while `recoveryRefs` is non-empty, and
`force` does not decide that. The dialog shows the counts and ref names and offers **Delete N
recovery points**, which calls `git_checkpoint_cleanup_at` for exactly the refs the preflight
attributed to this worktree (`manual`, `turns`, `safety`) and nothing else. The cleanup keeps its
per-ref "expected old value" refusal, deletes no object, and runs no garbage collection; the
remaining groups come back in the same report. Another worktree's refs are never counted, listed
or deleted, even when the two share a task id or a checkpoint name.

The refs are resolved from the repository's administrative directory
(`.git/worktrees/<name>/gitdir` and the ownership marker inside it), so a worktree whose working
directory was already deleted still reports and cleans up its recovery points. Removing that
registration goes through `git worktree remove --force <path>` for that one entry; the app never
runs `git worktree prune`, so other stale registrations (a volume that is merely offline) are
left alone.

Task archiving (`task_worktree_archive`) is the second caller that deletes a worktree, so it
obeys the same rule: an archive is refused while the worktree still owns a manual checkpoint or a
pre-restore safety ref, force included, and the archive reports the same `recoveryRefs` blocker
without deleting the directory, its registration or the refs. The archive's own snapshot is a
task ref (`refs/<namespace>/tasks/<id>/archive/…`), not an owned recovery ref, so the snapshot
the archive just took never blocks that archive.

### What removal does and does not touch

- It revokes only the removed worktree's **derived** access grant. A path covered by a stronger
  existing grant (the launch directory, the home directory, or a root grant the terminal flow
  made when a terminal reported that cwd) keeps that grant; removal does not take another
  feature's grant away.
- It never deletes the branch or its commits. The result says so.
- It never closes or deletes a Space. Deleting a Space is organization only and never calls
  worktree removal; a Space rooted in a removed worktree keeps its tabs, and the dialog names the
  Spaces whose terminals have a working directory there before the confirmation.
- It does not run `git gc`, `git worktree prune`, or an automatic branch deletion.

## Limits, stated rather than implied

- The preflight is advisory and the add is the authority. An external writer creating the branch
  or filling the target between the two is refused by Git, not silently overwritten.
- The app checks its own workspace registry. It does not claim to sandbox an independent
  process; see `docs/security-model.md`.
- Path/rev syntax checked in the form is a fast pre-check. `git check-ref-format`, `rev-parse`
  and the native path checks decide the final answer.
- Removal is not archival: there is no operation that restores a deleted worktree from a retained
  checkpoint afterwards (deferred). Cleanup is the accepted loss.
- The preflight is advisory between its answer and the removal; the native command is the
  authority and refuses a blocker that appeared in between.
- An independent program writing inside the worktree is outside the application's control, as
  everywhere else.

## Test seams

- `src-tauri/src/modules/git/worktree.rs` — real scratch repositories: a valid plan creates
  nothing, unknown start points / file targets / non-empty targets / checked-out branches /
  unauthorized locations are refused without mutation, and the managed location reports the
  first free name.
- `src-tauri/src/modules/workspace.rs` — `Access::{Root, Derived, Covered, None}` distinguishes an
  authorized root from a linked worktree's derived grant.
- `src/modules/worktrees/lib/createWorktree.test.ts` — form validation, request shape, result
  lines, access offer.
- `src/modules/worktrees/lib/wireContract.test.ts` — parses the Rust enum/struct fields so a
  rename cannot silently produce an empty form.
- `src/modules/worktrees/WorktreeCreateDialog.test.tsx` — refusal, copied/skipped report, access
  refusal and error states.
- `src-tauri/src/modules/git/worktree_removal_tests.rs` — real scratch repositories: a manual
  checkpoint and a restore safety ref each refuse removal even with `force`, explicit cleanup
  unblocks it, another worktree's refs are never counted or deleted, a missing directory is still
  refused while refs remain and its single registration is removed without a repository-wide
  prune, and the archive path refuses a manual checkpoint too (deleting nothing) before it is
  asked again after explicit cleanup.
- `src/modules/worktrees/lib/removeWorktree.test.ts` — blocker wording, force availability
  (never for a lock or a retained ref), the exact refs an explicit cleanup may name, refusal and
  result copy.
- `src/modules/git/worktreeRemove.test.ts` — command argument shapes, the `RemoveBlocker` enum and
  `WorktreeRemoveReport`/`OwnedRecoveryRefs` fields parsed from the Rust source, and the absence of
  a removal path from Space deletion.
- `src/modules/worktrees/WorktreeRemoveDialog.test.tsx` — blocker rendering, recovery cleanup,
  cross-Space acknowledgements, refusal and the completed result.
- `python3 scripts/app-lab/run.py --scenario worktree` — the real Linux app: creation with a new
  branch and a copied `.env`, derived access, a new Space with a terminal in the worktree, the
  original terminals unchanged, four creation refusals, deleting the Space leaving the worktree
  alone, removal refused while a checkpoint is retained, explicit cleanup, and a removal that
  deletes the folder, keeps the branch and revokes only the derived access.

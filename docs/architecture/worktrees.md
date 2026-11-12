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

Storage is not reclaimed automatically; deleting the worktree remains a separate, guarded action
(ticket #19's `worktreeRemove` guard).

## Open as a Space

After creation the result offers **Open as Space**. That creates (or reuses, by normalized root)
a Space rooted at the worktree and adds a terminal there when the Space has none. No existing
tab is moved, closed or re-spawned; a terminal keeps its working directory and its buffer. The
same action is available later from each worktree's submenu in the repository menu.

Space deletion continues to leave project and worktree directories on disk (ticket #17).

## Limits, stated rather than implied

- The preflight is advisory and the add is the authority. An external writer creating the branch
  or filling the target between the two is refused by Git, not silently overwritten.
- The app checks its own workspace registry. It does not claim to sandbox an independent
  process; see `docs/security-model.md`.
- Path/rev syntax checked in the form is a fast pre-check. `git check-ref-format`, `rev-parse`
  and the native path checks decide the final answer.
- Worktree removal with checkpoints or restore-safety refs remains blocked by the checkpoint
  work (ticket #23); this ticket only creates.

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
- `python3 scripts/app-lab/run.py --scenario worktree` — the real Linux app: creation with a new
  branch and a copied `.env`, derived access, a new Space with a terminal in the worktree, the
  original terminals unchanged, and four refusals through the same dialog.

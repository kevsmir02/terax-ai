# Manual checkpoints

A checkpoint is a recovery point for the files a worktree holds at the moment it is taken. This
fork makes them **manual and optionally named** (ADR 0005): creating one never depends on an
agent hook, a task id or a turn event, so recovery works for an independently installed agent, a
human edit, or a command run in a terminal. Checkpoints stay until an explicit deletion.

The retained per-task/per-turn checkpoint machinery still exists behind the same ref namespace
(`git_checkpoint_create`/`list`/`restore`/`prune`), but the product surface added for this
workspace ticket is the manual path below.

## Identity and ownership

| Kind | Ref | Identity |
| --- | --- | --- |
| Manual | `refs/<namespace>/manual-checkpoints/<id>` | 32 random hex digits |
| Turn (retained) | `refs/<namespace>/checkpoints/<task>/<turn>` | task id + turn |
| Safety | `refs/<namespace>/checkpoints/<id>/prerestore-<millis>` | manual id or task id + millis |

`<namespace>` is the fork namespace (`terax-workspace`), never upstream's `refs/terax`: refs live
in the user's repository and a shared namespace would let one installation list, restore or
delete the other's recovery points.

The manual id is the identity. The optional name is a label stored with the checkpoint, may repeat,
and never replaces the direct object identity Git already provides. Two checkpoints created from
the same content at the same second therefore remain two refs with two ids; creating one never
replaces an existing ref (`update-ref` is called with "must not exist").

Every checkpoint commit subject ends with ` wt:<worktree id>`, a random id stored in that
worktree's private Git directory. Listing, inspection and cleanup only ever consider refs whose
marker matches the worktree the command was called on, so two worktrees of one repository cannot
see or delete each other's recovery points. Renaming or moving the worktree directory moves the id
with its Git directory; it is not a path.

## Creation

`git_checkpoint_manual_create` (Rust: `checkpoint::create_manual`) captures the working tree
through the existing bounded snapshot:

1. a private copy of the real index is seeded from it, keeping its modification time so Git's racy
   entry rule still sees same-size edits;
2. `git add -A` (with `--ignore-errors`) writes that private index, up to three verification passes
   until two consecutive passes agree;
3. `git write-tree` and `git commit-tree` create a tree and a commit with a fixed identity, so a
   missing `user.name` cannot fail it;
4. the commit is published under a fresh manual ref, with "must not exist" semantics.

HEAD, the real index, branches and the working files are never modified by creation. Hooks and
the filesystem monitor are disabled for every plumbing call, and `core.safecrlf` is relaxed so a
mixed-line-ending file is snapshotted rather than rejected.

### What the result discloses

`ManualCheckpoint.created` includes `limits` (from the shared `CheckpointLimits`) and a persisted
`capture` record:

- `atomic: false` — the snapshot is not atomic; a file written while it runs may land mixed or be
  retried, and an independent writer is not excluded.
- `capturesIgnoredFiles: false` and `ignoredFiles` (+ `ignoredTruncated`) — ignored files and
  directories are counted, never captured. The count is a lower bound when the read cap was hit.
- `capturesSubmoduleContents: false` and `submodules` (+ `submodulesTruncated`) — submodules are
  recorded as their commit pointer only.
- `capturesIndexState: false` and `stagedFiles` (+ `stagedTruncated`) — the snapshot reads the
  worktree through a private index; what was staged in the real index at capture time is not part
  of the checkpoint's identity and is only counted.
- `consistent`, `passes` — did two snapshot passes agree, and how many passes ran.
- `unstableCount` — files that kept changing under the snapshot and were left out.
- `warnings` — `unreadable-files`, `unstable-files-skipped`, `concurrent-writes` when they applied.
- `incomplete` — true when the capture was not stable or skipped content; a checkpoint with
  `incomplete: true` is still recoverable but is not a complete backup.

The record is stored in the commit subject (single line, versioned `capture v1`) so listing and
inspection report the same facts later instead of trusting whatever the creation caller kept in
memory.

## Listing, inspection and storage pressure

`git_checkpoint_groups` returns every recovery point **this worktree owns**, grouped:

- `manual` — newest first, with `name` and the stored `capture` record;
- `turns` — the retained per-task checkpoints, by task then turn;
- `safety` — pre-restore safety refs, newest first, with the task that produced them;
- `storage` — repository-wide `git count-objects -v` counts (`looseObjects`, `looseKib`,
  `packedObjects`, `packedKib`), the number of owned recovery refs, and `sharedObjects: true`.

Storage pressure is context, **not a reclaimable-byte estimate**. Git objects are
content-addressed and shared between refs, and this application never runs garbage collection, so
deleting a checkpoint ref does not promise any number of reclaimed bytes.

`git_checkpoint_inspect` returns one owned ref's metadata, stored capture record, limits, the paths
that differ from its recorded parent (HEAD at capture time, capped at 200 with `changedTruncated`
and `changedTotal`), and `headMoved` when the worktree's HEAD is no longer where it was. Inspection
never changes files, refs or the index.

## Explicit cleanup

`git_checkpoint_cleanup` deletes exactly the refs the caller names, after checking that each one:

- parses as this fork's manual, turn or safety recovery ref (`not-a-recovery-ref` otherwise);
- still exists (`missing`);
- carries this worktree's ownership marker (`unknown-owner`, `another-worktree` otherwise).

Each deletion is its own `update-ref -d <ref> <old commit>`; the expected old value refuses a ref
that moved after the caller saw it (`changed`). Deletion is therefore not one transaction
(`atomic: false`): a failure midway leaves earlier deletions in place and reports them. An empty
selection is a no-op — there is no default "clean everything".

Cleanup never runs `git gc`, `git prune` or any other object deletion: the content objects remain
readable until Git itself prunes unreachable objects. The report returns the remaining groups after
the deletion, so the caller does not have to guess or re-list.

Worktree removal is blocked while its checkpoints or safety refs remain; the explicit cleanup is
what unblocks it, and it affects only the selected worktree. `git_checkpoint_groups_at` and
`git_checkpoint_cleanup_at` answer the same groups and delete the same way, resolved from the
repository and the administrative directory instead of the working directory, so the removal
dialog can still list and delete this worktree's refs after the directory itself is gone. Removal
never infers "clean everything": the caller passes the exact refs the preflight attributed to the
worktree it is removing, and another worktree's refs stay refused (`another-worktree`).

## Restore with preflight and a required safety capture

`git_checkpoint_manual_restore_preview` is the read-only preflight. It names:

- every affected path with its effect (`written` or `removed`), its status against the working
  tree, and whether the real index has a staged entry for it;
- the staging effect: restoring resets the index entries of touched paths to HEAD, so a staged
  copy is not preserved by the safety capture; affected staged paths refuse an unforced restore;
- the HEAD effect: restoring never moves HEAD, and `headMoved` says whether HEAD moved since the
  capture (commits are never undone);
- ignored-file protection: a path the checkpoint holds but the snapshot excludes stays untouched
  and is reported as `ignored-file-in-the-way`;
- the exclusions and the non-atomic nature of the capture, and that an independent writer is
  outside the application's control;
- a fingerprint of the target, the current snapshot, HEAD, every affected path and the staged
  sample of them. The restore is bound to it.

`git_checkpoint_manual_restore` takes that fingerprint and requires a fresh decision. It refuses
before changing anything when:

- the fingerprint no longer matches the working tree (`stalePreview`; retry from a fresh preview);
- affected paths are staged (`stagedAffectedPaths`) unless `force` explicitly accepts that the
  index state is not captured;
- the staged-path probe was truncated, so staging cannot be judged;
- the required safety capture failed, was inconsistent, or could not read an affected path;
- the safety ref could not be published.

The last two refusals apply **even with `force`**: the safety capture is a precondition, not a
best-effort extra. The capture is the working tree as it is immediately before mutation, published
under `refs/<namespace>/checkpoints/<manual id>/prerestore-<millis>`, and it stays until an explicit
deletion. Restoring that safety ref later recovers content; it does not recreate the index,
branches or HEAD, and the result says `contentOnly` instead of claiming a Git-state undo.

Mutation is sequential and disclosed as non-atomic. A failure after it starts (a write step, or the
index sync) returns a partial report: what was removed and written is listed, the safety ref is
still present, the result says `partial`, and `retryRequiresFreshPreview` is true. Repeating the old
fingerprint is refused, so a retry always starts from a fresh preflight. Files are written from a
private index; HEAD is never moved.

## The visible panel

The Source Control header opens the Checkpoints panel: create with an optional name, list manual,
safety and retained turn groups, inspect captured paths and the stored capture record, restore a
manual checkpoint or a safety ref through the shared destructive-Git guard, and delete exactly the
named ref. The panel shows capture incompleteness, ignored/staged counts and storage pressure, and
repeats that a deleted ref removes reachability, not a promised number of bytes. Retained per-turn
checkpoints are listed with their count and keep their own retained restore path; they are not
restored from this panel.

## Seams and tests

- `src-tauri/src/modules/git/manual_checkpoint_tests.rs` — real scratch repositories: capture
  without moving HEAD/index/files, duplicate names keeping distinct ids, per-worktree ownership and
  refusals, inspection and head movement, explicit cleanup with unrelated-ref preservation and no
  object collection, submodule/ignored/staged disclosure, concurrent-writer instability, storage
  shape and name validation.
- `src-tauri/src/modules/git/manual_restore_tests.rs` — real scratch repositories: the preview
  (including staging and HEAD effects and ignored-file protection), a staged-only refusal before
  mutation, a forced staged effect with its safety ref, failed/incomplete required capture and
  failed ref publication with no file or index change, a later partial failure with a retained
  safety ref and a fresh-preview retry, content recovery from the safety ref without a Git-state
  undo claim, and another worktree's ref being refused.
- `src/modules/git/checkpoints.test.ts` — command argument shapes, the Rust `RecoveryKind` enum
  parsed from its source, command registration, and the absence of a reclaimed-bytes field.
- `src/modules/git/restore.test.ts` — the preflight/result copy: staged resolution, stale preview,
  partial failure with the safety ref and fresh-preview rule, and content-only recovery wording.
- `python3 scripts/app-lab/run.py --scenario checkpoints` — the real Linux app: native
  create/list/inspect/cleanup with HEAD/index/files unchanged, then the visible panel's create,
  inspect, preflight, unacknowledged refusal, confirmed restore, safety-ref content recovery and
  explicit deletion.

## Not claimed

- Restore is not atomic and is not a full Git-state undo: ignored files, submodule contents and
  staging are not captured, HEAD is never moved, and an independent writer is not excluded.
- A continuously changing working tree can make the required safety capture fail, in which case the
  restore refuses rather than taking a snapshot it cannot trust.
- No automatic per-turn checkpoints, no automatic retention deletion, no archival restoration after
  a worktree is deleted (deferred). Deleting the refs is the only way past the removal refusal.
- No full-backup or atomic-snapshot claim: ignored files, submodule contents and staging state are
  not captured, and an independent writer can change files during the capture.

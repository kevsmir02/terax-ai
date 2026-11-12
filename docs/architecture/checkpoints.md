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
| Safety | `refs/<namespace>/checkpoints/<task>/prerestore-<millis>` | task id + millis |

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

Worktree removal is blocked while its checkpoints or safety refs remain (issue #25); this command
is the explicit cleanup that unblocks it, and it affects only the selected worktree.

## Seams and tests

- `src-tauri/src/modules/git/manual_checkpoint_tests.rs` — real scratch repositories: capture
  without moving HEAD/index/files, duplicate names keeping distinct ids, per-worktree ownership and
  refusals, inspection and head movement, explicit cleanup with unrelated-ref preservation and no
  object collection, submodule/ignored/staged disclosure, concurrent-writer instability, storage
  shape and name validation.
- `src/modules/git/checkpoints.test.ts` — command argument shapes, the Rust `RecoveryKind` enum
  parsed from its source, command registration, and the absence of a reclaimed-bytes field.
- `python3 scripts/app-lab/run.py --scenario checkpoints` — the real Linux app: create twice with
  the same name, list, inspect, clean up, and observe HEAD/index/files unchanged through the
  native commands.

## Not claimed

- No UI panel is added here; the commands and types are the seam the checkpoint controls use. The
  restore preflight and its safety refs are issue #24.
- No automatic per-turn checkpoints, no automatic retention deletion, no archival restoration after
  a worktree is deleted (deferred).
- No full-backup or atomic-snapshot claim: ignored files, submodule contents and staging state are
  not captured, and an independent writer can change files during the capture.

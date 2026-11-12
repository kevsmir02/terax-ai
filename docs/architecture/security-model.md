# Security model

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

Terax runs shells, reads and writes files, and can spawn coding agents. The security model is defense-in-depth: no single guard is enough, so every boundary validates input before acting on it.

## Boundaries

The main trust boundaries are:

1. **IPC boundary** - commands registered in `src-tauri/src/lib.rs`, gated by `src-tauri/capabilities/default.json`.
2. **File-system boundary** - automatic consumers (Markdown/media preview) go through the shared secret-path policy in `src/modules/workspace/policy.ts` and its native mirror; structural mutations and PTY spawn go through the workspace authorization registry. Explicit user editing is deliberately not policy-gated (see "File access tiers").
3. **Terminal escape-sequence boundary** - OSC sequences are parsed and acted on, but never blindly trusted to mutate state.

## Secret-path deny-list

The shared guard is `src/modules/workspace/policy.ts`; its data is `src/modules/workspace/pathPolicy.json` and the native mirror is `src-tauri/src/modules/fs/access_policy.rs`, which `include_str!`s the same JSON. It refuses automatic reads and writes of obvious secret paths and must never be bypassed by an automatic consumer.

Blocked categories include:

- Files: `.env*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `known_hosts`, `credentials`, `service-account*.json`, and similar.
- Directories: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.config/gh`, `~/.git`, system dirs (`/etc`, `/proc`, `/sys`), and Windows credential stores.
- System write prefixes: `/etc/`, `/var/db/`, `/usr/bin/`, `/windows/`, `/program files/`, etc.

The comparison surface normalizes paths: backslashes to forward slashes, strips Windows drive letters, strips NTFS alternate data streams, strips trailing dots/spaces, lowercases, and collapses duplicate slashes. Protected directories are matched as exact path or descendant, not raw substring.

`checkReadableCanonical` and `checkWritableCanonical` also canonicalize the path and re-check the resolved form so a symlink at an innocent path pointing into `~/.ssh` is caught.

The legacy AI-owned wrapper that re-exported these guards and owned `checkShellCommand` was removed with the built-in AI client (ticket #12); the shared policy modules above are the only owners.

## File access tiers

Three tiers exist and must stay distinct:

1. **Explicit user editing**: `fs_read_file`, `fs_write_file`, `fs_stat`, `fs_image_probe` (bounded header read for an image the user opened), `fs_canonicalize`, `fs_create_*`, `fs_rename`, `fs_delete`, explorer search/read. No registry, no secret policy. Editing `key.pem`, `.env`, `~/.ssh/config` or any file outside the project root works by design (the editor uses these commands, not an automatic reader). `fs_write_file` does take an *expected disk revision* when the caller read the file first; that is coordination, not authorization (see "Save coordination").
2. **Root-confined structural mutation**: `fs_move`, `fs_delete_batch`, `fs_copy`, control `open`, shell cwd. Canonicalize + `WorkspaceRegistry::is_authorized` only. Control `open` of a target outside every authorized root is still refused (retained-but-strict; a deliberate `terax open` outside the roots needs an explicit grant in a later change).
3. **Automatic preview assets**: grant token + canonical containment + secret policy + media type + range + descriptor identity, in `src-tauri/src/modules/fs/assets.rs`.

An automatic consumer never widens its own boundary. A Markdown document loads
local images only from its Space project root, or from its own directory when
the document lies outside that root. Anything beyond that needs an explicit
per-file grant the person chooses in the preview (`MarkdownAssetNotice`); a
secret path is never offered and a symlink that leaves the boundary is still
refused natively. Remote images are not fetched on render: the transform drops
their `src` until a deliberate "Load remote images" action. Document links never
navigate the application webview; only a clicked external target reaches the
native opener.

The fourth tier, automatic agent reads (`fs::access::authorize_read` plus the `fs::ai` reader commands), was removed with the built-in AI stack (ticket #14). Nothing now reads a file on the user's behalf: an external agent reads files in its own process, and the application reads only what the user opened or the preview policy explicitly serves.

Known limitation (RS-3, ticket #5): the external formatter runs `shell_run_command` with `cwd = dirname(edited file)` and that cwd is authorized through tier 2, so formatting a file outside every authorized root is refused even though that file can be edited. Widening it needs an explicit user grant for the formatter cwd; until then do not replace the registry check with a path-only check.

## Save coordination

Two independently dirty buffers of one canonical file must not both overwrite
the revision they were edited from, in one Space or across Spaces. The editor
reads an opaque **disk revision** with its content and sends it back on save;
`src-tauri/src/modules/fs/save.rs` recomputes the current one inside the write
critical section and refuses the write when they disagree.

- A revision is a SHA-256 content digest plus size plus file identity
  (device/inode, volume/file index). Mtime is deliberately not part of it: a
  same-size edit that keeps the timestamp must still conflict, and a replaced
  inode (checkout, rename, `cp`) is a conflict even when the bytes match,
  because the file the user reviewed no longer exists.
- A refusal is structured (`{kind:"conflict", reason, current}`) and the
  reasons are `changed`, `replaced`, `missing`, `unreadable`. A missing,
  unreadable or replaced target is never recreated by a save.
- The four conflict outcomes in `src/modules/editor/lib/diskSync.ts` are
  compare, Save As, reload/discard, and an explicit overwrite **bound to the
  revision the user reviewed**: the overwrite resends that revision, so a change
  after the review is refused and starts a fresh round. Save As refuses an
  existing destination and never writes the conflicting path.
- An app-owned save+format sequence uses the same coordination: the external
  formatter only runs while the file is still the revision the buffer just
  saved (`fs_file_revision`), and the formatter's read-back becomes the new
  baseline.
- The editor serialises the app-owned saves of one document (`createSaveQueue`).
  A save requested while an older one is in flight runs afterwards and reads its
  text and expected revision at that point, so newer typing is written against
  the revision the older save left instead of racing it with a stale baseline.
  Results of older completions are never adopted over the newer buffer.

Validated support (not a release-only gate): `src-tauri/tests/save_revision.rs`
covers two buffers from one baseline (including a concurrent two-thread race),
same-mtime content changes, stale overwrite consent, and missing/replaced/
non-regular targets; `src/modules/editor/lib/diskSync.test.ts` covers the editor
protocol, conflict outcomes, newer typing during a pending save, reload/discard,
and format-baseline checks. Not exercised here: a packaged two-Space UI race and
two independently running app instances.

## Recovery drafts

Opt-in durable recovery of unsaved editor text. It is **off by default** and is
a separate action from autosave of the original file and from layout/preference
persistence: recovery never writes a project file. Enabling it is an explicit
setting (`Editor → Recover unsaved drafts`) that discloses the storage location,
the bounds and the exclusions.

**Ownership is the buffer, not the path.** A record carries:

- `bufferId` — `buf-<session>-t<tab>-<space-hash>`: stable for the life of one
  editor buffer, different for every Space and tab. Two Spaces editing the same
  pathname are two ids and two records; the path alone never owns a draft.
- `path` and `fileIdentity` — the original file at the time of the record. The
  identity is the device/inode portion of the ticket-#15 disk revision.
- `bufferRevision` — a monotonic counter of this buffer's own text.
- `diskRevision` — the opaque `r1:<digest>:<size>:<identity>` revision the text
  was edited from, so a recovered draft knows whether the file still matches.
- `text`, `bytes`, `updatedAt`, `version`.

The session component changes every launch, so a buffer created after a crash
never silently inherits a pre-crash record: the record is *offered* to a document
reopened in the same Space and at the same path, as a comparison/Save As draft.
Restoring only puts the text back into the editor buffer (dirty, unsaved); a
changed, replaced/moved, missing or unreadable original is only ever compared or
saved to a path the user chooses.

**Storage.** `<app data>/recovery/records/<hex(bufferId)>.json` — its own private
subdirectory (`0700`, records `0600`), written with a tempfile + `fsync` +
rename so a crash mid-write leaves the older valid record. Hex file names mean a
buffer id can never escape the directory. The native store
(`src-tauri/src/modules/recovery.rs`) is the enforcement point; the frontend
mirrors the same policy file
(`src/modules/editor/lib/recovery/policy.json`) for its pre-check and status
text.

**Quota is a pause, not an eviction.** 10 MiB per record and 100 MiB total,
measured on the stored bytes. A record over the per-file bound pauses recovery
for that buffer and keeps its older draft; exhausting the total pauses every
buffer. Room comes back only from an explicitly resolved draft (or shrinking
text), never by deleting an unrecovered one. A refused or failed write leaves the
older record byte-identical.

**Acknowledgement, coalescing and cleanup.**

- Continuous editing schedules a persistence write after 1.5 s, not on idle: the
  first edit arms one timer and further edits only update the snapshot. Edits
  typed during a slow write get an immediate follow-up write.
- Only a completed storage write is reported as `durable`; `pending`, `failed`,
  `paused` and `unavailable` are visible states, and there is no optimistic
  success. A `pending` write that is not scheduled is reported as such with a
  Retry action rather than as "saving" progress.
- Quota refusals cross the IPC boundary as `{kind:"quota", reason:"file-limit"
  |"total-limit"}` and are treated as *pauses* by the manager (a per-file
  refusal pauses one buffer, a total refusal pauses all of them), never as a
  generic failure. The reason vocabulary is shared with
  `quota.ts`, and `wireContract.test.ts` parses the Rust enum so a rename on
  either side fails a test instead of silently downgrading to "failed".
- A pause stops scheduling by cancelling coalescers; resuming rebuilds the
  scheduler for **every** live buffer, not only the ones with pending text, so
  a buffer that was idle when the total bound was hit still persists its next
  edit.
- Every buffer has one operation chain, so a write cannot land after the delete
  that resolved it. A save/discard also retires the revisions it resolved (a
  watermark) and the delete is revision-aware natively, so a late completion
  cannot resurrect resolved text or remove newer typing. Cleanup removes only the
  resolving buffer's revision: newer unsaved text and another Space's draft of
  the same pathname survive.
- Save As retargets the record only after the write succeeds; a failed Save As
  leaves the draft owned by the original file.
- Known-sensitive paths are excluded by reusing `src/modules/workspace/policy.ts`
  and `pathPolicy.json`. This is a filename/location policy, **not complete
  secret detection**: text from an innocuously named file is recorded, which the
  settings disclosure says.

Validated support: `src/modules/editor/lib/recovery/*.test.ts` (record model,
quota admission, coalescing in virtual time, cleanup/watermark/restore plans,
manager races: late completions, discard-then-complete, failure-preserves-older,
two-Space independence, Save As retarget), `RecoveryStatusBar.test.tsx` /
`RecoveryDraftBanner.test.tsx` (visible states, offer-never-impose),
`src-tauri/src/modules/recovery.rs` unit tests (atomicity, private modes,
quota refusal, revision-aware delete, corrupt-record handling) and
`src-tauri/tests/recovery_store.rs` (restart, two-Space records through the
native seam, refusal leaves the older record). Not exercised: a real forced kill
of the packaged application, a packaged two-Space UI race, and the quit-time
bounded flush UI (the manager exposes `flushAll`; the close/quit flow is ticket
#34).


Limitation, deliberately not claimed otherwise: this coordinates **app-owned**
writes only. An independent external writer is not locked out, and a change that
lands between the revision check and the rename is indistinguishable from one
that lands immediately after. Atomic exclusion of other programs is not
provided. Save As refuses a destination that exists at check time, but a file an
external program creates between that check and the write is outside the same
guarantee. Durable unsaved-text recovery is a separate ticket (#16).

## Retained native consumers of shared contracts

The built-in AI stack is gone (client in ticket #12, native in ticket #14), and the removal kept the shared guards it used:

- `src/modules/workspace/{native,policy}.ts`, `src/modules/workspace/pathPolicy.json` and `src-tauri/src/modules/fs/{access,access_policy}.rs` are owned by retained file/preview features. `fs::assets` uses `fs::access::opened_path` for descriptor identity and `fs::access_policy::readable` for the secret-path policy, so `fs::access` keeps exactly that one primitive.
- `shell_run_command` stays because the external formatter needs it; the agent-session and background-process commands that shared its module were removed with the AI stack.
- If a command is removed, remove its own tests with it, not the shared guard tests.

## Workspace authorization registry

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs:20`) tracks directories that PTY spawn, git commands and the external formatter are allowed to operate in.

- `workspace_authorize` adds a directory.
- `authorize_spawn_cwd` rejects a spawn cwd outside an authorized root.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as a new root instead of rejecting it.
- The registry is bootstrapped with the launch directory and the user's home directory (`workspace.rs:135`).
- `authorize_derived(child, parent)` grants a linked git worktree on the strength of its parent repository: it only succeeds while the parent is authorized, stops counting if the parent is revoked, and `revoke_derived` removes it when the worktree is removed or pruned. A worktree git lists is re-granted only if its `.git` file points back into the repository's `worktrees/` directory.

This is the allow side of the file-system boundary. Any new feature that spawns a shell or mutates files outside the current workspace must interact with this registry.

## Removed AI tool approval flow

The client-side tool approval cards went with the built-in AI (ticket #12): there is no in-app tool execution or approval surface. External coding agents ask for permission in their own terminal, and the hook permission fallback in `modules/control/agents.ts` is retained for agent-owned approval prompts. No new approval UI is introduced.

## Removed AI network and secret planes

The AI HTTP proxy (`src-tauri/src/modules/net.rs`) and its SSRF/DNS-rebinding classifier were removed with the built-in AI stack (ticket #14): no application feature makes outbound model or provider requests any more, so the only remaining network work is the loopback control server and the update check. Likewise `secrets_*` (`src-tauri/src/modules/secrets.rs`) and the `keyring` dependency are gone. The application stores no AI credentials; Git authentication stays with the user's own git credential helper or SSH key, which the git commands inherit.

An installed upstream Terax keeps its own keychain entries and `secrets.json`. The fork never reads, migrates or deletes them (see [namespace isolation](namespace-isolation.md)).


## OSC trust gating

The terminal parses OSC sequences from the PTY byte stream:

- **OSC 7** updates the tab cwd.
- **OSC 133 A/B/C/D** marks prompt/command boundaries.
- **OSC 777** is used by the agent detector to signal coding-agent state transitions.

The agent detector (`src-tauri/src/modules/pty/agent_detect.rs`) is armed by `OSC 133;C;<cmd>` or by a self-armed marker and emits `terax:agent-signal` events. It is driven **only by OSC sequences**, never by raw output, so a repainting TUI never flaps.

## Fork identity and namespace isolation

This fork runs next to an installed upstream Terax and must not read, import, overwrite or
delete its state. Every fork-owned name (bundle identifier, app data/config/cache/state dirs,
control descriptor and per-pid launcher directory, shell integration, child-shell environment,
hook ownership markers, Pi extension, git refs and task-worktree state) comes from one table:
`src/modules/identity/namespace.json`. The full inventory, the old→new mapping and the reasons
are in [namespace-isolation.md](namespace-isolation.md).

Rules that follow from it:

- Never hardcode the product identifier or the `terax` directory name; use
  `modules::identity` (Rust) / `linux_profile` (runners) / the table (frontend checks).
- The agent-read denylist refuses **both** this fork's cache directory and the upstream one:
  each holds a live control token.
- There is no silent migration. Upstream settings, data, descriptors, shell-integration files
  and hook groups are foreign: install/uninstall/reset paths must leave them byte identical,
  and a foreign file at one of our paths is refused rather than replaced.
- Lab and bench runs use disposable identifiers derived from the table and refuse the fork
  product identifier *and* any upstream identifier.

## Invariants

- The deny-list in `src/modules/workspace/policy.ts` and its native mirror applies to every automatic read and write. Never bypass it.
- New file-system-touching commands must respect the workspace authorization registry.
- The application makes no outbound provider requests. A new network-facing command needs its own host/IP classification and DNS pinning; do not reintroduce a general proxy without one.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.
- No credential is stored by the application: Git and external agents authenticate with the user's own configuration.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Namespace isolation](namespace-isolation.md) - fork identity inventory and coexistence rules
- [Two-process model](two-process-model.md) - IPC boundary and command catalog

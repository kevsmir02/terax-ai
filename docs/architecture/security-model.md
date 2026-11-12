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

1. **Explicit user editing**: `fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`, `fs_create_*`, `fs_rename`, `fs_delete`, explorer search/read. No registry, no secret policy. Editing `key.pem`, `.env`, `~/.ssh/config` or any file outside the project root works by design (the editor uses these commands, not an automatic reader).
2. **Root-confined structural mutation**: `fs_move`, `fs_delete_batch`, `fs_copy`, control `open`, shell cwd. Canonicalize + `WorkspaceRegistry::is_authorized` only. Control `open` of a target outside every authorized root is still refused (retained-but-strict; a deliberate `terax open` outside the roots needs an explicit grant in a later change).
3. **Automatic preview assets**: grant token + canonical containment + secret policy + media type + range + descriptor identity, in `src-tauri/src/modules/fs/assets.rs`.

The fourth tier, automatic agent reads (`fs::access::authorize_read` plus the `fs::ai` reader commands), was removed with the built-in AI stack (ticket #14). Nothing now reads a file on the user's behalf: an external agent reads files in its own process, and the application reads only what the user opened or the preview policy explicitly serves.

Known limitation (RS-3, ticket #5): the external formatter runs `shell_run_command` with `cwd = dirname(edited file)` and that cwd is authorized through tier 2, so formatting a file outside every authorized root is refused even though that file can be edited. Widening it needs an explicit user grant for the formatter cwd; until then do not replace the registry check with a path-only check.

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

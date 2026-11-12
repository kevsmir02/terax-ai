# Security model

This guide elaborates on `TERAX.md`. If anything here conflicts with `TERAX.md`, `TERAX.md` wins.

Terax runs shells, reads and writes files, and can spawn coding agents. The security model is defense-in-depth: no single guard is enough, so every boundary validates input before acting on it.

## Boundaries

The main trust boundaries are:

1. **IPC boundary** - commands registered in `src-tauri/src/lib.rs`, gated by `src-tauri/capabilities/default.json`.
2. **File-system boundary** - automatic consumers (agent reads, Markdown/media preview) go through the shared secret-path policy in `src/modules/workspace/policy.ts` and its native mirror; structural mutations and PTY spawn go through the workspace authorization registry. Explicit user editing is deliberately not policy-gated (see "File access tiers").
3. **Network boundary** - the HTTP proxy in `src-tauri/src/modules/net.rs` with SSRF and DNS-rebinding defenses (inert native compatibility until ticket #14; the client has no AI provider requests).
4. **Secret-storage boundary** - provider keys live in the OS keychain, never on disk or in `localStorage`; the client no longer reads or writes them (inert native compatibility until ticket #14).
5. **Terminal escape-sequence boundary** - OSC sequences are parsed and acted on, but never blindly trusted to mutate state.

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

Four tiers exist and must stay distinct:

1. **Explicit user editing** — `fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`, `fs_create_*`, `fs_rename`, `fs_delete`, explorer search/read. No registry, no secret policy. Editing `key.pem`, `.env`, `~/.ssh/config` or any file outside the project root works by design (the editor uses these commands, not the agent reader).
2. **Root-confined structural mutation** — `fs_move`, `fs_delete_batch`, `fs_copy`, control `open`, shell cwd. Canonicalize + `WorkspaceRegistry::is_authorized` only. Control `open` of a target outside every authorized root is still refused (retained-but-strict; a deliberate `terax open` outside the roots needs an explicit grant in a later change).
3. **Automatic preview assets** — grant token + canonical containment + secret policy + media type + range, in `src-tauri/src/modules/fs/assets.rs`.
4. **Automatic agent reads** — `fs::access::authorize_read` (literal + canonical secret policy, then registry) plus fd pinning in `fs::ai`.

Known limitation (RS-3, ticket #5): the external formatter runs `shell_run_command` with `cwd = dirname(edited file)` and that cwd is authorized through tier 2, so formatting a file outside every authorized root is refused even though the file can be edited. Widening it needs an explicit user grant for the formatter cwd; until then do not replace the registry check with a path-only check.

## Inert AI-owned native consumers of shared contracts

The built-in AI client was removed (ticket #12), so nothing in `src/` calls these commands. The native side remains until ticket #14, and it must not take the shared guards with it: `src/modules/workspace/{native,policy}.ts`, `src/modules/workspace/pathPolicy.json` and `src-tauri/src/modules/fs/{access,access_policy}.rs` are owned by retained file/preview features.

- `src/modules/fs/ai.rs` (reader/walk commands) and `src/modules/fs/project_memory.rs` still use `fs::access` + `fs::access_policy`; `fs::assets` (retained) uses `fs::access_policy` and `fs::access::opened_path`.
- `shell_*` one-shot/session commands and `ai_*` readers have no client consumer; do not add one.
- If a command is removed, remove its own tests with it, not the shared guard tests.

## Workspace authorization registry

`WorkspaceRegistry` (`src-tauri/src/modules/workspace.rs:20`) tracks directories that PTY spawn, git commands, formatters and the inert AI commands are allowed to operate in.

- `workspace_authorize` adds a directory.
- `authorize_spawn_cwd` rejects a spawn cwd outside an authorized root.
- `authorize_user_spawn_cwd` registers the user's chosen cwd as a new root instead of rejecting it.
- The registry is bootstrapped with the launch directory and the user's home directory (`workspace.rs:135`).
- `authorize_derived(child, parent)` grants a linked git worktree on the strength of its parent repository: it only succeeds while the parent is authorized, stops counting if the parent is revoked, and `revoke_derived` removes it when the worktree is removed or pruned. A worktree git lists is re-granted only if its `.git` file points back into the repository's `worktrees/` directory.

This is the allow side of the file-system boundary. Any new feature that spawns a shell or mutates files outside the current workspace must interact with this registry.

## Removed AI tool approval flow

The client-side tool approval cards went with the built-in AI (ticket #12): there is no in-app tool execution or approval surface. External coding agents ask for permission in their own terminal, and the hook permission fallback in `modules/control/agents.ts` is retained for agent-owned approval prompts. No new approval UI is introduced.

## SSRF and DNS rebinding defense

`src-tauri/src/modules/net.rs` proxies the inert AI-provider requests and local-model pings. Before connecting:

1. Resolve the hostname once (`resolve_and_classify`).
2. Classify every resolved IP as public, private, loopback, or blocked metadata (`net/ip.rs`). An IPv6 address that carries an IPv4 destination (`::ffff:a.b.c.d`, `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, Teredo) takes the class of the embedded IPv4, and anything outside global unicast `2000::/3` (unique-local, site-local, link-local, multicast, documentation) is never public. Redirect targets are classified the same way.
3. Block cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, AWS IPv6 metadata, etc.).
4. Pin reqwest to the resolved IPs so a second DNS lookup cannot return a different address (DNS rebinding).

Local LLM endpoints were explicitly allowed because the user opted in by pointing Terax at them, but they are still classified and logged. Nothing in the client calls this proxy today.

## Secret storage

Provider API keys were stored via `secrets_*` commands (`src-tauri/src/modules/secrets.rs`); the client no longer calls them, and the fork must never read or delete an upstream entry:

- macOS: Keychain via `keyring`
- Windows: Credential Manager via `keyring`
- Linux: a JSON file in the app's local data dir with mode `0600` (atomic write to `.tmp` then rename)

Keys never touched disk outside the keychain/Linux secrets file, never went in `localStorage`, and never appeared in logs. The retained layer stays inert until ticket #14.

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

- The deny-list in `security.ts` applies on both read and write. Never bypass it.
- New file-system-touching commands must respect the workspace authorization registry.
- New network-facing commands must go through the `net.rs` proxy or reimplement the same classification and DNS pinning.
- New plugin APIs must be added to `src-tauri/capabilities/default.json`.
- Keys, tokens, and credentials stay in the keychain / Linux secrets file.

## See also

- [`TERAX.md`](../../TERAX.md) - the architecture source of truth
- [`docs/README.md`](../README.md) - index of contributor guides
- [Namespace isolation](namespace-isolation.md) - fork identity inventory and coexistence rules
- [Two-process model](two-process-model.md) - IPC boundary and command catalog
- [Built-in AI subsystem](ai-subsystem.md) - removed client surfaces and inert native compatibility

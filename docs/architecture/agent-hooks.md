# Agent hooks: review, apply and fork ownership

This fork writes small lifecycle hooks into terminal coding agents so their
session, prompt, permission and stop events reach the app instead of relying on
terminal heuristics. Hooks are **optional per agent and off by default**. This
document records the rules that keep that opt-in honest: what a preview shows,
when an apply is refused, which entries this fork may touch, and what a written
file does and does not prove.

Code: `src-tauri/src/modules/agent.rs` (planning, ownership, apply),
`src-tauri/src/modules/agent_json.rs` (byte-preserving JSON edits),
`src/modules/control/lib/hooksConfig.ts` (commands and types),
`src/modules/control/lib/hooksInstall.ts` (review state machine),
`src/settings/components/AgentHooksGroup.tsx` (the only install/remove UI).

## Ownership: what "this fork's entries" means

The marker is the fork's own CLI variable from
`src/modules/identity/namespace.json` (`envPrefix` = `CODR`, so
`CODR_CLI`). An entry is fork-owned only when its command
literally invokes that CLI in one of the three shell dialects the adapters emit:

| Dialect | Fork-owned invocation |
| --- | --- |
| POSIX | `"$CODR_CLI" hook <agent> <event>` |
| cmd | `"%CODR_CLI%" hook <agent> <event>` |
| PowerShell | `$env:CODR_CLI hook <agent> <event>` |

Consequences, all covered by tests:

- Upstream Terax hooks (`$TERAX_CLI`, `notify;Terax;`, `terax;notify`,
  `__terax_notify`, OSC 777 markers) are **foreign**. They are never rewritten,
  never removed and never "migrated". Coexistence is the expected state, not an
  error.
- User-written hooks are foreign. A matcher group that contains any command this
  fork did not write is left alone as a whole.
- Lookalikes are foreign: `TERAX_CLI`, an unquoted variable, a different verb
  (`"$CODR_CLI" report …`), or a suffix
  (`"$CODR_CLI_EXTRA" hook …`) does not match.
- A removal plan on a file that holds no fork entries produces no write, so the
  file stays byte-identical (comments, indentation, CRLF included).
- The Pi integration is a separate extension file
  (`~/.pi/agent/extensions/codr-notifications.ts`). Upstream's
  `terax-notifications.ts` sits next to it and is never opened. A file at our
  own path whose contents are not our `codr-pi-notifications-v*`
  family is a conflict: install is refused and removal does nothing.
- Installed definitions are byte-stable across application versions, so an
  upgrade does not rewrite a file that is already current.

Only the marker decides ownership. There is no timestamp, path, or "last written
by us" heuristic, because those cannot distinguish a fork entry from upstream's
in a file both applications edit.

## Plan → review → apply state machine

Planning is pure and read-only. Applying re-reads the file, compares the
fingerprint the user reviewed, and only then writes.

```text
        plan(agent, action)                       (read-only)
                 │
                 ▼
             ┌────────┐   cancel   ┌──────┐
             │ review │───────────▶│ idle │
             └────────┘            └──────┘
                 │ confirm (explicit, plan.changed)
                 ▼
             ┌─────────┐
             │ applying│
             └─────────┘
                 │
      ┌──────────┼───────────────────┐
      ▼          ▼                   ▼
  applied    unchanged            stale            errors
      │          │                   │                │
      ▼          ▼                   ▼                ▼
 ┌────────────┐  │          ┌──────────────┐     ┌────────┐
 │ configured │◀─┘          │ needs a fresh│     │ failed │
 └────────────┘             │ review       │     └────────┘
                            └──────────────┘
                                   │ plan() again
                                   ▼
                               review (new revision)
```

- **States**: `idle`, `reviewing`, `applying`, `configured`, `stale`, `failed`.
- **Review** carries the exact `before` and `after` file contents and the
  observed `revision`. Nothing is written while reviewing.
- **Confirm** is possible only from `reviewing` when the plan reports
  `changed: true`. An apply of an unchanged plan returns `unchanged` and writes
  nothing.
- **Stale refusal**: the plan carries a revision (byte length plus an FNV-1a hash
  of the contents, or `absent`). Apply sends that revision; the backend re-reads
  the file and returns `outcome: "stale"` **without writing** when the contents
  no longer match. The only way forward is a newly computed preview, then a new
  explicit confirm. Content is hashed rather than mtime/size so an external edit
  that keeps the same length and mtime is still detected.
- **Failure** (invalid JSON, unreadable file, unwritable directory) is surfaced
  as an error and never silently recreates a missing or replaced file. Writes go
  through a private temporary sibling and a rename, through a symlink rather than
  replacing it, keeping the target's permissions.
- **Retries** are explicit: re-plan, review, confirm. Repeating an apply with the
  old revision is stale; repeating it after the file matches the preview is
  `unchanged`.

There is exactly one install/remove path: the settings review dialog. Hook
configuration is not installed as a side effect of launching an agent.

## Per-agent capability and activation

A written configuration is **configured**, not active. The plan and status carry
`activation` so the UI can say so without guessing.

| Agent | Config this fork writes | Install | Removal | Restart | User trust/activation | Verified against a real CLI |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` → `hooks` | supported | supported | required | may ask to review hooks / changed settings; approve the group that calls `CODR_CLI` | **no** |
| Codex | `~/.codex/hooks.json` → `hooks` | supported | supported | required | may show a hook review/trust prompt; approve the entry that calls the fork CLI | **no** |
| Gemini CLI | `~/.gemini/settings.json` → `hooks` | supported | supported | required | may ask to trust/review hooks; approve the `codr` group | **no** |
| Pi | `~/.pi/agent/extensions/codr-notifications.ts` | supported | supported | required | may ask to allow/trust the extension | **no** |
| OpenCode | nothing | unsupported | unsupported | — | use OpenCode's own approvals | n/a |
| Antigravity CLI | nothing | unsupported | unsupported | — | launching/basic status only | n/a |

`activation.verified` is `false` for every agent on purpose: this repository has
not exercised a real installed vendor CLI and its version-specific trust flow.
Writing and removing the configuration is implemented and tested; claiming the
hooks actually run in a given vendor version is release-validation evidence, not
this ticket's claim. The UI prints "Configured — trust required" (or "restart
required"), never "active", and repeats the per-agent steps.

`agent_hooks_status` reports `supported`/`unsupported`, the config state
(`installed`, `partial`, `not-installed`, `invalid`, `conflict`, `unsupported`),
whether the fork's own entries are present and current, the foreign group count
and the same activation instructions. `partial` means an older or incomplete
set of fork entries; `invalid` means the file cannot be parsed and is refused
rather than replaced; `conflict` means a foreign file occupies the Pi extension
path.

OpenCode and Antigravity have no structured hook adapter in version one (the
parent spec defers them). This fork neither writes nor removes their
configuration, and does not pretend their terminal detection is hook-backed.

## Permissions without a centralized UI

The permission path is unchanged and keeps its fallback: Claude Code and Codex
`PermissionRequest` hooks may wait for the app's own decision UI when a window
subscribes, and otherwise fall through to the agent's own prompt (`{}` from the
CLI, no hang). There is no centralized approval UI in version one, and none is
added here. Hooks are inert outside a fork pane: a shell that only carries
upstream's `TERAX_*` variables runs the CLI, which prints `{}` and exits 0.

## What the tests establish, and what they do not

Asserted against temporary config files (never the real home directory):

- plan/apply against a temp file; stale apply between preview and apply refused
  with no write; retry only after a fresh preview;
- install adds only fork entries; removal leaves upstream and user entries
  byte-identical, including comments and a foreign-only file;
- install/uninstall retry and coexistence, idempotence, stale-group
  reconciliation, symlinked configs and private permissions;
- status reports "configured" with trust required rather than "active";
- lookalike commands never become fork-owned.

Not verified here: real Claude Code, Codex, Gemini CLI or Pi trust/activation
flows in a specific vendor version, and the packaged-app/real-webview acceptance
seam (the app-lab runner is macOS-only today). Those remain release-validation
work. The revision check also cannot exclude an external writer that edits the
file between that check and the rename; it guarantees refusal of everything
observed before the check, not atomic exclusion of independent processes.

## See also

- [Agent capabilities](agent-capabilities.md) — launch, process status, structured
  events, notifications and control per agent, including the agents with no hook
  adapter (OpenCode, Grok, Antigravity CLI) and the distinction between
  process-derived status and a completed turn.

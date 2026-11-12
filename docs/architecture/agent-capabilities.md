# Agent capabilities: launch, status, events, notifications, control

This guide records what Terax can do with each terminal agent **separately**,
because the five capabilities have different mechanisms and different evidence.
A launcher entry is not a status feed, a status feed is not a completed turn, and
no capability here implies that an installed vendor CLI was certified.

`TERAX.md` wins over this document. Hook installation, review and fork ownership
are covered in [agent hooks](agent-hooks.md); the local control protocol is
covered in [CLI control plane](cli-control.md).

## The five capabilities

| Capability | Question it answers | Mechanism |
| --- | --- | --- |
| Launch | Can Terax start this agent in a pane? | `src/modules/agents/lib/launcher.ts`, `App.tsx` `launchAgentGroup` |
| Process status | Is an agent process attached to the pane, or gone? | shell OSC 133 boundaries and PTY close in `src-tauri/src/modules/pty/agent_detect.rs` |
| Structured events | Does the agent report turns, prompts, tools or permissions? | opt-in hooks (`agent-hooks.md`), plus the agent's own terminal notifications |
| Notifications | Will the user be told, and what will it say? | `src/modules/agents/lib/route.ts` |
| Control | Can the agent open a file in the right Space at a line? | `terax open <file> --line <n>` (`cli-control.md`) |

A pane can have launch and process status for an agent that has no structured
events at all. That is the normal state for OpenCode, Grok and the Antigravity
CLI.

## Launch

Every launcher writes only the configured command into a fresh pane; launching
never installs hooks, never rewrites agent configuration and never reads agent
files. Commands are user-editable (aliases and flags are allowed), validated as a
single line of at most 256 characters, and persisted per agent.

| Agent | Launcher id | Default command | Notes |
| --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | |
| Codex | `codex` | `codex` | |
| Gemini CLI | `gemini` | `gemini` | |
| Pi | `pi` | `pi` | |
| OpenCode | `opencode` | `opencode` | |
| Grok | `grok` | `grok` | |
| Antigravity CLI | `antigravity` | `antigravity` | Desktop app refused, see below |

The launcher also creates pane layouts for one to four instances in the current
Space's directory. That layout and the configured command are the whole launch
contract: no agent is auto-restarted after a layout restore.

### Antigravity CLI is not its desktop app

Antigravity ships a desktop application and a terminal CLI as separate entry
points. Terax can own a terminal pane, so it launches the CLI and never embeds,
drives or claims to control the GUI:

- `src/modules/agents/lib/launchTarget.ts` classifies the configured command. A
  desktop-app shape (`antigravity-desktop`, `antigravity-gui`, an `.app` bundle,
  a `.desktop` file, or an `open -a` / `xdg-open` / `gio open` / `gtk-launch` /
  `flatpak run` / `snap run` launcher) is **refused with an explanation**, not
  launched and mislabelled. The refusal is shown in the launcher panel and the
  launch callback re-checks it.
- The detector applies the same distinction when it decides whether a pane is
  running an agent: a GUI command line never arms the `antigravity` CLI, even
  though its name would otherwise match as a dash-suffixed alias.
- UI copy says "Antigravity CLI" wherever the agent is named.

The classification is a command-shape heuristic. It is deterministic and tested,
but it is not vendor certification: it does not prove which binary a user's
`antigravity` resolves to.

## Process status versus agent events

Two independent sources feed the status surfaces, and every surface says which
one it used:

- **Process** — the shell's command boundary (OSC 133) arms an agent when the
  command line matches a known agent, and disarms it when the command finishes or
  the PTY closes. This proves only *running* or *exited*.
- **Event** — an opt-in hook, or the terminal notification the agent itself sent.
  This is the only source that can say a turn ended or that the agent wants the
  user.

`src/modules/agents/lib/status.ts` derives the claim from the signal:

| Signal | Evidence | Session status | May claim a finished turn? |
| --- | --- | --- | --- |
| `started` | process | `running` | no |
| `working` | process | `running` | no |
| `attention` | event | `attention` | no |
| `finished` | event (hook stop, or the agent's own finish marker) | `running` | yes |
| `exited` | process | session dropped | **no** |

Rules that follow from this, and the labels that implement them:

- A running process is **never** evidence that the agent is working. Session rows
  and the bell say `running`, not "working".
- A process exit is reported as `process exited` and drops the agent entry. It
  never produces a completion notification, and the tab icon simply disappears.
- After a `finished` event the session stays `running`: the turn is over, the
  process is still attached and may start another turn.
- A **cancelled** turn is not a completed one. Claude Code's aborted `Stop` and
  Codex's `Interrupt` hook map to the quiet intent, so they do not emit
  "turn finished".
- The tab icon for a finished turn is announced as "Agent turn finished" (not
  "completed"), and attention as "Agent needs attention".

Notification titles are the only place a completion claim is user-visible
(`<agent> turn finished`), and they can only be raised by an agent event.

## Capability matrix

`verified here` means exercised by this repository's tests with synthetic
fixtures. **No vendor CLI, version or hook-trust flow was certified for this
ticket**; the release validation ticket owns that evidence.

| Agent | Launch | Process status | Structured events | Notifications | Control (file open / line) |
| --- | --- | --- | --- | --- | --- |
| Claude Code | launcher, configurable command — verified here | start/exit from OSC 133 — verified here | opt-in hooks: session, prompt, tools, permission, stop/stop-failure — plan/apply verified here | attention + turn-finished when hooks are installed; attention only otherwise — verified here | `terax open <file> --line <n>` from its pane — routing verified here |
| Codex | launcher, configurable — verified here | start/exit — verified here | opt-in hooks; aborted stop and interrupt are quiet — verified here | as Claude Code — verified here | as Claude Code |
| Gemini CLI | launcher, configurable — verified here | start/exit — verified here | opt-in hooks — verified here | as Claude Code — verified here | as Claude Code |
| Pi | launcher, configurable — verified here | start/exit — verified here | opt-in extension file — verified here | as Claude Code — verified here | as Claude Code |
| OpenCode | launcher, configurable — verified here | start/exit — verified here | **none** (hook-free) — verified here | attention only (agent's terminal notification); no turn-finished — verified here | as Claude Code |
| Grok | launcher, configurable — verified here | start/exit — verified here | **none** | attention only | as Claude Code |
| Antigravity CLI | launcher, configurable; desktop app refused — verified here | start/exit for the CLI, GUI never armed — verified here | **none** | attention only | as Claude Code |

Everything in the "control" column comes from the bundled `terax` helper in the
pane, not from the vendor's integration, so it does not depend on the agent
supporting anything. Nothing in this matrix is vendor-version certified: not the
binary name, not the flag syntax, not that a given release emits the OSC
sequences or hook payloads we expect.

## Notifications

Default notifications identify **who** and **why**, never **what**:

| Field | Content |
| --- | --- |
| Title | `<agent display name> needs attention` / `turn finished` / `run failed` |
| Body | `Space: <Space name>` (or `Workspace` when the Space is unknown) |
| Bell row | agent name, event kind, relative time |
| Stored notification | source, agent, kind, tab id, leaf id, timestamp, read flag |

The payload is built in one place (`routeAgentNotification`, using
`agentNotificationContent`) from an allowlist. No prompt, assistant message,
transcript, command, cwd or file path can enter it, because no caller supplies
message text: the bridge passes only the Space's *name*. The previous behavior —
using the terminal's title as the notification body — was removed for exactly
this reason, since a terminal title can echo a cwd or a prompt.

Other guarantees:

- **No focus stealing.** Delivery never raises or focuses a window; clicking a
  notification or the "Open" toast action is the only way to navigate.
  Navigating activates the tab/leaf the agent belongs to.
- **Sound off by default** (`agentNotificationSound` defaults to `false`); the
  user can enable it. A native notification is requested only when Terax is
  unfocused; focused-but-not-looking uses a toast or the bell.
- **Deduplication and rate limiting are retained** at two levels: a per-target
  2 s cooldown with a bounded key set in the frontend gate, plus the native
  terminal-notification limiter (1 s duplicate window, 5 per 10 s burst) and a
  3 s repeat window for generic attention while an agent waits.
- Attention and completion are separate kinds, so a finished turn does not
  double-count as unread attention in the badge.
- These are the app's notifications for agent attention/completion. Programs in
  any terminal can still send their own OSC 9/99/777 notifications; those are
  terminal output, bounded and rate limited, and are not rewritten.

## Control: caller-Space file opening

Unchanged and independent of the agent:

- `terax open <file> [--line <n>] [--no-focus] [--json]` from inside a pane
  targets that pane's Space and tab, even when another Space has UI focus. An
  external client with no pane context falls back to the active context.
- Files must be canonical paths to regular files inside an authorized workspace.
- The line target is passed to the editor as a goto-line request.
- Child agents inherit the caller context, so an agent launched in a pane can
  open a file in *its* Space without asking the user.
- Permission approval stays in each agent's own terminal. There is no
  centralized approval UI, and no new structured adapter is added here.

## Verification status

**Verified here (synthetic fixtures and pure derivation):**

- launcher defaults, command validation and persistence, pane layouts,
  hook-free launching;
- Antigravity CLI versus desktop-app command classification on both sides
  (TypeScript refusal, Rust detector);
- status derivation: process lifecycle never claims a finished turn; a finished
  event does not kill the session; an exit raises no completion;
- notification payload contents, Space fallback, dedupe and rate suppression,
  payload privacy (tab title / prompt text absent);
- sound default off, including migration for users who never stored a choice;
- hook intent for aborted stops and interrupts;
- caller-Space control routing (`resolveControlContext`).

**Not verified here:**

- any real installed OpenCode, Claude Code, Codex, Gemini CLI, Pi, Grok or
  Antigravity CLI: binary name, flags, OSC/hook payloads per vendor version,
  hook trust prompts, and whether the CLI ships separately from the GUI on
  Fedora;
- that a real desktop notification appears in GNOME/KDE with the expected
  privacy (no body excerpt) and without taking focus;
- the packaged-app acceptance seam (the app-lab runner is macOS-only today) and
  any distribution-specific behavior;
- Windows/WSL pane behavior for these agents.

Those are release-validation and maintainer evidence, not claims of this work.

## Tests

- `src/modules/agents/lib/launcher.test.ts` — launches, Antigravity refusal,
  hook-free launching.
- `src/modules/agents/lib/status.test.ts` — process versus event status.
- `src/modules/agents/lib/notificationContent.test.ts` — payload fields.
- `src/modules/agents/lib/route.test.ts` — sound preference, payload, cooldown.
- `src/modules/agents/lib/notificationGate.test.ts` — dedupe/rate limits.
- `src/modules/agents/components/AgentNotificationsBridge.test.ts` — signal to
  session/notification routing, privacy, exit without completion.
- `src/modules/settings/notificationDefaults.test.ts` — silent default.
- `src/modules/control/lib/context.test.ts` — caller-Space routing.
- `src-tauri/src/modules/pty/agent_detect.rs` (tests) — CLI versus desktop app,
  process lifecycle.
- `src-tauri/src/modules/agent_events.rs` (tests) — hook intent for aborted or
  interrupted turns.

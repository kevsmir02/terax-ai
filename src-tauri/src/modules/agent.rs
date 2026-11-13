use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{json, Value};

use super::agent_json;
use crate::modules::identity;

/// How an agent's config describes a hook, and which shell runs it on Windows.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Style {
    Claude,
    Codex,
    Gemini,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dialect {
    Posix,
    Cmd,
    PowerShell,
}

struct EventSpec {
    event: &'static str,
    /// Seconds; Gemini's millisecond field is derived from it.
    timeout: Option<u32>,
    /// Observe-only events that never need to delay the agent.
    background: bool,
    /// Installed when true; a Terax group for an unwanted event is removed.
    wanted: bool,
}

const fn event(event: &'static str) -> EventSpec {
    EventSpec {
        event,
        timeout: None,
        background: false,
        wanted: true,
    }
}

const fn background(event: &'static str) -> EventSpec {
    EventSpec {
        event,
        timeout: None,
        background: true,
        wanted: true,
    }
}

const fn timed(event: &'static str, timeout: u32) -> EventSpec {
    EventSpec {
        event,
        timeout: Some(timeout),
        background: false,
        wanted: true,
    }
}

impl EventSpec {
    /// Supported by the adapters but not installed until something consumes it.
    const fn off(mut self) -> Self {
        self.wanted = false;
        self
    }
}

struct AgentSpec {
    agent: &'static str,
    dir: &'static str,
    file: &'static str,
    style: Style,
    events: &'static [EventSpec],
}

/// What writing a configuration does *not* prove: the agent still has to
/// restart, and some versions ask the user to review/trust the hooks before
/// they run. Reported so a written file is never described as an active
/// integration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub restart_required: bool,
    pub trust_required: bool,
    pub summary: String,
    pub steps: Vec<String>,
    /// False until a real installed CLI version was exercised. Every adapter
    /// here is planned implementation, not validated vendor support.
    pub verified: bool,
}

/// An agent this fork deliberately has no structured hook adapter for.
struct UnsupportedAgent {
    agent: &'static str,
    summary: &'static str,
    steps: &'static [&'static str],
}

const UNSUPPORTED_AGENTS: &[UnsupportedAgent] = &[
    UnsupportedAgent {
        agent: "opencode",
        summary: "OpenCode has no structured hook adapter in version one: this fork does not write or remove its configuration. Attention comes from terminal and process signals only.",
        steps: &[
            "Keep using OpenCode's own permission prompts and approvals.",
            "Expect process/terminal attention, not session, prompt or permission events.",
        ],
    },
    UnsupportedAgent {
        agent: "antigravity",
        summary: "The Antigravity CLI has no structured hook adapter in version one: only launching and basic process status are supported. This fork does not write or remove its configuration.",
        steps: &[
            "Keep using Antigravity's own permission prompts and approvals.",
            "Expect launch/process status only, with no hook-based events.",
        ],
    },
];

/// The activation/trust instructions for one supported agent, in that agent's
/// own terms. `verified` stays false until the release-validation ticket runs
/// the real installed CLI.
fn activation(agent: &str) -> Activation {
    let cli = identity::env("CLI");
    if let Some(spec) = UNSUPPORTED_AGENTS.iter().find(|spec| spec.agent == agent) {
        return Activation {
            restart_required: false,
            trust_required: false,
            summary: spec.summary.to_string(),
            steps: spec.steps.iter().map(|step| (*step).to_string()).collect(),
            verified: false,
        };
    }
    match agent {
        "claude" => Activation {
            restart_required: true,
            trust_required: true,
            summary: "Writing ~/.claude/settings.json configures Claude Code; it does not activate the hooks. A running session keeps the hooks it started with, and a version that reviews changed settings will not run this group until you approve it.".to_string(),
            steps: vec![
                "Restart the Claude Code session (or open a new one) so it reads ~/.claude/settings.json.".to_string(),
                format!("If it asks you to review hooks or changed settings, approve the group whose command calls {cli}."),
                "Run one prompt and check that the notification arrives; this fork cannot observe that approval.".to_string(),
            ],
            verified: false,
        },
        "codex" => Activation {
            restart_required: true,
            trust_required: true,
            summary: "Writing hooks.json configures Codex; it does not activate the hooks. Codex reads the file when a session starts and may ask you to review hooks before running them.".to_string(),
            steps: vec![
                "Restart the Codex session so it reads ~/.codex/hooks.json.".to_string(),
                format!("If Codex shows a hook review or trust prompt, approve the entry that calls {cli}."),
                "Run one prompt and check the notification; approval is not observable from this fork.".to_string(),
            ],
            verified: false,
        },
        "gemini" => Activation {
            restart_required: true,
            trust_required: true,
            summary: "Writing settings.json configures Gemini CLI; it does not activate the hooks. Gemini reads hooks at session start, and a version with hook review will not run this group until you enable it.".to_string(),
            steps: vec![
                "Restart the Gemini CLI session so it reads ~/.gemini/settings.json.".to_string(),
                format!("If the installed version asks you to trust or review hooks, approve the Terax group (name {}).", identity::namespace()),
                "Run one prompt and check the notification; approval is not observable from this fork.".to_string(),
            ],
            verified: false,
        },
        "pi" => Activation {
            restart_required: true,
            trust_required: true,
            summary: format!(
                "Writing {} configures Pi; it does not activate the extension. Pi loads extensions when a session starts and may ask you to allow or trust one before it runs.",
                pi_extension_file()
            ),
            steps: vec![
                format!("Restart the Pi session so it loads ~/.pi/agent/extensions/{}.", pi_extension_file()),
                "If Pi asks to allow or trust the extension, approve it; it only spawns this fork's CLI when that shell carries the fork's variables.".to_string(),
                "Run one prompt and check the notification; approval is not observable from this fork.".to_string(),
            ],
            verified: false,
        },
        other => Activation {
            restart_required: false,
            trust_required: false,
            summary: format!("{other} has no structured hook adapter in version one; nothing is written or removed."),
            steps: vec!["Use the agent's own permission prompts and approvals.".to_string()],
            verified: false,
        },
    }
}

/// Longer than the longest decision wait the CLI accepts plus its socket
/// slack, so Terax always answers before the agent gives up on the hook.
const DECISION_HOOK_TIMEOUT: u32 = terax_control_protocol::hook::MAX_DECISION_SECS + 60;

const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        agent: "claude",
        dir: ".claude",
        file: "settings.json",
        style: Style::Claude,
        events: &[
            event("SessionStart"),
            event("UserPromptSubmit"),
            background("PreToolUse").off(),
            timed("PermissionRequest", DECISION_HOOK_TIMEOUT),
            background("PostToolUse").off(),
            background("PostToolUseFailure").off(),
            event("Notification"),
            event("Stop"),
            event("StopFailure").off(),
            event("SubagentStart").off(),
            event("SubagentStop").off(),
            timed("SessionEnd", 5),
        ],
    },
    AgentSpec {
        agent: "codex",
        dir: ".codex",
        file: "hooks.json",
        style: Style::Codex,
        events: &[
            event("SessionStart"),
            event("UserPromptSubmit"),
            background("PreToolUse").off(),
            timed("PermissionRequest", DECISION_HOOK_TIMEOUT),
            background("PostToolUse").off(),
            event("Stop"),
        ],
    },
    AgentSpec {
        agent: "gemini",
        dir: ".gemini",
        file: "settings.json",
        style: Style::Gemini,
        events: &[
            event("SessionStart"),
            event("BeforeAgent"),
            event("BeforeTool").off(),
            event("AfterTool").off(),
            event("Notification"),
            event("AfterAgent"),
            event("SessionEnd"),
        ],
    },
];

const PI_EXTENSION_DIR: &str = ".pi/agent/extensions";

/// The extension file this fork owns inside the (shared) Pi extensions directory.
/// Upstream's `terax-notifications.ts` sits next to it and is never touched.
fn pi_extension_file() -> String {
    format!("{}-notifications.ts", identity::namespace())
}

/// Marker of this fork's extension `v*` family, so only our own stale versions are
/// rewritten or removed.
fn pi_extension_family() -> String {
    format!("{}-pi-notifications-v", identity::namespace())
}

/// Version of this fork's Pi extension; bumping it makes stale files rewrite.
const PI_VERSION: &str = "2";
struct PiHook {
    pi_event: &'static str,
    hook: &'static str,
    /// JavaScript object literal of payload fields, from the Pi event `e`.
    fields: &'static str,
    wanted: bool,
}

const PI_HOOKS: &[PiHook] = &[
    PiHook {
        pi_event: "session_start",
        hook: "SessionStart",
        fields: "{ source: e.reason }",
        wanted: true,
    },
    PiHook {
        pi_event: "before_agent_start",
        hook: "UserPromptSubmit",
        fields: "{ prompt: e.prompt }",
        wanted: true,
    },
    PiHook {
        pi_event: "tool_execution_start",
        hook: "PreToolUse",
        fields: "{ tool_name: e.toolName, tool_use_id: e.toolCallId, tool_input: e.args }",
        wanted: false,
    },
    PiHook {
        pi_event: "tool_execution_end",
        hook: "PostToolUse",
        fields: "{ tool_name: e.toolName, tool_use_id: e.toolCallId, is_error: e.isError }",
        wanted: false,
    },
    PiHook {
        pi_event: "agent_settled",
        hook: "Stop",
        fields: "{ aborted: e.aborted, last_assistant_message: takeMessage() }",
        wanted: true,
    },
    PiHook {
        pi_event: "session_shutdown",
        hook: "SessionEnd",
        fields: "{ reason: e.reason }",
        wanted: true,
    },
];

const PI_HEAD: &str = r#"__HEADER__
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const cli = process.env.__CLI_ENV__;
  if (!cli || !process.env.__PANE_ENV__) return;

  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };

  const send = (event: string, ctx: any, extra: Record<string, unknown> = {}) => {
    attempt(() => {
      const child = spawn(cli, ["hook", "pi", event], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          session_id: attempt(() => ctx.sessionManager.getSessionId()),
          transcript_path: attempt(() => ctx.sessionManager.getSessionFile()),
          cwd: ctx.cwd,
          ...extra,
        }),
      );
    });
  };

  let lastMessage: string | undefined;
  const takeMessage = () => {
    const text = lastMessage;
    lastMessage = undefined;
    return text;
  };

  pi.on("message_end", (e: any) => {
    const message = e.message;
    if (message?.role !== "assistant") return;
    const text = attempt(() =>
      (Array.isArray(message.content) ? message.content : [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join(""),
    );
    if (text) lastMessage = text;
  });

"#;

/// The Pi extension: one handler per wanted entry of `PI_HOOKS`.
fn pi_extension() -> String {
    let mut out = PI_HEAD
        .replace(
            "__HEADER__",
            &format!("// {}{}", pi_extension_family(), PI_VERSION),
        )
        .replace("__CLI_ENV__", &identity::env("CLI"))
        .replace("__PANE_ENV__", &identity::env("PANE_ID"));
    for hook in PI_HOOKS.iter().filter(|hook| hook.wanted) {
        out.push_str(&format!(
            "  pi.on(\"{}\", (e: any, ctx: any) => send(\"{}\", ctx, {}));\n",
            hook.pi_event, hook.hook, hook.fields
        ));
    }
    out.push_str("}\n");
    out
}

fn find(agent: &str) -> Result<&'static AgentSpec, String> {
    AGENTS
        .iter()
        .find(|s| s.agent == agent)
        .ok_or_else(|| format!("unknown agent {agent}"))
}

fn shell_for(style: Style, windows: bool) -> Dialect {
    match (style, windows) {
        (_, false) => Dialect::Posix,
        (Style::Claude, true) => Dialect::PowerShell,
        (Style::Codex | Style::Gemini, true) => Dialect::Cmd,
    }
}

/// Runs the CLI this fork exposes through its own `*_CLI` variable, and prints an
/// empty JSON object where there is none (outside this fork's terminal, or a stale
/// path) because some agents reject an empty stdout. No user data is interpolated.
fn hook_command(dialect: Dialect, agent: &str, event: &str) -> String {
    let cli = identity::env("CLI");
    match dialect {
        Dialect::Posix => {
            format!(r#"[ -n "${cli}" ] && "${cli}" hook {agent} {event} || printf '{{}}'"#)
        }
        Dialect::Cmd => {
            format!(r#"if defined {cli} ("%{cli}%" hook {agent} {event}) else (echo {{}})"#)
        }
        Dialect::PowerShell => {
            format!(r#"if ($env:{cli}) {{ & $env:{cli} hook {agent} {event} }} else {{ '{{}}' }}"#)
        }
    }
}

fn hook_group(spec: &AgentSpec, event: &EventSpec, windows: bool) -> Value {
    let command = hook_command(shell_for(spec.style, windows), spec.agent, event.event);
    let mut hook = json!({ "type": "command", "command": command });
    match spec.style {
        Style::Claude => {
            if windows {
                hook["shell"] = json!("powershell");
            }
            if let Some(timeout) = event.timeout {
                hook["timeout"] = json!(timeout);
            }
            if event.background {
                hook["async"] = json!(true);
            }
        }
        Style::Codex => {
            if windows {
                hook["commandWindows"] = hook["command"].clone();
            }
            if let Some(timeout) = event.timeout {
                hook["timeout"] = json!(timeout);
            }
            // Codex starts each hook through the login shell, which is too
            // slow to sit in front of every tool call.
            if event.background {
                hook["async"] = json!(true);
            }
        }
        Style::Gemini => {
            hook["name"] = json!(identity::namespace());
            if let Some(timeout) = event.timeout {
                hook["timeout"] = json!(u64::from(timeout) * 1000);
            }
        }
    }
    let mut group = json!({ "hooks": [hook] });
    if spec.style == Style::Gemini {
        group["matcher"] = json!("*");
    }
    group
}

/// True only for commands this fork wrote. An entry belongs to this fork when
/// its command *invokes* this fork's own CLI (`CODR_CLI`, from
/// the identity table) in one of the three shell dialects the adapters emit.
/// Upstream's hooks (`$TERAX_CLI`, `notify;Terax;`, `terax;notify`,
/// `__terax_notify`) and any user hook are deliberately not ours: they are
/// another application's or the user's configuration, so this fork never
/// rewrites or removes them, even when they share the same file.
fn command_is_ours(command: &str) -> bool {
    let cli = identity::env("CLI");
    [
        format!("\"${cli}\" hook "),
        format!("%{cli}%\" hook "),
        format!("$env:{cli} hook "),
    ]
    .iter()
    .any(|invocation| command.contains(invocation.as_str()))
}

/// A matcher group is ours when it exists only to run this fork's commands, so a
/// group the user added their own commands to is never taken apart.
fn group_is_ours(group: &Value) -> bool {
    let Some(hooks) = group.get("hooks").and_then(Value::as_array) else {
        return false;
    };
    !hooks.is_empty()
        && hooks.iter().all(|hook| {
            hook.get("command")
                .and_then(Value::as_str)
                .is_some_and(command_is_ours)
        })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Action {
    Install,
    Uninstall,
}

impl Action {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "install" => Ok(Self::Install),
            "uninstall" => Ok(Self::Uninstall),
            other => Err(format!("unknown action {other}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Uninstall => "uninstall",
        }
    }
}

fn blank(contents: Option<&str>) -> bool {
    contents.is_none_or(|text| text.trim().is_empty())
}

/// The config text after the action; `None` when the file would not exist.
fn json_after(
    spec: &AgentSpec,
    existing: Option<&str>,
    action: Action,
    windows: bool,
    path: &Path,
) -> Result<Option<String>, String> {
    if let Some(text) = existing.filter(|text| !text.trim().is_empty()) {
        agent_json::validate(text).map_err(|error| {
            format!(
                "{} is not valid JSON ({error}); refusing to edit",
                path.display()
            )
        })?;
    }
    let mut text = existing.filter(|_| !blank(existing)).map(str::to_string);
    match action {
        Action::Install => {
            let created = text.is_none();
            let mut current = text.take().unwrap_or_else(|| "{}".to_string());
            for event in spec.events {
                let edited = if event.wanted {
                    let group = hook_group(spec, event, windows);
                    agent_json::upsert(&current, &["hooks", event.event], &group, &group_is_ours)
                } else {
                    agent_json::remove_matching(&current, &["hooks", event.event], &group_is_ours)
                };
                current = edited.map_err(|error| format!("{}: {error}", path.display()))?;
            }
            if created {
                current.push('\n');
            }
            Ok(Some(current))
        }
        Action::Uninstall => {
            let Some(mut current) = text else {
                return Ok(existing.map(str::to_string));
            };
            for event in spec.events {
                current =
                    agent_json::remove_matching(&current, &["hooks", event.event], &group_is_ours)
                        .map_err(|error| format!("{}: {error}", path.display()))?;
            }
            Ok(Some(current))
        }
    }
}

fn pi_after(existing: Option<&str>, action: Action, path: &Path) -> Result<Option<String>, String> {
    let foreign = existing
        .is_some_and(|text| !text.trim().is_empty() && !text.contains(&pi_extension_family()));
    match action {
        Action::Install if foreign => Err(format!(
            "{} is not managed by Terax; refusing to overwrite",
            path.display()
        )),
        Action::Install => Ok(Some(pi_extension())),
        Action::Uninstall if foreign => Ok(existing.map(str::to_string)),
        Action::Uninstall => Ok(None),
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HooksPlan {
    pub agent: String,
    pub action: String,
    pub path: String,
    /// File contents now; `None` when the file does not exist.
    pub before: Option<String>,
    /// File contents after applying; `None` when the file would be removed.
    pub after: Option<String>,
    /// Fingerprint of the observed `before` contents. Apply echoes it back and
    /// refuses when the file no longer matches, so a preview is never applied
    /// to contents the user did not review.
    pub revision: String,
    pub changed: bool,
    /// Hook groups owned by another tool or by upstream, which stay untouched.
    pub foreign_groups: usize,
    pub activation: Activation,
}

/// A content fingerprint: `absent`, or the byte length plus an FNV-1a hash of
/// the bytes. It changes with content even when the length and mtime do not,
/// which is what a stale-preview check needs.
fn revision_of(existing: Option<&str>) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    match existing {
        None => "absent".to_string(),
        Some(text) => {
            let mut hash = OFFSET;
            for byte in text.as_bytes() {
                hash ^= u64::from(*byte);
                hash = hash.wrapping_mul(PRIME);
            }
            format!("{}:{hash:016x}", text.len())
        }
    }
}

/// Matcher groups under the events this fork manages that it does not own.
fn foreign_groups(agent: &str, existing: Option<&str>) -> usize {
    let Some(text) = existing.filter(|text| !text.trim().is_empty()) else {
        return 0;
    };
    if agent == "pi" {
        return usize::from(!text.contains(&pi_extension_family()));
    }
    let Ok(spec) = find(agent) else {
        return 0;
    };
    spec.events
        .iter()
        .map(|event| {
            agent_json::array_at(text, &["hooks", event.event]).map_or(0, |groups| {
                groups.iter().filter(|group| !group_is_ours(group)).count()
            })
        })
        .sum()
}

/// True when at least one entry in the file is this fork's.
fn has_fork_entry(agent: &str, existing: Option<&str>) -> bool {
    let Some(text) = existing.filter(|text| !text.trim().is_empty()) else {
        return false;
    };
    if agent == "pi" {
        return text.contains(&pi_extension_family());
    }
    let Ok(spec) = find(agent) else {
        return false;
    };
    spec.events.iter().any(|event| {
        agent_json::array_at(text, &["hooks", event.event])
            .is_some_and(|groups| groups.iter().any(group_is_ours))
    })
}

fn home_path(dir: &str, file: &str) -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "could not resolve home dir".to_string())?
        .join(dir)
        .join(file))
}

fn config_path(agent: &str) -> Result<PathBuf, String> {
    if agent == "pi" {
        return home_path(PI_EXTENSION_DIR, &pi_extension_file());
    }
    let spec = find(agent)?;
    home_path(spec.dir, spec.file)
}

fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn plan_at(
    agent: &str,
    action: Action,
    path: &Path,
    existing: Option<String>,
    windows: bool,
) -> Result<HooksPlan, String> {
    let after = if agent == "pi" {
        pi_after(existing.as_deref(), action, path)?
    } else {
        json_after(find(agent)?, existing.as_deref(), action, windows, path)?
    };
    let changed = after != existing;
    let foreign = foreign_groups(agent, existing.as_deref());
    Ok(HooksPlan {
        agent: agent.to_string(),
        action: action.as_str().to_string(),
        path: path.display().to_string(),
        revision: revision_of(existing.as_deref()),
        before: existing,
        after,
        changed,
        foreign_groups: foreign,
        activation: activation(agent),
    })
}

fn plan(agent: &str, action: Action) -> Result<HooksPlan, String> {
    let path = config_path(agent)?;
    let existing = read_existing(&path)?;
    plan_at(agent, action, &path, existing, cfg!(windows))
}

/// Writes through a symlink instead of replacing it (dotfile managers link
/// these files), and keeps the permissions the user chose.
fn write_target(path: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            std::fs::canonicalize(path).map_err(|e| format!("resolve {}: {e}", path.display()))
        }
        Ok(_) => Ok(path.to_path_buf()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let target = write_target(path)?;
    let dir = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", target.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (mut file, tmp) = create_temp(dir, &name)?;
    let written = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    // Widening to the target's mode is safe: the contents were private until now.
    if let Ok(metadata) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, metadata.permissions());
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename into {}: {e}", target.display())
    })
}

/// A fresh, private (0600 on Unix) sibling of the target, never shared with a
/// concurrent write.
fn create_temp(dir: &Path, name: &str) -> Result<(std::fs::File, PathBuf), String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(
        ".{name}.terax-tmp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let file = options
        .open(&tmp)
        .map_err(|e| format!("create {}: {e}", tmp.display()))?;
    Ok((file, tmp))
}

fn apply_plan(plan: &HooksPlan) -> Result<(), String> {
    let path = PathBuf::from(&plan.path);
    if read_existing(&path)? != plan.before {
        return Err(format!(
            "{} changed since the preview; review the new diff first",
            path.display()
        ));
    }
    if !plan.changed {
        return Ok(());
    }
    match &plan.after {
        Some(contents) => write_atomic(&path, contents),
        None => {
            let target = write_target(&path)?;
            std::fs::remove_file(&target).map_err(|e| format!("remove {}: {e}", target.display()))
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HooksStatus {
    pub agent: String,
    /// Empty for an agent this fork has no supported adapter for.
    pub path: String,
    pub support: Support,
    /// `installed` | `partial` | `not-installed` | `invalid` | `conflict` | `unsupported`
    pub config_state: &'static str,
    /// The fork's entries are present and current. This is *not* "active":
    /// see `activation`.
    pub installed: bool,
    pub revision: Option<String>,
    pub foreign_groups: usize,
    pub activation: Activation,
    pub note: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Support {
    Supported,
    Unsupported,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HooksApply {
    /// `applied` | `unchanged` | `stale`. A stale apply wrote nothing.
    pub outcome: &'static str,
    pub revision: String,
    pub status: HooksStatus,
}

fn unsupported(agent: &str) -> bool {
    UNSUPPORTED_AGENTS.iter().any(|spec| spec.agent == agent)
}

fn unsupported_status(agent: &str, note: Option<String>) -> HooksStatus {
    HooksStatus {
        agent: agent.to_string(),
        path: String::new(),
        support: Support::Unsupported,
        config_state: "unsupported",
        installed: false,
        revision: None,
        foreign_groups: 0,
        activation: activation(agent),
        note,
    }
}

fn status_for(
    agent: &str,
    path: &Path,
    existing: Option<&str>,
    config_state: &'static str,
    installed: bool,
    note: Option<String>,
) -> HooksStatus {
    HooksStatus {
        agent: agent.to_string(),
        path: path.display().to_string(),
        support: Support::Supported,
        config_state,
        installed,
        revision: Some(revision_of(existing)),
        foreign_groups: foreign_groups(agent, existing),
        activation: activation(agent),
        note,
    }
}

/// The honest state of one agent's configuration file: what is on disk, what
/// this fork owns, and what the agent still needs before the hooks run.
fn status_at(agent: &str, path: &Path) -> HooksStatus {
    if unsupported(agent) {
        return unsupported_status(agent, None);
    }
    if agent != "pi" && find(agent).is_err() {
        return unsupported_status(agent, Some(format!("unknown agent {agent}")));
    }
    let existing = match read_existing(path) {
        Ok(existing) => existing,
        Err(error) => {
            return status_for(agent, path, None, "invalid", false, Some(error));
        }
    };
    match plan_at(
        agent,
        Action::Install,
        path,
        existing.clone(),
        cfg!(windows),
    ) {
        Ok(plan) if !plan.changed => {
            status_for(agent, path, existing.as_deref(), "installed", true, None)
        }
        Ok(_) if has_fork_entry(agent, existing.as_deref()) => {
            status_for(agent, path, existing.as_deref(), "partial", false, None)
        }
        Ok(_) => status_for(
            agent,
            path,
            existing.as_deref(),
            "not-installed",
            false,
            None,
        ),
        Err(error) => {
            let state = if agent == "pi"
                && existing
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty())
            {
                "conflict"
            } else {
                "invalid"
            };
            status_for(agent, path, existing.as_deref(), state, false, Some(error))
        }
    }
}

/// The honest state of one agent's configuration, at its real home path.
fn status(agent: &str) -> HooksStatus {
    if unsupported(agent) {
        return unsupported_status(agent, None);
    }
    match config_path(agent) {
        Ok(path) => status_at(agent, &path),
        Err(error) => unsupported_status(agent, Some(error)),
    }
}

/// What installing or removing would change, for a diff preview.
#[tauri::command]
pub async fn agent_hooks_plan(agent: String, action: String) -> Result<HooksPlan, String> {
    let action = Action::parse(&action)?;
    super::fs::blocking(move || plan(&agent, action)).await
}

/// Validates a preview against the observed revision, then writes it. The
/// caller (the Tauri command) refuses a stale plan instead of writing it.
fn apply_at(
    agent: &str,
    action: Action,
    path: &Path,
    revision: &str,
) -> Result<HooksApply, String> {
    let current = plan_at(agent, action, path, read_existing(path)?, cfg!(windows))?;
    if current.revision != revision {
        return Ok(HooksApply {
            outcome: "stale",
            revision: current.revision,
            status: status_at(agent, path),
        });
    }
    if !current.changed {
        return Ok(HooksApply {
            outcome: "unchanged",
            revision: current.revision,
            status: status_at(agent, path),
        });
    }
    apply_plan(&current)?;
    let after = read_existing(path)?;
    Ok(HooksApply {
        outcome: "applied",
        revision: revision_of(after.as_deref()),
        status: status_at(agent, path),
    })
}

fn apply(agent: &str, action: Action, revision: &str) -> Result<HooksApply, String> {
    let path = config_path(agent)?;
    apply_at(agent, action, &path, revision)
}

/// Applies a previewed plan against the revision it was computed from. A file
/// that changed after the preview returns `stale` and is not written.
#[tauri::command]
pub async fn agent_hooks_apply(
    agent: String,
    action: String,
    revision: String,
) -> Result<HooksApply, String> {
    let action = Action::parse(&action)?;
    super::fs::blocking(move || apply(&agent, action, &revision)).await
}

#[tauri::command]
pub async fn agent_hooks_status(agent: String) -> HooksStatus {
    tauri::async_runtime::spawn_blocking(move || status(&agent))
        .await
        .unwrap_or_else(|_| unsupported_status("unknown", Some("status task failed".to_string())))
}

// The raw OSC 777 bytes older hooks emitted. Kept so an old Windows hook
// config still pointing at `__terax_notify` keeps working until it is migrated.
#[cfg(any(windows, test))]
fn conout_marker(agent: &str, event: &str) -> String {
    format!("\x1b]777;notify;Terax;{agent};{event}\x07")
}

#[cfg(windows)]
pub fn emit_conout_marker(agent: &str, event: &str) {
    use std::io::Write;
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};

    if std::env::var_os(identity::env("TERMINAL")).is_none() {
        return;
    }
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("CONOUT$")
    {
        let _ = f.write_all(conout_marker(agent, event).as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(agent: &str) -> &'static AgentSpec {
        find(agent).unwrap()
    }

    fn path() -> PathBuf {
        PathBuf::from("/home/me/.agent/config.json")
    }

    fn install(agent: &str, existing: Option<&str>, windows: bool) -> String {
        json_after(spec(agent), existing, Action::Install, windows, &path())
            .unwrap()
            .unwrap()
    }

    fn parsed(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn commands(root: &Value, event: &str) -> Vec<String> {
        root["hooks"][event]
            .as_array()
            .map(|groups| {
                groups
                    .iter()
                    .flat_map(|group| group["hooks"].as_array().cloned().unwrap_or_default())
                    .filter_map(|hook| hook["command"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn commands_resolve_the_cli_through_the_environment_for_every_shell() {
        assert_eq!(
            hook_command(Dialect::Posix, "codex", "Stop"),
            r#"[ -n "$CODR_CLI" ] && "$CODR_CLI" hook codex Stop || printf '{}'"#
        );
        assert_eq!(
            hook_command(Dialect::Cmd, "gemini", "AfterAgent"),
            r#"if defined CODR_CLI ("%CODR_CLI%" hook gemini AfterAgent) else (echo {})"#
        );
        assert_eq!(
            hook_command(Dialect::PowerShell, "claude", "Stop"),
            r#"if ($env:CODR_CLI) { & $env:CODR_CLI hook claude Stop } else { '{}' }"#
        );
    }

    #[test]
    fn no_command_embeds_a_path_or_interpolated_input() {
        for agent in AGENTS {
            for windows in [false, true] {
                for event in agent.events {
                    let group = hook_group(agent, event, windows);
                    let command = group["hooks"][0]["command"].as_str().unwrap();
                    assert!(command.contains("CODR_CLI"), "{command}");
                    assert!(
                        command.chars().all(
                            |c| c.is_ascii_alphanumeric() || " \"$%{}()[]&|'-=_:\\".contains(c)
                        ),
                        "{command}"
                    );
                    assert!(group_is_ours(&group));
                }
            }
        }
    }

    fn wanted(agent: &str) -> Vec<&'static str> {
        spec(agent)
            .events
            .iter()
            .filter(|event| event.wanted)
            .map(|event| event.event)
            .collect()
    }

    #[test]
    fn claude_installs_only_the_lifecycle_events_with_platform_shells() {
        assert_eq!(
            wanted("claude"),
            [
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "Notification",
                "Stop",
                "SessionEnd"
            ]
        );
        let unix = parsed(&install("claude", None, false));
        let mut keys: Vec<_> = unix["hooks"].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        let mut expected = wanted("claude");
        expected.sort();
        assert_eq!(keys, expected);
        for event in wanted("claude") {
            assert_eq!(commands(&unix, event).len(), 1, "{event}");
        }
        let hook = &unix["hooks"]["PermissionRequest"][0]["hooks"][0];
        assert_eq!(hook["timeout"], DECISION_HOOK_TIMEOUT);
        assert!(hook.get("async").is_none());
        assert!(hook.get("shell").is_none());
        assert_eq!(unix["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 5);
        assert!(commands(&unix, "Stop")[0].starts_with("[ -n \"$CODR_CLI\" ]"));

        let windows = parsed(&install("claude", None, true));
        let hook = &windows["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(hook["shell"], "powershell");
        assert!(hook["command"]
            .as_str()
            .unwrap()
            .starts_with("if ($env:CODR_CLI)"));
    }

    #[test]
    fn codex_installs_the_lifecycle_events_with_a_windows_override() {
        assert_eq!(
            wanted("codex"),
            [
                "SessionStart",
                "UserPromptSubmit",
                "PermissionRequest",
                "Stop"
            ]
        );
        let unix = parsed(&install("codex", None, false));
        assert_eq!(unix["hooks"].as_object().unwrap().len(), 4);
        for event in wanted("codex") {
            assert_eq!(commands(&unix, event).len(), 1, "{event}");
        }
        assert!(unix["hooks"]["Stop"][0]["hooks"][0]
            .get("commandWindows")
            .is_none());
        for event in wanted("codex") {
            assert!(unix["hooks"][event][0]["hooks"][0].get("async").is_none());
        }
        let windows = parsed(&install("codex", None, true));
        let hook = &windows["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(hook["commandWindows"], hook["command"]);
        assert!(hook["command"]
            .as_str()
            .unwrap()
            .starts_with("if defined CODR_CLI"));
    }

    #[test]
    fn background_events_are_marked_async_for_the_agents_that_support_it() {
        let tool = background("PreToolUse");
        assert_eq!(
            hook_group(spec("claude"), &tool, false)["hooks"][0]["async"],
            true
        );
        assert_eq!(
            hook_group(spec("codex"), &tool, false)["hooks"][0]["async"],
            true
        );
        assert!(hook_group(spec("gemini"), &tool, false)["hooks"][0]
            .get("async")
            .is_none());
    }

    #[test]
    fn gemini_uses_matchers_names_and_cmd_on_windows() {
        assert_eq!(
            wanted("gemini"),
            [
                "SessionStart",
                "BeforeAgent",
                "Notification",
                "AfterAgent",
                "SessionEnd"
            ]
        );
        let unix = parsed(&install("gemini", None, false));
        assert_eq!(unix["hooks"].as_object().unwrap().len(), 5);
        assert_eq!(unix["hooks"]["BeforeAgent"][0]["matcher"], "*");
        assert_eq!(
            unix["hooks"]["AfterAgent"][0]["hooks"][0]["name"],
            identity::namespace()
        );
        assert!(commands(&unix, "AfterAgent")[0].contains("hook gemini AfterAgent"));
        let windows = parsed(&install("gemini", None, true));
        assert!(commands(&windows, "Notification")[0]
            .starts_with("if defined CODR_CLI"));
    }

    #[test]
    fn no_per_tool_call_hook_is_installed_for_any_agent() {
        const TOOL_LEVEL: [&str; 5] = [
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "BeforeTool",
            "AfterTool",
        ];
        for agent in AGENTS {
            for event in agent.events {
                if TOOL_LEVEL.contains(&event.event) {
                    assert!(!event.wanted, "{} {}", agent.agent, event.event);
                }
            }
            for windows in [false, true] {
                let text = install(agent.agent, None, windows);
                for event in TOOL_LEVEL {
                    assert!(!text.contains(event), "{} {event}", agent.agent);
                }
            }
        }
        let extension = pi_extension();
        assert!(!extension.contains("tool_execution"));
        assert!(!extension.contains("PreToolUse"));
        assert!(!extension.contains("PostToolUse"));
    }

    fn with_every_event_installed(agent: &str, windows: bool, base: &str) -> String {
        let spec = spec(agent);
        let mut text = base.to_string();
        for event in spec.events {
            let group = hook_group(spec, event, windows);
            text =
                agent_json::upsert(&text, &["hooks", event.event], &group, &group_is_ours).unwrap();
        }
        text
    }

    #[test]
    fn install_reconciles_away_stale_groups_it_no_longer_wants() {
        for agent in ["claude", "codex", "gemini"] {
            for windows in [false, true] {
                let user = "{\n  \"hooks\": {\n    \"PreToolUse\": [\n      { \"hooks\": [ { \"type\": \"command\", \"command\": \"audit\" } ] }\n    ],\n    \"BeforeTool\": [\n      { \"hooks\": [ { \"type\": \"command\", \"command\": \"audit\" } ] }\n    ]\n  }\n}\n";
                let bloated = with_every_event_installed(agent, windows, user);
                let reconciled = install(agent, Some(&bloated), windows);
                let value = parsed(&reconciled);
                let hooks = value["hooks"].as_object().unwrap();
                for event in spec(agent).events {
                    let ours = commands(&value, event.event)
                        .iter()
                        .filter(|command| {
                            command.contains("CODR_CLI")
                                || command.contains("hook ")
                        })
                        .count();
                    assert_eq!(ours, usize::from(event.wanted), "{agent} {}", event.event);
                    if !event.wanted && !["PreToolUse", "BeforeTool"].contains(&event.event) {
                        assert!(!hooks.contains_key(event.event), "{agent} {}", event.event);
                    }
                }
                for key in ["PreToolUse", "BeforeTool"] {
                    if spec(agent).events.iter().any(|event| event.event == key) {
                        assert_eq!(commands(&value, key), ["audit"], "{agent} {key}");
                    }
                }
                assert_eq!(install(agent, Some(&reconciled), windows), reconciled);
                let fresh = install(agent, Some(user), windows);
                assert_eq!(
                    parsed(&reconciled),
                    parsed(&fresh),
                    "{agent} windows={windows}"
                );
                assert!(
                    !plan_at(
                        agent,
                        Action::Install,
                        &path(),
                        Some(reconciled.clone()),
                        windows
                    )
                    .unwrap()
                    .changed
                );
            }
        }
    }

    /// Coexistence: an installed upstream Terax writes its own hook groups into the same
    /// agent configuration files (`$TERAX_CLI`, `notify;Terax;`, `__terax_notify`). Those
    /// groups belong to the other application: installing or removing this fork's hooks
    /// must leave them exactly as they were.
    #[test]
    fn upstream_hook_groups_are_foreign_and_never_rewritten_or_removed() {
        let upstream_group = |event: &str| {
            format!(
                r#"{{ "hooks": [ {{ "type": "command", "command": "[ -n \"$TERAX_CLI\" ] && \"$TERAX_CLI\" hook claude {event} || printf '{{}}'", "timeout": 30 }} ] }}"#
            )
        };
        let user_group = r#"{ "hooks": [ { "type": "command", "command": "notify-send done" } ] }"#;
        let existing = format!(
            "{{\n  \"hooks\": {{\n    \"Stop\": [\n      {},\n      {user_group}\n    ],\n    \"Notification\": [\n      {}\n    ]\n  }}\n}}\n",
            upstream_group("Stop"),
            upstream_group("Notification")
        );
        let before: Value = parsed(&existing);
        let upstream_before = before["hooks"]["Stop"].as_array().unwrap()[0].clone();

        // The upstream command is not ours, so it is never reconciled away.
        let upstream_command =
            r#"[ -n "$TERAX_CLI" ] && "$TERAX_CLI" hook claude Stop || printf '{}'"#;
        assert!(!command_is_ours(upstream_command));
        assert!(!command_is_ours(
            r#"[ -n "$TERAX_TERMINAL" ] && printf '\033]777;notify;Terax;claude;Stop\007' || true"#
        ));
        assert!(command_is_ours(&hook_command(
            Dialect::Posix,
            "claude",
            "Stop"
        )));

        for agent in ["claude", "codex", "gemini"] {
            for windows in [false, true] {
                let installed = install(agent, Some(&existing), windows);
                let value = parsed(&installed);
                let upstream_now = value["hooks"]["Stop"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|group| serde_json::to_string(group).unwrap().contains("$TERAX_CLI"))
                    .unwrap_or_else(|| panic!("{agent} windows={windows}: upstream group removed"));
                assert_eq!(upstream_now, &upstream_before, "{agent} windows={windows}");

                let removed = json_after(
                    spec(agent),
                    Some(&installed),
                    Action::Uninstall,
                    windows,
                    &path(),
                )
                .unwrap()
                .unwrap();
                let value: Value = parsed(&removed);
                assert!(
                    commands(&value, "Stop")
                        .iter()
                        .any(|c| c.contains("$TERAX_CLI")),
                    "{agent} windows={windows}: uninstall removed the upstream hook"
                );
                assert!(
                    commands(&value, "Notification")
                        .iter()
                        .any(|c| c.contains("$TERAX_CLI")),
                    "{agent} windows={windows}: uninstall removed the upstream notification hook"
                );
                assert!(
                    serde_json::to_string(&value)
                        .unwrap()
                        .contains("notify-send done"),
                    "{agent} windows={windows}: uninstall removed the user's own hook"
                );
            }
        }
    }

    /// Coexistence on disk: our Pi extension is a *different file* next to upstream's, and a
    /// file with foreign contents at our path is refused instead of overwritten.
    #[test]
    fn the_pi_extension_leaves_upstreams_file_alone_and_refuses_foreign_content() {
        let dir = tempfile::tempdir().unwrap();
        let extensions = dir.path().join("extensions");
        std::fs::create_dir_all(&extensions).unwrap();
        let upstream_body = "// terax-pi-notifications-v2\nexport default 1;\n";
        let upstream = extensions.join(format!(
            "{}-notifications.ts",
            crate::modules::identity::upstream().namespace
        ));
        std::fs::write(&upstream, upstream_body).unwrap();
        let ours = extensions.join(pi_extension_file());
        assert_ne!(ours, upstream, "our extension must not be upstream's file");

        let plan = plan_at("pi", Action::Install, &ours, None, false).unwrap();
        apply_plan(&plan).unwrap();
        assert_eq!(std::fs::read_to_string(&upstream).unwrap(), upstream_body);
        let installed = std::fs::read_to_string(&ours).unwrap();
        assert!(installed.contains(&format!("// {}{}", pi_extension_family(), PI_VERSION)));
        assert!(installed.contains(&identity::env("CLI")));

        // A file that is not ours is refused, never silently replaced.
        let foreign = plan_at(
            "pi",
            Action::Install,
            &ours,
            Some(upstream_body.into()),
            false,
        );
        assert!(
            foreign.is_err(),
            "foreign extension content must be refused"
        );

        let uninstall = plan_at("pi", Action::Uninstall, &ours, Some(installed), false).unwrap();
        assert_eq!(uninstall.after, None);
        assert_eq!(std::fs::read_to_string(&upstream).unwrap(), upstream_body);
    }

    #[test]
    fn installed_hook_definitions_are_byte_stable_across_versions() {
        let group = |agent: &str, event: &str, windows: bool| {
            let spec = spec(agent);
            let event = spec.events.iter().find(|e| e.event == event).unwrap();
            hook_group(spec, event, windows)
        };
        let posix = |agent: &str, event: &str| {
            format!(
                r#"[ -n "$CODR_CLI" ] && "$CODR_CLI" hook {agent} {event} || printf '{{}}'"#
            )
        };
        let cmd = |agent: &str, event: &str| {
            format!(
                r#"if defined CODR_CLI ("%CODR_CLI%" hook {agent} {event}) else (echo {{}})"#
            )
        };

        assert_eq!(
            group("codex", "Stop", false),
            json!({ "hooks": [{ "type": "command", "command": posix("codex", "Stop") }] })
        );
        assert_eq!(
            group("codex", "PermissionRequest", false),
            json!({ "hooks": [{
                "type": "command",
                "command": posix("codex", "PermissionRequest"),
                "timeout": 960
            }] })
        );
        for event in ["SessionStart", "UserPromptSubmit"] {
            assert_eq!(
                group("codex", event, false),
                json!({ "hooks": [{ "type": "command", "command": posix("codex", event) }] }),
                "{event}"
            );
        }
        assert_eq!(
            group("codex", "Stop", true),
            json!({ "hooks": [{
                "type": "command",
                "command": cmd("codex", "Stop"),
                "commandWindows": cmd("codex", "Stop")
            }] })
        );
        assert_eq!(
            group("claude", "PermissionRequest", false),
            json!({ "hooks": [{
                "type": "command",
                "command": posix("claude", "PermissionRequest"),
                "timeout": 960
            }] })
        );
        assert_eq!(
            group("claude", "Stop", true),
            json!({ "hooks": [{
                "type": "command",
                "command": r#"if ($env:CODR_CLI) { & $env:CODR_CLI hook claude Stop } else { '{}' }"#,
                "shell": "powershell"
            }] })
        );
        assert_eq!(
            group("gemini", "AfterAgent", false),
            json!({
                "matcher": "*",
                "hooks": [{ "type": "command", "name": identity::namespace(), "command": posix("gemini", "AfterAgent") }]
            })
        );
    }

    #[test]
    fn install_is_idempotent_per_agent_and_platform() {
        for agent in ["claude", "codex", "gemini"] {
            for windows in [false, true] {
                let once = install(agent, None, windows);
                let twice = install(agent, Some(&once), windows);
                assert_eq!(once, twice, "{agent} windows={windows}");
                assert!(once.ends_with("}\n"));
            }
        }
    }

    #[test]
    fn user_configuration_is_preserved_byte_for_byte() {
        let original = "{\n    // my tweaks\n    \"permissions\": { \"allow\": [\"Bash(ls)\"] },\n    \"hooks\": {\n        \"Notification\": [\n            { \"hooks\": [ { \"type\": \"command\", \"command\": \"say hi\" } ] }\n        ]\n    },\n    \"model\": \"opus\"\n}\n";
        let out = install("claude", Some(original), false);
        assert!(
            out.contains("    // my tweaks\n    \"permissions\": { \"allow\": [\"Bash(ls)\"] },\n")
        );
        assert!(
            out.contains("{ \"hooks\": [ { \"type\": \"command\", \"command\": \"say hi\" } ] }")
        );
        assert!(out.contains("\"model\": \"opus\"\n}\n"));
        let value = parsed(&agent_json_strip(&out));
        let notification = commands(&value, "Notification");
        assert_eq!(notification[0], "say hi");
        assert_eq!(notification.len(), 2);

        let removed = json_after(
            spec("claude"),
            Some(&out),
            Action::Uninstall,
            false,
            &path(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(removed, original);
    }

    fn agent_json_strip(text: &str) -> String {
        text.lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Upstream's older hooks (OSC markers, the `__terax_notify` CONOUT$ helper) belong to
    /// the other application. They are not "migrated": our group is added and theirs stays.
    #[test]
    fn upstream_legacy_hooks_are_left_in_place_not_migrated() {
        let legacy = json!({
            "hooks": {
                "Notification": [
                    { "hooks": [ { "type": "command", "command": "[ -n \"$CODR_TERMINAL\" ] && printf '{\"terminalSequence\":\"\\u001b]777;notify;Terax;attention\\u0007\"}' || true" } ] }
                ],
                "Stop": [
                    { "hooks": [ { "type": "command", "command": "\"C:\\\\Terax\\\\terax.exe\" __terax_notify claude finished" } ] },
                    { "hooks": [ { "type": "command", "command": "mine" } ] }
                ]
            }
        });
        let out = parsed(&install("claude", Some(&legacy.to_string()), false));
        let notification = commands(&out, "Notification");
        assert!(
            notification
                .iter()
                .any(|command| command.contains(&identity::env("CLI"))),
            "{notification:?}"
        );
        // The upstream hook is another application's configuration: left byte for byte.
        assert_eq!(notification.len(), 2, "{notification:?}");
        assert!(notification
            .iter()
            .any(|command| command.contains("notify;Terax;attention")));
        let stop = commands(&out, "Stop");
        assert!(stop.contains(&"mine".to_string()));
        assert!(stop
            .iter()
            .any(|command| command.contains("__terax_notify")));
    }

    #[test]
    fn a_group_shared_with_user_commands_is_left_alone() {
        let mixed = json!({ "hooks": [
            { "type": "command", "command": "mine" },
            { "type": "command", "command": hook_command(Dialect::Posix, "claude", "Stop") }
        ] });
        assert!(!group_is_ours(&mixed));
        assert!(!group_is_ours(&json!({ "hooks": [] })));
        assert!(!group_is_ours(&json!({})));
    }

    #[test]
    fn invalid_or_unexpected_configs_are_refused() {
        let error = json_after(
            spec("claude"),
            Some("{ not json,"),
            Action::Install,
            false,
            &path(),
        )
        .unwrap_err();
        assert!(error.contains("refusing to edit"));
        for bad in [
            "[]",
            "\"x\"",
            "{\"hooks\": []}",
            "{\"hooks\": {\"Stop\": 1}}",
        ] {
            assert!(
                json_after(spec("claude"), Some(bad), Action::Install, false, &path()).is_err(),
                "{bad}"
            );
        }
        let blank = install("claude", Some("  \n"), false);
        assert!(parsed(&blank)["hooks"]["Stop"].is_array());
    }

    #[test]
    fn uninstall_removes_everything_it_installed_and_nothing_else() {
        for agent in ["claude", "codex", "gemini"] {
            let installed = install(agent, Some("{\n  \"keep\": true\n}\n"), false);
            let removed = json_after(
                spec(agent),
                Some(&installed),
                Action::Uninstall,
                false,
                &path(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(parsed(&removed), json!({ "keep": true }), "{agent}");
        }
        assert_eq!(
            json_after(spec("claude"), None, Action::Uninstall, false, &path()).unwrap(),
            None
        );
    }

    #[test]
    fn plans_describe_the_before_and_after_for_a_diff() {
        let path = PathBuf::from("/nowhere/settings.json");
        let fresh = plan_at("claude", Action::Install, &path, None, false).unwrap();
        assert!(fresh.changed);
        assert_eq!(fresh.before, None);
        assert_eq!(fresh.revision, "absent");
        assert!(fresh
            .after
            .as_deref()
            .unwrap()
            .contains("CODR_CLI"));

        let again = plan_at("claude", Action::Install, &path, fresh.after.clone(), false).unwrap();
        assert!(!again.changed);

        let remove = plan_at(
            "claude",
            Action::Uninstall,
            &path,
            fresh.after.clone(),
            false,
        )
        .unwrap();
        assert!(remove.changed);
        assert_eq!(parsed(remove.after.as_deref().unwrap()), json!({}));

        let value = serde_json::to_value(&fresh).unwrap();
        assert_eq!(value["action"], "install");
        assert!(value["changed"].as_bool().unwrap());
        assert_eq!(value["revision"], "absent");
        assert_eq!(value["activation"]["trustRequired"], true);
        assert_eq!(value["activation"]["restartRequired"], true);
        assert_eq!(value["activation"]["verified"], false);
        assert!(value["activation"]["steps"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn a_revision_changes_with_content_even_when_length_and_mtime_do_not() {
        let absent = revision_of(None);
        assert_eq!(absent, "absent");
        let before = revision_of(Some("{\"model\":\"opus\"}\n"));
        let same_length = revision_of(Some("{\"model\":\"sonn\"}\n"));
        assert_eq!(before.len(), same_length.len());
        assert_ne!(before, same_length, "same-length content must differ");
        assert_eq!(before, revision_of(Some("{\"model\":\"opus\"}\n")));
        assert_ne!(before, revision_of(Some("{}\n")));
    }

    /// The stale-preview refusal: an external edit between preview and apply is
    /// refused, the file keeps the external change, and only a fresh preview
    /// can be applied.
    #[test]
    fn a_preview_whose_file_changed_is_refused_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = "{\n  \"model\": \"opus\"\n}\n";
        std::fs::write(&path, original).unwrap();

        let preview = plan_at(
            "claude",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert!(preview.changed);

        // Same length, so only the content fingerprint can notice the change.
        let external = "{\n  \"model\": \"sonn\"\n}\n";
        assert_eq!(external.len(), original.len());
        std::fs::write(&path, external).unwrap();

        let stale = apply_at("claude", Action::Install, &path, &preview.revision).unwrap();
        assert_eq!(stale.outcome, "stale");
        assert_eq!(stale.revision, revision_of(Some(external)));
        assert!(!stale.status.installed);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), external);

        // A fresh preview, confirmed, applies against the reviewed revision.
        let fresh = plan_at(
            "claude",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        let applied = apply_at("claude", Action::Install, &path, &fresh.revision).unwrap();
        assert_eq!(applied.outcome, "applied");
        assert!(applied.status.installed);
        assert_eq!(applied.status.config_state, "installed");
        let installed = std::fs::read_to_string(&path).unwrap();
        assert!(installed.contains("sonn"), "the external edit is preserved");
        assert!(installed.contains("CODR_CLI"));

        // Repeating a preview that still matches reports no write needed, so a
        // retry after a stale refusal is explicit and idempotent.
        let again = plan_at(
            "claude",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert!(!again.changed);
        assert_eq!(
            apply_at("claude", Action::Install, &path, &again.revision)
                .unwrap()
                .outcome,
            "unchanged"
        );
    }

    #[test]
    fn install_and_remove_retry_cleanly_on_the_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let base = "{\n  \"model\": \"opus\"\n}\n";
        std::fs::write(&path, base).unwrap();

        let install = plan_at(
            "codex",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            apply_at("codex", Action::Install, &path, &install.revision)
                .unwrap()
                .outcome,
            "applied"
        );
        let installed = std::fs::read_to_string(&path).unwrap();
        let retry = plan_at(
            "codex",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert!(!retry.changed);
        assert_eq!(
            apply_at("codex", Action::Install, &path, &retry.revision)
                .unwrap()
                .outcome,
            "unchanged"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), installed);

        let remove = plan_at(
            "codex",
            Action::Uninstall,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            apply_at("codex", Action::Uninstall, &path, &remove.revision)
                .unwrap()
                .outcome,
            "applied"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), base);
    }

    /// Removal never needs a write when the file holds nothing of this fork's:
    /// an upstream-only (or user-only) file stays byte-identical, comments and
    /// odd formatting included.
    #[test]
    fn removing_from_a_foreign_only_file_writes_nothing_and_preserves_it() {
        let upstream = "{\n    // upstream Terax wrote these\n    \"hooks\": {\n        \"Stop\": [\n            { \"hooks\": [ { \"type\": \"command\", \"command\": \"[ -n \\\"$TERAX_CLI\\\" ] && \\\"$TERAX_CLI\\\" hook claude Stop || printf '{}'\" } ] }\n        ],\n        \"Notification\": [\n            { \"hooks\": [ { \"type\": \"command\", \"command\": \"notify-send done\" } ] }\n        ]\n    },\n    \"model\": \"opus\"\n}\n";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, upstream).unwrap();

        let plan = plan_at(
            "claude",
            Action::Uninstall,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert!(!plan.changed);
        assert_eq!(plan.after.as_deref(), Some(upstream));
        assert_eq!(plan.after, plan.before);
        assert!(
            plan.foreign_groups >= 2,
            "upstream + user groups are foreign"
        );
        let outcome = apply_at("claude", Action::Uninstall, &path, &plan.revision).unwrap();
        assert_eq!(outcome.outcome, "unchanged");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), upstream);
    }

    #[test]
    fn ownership_is_this_forks_own_cli_invocation_not_a_lookalike() {
        let ours = [
            hook_command(Dialect::Posix, "claude", "Stop"),
            hook_command(Dialect::Cmd, "gemini", "AfterAgent"),
            hook_command(Dialect::PowerShell, "codex", "Stop"),
        ];
        for command in ours {
            assert!(command_is_ours(&command), "{command}");
        }
        let foreign = [
            r#"[ -n "$TERAX_CLI" ] && "$TERAX_CLI" hook claude Stop || printf '{}'"#,
            r#"if defined TERAX_CLI ("%TERAX_CLI%" hook claude Stop) else (echo {})"#,
            r#"if ($env:TERAX_CLI) { & $env:TERAX_CLI hook claude Stop } else { '{}' }"#,
            r#"printf '\033]777;notify;Terax;claude;Stop\007'"#,
            r#"terax.exe __terax_notify claude finished"#,
            // The fork's variable without this fork's invocation.
            r#"[ -n "$CODR_CLI" ] && notify-send ready"#,
            r#""$CODR_CLI_EXTRA" hook claude Stop"#,
            r#""$CODR_CLI" report claude Stop"#,
            "claude hook claude Stop",
        ];
        for command in foreign {
            assert!(!command_is_ours(command), "{command}");
        }
    }

    #[test]
    fn status_reports_configured_state_not_active_support() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{\n  \"model\": \"opus\"\n}\n").unwrap();

        let plan = plan_at(
            "claude",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        apply_plan(&plan).unwrap();
        let status = status_at("claude", &path);
        assert_eq!(status.config_state, "installed");
        assert!(status.installed);
        assert_eq!(status.support, Support::Supported);
        assert!(status.activation.trust_required);
        assert!(status.activation.restart_required);
        assert!(
            !status.activation.verified,
            "writing a file is not verified vendor support"
        );
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["configState"], "installed");
        assert_eq!(json["activation"]["verified"], false);
        assert!(
            !json.to_string().to_lowercase().contains("\"active\""),
            "status must not claim activation"
        );

        // An older fork version's entry is partial, never installed.
        std::fs::write(&path, "{\n  \"hooks\": {\n    \"Stop\": [\n      { \"hooks\": [ { \"type\": \"command\", \"command\": \"[ -n \\\"$CODR_CLI\\\" ] && \\\"$CODR_CLI\\\" hook claude OldEvent || printf '{}'\" } ] }\n    ]\n  }\n}\n").unwrap();
        let partial = status_at("claude", &path);
        assert_eq!(partial.config_state, "partial");
        assert!(!partial.installed);

        std::fs::write(&path, "{ not json,").unwrap();
        assert_eq!(status_at("claude", &path).config_state, "invalid");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(status_at("claude", &path).config_state, "not-installed");
    }

    #[test]
    fn unsupported_agents_are_documented_and_never_written() {
        for agent in ["opencode", "antigravity"] {
            let status = status_at(agent, Path::new(""));
            assert_eq!(status.support, Support::Unsupported, "{agent}");
            assert_eq!(status.config_state, "unsupported", "{agent}");
            assert!(!status.installed);
            assert_eq!(status.path, "");
            assert!(
                status
                    .activation
                    .summary
                    .contains("no structured hook adapter"),
                "{agent}"
            );
            assert!(plan(agent, Action::Install).is_err(), "{agent}");
            let json = serde_json::to_value(&status).unwrap();
            assert_eq!(json["support"], "unsupported");
        }
        let unknown = status_at("nobody", Path::new(""));
        assert_eq!(unknown.support, Support::Unsupported);
        assert!(unknown.note.is_some());
    }

    #[test]
    fn a_foreign_file_at_the_pi_extension_path_is_a_conflict_not_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(pi_extension_file());
        let foreign = "export const mine = true;\n";
        std::fs::write(&path, foreign).unwrap();
        let status = status_at("pi", &path);
        assert_eq!(status.config_state, "conflict");
        assert!(!status.installed);
        assert_eq!(status.foreign_groups, 1);
        assert!(status.note.is_some());
        assert!(plan_at(
            "pi",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false
        )
        .is_err());
        // Removal leaves the foreign file alone as well.
        let remove = plan_at(
            "pi",
            Action::Uninstall,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert!(!remove.changed);
        assert_eq!(remove.after.as_deref(), Some(foreign));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), foreign);
    }

    #[test]
    fn applying_a_plan_writes_atomically_and_detects_concurrent_edits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".agent").join("settings.json");
        let first = plan_at("claude", Action::Install, &path, None, false).unwrap();
        apply_plan(&first).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            first.after.clone().unwrap()
        );

        // Second apply of the stale plan: the file is no longer absent.
        assert!(apply_plan(&first)
            .unwrap_err()
            .contains("changed since the preview"));

        let noop = plan_at(
            "claude",
            Action::Install,
            &path,
            read_existing(&path).unwrap(),
            false,
        )
        .unwrap();
        assert!(!noop.changed);
        apply_plan(&noop).unwrap();

        std::fs::write(&path, "{}").unwrap();
        let stale = plan_at("claude", Action::Install, &path, Some("{ }".into()), false).unwrap();
        assert!(apply_plan(&stale).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[cfg(unix)]
    #[test]
    fn temp_files_are_private_unique_and_never_leak_a_wider_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (first, first_path) = create_temp(dir.path(), "settings.json").unwrap();
        let (_second, second_path) = create_temp(dir.path(), "settings.json").unwrap();
        assert_ne!(first_path, second_path);
        let mode = first.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let target = dir.path().join("config.json");
        std::fs::write(&target, "{}\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_atomic(&target, "{\"a\":1}\n").unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644);
        let fresh = dir.path().join("fresh.json");
        write_atomic(&fresh, "{}\n").unwrap();
        assert_eq!(
            std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let leftovers = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("terax-tmp"))
            .count();
        assert_eq!(leftovers, 2, "only the two files created directly above");
    }

    #[test]
    fn reconcile_leaves_empty_arrays_the_user_wrote_alone() {
        let user = "{\n  \"hooks\": {\n    \"PreToolUse\": [],\n    \"BeforeTool\": []\n  }\n}\n";
        for agent in ["claude", "codex", "gemini"] {
            let out = install(agent, Some(user), false);
            let value = parsed(&out);
            for event in ["PreToolUse", "BeforeTool"] {
                if spec(agent).events.iter().any(|e| e.event == event) {
                    assert_eq!(value["hooks"][event], json!([]), "{agent} {event}");
                }
            }
            let removed = json_after(spec(agent), Some(&out), Action::Uninstall, false, &path())
                .unwrap()
                .unwrap();
            assert_eq!(removed, user, "{agent}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_and_private_configs_keep_their_identity() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let managed = dir.path().join("managed.json");
        std::fs::write(&managed, "{}\n").unwrap();
        std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("settings.json");
        symlink(&managed, &link).unwrap();

        let plan = plan_at(
            "claude",
            Action::Install,
            &link,
            read_existing(&link).unwrap(),
            false,
        )
        .unwrap();
        apply_plan(&plan).unwrap();

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::read_to_string(&managed)
            .unwrap()
            .contains("CODR_CLI"));
        let mode = std::fs::metadata(&managed).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn the_pi_extension_calls_the_cli_and_stays_inert_elsewhere() {
        let extension = pi_extension();
        assert!(extension.contains(&format!("process.env.{}", identity::env("CLI"))));
        assert!(extension.contains(&format!("process.env.{}", identity::env("PANE_ID"))));
        assert!(extension.contains(r#"["hook", "pi", event]"#));
        assert!(extension.starts_with(&format!("// {}{}", pi_extension_family(), PI_VERSION)));
        assert!(extension.contains("windowsHide: true"));
        assert!(!extension.contains("777"));
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
            assert!(extension.contains(&format!("\"{event}\"")), "{event}");
        }
        assert_eq!(
            extension.matches("pi.on(\"").count(),
            1 + PI_HOOKS.iter().filter(|hook| hook.wanted).count()
        );
    }

    #[test]
    fn pi_install_replaces_only_fork_owned_files() {
        let p = Path::new("/x/fork-extensions/ext.ts");
        assert_eq!(
            pi_after(None, Action::Install, p).unwrap().as_deref(),
            Some(pi_extension().as_str())
        );
        let v1 = "// codr-pi-notifications-v1\nexport default () => {}\n";
        assert_eq!(
            pi_after(Some(v1), Action::Install, p).unwrap().as_deref(),
            Some(pi_extension().as_str())
        );
        assert!(pi_after(Some("export const mine = true;"), Action::Install, p).is_err());
        assert_eq!(
            pi_after(Some("  \n"), Action::Install, p)
                .unwrap()
                .as_deref(),
            Some(pi_extension().as_str())
        );

        assert_eq!(
            pi_after(Some(pi_extension().as_str()), Action::Uninstall, p).unwrap(),
            None
        );
        assert_eq!(pi_after(None, Action::Uninstall, p).unwrap(), None);
        assert_eq!(
            pi_after(Some("export const mine = true;"), Action::Uninstall, p)
                .unwrap()
                .as_deref(),
            Some("export const mine = true;")
        );
    }

    #[test]
    fn pi_plan_install_and_uninstall_round_trip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ext").join(pi_extension_file());
        let install = plan_at("pi", Action::Install, &path, None, false).unwrap();
        apply_plan(&install).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), pi_extension());
        let existing = read_existing(&path).unwrap();
        assert!(
            !plan_at("pi", Action::Install, &path, existing.clone(), false)
                .unwrap()
                .changed
        );
        apply_plan(&plan_at("pi", Action::Uninstall, &path, existing, false).unwrap()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn unknown_agents_and_actions_are_rejected() {
        assert!(find("nobody").is_err());
        assert!(Action::parse("explode").is_err());
        let unknown = status("nobody");
        assert_eq!(unknown.support, Support::Unsupported);
        assert!(!unknown.installed);
    }

    #[test]
    fn conout_marker_matches_detector_format() {
        assert_eq!(
            conout_marker("gemini", "attention"),
            "\u{1b}]777;notify;Terax;gemini;attention\u{7}"
        );
    }
}

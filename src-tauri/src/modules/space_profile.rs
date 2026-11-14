//! Provisioning and fail-closed preflight for Space Agent profiles.
//!
//! Each isolated Space owns `<profiles_root>/<space_id>/` (`0700`) containing a
//! `bin/` shim directory and tool-specific profile subdirectories such as
//! `claude/` (`CLAUDE_CONFIG_DIR`). Non-secret shared resources are selectively
//! symlinked from host `~/.claude/*`, while credentials, sessions, caches, and
//! mutable JSON state stay strictly Space-private.

use serde_json::{Map, Value};
use std::ffi::{OsStr, OsString};
use std::fs::{self, DirBuilder};
use std::io::{ErrorKind, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::{NamedTempFile, TempDir};

use crate::modules::space_isolation::{sanitize_error_message, validate_space_id};

pub const CLAUDE_SHARED_ENTRIES: &[&str] = &["CLAUDE.md", "skills", "agents", "plugins"];
pub const CLAUDE_PRIVATE_ENTRIES: &[&str] = &[
    ".credentials.json",
    ".claude.json",
    "settings.json",
    "projects",
    "sessions",
    "transcripts",
    "backups",
    "cache",
    "statsig",
];

pub const OPENCODE_SHARED_ENTRIES: &[&str] = &[
    "opencode.json",
    "AGENTS.md",
    "plugins",
    "tui.json",
];
pub const OPENCODE_FORBIDDEN_CONFIG_ENTRIES: &[&str] = &["service.json", "cli.json"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileEnvironment {
    pub profiles_root: PathBuf,
    pub host_home: Option<PathBuf>,
    pub path_env: Option<OsString>,
}

impl ProfileEnvironment {
    pub fn from_host(profiles_root: PathBuf) -> Self {
        Self {
            profiles_root,
            host_home: dirs::home_dir(),
            path_env: std::env::var_os("PATH"),
        }
    }
}

pub const SCRUBBED_PROVIDER_ENV_KEYS: [&str; 4] = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_API_KEY",
    "GEMINI_API_KEY",
];

pub const ISOLATED_BLOCKED_AGENTS: &[(&str, &str)] = &[
    ("agy", "Antigravity CLI (agy)"),
    ("antigravity", "Antigravity (antigravity)"),
    ("codex", "Codex (codex)"),
    ("gemini", "Gemini (gemini)"),
    ("grok", "Grok (grok)"),
];

pub fn blocked_agent_shim_script(label: &str) -> String {
    format!(
        "#!/bin/sh\nprintf '%s\\n' 'codr: Account isolation is unsupported for {label} in isolated Spaces; refusing host fallback.' >&2\nexit 1\n"
    )
}

#[derive(Clone, PartialEq, Eq)]
pub struct IsolatedProfileEnv {
    pub space_dir: PathBuf,
    pub shim_dir: PathBuf,
    pub claude_config_dir: PathBuf,
    pub env_overrides: std::collections::BTreeMap<String, String>,
}

impl std::fmt::Debug for IsolatedProfileEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let override_keys: Vec<&str> = self.env_overrides.keys().map(String::as_str).collect();
        f.debug_struct("IsolatedProfileEnv")
            .field("space_dir", &self.space_dir)
            .field("shim_dir", &self.shim_dir)
            .field("claude_config_dir", &self.claude_config_dir)
            .field("env_override_keys", &override_keys)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeProfilePaths {
    pub space_dir: PathBuf,
    pub shim_dir: PathBuf,
    pub claude_dir: PathBuf,
    pub settings_path: PathBuf,
    pub state_path: PathBuf,
}

impl ClaudeProfilePaths {
    pub fn for_space(profiles_root: &Path, space_id: &str) -> Result<Self, String> {
        validate_space_id(space_id)?;
        let space_dir = profiles_root.join(space_id);
        let shim_dir = space_dir.join("bin");
        let claude_dir = space_dir.join("claude");
        let settings_path = claude_dir.join("settings.json");
        let state_path = claude_dir.join(".claude.json");
        Ok(Self {
            space_dir,
            shim_dir,
            claude_dir,
            settings_path,
            state_path,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenCodeProfilePaths {
    pub space_dir: PathBuf,
    pub shim_dir: PathBuf,
    pub shim_path: PathBuf,
    pub opencode_dir: PathBuf,
    pub config_dir: PathBuf,
    pub data_home: PathBuf,
    pub state_home: PathBuf,
    pub cache_home: PathBuf,
}

impl OpenCodeProfilePaths {
    pub fn for_space(profiles_root: &Path, space_id: &str) -> Result<Self, String> {
        validate_space_id(space_id)?;
        let space_dir = profiles_root.join(space_id);
        let shim_dir = space_dir.join("bin");
        let shim_path = shim_dir.join("opencode");
        let opencode_dir = space_dir.join("opencode");
        let config_dir = opencode_dir.join("config");
        let data_home = opencode_dir.join("data");
        let state_home = opencode_dir.join("state");
        let cache_home = opencode_dir.join("cache");
        Ok(Self {
            space_dir,
            shim_dir,
            shim_path,
            opencode_dir,
            config_dir,
            data_home,
            state_home,
            cache_home,
        })
    }
}

/// Pure sanitizer that seeds non-secret Claude settings on profile creation.
/// Strips env overrides, hooks, credential helpers, and secret-shaped keys/values
/// so host auth material is never imported into an isolated Space profile.
pub fn seed_claude_settings_json(host_settings_raw: Option<&str>) -> String {
    let Some(raw) = host_settings_raw else {
        return "{}\n".to_string();
    };
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(raw) else {
        return "{}\n".to_string();
    };
    let sanitized = sanitize_settings_object(&obj, true);
    match serde_json::to_string_pretty(&Value::Object(sanitized)) {
        Ok(mut text) => {
            text.push('\n');
            text
        }
        Err(_) => "{}\n".to_string(),
    }
}

fn sanitize_settings_object(obj: &Map<String, Value>, top_level: bool) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in obj {
        if is_disallowed_settings_key(key, top_level) {
            continue;
        }
        match value {
            Value::String(s) if looks_like_secret_value(s) => continue,
            Value::Object(nested) => {
                out.insert(
                    key.clone(),
                    Value::Object(sanitize_settings_object(nested, false)),
                );
            }
            _ => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

fn is_disallowed_settings_key(key: &str, top_level: bool) -> bool {
    let lower = key.to_ascii_lowercase();
    if top_level && matches!(lower.as_str(), "env" | "hooks") {
        return true;
    }
    if matches!(
        lower.as_str(),
        "apikeyhelper"
            | "awsauthrefresh"
            | "awscredentialexport"
            | "otelheadershelper"
            | "oauth"
            | "oauthaccount"
            | "credentials"
            | "credential"
            | "accesstoken"
            | "refreshtoken"
            | "sessionkey"
    ) {
        return true;
    }
    lower.contains("secret")
        || lower.contains("token")
        || lower.contains("password")
        || lower.contains("credential")
        || lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("auth")
}

fn looks_like_secret_value(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.starts_with("sk-")
        || trimmed.starts_with("ghp_")
        || trimmed.starts_with("github_pat_")
        || trimmed.starts_with("xoxb-")
        || trimmed.starts_with("xoxp_")
        || trimmed.starts_with("AIza")
        || trimmed.starts_with("AKIA")
        || trimmed.to_ascii_lowercase().starts_with("bearer ")
}

const CLAUDE_CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub fn verify_claude_cli_compatible(
    path_env: Option<&OsStr>,
    shim_dir: &Path,
    require_present: bool,
) -> Result<Option<PathBuf>, String> {
    let Some(bin_path) = resolve_claude_binary(path_env, shim_dir) else {
        if require_present {
            return Err(
                "Claude CLI ('claude') was not found on PATH; install Claude Code before launching an isolated Claude session"
                    .to_string(),
            );
        }
        return Ok(None);
    };

    let probe_root = TempDir::new().map_err(|e| {
        format!(
            "Failed to create temporary Claude CLI preflight directory: {}",
            sanitize_io_err(&e)
        )
    })?;
    let probe_home = probe_root.path().join("home");
    let probe_claude = probe_root.path().join("claude");
    create_private_dir_0700(&probe_home, "Claude preflight probe home")?;
    create_private_dir_0700(&probe_claude, "Claude preflight probe config")?;

    let mut cmd = Command::new(&bin_path);
    cmd.env_clear();
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    for key in ["SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT"] {
        if let Some(val) = std::env::var_os(key) {
            cmd.env(key, val);
        }
    }
    cmd.env("HOME", &probe_home);
    #[cfg(windows)]
    cmd.env("USERPROFILE", &probe_home);
    cmd.env("CLAUDE_CONFIG_DIR", &probe_claude);
    cmd.args(["auth", "status", "--json"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to invoke Claude CLI compatibility preflight: {}",
            sanitize_io_err(&e)
        )
    })?;

    let deadline = Instant::now() + CLAUDE_CLI_PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "Claude CLI compatibility preflight timed out; verify 'claude auth status --json' works before launching an isolated Space"
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(err) => {
                return Err(format!(
                    "Claude CLI compatibility preflight failed: {}",
                    sanitize_io_err(&err)
                ));
            }
        }
    };

    let mut stdout_buf = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut stdout_buf);
    }
    // `claude auth status --json` exits 1 when logged out while still returning status JSON.
    let code = status.code();
    if !matches!(code, Some(0) | Some(1)) {
        return Err(
            "Installed Claude CLI failed 'auth status --json'; update Claude Code to a version supporting CLAUDE_CONFIG_DIR before launching isolated Spaces"
                .to_string(),
        );
    }

    let stdout_str = String::from_utf8(stdout_buf).map_err(|_| {
        "Installed Claude CLI emitted invalid UTF-8 during compatibility preflight; refusing isolated launch"
            .to_string()
    })?;
    let parsed: Value = serde_json::from_str(stdout_str.trim()).map_err(|_| {
        "Installed Claude CLI did not return valid JSON from 'auth status --json'; update Claude Code before launching isolated Spaces"
            .to_string()
    })?;

    let expected_canon = fs::canonicalize(&probe_claude).unwrap_or_else(|_| probe_claude.clone());
    let reported_dir = parsed
        .get("configDirectory")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "Installed Claude CLI status output omitted 'configDirectory'; update Claude Code before launching isolated Spaces"
                .to_string()
        })?;
    let reported_path = Path::new(reported_dir);
    let reported_canon =
        fs::canonicalize(reported_path).unwrap_or_else(|_| reported_path.to_path_buf());
    if reported_canon != expected_canon {
        return Err(
            "Installed Claude CLI did not honor CLAUDE_CONFIG_DIR; update Claude Code before launching isolated Spaces to avoid host credential fallback"
                .to_string(),
        );
    }
    if let Some(projects_dir) = parsed.get("projectsDirectory").and_then(|v| v.as_str()) {
        let projects_path = Path::new(projects_dir);
        let projects_canon =
            fs::canonicalize(projects_path).unwrap_or_else(|_| projects_path.to_path_buf());
        if !projects_canon.starts_with(&expected_canon) {
            return Err(
                "Installed Claude CLI projectsDirectory escaped CLAUDE_CONFIG_DIR; refusing isolated launch"
                    .to_string(),
            );
        }
    }

    Ok(Some(bin_path))
}

pub fn verify_opencode_cli_compatible(
    path_env: Option<&OsStr>,
    host_home: Option<&Path>,
    shim_dir: &Path,
    require_present: bool,
) -> Result<Option<PathBuf>, String> {
    let Some(bin_path) = resolve_opencode_binary(path_env, host_home, shim_dir) else {
        if require_present {
            return Err(
                "OpenCode CLI ('opencode') was not found on PATH; install OpenCode before launching an isolated OpenCode session"
                    .to_string(),
            );
        }
        return Ok(None);
    };

    let probe_root = TempDir::new().map_err(|e| {
        format!(
            "Failed to create temporary OpenCode CLI preflight directory: {}",
            sanitize_io_err(&e)
        )
    })?;
    let probe_home = probe_root.path().join("home");
    let probe_cfg = probe_root.path().join("config");
    let probe_data = probe_root.path().join("data");
    let probe_state = probe_root.path().join("state");
    let probe_cache = probe_root.path().join("cache");
    for (dir, label) in [
        (&probe_home, "OpenCode preflight probe home"),
        (&probe_cfg, "OpenCode preflight probe config"),
        (&probe_data, "OpenCode preflight probe data"),
        (&probe_state, "OpenCode preflight probe state"),
        (&probe_cache, "OpenCode preflight probe cache"),
    ] {
        create_private_dir_0700(dir, label)?;
    }

    let mut cmd = Command::new(&bin_path);
    cmd.env_clear();
    if let Some(path) = path_env {
        cmd.env("PATH", path);
    }
    #[cfg(windows)]
    for key in ["SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "PATHEXT"] {
        if let Some(val) = std::env::var_os(key) {
            cmd.env(key, val);
        }
    }
    cmd.env("HOME", &probe_home);
    #[cfg(windows)]
    cmd.env("USERPROFILE", &probe_home);
    cmd.env("OPENCODE_CONFIG_DIR", &probe_cfg);
    cmd.env("XDG_DATA_HOME", &probe_data);
    cmd.env("XDG_STATE_HOME", &probe_state);
    cmd.env("XDG_CACHE_HOME", &probe_cache);
    cmd.arg("--help");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    crate::modules::proc::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to invoke OpenCode CLI compatibility preflight: {}",
            sanitize_io_err(&e)
        )
    })?;

    let deadline = Instant::now() + CLAUDE_CLI_PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "OpenCode CLI compatibility preflight timed out; verify 'opencode --help' works before launching an isolated Space"
                            .to_string(),
                    );
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(err) => {
                return Err(format!(
                    "OpenCode CLI compatibility preflight failed: {}",
                    sanitize_io_err(&err)
                ));
            }
        }
    };

    let mut stdout_buf = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut stdout_buf);
    }
    let mut stderr_buf = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_end(&mut stderr_buf);
    }

    if !status.success() {
        return Err(
            "Installed OpenCode CLI failed '--help'; update OpenCode before launching isolated Spaces"
                .to_string(),
        );
    }

    let help_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout_buf),
        String::from_utf8_lossy(&stderr_buf)
    );
    if !help_text.contains("--standalone") {
        return Err(
            "Installed OpenCode CLI does not support '--standalone'; update OpenCode before launching isolated Spaces to avoid shared daemon or host credential fallback"
                .to_string(),
        );
    }

    for rel in [
        ".config/opencode",
        ".local/share/opencode",
        ".local/state/opencode",
        ".cache/opencode",
    ] {
        if fs::symlink_metadata(probe_home.join(rel)).is_ok() {
            return Err(
                "Installed OpenCode CLI ignored scoped XDG_DATA_HOME/OPENCODE_CONFIG_DIR and wrote to HOME; refusing isolated launch"
                    .to_string(),
            );
        }
    }
    for forbidden in OPENCODE_FORBIDDEN_CONFIG_ENTRIES {
        if fs::symlink_metadata(probe_cfg.join(forbidden)).is_ok() {
            return Err(format!(
                "Installed OpenCode CLI created forbidden '{forbidden}' in OPENCODE_CONFIG_DIR during preflight; refusing isolated launch"
            ));
        }
    }

    Ok(Some(bin_path))
}

fn resolve_claude_binary(path_env: Option<&OsStr>, shim_dir: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = ["claude.exe", "claude.cmd", "claude"];
    #[cfg(not(windows))]
    let candidates = ["claude"];
    resolve_binary_skipping_shim(path_env, shim_dir, &candidates)
}

fn resolve_opencode_binary(
    path_env: Option<&OsStr>,
    host_home: Option<&Path>,
    shim_dir: &Path,
) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = ["opencode.exe", "opencode.cmd", "opencode"];
    #[cfg(not(windows))]
    let candidates = ["opencode"];
    if let Some(found) = resolve_binary_skipping_shim(path_env, shim_dir, &candidates) {
        return Some(found);
    }
    let home = host_home?;
    let user_opencode_bin = home.join(".opencode").join("bin");
    resolve_binary_skipping_shim(Some(user_opencode_bin.as_os_str()), shim_dir, &candidates)
}

fn resolve_binary_skipping_shim(
    path_env: Option<&OsStr>,
    shim_dir: &Path,
    candidates: &[&str],
) -> Option<PathBuf> {
    let raw_path = path_env?;
    let shim_canon = fs::canonicalize(shim_dir).ok();

    for dir in std::env::split_paths(raw_path) {
        if dir == shim_dir {
            continue;
        }
        if let Some(ref sc) = shim_canon {
            if fs::canonicalize(&dir).ok().as_ref() == Some(sc) {
                continue;
            }
        }
        for name in candidates {
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub fn provision_and_verify_claude_profile(
    env: &ProfileEnvironment,
    space_id: &str,
) -> Result<ClaudeProfilePaths, String> {
    let paths = ClaudeProfilePaths::for_space(&env.profiles_root, space_id)?;

    ensure_profiles_root(&env.profiles_root)?;
    ensure_strict_private_dir(&paths.space_dir, "Space profile root")?;
    ensure_strict_private_dir(&paths.shim_dir, "Space shim directory")?;
    provision_and_verify_blocked_shims(&paths.shim_dir)?;
    ensure_strict_private_dir(&paths.claude_dir, "Space Claude config directory")?;

    let host_claude_dir = env.host_home.as_ref().map(|h| h.join(".claude"));
    for entry in CLAUDE_SHARED_ENTRIES {
        sync_and_verify_shared_entry(
            "Claude",
            &paths.space_dir,
            &paths.claude_dir,
            host_claude_dir.as_deref(),
            entry,
        )?;
    }

    verify_no_private_symlinks(&paths.claude_dir)?;

    let host_settings_raw = host_claude_dir
        .as_deref()
        .and_then(|dir| read_regular_file_if_present(&dir.join("settings.json")));
    let seeded_settings = seed_claude_settings_json(host_settings_raw.as_deref());
    ensure_private_file_if_missing(
        &paths.settings_path,
        seeded_settings.as_bytes(),
        "Space Claude settings.json",
    )?;
    ensure_private_file_if_missing(&paths.state_path, b"{}\n", "Space Claude .claude.json")?;

    Ok(paths)
}

fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn render_opencode_shim(paths: &OpenCodeProfilePaths) -> String {
    let shim_dir = shell_single_quote(&paths.shim_dir.to_string_lossy());
    let data_home = shell_single_quote(&paths.data_home.to_string_lossy());
    let state_home = shell_single_quote(&paths.state_home.to_string_lossy());
    let cache_home = shell_single_quote(&paths.cache_home.to_string_lossy());
    let config_dir = shell_single_quote(&paths.config_dir.to_string_lossy());
    format!(
        "#!/bin/sh\n\
         # codr-space-opencode-shim-v1\n\
         set -eu\n\
         SHIM_DIR={shim_dir}\n\
         SELF_DIR=\"$(CDPATH='' cd -- \"$(dirname -- \"$0\")\" 2>/dev/null && pwd -P || true)\"\n\
         SHIM_CANON=\"$(CDPATH='' cd -- \"$SHIM_DIR\" 2>/dev/null && pwd -P || true)\"\n\
         real_opencode=\"\"\n\
         if [ \"${{IFS+x}}\" = \"x\" ]; then\n\
           has_ifs=1\n\
           old_ifs=\"$IFS\"\n\
         else\n\
           has_ifs=0\n\
         fi\n\
         IFS=\":\"\n\
         set -f\n\
         for dir in ${{PATH-}}; do\n\
           [ -n \"$dir\" ] || continue\n\
           [ \"$dir\" = \"$SHIM_DIR\" ] && continue\n\
           [ -n \"$SELF_DIR\" ] && [ \"$dir\" = \"$SELF_DIR\" ] && continue\n\
           [ -f \"$dir/opencode\" ] && [ -x \"$dir/opencode\" ] || continue\n\
           dir_canon=\"$(CDPATH='' cd -- \"$dir\" 2>/dev/null && pwd -P || true)\"\n\
           if [ -n \"$dir_canon\" ]; then\n\
             [ \"$dir_canon\" = \"$SHIM_DIR\" ] && continue\n\
             [ -n \"$SHIM_CANON\" ] && [ \"$dir_canon\" = \"$SHIM_CANON\" ] && continue\n\
             [ -n \"$SELF_DIR\" ] && [ \"$dir_canon\" = \"$SELF_DIR\" ] && continue\n\
           fi\n\
           real_opencode=\"$dir/opencode\"\n\
           break\n\
         done\n\
         set +f\n\
         if [ \"$has_ifs\" = \"1\" ]; then\n\\
           IFS=\"$old_ifs\"\n\
         else\n\
           unset IFS\n\
         fi\n\
         if [ -z \"$real_opencode\" ]; then\n\
           printf '%s\\n' \"Codr Space isolation: 'opencode' was not found on PATH outside Space shim directory.\" >&2\n\
           exit 127\n\
         fi\n\
         export XDG_DATA_HOME={data_home}\n\
         export XDG_STATE_HOME={state_home}\n\
         export XDG_CACHE_HOME={cache_home}\n\
         export OPENCODE_CONFIG_DIR={config_dir}\n\
         for arg in \"$@\"; do\n\
           if [ \"$arg\" = \"--standalone\" ]; then\n\
             exec \"$real_opencode\" \"$@\"\n\
           fi\n\
         done\n\
         exec \"$real_opencode\" --standalone \"$@\"\n"
    )
}

pub fn provision_and_verify_opencode_profile(
    env: &ProfileEnvironment,
    space_id: &str,
) -> Result<OpenCodeProfilePaths, String> {
    let paths = OpenCodeProfilePaths::for_space(&env.profiles_root, space_id)?;

    ensure_profiles_root(&env.profiles_root)?;
    ensure_strict_private_dir(&paths.space_dir, "Space profile root")?;
    ensure_strict_private_dir(&paths.shim_dir, "Space shim directory")?;
    ensure_strict_private_dir(&paths.opencode_dir, "Space OpenCode directory")?;
    ensure_strict_private_dir(&paths.config_dir, "Space OpenCode config directory")?;
    ensure_strict_private_dir(&paths.data_home, "Space OpenCode XDG data directory")?;
    ensure_strict_private_dir(&paths.state_home, "Space OpenCode XDG state directory")?;
    ensure_strict_private_dir(&paths.cache_home, "Space OpenCode XDG cache directory")?;

    let host_opencode_cfg = env
        .host_home
        .as_ref()
        .map(|h| h.join(".config").join("opencode"));
    for entry in OPENCODE_SHARED_ENTRIES {
        sync_and_verify_shared_entry(
            "OpenCode",
            &paths.space_dir,
            &paths.config_dir,
            host_opencode_cfg.as_deref(),
            entry,
        )?;
    }

    verify_opencode_config_dir(&paths)?;
    verify_no_opencode_private_symlinks(&paths)?;

    let expected_shim = render_opencode_shim(&paths);
    ensure_and_verify_executable_shim(
        &paths.shim_path,
        expected_shim.as_bytes(),
        "Space OpenCode shim",
    )?;

    Ok(paths)
}

fn verify_opencode_config_dir(paths: &OpenCodeProfilePaths) -> Result<(), String> {
    for entry in OPENCODE_FORBIDDEN_CONFIG_ENTRIES {
        let candidate = paths.config_dir.join(entry);
        match fs::symlink_metadata(&candidate) {
            Ok(_) => {
                return Err(format!(
                    "Leaked OpenCode '{entry}' found in Space config directory; refusing isolated launch"
                ));
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Failed to inspect Space OpenCode config entry '{entry}': {}",
                    sanitize_io_err(&err)
                ));
            }
        }
    }

    let entries = fs::read_dir(&paths.config_dir).map_err(|e| {
        format!(
            "Failed to read Space OpenCode config directory: {}",
            sanitize_io_err(&e)
        )
    })?;
    for item in entries {
        let item = item.map_err(|e| {
            format!(
                "Failed to inspect Space OpenCode config directory entry: {}",
                sanitize_io_err(&e)
            )
        })?;
        let name = item.file_name();
        let name_str = name.to_string_lossy();
        if OPENCODE_FORBIDDEN_CONFIG_ENTRIES.contains(&name_str.as_ref()) {
            return Err(format!(
                "Leaked OpenCode '{name_str}' found in Space config directory; refusing isolated launch"
            ));
        }
        let ft = item.file_type().map_err(|e| {
            format!(
                "Failed to inspect Space OpenCode config entry '{name_str}': {}",
                sanitize_io_err(&e)
            )
        })?;
        if ft.is_symlink() && !OPENCODE_SHARED_ENTRIES.contains(&name_str.as_ref()) {
            return Err(format!(
                "Unexpected symlink '{name_str}' in Space OpenCode config directory; refusing isolated launch"
            ));
        }
    }
    Ok(())
}

pub fn provision_and_verify_blocked_shims(shim_dir: &Path) -> Result<(), String> {
    for &(bin_name, label) in ISOLATED_BLOCKED_AGENTS {
        let shim_path = shim_dir.join(bin_name);
        let expected = blocked_agent_shim_script(label);
        ensure_executable_shim_0700(&shim_path, expected.as_bytes(), bin_name)?;
    }
    Ok(())
}

fn ensure_and_verify_executable_shim(
    path: &Path,
    expected_bytes: &[u8],
    label: &str,
) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(format!(
                    "{label} must be a regular executable file, not a symlink; refusing isolated launch"
                ));
            }
            #[cfg(unix)]
            {
                let mode = meta.permissions().mode() & 0o777;
                if mode != 0o700 {
                    return Err(format!(
                        "{label} permissions must be 0700 (found {:04o}); refusing isolated launch",
                        mode
                    ));
                }
            }
            let actual = fs::read(path).map_err(|e| {
                format!("Failed to read {label}: {}", sanitize_io_err(&e))
            })?;
            if actual.as_slice() != expected_bytes {
                return Err(format!(
                    "{label} failed integrity check; refusing isolated launch"
                ));
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| format!("Invalid path for {label}"))?;
            let mut tmp = NamedTempFile::new_in(parent)
                .map_err(|e| format!("Failed to stage {label}: {}", sanitize_io_err(&e)))?;
            #[cfg(unix)]
            fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).map_err(|e| {
                format!(
                    "Failed to secure permissions for {label}: {}",
                    sanitize_io_err(&e)
                )
            })?;
            tmp.write_all(expected_bytes)
                .and_then(|()| tmp.as_file().sync_all())
                .map_err(|e| format!("Failed to write {label}: {}", sanitize_io_err(&e)))?;
            match tmp.persist_noclobber(path) {
                Ok(_) => Ok(()),
                Err(err) if err.error.kind() == ErrorKind::AlreadyExists => {
                    ensure_and_verify_executable_shim(path, expected_bytes, label)
                }
                Err(err) => Err(format!(
                    "Failed to persist {label}: {}",
                    sanitize_io_err(&err.error)
                )),
            }
        }
        Err(err) => Err(format!(
            "Failed to inspect {label}: {}",
            sanitize_io_err(&err)
        )),
    }
}

fn ensure_executable_shim_0700(
    path: &Path,
    bytes: &[u8],
    bin_name: &str,
) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(format!(
                    "Space blocking shim '{bin_name}' must be a regular executable file, not a symlink; refusing isolated launch"
                ));
            }
            if fs::read(path).ok().as_deref() == Some(bytes) {
                #[cfg(unix)]
                if (meta.permissions().mode() & 0o777) != 0o700 {
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| {
                        format!(
                            "Failed to enforce 0700 permissions on Space blocking shim '{bin_name}': {}",
                            sanitize_io_err(&e)
                        )
                    })?;
                }
                return Ok(());
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(format!(
                "Failed to inspect Space blocking shim '{bin_name}': {}",
                sanitize_io_err(&err)
            ));
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid path for Space blocking shim '{bin_name}'"))?;
    let mut tmp = NamedTempFile::new_in(parent).map_err(|e| {
        format!(
            "Failed to stage Space blocking shim '{bin_name}': {}",
            sanitize_io_err(&e)
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o700)).map_err(|e| {
        format!(
            "Failed to set 0700 permissions on Space blocking shim '{bin_name}': {}",
            sanitize_io_err(&e)
        )
    })?;
    tmp.write_all(bytes)
        .and_then(|()| tmp.as_file().sync_all())
        .map_err(|e| {
            format!(
                "Failed to write Space blocking shim '{bin_name}': {}",
                sanitize_io_err(&e)
            )
        })?;
    tmp.persist(path).map_err(|e| {
        format!(
            "Failed to persist Space blocking shim '{bin_name}': {}",
            sanitize_io_err(&e.error)
        )
    })?;
    Ok(())
}

fn verify_no_opencode_private_symlinks(paths: &OpenCodeProfilePaths) -> Result<(), String> {
    const PRIVATE_RELS: &[&str] = &[
        "opencode",
        "opencode/opencode.db",
        "opencode/opencode.db-wal",
        "opencode/opencode.db-shm",
        "opencode/auth.json",
        "opencode.db",
        "auth.json",
        "service.json",
        "cli.json",
    ];
    for base in [&paths.data_home, &paths.state_home, &paths.cache_home] {
        for rel in PRIVATE_RELS {
            let candidate = base.join(rel);
            match fs::symlink_metadata(&candidate) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(format!(
                        "Private Space OpenCode entry '{rel}' cannot be a symlink; refusing host fallback"
                    ));
                }
                Ok(_) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!(
                        "Failed to inspect private Space OpenCode entry '{rel}': {}",
                        sanitize_io_err(&err)
                    ));
                }
            }
        }
    }
    Ok(())
}

fn ensure_profiles_root(root: &Path) -> Result<(), String> {
    match fs::symlink_metadata(root) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(
                    "Space profiles root must be a real directory, not a symlink; refusing host fallback"
                        .to_string(),
                );
            }
            #[cfg(unix)]
            if (meta.permissions().mode() & 0o022) != 0 {
                return Err(
                    "Space profiles root has group or world write permissions; refusing isolated launch"
                        .to_string(),
                );
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            if let Some(parent) = root.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create Space profiles parent directory: {}",
                        sanitize_io_err(&e)
                    )
                })?;
            }
            create_private_dir_0700(root, "Space profiles root")
        }
        Err(err) => Err(format!(
            "Failed to inspect Space profiles root: {}",
            sanitize_io_err(&err)
        )),
    }
}

fn ensure_strict_private_dir(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(format!(
                    "{label} must be a private directory, not a symlink; refusing launch"
                ));
            }
            #[cfg(unix)]
            {
                let mode = meta.permissions().mode() & 0o777;
                if mode != 0o700 {
                    return Err(format!(
                        "{label} permissions must be 0700 (found {:04o}); refusing isolated launch",
                        mode
                    ));
                }
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => create_private_dir_0700(path, label),
        Err(err) => Err(format!(
            "Failed to inspect {label}: {}",
            sanitize_io_err(&err)
        )),
    }
}

fn create_private_dir_0700(path: &Path, label: &str) -> Result<(), String> {
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => {}
        Err(err) if err.kind() == ErrorKind::AlreadyExists => {
            // Re-validate so a concurrent creator or pre-planted symlink cannot bypass 0700.
            return ensure_strict_private_dir(path, label);
        }
        Err(err) => {
            return Err(format!(
                "Failed to create {label}: {}",
                sanitize_io_err(&err)
            ));
        }
    }
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| {
        format!(
            "Failed to enforce 0700 permissions on {label}: {}",
            sanitize_io_err(&e)
        )
    })?;
    Ok(())
}

fn sync_and_verify_shared_entry(
    tool_label: &str,
    space_dir: &Path,
    space_tool_dir: &Path,
    host_tool_dir: Option<&Path>,
    entry: &str,
) -> Result<(), String> {
    let link_path = space_tool_dir.join(entry);
    let expected_target = host_tool_dir.map(|dir| dir.join(entry));
    let resolved_host = match expected_target.as_deref() {
        Some(target) => validate_host_shared_target(tool_label, space_dir, target, entry)?,
        None => HostTargetState::Missing,
    };

    match fs::symlink_metadata(&link_path) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let actual_target = fs::read_link(&link_path).map_err(|e| {
                format!(
                    "Failed to inspect shared {tool_label} entry '{entry}': {}",
                    sanitize_io_err(&e)
                )
            })?;
            let Some(expected) = expected_target.as_deref() else {
                return Err(format!(
                    "Shared {tool_label} entry '{entry}' is symlinked without a host target; refusing launch"
                ));
            };
            if actual_target != expected {
                return Err(format!(
                    "Shared {tool_label} entry '{entry}' points to an unexpected target; refusing isolated launch"
                ));
            }
            if !matches!(resolved_host, HostTargetState::Valid) {
                return Err(format!(
                    "Shared {tool_label} entry '{entry}' symlink target is missing or unreadable; fix or remove broken link before launch"
                ));
            }
            Ok(())
        }
        Ok(_) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            if matches!(resolved_host, HostTargetState::Valid) {
                if let Some(target) = expected_target.as_deref() {
                    create_shared_symlink(tool_label, &link_path, target, entry)?;
                }
            }
            Ok(())
        }
        Err(err) => Err(format!(
            "Failed to inspect Space {tool_label} entry '{entry}': {}",
            sanitize_io_err(&err)
        )),
    }
}

enum HostTargetState {
    Missing,
    Valid,
}

fn validate_host_shared_target(
    tool_label: &str,
    space_dir: &Path,
    target: &Path,
    entry: &str,
) -> Result<HostTargetState, String> {
    match fs::symlink_metadata(target) {
        Ok(_) => match fs::canonicalize(target) {
            Ok(canon) => {
                let space_canon = fs::canonicalize(space_dir).unwrap_or_else(|_| space_dir.to_path_buf());
                if canon == space_canon || canon.starts_with(&space_canon) || canon.starts_with(space_dir) {
                    return Err(format!(
                        "Shared {tool_label} entry '{entry}' resolves back inside this Space profile; refusing symlink cycle"
                    ));
                }
                Ok(HostTargetState::Valid)
            }
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(HostTargetState::Missing),
            Err(err) => Err(format!(
                "Shared {tool_label} entry '{entry}' failed symlink resolution (possible cycle or permission issue): {}",
                sanitize_io_err(&err)
            )),
        },
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(HostTargetState::Missing),
        Err(err) => Err(format!(
            "Failed to inspect host {tool_label} entry '{entry}': {}",
            sanitize_io_err(&err)
        )),
    }
}

#[cfg(unix)]
fn create_shared_symlink(
    tool_label: &str,
    link_path: &Path,
    target: &Path,
    entry: &str,
) -> Result<(), String> {
    symlink(target, link_path).map_err(|e| {
        format!(
            "Failed to symlink shared {tool_label} entry '{entry}': {}",
            sanitize_io_err(&e)
        )
    })
}

#[cfg(not(unix))]
fn create_shared_symlink(
    tool_label: &str,
    link_path: &Path,
    target: &Path,
    entry: &str,
) -> Result<(), String> {
    let meta = fs::metadata(target).map_err(|e| {
        format!(
            "Failed to inspect host {tool_label} entry '{entry}': {}",
            sanitize_io_err(&e)
        )
    })?;
    let res = if meta.is_dir() {
        std::os::windows::fs::symlink_dir(target, link_path)
    } else {
        std::os::windows::fs::symlink_file(target, link_path)
    };
    res.map_err(|e| {
        format!(
            "Failed to symlink shared {tool_label} entry '{entry}': {}",
            sanitize_io_err(&e)
        )
    })
}

fn verify_no_private_symlinks(claude_dir: &Path) -> Result<(), String> {
    for entry in CLAUDE_PRIVATE_ENTRIES {
        let candidate = claude_dir.join(entry);
        match fs::symlink_metadata(&candidate) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!(
                        "Private Space Claude entry '{entry}' cannot be a symlink; refusing host fallback"
                    ));
                }
            }
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "Failed to inspect private Space Claude entry '{entry}': {}",
                    sanitize_io_err(&err)
                ));
            }
        }
    }
    Ok(())
}

fn read_regular_file_if_present(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn ensure_private_file_if_missing(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                return Err(format!(
                    "{label} must be a private regular file, not a symlink; refusing launch"
                ));
            }
            Ok(())
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| format!("Invalid path for {label}"))?;
            let mut tmp = NamedTempFile::new_in(parent)
                .map_err(|e| format!("Failed to stage {label}: {}", sanitize_io_err(&e)))?;
            #[cfg(unix)]
            fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o600)).map_err(|e| {
                format!(
                    "Failed to secure permissions for {label}: {}",
                    sanitize_io_err(&e)
                )
            })?;
            tmp.write_all(bytes)
                .and_then(|()| tmp.as_file().sync_all())
                .map_err(|e| format!("Failed to write {label}: {}", sanitize_io_err(&e)))?;
            match tmp.persist_noclobber(path) {
                Ok(_) => Ok(()),
                Err(err) if err.error.kind() == ErrorKind::AlreadyExists => {
                    let meta = fs::symlink_metadata(path).map_err(|e| {
                        format!("Failed to inspect {label}: {}", sanitize_io_err(&e))
                    })?;
                    if meta.file_type().is_symlink() || !meta.is_file() {
                        return Err(format!(
                            "{label} must be a private regular file, not a symlink; refusing launch"
                        ));
                    }
                    Ok(())
                }
                Err(err) => Err(format!(
                    "Failed to persist {label}: {}",
                    sanitize_io_err(&err.error)
                )),
            }
        }
        Err(err) => Err(format!(
            "Failed to inspect {label}: {}",
            sanitize_io_err(&err)
        )),
    }
}

fn sanitize_io_err(err: &std::io::Error) -> String {
    sanitize_error_message(&err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_env(temp: &TempDir) -> ProfileEnvironment {
        ProfileEnvironment {
            profiles_root: temp.path().join("xdg_data/codr/space-profiles"),
            host_home: Some(temp.path().join("host_home")),
            path_env: None,
        }
    }

    #[test]
    fn seed_settings_strips_secrets_env_and_hooks_while_preserving_non_secret_defaults() {
        let raw = r#"{
            "theme": "dark",
            "model": "sonnet",
            "enabledPlugins": { "foo@bar": true },
            "keybindings": { "submit": "enter" },
            "env": { "ANTHROPIC_API_KEY": "sk-ant-secret-123" },
            "hooks": { "PreToolUse": [{ "matcher": "*", "hooks": [] }] },
            "apiKeyHelper": "/usr/local/bin/get-key",
            "oauthAccount": { "email": "user@example.com" },
            "customNested": {
                "keepMe": "yes",
                "authToken": "tok-123",
                "inlineKey": "sk-ant-inline-456"
            }
        }"#;

        let seeded = seed_claude_settings_json(Some(raw));
        let parsed: Value = serde_json::from_str(&seeded).unwrap();
        let obj = parsed.as_object().unwrap();

        assert_eq!(obj.get("theme"), Some(&Value::String("dark".to_string())));
        assert_eq!(obj.get("model"), Some(&Value::String("sonnet".to_string())));
        assert!(obj.contains_key("enabledPlugins"));
        assert!(obj.contains_key("keybindings"));
        assert!(!obj.contains_key("env"));
        assert!(!obj.contains_key("hooks"));
        assert!(!obj.contains_key("apiKeyHelper"));
        assert!(!obj.contains_key("oauthAccount"));

        let nested = obj.get("customNested").unwrap().as_object().unwrap();
        assert_eq!(
            nested.get("keepMe"),
            Some(&Value::String("yes".to_string()))
        );
        assert!(!nested.contains_key("authToken"));
        assert!(!nested.contains_key("inlineKey"));
        assert!(!seeded.contains("sk-ant-"));
        assert!(!seeded.contains("get-key"));
    }

    #[test]
    fn provision_creates_private_0700_dirs_and_fresh_non_secret_claude_files() {
        let temp = TempDir::new().unwrap();
        let env = test_env(&temp);
        let host_home = env.host_home.as_ref().unwrap();
        let host_claude = host_home.join(".claude");
        fs::create_dir_all(host_claude.join("skills/my-skill")).unwrap();
        fs::create_dir_all(host_claude.join("agents")).unwrap();
        fs::write(host_claude.join("CLAUDE.md"), "# User instructions").unwrap();
        fs::write(
            host_claude.join("settings.json"),
            r#"{"theme":"light","env":{"ANTHROPIC_API_KEY":"sk-ant-host"}}"#,
        )
        .unwrap();
        fs::write(
            host_claude.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"secret-host-token"}}"#,
        )
        .unwrap();
        fs::write(
            host_home.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"host-acct"},"numStartups":42}"#,
        )
        .unwrap();
        fs::create_dir_all(host_claude.join("projects/host-proj")).unwrap();

        let paths = provision_and_verify_claude_profile(&env, "sp-alpha").unwrap();

        #[cfg(unix)]
        {
            assert_eq!(
                fs::symlink_metadata(&paths.space_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::symlink_metadata(&paths.shim_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::symlink_metadata(&paths.claude_dir)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                fs::symlink_metadata(&paths.settings_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::symlink_metadata(&paths.state_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        // Shared non-secret entries are symlinked to host ~/.claude/* when present,
        // and missing host entries (plugins) are gracefully omitted.
        assert_eq!(
            fs::read_link(paths.claude_dir.join("CLAUDE.md")).unwrap(),
            host_claude.join("CLAUDE.md")
        );
        assert_eq!(
            fs::read_link(paths.claude_dir.join("skills")).unwrap(),
            host_claude.join("skills")
        );
        assert_eq!(
            fs::read_link(paths.claude_dir.join("agents")).unwrap(),
            host_claude.join("agents")
        );
        assert!(fs::symlink_metadata(paths.claude_dir.join("plugins")).is_err());

        // Settings seeded without secrets and not symlinked.
        assert!(!fs::symlink_metadata(&paths.settings_path)
            .unwrap()
            .file_type()
            .is_symlink());
        let space_settings = fs::read_to_string(&paths.settings_path).unwrap();
        assert!(space_settings.contains("light"));
        assert!(!space_settings.contains("sk-ant-host"));

        // Fresh .claude.json never copies host ~/.claude.json.
        assert!(!fs::symlink_metadata(&paths.state_path)
            .unwrap()
            .file_type()
            .is_symlink());
        let space_state = fs::read_to_string(&paths.state_path).unwrap();
        assert_eq!(space_state.trim(), "{}");
        assert!(!space_state.contains("host-acct"));

        // Credentials and projects stay private (never copied or symlinked from host).
        assert!(!paths.claude_dir.join(".credentials.json").exists());
        assert!(!paths.claude_dir.join("projects").exists());

        // Re-running provisioning does not overwrite existing Space mutable settings/state.
        fs::write(&paths.settings_path, "{\"theme\":\"space-custom\"}\n").unwrap();
        fs::write(&paths.state_path, "{\"numStartups\":7}\n").unwrap();
        provision_and_verify_claude_profile(&env, "sp-alpha").unwrap();
        assert_eq!(
            fs::read_to_string(&paths.settings_path).unwrap(),
            "{\"theme\":\"space-custom\"}\n"
        );
        assert_eq!(
            fs::read_to_string(&paths.state_path).unwrap(),
            "{\"numStartups\":7}\n"
        );
    }

    #[test]
    fn provision_fails_closed_on_symlinked_profile_dirs_bad_perms_poisoned_symlinks_and_cycles() {
        let temp = TempDir::new().unwrap();
        let env = test_env(&temp);
        let host_claude = env.host_home.as_ref().unwrap().join(".claude");
        fs::create_dir_all(host_claude.join("skills")).unwrap();

        // 1. Symlinked space dir fails closed.
        let decoys = temp.path().join("decoy");
        fs::create_dir_all(&decoys).unwrap();
        fs::create_dir_all(&env.profiles_root).unwrap();
        #[cfg(unix)]
        symlink(&decoys, env.profiles_root.join("sp-sym")).unwrap();
        assert!(provision_and_verify_claude_profile(&env, "sp-sym").is_err());

        // 2. Permissive (0755) private directory fails closed.
        let paths = provision_and_verify_claude_profile(&env, "sp-perms").unwrap();
        #[cfg(unix)]
        {
            fs::set_permissions(&paths.claude_dir, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(provision_and_verify_claude_profile(&env, "sp-perms").is_err());
            fs::set_permissions(&paths.claude_dir, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(provision_and_verify_claude_profile(&env, "sp-perms").is_ok());
        }

        // 3. Poisoned shared symlink target fails closed.
        #[cfg(unix)]
        {
            let evil_target = temp.path().join("evil-skills");
            fs::create_dir_all(&evil_target).unwrap();
            fs::remove_file(paths.claude_dir.join("skills")).unwrap();
            symlink(&evil_target, paths.claude_dir.join("skills")).unwrap();
            assert!(provision_and_verify_claude_profile(&env, "sp-perms").is_err());

            // 4. Symlinked private file (.credentials.json) fails closed.
            fs::remove_file(paths.claude_dir.join("skills")).unwrap();
            symlink(host_claude.join("skills"), paths.claude_dir.join("skills")).unwrap();
            symlink(
                temp.path().join("host-creds.json"),
                paths.claude_dir.join(".credentials.json"),
            )
            .unwrap();
            assert!(provision_and_verify_claude_profile(&env, "sp-perms").is_err());
        }

        // 5. Symlink cycle on host shared entry fails closed without looping.
        #[cfg(unix)]
        {
            let cycle_env = ProfileEnvironment {
                profiles_root: temp.path().join("xdg_data/codr/space-profiles"),
                host_home: Some(temp.path().join("cycle_home")),
                path_env: None,
            };
            let cycle_claude = cycle_env.host_home.as_ref().unwrap().join(".claude");
            fs::create_dir_all(&cycle_claude).unwrap();
            symlink(cycle_claude.join("agents"), cycle_claude.join("skills")).unwrap();
            symlink(cycle_claude.join("skills"), cycle_claude.join("agents")).unwrap();
            assert!(provision_and_verify_claude_profile(&cycle_env, "sp-cycle").is_err());
        }
    }

    #[cfg(unix)]
    fn write_exec_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn verify_claude_cli_checks_missing_compatible_and_incompatible_binaries() {
        let temp = TempDir::new().unwrap();
        let shim_dir = temp.path().join("space/bin");
        fs::create_dir_all(&shim_dir).unwrap();
        let empty_bin = temp.path().join("empty-bin");
        fs::create_dir_all(&empty_bin).unwrap();

        // Missing binary: optional for generic terminal preflight, required for Claude launcher.
        assert_eq!(
            verify_claude_cli_compatible(Some(empty_bin.as_os_str()), &shim_dir, false).unwrap(),
            None
        );
        let missing_err =
            verify_claude_cli_compatible(Some(empty_bin.as_os_str()), &shim_dir, true).unwrap_err();
        assert!(
            missing_err.contains("Claude CLI"),
            "unexpected error: {missing_err}"
        );

        #[cfg(unix)]
        {
            // Compatible binary honoring CLAUDE_CONFIG_DIR (even exit 1 when logged out).
            let ok_bin = temp.path().join("ok-bin");
            fs::create_dir_all(&ok_bin).unwrap();
            let ok_claude = write_exec_script(
                &ok_bin,
                "claude",
                "#!/bin/sh\nif [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then\n  printf '{\"loggedIn\":false,\"configDirectory\":\"%s\",\"projectsDirectory\":\"%s/projects\"}\\n' \"$CLAUDE_CONFIG_DIR\" \"$CLAUDE_CONFIG_DIR\"\n  exit 1\nfi\nexit 2\n",
            );
            let ok_path = std::env::join_paths([shim_dir.as_path(), ok_bin.as_path()]).unwrap();
            let resolved =
                verify_claude_cli_compatible(Some(ok_path.as_os_str()), &shim_dir, true).unwrap();
            assert_eq!(resolved.as_deref(), Some(ok_claude.as_path()));

            // Incompatible binary ignoring CLAUDE_CONFIG_DIR and falling back to HOME/.claude.
            let bad_bin = temp.path().join("bad-bin");
            fs::create_dir_all(&bad_bin).unwrap();
            write_exec_script(
                &bad_bin,
                "claude",
                "#!/bin/sh\nprintf '{\"loggedIn\":true,\"configDirectory\":\"%s/.claude\"}\\n' \"$HOME\"\nexit 0\n",
            );
            let compat_err =
                verify_claude_cli_compatible(Some(bad_bin.as_os_str()), &shim_dir, false)
                    .unwrap_err();
            assert!(
                compat_err.contains("CLAUDE_CONFIG_DIR"),
                "unexpected error: {compat_err}"
            );

            // Incompatible binary rejecting `auth status`.
            let old_bin = temp.path().join("old-bin");
            fs::create_dir_all(&old_bin).unwrap();
            write_exec_script(&old_bin, "claude", "#!/bin/sh\nexit 2\n");
            assert!(
                verify_claude_cli_compatible(Some(old_bin.as_os_str()), &shim_dir, false).is_err()
            );
        }
    }

    #[test]
    fn provision_opencode_creates_private_0700_dirs_selective_symlinks_and_excludes_service_and_cli_json(
    ) {
        let temp = TempDir::new().unwrap();
        let env = test_env(&temp);
        let host_home = env.host_home.as_ref().unwrap();
        let host_opencode_cfg = host_home.join(".config/opencode");
        let host_opencode_data = host_home.join(".local/share/opencode");
        fs::create_dir_all(host_opencode_cfg.join("plugins/my-plugin")).unwrap();
        fs::create_dir_all(&host_opencode_data).unwrap();
        fs::write(host_opencode_cfg.join("opencode.json"), r#"{"model":"claude-sonnet"}"#).unwrap();
        fs::write(host_opencode_cfg.join("AGENTS.md"), "# Shared instructions").unwrap();
        // Note: tui.json is intentionally omitted on host to verify missing entries are skipped cleanly.
        // service.json and cli.json exist on host and MUST NOT be symlinked or copied into the Space.
        fs::write(
            host_opencode_cfg.join("service.json"),
            r#"{"password":"host-daemon-secret","port":4096}"#,
        )
        .unwrap();
        fs::write(
            host_opencode_cfg.join("cli.json"),
            r#"{"serverUrl":"http://127.0.0.1:4096"}"#,
        )
        .unwrap();
        fs::write(
            host_opencode_data.join("opencode.db"),
            b"host-sqlite-credentials",
        )
        .unwrap();

        let paths = provision_and_verify_opencode_profile(&env, "sp-opencode").unwrap();

        #[cfg(unix)]
        {
            for dir in [
                &paths.space_dir,
                &paths.shim_dir,
                &paths.opencode_dir,
                &paths.config_dir,
                &paths.data_home,
                &paths.state_home,
                &paths.cache_home,
            ] {
                let meta = fs::symlink_metadata(dir).unwrap();
                assert!(!meta.file_type().is_symlink());
                assert!(meta.is_dir());
                assert_eq!(meta.permissions().mode() & 0o777, 0o700);
            }
            let shim_meta = fs::symlink_metadata(&paths.shim_path).unwrap();
            assert!(!shim_meta.file_type().is_symlink());
            assert!(shim_meta.is_file());
            assert_eq!(shim_meta.permissions().mode() & 0o777, 0o700);
        }

        // Only present shareable entries are symlinked.
        assert_eq!(
            fs::read_link(paths.config_dir.join("opencode.json")).unwrap(),
            host_opencode_cfg.join("opencode.json")
        );
        assert_eq!(
            fs::read_link(paths.config_dir.join("AGENTS.md")).unwrap(),
            host_opencode_cfg.join("AGENTS.md")
        );
        assert_eq!(
            fs::read_link(paths.config_dir.join("plugins")).unwrap(),
            host_opencode_cfg.join("plugins")
        );
        assert!(fs::symlink_metadata(paths.config_dir.join("tui.json")).is_err());

        // service.json, cli.json, and host opencode.db are strictly excluded.
        assert!(fs::symlink_metadata(paths.config_dir.join("service.json")).is_err());
        assert!(fs::symlink_metadata(paths.config_dir.join("cli.json")).is_err());
        assert!(!paths.data_home.join("opencode/opencode.db").exists());
        assert!(!paths.data_home.join("opencode.db").exists());
    }

    #[test]
    fn provision_opencode_fails_closed_on_leaked_service_or_cli_json_poisoned_symlinks_and_tampered_shim(
    ) {
        let temp = TempDir::new().unwrap();
        let env = test_env(&temp);
        let host_opencode_cfg = env.host_home.as_ref().unwrap().join(".config/opencode");
        fs::create_dir_all(host_opencode_cfg.join("plugins")).unwrap();
        fs::write(host_opencode_cfg.join("opencode.json"), "{}").unwrap();

        let paths = provision_and_verify_opencode_profile(&env, "sp-guard").unwrap();

        // 1. Leaked service.json (regular file or symlink) fails closed.
        fs::write(paths.config_dir.join("service.json"), "{}").unwrap();
        assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_err());
        fs::remove_file(paths.config_dir.join("service.json")).unwrap();
        assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_ok());

        // 2. Leaked cli.json fails closed.
        fs::write(paths.config_dir.join("cli.json"), "{}").unwrap();
        assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_err());
        fs::remove_file(paths.config_dir.join("cli.json")).unwrap();
        assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_ok());

        #[cfg(unix)]
        {
            // 3. Symlinked service.json (even broken) fails closed.
            symlink(
                host_opencode_cfg.join("service.json"),
                paths.config_dir.join("service.json"),
            )
            .unwrap();
            assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_err());
            fs::remove_file(paths.config_dir.join("service.json")).unwrap();

            // 4. Poisoned shared symlink target fails closed.
            let evil_target = temp.path().join("evil-plugins");
            fs::create_dir_all(&evil_target).unwrap();
            fs::remove_file(paths.config_dir.join("plugins")).unwrap();
            symlink(&evil_target, paths.config_dir.join("plugins")).unwrap();
            assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_err());
            fs::remove_file(paths.config_dir.join("plugins")).unwrap();
            assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_ok());

            // 5. Tampered shim content or permissions fails closed.
            let original_shim = fs::read(&paths.shim_path).unwrap();
            fs::write(&paths.shim_path, "#!/bin/sh\nexec opencode \"$@\"\n").unwrap();
            assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_err());
            fs::write(&paths.shim_path, &original_shim).unwrap();
            fs::set_permissions(&paths.shim_path, fs::Permissions::from_mode(0o755)).unwrap();
            assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_err());
            fs::set_permissions(&paths.shim_path, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(provision_and_verify_opencode_profile(&env, "sp-guard").is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn verify_opencode_cli_and_shim_execution_enforce_standalone_and_scoped_xdg() {
        let temp = TempDir::new().unwrap();
        let env = test_env(&temp);
        let paths = provision_and_verify_opencode_profile(&env, "sp-exec").unwrap();
        let empty_bin = temp.path().join("empty-bin");
        fs::create_dir_all(&empty_bin).unwrap();

        // Missing binary: optional for generic terminal preflight, required for OpenCode launcher.
        assert_eq!(
            verify_opencode_cli_compatible(
                Some(empty_bin.as_os_str()),
                env.host_home.as_deref(),
                &paths.shim_dir,
                false
            )
            .unwrap(),
            None
        );
        let missing_err = verify_opencode_cli_compatible(
            Some(empty_bin.as_os_str()),
            env.host_home.as_deref(),
            &paths.shim_dir,
            true,
        )
        .unwrap_err();
        assert!(
            missing_err.contains("OpenCode"),
            "unexpected error: {missing_err}"
        );

        // Compatible binary supporting --standalone and honoring scoped dirs.
        let real_bin_dir = temp.path().join("real-opencode-bin");
        fs::create_dir_all(&real_bin_dir).unwrap();
        let real_opencode = write_exec_script(
            &real_bin_dir,
            "opencode",
            "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  printf 'FLAGS\\n  --standalone  Run with a private server\\n'\n  exit 0\nfi\nprintf 'ARGS=%s\\nDATA=%s\\nSTATE=%s\\nCACHE=%s\\nCFG=%s\\n' \"$*\" \"$XDG_DATA_HOME\" \"$XDG_STATE_HOME\" \"$XDG_CACHE_HOME\" \"$OPENCODE_CONFIG_DIR\"\n",
        );
        let combined_path =
            std::env::join_paths([paths.shim_dir.as_path(), real_bin_dir.as_path()]).unwrap();
        let resolved = verify_opencode_cli_compatible(
            Some(combined_path.as_os_str()),
            env.host_home.as_deref(),
            &paths.shim_dir,
            true,
        )
        .unwrap();
        assert_eq!(resolved.as_deref(), Some(real_opencode.as_path()));

        // Executing the Space shim resolves real_opencode (skipping shim_dir), exports scoped XDG_*
        // and OPENCODE_CONFIG_DIR to the child, and prepends --standalone.
        let output = Command::new(&paths.shim_path)
            .env("PATH", &combined_path)
            .env("XDG_DATA_HOME", "/host/xdg/data")
            .env("XDG_STATE_HOME", "/host/xdg/state")
            .env("XDG_CACHE_HOME", "/host/xdg/cache")
            .args(["run", "hello"])
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("ARGS=--standalone run hello\n"), "got: {stdout}");
        assert!(
            stdout.contains(&format!("DATA={}\n", paths.data_home.display())),
            "got: {stdout}"
        );
        assert!(
            stdout.contains(&format!("STATE={}\n", paths.state_home.display())),
            "got: {stdout}"
        );
        assert!(
            stdout.contains(&format!("CACHE={}\n", paths.cache_home.display())),
            "got: {stdout}"
        );
        assert!(
            stdout.contains(&format!("CFG={}\n", paths.config_dir.display())),
            "got: {stdout}"
        );

        // Incompatible binary without --standalone fails closed even when require_present is false.
        let no_standalone_dir = temp.path().join("no-standalone-bin");
        fs::create_dir_all(&no_standalone_dir).unwrap();
        write_exec_script(
            &no_standalone_dir,
            "opencode",
            "#!/bin/sh\nprintf 'FLAGS\\n  --server string\\n'\nexit 0\n",
        );
        let compat_err = verify_opencode_cli_compatible(
            Some(no_standalone_dir.as_os_str()),
            env.host_home.as_deref(),
            &paths.shim_dir,
            false,
        )
        .unwrap_err();
        assert!(
            compat_err.contains("--standalone"),
            "unexpected error: {compat_err}"
        );

        // Incompatible binary that writes to $HOME/.local/share/opencode fails closed.
        let leaky_dir = temp.path().join("leaky-bin");
        fs::create_dir_all(&leaky_dir).unwrap();
        write_exec_script(
            &leaky_dir,
            "opencode",
            "#!/bin/sh\nmkdir -p \"$HOME/.local/share/opencode\"\nprintf 'FLAGS\\n  --standalone\\n'\nexit 0\n",
        );
        let leaky_path = std::env::join_paths([
            leaky_dir.as_path(),
            Path::new("/usr/bin"),
            Path::new("/bin"),
        ])
        .unwrap();
        assert!(
            verify_opencode_cli_compatible(
                Some(leaky_path.as_os_str()),
                env.host_home.as_deref(),
                &paths.shim_dir,
                false
            )
            .is_err()
        );

        // When opencode is only in ~/.opencode/bin (added by user rc, absent from GUI PATH),
        // preflight still locates and validates it via host_home/.opencode/bin.
        let user_opencode_bin = env.host_home.as_ref().unwrap().join(".opencode/bin");
        fs::create_dir_all(&user_opencode_bin).unwrap();
        let home_opencode = write_exec_script(
            &user_opencode_bin,
            "opencode",
            "#!/bin/sh\nprintf 'FLAGS\\n  --standalone\\n'\nexit 0\n",
        );
        let home_resolved = verify_opencode_cli_compatible(
            Some(empty_bin.as_os_str()),
            env.host_home.as_deref(),
            &paths.shim_dir,
            true,
        )
        .unwrap();
        assert_eq!(home_resolved.as_deref(), Some(home_opencode.as_path()));
    }

    #[cfg(unix)]
    #[test]
    fn provision_creates_0700_blocking_shims_for_unsupported_agents_that_refuse_host_delegation() {
        let temp = TempDir::new().unwrap();
        let env = test_env(&temp);
        let host_bin = temp.path().join("host_bin");
        fs::create_dir_all(&host_bin).unwrap();
        let sentinel = temp.path().join("host-invoked");

        for name in ["agy", "antigravity", "codex", "gemini", "grok"] {
            write_exec_script(
                &host_bin,
                name,
                &format!(
                    "#!/bin/sh\ntouch '{}'\necho HOST_{}\nexit 0\n",
                    sentinel.display(),
                    name.to_ascii_uppercase()
                ),
            );
        }

        let paths = provision_and_verify_claude_profile(&env, "sp-alpha").unwrap();
        let path_env =
            std::env::join_paths([paths.shim_dir.as_path(), host_bin.as_path(), Path::new("/usr/bin"), Path::new("/bin")])
                .unwrap();

        for name in ["agy", "antigravity", "codex", "gemini", "grok"] {
            let shim_path = paths.shim_dir.join(name);
            let meta = fs::symlink_metadata(&shim_path)
                .unwrap_or_else(|e| panic!("missing shim {name}: {e}"));
            assert!(meta.is_file(), "{name} shim must be a regular file");
            assert!(!meta.file_type().is_symlink(), "{name} shim must not be symlink");
            assert_eq!(
                meta.permissions().mode() & 0o777,
                0o700,
                "{name} shim must be 0700 executable"
            );

            let out = Command::new(name)
                .env_clear()
                .env("PATH", &path_env)
                .env("HOME", env.host_home.as_ref().unwrap())
                .output()
                .unwrap_or_else(|e| panic!("failed to run shim {name}: {e}"));
            assert!(!out.status.success(), "{name} shim must exit non-zero");
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert!(stdout.is_empty(), "{name} shim emitted unexpected stdout: {stdout}");
            assert!(
                stderr.contains("Account isolation is unsupported") && stderr.contains(name),
                "{name} shim stderr missing clear unsupported message: {stderr}"
            );
        }
        assert!(
            !sentinel.exists(),
            "blocking shims must never delegate to host binaries"
        );

        // Replacing a blocking shim with a symlink fails closed; overwriting with
        // tampered regular content or lax permissions is repaired atomically to 0700.
        let codex_shim = paths.shim_dir.join("codex");
        fs::write(&codex_shim, "#!/bin/sh\necho HIJACKED\n").unwrap();
        fs::set_permissions(&codex_shim, fs::Permissions::from_mode(0o755)).unwrap();
        provision_and_verify_claude_profile(&env, "sp-alpha").unwrap();
        assert_eq!(
            fs::symlink_metadata(&codex_shim).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let repaired_out = Command::new(&codex_shim).output().unwrap();
        assert!(!repaired_out.status.success());
        assert!(repaired_out.stdout.is_empty());

        fs::remove_file(&codex_shim).unwrap();
        symlink(host_bin.join("codex"), &codex_shim).unwrap();
        assert!(provision_and_verify_claude_profile(&env, "sp-alpha").is_err());
    }
}

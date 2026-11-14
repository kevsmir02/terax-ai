//! Authoritative Space Account isolation and pending-tombstone registry.
//!
//! Stores non-secret per-Space isolation policy and cleanup tombstones under
//! Codr's app data directory (`0700` dir / `0600` file, atomic tempfile rename)
//! so `pty_open` enforces fail-closed guarantees without host fallback.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::{self, DirBuilder, File};
use std::io::{ErrorKind, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

use crate::modules::space_profile::{
    provision_and_verify_claude_profile, verify_claude_cli_compatible, IsolatedProfileEnv,
    ProfileEnvironment,
};

const MANIFEST_VERSION: u32 = 1;
const MAX_SPACE_ID_LEN: usize = 128;
const MAX_SANITIZED_ERROR_LEN: usize = 160;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountIsolationMode {
    Default,
    Isolated,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSyncInput {
    pub id: String,
    pub account_isolation: AccountIsolationMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRuntimeStatus {
    pub id: String,
    pub account_isolation: AccountIsolationMode,
    pub has_retained_profiles: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestSpaceEntry {
    pub mode: AccountIsolationMode,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTombstone {
    pub space_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    #[serde(default)]
    pub spaces: BTreeMap<String, ManifestSpaceEntry>,
    #[serde(default)]
    pub tombstones: BTreeMap<String, PendingTombstone>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: MANIFEST_VERSION,
            spaces: BTreeMap::new(),
            tombstones: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Default)]
enum RegistryState {
    #[default]
    Uninitialized,
    Ready {
        manifest_path: PathBuf,
        profiles_dir: Option<PathBuf>,
        host_home_override: Option<Option<PathBuf>>,
        path_env_override: Option<Option<OsString>>,
        manifest: Manifest,
    },
    Error {
        reason: String,
    },
}

#[derive(Clone, Debug, Default)]
pub struct SpaceIsolationRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

impl SpaceIsolationRegistry {
    pub fn for_paths(manifest_path: PathBuf, profiles_dir: Option<PathBuf>) -> Self {
        let registry = Self::default();
        let _ = registry.initialize(manifest_path, profiles_dir);
        registry
    }

    pub fn for_paths_with_env(
        manifest_path: PathBuf,
        profiles_dir: Option<PathBuf>,
        host_home: Option<PathBuf>,
        path_env: Option<OsString>,
    ) -> Self {
        let registry = Self::default();
        let _ = registry.initialize_with_env(
            manifest_path,
            profiles_dir,
            Some(host_home),
            Some(path_env),
        );
        registry
    }

    pub fn initialize(
        &self,
        manifest_path: PathBuf,
        profiles_dir: Option<PathBuf>,
    ) -> Result<(), String> {
        self.initialize_with_env(manifest_path, profiles_dir, None, None)
    }

    pub fn initialize_with_env(
        &self,
        manifest_path: PathBuf,
        profiles_dir: Option<PathBuf>,
        host_home_override: Option<Option<PathBuf>>,
        path_env_override: Option<Option<OsString>>,
    ) -> Result<(), String> {
        let next = match fs::read_to_string(&manifest_path) {
            Ok(raw) => match parse_manifest(&raw) {
                Ok(manifest) => RegistryState::Ready {
                    manifest_path,
                    profiles_dir,
                    host_home_override,
                    path_env_override,
                    manifest,
                },
                Err(reason) => {
                    let msg = format!(
                        "Space isolation manifest unavailable: {}",
                        sanitize_error_message(&reason)
                    );
                    RegistryState::Error { reason: msg }
                }
            },
            Err(err) if err.kind() == ErrorKind::NotFound => RegistryState::Ready {
                manifest_path,
                profiles_dir,
                host_home_override,
                path_env_override,
                manifest: Manifest::default(),
            },
            Err(err) => {
                let msg = format!(
                    "Space isolation manifest unreadable: {}",
                    sanitize_io_error(&err)
                );
                RegistryState::Error { reason: msg }
            }
        };

        let result = match &next {
            RegistryState::Error { reason } => Err(reason.clone()),
            _ => Ok(()),
        };
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        *guard = next;
        result
    }

    pub fn profile_dir_for(&self, space_id: &str) -> Result<PathBuf, String> {
        validate_space_id(space_id)?;
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (_, profiles_dir, _, _, _) = ready_parts(&guard)?;
        let base = profiles_dir
            .as_ref()
            .ok_or_else(|| "Space profiles directory is unavailable".to_string())?;
        Ok(base.join(space_id))
    }

    pub fn sync_spaces(
        &self,
        inputs: Vec<SpaceSyncInput>,
    ) -> Result<Vec<SpaceRuntimeStatus>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, profiles_dir, _, _, manifest) = ready_parts_mut(&mut guard)?;
        let profiles_ref = profiles_dir.as_deref();
        let (statuses, dirty) = plan_sync_manifest(manifest, &inputs, &|id| {
            has_retained_profile_dir(profiles_ref, id)
        })?;
        if dirty {
            write_manifest_atomic(manifest_path, manifest)?;
        }
        Ok(statuses)
    }

    pub fn register_space(
        &self,
        space_id: &str,
        mode: AccountIsolationMode,
    ) -> Result<SpaceRuntimeStatus, String> {
        validate_space_id(space_id)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, profiles_dir, host_home_override, path_env_override, manifest) =
            ready_parts_mut(&mut guard)?;

        if manifest.tombstones.contains_key(space_id) {
            return Err(
                "Space has a pending deletion tombstone; cannot register until cleanup completes"
                    .to_string(),
            );
        }

        if let Some(existing) = manifest.spaces.get(space_id) {
            if existing.mode != mode {
                return Err(
                    "Space is already registered with a different Account isolation mode"
                        .to_string(),
                );
            }
        } else {
            if mode == AccountIsolationMode::Isolated {
                let env = build_profile_env(
                    profiles_dir.as_deref(),
                    host_home_override,
                    path_env_override,
                )?;
                provision_and_verify_claude_profile(&env, space_id)?;
            }
            manifest
                .spaces
                .insert(space_id.to_string(), ManifestSpaceEntry { mode });
            write_manifest_atomic(manifest_path, manifest)?;
        }

        Ok(build_runtime_status(
            space_id,
            mode,
            profiles_dir.as_deref(),
            manifest.tombstones.get(space_id),
        ))
    }

    pub fn set_space_mode(
        &self,
        space_id: &str,
        mode: AccountIsolationMode,
    ) -> Result<SpaceRuntimeStatus, String> {
        validate_space_id(space_id)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, profiles_dir, host_home_override, path_env_override, manifest) =
            ready_parts_mut(&mut guard)?;

        if manifest.tombstones.contains_key(space_id) {
            return Err(
                "Space has a pending deletion tombstone; cannot change Account isolation mode"
                    .to_string(),
            );
        }

        let Some(current_mode) = manifest.spaces.get(space_id).map(|entry| entry.mode) else {
            return Err("Space is not registered in the isolation registry".to_string());
        };
        if current_mode != mode {
            if mode == AccountIsolationMode::Isolated {
                let env = build_profile_env(
                    profiles_dir.as_deref(),
                    host_home_override,
                    path_env_override,
                )?;
                provision_and_verify_claude_profile(&env, space_id)?;
            }
            if let Some(entry) = manifest.spaces.get_mut(space_id) {
                entry.mode = mode;
            }
            write_manifest_atomic(manifest_path, manifest)?;
        }

        Ok(build_runtime_status(
            space_id,
            mode,
            profiles_dir.as_deref(),
            manifest.tombstones.get(space_id),
        ))
    }

    pub fn remove_space(&self, space_id: &str) -> Result<(), String> {
        validate_space_id(space_id)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, profiles_dir, _, _, manifest) = ready_parts_mut(&mut guard)?;

        let retained = has_retained_profile_dir(profiles_dir.as_deref(), space_id);
        let has_tombstone = manifest.tombstones.contains_key(space_id);

        let mut dirty = false;
        if retained && !has_tombstone {
            manifest.tombstones.insert(
                space_id.to_string(),
                PendingTombstone {
                    space_id: space_id.to_string(),
                    staging_dir: None,
                    last_error: Some(
                        "Pending cleanup for retained Space profile directory".to_string(),
                    ),
                    created_at_ms: current_time_ms(),
                },
            );
            dirty = true;
        } else if !retained && !has_tombstone && manifest.spaces.remove(space_id).is_some() {
            dirty = true;
        }

        if dirty {
            write_manifest_atomic(manifest_path, manifest)?;
        }
        Ok(())
    }

    pub fn record_tombstone(
        &self,
        space_id: &str,
        staging_dir: Option<String>,
        last_error: Option<String>,
    ) -> Result<(), String> {
        validate_space_id(space_id)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, _, _, _, manifest) = ready_parts_mut(&mut guard)?;
        manifest.tombstones.insert(
            space_id.to_string(),
            PendingTombstone {
                space_id: space_id.to_string(),
                staging_dir,
                last_error: last_error.map(|e| sanitize_error_message(&e)),
                created_at_ms: current_time_ms(),
            },
        );
        write_manifest_atomic(manifest_path, manifest)
    }

    pub fn clear_tombstone(&self, space_id: &str) -> Result<(), String> {
        validate_space_id(space_id)?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, _, _, _, manifest) = ready_parts_mut(&mut guard)?;
        if manifest.tombstones.remove(space_id).is_some() {
            write_manifest_atomic(manifest_path, manifest)?;
        }
        Ok(())
    }

    pub fn validate_pty_open(
        &self,
        space_id: Option<&str>,
        expected_isolation: Option<AccountIsolationMode>,
    ) -> Result<(), String> {
        self.prepare_pty_isolation(space_id, expected_isolation, false, false)
            .map(|_| ())
    }

    pub fn prepare_pty_isolation(
        &self,
        space_id: Option<&str>,
        expected_isolation: Option<AccountIsolationMode>,
        is_wsl: bool,
        require_claude_cli: bool,
    ) -> Result<Option<IsolatedProfileEnv>, String> {
        let (id, expected, env_snapshot) = {
            let guard = self
                .inner
                .lock()
                .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
            let (_, profiles_dir, host_home_override, path_env_override, manifest) =
                ready_parts(&guard)?;
            validate_pty_open_against_manifest(manifest, space_id, expected_isolation)?;
            let expected = expected_isolation.ok_or_else(|| {
                "Missing expectedIsolation for terminal open; refusing host fallback".to_string()
            })?;
            let id = space_id
                .ok_or_else(|| {
                    "Missing spaceId for terminal open; refusing host credential fallback"
                        .to_string()
                })?
                .to_string();
            let snapshot = if expected == AccountIsolationMode::Isolated {
                if is_wsl {
                    return Err(
                        "Isolated Account context is not supported for WSL terminals; refusing host credential fallback"
                            .to_string(),
                    );
                }
                Some(build_profile_env(
                    profiles_dir.as_deref(),
                    host_home_override,
                    path_env_override,
                )?)
            } else {
                None
            };
            (id, expected, snapshot)
        };

        if expected == AccountIsolationMode::Default {
            return Ok(None);
        }

        let env = env_snapshot.ok_or_else(|| {
            "Space profiles directory is unavailable; refusing isolated launch without host fallback"
                .to_string()
        })?;
        let paths = provision_and_verify_claude_profile(&env, &id)?;
        verify_claude_cli_compatible(env.path_env.as_deref(), &paths.shim_dir, require_claude_cli)?;
        Ok(Some(IsolatedProfileEnv {
            space_dir: paths.space_dir,
            shim_dir: paths.shim_dir,
            claude_config_dir: paths.claude_dir,
        }))
    }

    pub fn prepare_agent_launch(
        &self,
        space_id: &str,
        expected_isolation: AccountIsolationMode,
        agent_id: &str,
    ) -> Result<(), String> {
        let require_claude =
            expected_isolation == AccountIsolationMode::Isolated && agent_id == "claude";
        self.prepare_pty_isolation(Some(space_id), Some(expected_isolation), false, require_claude)
            .map(|_| ())
    }
}

type ReadyParts<'a> = (
    &'a PathBuf,
    &'a Option<PathBuf>,
    &'a Option<Option<PathBuf>>,
    &'a Option<Option<OsString>>,
    &'a Manifest,
);

type ReadyPartsMut<'a> = (
    &'a PathBuf,
    &'a Option<PathBuf>,
    &'a Option<Option<PathBuf>>,
    &'a Option<Option<OsString>>,
    &'a mut Manifest,
);

fn build_profile_env(
    profiles_dir: Option<&Path>,
    host_home_override: &Option<Option<PathBuf>>,
    path_env_override: &Option<Option<OsString>>,
) -> Result<ProfileEnvironment, String> {
    let profiles_root = profiles_dir
        .ok_or_else(|| {
            "Space profiles directory is unavailable; refusing isolated launch without host fallback"
                .to_string()
        })?
        .to_path_buf();
    let host_home = match host_home_override {
        Some(custom) => custom.clone(),
        None => dirs::home_dir(),
    };
    let path_env = match path_env_override {
        Some(custom) => custom.clone(),
        None => std::env::var_os("PATH"),
    };
    Ok(ProfileEnvironment {
        profiles_root,
        host_home,
        path_env,
    })
}

fn ready_parts(state: &RegistryState) -> Result<ReadyParts<'_>, String> {
    match state {
        RegistryState::Ready {
            manifest_path,
            profiles_dir,
            host_home_override,
            path_env_override,
            manifest,
        } => Ok((
            manifest_path,
            profiles_dir,
            host_home_override,
            path_env_override,
            manifest,
        )),
        RegistryState::Uninitialized => Err(
            "Space isolation registry is uninitialized; refusing terminal open without host fallback"
                .to_string(),
        ),
        RegistryState::Error { reason } => Err(reason.clone()),
    }
}

fn ready_parts_mut(state: &mut RegistryState) -> Result<ReadyPartsMut<'_>, String> {
    match state {
        RegistryState::Ready {
            manifest_path,
            profiles_dir,
            host_home_override,
            path_env_override,
            manifest,
        } => Ok((
            manifest_path,
            profiles_dir,
            host_home_override,
            path_env_override,
            manifest,
        )),
        RegistryState::Uninitialized => {
            Err("Space isolation registry is uninitialized; refusing isolation update".to_string())
        }
        RegistryState::Error { reason } => Err(reason.clone()),
    }
}

pub fn validate_space_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_SPACE_ID_LEN {
        return Err("Invalid spaceId length".to_string());
    }
    if id == "." || id == ".." || id.starts_with('.') {
        return Err("Invalid spaceId segment".to_string());
    }
    if id
        .chars()
        .any(|c| c == '/' || c == '\\' || c == '\0' || c.is_control() || c.is_whitespace())
    {
        return Err("Invalid character in spaceId".to_string());
    }
    Ok(())
}

fn looks_like_secret_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| {
        matches!(c, '"' | '\'' | ',' | ';' | ')' | '(' | '{' | '}' | '[' | ']')
    });
    if [
        "sk-",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "AIza",
        "AKIA",
        "eyJ",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix) && (!prefix.eq(&"eyJ") || trimmed.contains('.')))
    {
        return true;
    }
    let lower = token.to_ascii_lowercase();
    [
        "\"accesstoken\":",
        "\"refreshtoken\":",
        "\"apikey\":",
        "\"sessionkey\":",
        "\"oauth",
        "\"secret\":",
        "\"token\":",
        "\"password\":",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
}

fn is_json_secret_key_prefix(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    [
        "\"accesstoken\":",
        "\"refreshtoken\":",
        "\"apikey\":",
        "\"sessionkey\":",
        "\"secret\":",
        "\"token\":",
        "\"password\":",
    ]
    .iter()
    .any(|pattern| lower.ends_with(pattern))
}

pub fn contains_secret_payload(payload: &str) -> bool {
    let lower = payload.to_ascii_lowercase();
    if payload.contains("sk-ant-")
        || payload.contains("sk-proj-")
        || payload.contains("ghp_")
        || payload.contains("github_pat_")
        || payload.contains("xoxb-")
        || payload.contains("xoxp_")
        || payload.contains("claudeAiOauth")
    {
        return true;
    }
    if [
        "\"accesstoken\":",
        "\"refreshtoken\":",
        "\"sessionkey\":",
        "\"oauthaccount\":",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    for prefix in [
        "anthropic_api_key=",
        "claude_code_oauth_token=",
        "openai_api_key=",
    ] {
        if let Some(pos) = lower.find(prefix) {
            let rest = &payload[pos + prefix.len()..];
            let val_len = rest
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
                .count();
            if val_len >= 8 {
                return true;
            }
        }
    }
    false
}

pub fn sanitize_error_message(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let mut out = Vec::new();
    let mut redact_next = false;
    for token in cleaned.split_whitespace() {
        if redact_next {
            out.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        let lower = token.to_ascii_lowercase();
        if matches!(lower.as_str(), "bearer" | "bearer:" | "basic" | "basic:") {
            out.push(token.to_string());
            redact_next = true;
            continue;
        }
        if looks_like_secret_token(token) {
            if is_json_secret_key_prefix(token) {
                redact_next = true;
            }
            out.push("[redacted]".to_string());
        } else if let Some((k, _)) = token.split_once('=') {
            let kl = k.to_ascii_lowercase();
            if kl.contains("key")
                || kl.contains("token")
                || kl.contains("secret")
                || kl.contains("auth")
                || kl.contains("password")
                || kl.contains("cookie")
            {
                out.push(format!("{k}=[redacted]"));
            } else {
                out.push(token.to_string());
            }
        } else {
            out.push(token.to_string());
        }
    }
    out.join(" ")
        .chars()
        .take(MAX_SANITIZED_ERROR_LEN)
        .collect()
}

fn sanitize_io_error(err: &std::io::Error) -> String {
    sanitize_error_message(&format!("{:?}", err.kind()))
}

pub fn parse_manifest(raw: &str) -> Result<Manifest, String> {
    let manifest: Manifest =
        serde_json::from_str(raw).map_err(|_| "corrupt isolation manifest JSON".to_string())?;
    if manifest.version != MANIFEST_VERSION {
        return Err(format!(
            "unsupported isolation manifest version {}",
            manifest.version
        ));
    }
    for id in manifest.spaces.keys() {
        validate_space_id(id)?;
    }
    for (key, tombstone) in &manifest.tombstones {
        validate_space_id(key)?;
        if key != &tombstone.space_id {
            return Err("mismatched tombstone key in isolation manifest".to_string());
        }
    }
    Ok(manifest)
}

pub fn plan_sync_manifest<F>(
    manifest: &mut Manifest,
    inputs: &[SpaceSyncInput],
    has_retained: &F,
) -> Result<(Vec<SpaceRuntimeStatus>, bool), String>
where
    F: Fn(&str) -> bool,
{
    let mut seen = BTreeSet::new();
    for item in inputs {
        validate_space_id(&item.id)?;
        if !seen.insert(item.id.as_str()) {
            return Err("Duplicate spaceId in isolation sync request".to_string());
        }
    }

    let mut dirty = false;
    let mut statuses = Vec::with_capacity(inputs.len());
    for item in inputs {
        let retained = has_retained(&item.id);
        if let Some(tombstone) = manifest.tombstones.get(&item.id) {
            let mode = manifest
                .spaces
                .get(&item.id)
                .map(|entry| entry.mode)
                .unwrap_or(item.account_isolation);
            statuses.push(SpaceRuntimeStatus {
                id: item.id.clone(),
                account_isolation: mode,
                has_retained_profiles: retained,
                cleanup_error: Some(
                    tombstone
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "Pending deletion cleanup for Space".to_string()),
                ),
            });
            continue;
        }

        let mode = if let Some(existing) = manifest.spaces.get(&item.id) {
            // Authoritative Rust mode wins over stale frontend storage on sync.
            existing.mode
        } else {
            manifest.spaces.insert(
                item.id.clone(),
                ManifestSpaceEntry {
                    mode: item.account_isolation,
                },
            );
            dirty = true;
            item.account_isolation
        };

        statuses.push(SpaceRuntimeStatus {
            id: item.id.clone(),
            account_isolation: mode,
            has_retained_profiles: retained,
            cleanup_error: None,
        });
    }

    let prev_len = manifest.spaces.len();
    manifest.spaces.retain(|id, entry| {
        seen.contains(id.as_str())
            || entry.mode == AccountIsolationMode::Isolated
            || has_retained(id)
            || manifest.tombstones.contains_key(id)
    });
    if manifest.spaces.len() != prev_len {
        dirty = true;
    }

    Ok((statuses, dirty))
}

pub fn validate_pty_open_against_manifest(
    manifest: &Manifest,
    space_id: Option<&str>,
    expected_isolation: Option<AccountIsolationMode>,
) -> Result<(), String> {
    let Some(id) = space_id else {
        return Err(
            "Missing spaceId for terminal open; refusing host credential fallback".to_string(),
        );
    };
    validate_space_id(id)
        .map_err(|_| "Invalid spaceId for terminal open; refusing host fallback".to_string())?;

    let Some(expected) = expected_isolation else {
        return Err(
            "Missing expectedIsolation for terminal open; refusing host fallback".to_string(),
        );
    };

    if manifest.tombstones.contains_key(id) {
        return Err(
            "Space has a pending deletion tombstone; refusing to open terminal".to_string(),
        );
    }

    let Some(entry) = manifest.spaces.get(id) else {
        return Err(
            "Space is not registered in the isolation registry; refusing to open terminal"
                .to_string(),
        );
    };

    if entry.mode != expected {
        return Err(
            "Space Account isolation mismatch between frontend and authoritative registry; refusing to open terminal"
                .to_string(),
        );
    }

    Ok(())
}

fn build_runtime_status(
    space_id: &str,
    mode: AccountIsolationMode,
    profiles_dir: Option<&Path>,
    tombstone: Option<&PendingTombstone>,
) -> SpaceRuntimeStatus {
    SpaceRuntimeStatus {
        id: space_id.to_string(),
        account_isolation: mode,
        has_retained_profiles: has_retained_profile_dir(profiles_dir, space_id),
        cleanup_error: tombstone.map(|t| {
            t.last_error
                .clone()
                .unwrap_or_else(|| "Pending deletion cleanup for Space".to_string())
        }),
    }
}

fn has_retained_profile_dir(profiles_dir: Option<&Path>, space_id: &str) -> bool {
    let Some(base) = profiles_dir else {
        return false;
    };
    if validate_space_id(space_id).is_err() {
        return false;
    }
    fs::symlink_metadata(base.join(space_id)).is_ok()
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path).map_err(|e| {
        format!(
            "Failed to prepare isolation directory: {}",
            sanitize_io_error(&e)
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| {
        format!(
            "Failed to secure isolation directory permissions: {}",
            sanitize_io_error(&e)
        )
    })?;
    Ok(())
}

fn write_manifest_atomic(path: &Path, manifest: &Manifest) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid isolation manifest path".to_string())?;
    ensure_private_dir(parent)?;

    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|_| "Failed to serialize isolation manifest".to_string())?;

    let mut tmp = NamedTempFile::new_in(parent).map_err(|e| {
        format!(
            "Failed to create isolation manifest tempfile: {}",
            sanitize_io_error(&e)
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o600)).map_err(|e| {
        format!(
            "Failed to set isolation manifest permissions: {}",
            sanitize_io_error(&e)
        )
    })?;

    tmp.write_all(&bytes)
        .and_then(|()| tmp.as_file().sync_all())
        .map_err(|e| {
            format!(
                "Failed to flush isolation manifest: {}",
                sanitize_io_error(&e)
            )
        })?;

    tmp.persist(path).map_err(|e| {
        format!(
            "Failed to persist isolation manifest: {}",
            sanitize_io_error(&e.error)
        )
    })?;

    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn default_profiles_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|dir| {
        dir.join(crate::modules::identity::namespace())
            .join("space-profiles")
    })
}

#[tauri::command]
pub fn space_isolation_sync(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    spaces: Vec<SpaceSyncInput>,
) -> Result<Vec<SpaceRuntimeStatus>, String> {
    state.sync_spaces(spaces)
}

#[tauri::command]
pub fn space_isolation_register(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    space_id: String,
    account_isolation: AccountIsolationMode,
) -> Result<SpaceRuntimeStatus, String> {
    state.register_space(&space_id, account_isolation)
}

#[tauri::command]
pub fn space_isolation_set_mode(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    space_id: String,
    account_isolation: AccountIsolationMode,
) -> Result<SpaceRuntimeStatus, String> {
    state.set_space_mode(&space_id, account_isolation)
}

#[tauri::command]
pub fn space_isolation_remove(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    space_id: String,
) -> Result<(), String> {
    state.remove_space(&space_id)
}

#[tauri::command]
pub async fn space_isolation_preflight_agent(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    space_id: String,
    expected_isolation: AccountIsolationMode,
    agent_id: String,
) -> Result<(), String> {
    let registry = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.prepare_agent_launch(&space_id, expected_isolation, &agent_id)
    })
    .await
    .map_err(|e| sanitize_error_message(&e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_registry() -> (tempfile::TempDir, SpaceIsolationRegistry, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_path = dir
            .path()
            .join("app-data")
            .join("space-isolation")
            .join("manifest.json");
        let profiles_dir = dir
            .path()
            .join("xdg-data")
            .join("codr")
            .join("space-profiles");
        let host_home = dir.path().join("host-home");
        fs::create_dir_all(&host_home).unwrap();
        let registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path.clone(),
            Some(profiles_dir.clone()),
            Some(host_home),
            Some(OsString::new()),
        );
        (dir, registry, manifest_path, profiles_dir)
    }

    #[test]
    fn rejects_invalid_or_traversal_space_ids() {
        for bad in [
            "",
            ".",
            "..",
            ".hidden",
            "a/b",
            "a\\b",
            "bad id",
            "a\0b",
            &"x".repeat(129),
        ] {
            assert!(validate_space_id(bad).is_err(), "expected {bad:?} to fail");
        }
        for good in ["default", "sp-m123abc-123456", "space_1"] {
            assert!(validate_space_id(good).is_ok(), "expected {good:?} to pass");
        }
    }

    #[test]
    fn persists_manifest_with_restricted_permissions_and_reloads_cleanly() {
        let (_dir, registry, manifest_path, profiles_dir) = temp_registry();

        let statuses = registry
            .sync_spaces(vec![SpaceSyncInput {
                id: "default".to_string(),
                account_isolation: AccountIsolationMode::Default,
            }])
            .expect("sync should succeed");

        assert_eq!(
            statuses,
            vec![SpaceRuntimeStatus {
                id: "default".to_string(),
                account_isolation: AccountIsolationMode::Default,
                has_retained_profiles: false,
                cleanup_error: None,
            }]
        );
        assert!(manifest_path.exists());

        #[cfg(unix)]
        {
            let dir_mode = fs::metadata(manifest_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(&manifest_path).unwrap().permissions().mode() & 0o777;
            assert_eq!(dir_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }

        let reloaded = SpaceIsolationRegistry::for_paths(manifest_path, Some(profiles_dir));
        assert!(reloaded
            .validate_pty_open(Some("default"), Some(AccountIsolationMode::Default))
            .is_ok());
    }

    #[test]
    fn rust_authoritative_mode_prevents_stale_frontend_downgrade() {
        let (_dir, registry, manifest_path, profiles_dir) = temp_registry();
        registry
            .register_space("sp-work", AccountIsolationMode::Isolated)
            .expect("register isolated");

        let reloaded = SpaceIsolationRegistry::for_paths(manifest_path, Some(profiles_dir));
        let synced = reloaded
            .sync_spaces(vec![SpaceSyncInput {
                id: "sp-work".to_string(),
                account_isolation: AccountIsolationMode::Default,
            }])
            .expect("sync succeeds with authoritative correction");

        assert_eq!(synced[0].account_isolation, AccountIsolationMode::Isolated);
        let err = reloaded
            .validate_pty_open(Some("sp-work"), Some(AccountIsolationMode::Default))
            .expect_err("stale default claim must fail closed against isolated registry");
        assert!(err.contains("mismatch"), "unexpected error: {err}");
    }

    #[test]
    fn corrupt_manifest_fails_closed_without_overwriting_file() {
        let (_dir, _reg, manifest_path, profiles_dir) = temp_registry();
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        let corrupt = b"{not valid json";
        fs::write(&manifest_path, corrupt).unwrap();

        let registry = SpaceIsolationRegistry::for_paths(manifest_path.clone(), Some(profiles_dir));
        let pty_err = registry
            .validate_pty_open(Some("default"), Some(AccountIsolationMode::Default))
            .expect_err("corrupt manifest must fail closed");
        assert!(pty_err.contains("manifest"), "unexpected error: {pty_err}");
        let reg_err = registry
            .register_space("default", AccountIsolationMode::Default)
            .expect_err("corrupt manifest must refuse register");
        assert!(reg_err.contains("manifest"), "unexpected error: {reg_err}");
        assert_eq!(fs::read(&manifest_path).unwrap(), corrupt);
    }

    #[test]
    fn detects_retained_profile_directory_without_touching_host_dirs() {
        let (_dir, registry, _manifest_path, profiles_dir) = temp_registry();
        let space_profile = profiles_dir.join("sp-alpha");
        fs::create_dir_all(&space_profile).unwrap();

        registry
            .register_space("sp-alpha", AccountIsolationMode::Default)
            .expect("register default");

        let synced = registry
            .sync_spaces(vec![SpaceSyncInput {
                id: "sp-alpha".to_string(),
                account_isolation: AccountIsolationMode::Default,
            }])
            .expect("sync");
        assert!(synced[0].has_retained_profiles);
        assert_eq!(registry.profile_dir_for("sp-alpha").unwrap(), space_profile);
    }

    #[test]
    fn pty_open_validation_fails_closed_for_missing_unregistered_mismatched_tombstoned_and_isolated(
    ) {
        let (_dir, registry, _manifest_path, _profiles_dir) = temp_registry();
        registry
            .register_space("default", AccountIsolationMode::Default)
            .unwrap();
        registry
            .register_space("sp-iso", AccountIsolationMode::Isolated)
            .unwrap();
        registry
            .register_space("sp-dead", AccountIsolationMode::Default)
            .unwrap();
        registry
            .record_tombstone("sp-dead", None, Some("cleanup interrupted".to_string()))
            .unwrap();

        assert!(SpaceIsolationRegistry::default()
            .validate_pty_open(Some("default"), Some(AccountIsolationMode::Default))
            .is_err());
        assert!(registry
            .validate_pty_open(None, Some(AccountIsolationMode::Default))
            .is_err());
        assert!(registry
            .validate_pty_open(Some("../escape"), Some(AccountIsolationMode::Default))
            .is_err());
        assert!(registry.validate_pty_open(Some("default"), None).is_err());
        assert!(registry
            .validate_pty_open(Some("sp-unknown"), Some(AccountIsolationMode::Default))
            .is_err());
        assert!(registry
            .validate_pty_open(Some("default"), Some(AccountIsolationMode::Isolated))
            .is_err());
        assert!(registry
            .validate_pty_open(Some("sp-dead"), Some(AccountIsolationMode::Default))
            .is_err());
        // In #65, valid registered sp-iso passes preflight and provisions its profile dir.
        assert!(registry
            .validate_pty_open(Some("sp-iso"), Some(AccountIsolationMode::Isolated))
            .is_ok());
        assert!(registry
            .validate_pty_open(Some("default"), Some(AccountIsolationMode::Default))
            .is_ok());

        registry.clear_tombstone("sp-dead").unwrap();
        assert!(registry
            .validate_pty_open(Some("sp-dead"), Some(AccountIsolationMode::Default))
            .is_ok());
    }

    #[test]
    fn redacts_secret_patterns_from_sanitized_errors() {
        let raw = "failed near sk-ant-secretvalue1234567890 Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig {\"accessToken\":\"tok_abc\"} and ANTHROPIC_API_KEY=supersecretvalue999\nnewline";
        let sanitized = sanitize_error_message(raw);
        assert!(!sanitized.contains("sk-ant-secretvalue1234567890"));
        assert!(!sanitized.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(!sanitized.contains("tok_abc"));
        assert!(!sanitized.contains("supersecretvalue999"));
        assert!(!sanitized.contains('\n'));
    }

    #[test]
    fn remove_space_prunes_clean_default_entry_and_tracks_retained_profile_tombstone() {
        let (_dir, registry, manifest_path, profiles_dir) = temp_registry();
        registry
            .register_space("sp-clean", AccountIsolationMode::Default)
            .unwrap();
        registry.remove_space("sp-clean").unwrap();
        assert!(registry
            .validate_pty_open(Some("sp-clean"), Some(AccountIsolationMode::Default))
            .is_err());

        registry
            .register_space("sp-retained", AccountIsolationMode::Default)
            .unwrap();
        fs::create_dir_all(profiles_dir.join("sp-retained")).unwrap();
        registry.remove_space("sp-retained").unwrap();

        let reloaded = SpaceIsolationRegistry::for_paths(manifest_path, Some(profiles_dir));
        let synced = reloaded
            .sync_spaces(vec![SpaceSyncInput {
                id: "sp-retained".to_string(),
                account_isolation: AccountIsolationMode::Default,
            }])
            .unwrap();
        assert!(synced[0].cleanup_error.is_some());
        assert!(reloaded
            .validate_pty_open(Some("sp-retained"), Some(AccountIsolationMode::Default))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn agent_launch_preflight_requires_compatible_claude_cli_when_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let manifest_path = dir.path().join("app-data/space-isolation/manifest.json");
        let profiles_dir = dir.path().join("xdg-data/codr/space-profiles");
        let host_home = dir.path().join("host-home");
        let empty_bin = dir.path().join("empty-bin");
        fs::create_dir_all(&host_home).unwrap();
        fs::create_dir_all(&empty_bin).unwrap();

        let no_claude_registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path.clone(),
            Some(profiles_dir.clone()),
            Some(host_home.clone()),
            Some(empty_bin.as_os_str().to_os_string()),
        );
        no_claude_registry
            .register_space("sp-default", AccountIsolationMode::Default)
            .unwrap();
        no_claude_registry
            .register_space("sp-iso", AccountIsolationMode::Isolated)
            .unwrap();

        assert!(no_claude_registry
            .prepare_agent_launch("sp-default", AccountIsolationMode::Default, "claude")
            .is_ok());
        assert!(no_claude_registry
            .prepare_agent_launch("sp-iso", AccountIsolationMode::Isolated, "claude")
            .is_err());

        let good_bin = dir.path().join("good-bin");
        fs::create_dir_all(&good_bin).unwrap();
        let claude_path = good_bin.join("claude");
        fs::write(
            &claude_path,
            "#!/bin/sh\nprintf '{\"loggedIn\":false,\"configDirectory\":\"%s\"}\\n' \"$CLAUDE_CONFIG_DIR\"\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&claude_path, fs::Permissions::from_mode(0o755)).unwrap();

        let good_registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path,
            Some(profiles_dir),
            Some(host_home),
            Some(good_bin.as_os_str().to_os_string()),
        );
        assert!(good_registry
            .prepare_agent_launch("sp-iso", AccountIsolationMode::Isolated, "claude")
            .is_ok());
    }
}

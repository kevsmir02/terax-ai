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
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tempfile::NamedTempFile;

use crate::modules::pty::PtyState;
use crate::modules::space_profile::{
    provision_and_verify_claude_profile, verify_claude_cli_compatible, IsolatedProfileEnv,
    ProfileEnvironment,
};

const MANIFEST_VERSION: u32 = 1;
const MAX_SPACE_ID_LEN: usize = 128;
const MAX_SANITIZED_ERROR_LEN: usize = 160;
const TOMBSTONES_DIR_NAME: &str = ".tombstones";
const PTY_CLEANUP_GRACE_MS: u64 = 1000;

static TOMBSTONE_SEQ: AtomicU64 = AtomicU64::new(1);

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
    #[serde(default, skip_serializing_if = "is_false")]
    pub remove_space_after_cleanup: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
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
        let mut next = match fs::read_to_string(&manifest_path) {
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

        if let RegistryState::Ready {
            manifest_path,
            profiles_dir,
            manifest,
            ..
        } = &mut next
        {
            if let Err(error) =
                sweep_pending_tombstones(manifest_path, profiles_dir.as_deref(), manifest)
            {
                log::warn!("space isolation startup tombstone sweep failed: {error}");
            }
        }

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
        let tombstones_snapshot = manifest.tombstones.clone();
        let (statuses, dirty) = plan_sync_manifest(manifest, &inputs, &|id| {
            has_space_artifacts(profiles_ref, id, tombstones_snapshot.get(id))
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

    pub fn remove_space(&self, space_id: &str) -> Result<SpaceRuntimeStatus, String> {
        self.cleanup_space_profile(None, space_id, &[], CleanupIntent::RemoveSpace)
    }

    pub(crate) fn remove_space_with_pty(
        &self,
        pty: &PtyState,
        space_id: &str,
        pane_ids: &[u32],
    ) -> Result<SpaceRuntimeStatus, String> {
        self.cleanup_space_profile(Some(pty), space_id, pane_ids, CleanupIntent::RemoveSpace)
    }

    pub fn clear_private_profiles(&self, space_id: &str) -> Result<SpaceRuntimeStatus, String> {
        self.cleanup_space_profile(None, space_id, &[], CleanupIntent::ClearProfiles)
    }

    pub(crate) fn clear_private_profiles_with_pty(
        &self,
        pty: &PtyState,
        space_id: &str,
        pane_ids: &[u32],
    ) -> Result<SpaceRuntimeStatus, String> {
        self.cleanup_space_profile(Some(pty), space_id, pane_ids, CleanupIntent::ClearProfiles)
    }

    pub(crate) fn retry_cleanup(
        &self,
        pty: Option<&PtyState>,
        space_id: &str,
    ) -> Result<SpaceRuntimeStatus, String> {
        self.cleanup_space_profile(pty, space_id, &[], CleanupIntent::RetryExisting)
    }

    fn cleanup_space_profile(
        &self,
        pty: Option<&PtyState>,
        space_id: &str,
        pane_ids: &[u32],
        intent: CleanupIntent,
    ) -> Result<SpaceRuntimeStatus, String> {
        validate_space_id(space_id)?;

        let needs_pty_stop = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
            let (manifest_path, profiles_dir, _, _, manifest) = ready_parts_mut(&mut guard)?;
            let profiles_ref = profiles_dir.as_deref();
            let existing_tomb = manifest.tombstones.get(space_id).cloned();
            let has_artifacts = has_space_artifacts(profiles_ref, space_id, existing_tomb.as_ref());

            if intent == CleanupIntent::RetryExisting && existing_tomb.is_none() && !has_artifacts {
                let mode = manifest
                    .spaces
                    .get(space_id)
                    .map(|e| e.mode)
                    .unwrap_or(AccountIsolationMode::Default);
                return Ok(SpaceRuntimeStatus {
                    id: space_id.to_string(),
                    account_isolation: mode,
                    has_retained_profiles: false,
                    cleanup_error: None,
                });
            }

            let remove_space_after = match intent {
                CleanupIntent::RemoveSpace => true,
                CleanupIntent::ClearProfiles => existing_tomb
                    .as_ref()
                    .is_some_and(|t| t.remove_space_after_cleanup),
                CleanupIntent::RetryExisting => existing_tomb
                    .as_ref()
                    .is_some_and(|t| t.remove_space_after_cleanup),
            };

            let staging_dir = existing_tomb.as_ref().and_then(|t| t.staging_dir.clone());
            let created_at_ms = existing_tomb
                .as_ref()
                .map(|t| t.created_at_ms)
                .unwrap_or_else(current_time_ms);

            // Persist tombstone before releasing the lock to stop PTYs so
            // concurrent pty_open fails closed and crashes recover cleanly.
            if has_artifacts || existing_tomb.is_some() || pty.is_some() {
                manifest.tombstones.insert(
                    space_id.to_string(),
                    PendingTombstone {
                        space_id: space_id.to_string(),
                        staging_dir,
                        last_error: Some("Cleanup in progress".to_string()),
                        created_at_ms,
                        remove_space_after_cleanup: remove_space_after,
                    },
                );
                write_manifest_atomic(manifest_path, manifest)?;
            }
            pty.is_some()
        };

        let pty_stop_err = if needs_pty_stop {
            match pty {
                Some(pty_state) => pty_state
                    .stop_space_sessions(space_id, pane_ids, PTY_CLEANUP_GRACE_MS)
                    .err()
                    .map(|e| sanitize_error_message(&e)),
                None => None,
            }
        } else {
            None
        };

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Space isolation registry lock poisoned".to_string())?;
        let (manifest_path, profiles_dir, _, _, manifest) = ready_parts_mut(&mut guard)?;
        let mode = manifest
            .spaces
            .get(space_id)
            .map(|e| e.mode)
            .unwrap_or(AccountIsolationMode::Default);

        if let Some(err) = pty_stop_err {
            if let Some(tomb) = manifest.tombstones.get_mut(space_id) {
                tomb.last_error = Some(err);
                write_manifest_atomic(manifest_path, manifest)?;
            }
            return Ok(build_runtime_status(
                space_id,
                mode,
                profiles_dir.as_deref(),
                manifest.tombstones.get(space_id),
            ));
        }

        if manifest.tombstones.contains_key(space_id) {
            execute_tombstone_cleanup(manifest_path, profiles_dir.as_deref(), manifest, space_id)?;
        } else if intent == CleanupIntent::RemoveSpace && manifest.spaces.remove(space_id).is_some()
        {
            write_manifest_atomic(manifest_path, manifest)?;
        }

        Ok(build_runtime_status(
            space_id,
            mode,
            profiles_dir.as_deref(),
            manifest.tombstones.get(space_id),
        ))
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
                remove_space_after_cleanup: true,
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
        self.prepare_pty_isolation(
            Some(space_id),
            Some(expected_isolation),
            false,
            require_claude,
        )
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
        matches!(
            c,
            '"' | '\'' | ',' | ';' | ')' | '(' | '{' | '}' | '[' | ']'
        )
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

fn looks_like_path_fragment(raw: &str) -> bool {
    let s = raw.trim();
    if s.starts_with('/') && s.len() > 1 {
        return true;
    }
    if s.starts_with("~/")
        || s.starts_with("~\\")
        || s.starts_with("\\\\")
        || s.starts_with("file://")
    {
        return true;
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    s.contains("space-profiles") || s.contains(".tombstones") || s.contains(".credentials")
}

fn redact_quoted_paths(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\'' || ch == '"' {
            if let Some(end_offset) = chars[i + 1..].iter().position(|&c| c == ch) {
                let inner: String = chars[i + 1..i + 1 + end_offset].iter().collect();
                if looks_like_path_fragment(&inner) {
                    result.push_str("[path]");
                    i += 1 + end_offset + 1;
                    continue;
                }
            }
        }
        result.push(ch);
        i += 1;
    }
    result
}

fn strip_token_wrappers(token: &str) -> (&str, &str) {
    let trimmed_start = token.trim_start_matches(['(', '[', '{', '\'', '"']);
    let mut end_idx = trimmed_start.len();
    for (idx, ch) in trimmed_start.char_indices().rev() {
        if matches!(ch, ')' | ']' | '}' | '\'' | '"' | ',' | ';' | ':') {
            end_idx = idx;
        } else {
            break;
        }
    }
    let core = &trimmed_start[..end_idx];
    let suffix = &trimmed_start[end_idx..];
    (core, suffix)
}

pub fn sanitize_error_message(message: &str) -> String {
    let cleaned: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let unquoted_paths = redact_quoted_paths(&cleaned);
    let mut out = Vec::new();
    let mut redact_next = false;
    for token in unquoted_paths.split_whitespace() {
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
            continue;
        }
        let (core, suffix) = strip_token_wrappers(token);
        if looks_like_path_fragment(core) {
            let colon = if suffix.starts_with(':') { ":" } else { "" };
            out.push(format!("[path]{colon}"));
        } else if let Some((k, v)) = token.split_once('=') {
            let kl = k.to_ascii_lowercase();
            let (v_core, _) = strip_token_wrappers(v);
            if kl.contains("key")
                || kl.contains("token")
                || kl.contains("secret")
                || kl.contains("auth")
                || kl.contains("password")
                || kl.contains("cookie")
            {
                out.push(format!("{k}=[redacted]"));
            } else if looks_like_path_fragment(v_core) {
                out.push(format!("{k}=[path]"));
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
    sanitize_error_message(&format!("{:?}: {err}", err.kind()))
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupIntent {
    RemoveSpace,
    ClearProfiles,
    RetryExisting,
}

fn next_staging_rel(space_id: &str) -> String {
    let seq = TOMBSTONE_SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "{TOMBSTONES_DIR_NAME}/{space_id}-{}-{seq}",
        current_time_ms()
    )
}

fn resolve_staged_path(profiles_dir: &Path, staging_rel: &str) -> Result<PathBuf, String> {
    let mut components = Path::new(staging_rel).components();
    let Some(Component::Normal(first)) = components.next() else {
        return Err("Invalid tombstone staging path".to_string());
    };
    let Some(Component::Normal(child)) = components.next() else {
        return Err("Invalid tombstone staging child path".to_string());
    };
    if components.next().is_some() || first != TOMBSTONES_DIR_NAME {
        return Err("Tombstone staging path must live directly inside .tombstones".to_string());
    }
    let child_str = child.to_string_lossy();
    if child_str.is_empty() || child_str == "." || child_str == ".." || child_str.starts_with('.') {
        return Err("Invalid tombstone staging entry name".to_string());
    }
    Ok(profiles_dir.join(TOMBSTONES_DIR_NAME).join(child))
}

fn remove_path_strictly_scoped(expected_parent: &Path, target: &Path) -> Result<(), String> {
    let meta = match fs::symlink_metadata(target) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(sanitize_io_error(&e)),
    };
    if target.parent() != Some(expected_parent) {
        return Err("Refusing deletion outside expected isolation boundary".to_string());
    }
    if expected_parent.exists() {
        let canon_expected =
            fs::canonicalize(expected_parent).map_err(|e| sanitize_io_error(&e))?;
        let canon_actual = target
            .parent()
            .ok_or_else(|| "Missing parent directory".to_string())
            .and_then(|p| fs::canonicalize(p).map_err(|e| sanitize_io_error(&e)))?;
        if canon_actual != canon_expected {
            return Err("Refusing deletion across symlinked parent boundary".to_string());
        }
    }
    let res = if meta.file_type().is_symlink() || meta.is_file() {
        fs::remove_file(target)
    } else {
        fs::remove_dir_all(target)
    };
    res.map_err(|e| sanitize_io_error(&e))
}

fn matching_staged_entries(tombstones_root: &Path, space_id: &str) -> Vec<PathBuf> {
    let prefix = format!("{space_id}-");
    let Ok(entries) = fs::read_dir(tombstones_root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let s = name.to_string_lossy();
            if s.starts_with(&prefix) {
                Some(entry.path())
            } else {
                None
            }
        })
        .collect()
}

fn has_space_artifacts(
    profiles_dir: Option<&Path>,
    space_id: &str,
    tombstone: Option<&PendingTombstone>,
) -> bool {
    if has_retained_profile_dir(profiles_dir, space_id) {
        return true;
    }
    let Some(base) = profiles_dir else {
        return false;
    };
    if let Some(rel) = tombstone.and_then(|t| t.staging_dir.as_deref()) {
        if let Ok(staged) = resolve_staged_path(base, rel) {
            if fs::symlink_metadata(staged).is_ok() {
                return true;
            }
        }
    }
    !matching_staged_entries(&base.join(TOMBSTONES_DIR_NAME), space_id).is_empty()
}

fn execute_tombstone_cleanup(
    manifest_path: &Path,
    profiles_dir: Option<&Path>,
    manifest: &mut Manifest,
    space_id: &str,
) -> Result<(), String> {
    let Some(mut tomb) = manifest.tombstones.get(space_id).cloned() else {
        return Ok(());
    };
    let Some(base) = profiles_dir else {
        if tomb.staging_dir.is_some() {
            tomb.last_error = Some("Space profiles directory is unavailable".to_string());
            manifest.tombstones.insert(space_id.to_string(), tomb);
            write_manifest_atomic(manifest_path, manifest)?;
            return Ok(());
        }
        manifest.tombstones.remove(space_id);
        if tomb.remove_space_after_cleanup {
            manifest.spaces.remove(space_id);
        }
        write_manifest_atomic(manifest_path, manifest)?;
        return Ok(());
    };

    let tombstones_root = base.join(TOMBSTONES_DIR_NAME);

    if let Some(rel) = tomb.staging_dir.clone() {
        match resolve_staged_path(base, &rel)
            .and_then(|staged| remove_path_strictly_scoped(&tombstones_root, &staged))
        {
            Ok(()) => {
                tomb.staging_dir = None;
            }
            Err(err) => {
                tomb.last_error = Some(err);
                manifest.tombstones.insert(space_id.to_string(), tomb);
                write_manifest_atomic(manifest_path, manifest)?;
                return Ok(());
            }
        }
    }

    let active_path = base.join(space_id);
    match fs::symlink_metadata(&active_path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || meta.is_file() {
                if let Err(err) = remove_path_strictly_scoped(base, &active_path) {
                    tomb.last_error = Some(err);
                    manifest.tombstones.insert(space_id.to_string(), tomb);
                    write_manifest_atomic(manifest_path, manifest)?;
                    return Ok(());
                }
            } else {
                if let Err(err) = ensure_private_dir(&tombstones_root) {
                    tomb.last_error = Some(err);
                    manifest.tombstones.insert(space_id.to_string(), tomb);
                    write_manifest_atomic(manifest_path, manifest)?;
                    return Ok(());
                }
                let staging_rel = next_staging_rel(space_id);
                let staging_path = resolve_staged_path(base, &staging_rel)?;
                if let Err(err) = fs::rename(&active_path, &staging_path) {
                    tomb.last_error = Some(sanitize_io_error(&err));
                    manifest.tombstones.insert(space_id.to_string(), tomb);
                    write_manifest_atomic(manifest_path, manifest)?;
                    return Ok(());
                }
                tomb.staging_dir = Some(staging_rel);
                manifest
                    .tombstones
                    .insert(space_id.to_string(), tomb.clone());
                // Persist staging path atomically before recursive removal so crash recovery finds it.
                write_manifest_atomic(manifest_path, manifest)?;

                if let Err(err) = remove_path_strictly_scoped(&tombstones_root, &staging_path) {
                    tomb.last_error = Some(err);
                    manifest.tombstones.insert(space_id.to_string(), tomb);
                    write_manifest_atomic(manifest_path, manifest)?;
                    return Ok(());
                }
                tomb.staging_dir = None;
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            tomb.last_error = Some(sanitize_io_error(&err));
            manifest.tombstones.insert(space_id.to_string(), tomb);
            write_manifest_atomic(manifest_path, manifest)?;
            return Ok(());
        }
    }

    for leftover in matching_staged_entries(&tombstones_root, space_id) {
        if let Err(err) = remove_path_strictly_scoped(&tombstones_root, &leftover) {
            let rel = leftover
                .file_name()
                .map(|n| format!("{TOMBSTONES_DIR_NAME}/{}", n.to_string_lossy()));
            tomb.staging_dir = rel;
            tomb.last_error = Some(err);
            manifest.tombstones.insert(space_id.to_string(), tomb);
            write_manifest_atomic(manifest_path, manifest)?;
            return Ok(());
        }
    }

    manifest.tombstones.remove(space_id);
    if tomb.remove_space_after_cleanup {
        manifest.spaces.remove(space_id);
    }
    write_manifest_atomic(manifest_path, manifest)
}

fn sweep_pending_tombstones(
    manifest_path: &Path,
    profiles_dir: Option<&Path>,
    manifest: &mut Manifest,
) -> Result<(), String> {
    let ids: Vec<String> = manifest.tombstones.keys().cloned().collect();
    for space_id in ids {
        execute_tombstone_cleanup(manifest_path, profiles_dir, manifest, &space_id)?;
    }

    let Some(base) = profiles_dir else {
        return Ok(());
    };
    let tombstones_root = base.join(TOMBSTONES_DIR_NAME);
    let Ok(entries) = fs::read_dir(&tombstones_root) else {
        return Ok(());
    };

    let active_staging: BTreeSet<PathBuf> = manifest
        .tombstones
        .values()
        .filter_map(|t| t.staging_dir.as_deref())
        .filter_map(|rel| resolve_staged_path(base, rel).ok())
        .collect();

    for entry in entries.flatten() {
        let path = entry.path();
        if !active_staging.contains(&path) {
            if let Err(err) = remove_path_strictly_scoped(&tombstones_root, &path) {
                log::warn!("failed removing orphaned tombstone dir: {err}");
            }
        }
    }
    Ok(())
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

    for (id, tombstone) in &manifest.tombstones {
        if !seen.contains(id.as_str()) {
            let mode = manifest
                .spaces
                .get(id)
                .map(|entry| entry.mode)
                .unwrap_or(AccountIsolationMode::Default);
            statuses.push(SpaceRuntimeStatus {
                id: id.clone(),
                account_isolation: mode,
                has_retained_profiles: has_retained(id),
                cleanup_error: Some(
                    tombstone
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "Pending deletion cleanup for Space".to_string()),
                ),
            });
        }
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
        has_retained_profiles: has_space_artifacts(profiles_dir, space_id, tombstone),
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
pub async fn space_isolation_remove(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    pty: tauri::State<'_, PtyState>,
    space_id: String,
    pane_ids: Option<Vec<u32>>,
) -> Result<SpaceRuntimeStatus, String> {
    let registry = state.inner().clone();
    let pty_state = pty.inner().clone();
    let panes = pane_ids.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        registry.remove_space_with_pty(&pty_state, &space_id, &panes)
    })
    .await
    .map_err(|e| sanitize_error_message(&e.to_string()))?
}

#[tauri::command]
pub async fn space_isolation_clear_profiles(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    pty: tauri::State<'_, PtyState>,
    space_id: String,
    pane_ids: Option<Vec<u32>>,
) -> Result<SpaceRuntimeStatus, String> {
    let registry = state.inner().clone();
    let pty_state = pty.inner().clone();
    let panes = pane_ids.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        registry.clear_private_profiles_with_pty(&pty_state, &space_id, &panes)
    })
    .await
    .map_err(|e| sanitize_error_message(&e.to_string()))?
}

#[tauri::command]
pub async fn space_isolation_retry_cleanup(
    state: tauri::State<'_, SpaceIsolationRegistry>,
    pty: tauri::State<'_, PtyState>,
    space_id: String,
) -> Result<SpaceRuntimeStatus, String> {
    let registry = state.inner().clone();
    let pty_state = pty.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.retry_cleanup(Some(&pty_state), &space_id)
    })
    .await
    .map_err(|e| sanitize_error_message(&e.to_string()))?
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
    fn redacts_filesystem_paths_from_sanitized_errors() {
        let unix = sanitize_error_message(
            "failed removing /home/alice/.local/share/codr/space-profiles/sp-1/.credentials.json: PermissionDenied",
        );
        assert!(!unix.contains("/home"));
        assert!(!unix.contains("alice"));
        assert!(!unix.contains("space-profiles"));
        assert!(!unix.contains(".credentials.json"));
        assert!(unix.contains("[path]"));
        assert!(unix.contains("PermissionDenied"));

        let quoted = sanitize_error_message(
            "busy directory '/Users/Alice Smith/Library/Application Support/terax/space-profiles/sp 1'",
        );
        assert!(!quoted.contains("Alice"));
        assert!(!quoted.contains("space-profiles"));
        assert!(quoted.contains("[path]"));

        let win = sanitize_error_message(
            r"AccessDenied at C:\Users\alice\AppData\Roaming\codr\space-profiles\sp-1",
        );
        assert!(!win.contains("alice"));
        assert!(!win.contains("AppData"));
        assert!(win.contains("[path]"));
        assert!(win.contains("AccessDenied"));

        let env_path = sanitize_error_message("failed with CLAUDE_CONFIG_DIR=/tmp/secret-dir/sp-1");
        assert!(!env_path.contains("/tmp"));
        assert!(!env_path.contains("secret-dir"));
        assert!(env_path.contains("[path]"));
    }

    #[test]
    fn remove_space_deletes_writable_retained_profile_dir_and_prunes_manifest() {
        let (_dir, registry, manifest_path, profiles_dir) = temp_registry();
        registry
            .register_space("sp-clean", AccountIsolationMode::Default)
            .unwrap();
        let clean = registry.remove_space("sp-clean").unwrap();
        assert!(!clean.has_retained_profiles);
        assert!(clean.cleanup_error.is_none());
        assert!(registry
            .validate_pty_open(Some("sp-clean"), Some(AccountIsolationMode::Default))
            .is_err());

        registry
            .register_space("sp-retained", AccountIsolationMode::Default)
            .unwrap();
        fs::create_dir_all(profiles_dir.join("sp-retained")).unwrap();
        let removed = registry.remove_space("sp-retained").unwrap();
        assert!(!removed.has_retained_profiles);
        assert!(removed.cleanup_error.is_none());
        assert!(!profiles_dir.join("sp-retained").exists());

        let reloaded = SpaceIsolationRegistry::for_paths(manifest_path, Some(profiles_dir));
        let synced = reloaded.sync_spaces(vec![]).unwrap();
        assert!(synced.is_empty());
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

    #[cfg(unix)]
    #[test]
    fn clear_private_profiles_deletes_profile_dir_and_disabling_retains_for_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let manifest_path = dir.path().join("app-data/space-isolation/manifest.json");
        let profiles_dir = dir.path().join("xdg-data/codr/space-profiles");
        let host_home = dir.path().join("host-home");
        let bin_dir = dir.path().join("bin");
        fs::create_dir_all(&host_home).unwrap();
        fs::create_dir_all(&bin_dir).unwrap();
        let claude_path = bin_dir.join("claude");
        fs::write(
            &claude_path,
            "#!/bin/sh\nprintf '{\"loggedIn\":false,\"configDirectory\":\"%s\"}\\n' \"$CLAUDE_CONFIG_DIR\"\nexit 1\n",
        )
        .unwrap();
        fs::set_permissions(&claude_path, fs::Permissions::from_mode(0o755)).unwrap();

        let registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path.clone(),
            Some(profiles_dir.clone()),
            Some(host_home),
            Some(bin_dir.as_os_str().to_os_string()),
        );
        registry
            .register_space("sp-iso", AccountIsolationMode::Isolated)
            .unwrap();
        let creds_path = profiles_dir.join("sp-iso/claude/.credentials.json");
        fs::write(&creds_path, "secret-token").unwrap();

        let disabled = registry
            .set_space_mode("sp-iso", AccountIsolationMode::Default)
            .unwrap();
        assert_eq!(disabled.account_isolation, AccountIsolationMode::Default);
        assert!(disabled.has_retained_profiles);
        assert!(creds_path.exists());

        let reenabled = registry
            .set_space_mode("sp-iso", AccountIsolationMode::Isolated)
            .unwrap();
        assert_eq!(reenabled.account_isolation, AccountIsolationMode::Isolated);
        assert!(reenabled.has_retained_profiles);
        assert_eq!(fs::read_to_string(&creds_path).unwrap(), "secret-token");

        registry
            .set_space_mode("sp-iso", AccountIsolationMode::Default)
            .unwrap();
        let cleared = registry.clear_private_profiles("sp-iso").unwrap();
        assert_eq!(cleared.account_isolation, AccountIsolationMode::Default);
        assert!(!cleared.has_retained_profiles);
        assert!(cleared.cleanup_error.is_none());
        assert!(!profiles_dir.join("sp-iso").exists());
        assert!(registry
            .validate_pty_open(Some("sp-iso"), Some(AccountIsolationMode::Default))
            .is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_directory_preserves_tombstone_surfaces_redacted_error_and_recovers_on_retry() {
        let dir = tempfile::tempdir().unwrap();
        let manifest_path = dir.path().join("app-data/space-isolation/manifest.json");
        let profiles_dir = dir.path().join("xdg-data/codr/space-profiles");
        let registry =
            SpaceIsolationRegistry::for_paths(manifest_path.clone(), Some(profiles_dir.clone()));

        registry
            .register_space("sp-locked", AccountIsolationMode::Default)
            .unwrap();
        let locked_sub = profiles_dir.join("sp-locked/locked-sub");
        let inner = locked_sub.join("inner");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("token.json"), "secret").unwrap();
        fs::set_permissions(&locked_sub, fs::Permissions::from_mode(0o500)).unwrap();

        let status = registry.remove_space("sp-locked").unwrap();
        let err = status
            .cleanup_error
            .clone()
            .expect("unwritable nested dir should yield cleanupError");
        assert!(status.has_retained_profiles);
        assert!(
            !err.contains(&dir.path().to_string_lossy().to_string()),
            "cleanup_error must redact temp path: {err}"
        );
        assert!(!err.contains("space-profiles"));
        assert!(
            !profiles_dir.join("sp-locked").exists(),
            "atomic rename must move active dir into tombstone staging"
        );
        assert!(registry
            .validate_pty_open(Some("sp-locked"), Some(AccountIsolationMode::Default))
            .is_err());

        // Restore write bit on staged dir and retry cleanup.
        let staged_locked_sub = fs::read_dir(profiles_dir.join(".tombstones"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path().join("locked-sub"))
            .find(|p| p.exists())
            .expect("staged dir should exist under .tombstones");
        fs::set_permissions(&staged_locked_sub, fs::Permissions::from_mode(0o700)).unwrap();

        let retried = registry.retry_cleanup(None, "sp-locked").unwrap();
        assert!(!retried.has_retained_profiles);
        assert!(retried.cleanup_error.is_none());
        assert!(!staged_locked_sub.parent().unwrap().exists());
    }

    #[cfg(unix)]
    #[test]
    fn startup_sweep_cleans_leftover_tombstones_and_reconciles_stale_flags() {
        let dir = tempfile::tempdir().unwrap();
        let manifest_path = dir.path().join("app-data/space-isolation/manifest.json");
        let profiles_dir = dir.path().join("xdg-data/codr/space-profiles");
        let tombstones_dir = profiles_dir.join(".tombstones");
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        fs::create_dir_all(tombstones_dir.join("sp-crash-staged-100")).unwrap();
        fs::write(tombstones_dir.join("sp-crash-staged-100/creds.json"), "old").unwrap();
        fs::create_dir_all(profiles_dir.join("sp-crash-active/sub")).unwrap();
        fs::create_dir_all(tombstones_dir.join("sp-orphan-999")).unwrap();

        let still_locked_dir = profiles_dir.join("sp-still-locked/locked");
        fs::create_dir_all(still_locked_dir.join("leaf")).unwrap();
        fs::set_permissions(&still_locked_dir, fs::Permissions::from_mode(0o500)).unwrap();

        let manifest_json = serde_json::json!({
            "version": 1,
            "spaces": {
                "sp-crash-staged": { "mode": "isolated" },
                "sp-crash-active": { "mode": "default" },
                "sp-stale-tombstone": { "mode": "default" },
                "sp-still-locked": { "mode": "default" }
            },
            "tombstones": {
                "sp-crash-staged": {
                    "spaceId": "sp-crash-staged",
                    "stagingDir": ".tombstones/sp-crash-staged-100",
                    "lastError": "crashed mid-delete",
                    "createdAtMs": 100,
                    "removeSpaceAfterCleanup": true
                },
                "sp-crash-active": {
                    "spaceId": "sp-crash-active",
                    "createdAtMs": 101,
                    "removeSpaceAfterCleanup": true
                },
                "sp-stale-tombstone": {
                    "spaceId": "sp-stale-tombstone",
                    "createdAtMs": 102,
                    "removeSpaceAfterCleanup": true
                },
                "sp-still-locked": {
                    "spaceId": "sp-still-locked",
                    "createdAtMs": 103,
                    "removeSpaceAfterCleanup": true
                }
            }
        });
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest_json).unwrap(),
        )
        .unwrap();

        let reloaded =
            SpaceIsolationRegistry::for_paths(manifest_path.clone(), Some(profiles_dir.clone()));

        assert!(!tombstones_dir.join("sp-crash-staged-100").exists());
        assert!(!profiles_dir.join("sp-crash-active").exists());
        assert!(!tombstones_dir.join("sp-orphan-999").exists());

        let synced = reloaded.sync_spaces(vec![]).unwrap();
        assert_eq!(synced.len(), 1);
        assert_eq!(synced[0].id, "sp-still-locked");
        assert!(synced[0].has_retained_profiles);
        assert!(synced[0].cleanup_error.is_some());

        // Cleanup test permission for TempDir drop.
        for entry in fs::read_dir(&tombstones_dir).unwrap().flatten() {
            let p = entry.path().join("locked");
            if p.exists() {
                let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o700));
            }
        }
    }
}

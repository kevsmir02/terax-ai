//! Private durable storage for unsaved-text recovery drafts.
//!
//! This is a deliberately dumb store: it writes exactly the JSON record the
//! frontend produced, one file per buffer, into
//! `<app data>/<policy.directory>/`. The rules that need judgment (what a
//! cleanup resolves, what a late completion may still write, what a recovered
//! draft may become) live in `src/modules/editor/lib/recovery/` where they are
//! testable without a GUI. What this module owns is what only native code can
//! own:
//!
//!  - **Durability.** Atomic tempfile + `fsync` + rename, so a crash during a
//!    write leaves the older valid record instead of a torn one.
//!  - **A private location.** Its own subdirectory of the app data directory —
//!    not the layout/preference JSON files, and not the original project file.
//!    Created `0700`, records written `0600` (Unix; Windows relies on the
//!    per-app data directory ACL).
//!  - **Authoritative quota.** `policy.json` (shared with the frontend, not
//!    duplicated) bounds one record and the whole directory. Two running app
//!    instances share the directory, so the frontend pre-check cannot be the
//!    enforcement point. At the bound a write is *refused*; nothing is evicted,
//!    because the drafts are unrecovered user text.
//!  - **Revision-aware delete.** A delete carries the revision that was
//!    resolved and refuses to remove a newer record, so a late cleanup cannot
//!    destroy typing that happened after the save.
//!
//! Not provided on purpose: encryption, secret detection, and any path back to
//! the original file. Recovery never writes project files.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

/// The same policy file the frontend imports (`policy.json` sits next to the
/// recovery domain modules). One source for both limits.
const POLICY_JSON: &str = include_str!("../../../src/modules/editor/lib/recovery/policy.json");

/// Serialises quota-check-then-write and read-then-unlink. One lock for the
/// whole app: writes are coalesced and rare, and a global lock cannot deadlock
/// on id spelling the way a per-id lock could.
static RECOVERY_LOCK: Mutex<()> = Mutex::new(());

fn recovery_lock() -> std::sync::MutexGuard<'static, ()> {
    RECOVERY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

const MAX_BUFFER_ID_BYTES: usize = 200;

#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub per_file_bytes: u64,
    pub total_bytes: u64,
    pub directory: String,
}

impl Policy {
    pub fn from_json() -> Self {
        serde_json::from_str(POLICY_JSON).expect("valid recovery policy")
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PutOutcome {
    pub bytes: u64,
    pub total_bytes: u64,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOutcome {
    pub removed: bool,
    /// Revision still stored when the delete was refused as stale.
    pub revision: Option<u64>,
    pub total_bytes: u64,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub total_bytes: u64,
    pub records: u64,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StoreError {
    /// The record would exceed the per-file or the total bound.
    Quota { reason: QuotaReason },
    /// The private directory cannot be used at all (permissions, read-only
    /// home, removed volume). Drafts are not being protected right now.
    Unavailable { message: String },
    /// This one write/delete failed; the older record is still intact.
    Failed { message: String },
}

/// Why a write was refused. The strings are the frontend's `QuotaRefusal`
/// vocabulary (`src/modules/editor/lib/recovery/quota.ts`) on purpose: the
/// frontend turns this refusal into a *pause*, and a mismatch would degrade to
/// a generic failure. `src/modules/editor/lib/recovery/wireContract.test.ts`
/// parses this enum and fails if the two ever drift.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaReason {
    /// One record over the 10 MiB per-file bound.
    FileLimit,
    /// The recovery directory over the 100 MiB total bound.
    TotalLimit,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub root: String,
    pub available: bool,
}

/// What the frontend sends; only the fields native coordination needs are read,
/// the rest of the record is stored verbatim.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordEnvelope {
    buffer_id: String,
    buffer_revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRevision {
    buffer_revision: u64,
}

pub struct Store {
    root: PathBuf,
    policy: Policy,
}

impl Store {
    /// Root is the recovery directory itself (`<app data>/recovery`).
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            policy: Policy::from_json(),
        }
    }

    pub fn with_policy(root: PathBuf, policy: Policy) -> Self {
        Self { root, policy }
    }

    pub fn location(&self) -> Location {
        Location {
            root: self.root.to_string_lossy().to_string(),
            available: self.ensure_dirs().is_ok(),
        }
    }

    fn records_dir(&self) -> PathBuf {
        self.root.join("records")
    }

    fn record_path(&self, buffer_id: &str) -> PathBuf {
        // Hex, not the raw id: an id can contain separators, and a stored file
        // name must never be able to escape the records directory.
        let mut name = String::with_capacity(buffer_id.len() * 2 + 5);
        for byte in buffer_id.as_bytes() {
            name.push_str(&format!("{byte:02x}"));
        }
        name.push_str(".json");
        self.records_dir().join(name)
    }

    fn ensure_dirs(&self) -> Result<(), StoreError> {
        create_private_dir(&self.root)?;
        create_private_dir(&self.records_dir())
    }

    /// Stores one record, refusing rather than evicting at the quota bounds.
    pub fn put(&self, record_json: &str) -> Result<PutOutcome, StoreError> {
        let _guard = recovery_lock();
        validate_record(record_json)?;
        let envelope: RecordEnvelope =
            serde_json::from_str(record_json).map_err(|e| StoreError::Failed {
                message: format!("invalid recovery record: {e}"),
            })?;
        validate_buffer_id(&envelope.buffer_id)?;
        if envelope.buffer_revision == 0 {
            return Err(StoreError::Failed {
                message: "invalid recovery buffer revision".into(),
            });
        }

        let bytes = record_json.len() as u64;
        if bytes > self.policy.per_file_bytes {
            return Err(StoreError::Quota {
                reason: QuotaReason::FileLimit,
            });
        }
        self.ensure_dirs()?;

        let target = self.record_path(&envelope.buffer_id);
        let existing = file_len(&target);
        let used = self.usage_unlocked()?;
        let after = used.saturating_sub(existing).saturating_add(bytes);
        if after > self.policy.total_bytes {
            return Err(StoreError::Quota {
                reason: QuotaReason::TotalLimit,
            });
        }

        write_private_atomic(&target, record_json.as_bytes()).map_err(|e| StoreError::Failed {
            message: format!("could not write recovery record: {e}"),
        })?;

        Ok(PutOutcome {
            bytes,
            total_bytes: self.usage_unlocked()?,
        })
    }

    /// Deletes `buffer_id`'s record only when its stored revision is at or below
    /// `up_to_revision`. A newer record is kept and reported.
    pub fn remove(
        &self,
        buffer_id: &str,
        up_to_revision: u64,
    ) -> Result<RemoveOutcome, StoreError> {
        let _guard = recovery_lock();
        validate_buffer_id(buffer_id)?;
        let target = self.record_path(buffer_id);
        let stored = match fs::read_to_string(&target) {
            Ok(raw) => match serde_json::from_str::<StoredRevision>(&raw) {
                Ok(revision) => Some(revision.buffer_revision),
                Err(_) => None,
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RemoveOutcome {
                    removed: false,
                    revision: None,
                    total_bytes: self.usage_unlocked()?,
                });
            }
            Err(e) => {
                return Err(StoreError::Failed {
                    message: format!("could not read recovery record: {e}"),
                });
            }
        };

        // A record we cannot parse is not safe to keep forever either: it can
        // never be offered to the user, and it still counts against the quota.
        // Remove it on an explicit resolution instead of shielding garbage.
        let stale = stored.is_none_or(|revision| revision <= up_to_revision);
        if !stale {
            return Ok(RemoveOutcome {
                removed: false,
                revision: stored,
                total_bytes: self.usage_unlocked()?,
            });
        }
        fs::remove_file(&target).map_err(|e| StoreError::Failed {
            message: format!("could not remove recovery record: {e}"),
        })?;
        Ok(RemoveOutcome {
            removed: true,
            revision: stored,
            total_bytes: self.usage_unlocked()?,
        })
    }

    /// Every stored record, verbatim. Unreadable files are skipped: one corrupt
    /// record must not hide the rest of the drafts.
    pub fn list(&self) -> Result<Vec<String>, StoreError> {
        let dir = self.records_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(StoreError::Unavailable {
                    message: format!("could not list recovery storage: {e}"),
                });
            }
        };
        let mut out: Vec<(String, String)> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(raw) = fs::read_to_string(&path) {
                // A file that is not a JSON object cannot be offered to the
                // user; skipping it here keeps one corrupt record from hiding
                // the rest. `remove` still resolves it on request.
                if serde_json::from_str::<serde_json::Value>(&raw)
                    .map(|value| value.is_object())
                    .unwrap_or(false)
                {
                    out.push((entry.file_name().to_string_lossy().to_string(), raw));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out.into_iter().map(|(_, raw)| raw).collect())
    }

    pub fn usage(&self) -> Result<Usage, StoreError> {
        let _guard = recovery_lock();
        let total = self.usage_unlocked()?;
        let records = self.count_unlocked()?;
        Ok(Usage {
            total_bytes: total,
            records,
        })
    }

    fn usage_unlocked(&self) -> Result<u64, StoreError> {
        let dir = self.records_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => {
                return Err(StoreError::Unavailable {
                    message: format!("recovery storage is unreadable: {e}"),
                });
            }
        };
        let mut total = 0u64;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            total = total.saturating_add(file_len(&path));
        }
        Ok(total)
    }

    fn count_unlocked(&self) -> Result<u64, StoreError> {
        let dir = self.records_dir();
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => {
                return Err(StoreError::Unavailable {
                    message: format!("recovery storage is unreadable: {e}"),
                });
            }
        };
        Ok(entries
            .flatten()
            .filter(|entry| entry.path().extension().and_then(|e| e.to_str()) == Some("json"))
            .count() as u64)
    }
}

fn validate_record(record_json: &str) -> Result<(), StoreError> {
    if record_json.is_empty() {
        return Err(StoreError::Failed {
            message: "empty recovery record".into(),
        });
    }
    Ok(())
}

/// Ids are generated by the frontend, but the store refuses anything that could
/// not have been generated: empty, oversized, control bytes, separators, or a
/// path component.
fn validate_buffer_id(buffer_id: &str) -> Result<(), StoreError> {
    if buffer_id.is_empty() || buffer_id.len() > MAX_BUFFER_ID_BYTES {
        return Err(StoreError::Failed {
            message: "invalid recovery buffer identity".into(),
        });
    }
    if buffer_id
        .bytes()
        .any(|b| b < 0x20 || b == b'/' || b == b'\\')
    {
        return Err(StoreError::Failed {
            message: "invalid recovery buffer identity".into(),
        });
    }
    if Path::new(buffer_id).components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(StoreError::Failed {
            message: "invalid recovery buffer identity".into(),
        });
    }
    Ok(())
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// The recovery directory lives inside the per-identifier app data directory
/// (`~/.local/share/<identifier>` on Linux) but in its own subdirectory: layout
/// and preference persistence are separate JSON files one level up, and drafts
/// must never be confused with either them or the original project file.
fn store_for(app: &tauri::AppHandle) -> Result<Store, StoreError> {
    use tauri::Manager;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| StoreError::Unavailable {
            message: format!("no app data directory: {e}"),
        })?;
    Ok(Store::new(data.join(Policy::from_json().directory)))
}

/// Records and the byte total for the UI's status line.
#[tauri::command]
pub async fn recovery_list(app: tauri::AppHandle) -> Result<Vec<String>, StoreError> {
    let store = store_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.list())
        .await
        .map_err(|e| StoreError::Failed {
            message: e.to_string(),
        })?
}

/// Stores one record. Refuses at the per-file or total bound; never evicts.
#[tauri::command]
pub async fn recovery_put(app: tauri::AppHandle, record: String) -> Result<PutOutcome, StoreError> {
    let store = store_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.put(&record))
        .await
        .map_err(|e| StoreError::Failed {
            message: e.to_string(),
        })?
}

/// Deletes a resolved record, refusing when a newer revision is stored.
#[tauri::command]
pub async fn recovery_remove(
    app: tauri::AppHandle,
    buffer_id: String,
    up_to_revision: u64,
) -> Result<RemoveOutcome, StoreError> {
    let store = store_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.remove(&buffer_id, up_to_revision))
        .await
        .map_err(|e| StoreError::Failed {
            message: e.to_string(),
        })?
}

#[tauri::command]
pub async fn recovery_usage(app: tauri::AppHandle) -> Result<Usage, StoreError> {
    let store = store_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.usage())
        .await
        .map_err(|e| StoreError::Failed {
            message: e.to_string(),
        })?
}

/// Discloses the private directory and whether it is usable. Creating it here
/// is the one place the directory is provisioned.
#[tauri::command]
pub async fn recovery_location(app: tauri::AppHandle) -> Result<Location, StoreError> {
    let store = store_for(&app)?;
    tauri::async_runtime::spawn_blocking(move || store.location())
        .await
        .map_err(|e| StoreError::Unavailable {
            message: e.to_string(),
        })
}

#[cfg(unix)]
fn create_private_dir(path: &Path) -> Result<(), StoreError> {
    use std::os::unix::fs::DirBuilderExt;
    if path.is_dir() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(path).map_err(|e| StoreError::Unavailable {
        message: format!("could not create recovery storage: {e}"),
    })
}

#[cfg(not(unix))]
fn create_private_dir(path: &Path) -> Result<(), StoreError> {
    fs::create_dir_all(path).map_err(|e| StoreError::Unavailable {
        message: format!("could not create recovery storage: {e}"),
    })
}

#[cfg(unix)]
fn write_private_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent directory")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut()
        .set_permissions(fs::Permissions::from_mode(0o600))?;
    tmp.as_file_mut().write_all(bytes)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent directory")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(bytes)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(buffer_id: &str, revision: u64, text: &str) -> String {
        serde_json::json!({
            "version": 1,
            "bufferId": buffer_id,
            "spaceId": "sp-a",
            "path": "/home/me/notes.txt",
            "fileIdentity": "8-9",
            "bufferRevision": revision,
            "diskRevision": null,
            "text": text,
            "bytes": text.len(),
            "updatedAt": 1,
        })
        .to_string()
    }

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::with_policy(
            dir.path().join("recovery"),
            Policy {
                per_file_bytes: 1024,
                total_bytes: 4096,
                directory: "recovery".into(),
            },
        );
        (dir, store)
    }

    #[test]
    fn the_policy_carries_the_disclosed_limits_and_its_own_directory() {
        let policy = Policy::from_json();
        assert_eq!(policy.per_file_bytes, 10 * 1024 * 1024);
        assert_eq!(policy.total_bytes, 100 * 1024 * 1024);
        assert_eq!(policy.directory, "recovery");
    }

    #[test]
    fn errors_serialize_to_the_frontend_contract() {
        assert_eq!(
            serde_json::to_value(StoreError::Quota {
                reason: QuotaReason::FileLimit
            })
            .unwrap(),
            serde_json::json!({ "kind": "quota", "reason": "file-limit" })
        );
        assert_eq!(
            serde_json::to_value(StoreError::Quota {
                reason: QuotaReason::TotalLimit
            })
            .unwrap(),
            serde_json::json!({ "kind": "quota", "reason": "total-limit" })
        );
        assert_eq!(
            serde_json::to_value(StoreError::Unavailable {
                message: "read-only".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "unavailable", "message": "read-only" })
        );
        assert_eq!(
            serde_json::to_value(StoreError::Failed {
                message: "nope".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "failed", "message": "nope" })
        );
    }

    #[test]
    fn ids_with_separators_cannot_escape_the_records_directory() {
        let (_dir, store) = store();
        for id in ["", "a/b", "../escape", "a\\b", "line\nbreak"] {
            assert!(store.put(&record(id, 1, "x")).is_err(), "{id} was accepted");
        }
        // A legitimate odd character is fine and stays inside the directory.
        store.put(&record("buf-1:t", 1, "x")).unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn put_refuses_over_the_per_file_bound_and_keeps_the_older_record() {
        let (_dir, store) = store();
        store.put(&record("buf-a", 1, "older")).unwrap();
        let huge = record("buf-a", 2, &"x".repeat(2048));
        let err = store.put(&huge).unwrap_err();
        assert_eq!(
            err,
            StoreError::Quota {
                reason: QuotaReason::FileLimit
            }
        );
        assert_eq!(store.list().unwrap(), vec![record("buf-a", 1, "older")]);
    }

    #[test]
    fn put_refuses_over_the_total_bound_without_evicting() {
        let (_dir, store) = store();
        // Each record is a bit under 512 bytes; the total bound is 4096.
        for i in 0..8 {
            store
                .put(&record(&format!("buf-{i}"), 1, &"y".repeat(300)))
                .unwrap_or_else(|e| panic!("record {i} refused: {e:?}"));
        }
        let before = store.usage().unwrap();
        assert!(before.total_bytes > 3000);
        assert!(before.total_bytes <= 4096);
        let err = store
            .put(&record("buf-overflow", 1, &"z".repeat(300)))
            .unwrap_err();
        assert_eq!(
            err,
            StoreError::Quota {
                reason: QuotaReason::TotalLimit
            }
        );
        // Nothing was removed to make room.
        assert_eq!(store.usage().unwrap().records, before.records);
    }

    #[test]
    fn remove_is_revision_aware() {
        let (_dir, store) = store();
        store.put(&record("buf-a", 4, "newer")).unwrap();
        let refused = store.remove("buf-a", 3).unwrap();
        assert!(!refused.removed);
        assert_eq!(refused.revision, Some(4));
        assert_eq!(store.list().unwrap().len(), 1);

        let removed = store.remove("buf-a", 4).unwrap();
        assert!(removed.removed);
        assert_eq!(store.list().unwrap(), Vec::<String>::new());
        // Deleting a missing record is a no-op, not an error.
        assert!(!store.remove("buf-a", 9).unwrap().removed);
    }

    #[test]
    fn two_buffers_of_one_pathname_are_two_files() {
        let (_dir, store) = store();
        store
            .put(
                &serde_json::json!({
                    "version": 1, "bufferId": "buf-a", "spaceId": "sp-a",
                    "path": "/home/me/x", "fileIdentity": "", "bufferRevision": 1,
                    "diskRevision": null, "text": "A", "bytes": 1, "updatedAt": 1,
                })
                .to_string(),
            )
            .unwrap();
        store
            .put(
                &serde_json::json!({
                    "version": 1, "bufferId": "buf-b", "spaceId": "sp-b",
                    "path": "/home/me/x", "fileIdentity": "", "bufferRevision": 1,
                    "diskRevision": null, "text": "B", "bytes": 1, "updatedAt": 1,
                })
                .to_string(),
            )
            .unwrap();
        assert_eq!(store.usage().unwrap().records, 2);
        store.remove("buf-a", 1).unwrap();
        let remaining = store.list().unwrap();
        assert_eq!(remaining.len(), 1);
        assert!(remaining[0].contains("\"buf-b\""));
    }

    #[cfg(unix)]
    #[test]
    fn the_storage_location_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = store();
        store.put(&record("buf-a", 1, "text")).unwrap();
        let root_mode = fs::metadata(&store.root).unwrap().permissions().mode() & 0o777;
        assert_eq!(root_mode, 0o700);
        let records_mode = fs::metadata(store.records_dir())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(records_mode, 0o700);
        let record_path = store.record_path("buf-a");
        assert!(record_path.starts_with(dir.path()));
        let file_mode = fs::metadata(&record_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_preserves_the_older_valid_record() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, store) = store();
        store.put(&record("buf-a", 1, "older")).unwrap();
        // Make the records directory read-only: tempfile creation fails.
        let records = store.records_dir();
        let original = fs::metadata(&records).unwrap().permissions();
        fs::set_permissions(&records, fs::Permissions::from_mode(0o500)).unwrap();

        let outcome = store.put(&record("buf-a", 2, "newer"));
        // Root bypasses the permission bits in some test containers; the
        // invariant asserted here is only "no partial/torn replacement".
        if outcome.is_err() {
            assert_eq!(store.list().unwrap(), vec![record("buf-a", 1, "older")]);
        }
        fs::set_permissions(&records, original).unwrap();
    }

    #[test]
    fn unreadable_entries_are_skipped_but_still_resolved() {
        let (_dir, store) = store();
        store.put(&record("buf-a", 2, "good")).unwrap();
        store.ensure_dirs().unwrap();
        fs::write(store.record_path("buf-garbage"), b"{not json").unwrap();

        let listed = store.list().unwrap();
        assert_eq!(listed, vec![record("buf-a", 2, "good")]);

        // The corrupt file can never be offered, so an explicit resolution
        // removes it rather than shielding it from cleanup forever.
        let removed = store.remove("buf-garbage", 0).unwrap();
        assert!(removed.removed);
        assert_eq!(store.list().unwrap().len(), 1);
    }
}

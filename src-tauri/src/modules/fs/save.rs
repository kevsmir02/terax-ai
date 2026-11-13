//! Expected-revision coordination for app-owned file writes.
//!
//! Two independently dirty buffers of one canonical file must not both
//! overwrite the revision they were both edited from. The frontend carries the
//! revision it read; this module recomputes the current one **inside** the
//! write critical section and refuses the write when they disagree.
//!
//! A revision is opaque to callers and must distinguish a content change that
//! keeps the same mtime and size, so it is a content digest plus the size and
//! the file identity (device/inode, volume/file index). Identity is included on
//! purpose: a replaced target (checkout, rename, `cp`) is a conflict even when
//! the bytes happen to match, because the file the user reviewed no longer
//! exists.
//!
//! Scope: this coordinates **app-owned** writes. Independent external writers
//! are not locked out, and a write that lands between the check and the rename
//! is not distinguishable from one that lands immediately after. Do not claim
//! atomic exclusion of other programs.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use serde::ser::{SerializeStruct, Serializer};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use super::file::mtime_millis;

/// Marks the revision format so an unrecognised string is a conflict, not a
/// silent match. Bump only with a migration plan for open buffers.
const REVISION_PREFIX: &str = "r1";
const HASH_CHUNK_BYTES: usize = 64 * 1024;

/// Serialises app-owned write coordination. One lock for the whole app: the
/// critical section is a fingerprint plus a rename, writes are user-initiated
/// and rare, and a global lock cannot deadlock on path spelling differences
/// (symlinks, `..`, case) the way a per-path lock could.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

fn save_lock() -> std::sync::MutexGuard<'static, ()> {
    // A panicking writer must not poison every later save.
    SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Bench-only write delay (`TERAX_BENCH_WRITE_DELAY_MS`).
///
/// The app-lab stale-typing step has to type while a native write is genuinely in flight. Waiting
/// for a slow disk is not deterministic, so the bench build honours this variable; without the
/// `bench` feature the function is empty and the variable does nothing, so a shipped build has no
/// runtime knob. The value is bounded so a stray environment cannot hang the app.
#[cfg(feature = "bench")]
fn bench_write_delay() {
    if let Ok(raw) = std::env::var("TERAX_BENCH_WRITE_DELAY_MS") {
        let millis = bench_delay_ms(Some(raw.as_str()));
        if millis > 0 {
            std::thread::sleep(std::time::Duration::from_millis(millis));
        }
    }
}

#[cfg(not(feature = "bench"))]
fn bench_write_delay() {}

/// Parse and bound the bench delay; `None`, a non-number and `0` mean no delay.
#[cfg(feature = "bench")]
fn bench_delay_ms(raw: Option<&str>) -> u64 {
    const MAX_BENCH_DELAY_MS: u64 = 10_000;
    raw.and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.min(MAX_BENCH_DELAY_MS))
        .unwrap_or(0)
}

/// Content digest + size + file identity. Comparable, never interpreted by the
/// frontend; it is passed back verbatim on save.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskRevision {
    digest: [u8; 32],
    size: u64,
    identity: String,
}

impl DiskRevision {
    /// Fingerprint of bytes already read, bound to the identity of the file
    /// they came from. Hashing the read buffer keeps the read path free of a
    /// second pass over the same file.
    pub fn of_bytes(bytes: &[u8], meta: &fs::Metadata) -> Self {
        Self {
            digest: Sha256::digest(bytes).into(),
            size: bytes.len() as u64,
            identity: file_identity(meta),
        }
    }

    /// Opaque form handed to the frontend and expected back on save.
    pub fn to_opaque(&self) -> String {
        format!(
            "{REVISION_PREFIX}:{}:{}:{}",
            hex(&self.digest),
            self.size,
            self.identity
        )
    }

    /// `None` for anything this build did not produce; an unknown revision is
    /// treated as a mismatch so a stale or foreign token can never authorise a
    /// write.
    pub fn parse(opaque: &str) -> Option<Self> {
        let rest = opaque.strip_prefix(REVISION_PREFIX)?.strip_prefix(':')?;
        let (digest, rest) = rest.split_once(':')?;
        let (size, identity) = rest.split_once(':')?;
        if digest.len() != 64 || identity.is_empty() {
            return None;
        }
        Some(Self {
            digest: unhex(digest)?,
            size: size.parse().ok()?,
            identity: identity.to_string(),
        })
    }

    fn same_contents(&self, other: &Self) -> bool {
        self.digest == other.digest && self.size == other.size
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn unhex(text: &str) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(text.get(index * 2..index * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{}-{}", meta.dev(), meta.ino())
}

#[cfg(windows)]
fn file_identity(meta: &fs::Metadata) -> String {
    use std::os::windows::fs::MetadataExt;
    format!(
        "{}-{}",
        meta.volume_serial_number().unwrap_or(0),
        meta.file_index().unwrap_or(0)
    )
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_meta: &fs::Metadata) -> String {
    // No stable file identity on this platform: replaced-target detection
    // degrades to a content comparison.
    "0-0".to_string()
}

/// What is on disk right now, by the same rules the write path applies.
#[derive(Debug)]
pub enum CurrentState {
    Present(DiskRevision),
    Missing,
    Unreadable,
}

/// Reads and fingerprints the current target without following it into
/// something that is not a regular file. Never opens a FIFO or device for a
/// revision: those are unreadable-by-definition here, and opening one would
/// block or consume a stream.
pub fn current_revision(path: &Path) -> CurrentState {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    // A FIFO swapped in before open() must fail instead of blocking.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return CurrentState::Missing,
        Err(e) => {
            log::debug!("revision open({}) failed: {e}", path.display());
            return CurrentState::Unreadable;
        }
    };
    let meta = match file.metadata() {
        Ok(meta) => meta,
        Err(_) => return CurrentState::Unreadable,
    };
    if !meta.is_file() {
        return CurrentState::Unreadable;
    }
    match hash_reader(file) {
        Ok(digest) => CurrentState::Present(DiskRevision {
            digest,
            size: meta.len(),
            identity: file_identity(&meta),
        }),
        Err(e) => {
            log::debug!("revision read({}) failed: {e}", path.display());
            CurrentState::Unreadable
        }
    }
}

fn hash_reader(mut reader: impl Read) -> std::io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; HASH_CHUNK_BYTES];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&chunk[..read]);
    }
}

/// Why an expected revision did not match the disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictReason {
    /// Contents differ (including a same-mtime, same-size edit).
    Changed,
    /// Same contents, different file identity: the reviewed file is gone.
    Replaced,
    /// The target no longer exists.
    Missing,
    /// Exists but cannot be fingerprinted as a regular file.
    Unreadable,
}

/// A refused save. `current` is the revision now on disk, so the caller can
/// present it for review and bind a fresh overwrite consent to it.
#[derive(Debug)]
pub struct Conflict {
    pub reason: ConflictReason,
    pub current: Option<String>,
}

/// A save that did not happen. `Conflict` is the expected, recoverable outcome;
/// `Failed` is an I/O problem the user cannot resolve by choosing.
#[derive(Debug)]
pub enum SaveError {
    Conflict(Conflict),
    Failed(String),
}

impl Serialize for SaveError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            SaveError::Conflict(conflict) => {
                let mut state = serializer.serialize_struct("Conflict", 3)?;
                state.serialize_field("kind", "conflict")?;
                state.serialize_field("reason", &conflict.reason)?;
                state.serialize_field("current", &conflict.current)?;
                state.end()
            }
            SaveError::Failed(message) => {
                let mut state = serializer.serialize_struct("Failed", 2)?;
                state.serialize_field("kind", "failed")?;
                state.serialize_field("message", message)?;
                state.end()
            }
        }
    }
}

/// What a successful save left on disk.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub revision: String,
    pub mtime: u64,
    /// The target did not exist before this write.
    pub created: bool,
}

/// Writes `content` to `target`, refusing when the disk no longer matches
/// `expected`.
///
/// `expected == None` is the deliberate unconditional form: creating a new
/// file, Save As to a chosen path, or a legacy caller that never read the file.
/// With a revision supplied, a missing, unreadable, replaced or changed target
/// is never written over.
pub fn save(
    target: &Path,
    content: &[u8],
    expected: Option<&str>,
) -> Result<SaveOutcome, SaveError> {
    // Serialise the check and the write so two app-owned saves of the same
    // baseline cannot interleave.
    let _guard = save_lock();

    // Bench-only: hold the write open so the app-lab can type during it.
    bench_write_delay();

    if let Some(expected) = expected {
        match current_revision(target) {
            CurrentState::Present(current) => check_expected(&current, expected)?,
            CurrentState::Missing => {
                return Err(SaveError::Conflict(Conflict {
                    reason: ConflictReason::Missing,
                    current: None,
                }));
            }
            CurrentState::Unreadable => {
                return Err(SaveError::Conflict(Conflict {
                    reason: ConflictReason::Unreadable,
                    current: None,
                }));
            }
        }
    }

    let original = fs::metadata(target).ok();
    write_atomic(target, content).map_err(|e| {
        log::warn!("write({}) failed: {e}", target.display());
        SaveError::Failed(e.to_string())
    })?;
    // write_atomic renames a fresh tempfile over the target, so the mode has to
    // be carried over explicitly.
    if let Some(perms) = original.as_ref().map(|m| m.permissions()) {
        let _ = fs::set_permissions(target, perms);
    }
    let meta = fs::metadata(target).map_err(|e| SaveError::Failed(e.to_string()))?;
    let revision = DiskRevision::of_bytes(content, &meta);
    Ok(SaveOutcome {
        revision: revision.to_opaque(),
        mtime: mtime_millis(&meta),
        created: original.is_none(),
    })
}

fn check_expected(current: &DiskRevision, expected: &str) -> Result<(), SaveError> {
    let Some(expected) = DiskRevision::parse(expected) else {
        return Err(SaveError::Conflict(Conflict {
            reason: ConflictReason::Changed,
            current: Some(current.to_opaque()),
        }));
    };
    if !current.same_contents(&expected) {
        return Err(SaveError::Conflict(Conflict {
            reason: ConflictReason::Changed,
            current: Some(current.to_opaque()),
        }));
    }
    if current.identity != expected.identity {
        return Err(SaveError::Conflict(Conflict {
            reason: ConflictReason::Replaced,
            current: Some(current.to_opaque()),
        }));
    }
    Ok(())
}

/// Atomic write via O_EXCL tempfile in the target's parent, then rename.
/// The random suffix is what blocks pre-staged symlink attacks.
pub fn write_atomic(target: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opaque_revisions_round_trip() {
        let opaque = format!("{REVISION_PREFIX}:{}:12:8-9", "ab".repeat(32));
        let parsed = DiskRevision::parse(&opaque).unwrap();
        assert_eq!(parsed.size, 12);
        assert_eq!(parsed.identity, "8-9");
        assert_eq!(parsed.to_opaque(), opaque);
    }

    #[test]
    fn foreign_or_truncated_revisions_do_not_parse() {
        for value in [
            "",
            "r1",
            "r2:aa:1:0-0",
            "r1:zz:1:0-0",
            "r1:abcd:1:0-0",
            "r1::1:0-0",
            &format!("r1:{}:1:", "ab".repeat(32)),
            &format!("r1:{}:x:0-0", "ab".repeat(32)),
        ] {
            assert!(DiskRevision::parse(value).is_none(), "{value} parsed");
        }
    }

    #[test]
    fn identity_changes_are_reported_as_replaced_not_changed() {
        let digest = [7u8; 32];
        let current = DiskRevision {
            digest,
            size: 4,
            identity: "1-2".into(),
        };
        let same_bytes_new_inode = format!("{REVISION_PREFIX}:{}:4:1-3", "07".repeat(32));
        match check_expected(&current, &same_bytes_new_inode).unwrap_err() {
            SaveError::Conflict(conflict) => assert_eq!(conflict.reason, ConflictReason::Replaced),
            other => panic!("{other:?}"),
        }
        let other_bytes = format!("{REVISION_PREFIX}:{}:4:1-2", "08".repeat(32));
        match check_expected(&current, &other_bytes).unwrap_err() {
            SaveError::Conflict(conflict) => assert_eq!(conflict.reason, ConflictReason::Changed),
            other => panic!("{other:?}"),
        }
        let same = format!("{REVISION_PREFIX}:{}:4:1-2", "07".repeat(32));
        assert!(check_expected(&current, &same).is_ok());
    }

    /// The refusal shape is a contract with `diskSync.ts`
    /// (`{kind, reason, current}` / `{kind, message}`): assert it here so a
    /// serialization change cannot silently turn a conflict into a generic
    /// error the dialog does not recognise.
    #[test]
    fn refusals_serialize_to_the_frontend_contract() {
        let current = format!("{REVISION_PREFIX}:{}:4:8-9", "ab".repeat(32));
        for (reason, reason_name) in [
            (ConflictReason::Changed, "changed"),
            (ConflictReason::Replaced, "replaced"),
            (ConflictReason::Missing, "missing"),
            (ConflictReason::Unreadable, "unreadable"),
        ] {
            let error = SaveError::Conflict(Conflict {
                reason,
                current: Some(current.clone()),
            });
            assert_eq!(
                serde_json::to_value(&error).unwrap(),
                serde_json::json!({
                    "kind": "conflict",
                    "reason": reason_name,
                    "current": current,
                })
            );
        }

        let failed = SaveError::Failed("disk full".into());
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({ "kind": "failed", "message": "disk full" })
        );
    }

    #[test]
    fn an_unknown_expected_revision_never_authorises_a_write() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"baseline\n").unwrap();

        for expected in [
            "not-a-revision".to_string(),
            format!("r1:{}:8:0-0", "00".repeat(32)),
        ] {
            match save(&target, b"mine\n", Some(&expected)).unwrap_err() {
                SaveError::Conflict(conflict) => {
                    assert_eq!(conflict.reason, ConflictReason::Changed)
                }
                other => panic!("expected a conflict, got {other:?}"),
            }
            assert_eq!(std::fs::read(&target).unwrap(), b"baseline\n");
        }
    }

    #[test]
    fn overwrites_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.txt");
        std::fs::write(&target, b"old").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"new");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_legacy_staging_symlink() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, b"untouched").unwrap();

        let target = dir.path().join("note.txt");
        // Pre-stage a symlink at the legacy deterministic staging path.
        let legacy = dir.path().join(".note.txt.terax.tmp");
        symlink(&outside, &legacy).unwrap();

        write_atomic(&target, b"payload").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"payload");
        // The pre-staged symlink target must not have been written through.
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
    }

    /// The app-lab stale-typing step relies on a bounded, opt-in delay. Garbage or an unset
    /// variable must mean "no delay", or a release build would inherit a runtime knob it does
    /// not have.
    #[cfg(feature = "bench")]
    #[test]
    fn bench_delay_is_bounded_and_ignores_garbage() {
        assert_eq!(bench_delay_ms(None), 0);
        assert_eq!(bench_delay_ms(Some("")), 0);
        assert_eq!(bench_delay_ms(Some("nope")), 0);
        assert_eq!(bench_delay_ms(Some("0")), 0);
        assert_eq!(bench_delay_ms(Some("800")), 800);
        assert_eq!(bench_delay_ms(Some(" 1200 ")), 1200);
        assert_eq!(bench_delay_ms(Some("999999")), 10_000);
    }
}

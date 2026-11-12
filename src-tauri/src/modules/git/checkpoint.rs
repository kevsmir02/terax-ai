//! Per-agent-turn checkpoints. A checkpoint is a commit object reachable only
//! from `refs/<namespace>/checkpoints/<task>/<turn>`, built from a private copy of
//! the index, so the user's index, HEAD, branches and working files are never
//! touched by creating one. Restoring does write the working tree (and syncs the
//! index entries of the files it changed), but only the paths that differ.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::modules::git::diff::{parse_raw_numstat_z, DiffFileSummary, FileStatus};
use crate::modules::git::errors::{GitError, Result};
use crate::modules::git::plumbing::{
    empty_tree, git_dir, head_commit_opt, lock_for_repo, open_worktree, os_args, run, run_ok,
    stdout_text, verify_tree,
};
use crate::modules::git::process::{ensure_success, run_git_with, RunOptions};
use crate::modules::git::refs;
use crate::modules::git::types::{GitOutput, NETWORK_TIMEOUT_SECS};
use crate::modules::git::utils::ResolvedGitDirectory;
use crate::modules::workspace::{WorkspaceEnv, WorkspaceRegistry};

/// Snapshot passes before giving up on a quiet moment. Each extra pass costs a
/// stat walk, not a rehash, because the private index already knows every file.
const MAX_PASSES: u32 = 3;
/// Extra attempts per pass on top of one per excluded file.
const ADD_ATTEMPTS: u32 = 3;
const MAX_UNSTABLE_FILES: usize = 50;
const INDEX_SYNC_CHUNK: usize = 100;
const MAX_DIRTY_REPORTED: usize = 200;
const SNAPSHOT_TIMEOUT_SECS: u64 = NETWORK_TIMEOUT_SECS;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

const WORKTREE_ID_FILE: &str = "terax-worktree-id";
const LAST_RESTORE_FILE: &str = "terax-last-restore";
const NO_HOOKS_DIR: &str = "terax-no-hooks";

static ID_LOCK: Mutex<()> = Mutex::new(());

/// A worktree's private git directory (`.git`, or `.git/worktrees/<name>`) and
/// what checkpoints keep in it: an empty hooks directory, the worktree's random
/// id and the marker of the last restore. It moves with the worktree, so
/// renaming or moving the directory does not orphan anything.
struct Admin {
    dir: PathBuf,
    hooks: PathBuf,
}

fn is_valid_worktree_id(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

impl Admin {
    fn new(repo: &ResolvedGitDirectory) -> Result<Self> {
        let dir = git_dir(repo)?;
        let hooks = dir.join(NO_HOOKS_DIR);
        Ok(Self { dir, hooks })
    }

    /// `args` behind the plumbing config (see `plumbing_config`); makes sure the
    /// empty hooks directory exists.
    fn plumb(&self, args: Vec<OsString>) -> Result<Vec<OsString>> {
        std::fs::create_dir_all(&self.hooks)?;
        Ok(with_plumbing_config(&self.hooks, args))
    }

    /// The id, if this worktree ever made a checkpoint. Reading never writes.
    fn existing_worktree_id(&self) -> Option<String> {
        std::fs::read_to_string(self.dir.join(WORKTREE_ID_FILE))
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| is_valid_worktree_id(t))
    }

    /// The id every checkpoint of this worktree is stamped with, created once
    /// from the system's random source and kept in the git directory.
    fn worktree_id(&self) -> Result<String> {
        let read = || self.existing_worktree_id();
        if let Some(id) = read() {
            return Ok(id);
        }
        let _guard = ID_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(id) = read() {
            return Ok(id);
        }
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)
            .map_err(|e| GitError::command("git checkpoint", format!("no random source: {e}")))?;
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        publish_worktree_id(&self.dir, &id, &|from, to| std::fs::hard_link(from, to))?;
        read().ok_or_else(|| GitError::command("git checkpoint", "could not record the worktree id"))
    }
}

/// Writes `id` to the worktree-id file without ever replacing an existing one.
/// The preferred way is to write the id whole under a temporary name and hard
/// link it into place, so a reader never sees half an id. File systems without
/// hard links (FAT32, exFAT, some network mounts) fall back to creating the
/// final file exclusively; a reader that catches it half written rejects it,
/// because a valid id is exactly 32 hex digits, and a lost race is not an error
/// either way.
fn publish_worktree_id(
    dir: &Path,
    id: &str,
    link: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    use std::io::Write;
    let path = dir.join(WORKTREE_ID_FILE);
    let staging = dir.join(format!("{WORKTREE_ID_FILE}.{id}"));
    std::fs::write(&staging, id)?;
    let linked = link(&staging, &path);
    let _ = std::fs::remove_file(&staging);
    match linked {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => file.write_all(id.as_bytes()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(e),
        },
    }
}

/// Gives the private copy of the index the real one's modification time.
///
/// Git trusts an entry's cached stat data only if the entry is older than the
/// index file itself ("racy git"): a file rewritten within the timestamp
/// granularity of the moment it was indexed, with the same size, looks unchanged
/// otherwise. A plain copy carries a fresh mtime and would hide exactly those
/// edits. The copy of a read-only index is read-only too, so it is made
/// owner-writable first (only that bit: never group or world).
fn keep_modification_time(real: &Path, copy: &Path) -> std::io::Result<()> {
    let modified = std::fs::metadata(real)?.modified()?;
    make_owner_writable(copy)?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(copy)?
        .set_modified(modified)
}

#[cfg(unix)]
fn make_owner_writable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o200);
    std::fs::set_permissions(path, permissions)
}

#[cfg(windows)]
#[allow(
    clippy::permissions_set_readonly_false,
    reason = "on Windows this only clears FILE_ATTRIBUTE_READONLY of our own private copy"
)]
fn make_owner_writable(path: &Path) -> std::io::Result<()> {
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(path, permissions)
}

#[cfg(not(any(unix, windows)))]
fn make_owner_writable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// A throwaway index file inside the git directory, removed on drop.
struct TempIndex {
    path: PathBuf,
    hooks: PathBuf,
}

impl TempIndex {
    /// Seeds the copy from the real index when there is one, so unchanged files
    /// are recognized by their cached stat data and never rehashed.
    fn seeded(repo: &ResolvedGitDirectory) -> Result<Self> {
        let admin = Admin::new(repo)?;
        std::fs::create_dir_all(&admin.hooks)?;
        let dir = admin.dir;
        let unique = format!(
            "terax-snapshot-{}-{}-{}.index",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        // Built before anything can fail, so `Drop` removes the copy on every path.
        let temp = Self {
            path: dir.join(unique),
            hooks: admin.hooks,
        };
        let real = dir.join("index");
        if real.is_file() {
            std::fs::copy(&real, &temp.path)?;
            if keep_modification_time(&real, &temp.path).is_err() {
                // A copy that cannot be dated like the original would hide edits
                // (see `keep_modification_time`). An index that knows nothing is
                // slower, since every file is read again, but exact.
                let _ = std::fs::remove_file(&temp.path);
            }
        }
        Ok(temp)
    }

    fn empty(repo: &ResolvedGitDirectory) -> Result<Self> {
        let temp = Self::seeded(repo)?;
        let _ = std::fs::remove_file(&temp.path);
        Ok(temp)
    }

    fn options(&self, stdin: Option<Vec<u8>>) -> RunOptions {
        RunOptions {
            env: vec![(
                OsString::from("GIT_INDEX_FILE"),
                crate::modules::git::utils::git_arg(&self.path),
            )],
            stdin,
            stdout_cap: 0,
        }
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(PathBuf::from(lock));
    }
}

/// Config for every plumbing call a checkpoint makes: no filesystem-monitor
/// daemon is started or consulted, no hook of the user's can run (`hooks` is a
/// real, empty directory, which every platform resolves the same way), and a
/// file with mixed line endings is snapshotted instead of failing
/// `core.safecrlf`.
pub fn plumbing_config(hooks: &Path) -> Vec<OsString> {
    let mut hooks_arg = OsString::from("core.hooksPath=");
    hooks_arg.push(crate::modules::git::utils::git_arg(hooks));
    let mut args = os_args(["-c", "core.fsmonitor=false", "-c"]);
    args.push(hooks_arg);
    args.extend(os_args(["-c", "core.safecrlf=false"]));
    args
}

fn with_plumbing_config(hooks: &Path, args: Vec<OsString>) -> Vec<OsString> {
    let mut full = plumbing_config(hooks);
    full.extend(args);
    full
}

/// The modification time of a freshly seeded private index (test hook).
#[cfg(test)]
pub(crate) fn seeded_index_mtime_for_tests(
    repo: &ResolvedGitDirectory,
) -> Result<std::time::SystemTime> {
    let temp = TempIndex::seeded(repo)?;
    Ok(std::fs::metadata(&temp.path)?.modified()?)
}

fn run_indexed(
    repo: &ResolvedGitDirectory,
    temp: &TempIndex,
    args: Vec<OsString>,
    stdin: Option<Vec<u8>>,
) -> Result<GitOutput> {
    run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        with_plumbing_config(&temp.hooks, args),
        SNAPSHOT_TIMEOUT_SECS,
        temp.options(stdin),
    )
}

#[derive(Debug)]
pub struct Snapshot {
    pub tree: String,
    pub consistent: bool,
    pub passes: u32,
    pub warnings: Vec<String>,
    /// Files that kept disappearing under the snapshot and were left out; for a
    /// tracked file the index's version is recorded instead.
    pub unstable_paths: Vec<String>,
}

fn ensure_supported(repo: &ResolvedGitDirectory) -> Result<()> {
    if repo.workspace.is_wsl() {
        return Err(GitError::Unsupported(
            "checkpoints are not supported in WSL workspaces yet",
        ));
    }
    Ok(())
}

fn warn(warnings: &mut Vec<String>, code: &str) {
    if !warnings.iter().any(|w| w == code) {
        warnings.push(code.to_string());
    }
}

/// The file git reports it could not `stat`: it was listed by the directory
/// walk and gone (or being replaced) by the time git looked, i.e. an agent
/// writing while we snapshot.
pub fn vanished_path(stderr: &str) -> Option<String> {
    let line = stderr.lines().find(|l| l.contains("unable to stat '"))?;
    let rest = line.split_once("unable to stat '")?.1;
    let end = rest.rfind("': ")?;
    Some(rest[..end].to_string())
}

/// Files `git add --ignore-errors` reported as unreadable or changing mid-read.
pub fn unindexed_paths(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("error: unable to index file '")?;
            Some(rest.strip_suffix('\'')?.to_string())
        })
        .collect()
}

/// One `git add -A` pass over the private index. A file that vanishes aborts
/// git's whole pass (the index is left unwritten, so a retry starts clean);
/// the pass is retried with that file excluded and the file is reported in
/// `unstable` rather than failing the snapshot.
fn add_everything(
    repo: &ResolvedGitDirectory,
    temp: &TempIndex,
    warnings: &mut Vec<String>,
    unstable: &mut Vec<String>,
    excluded: &[String],
) -> Result<()> {
    for attempt in 1..=(ADD_ATTEMPTS + MAX_UNSTABLE_FILES as u32) {
        let mut args = os_args(["add", "-A", "--ignore-errors", "--", "."]);
        args.extend(
            unstable
                .iter()
                .chain(excluded)
                .map(|path| OsString::from(format!(":(exclude,literal){path}"))),
        );
        let output = run_indexed(repo, temp, args, None)?;
        if output.timed_out {
            return Err(GitError::TimedOut("git add"));
        }
        if output.exit_code == Some(0) {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if !stderr.contains("fatal:") && stderr.contains("unable to index file") {
            // `--ignore-errors`: files that could not be read are skipped, the
            // rest was added and the index written; git only exits non-zero.
            warn(warnings, "unreadable-files");
            for path in unindexed_paths(&stderr) {
                if unstable.len() < MAX_UNSTABLE_FILES && !unstable.contains(&path) {
                    unstable.push(path);
                }
            }
            return Ok(());
        }
        if let Some(path) = vanished_path(&stderr) {
            if unstable.len() < MAX_UNSTABLE_FILES && !unstable.contains(&path) {
                warn(warnings, "unstable-files-skipped");
                unstable.push(path);
                std::thread::sleep(std::time::Duration::from_millis(
                    u64::from(attempt.min(5)) * 5,
                ));
                continue;
            }
        }
        return ensure_success(&output, "git add failed");
    }
    Err(GitError::command(
        "git add failed",
        "the working tree kept changing during the snapshot",
    ))
}

fn write_tree(repo: &ResolvedGitDirectory, temp: &TempIndex) -> Result<String> {
    let output = run_indexed(repo, temp, os_args(["write-tree"]), None)?;
    ensure_success(&output, "git write-tree failed")?;
    Ok(stdout_text(&output))
}

/// Freezes the working tree (tracked files plus untracked, non-ignored ones)
/// into a tree object without touching the real index. With `verify`, the
/// snapshot is repeated until two consecutive passes agree or `MAX_PASSES` is
/// reached; `consistent` reports whether they did.
pub fn snapshot_tree(repo: &ResolvedGitDirectory, verify: bool) -> Result<Snapshot> {
    ensure_supported(repo)?;
    let temp = TempIndex::seeded(repo)?;
    snapshot_index(repo, verify, &temp, &[])
}

fn snapshot_index(
    repo: &ResolvedGitDirectory,
    verify: bool,
    temp: &TempIndex,
    excluded: &[String],
) -> Result<Snapshot> {
    let mut warnings = Vec::new();
    let mut unstable = Vec::new();
    add_everything(repo, temp, &mut warnings, &mut unstable, excluded)?;
    let mut tree = write_tree(repo, temp)?;
    let mut passes = 1;
    let mut consistent = false;
    while verify && passes < MAX_PASSES {
        add_everything(repo, temp, &mut warnings, &mut unstable, excluded)?;
        let again = write_tree(repo, temp)?;
        passes += 1;
        if again == tree {
            consistent = true;
            break;
        }
        tree = again;
    }
    if verify && !consistent {
        warn(&mut warnings, "concurrent-writes");
    }
    Ok(Snapshot {
        tree,
        consistent,
        passes,
        warnings,
        unstable_paths: unstable,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub task_id: String,
    pub turn: u32,
    pub commit: String,
    pub tree: String,
    /// HEAD when the checkpoint was taken; `None` for an unborn branch.
    pub parent: Option<String>,
    pub created_at_secs: i64,
    /// The worktree that made it (not sent to the frontend).
    #[serde(skip)]
    pub worktree_id: Option<String>,
}

/// What a checkpoint does and does not capture, stated in the result so the UI
/// never has to assume.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointLimits {
    /// The snapshot is not atomic: files written while it runs may be mixed.
    pub atomic: bool,
    pub captures_ignored_files: bool,
    /// Submodules are recorded as their commit pointer only.
    pub captures_submodule_contents: bool,
    /// Restoring puts files back; what was staged is not recorded.
    pub captures_index_state: bool,
}

const LIMITS: CheckpointLimits = CheckpointLimits {
    atomic: false,
    captures_ignored_files: false,
    captures_submodule_contents: false,
    captures_index_state: false,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCreated {
    #[serde(flatten)]
    pub info: CheckpointInfo,
    /// Two consecutive snapshot passes produced the same tree.
    pub consistent: bool,
    pub passes: u32,
    pub warnings: Vec<String>,
    pub unstable_paths: Vec<String>,
    pub limits: CheckpointLimits,
    pub duration_ms: u64,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A commit object for `tree` (no ref, no HEAD movement, never signed, a fixed
/// identity so a missing `user.name` cannot fail it).
fn write_commit(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
    tree: &str,
    parent: Option<&str>,
    message: &str,
) -> Result<String> {
    let mut args = os_args(["-c", "commit.gpgsign=false", "commit-tree", tree]);
    if let Some(parent) = parent {
        args.extend(os_args(["-p", parent]));
    }
    args.extend(os_args(["-m", message]));
    let output = run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        admin.plumb(args)?,
        crate::modules::git::types::DEFAULT_TIMEOUT_SECS,
        RunOptions {
            env: ["AUTHOR", "COMMITTER"]
                .iter()
                .flat_map(|who| {
                    [
                        (
                            OsString::from(format!("GIT_{who}_NAME")),
                            OsString::from("Terax"),
                        ),
                        (
                            OsString::from(format!("GIT_{who}_EMAIL")),
                            OsString::from("terax@localhost"),
                        ),
                    ]
                })
                .collect(),
            ..Default::default()
        },
    )?;
    ensure_success(&output, "git commit-tree failed")?;
    Ok(stdout_text(&output))
}

fn prepare_archive_index(repo: &ResolvedGitDirectory, temp: &TempIndex) -> Result<()> {
    let listing = run_indexed(
        repo,
        temp,
        os_args(["ls-files", "--stage", "-v", "-z"]),
        None,
    )?;
    ensure_success(&listing, "task archive index scan failed")?;
    if listing.truncated {
        return Err(GitError::command(
            "task archive",
            "index scan was truncated",
        ));
    }
    let mut assumed = Vec::new();
    for record in listing.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let path = record
            .splitn(2, |b| *b == b'\t')
            .nth(1)
            .ok_or_else(|| GitError::command("task archive", "invalid index record"))?;
        if matches!(record.first(), Some(b'S' | b's')) {
            return Err(GitError::command(
                "task archive",
                "skip-worktree entries must be materialized before archiving",
            ));
        }
        if record.get(2..8) == Some(b"160000") {
            let relative = std::str::from_utf8(path)
                .map_err(|_| GitError::command("task archive", "non-UTF-8 submodule path"))?;
            let directory = super::utils::resolve_within_repo(&repo.local_path, relative)?;
            if directory.is_dir() && std::fs::read_dir(&directory)?.next().is_some() {
                return Err(GitError::command("task archive", format!("submodule {relative} contains data that the task snapshot cannot preserve; deinitialize it after saving its work")));
            }
        }
        if record.first().is_some_and(u8::is_ascii_lowercase) {
            assumed.extend_from_slice(path);
            assumed.push(0);
        }
    }
    if !assumed.is_empty() {
        let output = run_indexed(
            repo,
            temp,
            os_args(["update-index", "--no-assume-unchanged", "-z", "--stdin"]),
            Some(assumed),
        )?;
        ensure_success(&output, "task archive index flags failed")?;
    }
    Ok(())
}

pub(crate) fn task_snapshot(
    repo: &ResolvedGitDirectory,
    id: &str,
    excluded: &[String],
) -> Result<super::task_state::TaskSnapshot> {
    let temp = TempIndex::seeded(repo)?;
    prepare_archive_index(repo, &temp)?;
    let mut excluded = excluded.to_vec();
    if !excluded.is_empty() {
        let input = excluded
            .iter()
            .flat_map(|p| p.bytes().chain(std::iter::once(0)))
            .collect();
        let ignored = run_indexed(
            repo,
            &temp,
            os_args(["check-ignore", "--stdin", "-z"]),
            Some(input),
        )?;
        if ignored.timed_out || ignored.truncated || !matches!(ignored.exit_code, Some(0 | 1)) {
            return Err(GitError::command(
                "task archive",
                "shared-link ignore check failed",
            ));
        }
        // An exclusion below an ignored directory makes git add treat that directory as explicit.
        excluded.retain(|p| !ignored.stdout.split(|b| *b == 0).any(|b| b == p.as_bytes()));
    }
    let snapshot = snapshot_index(repo, true, &temp, &excluded)?;
    prepare_archive_index(repo, &temp)?;
    if !snapshot.consistent || !snapshot.unstable_paths.is_empty() || !snapshot.warnings.is_empty()
    {
        return Err(GitError::command(
            "task archive",
            "could not capture a complete, stable snapshot; stop writers and retry",
        ));
    }
    let parent = super::plumbing::resolve_commit(repo, "HEAD")?;
    let admin = Admin::new(repo)?;
    let commit = write_commit(
        repo,
        &admin,
        &snapshot.tree,
        Some(&parent),
        "task archive snapshot",
    )?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|e| GitError::command("task snapshot", e.to_string()))?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let reference = format!("{}{suffix}", refs::task_archive_prefix(id));
    run_ok(
        repo,
        admin.plumb(os_args(["update-ref", &reference, &commit, ""]))?,
        "git update-ref failed",
    )?;
    Ok(super::task_state::TaskSnapshot {
        reference,
        commit,
        parent,
        captures_ignored_files: false,
    })
}

pub fn create(
    registry: &WorkspaceRegistry,
    worktree: &str,
    task_id: &str,
    turn: u32,
    workspace: &WorkspaceEnv,
) -> Result<CheckpointCreated> {
    if !refs::is_valid_task_id(task_id) {
        return Err(GitError::InvalidRef(task_id.to_string()));
    }
    let started = Instant::now();
    let repo = open_worktree(registry, worktree, workspace)?;
    ensure_supported(&repo)?;
    let admin = Admin::new(&repo)?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    let name = refs::checkpoint_ref(task_id, turn);
    let mine = admin.worktree_id()?;
    // A task id reused by another worktree must not overwrite its checkpoints.
    let taken = list_records(&repo, task_id)?
        .into_iter()
        .any(|r| r.name == name && r.worktree_id.as_deref() != Some(mine.as_str()));
    if taken {
        return Err(GitError::command(
            "git checkpoint create",
            "that checkpoint belongs to another worktree",
        ));
    }

    let mut snapshot = snapshot_tree(&repo, true)?;
    let parent = head_commit_opt(&repo)?;
    let message = format!("terax checkpoint {task_id}/{turn}{WORKTREE_MARK}{mine}");
    let commit = write_commit(&repo, &admin, &snapshot.tree, parent.as_deref(), &message)?;
    run_ok(
        &repo,
        admin.plumb(os_args(["update-ref", name.as_str(), commit.as_str()]))?,
        "git update-ref failed",
    )?;
    // The newest checkpoint is now what the worktree is measured against.
    clear_last_restore(&admin);

    Ok(CheckpointCreated {
        info: CheckpointInfo {
            ref_name: name,
            task_id: task_id.to_string(),
            turn,
            commit,
            tree: snapshot.tree,
            parent,
            created_at_secs: now_secs(),
            worktree_id: None,
        },
        consistent: snapshot.consistent,
        passes: snapshot.passes,
        warnings: std::mem::take(&mut snapshot.warnings),
        unstable_paths: std::mem::take(&mut snapshot.unstable_paths),
        limits: LIMITS,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

const LIST_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(tree)%00%(parent)%00%(committerdate:unix)%00%(contents:subject)";

/// Every checkpoint ref's commit message ends with the id of the worktree that
/// made it, because refs live in the repository shared by all its worktrees:
/// only the owner may list, restore or prune them.
const WORKTREE_MARK: &str = " wt:";

/// What the worktree is expected to look like right after a restore: the
/// restored checkpoint's tree. Kept in the worktree's git directory until the
/// next checkpoint is made (which replaces it as the baseline).
struct LastRestore {
    task_id: String,
    ref_name: String,
    tree: String,
}

fn read_last_restore(admin: &Admin) -> Option<LastRestore> {
    let text = std::fs::read_to_string(admin.dir.join(LAST_RESTORE_FILE)).ok()?;
    let mut lines = text.lines();
    let task_id = lines.next()?.to_string();
    let ref_name = lines.next()?.to_string();
    let tree = lines.next()?.to_string();
    (refs::is_valid_task_id(&task_id) && refs::parse_restore_source(&ref_name).is_some()).then_some(
        LastRestore {
            task_id,
            ref_name,
            tree,
        },
    )
}

fn write_last_restore(admin: &Admin, task_id: &str, ref_name: &str, tree: &str) {
    let _ = std::fs::write(
        admin.dir.join(LAST_RESTORE_FILE),
        format!("{task_id}\n{ref_name}\n{tree}\n"),
    );
}

fn clear_last_restore(admin: &Admin) {
    let _ = std::fs::remove_file(admin.dir.join(LAST_RESTORE_FILE));
}

/// The worktree id a checkpoint commit subject ends with.
pub fn subject_worktree_id(subject: &str) -> Option<&str> {
    let id = subject.rsplit_once(WORKTREE_MARK)?.1.trim();
    (!id.is_empty()).then_some(id)
}

/// One line of `for-each-ref` output in `LIST_FORMAT`.
struct RefRecord {
    name: String,
    commit: String,
    tree: String,
    parent: Option<String>,
    created_at_secs: i64,
    subject: String,
    worktree_id: Option<String>,
}

fn parse_ref_records(output: &[u8]) -> Vec<RefRecord> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let name = fields.next()?.to_string();
            let commit = fields.next()?.to_string();
            let tree = fields.next()?.to_string();
            let parent = fields.next()?.split_whitespace().next().map(str::to_string);
            let created_at_secs = fields.next()?.parse().unwrap_or(0);
            let subject = fields.next().unwrap_or("");
            Some(RefRecord {
                name,
                commit,
                tree,
                parent,
                created_at_secs,
                subject: subject.to_string(),
                worktree_id: subject_worktree_id(subject).map(str::to_string),
            })
        })
        .collect()
}

fn info_of(record: RefRecord) -> Option<CheckpointInfo> {
    let (task, turn) = refs::parse_checkpoint_ref(&record.name)?;
    Some(CheckpointInfo {
        task_id: task.to_string(),
        turn,
        ref_name: record.name,
        commit: record.commit,
        tree: record.tree,
        parent: record.parent,
        created_at_secs: record.created_at_secs,
        worktree_id: record.worktree_id,
    })
}

/// Parses `for-each-ref` output in `LIST_FORMAT`: the turn checkpoints, ordered
/// by turn (safety snapshots are not turns and are left out).
pub fn parse_checkpoint_list(output: &[u8]) -> Vec<CheckpointInfo> {
    let mut infos: Vec<CheckpointInfo> = parse_ref_records(output)
        .into_iter()
        .filter_map(info_of)
        .collect();
    infos.sort_by_key(|info| info.turn);
    infos
}

fn list_records(repo: &ResolvedGitDirectory, task_id: &str) -> Result<Vec<RefRecord>> {
    let prefix = refs::checkpoint_task_prefix(task_id);
    let output = run_ok(
        repo,
        os_args(["for-each-ref", LIST_FORMAT, prefix.as_str()]),
        "git for-each-ref failed",
    )?;
    Ok(parse_ref_records(&output.stdout))
}

/// This worktree's turn checkpoints of `task_id`, ordered by turn.
fn list_for(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
    task_id: &str,
) -> Result<Vec<CheckpointInfo>> {
    // A worktree that never made a checkpoint has no id and owns nothing.
    let Some(mine) = admin.existing_worktree_id() else {
        return Ok(Vec::new());
    };
    let mut infos: Vec<CheckpointInfo> = list_records(repo, task_id)?
        .into_iter()
        .filter(|r| r.worktree_id.as_deref() == Some(mine.as_str()))
        .filter_map(info_of)
        .collect();
    infos.sort_by_key(|info| info.turn);
    Ok(infos)
}

pub fn list(
    registry: &WorkspaceRegistry,
    worktree: &str,
    task_id: &str,
    workspace: &WorkspaceEnv,
) -> Result<Vec<CheckpointInfo>> {
    if !refs::is_valid_task_id(task_id) {
        return Err(GitError::InvalidRef(task_id.to_string()));
    }
    let repo = open_worktree(registry, worktree, workspace)?;
    list_for(&repo, &Admin::new(&repo)?, task_id)
}

pub fn prune(
    registry: &WorkspaceRegistry,
    worktree: &str,
    task_id: &str,
    workspace: &WorkspaceEnv,
) -> Result<u32> {
    if !refs::is_valid_task_id(task_id) {
        return Err(GitError::InvalidRef(task_id.to_string()));
    }
    let repo = open_worktree(registry, worktree, workspace)?;
    let admin = Admin::new(&repo)?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    // Turn checkpoints and the safety snapshots of restores, this worktree's
    // only: another worktree may use the same task id.
    let Some(mine) = admin.existing_worktree_id() else {
        return Ok(0);
    };
    let names: Vec<String> = list_records(&repo, task_id)?
        .into_iter()
        .filter(|r| r.worktree_id.as_deref() == Some(mine.as_str()))
        .map(|r| r.name)
        .collect();
    if names.is_empty() {
        return Ok(0);
    }
    let mut script = String::new();
    for name in &names {
        script.push_str("delete ");
        script.push_str(name);
        script.push('\n');
    }
    let output = run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        admin.plumb(os_args(["update-ref", "--stdin"]))?,
        crate::modules::git::types::DEFAULT_TIMEOUT_SECS,
        RunOptions {
            stdin: Some(script.into_bytes()),
            ..Default::default()
        },
    )?;
    ensure_success(&output, "git update-ref failed")?;
    clear_last_restore(&admin);
    Ok(names.len() as u32)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedPath {
    pub path: String,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreRefusal {
    /// Files changed since the latest checkpoint, or since the last restore
    /// when that is newer; restoring would lose them.
    ChangedSinceLatest,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: bool,
    pub refusal: Option<RestoreRefusal>,
    pub latest_ref: Option<String>,
    /// What the working tree was compared against: the last restore's target
    /// when a restore happened after the latest checkpoint, else `latest_ref`.
    pub baseline_ref: Option<String>,
    /// Files that differ between the working tree and the baseline (capped at
    /// `MAX_DIRTY_REPORTED`).
    pub dirty: Vec<ChangedPath>,
    pub dirty_total: u32,
    pub written: u32,
    pub removed: u32,
    pub skipped: Vec<Skipped>,
    /// HEAD is not where it was when the checkpoint was taken (the agent
    /// committed, or switched branches). Commits are left alone.
    pub head_moved: bool,
    /// Index entries of the touched paths were reset to HEAD.
    pub index_synced: bool,
    pub consistent: bool,
    /// Files that kept changing under the pre-restore snapshot and were left
    /// out of it.
    pub unstable_paths: Vec<String>,
    /// The working tree as it was before this restore, kept under a ref so the
    /// restore can be undone by restoring this ref. Present whenever the
    /// restore could drop work that no checkpoint holds.
    pub safety: Option<SafetySnapshot>,
    pub atomic: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafetySnapshot {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub commit: String,
    pub tree: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Records `tree` (the working tree about to be overwritten) under a fresh
/// `refs/<namespace>/checkpoints/<task>/prerestore-<millis>` ref. An existing ref is
/// never replaced.
fn write_safety_snapshot(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
    task_id: &str,
    tree: &str,
    parent: Option<&str>,
    worktree: &str,
) -> Result<SafetySnapshot> {
    let message = format!("terax prerestore {task_id}{WORKTREE_MARK}{worktree}");
    let commit = write_commit(repo, admin, tree, parent, &message)?;
    for millis in (now_millis()..).take(50) {
        let name = refs::prerestore_ref(task_id, millis);
        // An empty old value makes update-ref fail if the ref already exists.
        let output = run(
            repo,
            admin.plumb(os_args(["update-ref", name.as_str(), commit.as_str(), ""]))?,
        )?;
        if output.exit_code == Some(0) {
            return Ok(SafetySnapshot {
                ref_name: name,
                commit,
                tree: tree.to_string(),
            });
        }
    }
    Err(GitError::command(
        "git update-ref failed",
        "could not create the pre-restore safety ref",
    ))
}

fn tree_of(repo: &ResolvedGitDirectory, commit: &str) -> Result<String> {
    let output = run_ok(
        repo,
        os_args(["rev-parse", "--verify", &format!("{commit}^{{tree}}")]),
        "git rev-parse failed",
    )?;
    Ok(stdout_text(&output))
}

fn diff_trees(repo: &ResolvedGitDirectory, a: &str, b: &str) -> Result<Vec<DiffFileSummary>> {
    let output = run_ok(
        repo,
        os_args(["diff-tree", "-r", "-z", "--no-renames", a, b]),
        "git diff-tree failed",
    )?;
    Ok(parse_raw_numstat_z(&output.stdout))
}

/// A path that may be written or removed during a restore: relative, no `..`,
/// nothing inside `.git`, no NUL or control characters.
pub fn is_safe_restore_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.chars().any(|c| c.is_control())
        && !path.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
        })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RestorePlan {
    pub writes: Vec<String>,
    pub deletes: Vec<String>,
    pub skipped: Vec<Skipped>,
}

/// `changes` is the diff from the current tree to the checkpoint tree: what is
/// `Added` exists only in the checkpoint (write it), `Deleted` only now (remove
/// it).
pub fn plan_restore(changes: &[DiffFileSummary]) -> RestorePlan {
    let mut plan = RestorePlan::default();
    for change in changes {
        let skip = |reason: &str| Skipped {
            path: change.path.clone(),
            reason: reason.to_string(),
        };
        if !is_safe_restore_path(&change.path) {
            plan.skipped.push(skip("unsafe-path"));
            continue;
        }
        if change.submodule {
            plan.skipped.push(skip("submodule"));
            continue;
        }
        match change.status {
            FileStatus::Added | FileStatus::Modified => plan.writes.push(change.path.clone()),
            FileStatus::Deleted => plan.deletes.push(change.path.clone()),
            FileStatus::TypeChanged => {
                plan.deletes.push(change.path.clone());
                plan.writes.push(change.path.clone());
            }
            _ => plan.skipped.push(skip("unsupported-change")),
        }
    }
    plan
}

/// Removes a file or symlink without following symlinks in its parent chain,
/// then prunes directories that became empty. `Ok(false)` when already gone.
fn remove_tracked_path(root: &Path, rel: &str) -> std::result::Result<bool, String> {
    let full = root.join(rel);
    let Some(parent) = full.parent() else {
        return Err("no parent".into());
    };
    let canonical_parent = match std::fs::canonicalize(parent) {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if !canonical_parent.starts_with(root) {
        return Err("outside-worktree".into());
    }
    match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_dir() => return Err("is-directory".into()),
        Ok(_) => std::fs::remove_file(&full).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    }
    let mut dir = full.parent().map(Path::to_path_buf);
    while let Some(current) = dir {
        if current == root || !current.starts_with(root) || std::fs::remove_dir(&current).is_err() {
            break;
        }
        dir = current.parent().map(Path::to_path_buf);
    }
    Ok(true)
}

fn sync_index_to_head(repo: &ResolvedGitDirectory, admin: &Admin, paths: &[String]) -> bool {
    let has_head = matches!(head_commit_opt(repo), Ok(Some(_)));
    for chunk in paths.chunks(INDEX_SYNC_CHUNK) {
        let mut args = if has_head {
            os_args(["--literal-pathspecs", "reset", "-q", "HEAD", "--"])
        } else {
            os_args([
                "--literal-pathspecs",
                "rm",
                "--cached",
                "-q",
                "-r",
                "--ignore-unmatch",
                "--",
            ])
        };
        args.extend(os_args(chunk));
        let Ok(args) = admin.plumb(args) else {
            return false;
        };
        match run(repo, args) {
            Ok(output) if output.exit_code == Some(0) => {}
            _ => return false,
        }
    }
    true
}

pub fn restore(
    registry: &WorkspaceRegistry,
    worktree: &str,
    reference: &str,
    force: bool,
    workspace: &WorkspaceEnv,
) -> Result<RestoreReport> {
    let Some(task_id) = refs::parse_restore_source(reference) else {
        return Err(GitError::InvalidRef(reference.to_string()));
    };
    let repo = open_worktree(registry, worktree, workspace)?;
    ensure_supported(&repo)?;
    let admin = Admin::new(&repo)?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());

    // The refs are shared by every worktree of the repository; only a
    // checkpoint this worktree made may be restored into it.
    let mine = admin.existing_worktree_id().ok_or_else(|| {
        GitError::command(
            "git checkpoint restore",
            "no such checkpoint for this worktree",
        )
    })?;
    let target = list_records(&repo, task_id)?
        .into_iter()
        .find(|r| r.name == reference && r.worktree_id.as_deref() == Some(mine.as_str()))
        .ok_or_else(|| {
            GitError::command(
                "git checkpoint restore",
                "no such checkpoint for this worktree",
            )
        })?;
    let target_tree = tree_of(&repo, &target.commit)?;
    let latest = list_for(&repo, &admin, task_id)?.pop();
    let target_parent = target.parent.clone();

    // What the worktree should look like if nobody touched it since: the tree
    // the last restore wrote when that happened after the latest checkpoint
    // (making a checkpoint clears the marker), otherwise the latest checkpoint.
    // Without this, restoring forward (turn 1, then turn 2) would always count
    // the first restore itself as a change.
    let after_restore = read_last_restore(&admin)
        .filter(|r| r.task_id == task_id && verify_tree(&repo, &r.tree).is_ok());
    let (baseline_tree, baseline_ref) = match (&after_restore, &latest) {
        (Some(restore), _) => (Some(restore.tree.clone()), Some(restore.ref_name.clone())),
        (None, Some(latest)) => (Some(latest.tree.clone()), Some(latest.ref_name.clone())),
        (None, None) => (None, None),
    };

    let snapshot = snapshot_tree(&repo, true)?;
    let mut report = RestoreReport {
        restored: false,
        refusal: None,
        latest_ref: latest.as_ref().map(|l| l.ref_name.clone()),
        baseline_ref,
        dirty: Vec::new(),
        dirty_total: 0,
        written: 0,
        removed: 0,
        skipped: Vec::new(),
        head_moved: head_commit_opt(&repo)? != target_parent,
        index_synced: true,
        consistent: snapshot.consistent,
        unstable_paths: snapshot.unstable_paths.clone(),
        safety: None,
        atomic: false,
    };

    if !force {
        if let Some(baseline) = &baseline_tree {
            let dirty = diff_trees(&repo, baseline, &snapshot.tree)?;
            if !dirty.is_empty() {
                report.dirty_total = dirty.len() as u32;
                report.dirty = dirty
                    .into_iter()
                    .take(MAX_DIRTY_REPORTED)
                    .map(|d| ChangedPath {
                        path: d.path,
                        status: d.status,
                    })
                    .collect();
                report.refusal = Some(RestoreRefusal::ChangedSinceLatest);
                return Ok(report);
            }
        }
    }

    let changes = diff_trees(&repo, &snapshot.tree, &target_tree)?;
    let mut plan = plan_restore(&changes);
    report.skipped.append(&mut plan.skipped);

    // A path that is on disk but was not in the snapshot is an ignored file;
    // it is never overwritten.
    let in_snapshot: std::collections::HashSet<&str> = changes
        .iter()
        .filter(|c| c.status != FileStatus::Added)
        .map(|c| c.path.as_str())
        .collect();
    let mut writes: Vec<&String> = Vec::new();
    for path in &plan.writes {
        let exists = std::fs::symlink_metadata(repo.local_path.join(path)).is_ok();
        if exists && !in_snapshot.contains(path.as_str()) {
            report.skipped.push(Skipped {
                path: path.clone(),
                reason: "ignored-file-in-the-way".into(),
            });
        } else {
            writes.push(path);
        }
    }

    // Everything that can fail before the working tree is touched happens now:
    // the safety snapshot (so a forced or lossy restore can be undone) and the
    // private index the files are written from.
    let needs_safety = force || baseline_tree.as_ref().is_none_or(|t| *t != snapshot.tree);
    if needs_safety {
        let head = head_commit_opt(&repo)?;
        report.safety = Some(write_safety_snapshot(
            &repo,
            &admin,
            task_id,
            &snapshot.tree,
            head.as_deref(),
            &mine,
        )?);
    }
    let staged = if writes.is_empty() {
        None
    } else {
        let temp = TempIndex::empty(&repo)?;
        let read = run_indexed(
            &repo,
            &temp,
            os_args(["read-tree", target_tree.as_str()]),
            None,
        )?;
        ensure_success(&read, "git read-tree failed")?;
        Some(temp)
    };

    let mut touched: Vec<String> = Vec::new();
    for path in &plan.deletes {
        match remove_tracked_path(&repo.local_path, path) {
            Ok(true) => {
                report.removed += 1;
                touched.push(path.clone());
            }
            Ok(false) => {}
            Err(reason) => report.skipped.push(Skipped {
                path: path.clone(),
                reason,
            }),
        }
    }

    if let Some(temp) = staged {
        let mut list: Vec<u8> = Vec::new();
        for path in &writes {
            list.extend_from_slice(path.as_bytes());
            list.push(0);
        }
        let checkout = run_indexed(
            &repo,
            &temp,
            os_args(["checkout-index", "-f", "-z", "--stdin"]),
            Some(list),
        )?;
        ensure_success(&checkout, "git checkout-index failed")?;
        report.written = writes.len() as u32;
        touched.extend(writes.iter().map(|p| (*p).clone()));
    }

    touched.sort();
    touched.dedup();
    if !touched.is_empty() {
        report.index_synced = sync_index_to_head(&repo, &admin, &touched);
    }
    write_last_restore(&admin, task_id, reference, &target_tree);
    report.restored = true;
    Ok(report)
}

// ---------------------------------------------------------------------------
// Manual checkpoints
//
// A manual checkpoint is not tied to an agent task or turn: it has its own
// random id, its own ref root (`refs/<namespace>/manual-checkpoints/<id>`) and
// an optional name that is a label, never part of the identity. Creation reuses
// the bounded snapshot above (a private copy of the index, `git add -A`, up to
// three verification passes) and records what it excluded or could not capture
// in the commit subject, so a later listing and inspection disclose the same
// limitations without trusting creation-time state.
// ---------------------------------------------------------------------------

/// Longest accepted manual checkpoint name, in characters.
pub const MAX_MANUAL_NAME_CHARS: usize = 120;
const MAX_INSPECTED_PATHS: usize = 200;
/// Cap for the ignored/staged path probes: enough to count them, never a walk
/// over an arbitrarily large ignored tree.
const PROBE_STDOUT_CAP: usize = 256 * 1024;
/// Cap for the submodule scan of the index.
const INDEX_SCAN_CAP: usize = 4 * 1024 * 1024;
const MANUAL_ID_ATTEMPTS: u32 = 8;

const MANUAL_SUBJECT_PREFIX: &str = "terax manual ";
const CAPTURE_MARK: &str = " [capture ";
const CAPTURE_VERSION: &str = "v1";
const UNNAMED: &str = "(unnamed)";

/// What kind of recovery point a ref is.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryKind {
    /// A manual, optionally named checkpoint.
    Manual,
    /// A retained per-task/per-turn checkpoint.
    Turn,
    /// A pre-restore snapshot kept so a restore can be undone.
    Safety,
}

/// What a manual capture did and did not include. Persisted with the checkpoint
/// (in its commit subject) so inspection reports the same facts later.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReport {
    /// Two consecutive snapshot passes produced the same tree.
    pub consistent: bool,
    pub passes: u32,
    /// Files that kept changing under the snapshot and were left out.
    pub unstable_count: u32,
    /// Files Git could not read; the rest of the tree was still captured.
    pub warnings: Vec<String>,
    /// Ignored files and directories under the worktree. Never captured.
    pub ignored_files: u32,
    /// The ignored listing hit its read cap: the count is a lower bound.
    pub ignored_truncated: bool,
    /// Paths staged in the real index at capture time. Staging is not recorded.
    pub staged_files: u32,
    pub staged_truncated: bool,
    /// Submodules recorded as their commit pointer only.
    pub submodules: u32,
    pub submodules_truncated: bool,
    /// The capture is not a complete, stable snapshot of the working tree.
    pub incomplete: bool,
}

impl CaptureReport {
    fn of(
        snapshot: &Snapshot,
        ignored: &ProbeCount,
        staged: &ProbeCount,
        submodules: &ProbeCount,
    ) -> Self {
        let unstable_count = snapshot.unstable_paths.len() as u32;
        Self {
            consistent: snapshot.consistent,
            passes: snapshot.passes,
            unstable_count,
            warnings: snapshot.warnings.clone(),
            ignored_files: ignored.count,
            ignored_truncated: ignored.truncated,
            staged_files: staged.count,
            staged_truncated: staged.truncated,
            submodules: submodules.count,
            submodules_truncated: submodules.truncated,
            incomplete: !snapshot.consistent || unstable_count > 0 || !snapshot.warnings.is_empty(),
        }
    }
}

/// A manual checkpoint as the frontend sees it (creation result and listing).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManualCheckpoint {
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// The opaque identity: 32 hex digits, never a fallback to task/turn slots.
    pub id: String,
    /// The user's optional name; a label, not an identity.
    pub name: Option<String>,
    pub commit: String,
    pub tree: String,
    /// HEAD at capture time; `None` for an unborn branch.
    pub parent: Option<String>,
    pub created_at_secs: i64,
    /// `None` only when the stored record is missing or unreadable.
    pub capture: Option<CaptureReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCheckpointCreated {
    #[serde(flatten)]
    pub checkpoint: ManualCheckpoint,
    pub limits: CheckpointLimits,
    pub duration_ms: u64,
}

/// A pre-restore safety snapshot this worktree owns.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafetyRef {
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// The turn checkpoint whose restore saved it.
    pub task_id: String,
    pub commit: String,
    pub tree: String,
    pub parent: Option<String>,
    pub created_at_secs: i64,
}

/// Repository-wide object context for retained recovery points. Deliberately
/// not a reclaimable-byte estimate: objects are content-addressed and shared
/// between refs, and this application never runs Git garbage collection.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoragePressure {
    /// Loose objects in the repository, all refs included (`git count-objects -v`).
    pub loose_objects: u32,
    pub loose_kib: u64,
    /// Objects already packed (`in-pack` / `size-pack`).
    pub packed_objects: u32,
    pub packed_kib: u64,
    /// Recovery refs this worktree owns: manual + turn + safety.
    pub owned_refs: u32,
    /// Always true: deleting a ref removes reachability, not a measurable number
    /// of bytes, until Git itself prunes unreachable objects.
    pub shared_objects: bool,
}

/// Every recovery point this worktree owns, grouped by kind.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointList {
    pub manual: Vec<ManualCheckpoint>,
    pub turns: Vec<CheckpointInfo>,
    pub safety: Vec<SafetyRef>,
    pub storage: StoragePressure,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInspection {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub kind: RecoveryKind,
    pub name: Option<String>,
    pub task_id: Option<String>,
    pub turn: Option<u32>,
    pub commit: String,
    pub tree: String,
    pub parent: Option<String>,
    pub created_at_secs: i64,
    pub capture: Option<CaptureReport>,
    pub limits: CheckpointLimits,
    /// Paths that differ between the checkpoint and its recorded parent (HEAD at
    /// capture time), capped at `MAX_INSPECTED_PATHS`.
    pub changed_paths: Vec<ChangedPath>,
    pub changed_total: u32,
    pub changed_truncated: bool,
    /// HEAD is not where it was when the checkpoint was taken. Commits are left
    /// alone; inspection only reports it.
    pub head_moved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRemoved {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub kind: RecoveryKind,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRefused {
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// `not-a-recovery-ref`, `missing`, `unknown-owner`, `another-worktree` or
    /// `changed`, when the ref moved between the check and the deletion.
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub removed: Vec<CleanupRemoved>,
    pub refused: Vec<CleanupRefused>,
    /// The groups after the deletion, so the UI never has to guess.
    pub remaining: CheckpointList,
    /// Every deletion is its own `update-ref`; a failure midway leaves earlier
    /// deletions in place and reports them.
    pub atomic: bool,
}

fn recovery_kind(name: &str) -> Option<RecoveryKind> {
    if refs::parse_manual_checkpoint_ref(name).is_some() {
        Some(RecoveryKind::Manual)
    } else if refs::parse_checkpoint_ref(name).is_some() {
        Some(RecoveryKind::Turn)
    } else if refs::parse_prerestore_ref(name).is_some() {
        Some(RecoveryKind::Safety)
    } else {
        None
    }
}

fn normalize_manual_name(name: Option<&str>) -> Result<Option<String>> {
    let Some(name) = name else {
        return Ok(None);
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_MANUAL_NAME_CHARS {
        return Err(GitError::command(
            "git checkpoint create",
            format!("the checkpoint name is longer than {MAX_MANUAL_NAME_CHARS} characters"),
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(GitError::command(
            "git checkpoint create",
            "the checkpoint name cannot contain control characters or line breaks",
        ));
    }
    if trimmed == UNNAMED {
        return Err(GitError::command(
            "git checkpoint create",
            "that name is reserved for an unnamed checkpoint",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// One line of the commit subject, so the existing single-line `for-each-ref`
/// listing can carry it: id, optional name, the capture record and the owning
/// worktree. The worktree marker stays last, as `subject_worktree_id` expects.
fn manual_subject(
    id: &str,
    name: Option<&str>,
    worktree_id: &str,
    capture: &CaptureReport,
) -> String {
    let record = format!(
        "{CAPTURE_VERSION} c={} p={} u={} i={} it={} s={} st={} m={} mt={} w={}",
        u8::from(capture.consistent),
        capture.passes,
        capture.unstable_count,
        capture.ignored_files,
        u8::from(capture.ignored_truncated),
        capture.staged_files,
        u8::from(capture.staged_truncated),
        capture.submodules,
        u8::from(capture.submodules_truncated),
        capture.warnings.join(",")
    );
    let label = name.unwrap_or(UNNAMED);
    format!(
        "{MANUAL_SUBJECT_PREFIX}{id} {label}{CAPTURE_MARK}{record}]{WORKTREE_MARK}{worktree_id}"
    )
}

fn parse_manual_subject(subject: &str) -> Option<(String, Option<String>)> {
    let rest = subject.strip_prefix(MANUAL_SUBJECT_PREFIX)?;
    let (id, rest) = rest.split_once(' ')?;
    if !refs::is_valid_manual_checkpoint_id(id) {
        return None;
    }
    let rest = rest.rsplit_once(WORKTREE_MARK)?.0;
    let label = match rest.rsplit_once(CAPTURE_MARK) {
        Some((label, record)) => {
            record.strip_suffix(']')?;
            label
        }
        None => rest,
    };
    let label = label.trim();
    let name = (!label.is_empty() && label != UNNAMED).then(|| label.to_string());
    Some((id.to_string(), name))
}

fn parse_capture_record(record: &str) -> Option<CaptureReport> {
    let mut fields = std::collections::HashMap::new();
    let mut parts = record.split(' ');
    if parts.next()? != CAPTURE_VERSION {
        return None;
    }
    for part in parts {
        let (key, value) = part.split_once('=')?;
        fields.insert(key, value);
    }
    let number = |key: &str| fields.get(key)?.parse::<u32>().ok();
    let flag = |key: &str| number(key).map(|value| value != 0);
    let warnings: Vec<String> = fields
        .get("w")?
        .split(',')
        .filter(|code| !code.is_empty())
        .map(str::to_string)
        .collect();
    let consistent = flag("c")?;
    let unstable_count = number("u")?;
    Some(CaptureReport {
        consistent,
        passes: number("p")?,
        unstable_count,
        incomplete: !consistent || unstable_count > 0 || !warnings.is_empty(),
        warnings,
        ignored_files: number("i")?,
        ignored_truncated: flag("it")?,
        staged_files: number("s")?,
        staged_truncated: flag("st")?,
        submodules: number("m")?,
        submodules_truncated: flag("mt")?,
    })
}

fn capture_record_of(subject: &str) -> Option<CaptureReport> {
    let (_, rest) = subject.rsplit_once(CAPTURE_MARK)?;
    let (record, _) = rest.split_once(']')?;
    parse_capture_record(record)
}

impl RefRecord {
    fn manual(&self) -> Option<ManualCheckpoint> {
        let (id, name) = parse_manual_subject(&self.subject)?;
        Some(ManualCheckpoint {
            ref_name: self.name.clone(),
            id,
            name,
            commit: self.commit.clone(),
            tree: self.tree.clone(),
            parent: self.parent.clone(),
            created_at_secs: self.created_at_secs,
            capture: capture_record_of(&self.subject),
        })
    }
}

/// Count of NUL-separated records, with the read-cap state the output carried.
struct ProbeCount {
    count: u32,
    truncated: bool,
}

impl ProbeCount {
    fn of(output: &GitOutput) -> Self {
        let count = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
            .count();
        Self {
            count: count.min(u32::MAX as usize) as u32,
            truncated: output.truncated,
        }
    }
}

fn probe(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
    args: Vec<OsString>,
    cap: usize,
) -> Result<ProbeCount> {
    let output = run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        admin.plumb(args)?,
        SNAPSHOT_TIMEOUT_SECS,
        RunOptions {
            stdout_cap: cap,
            ..Default::default()
        },
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git ls-files"));
    }
    ensure_success(&output, "git ls-files failed")?;
    Ok(ProbeCount::of(&output))
}

fn staged_paths(repo: &ResolvedGitDirectory, admin: &Admin) -> Result<ProbeCount> {
    let output = run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        admin.plumb(os_args(["diff", "--cached", "--name-only", "-z"]))?,
        SNAPSHOT_TIMEOUT_SECS,
        RunOptions {
            stdout_cap: PROBE_STDOUT_CAP,
            ..Default::default()
        },
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git diff --cached"));
    }
    ensure_success(&output, "git diff --cached failed")?;
    Ok(ProbeCount::of(&output))
}

fn submodule_entries(repo: &ResolvedGitDirectory, admin: &Admin) -> Result<ProbeCount> {
    let output = run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        admin.plumb(os_args(["ls-files", "--stage", "-z"]))?,
        SNAPSHOT_TIMEOUT_SECS,
        RunOptions {
            stdout_cap: INDEX_SCAN_CAP,
            ..Default::default()
        },
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git ls-files --stage"));
    }
    ensure_success(&output, "git ls-files --stage failed")?;
    let count = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| record.get(..6) == Some(b"160000"))
        .count();
    Ok(ProbeCount {
        count: count.min(u32::MAX as usize) as u32,
        truncated: output.truncated,
    })
}

fn capture_report(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
    snapshot: &Snapshot,
) -> Result<CaptureReport> {
    let ignored = probe(
        repo,
        admin,
        os_args([
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ]),
        PROBE_STDOUT_CAP,
    )?;
    let staged = staged_paths(repo, admin)?;
    let submodules = submodule_entries(repo, admin)?;
    Ok(CaptureReport::of(snapshot, &ignored, &staged, &submodules))
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| {
        GitError::command("git checkpoint create", format!("no random source: {e}"))
    })?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn storage_pressure(repo: &ResolvedGitDirectory, owned_refs: u32) -> Result<StoragePressure> {
    let output = run_ok(
        repo,
        os_args(["count-objects", "-v"]),
        "git count-objects failed",
    )?;
    let mut loose_objects = 0u32;
    let mut loose_kib = 0u64;
    let mut packed_objects = 0u32;
    let mut packed_kib = 0u64;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((key, value)) = line.split_once(": ") else {
            continue;
        };
        let Ok(value) = value.trim().parse::<u64>() else {
            continue;
        };
        match key {
            "count" => loose_objects = value.min(u64::from(u32::MAX)) as u32,
            "size" => loose_kib = value,
            "in-pack" => packed_objects = value.min(u64::from(u32::MAX)) as u32,
            "size-pack" => packed_kib = value,
            _ => {}
        }
    }
    Ok(StoragePressure {
        loose_objects,
        loose_kib,
        packed_objects,
        packed_kib,
        owned_refs,
        shared_objects: true,
    })
}

/// The manual refs this worktree owns, newest first.
fn list_manual(repo: &ResolvedGitDirectory, mine: &str) -> Result<Vec<ManualCheckpoint>> {
    let prefix = refs::manual_checkpoint_prefix();
    let output = run_ok(
        repo,
        os_args(["for-each-ref", LIST_FORMAT, prefix.as_str()]),
        "git for-each-ref failed",
    )?;
    let mut manual: Vec<ManualCheckpoint> = parse_ref_records(&output.stdout)
        .into_iter()
        .filter(|record| record.worktree_id.as_deref() == Some(mine))
        .filter_map(|record| record.manual())
        .collect();
    manual.sort_by(|a, b| {
        b.created_at_secs
            .cmp(&a.created_at_secs)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(manual)
}

/// The retained turn checkpoints this worktree owns, by task then turn.
fn list_turns(repo: &ResolvedGitDirectory, mine: &str) -> Result<Vec<CheckpointInfo>> {
    let prefix = refs::checkpoint_prefix();
    let output = run_ok(
        repo,
        os_args(["for-each-ref", LIST_FORMAT, prefix.as_str()]),
        "git for-each-ref failed",
    )?;
    let mut turns: Vec<CheckpointInfo> = parse_ref_records(&output.stdout)
        .into_iter()
        .filter(|record| record.worktree_id.as_deref() == Some(mine))
        .filter_map(info_of)
        .collect();
    turns.sort_by(|a, b| a.task_id.cmp(&b.task_id).then_with(|| a.turn.cmp(&b.turn)));
    Ok(turns)
}

/// The pre-restore safety refs this worktree owns, newest first.
fn list_safety(repo: &ResolvedGitDirectory, mine: &str) -> Result<Vec<SafetyRef>> {
    let prefix = refs::checkpoint_prefix();
    let output = run_ok(
        repo,
        os_args(["for-each-ref", LIST_FORMAT, prefix.as_str()]),
        "git for-each-ref failed",
    )?;
    let mut safety: Vec<SafetyRef> = parse_ref_records(&output.stdout)
        .into_iter()
        .filter(|record| record.worktree_id.as_deref() == Some(mine))
        .filter_map(|record| {
            let (task, _) = refs::parse_prerestore_ref(&record.name)?;
            let task_id = task.to_string();
            Some(SafetyRef {
                ref_name: record.name,
                task_id,
                commit: record.commit,
                tree: record.tree,
                parent: record.parent,
                created_at_secs: record.created_at_secs,
            })
        })
        .collect();
    safety.sort_by(|a, b| {
        b.created_at_secs
            .cmp(&a.created_at_secs)
            .then_with(|| a.ref_name.cmp(&b.ref_name))
    });
    Ok(safety)
}

fn groups_for(repo: &ResolvedGitDirectory, mine: &str) -> Result<CheckpointList> {
    let manual = list_manual(repo, mine)?;
    let turns = list_turns(repo, mine)?;
    let safety = list_safety(repo, mine)?;
    let owned = manual.len() + turns.len() + safety.len();
    Ok(CheckpointList {
        manual,
        turns,
        safety,
        storage: storage_pressure(repo, owned.min(u32::MAX as usize) as u32)?,
    })
}

/// Creates a manual checkpoint of the worktree's tracked and non-ignored files.
///
/// HEAD, the real index and the working tree are never modified: the snapshot
/// uses a private copy of the index and the commit object is published under a
/// new manual ref that never replaces an existing one.
pub fn create_manual(
    registry: &WorkspaceRegistry,
    worktree: &str,
    name: Option<&str>,
    workspace: &WorkspaceEnv,
) -> Result<ManualCheckpointCreated> {
    let name = normalize_manual_name(name)?;
    let started = Instant::now();
    let repo = open_worktree(registry, worktree, workspace)?;
    ensure_supported(&repo)?;
    let admin = Admin::new(&repo)?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mine = admin.worktree_id()?;

    let snapshot = snapshot_tree(&repo, true)?;
    let capture = capture_report(&repo, &admin, &snapshot)?;
    let parent = head_commit_opt(&repo)?;

    for _ in 0..MANUAL_ID_ATTEMPTS {
        let id = random_id()?;
        let subject = manual_subject(&id, name.as_deref(), &mine, &capture);
        let commit = write_commit(&repo, &admin, &snapshot.tree, parent.as_deref(), &subject)?;
        let ref_name = refs::manual_checkpoint_ref(&id);
        // The empty old value makes this fail instead of replacing a ref that
        // already exists, so two checkpoints can never share an identity.
        let output = run(
            &repo,
            admin.plumb(os_args([
                "update-ref",
                ref_name.as_str(),
                commit.as_str(),
                "",
            ]))?,
        )?;
        if output.timed_out {
            return Err(GitError::TimedOut("git update-ref"));
        }
        if output.exit_code == Some(0) {
            return Ok(ManualCheckpointCreated {
                checkpoint: ManualCheckpoint {
                    ref_name,
                    id,
                    name: name.clone(),
                    commit,
                    tree: snapshot.tree.clone(),
                    parent,
                    created_at_secs: now_secs(),
                    capture: Some(capture.clone()),
                },
                limits: LIMITS,
                duration_ms: started.elapsed().as_millis() as u64,
            });
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.contains("already exists") {
            return Err(GitError::command(
                "git update-ref failed",
                stderr.trim().to_string(),
            ));
        }
    }
    Err(GitError::command(
        "git checkpoint create",
        "could not allocate a free checkpoint identity",
    ))
}

/// Every recovery point this worktree owns: manual checkpoints, retained turn
/// checkpoints and restore safety refs, with repository-level storage context.
pub fn list_groups(
    registry: &WorkspaceRegistry,
    worktree: &str,
    workspace: &WorkspaceEnv,
) -> Result<CheckpointList> {
    let repo = open_worktree(registry, worktree, workspace)?;
    let admin = Admin::new(&repo)?;
    match admin.existing_worktree_id() {
        Some(mine) => groups_for(&repo, &mine),
        None => Ok(CheckpointList {
            manual: Vec::new(),
            turns: Vec::new(),
            safety: Vec::new(),
            storage: storage_pressure(&repo, 0)?,
        }),
    }
}

/// The metadata and captured paths of one recovery point this worktree owns.
pub fn inspect(
    registry: &WorkspaceRegistry,
    worktree: &str,
    reference: &str,
    workspace: &WorkspaceEnv,
) -> Result<CheckpointInspection> {
    let kind =
        recovery_kind(reference).ok_or_else(|| GitError::InvalidRef(reference.to_string()))?;
    let repo = open_worktree(registry, worktree, workspace)?;
    let admin = Admin::new(&repo)?;
    let mine = admin.existing_worktree_id().ok_or_else(|| {
        GitError::command(
            "git checkpoint inspect",
            "no such checkpoint for this worktree",
        )
    })?;
    let output = run_ok(
        &repo,
        os_args(["for-each-ref", LIST_FORMAT, reference]),
        "git for-each-ref failed",
    )?;
    let record = parse_ref_records(&output.stdout)
        .into_iter()
        .find(|record| record.name == reference)
        .ok_or_else(|| {
            GitError::command(
                "git checkpoint inspect",
                "no such checkpoint for this worktree",
            )
        })?;
    if record.worktree_id.as_deref() != Some(mine.as_str()) {
        return Err(GitError::command(
            "git checkpoint inspect",
            "no such checkpoint for this worktree",
        ));
    }

    let (name, task_id, turn, capture) = match kind {
        RecoveryKind::Manual => {
            let manual = record.manual().ok_or_else(|| {
                GitError::command(
                    "git checkpoint inspect",
                    "unreadable manual checkpoint record",
                )
            })?;
            (manual.name, None, None, manual.capture)
        }
        RecoveryKind::Turn => {
            let (task, turn) = refs::parse_checkpoint_ref(&record.name)
                .ok_or_else(|| GitError::InvalidRef(reference.to_string()))?;
            (None, Some(task.to_string()), Some(turn), None)
        }
        RecoveryKind::Safety => {
            let (task, _) = refs::parse_prerestore_ref(&record.name)
                .ok_or_else(|| GitError::InvalidRef(reference.to_string()))?;
            (None, Some(task.to_string()), None, None)
        }
    };

    let parent_tree = match &record.parent {
        Some(parent) => tree_of(&repo, parent)?,
        None => empty_tree(&repo)?,
    };
    let changes = diff_trees(&repo, &parent_tree, &record.tree)?;
    let changed_total = changes.len() as u32;
    let changed_paths: Vec<ChangedPath> = changes
        .into_iter()
        .take(MAX_INSPECTED_PATHS)
        .map(|change| ChangedPath {
            path: change.path,
            status: change.status,
        })
        .collect();
    let changed_truncated = changed_total as usize > changed_paths.len();

    Ok(CheckpointInspection {
        ref_name: record.name,
        kind,
        name,
        task_id,
        turn,
        commit: record.commit,
        tree: record.tree,
        parent: record.parent.clone(),
        created_at_secs: record.created_at_secs,
        capture,
        limits: LIMITS,
        changed_paths,
        changed_total,
        changed_truncated,
        head_moved: head_commit_opt(&repo)? != record.parent,
    })
}

/// Deletes exactly the named recovery refs this worktree owns.
///
/// Nothing is deleted by default, references from another worktree or another
/// installation are refused, and no Git garbage collection is ever run: content
/// objects stay until Git itself prunes them.
pub fn cleanup(
    registry: &WorkspaceRegistry,
    worktree: &str,
    references: &[String],
    workspace: &WorkspaceEnv,
) -> Result<CleanupReport> {
    let repo = open_worktree(registry, worktree, workspace)?;
    let admin = Admin::new(&repo)?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mine = admin.existing_worktree_id();

    let mut removed = Vec::new();
    let mut refused = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for reference in references {
        if !seen.insert(reference.as_str()) {
            continue;
        }
        let Some(kind) = recovery_kind(reference) else {
            refused.push(CleanupRefused {
                ref_name: reference.clone(),
                reason: "not-a-recovery-ref".into(),
            });
            continue;
        };
        let output = run(
            &repo,
            os_args(["for-each-ref", LIST_FORMAT, reference.as_str()]),
        )?;
        let record = parse_ref_records(&output.stdout)
            .into_iter()
            .find(|record| record.name == *reference);
        let Some(record) = record else {
            refused.push(CleanupRefused {
                ref_name: reference.clone(),
                reason: "missing".into(),
            });
            continue;
        };
        let reason = match (record.worktree_id.as_deref(), mine.as_deref()) {
            (None, _) => Some("unknown-owner"),
            (Some(owner), Some(mine)) if owner == mine => None,
            (Some(_), _) => Some("another-worktree"),
        };
        if let Some(reason) = reason {
            refused.push(CleanupRefused {
                ref_name: reference.clone(),
                reason: reason.into(),
            });
            continue;
        }
        // The expected old value makes a concurrent move of the ref a refusal
        // rather than a deletion of something the caller never saw.
        let deleted = run(
            &repo,
            admin.plumb(os_args([
                "update-ref",
                "-d",
                reference.as_str(),
                record.commit.as_str(),
            ]))?,
        )?;
        if deleted.timed_out {
            return Err(GitError::TimedOut("git update-ref"));
        }
        if deleted.exit_code == Some(0) {
            removed.push(CleanupRemoved {
                ref_name: reference.clone(),
                kind,
            });
        } else {
            refused.push(CleanupRefused {
                ref_name: reference.clone(),
                reason: "changed".into(),
            });
        }
    }
    if !removed.is_empty() {
        clear_last_restore(&admin);
    }
    let remaining = list_groups(registry, worktree, workspace)?;
    Ok(CleanupReport {
        removed,
        refused,
        remaining,
        atomic: false,
    })
}

// ---------------------------------------------------------------------------
// Manual restore: preview, required safety capture, partial-failure recovery
//
// Restoring a captured working-tree content is never a Git-state undo. Before
// a file or an index entry changes, the current working tree is captured and
// published under a safety ref; a failed or incomplete capture, or a failed ref
// publication, refuses before mutation and `force` does not bypass it. The
// preflight reports the affected paths, staging effects, HEAD effect, ignored
// files it will leave alone and the limits of the safety capture. If the
// working tree changed after the preview, the stale preview is refused; a
// retry after a partial failure therefore starts from a fresh preview.
// ---------------------------------------------------------------------------

const NO_SAFETY_CAPTURE: &str = "the required safety capture failed";

/// Failure injection for the native seam tests. Production calls always pass
/// `RestoreHooks::default()`, so every flag is `false` there.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct RestoreHooks {
    pub(crate) fail_safety_capture: bool,
    pub(crate) inconsistent_capture: bool,
    pub(crate) fail_safety_ref: bool,
    pub(crate) fail_after_deletes: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreEffect {
    Written,
    Removed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePath {
    pub path: String,
    pub status: FileStatus,
    pub effect: RestoreEffect,
    /// The real index has a staged entry for this path; staging is not captured.
    pub staged: bool,
    /// Present on disk but excluded from the snapshot, so it is left alone.
    pub ignored_in_the_way: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ManualRestoreRefusal {
    /// Affected paths are staged; staging is not part of a safety capture, so
    /// the user resolves them (unstage/commit) or forces an explicit loss.
    StagedAffectedPaths,
    /// The working tree changed after the preview; take a fresh preview.
    StalePreview,
    /// A per-turn checkpoint belongs to the retained restore path, not this one.
    UnsupportedCheckpointKind,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreFailureStage {
    Writes,
    IndexSync,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualRestorePreview {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub kind: RecoveryKind,
    pub name: Option<String>,
    pub commit: String,
    pub tree: String,
    pub parent: Option<String>,
    pub head_moved: bool,
    /// Restoring never moves HEAD; it resets the index entries of touched paths.
    pub head_effect: String,
    pub affected: Vec<RestorePath>,
    pub affected_total: u32,
    pub affected_truncated: bool,
    pub skipped: Vec<Skipped>,
    /// Affected paths staged in the real index.
    pub staged_total: u32,
    /// The staged-path probe hit its read cap: staging is unknown, so mutation
    /// is refused rather than guessed.
    pub staged_truncated: bool,
    /// An ignored file or directory the checkpoint holds is left alone.
    pub ignored_in_the_way: u32,
    /// The safety capture is a precondition, not a best effort.
    pub requires_safety_capture: bool,
    pub captures_index_state: bool,
    pub captures_ignored_files: bool,
    pub atomic: bool,
    pub fingerprint: String,
    pub refusal: Option<ManualRestoreRefusal>,
    pub refusal_detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualRestoreReport {
    pub restored: bool,
    pub refusal: Option<ManualRestoreRefusal>,
    pub refusal_detail: Option<String>,
    pub kind: RecoveryKind,
    /// The target was a safety ref: this recovers content, never Git state.
    pub content_only: bool,
    pub affected: Vec<RestorePath>,
    pub affected_total: u32,
    pub skipped: Vec<Skipped>,
    pub staged_total: u32,
    pub written: u32,
    pub removed: u32,
    pub safety: Option<SafetySnapshot>,
    pub safety_retained: bool,
    pub captures_index_state: bool,
    pub index_synced: bool,
    pub head_effect: String,
    pub head_moved: bool,
    pub atomic: bool,
    pub capture_consistent: bool,
    pub capture_warnings: Vec<String>,
    /// A failure happened after mutation started; the effects listed above are
    /// what this call knows it did.
    pub partial: bool,
    pub failure: Option<String>,
    pub failure_stage: Option<RestoreFailureStage>,
    /// The previous plan no longer describes the working tree: preview again.
    pub retry_requires_fresh_preview: bool,
}

struct Restorable {
    kind: RecoveryKind,
    ref_name: String,
    name: Option<String>,
    commit: String,
    tree: String,
    parent: Option<String>,
    /// Where a generated safety ref is filed: the manual id, or the task id a
    /// safety ref already belongs to.
    safety_task: String,
}

struct RestoreState {
    target: Restorable,
    target_tree: String,
    head_before: Option<String>,
    snapshot: Snapshot,
    skipped: Vec<Skipped>,
    affected: Vec<RestorePath>,
    ignored_in_the_way: u32,
    staged_truncated: bool,
    fingerprint: String,
}

impl RestoreState {
    fn staged_total(&self) -> u32 {
        self.affected.iter().filter(|path| path.staged).count() as u32
    }

    fn writes(&self) -> Vec<String> {
        self.affected
            .iter()
            .filter(|path| path.effect == RestoreEffect::Written && !path.ignored_in_the_way)
            .map(|path| path.path.clone())
            .collect()
    }

    fn deletes(&self) -> Vec<String> {
        self.affected
            .iter()
            .filter(|path| path.effect == RestoreEffect::Removed && !path.ignored_in_the_way)
            .map(|path| path.path.clone())
            .collect()
    }
}

/// Deterministic FNV-1a over the pieces the preview was built from. A native
/// recheck compares it immediately before mutation, so an external writer or a
/// failed partial restore cannot be retried with an outdated plan.
fn restore_fingerprint(parts: &[&str]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn resolve_restorable(
    repo: &ResolvedGitDirectory,
    reference: &str,
    mine: &str,
) -> Result<Restorable> {
    let kind =
        recovery_kind(reference).ok_or_else(|| GitError::InvalidRef(reference.to_string()))?;
    let output = run(repo, os_args(["for-each-ref", LIST_FORMAT, reference]))?;
    let record = parse_ref_records(&output.stdout)
        .into_iter()
        .find(|record| record.name == reference)
        .ok_or_else(|| {
            GitError::command(
                "git checkpoint restore",
                "no such checkpoint for this worktree",
            )
        })?;
    if record.worktree_id.as_deref() != Some(mine) {
        return Err(GitError::command(
            "git checkpoint restore",
            "no such checkpoint for this worktree",
        ));
    }
    let (name, safety_task) = match kind {
        RecoveryKind::Manual => {
            let manual = record.manual().ok_or_else(|| {
                GitError::command(
                    "git checkpoint restore",
                    "unreadable manual checkpoint record",
                )
            })?;
            (manual.name, manual.id)
        }
        RecoveryKind::Safety => {
            let (task, _) = refs::parse_prerestore_ref(reference)
                .ok_or_else(|| GitError::InvalidRef(reference.to_string()))?;
            (None, task.to_string())
        }
        RecoveryKind::Turn => (None, String::new()),
    };
    Ok(Restorable {
        kind,
        ref_name: record.name,
        name,
        commit: record.commit,
        tree: record.tree,
        parent: record.parent,
        safety_task,
    })
}

/// Names staged in the real index, with the read-cap state (`true` means the
/// list is incomplete and staging cannot be judged).
fn staged_path_set(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
) -> Result<(std::collections::HashSet<String>, bool)> {
    let output = run_git_with(
        &repo.workspace,
        Some(&repo.git_path),
        admin.plumb(os_args(["diff", "--cached", "--name-only", "-z"]))?,
        SNAPSHOT_TIMEOUT_SECS,
        RunOptions {
            stdout_cap: INDEX_SCAN_CAP,
            ..Default::default()
        },
    )?;
    if output.timed_out {
        return Err(GitError::TimedOut("git diff --cached"));
    }
    ensure_success(&output, "git diff --cached failed")?;
    let staged = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).into_owned())
        .collect();
    Ok((staged, output.truncated))
}

fn restore_state(
    repo: &ResolvedGitDirectory,
    admin: &Admin,
    mine: &str,
    reference: &str,
) -> Result<RestoreState> {
    let target = resolve_restorable(repo, reference, mine)?;
    if target.kind == RecoveryKind::Turn {
        return Ok(RestoreState {
            target,
            target_tree: String::new(),
            head_before: head_commit_opt(repo)?,
            snapshot: Snapshot {
                tree: String::new(),
                consistent: true,
                passes: 1,
                warnings: Vec::new(),
                unstable_paths: Vec::new(),
            },
            skipped: Vec::new(),
            affected: Vec::new(),
            ignored_in_the_way: 0,
            staged_truncated: false,
            fingerprint: String::new(),
        });
    }

    let target_tree = tree_of(repo, &target.commit)?;
    let snapshot = snapshot_tree(repo, true)?;
    let changes = diff_trees(repo, &snapshot.tree, &target_tree)?;
    let plan = plan_restore(&changes);
    let in_snapshot: std::collections::HashSet<&str> = changes
        .iter()
        .filter(|change| change.status != FileStatus::Added)
        .map(|change| change.path.as_str())
        .collect();
    let (staged, staged_truncated) = staged_path_set(repo, admin)?;

    let mut writes: std::collections::HashSet<String> = plan.writes.iter().cloned().collect();
    let mut ignored_in_the_way = 0u32;
    for path in &plan.writes {
        let exists = std::fs::symlink_metadata(repo.local_path.join(path)).is_ok();
        if exists && !in_snapshot.contains(path.as_str()) {
            // Ignored-file protection: the checkpoint holds this path, the
            // snapshot does not (it is ignored now), so it stays untouched.
            writes.remove(path);
            ignored_in_the_way += 1;
        }
    }
    let mut skipped = plan.skipped.clone();
    for path in &plan.writes {
        if !writes.contains(path) {
            skipped.push(Skipped {
                path: path.clone(),
                reason: "ignored-file-in-the-way".into(),
            });
        }
    }

    let status_of = |path: &str| {
        changes
            .iter()
            .find(|change| change.path == path)
            .map(|change| change.status)
    };
    let mut affected: Vec<RestorePath> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in writes.iter().chain(plan.deletes.iter()) {
        if !seen.insert(path.clone()) {
            continue;
        }
        let Some(status) = status_of(path) else {
            continue;
        };
        affected.push(RestorePath {
            path: path.clone(),
            status,
            effect: if writes.contains(path) {
                RestoreEffect::Written
            } else {
                RestoreEffect::Removed
            },
            staged: staged.contains(path),
            ignored_in_the_way: false,
        });
    }
    affected.sort_by(|a, b| a.path.cmp(&b.path));

    let head_before = head_commit_opt(repo)?;
    let mut parts: Vec<String> = vec![
        format!("{:?}", target.kind).to_lowercase(),
        target.ref_name.clone(),
        target.commit.clone(),
        target_tree.clone(),
        snapshot.tree.clone(),
        head_before.clone().unwrap_or_default(),
    ];
    for path in &affected {
        parts.push(format!(
            "{}:{:?}:{:?}:{}",
            path.path, path.status, path.effect, path.staged
        ));
    }
    parts.push(format!("staged-truncated:{staged_truncated}"));
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    let fingerprint = restore_fingerprint(&refs);

    Ok(RestoreState {
        target,
        target_tree,
        head_before,
        snapshot,
        skipped,
        affected,
        ignored_in_the_way,
        staged_truncated,
        fingerprint,
    })
}

fn preview_of(state: &RestoreState, refusal: Option<ManualRestoreRefusal>) -> ManualRestorePreview {
    let total = state.affected.len() as u32;
    let affected: Vec<RestorePath> = state
        .affected
        .iter()
        .take(MAX_INSPECTED_PATHS)
        .cloned()
        .collect();
    ManualRestorePreview {
        ref_name: state.target.ref_name.clone(),
        kind: state.target.kind,
        name: state.target.name.clone(),
        commit: state.target.commit.clone(),
        tree: state.target.tree.clone(),
        parent: state.target.parent.clone(),
        head_moved: state.head_before != state.target.parent,
        head_effect: "unchanged".into(),
        affected,
        affected_total: total,
        affected_truncated: total as usize > MAX_INSPECTED_PATHS,
        skipped: state.skipped.clone(),
        staged_total: state.staged_total(),
        staged_truncated: state.staged_truncated,
        ignored_in_the_way: state.ignored_in_the_way,
        requires_safety_capture: state.target.kind != RecoveryKind::Turn,
        captures_index_state: false,
        captures_ignored_files: false,
        atomic: false,
        fingerprint: state.fingerprint.clone(),
        refusal,
        refusal_detail: refusal.map(|refusal| match refusal {
            ManualRestoreRefusal::UnsupportedCheckpointKind => {
                "per-turn checkpoints use the retained checkpoint restore path".to_string()
            }
            ManualRestoreRefusal::StagedAffectedPaths => {
                "affected paths are staged; staging is not part of a safety capture".to_string()
            }
            ManualRestoreRefusal::StalePreview => {
                "the working tree changed after this preview".to_string()
            }
        }),
    }
}

/// Read-only preflight for restoring captured content. Never writes a ref, a
/// file or an index entry.
pub fn restore_preview(
    registry: &WorkspaceRegistry,
    worktree: &str,
    reference: &str,
    workspace: &WorkspaceEnv,
) -> Result<ManualRestorePreview> {
    let repo = open_worktree(registry, worktree, workspace)?;
    ensure_supported(&repo)?;
    let admin = Admin::new(&repo)?;
    let mine = admin.existing_worktree_id().ok_or_else(|| {
        GitError::command(
            "git checkpoint restore",
            "no such checkpoint for this worktree",
        )
    })?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let state = restore_state(&repo, &admin, &mine, reference)?;
    let refusal = (state.target.kind == RecoveryKind::Turn)
        .then_some(ManualRestoreRefusal::UnsupportedCheckpointKind);
    Ok(preview_of(&state, refusal))
}

fn capture_problem(state: &RestoreState, consistent: bool) -> Option<String> {
    if !consistent {
        return Some(
            "the required safety capture was incomplete: the working tree kept changing while it ran"
                .to_string(),
        );
    }
    let affected: std::collections::HashSet<&str> = state
        .affected
        .iter()
        .map(|path| path.path.as_str())
        .collect();
    let unstable: Vec<&str> = state
        .snapshot
        .unstable_paths
        .iter()
        .map(String::as_str)
        .filter(|path| affected.contains(path))
        .collect();
    if !unstable.is_empty() {
        return Some(format!(
            "the required safety capture was incomplete: affected paths kept changing ({})",
            unstable.join(", ")
        ));
    }
    None
}

fn report_of(state: &RestoreState, kind: RecoveryKind) -> ManualRestoreReport {
    let total = state.affected.len() as u32;
    ManualRestoreReport {
        restored: false,
        refusal: None,
        refusal_detail: None,
        kind,
        content_only: kind == RecoveryKind::Safety,
        affected: state
            .affected
            .iter()
            .take(MAX_INSPECTED_PATHS)
            .cloned()
            .collect(),
        affected_total: total,
        skipped: state.skipped.clone(),
        staged_total: state.staged_total(),
        written: 0,
        removed: 0,
        safety: None,
        safety_retained: false,
        captures_index_state: false,
        index_synced: true,
        head_effect: "unchanged".into(),
        head_moved: state.head_before != state.target.parent,
        atomic: false,
        capture_consistent: state.snapshot.consistent,
        capture_warnings: state.snapshot.warnings.clone(),
        partial: false,
        failure: None,
        failure_stage: None,
        retry_requires_fresh_preview: false,
    }
}

fn refuse_report(
    state: &RestoreState,
    kind: RecoveryKind,
    refusal: ManualRestoreRefusal,
    detail: String,
) -> ManualRestoreReport {
    let mut report = report_of(state, kind);
    report.refusal = Some(refusal);
    report.refusal_detail = Some(detail);
    report
}

fn restore_manual_inner(
    registry: &WorkspaceRegistry,
    worktree: &str,
    reference: &str,
    expected_fingerprint: Option<&str>,
    force: bool,
    workspace: &WorkspaceEnv,
    hooks: RestoreHooks,
) -> Result<ManualRestoreReport> {
    let repo = open_worktree(registry, worktree, workspace)?;
    ensure_supported(&repo)?;
    let admin = Admin::new(&repo)?;
    let lock = lock_for_repo(&repo);
    let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mine = admin.existing_worktree_id().ok_or_else(|| {
        GitError::command(
            "git checkpoint restore",
            "no such checkpoint for this worktree",
        )
    })?;

    let state = restore_state(&repo, &admin, &mine, reference)?;
    let kind = state.target.kind;
    if kind == RecoveryKind::Turn {
        return Ok(refuse_report(
            &state,
            kind,
            ManualRestoreRefusal::UnsupportedCheckpointKind,
            "per-turn checkpoints use the retained checkpoint restore path".into(),
        ));
    }

    // The native recheck immediately before mutation. It sees external writers
    // and the effects of a previous partial failure, so an old plan cannot be
    // repeated.
    if let Some(expected) = expected_fingerprint {
        if expected != state.fingerprint {
            return Ok(refuse_report(
                &state,
                kind,
                ManualRestoreRefusal::StalePreview,
                "the working tree changed after this preview; review a fresh preview before retrying"
                    .into(),
            ));
        }
    }
    if state.staged_truncated {
        return Ok(refuse_report(
            &state,
            kind,
            ManualRestoreRefusal::StagedAffectedPaths,
            "the staged-path probe was truncated, so staging cannot be judged; resolve it in the terminal"
                .into(),
        ));
    }
    if !force && state.staged_total() > 0 {
        let detail = format!(
            "{} affected path{} staged; staging is not part of a safety capture. Unstage or commit them, or force an explicit index effect.",
            state.staged_total(),
            if state.staged_total() == 1 { " is" } else { "s are" }
        );
        return Ok(refuse_report(
            &state,
            kind,
            ManualRestoreRefusal::StagedAffectedPaths,
            detail,
        ));
    }

    // Everything that can fail before the working tree or index is touched
    // happens now, and nothing below is conditional on `force`.
    if hooks.fail_safety_capture {
        return Err(GitError::command(
            "git checkpoint restore",
            format!("{NO_SAFETY_CAPTURE}: the snapshot could not be read"),
        ));
    }
    let consistent = state.snapshot.consistent && !hooks.inconsistent_capture;
    if let Some(problem) = capture_problem(&state, consistent) {
        return Err(GitError::command("git checkpoint restore", problem));
    }
    if hooks.fail_safety_ref {
        return Err(GitError::command(
            "git checkpoint restore",
            "the required safety ref publication failed; nothing was changed",
        ));
    }
    let safety = write_safety_snapshot(
        &repo,
        &admin,
        &state.target.safety_task,
        &state.snapshot.tree,
        state.head_before.as_deref(),
        &mine,
    )?;
    let mut report = report_of(&state, kind);
    report.safety = Some(safety);
    report.safety_retained = true;

    let writes = state.writes();
    let deletes = state.deletes();
    let temp = if writes.is_empty() {
        None
    } else {
        let temp = TempIndex::empty(&repo)?;
        let read = run_indexed(
            &repo,
            &temp,
            os_args(["read-tree", state.target_tree.as_str()]),
            None,
        )?;
        ensure_success(&read, "git read-tree failed")?;
        Some(temp)
    };

    let mut touched: Vec<String> = Vec::new();
    for path in &deletes {
        match remove_tracked_path(&repo.local_path, path) {
            Ok(true) => {
                report.removed += 1;
                touched.push(path.clone());
            }
            Ok(false) => {}
            Err(reason) => report.skipped.push(Skipped {
                path: path.clone(),
                reason,
            }),
        }
    }

    if hooks.fail_after_deletes {
        return Ok(partial_report(
            report,
            RestoreFailureStage::Writes,
            "a later restore step failed after files were removed; the safety ref is retained"
                .into(),
        ));
    }

    if let Some(temp) = temp {
        let mut list: Vec<u8> = Vec::new();
        for path in &writes {
            list.extend_from_slice(path.as_bytes());
            list.push(0);
        }
        let checkout = run_indexed(
            &repo,
            &temp,
            os_args(["checkout-index", "-f", "-z", "--stdin"]),
            Some(list),
        )?;
        if let Err(error) = ensure_success(&checkout, "git checkout-index failed") {
            return Ok(partial_report(
                report,
                RestoreFailureStage::Writes,
                format!(
                    "{error}; the safety ref is retained and write effects are not known exactly"
                ),
            ));
        }
        report.written = writes.len() as u32;
        touched.extend(writes.iter().cloned());
    }

    touched.sort();
    touched.dedup();
    if !touched.is_empty() {
        report.index_synced = sync_index_to_head(&repo, &admin, &touched);
        if !report.index_synced {
            return Ok(partial_report(
                report,
                RestoreFailureStage::IndexSync,
                "the working files were restored but the index entries could not be reset; the safety ref is retained"
                    .into(),
            ));
        }
    }
    report.restored = true;
    Ok(report)
}

fn partial_report(
    mut report: ManualRestoreReport,
    stage: RestoreFailureStage,
    failure: String,
) -> ManualRestoreReport {
    report.restored = false;
    report.partial = true;
    report.failure = Some(failure);
    report.failure_stage = Some(stage);
    report.retry_requires_fresh_preview = true;
    report
}

/// Restores captured content after a fresh preview and a required safety
/// capture. Never moves HEAD; index entries of touched paths are reset to HEAD,
/// which is disclosed rather than presented as a restored index.
pub fn restore_manual(
    registry: &WorkspaceRegistry,
    worktree: &str,
    reference: &str,
    expected_fingerprint: Option<&str>,
    force: bool,
    workspace: &WorkspaceEnv,
) -> Result<ManualRestoreReport> {
    restore_manual_inner(
        registry,
        worktree,
        reference,
        expected_fingerprint,
        force,
        workspace,
        RestoreHooks::default(),
    )
}

#[cfg(test)]
pub(crate) fn restore_manual_with_hooks(
    registry: &WorkspaceRegistry,
    worktree: &str,
    reference: &str,
    expected_fingerprint: Option<&str>,
    force: bool,
    workspace: &WorkspaceEnv,
    hooks: RestoreHooks,
) -> Result<ManualRestoreReport> {
    restore_manual_inner(
        registry,
        worktree,
        reference,
        expected_fingerprint,
        force,
        workspace,
        hooks,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(path: &str, status: FileStatus) -> DiffFileSummary {
        DiffFileSummary {
            path: path.into(),
            old_path: None,
            status,
            added: 0,
            removed: 0,
            binary: false,
            submodule: false,
            symlink: false,
            approximate: false,
        }
    }

    #[test]
    fn parses_checkpoint_listing_in_turn_order() {
        let prefix = refs::checkpoint_prefix();
        let listing = format!(
            "{prefix}t1/10\u{0}c10\u{0}tree10\u{0}p10\u{0}1700000010\n\
             {prefix}t1/2\u{0}c2\u{0}tree2\u{0}\u{0}1700000002\n\
             {prefix}t1/x\u{0}bad\u{0}\u{0}\u{0}0\n"
        );
        let infos = parse_checkpoint_list(listing.as_bytes());
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].turn, 2);
        assert_eq!(infos[0].parent, None);
        assert_eq!(infos[1].turn, 10);
        assert_eq!(infos[1].parent.as_deref(), Some("p10"));
        assert_eq!(infos[1].created_at_secs, 1_700_000_010);
        assert_eq!(infos[1].task_id, "t1");
    }

    #[test]
    fn restore_paths_must_stay_inside_the_worktree() {
        for ok in [
            "a.txt",
            "dir/sub/file.rs",
            "caf\u{e9}/x y.txt",
            ".github/workflows/ci.yml",
        ] {
            assert!(is_safe_restore_path(ok), "{ok}");
        }
        for bad in [
            "",
            "/etc/passwd",
            "../x",
            "a/../x",
            "a//b",
            ".git/config",
            "sub/.git/hooks/pre-commit",
            "sub/.GIT/x",
            "a\\b",
            "a\nb",
            "./a",
        ] {
            assert!(!is_safe_restore_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn plan_writes_additions_and_edits_deletes_extras_and_skips_the_rest() {
        let mut sub = change("vendor/lib", FileStatus::Modified);
        sub.submodule = true;
        let plan = plan_restore(&[
            change("only-in-checkpoint.txt", FileStatus::Added),
            change("edited.txt", FileStatus::Modified),
            change("created-since.txt", FileStatus::Deleted),
            change("swapped", FileStatus::TypeChanged),
            change("../escape", FileStatus::Added),
            change("conflict.txt", FileStatus::Unmerged),
            sub,
        ]);
        assert_eq!(
            plan.writes,
            vec!["only-in-checkpoint.txt", "edited.txt", "swapped"]
        );
        assert_eq!(plan.deletes, vec!["created-since.txt", "swapped"]);
        let reasons: Vec<_> = plan.skipped.iter().map(|s| s.reason.as_str()).collect();
        assert_eq!(
            reasons,
            vec!["unsafe-path", "unsupported-change", "submodule"]
        );
    }

    #[test]
    fn the_vanished_file_is_read_out_of_gits_error() {
        assert_eq!(
            vanished_path("fatal: unable to stat 'dir/a b.txt': No such file or directory\n"),
            Some("dir/a b.txt".to_string())
        );
        assert_eq!(
            vanished_path("fatal: unable to stat 'it's': here.txt': No such file or directory"),
            Some("it's': here.txt".to_string())
        );
        assert_eq!(
            vanished_path("fatal: pathspec 'x' did not match any files"),
            None
        );
        assert_eq!(vanished_path(""), None);
    }

    #[test]
    fn unreadable_files_are_read_out_of_gits_error_lines() {
        let stderr = "error: short read while indexing src/f18.txt\nerror: src/f18.txt: failed to insert into database\nerror: unable to index file 'src/f18.txt'\nerror: open(\"x\"): Permission denied\nerror: unable to index file 'x'\n";
        assert_eq!(unindexed_paths(stderr), vec!["src/f18.txt", "x"]);
        assert!(unindexed_paths("").is_empty());
    }

    const SOME_ID: &str = "0123456789abcdef0123456789abcdef";
    const OTHER_ID: &str = "fedcba9876543210fedcba9876543210";

    fn no_hard_links(_: &Path, _: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "this file system has no hard links",
        ))
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn the_worktree_id_is_published_by_hard_link_when_the_file_system_has_them() {
        let dir = tempfile::tempdir().unwrap();
        publish_worktree_id(dir.path(), SOME_ID, &|from, to| std::fs::hard_link(from, to)).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(WORKTREE_ID_FILE)).unwrap(),
            SOME_ID
        );
        assert_eq!(names_in(dir.path()), vec![WORKTREE_ID_FILE.to_string()]);
    }

    #[test]
    fn the_worktree_id_is_created_exclusively_where_hard_links_fail() {
        let dir = tempfile::tempdir().unwrap();
        publish_worktree_id(dir.path(), SOME_ID, &no_hard_links).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(WORKTREE_ID_FILE)).unwrap(),
            SOME_ID
        );
        assert_eq!(
            names_in(dir.path()),
            vec![WORKTREE_ID_FILE.to_string()],
            "the staging file is cleaned up"
        );

        // Never replaces an id another caller published first, on either path.
        publish_worktree_id(dir.path(), OTHER_ID, &no_hard_links).unwrap();
        publish_worktree_id(dir.path(), OTHER_ID, &|from, to| std::fs::hard_link(from, to)).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(WORKTREE_ID_FILE)).unwrap(),
            SOME_ID
        );
        assert_eq!(names_in(dir.path()), vec![WORKTREE_ID_FILE.to_string()]);
    }

    #[test]
    fn publishing_the_worktree_id_reports_a_directory_it_cannot_write() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-there");
        assert!(publish_worktree_id(&missing, SOME_ID, &no_hard_links).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_index_copy_is_dated_like_the_original_and_made_owner_writable_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("index");
        let copy = dir.path().join("copy");
        std::fs::write(&real, "index bytes").unwrap();
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&real)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o444)).unwrap();
        std::fs::copy(&real, &copy).unwrap();
        assert_eq!(
            std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777,
            0o444,
            "the copy of a read-only file is read-only"
        );

        keep_modification_time(&real, &copy).unwrap();
        assert_eq!(std::fs::metadata(&copy).unwrap().modified().unwrap(), long_ago);
        assert_eq!(
            std::fs::metadata(&copy).unwrap().permissions().mode() & 0o777,
            0o644,
            "only the owner's write bit was added"
        );
    }

    #[test]
    fn dating_a_copy_after_a_missing_original_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("copy");
        std::fs::write(&copy, "x").unwrap();
        assert!(keep_modification_time(&dir.path().join("index"), &copy).is_err());
    }

    #[test]
    fn limits_serialize_as_explicit_flags() {
        let json = serde_json::to_value(&LIMITS).unwrap();
        assert_eq!(json["atomic"], false);
        assert_eq!(json["capturesIgnoredFiles"], false);
        assert_eq!(json["capturesSubmoduleContents"], false);
        assert_eq!(json["capturesIndexState"], false);
    }

    #[test]
    fn checkpoint_info_serializes_the_ref_under_its_real_name() {
        let info = CheckpointInfo {
            ref_name: refs::checkpoint_ref("t", 1),
            task_id: "t".into(),
            turn: 1,
            commit: "c".into(),
            tree: "t".into(),
            parent: None,
            created_at_secs: 5,
            worktree_id: Some("abc".into()),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["ref"], refs::checkpoint_ref("t", 1));
        assert_eq!(json["createdAtSecs"], 5);
        assert!(
            json.get("worktreeId").is_none(),
            "internal field stays internal"
        );
    }
}

//! Neutral file-access primitives shared by every retained native consumer.
//!
//! The native layer has four distinct trust tiers; this module owns the
//! primitives of the strictest one without owning any AI-only policy:
//!
//! 1. Explicit user editing (`fs_read_file`/`fs_write_file`/`fs_stat`/…) — no
//!    authorization, no secret policy. Never route it through this module.
//! 2. Root-confined structural mutation (`fs_move`, `fs_delete_batch`,
//!    `fs_copy`, control `open`, shell cwd) — `workspace::WorkspaceRegistry`
//!    only.
//! 3. Automatic preview assets (`fs::assets`) — grant + containment + secret
//!    policy + fd check.
//! 4. Automatic agent reads (`fs::ai`) — [`authorize_read`] composes the secret
//!    policy on the literal path, the canonical path and the registry, then
//!    pins the descriptor with [`opened_path`]/[`open_read_file`] so a swapped
//!    symlink cannot change what is read.
//!
//! `fs::ai` is the AI-owned consumer that will be deleted with the agent; the
//! retained consumers of this module are `fs::assets` (descriptor identity)
//! and `fs::access_policy` (policy data), both neutral.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::access_policy::readable;
use crate::modules::workspace::WorkspaceRegistry;

/// Stable IPC text for "this path does not exist yet"; callers distinguish a
/// creatable path from an access failure, so it must not fold into other I/O
/// errors.
pub(super) fn path_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "file not found".into()
    } else {
        error.to_string()
    }
}

/// The composed read guard: secret policy on the literal path *and* on the
/// canonical path (so a symlink at an innocent name cannot point into a
/// protected directory), then the workspace registry.
pub(super) fn authorize_read(
    registry: &WorkspaceRegistry,
    path: &Path,
) -> Result<PathBuf, String> {
    readable(path)?;
    let canonical = std::fs::canonicalize(path).map_err(path_error)?;
    readable(&canonical)?;
    if !registry.is_authorized(&canonical) {
        return Err("path is outside the authorized workspace".into());
    }
    Ok(canonical)
}

/// The path the descriptor actually refers to. Checking this instead of the
/// requested path closes the check-then-open race.
pub(super) fn opened_path(file: &File) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let mut buffer = [0u8; libc::PATH_MAX as usize];
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let end = buffer
            .iter()
            .position(|&byte| byte == 0)
            .ok_or("invalid path")?;
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end])))
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
        let mut buffer = vec![0u16; 32768];
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                0,
            )
        } as usize;
        if len == 0 || len >= buffer.len() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len])))
    }
}

/// Reopens the pinned descriptor for reading without following the path again.
#[cfg(target_os = "linux")]
pub(super) fn reopen_regular(file: &File) -> Result<File, String> {
    use std::os::fd::AsRawFd;
    if !file.metadata().map_err(path_error)?.is_file() {
        return Err("reads require a regular file".into());
    }
    File::open(format!("/proc/self/fd/{}", file.as_raw_fd())).map_err(path_error)
}

/// Opens a descriptor for [`opened_path`]: on Linux the path is pinned with
/// `O_PATH` first, so a FIFO or device is never given a data open.
pub(super) fn open_read_file(path: &Path) -> Result<File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        options.custom_flags(libc::O_PATH);
        #[cfg(not(target_os = "linux"))]
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(path_error)?;
    #[cfg(target_os = "linux")]
    {
        // Pin without opening a device, then reopen that same regular inode for reading.
        reopen_regular(&file)
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(file)
    }
}

/// Reads at most `limit + 1` bytes so the caller can detect an oversized file
/// without trusting the metadata size alone.
pub(super) fn read_bounded_regular(file: &File, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_read_allows_a_granted_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("src").join("main.ts");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "SYNTHETIC_SOURCE").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();

        let authorized = authorize_read(&registry, &path).unwrap();
        assert_eq!(authorized, std::fs::canonicalize(&path).unwrap());
    }

    #[test]
    fn authorize_read_refuses_an_unauthorized_root() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("customer.csv");
        std::fs::write(&path, "SYNTHETIC_PRIVATE_DATA").unwrap();
        let registry = WorkspaceRegistry::default();

        let error = authorize_read(&registry, &path).unwrap_err();
        assert!(error.contains("outside the authorized workspace"), "{error}");
    }

    #[test]
    fn authorize_read_refuses_sensitive_basenames_inside_a_granted_root() {
        let dir = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();
        for name in [".env", "key.pem", "service-account.json"] {
            let path = dir.path().join(name);
            std::fs::write(&path, "SYNTHETIC_SECRET").unwrap();
            assert!(authorize_read(&registry, &path).is_err(), "{name}");
        }
    }

    #[test]
    fn authorize_read_refuses_a_protected_directory_inside_a_granted_root() {
        let dir = tempfile::tempdir().unwrap();
        let protected = dir.path().join(".git");
        std::fs::create_dir(&protected).unwrap();
        let path = protected.join("config");
        std::fs::write(&path, "SYNTHETIC_REPOSITORY_STATE").unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();

        assert!(authorize_read(&registry, &path).is_err());
    }

    #[test]
    fn only_missing_paths_report_the_creatable_distinction() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        let registry = WorkspaceRegistry::default();
        assert_eq!(authorize_read(&registry, &path).unwrap_err(), "file not found");
        std::fs::write(&path, "existing").unwrap();
        // Any other failure must not read as "you may create this".
        assert_ne!(authorize_read(&registry, &path).unwrap_err(), "file not found");
        assert_ne!(
            path_error(std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            "file not found"
        );
        registry.authorize(dir.path()).unwrap();
        assert!(authorize_read(&registry, &path).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reopening_a_pinned_regular_file_does_not_follow_a_replaced_path() {
        use std::os::unix::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        std::fs::write(&path, "original").unwrap();
        let pinned = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH)
            .open(&path)
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        let replacement = dir.path().join("replacement.txt");
        std::fs::write(&replacement, "replacement").unwrap();
        std::os::unix::fs::symlink(&replacement, &path).unwrap();
        let mut actual = String::new();
        reopen_regular(&pinned)
            .unwrap()
            .read_to_string(&mut actual)
            .unwrap();
        assert_eq!(actual, "original");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fifo_is_never_given_a_data_open() {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::OpenOptionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pipe");
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        assert!(fd >= 0);
        let mut events = unsafe { std::fs::File::from_raw_fd(fd) };
        assert!(
            unsafe { libc::inotify_add_watch(events.as_raw_fd(), c_path.as_ptr(), libc::IN_OPEN) }
                >= 0
        );
        let mut bytes = [0u8; 4096];
        // Positive control: a plain nonblocking read-open activates the FIFO.
        drop(
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(&path)
                .unwrap(),
        );
        assert!(events.read(&mut bytes).unwrap() > 0);
        assert!(open_read_file(&path).is_err());
        assert_eq!(
            events.read(&mut bytes).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[cfg(unix)]
    #[test]
    fn authorize_read_refuses_links_that_resolve_into_a_refused_path() {
        let dir = tempfile::tempdir().unwrap();
        let registry = WorkspaceRegistry::default();
        registry.authorize(dir.path()).unwrap();
        let link = dir.path().join("innocent.txt");

        // A link that leaves every authorized root.
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        assert!(authorize_read(&registry, &link).is_err());
        std::fs::remove_file(&link).unwrap();

        // A link whose name is harmless but whose target is a secret file.
        let secret = dir.path().join(".env");
        std::fs::write(&secret, "SYNTHETIC_SECRET").unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let error = authorize_read(&registry, &link).unwrap_err();
        assert!(error.contains("sensitive"), "{error}");
    }
}

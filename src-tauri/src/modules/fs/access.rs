//! Neutral file-access primitives shared by every retained native consumer.
//!
//! The native layer has three distinct trust tiers:
//!
//! 1. Explicit user editing (`fs_read_file`/`fs_write_file`/`fs_stat`/…) — no
//!    authorization, no secret policy. Never route it through this module.
//! 2. Root-confined structural mutation (`fs_move`, `fs_delete_batch`,
//!    `fs_copy`, control `open`, shell cwd) — `workspace::WorkspaceRegistry`
//!    only.
//! 3. Automatic preview assets (`fs::assets`) — grant + containment + secret
//!    policy + descriptor identity.
//!
//! [`opened_path`] belongs to tier 3: it pins *which* file a descriptor refers
//! to so a path swapped between the containment check and the read cannot
//! change what is served. Its owner is `fs::assets`; there is no other caller.

use std::fs::File;
use std::path::PathBuf;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn the_opened_descriptor_names_the_file_it_was_opened_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("asset.png");
        fs::write(&path, b"PNG").unwrap();
        let file = fs::File::open(&path).unwrap();
        assert_eq!(
            opened_path(&file).unwrap(),
            fs::canonicalize(&path).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_path_does_not_change_what_the_descriptor_names() {
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        fs::write(&path, "original").unwrap();
        let mut file = fs::File::open(&path).unwrap();

        fs::remove_file(&path).unwrap();
        let replacement = dir.path().join("replacement.txt");
        fs::write(&replacement, "replacement").unwrap();
        std::os::unix::fs::symlink(&replacement, &path).unwrap();

        assert_ne!(
            opened_path(&file).unwrap(),
            fs::canonicalize(&path).unwrap(),
            "the descriptor must not be reported as the replacement"
        );
        let mut actual = String::new();
        file.read_to_string(&mut actual).unwrap();
        assert_eq!(actual, "original");
    }
}

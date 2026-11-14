//! Secret-path policy shared by automatic preview assets.
//!
//! The data lives in the frontend tree because the TS guard and this native
//! guard must agree on the exact same list:
//! `src/modules/workspace/pathPolicy.json` (owner: `src/modules/workspace`).
//! Retained consumer: `fs::assets` (Markdown/media preview).
//!
//! This module is deliberately *not* enough on its own: callers must also check
//! the canonical (post-symlink) path, which `fs::assets::respond` does.

use regex::RegexSetBuilder;
use serde::Deserialize;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathPolicy {
    secret_basenames: Vec<String>,
    protected_dirs: Vec<String>,
}

pub(crate) fn readable(path: &Path) -> Result<(), String> {
    // This fork's control directory holds a live credential, and so does the upstream
    // application's: both are refused, which keeps the denylist in sync with whatever
    // name the identity table gives the fork (see `modules::identity`).
    for directory in [
        crate::modules::identity::cache_dir(),
        crate::modules::identity::upstream_cache_dir(),
    ]
    .into_iter()
    .flatten()
    {
        deny_runtime_directory(path, &directory)?;
    }
    static POLICY: OnceLock<(regex::RegexSet, Vec<String>)> = OnceLock::new();
    let (patterns, directories) = POLICY.get_or_init(|| {
        let policy: PathPolicy = serde_json::from_str(include_str!(
            "../../../../src/modules/workspace/pathPolicy.json"
        ))
        .expect("valid path policy");
        (
            RegexSetBuilder::new(policy.secret_basenames)
                .case_insensitive(true)
                .build()
                .expect("valid secret patterns"),
            policy.protected_dirs,
        )
    });
    let path = path.to_str().ok_or("refused non-UTF-8 path")?;
    if path.is_empty() || path.chars().any(|c| c < ' ') {
        return Err("refused invalid path".into());
    }
    let normalized = path.replace('\\', "/");
    let basename = normalized.rsplit('/').next().unwrap_or("");
    if patterns.is_match(&basename.replace('\u{feff}', " ")) {
        return Err("refused sensitive file".into());
    }
    let comparison = normalized
        .split('/')
        .map(|part| {
            part.split(':')
                .next()
                .unwrap_or("")
                .trim_end_matches(|c: char| c == '.' || c == '\u{feff}' || c.is_whitespace())
                .to_lowercase()
        })
        .collect::<Vec<_>>()
        .join("/");
    let comparison = format!("{comparison}/");
    if directories
        .iter()
        .any(|dir| comparison.contains(&format!("{dir}/")))
    {
        return Err("refused protected directory".into());
    }
    Ok(())
}

fn inside_directory(path: &Path, directory: &Path) -> bool {
    #[cfg(windows)]
    {
        windows_inside_directory(path, directory)
    }
    #[cfg(not(windows))]
    {
        path.starts_with(directory)
    }
}

#[cfg(any(windows, test))]
fn windows_inside_directory(path: &Path, directory: &Path) -> bool {
    let (Some(path), Some(directory)) = (path.to_str(), directory.to_str()) else {
        return false;
    };
    Path::new(&super::strip_verbatim(path)).starts_with(super::strip_verbatim(directory))
}

fn deny_runtime_directory(path: &Path, directory: &Path) -> Result<(), String> {
    if inside_directory(path, directory)
        || std::fs::canonicalize(directory)
            .is_ok_and(|canonical| inside_directory(path, &canonical))
    {
        return Err("refused application credential directory".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relocated_runtime_credentials_are_protected() {
        let tmp = tempfile::tempdir().unwrap();
        let relocated = tmp.path().join("custom-cache").join("terax");
        std::fs::create_dir_all(&relocated).unwrap();
        let actual = std::fs::canonicalize(&relocated).unwrap();
        assert!(deny_runtime_directory(&actual.join("control.json"), &relocated).is_err());
        assert!(deny_runtime_directory(&actual.join("control.json.tmp-abc"), &relocated).is_err());
        assert!(deny_runtime_directory(&tmp.path().join("source.ts"), &relocated).is_ok());
        #[cfg(unix)]
        {
            let alias = tmp.path().join("cache-alias");
            std::os::unix::fs::symlink(&relocated, &alias).unwrap();
            assert!(deny_runtime_directory(&actual.join("control.json"), &alias).is_err());
        }
    }

    #[test]
    fn windows_runtime_paths_match_across_verbatim_prefixes() {
        for (path, directory) in [
            (r"C:\project\state\control.json", r"\\?\C:\project\state"),
            (r"\\?\C:\project\state\control.json", r"C:\project\state"),
            (
                r"\\server\share\state\control.json",
                r"\\?\UNC\server\share\state",
            ),
        ] {
            assert!(windows_inside_directory(
                Path::new(path),
                Path::new(directory)
            ));
        }
        assert!(!windows_inside_directory(
            Path::new("C:/project/state-other/file"),
            Path::new("C:/project/state")
        ));
        assert!(!windows_inside_directory(
            Path::new("//wsl.localhost/Ubuntu/home/me/State/file"),
            Path::new("//wsl.localhost/Ubuntu/home/me/state")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_relocated_cache_is_denied_after_opened_path_normalization() {
        use std::os::windows::process::CommandExt;
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp
            .path()
            .join("authorized-project")
            .join("application-state");
        let alias = tmp.path().join("relocated-cache").join("terax");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(alias.parent().unwrap()).unwrap();
        std::fs::write(target.join("control.json"), "SYNTHETIC_CREDENTIAL").unwrap();
        // Quote fixture paths for cmd; percent expansion cannot be quoted away.
        for path in [&alias, &target] {
            assert!(!path.to_str().unwrap().contains(['%', '"', '\r', '\n']));
        }
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/V:OFF", "/C"])
            .raw_arg(format!(
                "mklink /J \"{}\" \"{}\"",
                alias.display(),
                target.display()
            ))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let actual = std::fs::canonicalize(target.join("control.json")).unwrap();
        let opened = std::path::PathBuf::from(super::super::to_canon(actual));
        assert!(deny_runtime_directory(&opened, &alias).is_err());
        std::fs::remove_dir(alias).unwrap();
    }

    #[test]
    fn shared_policy_protects_secrets_and_control_descriptors() {
        for path in [
            "/repo/.env",
            "/repo/file.pem",
            "/repo/.git/config",
            "/Users/me/Library/Caches/terax/control.json",
            "/home/me/.cache/terax/control.json",
            "C:/Users/me/AppData/Local/terax/control.json",
            "//wsl.localhost/Ubuntu/home/me/.ssh/id_rsa",
            "/home/me/.local/share/codr/space-profiles/sp-a/opencode/data/opencode/opencode.db",
            "/home/me/.local/share/opencode/auth.json",
            "/home/me/.config/opencode/service.json",
        ] {
            assert!(readable(Path::new(path)).is_err(), "{path}");
        }
        for path in ["/repo/src/main.ts", "/repo/environment.ts", "/repo/.envoy"] {
            assert!(readable(Path::new(path)).is_ok(), "{path}");
        }
    }

    #[test]
    fn javascript_bom_whitespace_is_also_sensitive_natively() {
        for path in [
            "/repo/.env\u{feff}x",
            "/repo/.ssh\u{feff}/key",
            "/repo/secrets.json.tmp-abc",
        ] {
            assert!(readable(Path::new(path)).is_err(), "{path}");
        }
        assert!(readable(Path::new("/repo/environment.ts")).is_ok());
    }
}

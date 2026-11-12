//! AI-only reader/search tools. The access primitives it composes live in
//! `fs::access`; only the hidden-entry walk and the command surface are AI.

use std::path::Path;

use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use tauri::Manager;

use super::access::{authorize_read, opened_path, open_read_file, read_bounded_regular};
use super::access_policy::readable;
use super::file::ReadResult;
use super::grep::{GlobHit, GlobResponse, GrepHit, GrepResponse};
use super::tree::DirEntry;
use crate::modules::workspace::{resolve_path, WorkspaceEnv, WorkspaceRegistry};

fn authorized(registry: &WorkspaceRegistry, path: &Path) -> Result<std::path::PathBuf, String> {
    authorize_read(registry, path)
}

pub fn read_file(
    registry: &WorkspaceRegistry,
    path: &Path,
    limit: u64,
) -> Result<ReadResult, String> {
    let path = authorized(registry, path)?;
    let file = open_read_file(&path)?;
    let actual = opened_path(&file)?;
    readable(&actual)?;
    if !registry.is_authorized(&actual) {
        return Err("opened file is outside the authorized workspace".into());
    }
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("AI reads require a regular file".into());
    }
    if meta.len() > limit {
        return Ok(ReadResult::TooLarge {
            size: meta.len(),
            limit,
        });
    }
    let bytes = read_bounded_regular(&file, limit)?;
    let size = bytes.len() as u64;
    if size > limit {
        return Ok(ReadResult::TooLarge { size, limit });
    }
    if bytes.contains(&0) {
        return Ok(ReadResult::Binary { size });
    }
    Ok(match String::from_utf8(bytes) {
        Ok(content) => ReadResult::Text {
            revision: super::save::DiskRevision::of_bytes(content.as_bytes(), &meta).to_opaque(),
            content,
            size,
            mtime: 0,
        },
        Err(_) => ReadResult::Binary { size },
    })
}

#[tauri::command]
pub async fn ai_read_file(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<ReadResult, String> {
    super::blocking(move || {
        read_file(
            &app.state::<WorkspaceRegistry>(),
            &resolve_path(&path, &WorkspaceEnv::from_option(workspace)),
            10 * 1024 * 1024,
        )
    })
    .await
}

#[tauri::command]
pub async fn ai_read_dir(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<Vec<DirEntry>, String> {
    super::blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let path = authorized(
            &registry,
            &resolve_path(&path, &WorkspaceEnv::from_option(workspace)),
        )?;
        let entries = super::tree::read_dir_entries(
            super::to_canon(&path),
            false,
            None,
            Some(WorkspaceEnv::Local),
        )?;
        Ok(entries
            .into_iter()
            .filter(|entry| authorized(&registry, &path.join(&entry.name)).is_ok())
            .collect())
    })
    .await
}

fn walk(registry: &WorkspaceRegistry, root: &Path) -> Result<ignore::Walk, String> {
    let root = authorized(registry, root)?;
    if !root.is_dir() {
        return Err("AI search root must be a directory".into());
    }
    Ok(WalkBuilder::new(root)
        .hidden(true)
        .follow_links(false)
        .filter_entry(|entry| readable(entry.path()).is_ok())
        .build())
}

#[tauri::command]
pub async fn ai_glob(
    app: tauri::AppHandle,
    pattern: String,
    root: String,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GlobResponse, String> {
    super::blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let workspace = WorkspaceEnv::from_option(workspace);
        let root_path = authorized(&registry, &resolve_path(&root, &workspace))?;
        let matcher = Glob::new(&pattern)
            .map_err(|e| e.to_string())?
            .compile_matcher();
        let cap = max_results.unwrap_or(500).clamp(1, 2000);
        let mut hits = Vec::new();
        let mut truncated = false;
        for entry in walk(&registry, &root_path)?.flatten() {
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&root_path) else {
                continue;
            };
            if !matcher.is_match(rel) || authorized(&registry, entry.path()).is_err() {
                continue;
            }
            if hits.len() == cap {
                truncated = true;
                break;
            }
            hits.push(GlobHit {
                path: super::display_path(entry.path(), &root_path, &root, &workspace),
                rel: super::to_canon(rel),
            });
        }
        Ok(GlobResponse { hits, truncated })
    })
    .await
}

fn matching_lines<'a>(
    content: &'a str,
    matcher: &'a regex::Regex,
) -> impl Iterator<Item = (usize, &'a str)> + 'a {
    content
        .split_terminator('\n')
        .enumerate()
        .filter(|(_, text)| matcher.is_match(text))
}

fn clip_line(text: &str) -> String {
    let mut chars = text.chars();
    let prefix: String = chars.by_ref().take(160).collect();
    let remaining = chars.count();
    if remaining == 0 {
        prefix
    } else {
        format!("{prefix}…[+{remaining}]")
    }
}

#[tauri::command]
pub async fn ai_grep(
    app: tauri::AppHandle,
    pattern: String,
    root: String,
    glob: Option<Vec<String>>,
    case_insensitive: Option<bool>,
    max_results: Option<usize>,
    workspace: Option<WorkspaceEnv>,
) -> Result<GrepResponse, String> {
    super::blocking(move || {
        let registry = app.state::<WorkspaceRegistry>();
        let workspace = WorkspaceEnv::from_option(workspace);
        let root_path = authorized(&registry, &resolve_path(&root, &workspace))?;
        let matcher = RegexBuilder::new(&pattern)
            .case_insensitive(case_insensitive.unwrap_or(false))
            .build()
            .map_err(|e| e.to_string())?;
        let mut globs = GlobSetBuilder::new();
        for pattern in glob.unwrap_or_default() {
            globs.add(Glob::new(&pattern).map_err(|e| e.to_string())?);
        }
        let globs = globs.build().map_err(|e| e.to_string())?;
        let cap = max_results.unwrap_or(200).clamp(1, 2000);
        let mut hits = Vec::new();
        let mut files_scanned = 0;
        let mut truncated = false;
        'files: for entry in walk(&registry, &root_path)?.flatten() {
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&root_path) else {
                continue;
            };
            if !globs.is_empty() && !globs.is_match(rel) {
                continue;
            }
            let Ok(ReadResult::Text { content, .. }) =
                read_file(&registry, entry.path(), 5 * 1024 * 1024)
            else {
                continue;
            };
            files_scanned += 1;
            for (line, text) in matching_lines(&content, &matcher) {
                if hits.len() == cap {
                    truncated = true;
                    break 'files;
                }
                hits.push(GrepHit {
                    path: super::display_path(entry.path(), &root_path, &root, &workspace),
                    rel: super::to_canon(rel),
                    line: (line + 1) as u64,
                    text: clip_line(text),
                });
            }
        }
        Ok(GrepResponse {
            hits,
            truncated,
            files_scanned,
            cancelled: false,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grep_has_no_phantom_lines_and_bounds_native_hit_text() {
        let empty = regex::Regex::new("^$").unwrap();
        assert_eq!(matching_lines("hello\n", &empty).count(), 0);
        assert_eq!(matching_lines("", &empty).count(), 0);
        assert_eq!(
            matching_lines("\n", &empty).collect::<Vec<_>>(),
            vec![(0, "")]
        );
        assert_eq!(clip_line("short"), "short");
        let text = "界".repeat(1_000_000);
        assert_eq!(clip_line(&text), format!("{}…[+999840]", "界".repeat(160)));
    }

    #[test]
    fn ungranted_files_and_search_roots_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("customer.csv");
        std::fs::write(&path, "SYNTHETIC_PRIVATE_DATA").unwrap();
        let registry = WorkspaceRegistry::default();
        assert!(read_file(&registry, &path, 1024).is_err());
        assert!(walk(&registry, dir.path()).is_err());
        registry.authorize(dir.path()).unwrap();
        assert!(
            matches!(read_file(&registry, &path, 1024).unwrap(), ReadResult::Text { content, .. } if content == "SYNTHETIC_PRIVATE_DATA")
        );
        let secret = dir.path().join("secret.pem");
        std::fs::write(&secret, "SYNTHETIC_SECRET").unwrap();
        assert!(read_file(&registry, &secret, 1024).is_err());
        assert!(!walk(&registry, dir.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.path() == secret));
    }

}

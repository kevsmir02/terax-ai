//! Manual checkpoints through the native command seam, against real scratch
//! repositories: identity, worktree ownership, capture disclosure, inspection
//! and explicit grouped cleanup.
//!
//! A manual checkpoint is created without any agent task, turn or hook; it is
//! addressed by its own id and lives until a caller names it for deletion.

use std::path::Path;

use crate::modules::git::checkpoint::{self, RecoveryKind};
use crate::modules::git::testutil::{git_command, git_in, scratch, TestRepo};

fn refs_of(repo: &TestRepo) -> Vec<String> {
    repo.git(&["for-each-ref", "--format=%(refname)"])
        .lines()
        .map(str::to_string)
        .collect()
}

fn missing_in(repo: &TestRepo, spec: &str) -> bool {
    !git_command(&repo.root, &["cat-file", "-e", spec])
        .status()
        .expect("run git cat-file")
        .success()
}

fn head(repo: &TestRepo) -> String {
    repo.git(&["rev-parse", "HEAD"])
}

/// The user's index, byte for byte, as `git ls-files --stage` prints it.
fn index(repo: &TestRepo) -> String {
    repo.git(&["ls-files", "--stage"])
}

fn status(repo: &TestRepo) -> String {
    repo.git(&["status", "--porcelain"])
}

#[test]
fn a_manual_checkpoint_captures_tracked_and_nonignored_files_without_moving_head_or_the_index() {
    let repo = TestRepo::new();
    repo.write(".gitignore", "ignored/\n*.log\n");
    repo.write("tracked.txt", "base\n");
    repo.commit_all("base");
    // Everything below is what the checkpoint must see or disclose.
    repo.write("tracked.txt", "edited\n");
    repo.write("src/new.txt", "new\n");
    repo.write("ignored/secret.txt", "never captured\n");
    repo.write("debug.log", "never captured\n");
    repo.write("staged.txt", "staged\n");
    repo.git(&["add", "staged.txt"]);

    let head_before = head(&repo);
    let index_before = index(&repo);
    let status_before = status(&repo);
    let refs_before = refs_of(&repo);

    let created = checkpoint::create_manual(
        &repo.registry,
        &repo.path(),
        Some("  before refactor  "),
        &repo.ws,
    )
    .expect("create a manual checkpoint");

    assert_eq!(created.checkpoint.name.as_deref(), Some("before refactor"));
    assert_eq!(created.checkpoint.id.len(), 32);
    assert!(created.checkpoint.id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(
        created.checkpoint.ref_name,
        format!(
            "refs/codr/manual-checkpoints/{}",
            created.checkpoint.id
        )
    );
    assert_eq!(
        created.checkpoint.parent.as_deref(),
        Some(head_before.trim())
    );
    assert!(created.checkpoint.created_at_secs > 0);
    assert!(!created.limits.atomic);
    assert!(!created.limits.captures_ignored_files);
    assert!(!created.limits.captures_submodule_contents);
    assert!(!created.limits.captures_index_state);

    // Creation writes a ref and objects only: HEAD, the real index and the
    // working tree are exactly where the user left them.
    assert_eq!(head(&repo), head_before);
    assert_eq!(index(&repo), index_before);
    assert_eq!(status(&repo), status_before);
    let mut refs_after = refs_of(&repo);
    refs_after.retain(|name| !created.checkpoint.ref_name.eq(name));
    assert_eq!(refs_after, refs_before);

    // Tracked and non-ignored untracked contents are in the tree; ignored ones
    // never are.
    let show = |spec: &str| repo.git(&["show", &format!("{}:{spec}", created.checkpoint.commit)]);
    assert_eq!(show("tracked.txt"), "edited\n");
    assert_eq!(show("src/new.txt"), "new\n");
    assert_eq!(show("staged.txt"), "staged\n");
    assert!(missing_in(
        &repo,
        &format!("{}:ignored/secret.txt", created.checkpoint.commit)
    ));
    assert!(missing_in(
        &repo,
        &format!("{}:debug.log", created.checkpoint.commit)
    ));

    // The exclusions and the staging state are part of the result, not implied.
    let capture = created
        .checkpoint
        .capture
        .as_ref()
        .expect("a capture record");
    assert_eq!(
        capture.ignored_files, 2,
        "the ignored directory and the log"
    );
    assert!(!capture.ignored_truncated);
    assert_eq!(capture.staged_files, 1, "staged.txt");
    assert!(!capture.staged_truncated);
    assert_eq!(capture.submodules, 0);
    assert!(!capture.incomplete, "nothing was skipped or unstable");
    assert!(capture.warnings.is_empty());
}

#[test]
fn creating_the_same_named_checkpoint_twice_keeps_two_distinct_refs() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.commit_all("base");
    repo.write("a.txt", "two\n");

    let first =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("duplicate"), &repo.ws)
            .unwrap();
    let second =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("duplicate"), &repo.ws)
            .unwrap();

    assert_ne!(first.checkpoint.id, second.checkpoint.id);
    assert_ne!(first.checkpoint.ref_name, second.checkpoint.ref_name);
    assert_eq!(first.checkpoint.tree, second.checkpoint.tree);
    assert!(refs_of(&repo).contains(&first.checkpoint.ref_name));
    assert!(refs_of(&repo).contains(&second.checkpoint.ref_name));

    let groups = checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws).unwrap();
    assert_eq!(groups.manual.len(), 2);
    assert!(groups
        .manual
        .iter()
        .all(|checkpoint| checkpoint.name.as_deref() == Some("duplicate")));
    assert_eq!(groups.storage.owned_refs, 2);
}

#[test]
fn each_worktree_owns_only_its_own_recovery_refs_and_cleanup_refuses_the_rest() {
    let repo = TestRepo::new();
    repo.write("a.txt", "base\n");
    repo.commit_all("base");

    let (_dir, base) = scratch();
    let linked = base.join("linked");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "linked",
        linked.to_str().unwrap(),
        "HEAD",
    ]);
    repo.registry.authorize(&linked).unwrap();
    repo.git(&["branch", "untouched"]);

    let root_one =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("root"), &repo.ws).unwrap();
    let linked_path = linked.to_string_lossy().into_owned();
    let linked_one =
        checkpoint::create_manual(&repo.registry, &linked_path, Some("linked"), &repo.ws).unwrap();
    assert_ne!(root_one.checkpoint.id, linked_one.checkpoint.id);

    let root_groups = checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws).unwrap();
    let linked_groups = checkpoint::list_groups(&repo.registry, &linked_path, &repo.ws).unwrap();
    assert_eq!(root_groups.manual.len(), 1);
    assert_eq!(root_groups.manual[0].ref_name, root_one.checkpoint.ref_name);
    assert_eq!(linked_groups.manual.len(), 1);
    assert_eq!(
        linked_groups.manual[0].ref_name,
        linked_one.checkpoint.ref_name
    );

    // A mixed selection: another worktree's checkpoint, a normal branch and a
    // foreign-namespace ref. None may be deleted from this worktree.
    let foreign = "refs/terax/checkpoints/t/1".to_string();
    git_in(&repo.root, &["update-ref", &foreign, "HEAD"]);
    let report = checkpoint::cleanup(
        &repo.registry,
        &repo.path(),
        &[
            linked_one.checkpoint.ref_name.clone(),
            "refs/heads/untouched".to_string(),
            foreign.clone(),
        ],
        &repo.ws,
    )
    .unwrap();
    assert!(report.removed.is_empty(), "{report:?}");
    let reason = |name: &str| {
        report
            .refused
            .iter()
            .find(|refused| refused.ref_name == name)
            .map(|refused| refused.reason.as_str())
    };
    assert_eq!(
        reason(&linked_one.checkpoint.ref_name),
        Some("another-worktree")
    );
    assert_eq!(reason("refs/heads/untouched"), Some("not-a-recovery-ref"));
    assert_eq!(reason(&foreign), Some("not-a-recovery-ref"));
    assert!(refs_of(&repo).contains(&linked_one.checkpoint.ref_name));
    assert!(refs_of(&repo).contains(&foreign));
    assert_eq!(
        checkpoint::list_groups(&repo.registry, &linked_path, &repo.ws)
            .unwrap()
            .manual
            .len(),
        1
    );
    assert!(!report.atomic, "ref deletion is not one atomic transaction");
}

#[test]
fn inspection_names_the_owner_capture_record_and_captured_paths() {
    let repo = TestRepo::new();
    repo.write("a.txt", "base\n");
    repo.commit_all("base");
    repo.write("a.txt", "edited\n");
    repo.write("new.txt", "new\n");
    let created =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("inspect me"), &repo.ws)
            .unwrap();

    let inspection = checkpoint::inspect(
        &repo.registry,
        &repo.path(),
        &created.checkpoint.ref_name,
        &repo.ws,
    )
    .unwrap();
    assert_eq!(inspection.kind, RecoveryKind::Manual);
    assert_eq!(inspection.name.as_deref(), Some("inspect me"));
    assert_eq!(inspection.task_id, None);
    assert_eq!(inspection.turn, None);
    assert_eq!(inspection.commit, created.checkpoint.commit);
    assert_eq!(inspection.tree, created.checkpoint.tree);
    let paths: Vec<&str> = inspection
        .changed_paths
        .iter()
        .map(|change| change.path.as_str())
        .collect();
    assert_eq!(paths, vec!["a.txt", "new.txt"]);
    assert_eq!(inspection.changed_total, 2);
    assert!(!inspection.changed_truncated);
    assert!(!inspection.head_moved);
    assert_eq!(
        inspection
            .capture
            .as_ref()
            .map(|capture| capture.ignored_files),
        Some(0)
    );
    assert!(!inspection.limits.captures_ignored_files);

    // The stored capture record survives a later listing (it is not a creation
    // time epilogue the UI would have to remember).
    let listed = checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws).unwrap();
    assert_eq!(
        listed.manual[0].capture.as_ref().map(|c| c.passes),
        created.checkpoint.capture.as_ref().map(|c| c.passes)
    );

    repo.commit_all("move head");
    let moved = checkpoint::inspect(
        &repo.registry,
        &repo.path(),
        &created.checkpoint.ref_name,
        &repo.ws,
    )
    .unwrap();
    assert!(moved.head_moved, "HEAD moved: commits are not undone");

    let unknown =
        checkpoint::inspect(&repo.registry, &repo.path(), "refs/heads/main", &repo.ws).unwrap_err();
    assert_eq!(
        unknown.to_string(),
        "invalid ref or revision: refs/heads/main"
    );
}

#[test]
fn cleanup_deletes_only_the_named_refs_and_never_runs_garbage_collection() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.commit_all("base");

    let keep =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("keep"), &repo.ws).unwrap();
    let remove =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("remove"), &repo.ws).unwrap();

    // A turn checkpoint and its restore safety ref are grouped separately, and
    // an unrelated branch must be invisible to cleanup.
    let turn = checkpoint::create(&repo.registry, &repo.path(), "t", 1, &repo.ws).unwrap();
    repo.write("a.txt", "two\n");
    let restored = checkpoint::restore(
        &repo.registry,
        &repo.path(),
        &turn.info.ref_name,
        true,
        &repo.ws,
    )
    .unwrap();
    let safety = restored
        .safety
        .expect("a forced restore keeps a safety ref");
    repo.git(&["branch", "keep-branch"]);

    let before = checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws).unwrap();
    assert_eq!(before.manual.len(), 2);
    assert_eq!(before.turns.len(), 1);
    assert_eq!(before.safety.len(), 1);
    assert_eq!(before.safety[0].ref_name, safety.ref_name);
    assert_eq!(before.safety[0].task_id, "t");

    let safety_inspection =
        checkpoint::inspect(&repo.registry, &repo.path(), &safety.ref_name, &repo.ws).unwrap();
    assert_eq!(safety_inspection.kind, RecoveryKind::Safety);
    assert_eq!(safety_inspection.task_id.as_deref(), Some("t"));

    let report = checkpoint::cleanup(
        &repo.registry,
        &repo.path(),
        std::slice::from_ref(&remove.checkpoint.ref_name),
        &repo.ws,
    )
    .unwrap();
    assert_eq!(report.removed.len(), 1);
    assert_eq!(report.removed[0].ref_name, remove.checkpoint.ref_name);
    assert_eq!(report.removed[0].kind, RecoveryKind::Manual);
    assert!(report.refused.is_empty());
    assert_eq!(report.remaining.manual.len(), 1);
    assert_eq!(report.remaining.turns.len(), 1);
    assert_eq!(report.remaining.safety.len(), 1);
    assert_eq!(report.remaining.storage.owned_refs, 3);

    assert!(!refs_of(&repo).contains(&remove.checkpoint.ref_name));
    assert!(refs_of(&repo).contains(&keep.checkpoint.ref_name));
    assert!(refs_of(&repo).contains(&turn.info.ref_name));
    assert!(refs_of(&repo).contains(&safety.ref_name));
    assert!(refs_of(&repo)
        .iter()
        .any(|name| name == "refs/heads/keep-branch"));

    // Deleting a ref does not delete objects: the content stays readable until
    // Git itself prunes it, and this application never runs `git gc`.
    assert!(!missing_in(
        &repo,
        &format!("{}:a.txt", remove.checkpoint.commit)
    ));
    let loose_after = report.remaining.storage.loose_objects;
    assert!(
        loose_after >= before.storage.loose_objects,
        "cleanup collected objects: {loose_after} < {}",
        before.storage.loose_objects
    );

    // An empty explicit selection is a no-op, never a default "clean all".
    let untouched = checkpoint::cleanup(&repo.registry, &repo.path(), &[], &repo.ws).unwrap();
    assert!(untouched.removed.is_empty());
    assert_eq!(untouched.remaining.storage.owned_refs, 3);
}

#[test]
fn submodules_are_recorded_as_pointers_and_the_limits_say_so() {
    let sub = TestRepo::new();
    sub.write("lib.txt", "lib\n");
    sub.commit_all("lib");
    let repo = TestRepo::new();
    repo.git(&[
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        &sub.path(),
        "vendor/lib",
    ]);
    repo.write(".gitignore", "*.log\n");
    repo.commit_all("add submodule");
    repo.write("noise.log", "not captured\n");

    let created = checkpoint::create_manual(&repo.registry, &repo.path(), None, &repo.ws).unwrap();
    assert_eq!(created.checkpoint.name, None);
    let capture = created.checkpoint.capture.as_ref().unwrap();
    assert_eq!(capture.submodules, 1);
    assert_eq!(capture.ignored_files, 1);
    assert!(!created.limits.captures_submodule_contents);
    assert!(!created.limits.captures_index_state);
    assert!(!created.limits.atomic);
}

#[test]
fn a_capture_under_concurrent_writes_reports_its_instability_instead_of_claiming_a_stable_backup() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let repo = TestRepo::new();
    for i in 0..120 {
        repo.write(&format!("src/f{i}.txt"), &format!("{i}\n"));
    }
    repo.commit_all("base");

    let root = repo.root.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let writer = std::thread::spawn(move || {
        let mut n = 0u32;
        while !flag.load(Ordering::Relaxed) {
            let _ = std::fs::write(root.join(format!("src/f{}.txt", n % 120)), format!("{n}\n"));
            let _ = std::fs::write(root.join(format!("churn{}.txt", n % 5)), "x\n");
            let _ = std::fs::remove_file(root.join(format!("churn{}.txt", (n + 2) % 5)));
            n += 1;
        }
    });
    let created = checkpoint::create_manual(&repo.registry, &repo.path(), None, &repo.ws).unwrap();
    stop.store(true, Ordering::Relaxed);
    writer.join().unwrap();

    let capture = created.checkpoint.capture.as_ref().unwrap();
    assert!((1..=3).contains(&capture.passes));
    if !capture.consistent {
        assert!(capture.warnings.contains(&"concurrent-writes".to_string()));
    }
    assert_eq!(
        capture.incomplete,
        !capture.consistent || capture.unstable_count > 0 || !capture.warnings.is_empty()
    );
    repo.git(&["cat-file", "-e", &created.checkpoint.commit]);
}

#[test]
fn storage_pressure_is_repo_wide_context_and_never_promises_reclaimed_bytes() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.commit_all("base");
    checkpoint::create_manual(&repo.registry, &repo.path(), Some("one"), &repo.ws).unwrap();

    let groups = checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws).unwrap();
    let json = serde_json::to_value(&groups).unwrap();
    let storage = json.get("storage").expect("storage pressure is reported");
    assert!(storage["sharedObjects"].as_bool().unwrap());
    assert!(storage.get("reclaimedBytes").is_none());
    assert!(storage.get("freedBytes").is_none());
    assert!(storage["looseObjects"].as_u64().unwrap() >= 1);
    assert_eq!(storage["ownedRefs"], 1);
    assert!(storage["looseKib"].as_u64().is_some());
    assert!(storage["packedKib"].as_u64().is_some());
}

#[test]
fn listing_a_fresh_worktree_writes_no_id_file_and_names_are_validated() {
    let repo = TestRepo::new();
    assert!(
        checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws)
            .unwrap()
            .manual
            .is_empty()
    );
    assert!(
        !repo.root.join(".git/terax-worktree-id").exists(),
        "reading creates no worktree id"
    );

    let blank =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("   "), &repo.ws).unwrap();
    assert_eq!(blank.checkpoint.name, None);

    let too_long = "x".repeat(checkpoint::MAX_MANUAL_NAME_CHARS + 1);
    for bad in [too_long.as_str(), "line\nbreak", "tab\there", "bell\u{7}"] {
        let error = checkpoint::create_manual(&repo.registry, &repo.path(), Some(bad), &repo.ws)
            .unwrap_err();
        assert!(
            error.to_string().contains("name"),
            "{bad:?} was accepted: {error}"
        );
    }
    assert_eq!(
        checkpoint::list_groups(&repo.registry, &repo.path(), &repo.ws)
            .unwrap()
            .manual
            .len(),
        1,
        "a refused name creates no ref"
    );
}

/// The native command names the frontend invokes must stay bound to the
/// functions here; a rename without the command would otherwise fail at runtime
/// on a user's machine instead of in this suite.
#[test]
fn the_manual_checkpoint_commands_are_registered_in_the_tauri_builder() {
    let lib = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .expect("read src/lib.rs");
    for command in [
        "git_checkpoint_manual_create",
        "git_checkpoint_groups",
        "git_checkpoint_inspect",
        "git_checkpoint_cleanup",
    ] {
        assert!(lib.contains(command), "lib.rs does not register {command}");
    }
}

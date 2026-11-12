//! Manual-checkpoint restore through the native command seam, against real
//! scratch repositories: preview, all-Space-adjacent preconditions, the
//! required safety capture, refusals before mutation, partial failures after
//! mutation, and content recovery from a safety ref.
//!
//! The safety capture is a precondition, not a best effort: a failed or
//! incomplete capture, or a failed ref publication, changes no file and no
//! index entry, and `force` does not bypass it.

use std::path::Path;

use crate::modules::git::checkpoint::{
    self, ManualRestoreRefusal, RestoreEffect, RestoreHooks, RestorePath,
};
use crate::modules::git::testutil::TestRepo;

fn head(repo: &TestRepo) -> String {
    repo.git(&["rev-parse", "HEAD"])
}

fn index(repo: &TestRepo) -> String {
    repo.git(&["ls-files", "--stage"])
}

fn status(repo: &TestRepo) -> String {
    repo.git(&["status", "--porcelain"])
}

fn recovery_refs(repo: &TestRepo) -> Vec<String> {
    repo.git(&[
        "for-each-ref",
        "--format=%(refname)",
        "refs/terax-workspace/",
    ])
    .lines()
    .map(str::to_string)
    .filter(|name| !name.is_empty())
    .collect()
}

fn safety_refs(repo: &TestRepo) -> Vec<String> {
    recovery_refs(repo)
        .into_iter()
        .filter(|name| name.contains("/prerestore-"))
        .collect()
}

fn affected(preview: &checkpoint::ManualRestorePreview) -> Vec<(&str, RestoreEffect, bool)> {
    preview
        .affected
        .iter()
        .map(|path: &RestorePath| (path.path.as_str(), path.effect, path.staged))
        .collect()
}

/// A repository whose checkpoint no longer matches the working tree: one edit,
/// one file created since, one file removed since, and a staged edit.
fn diverged() -> (TestRepo, checkpoint::ManualCheckpoint) {
    let repo = TestRepo::new();
    repo.write("edited.txt", "checkpoint\n");
    repo.write("removed.txt", "checkpoint\n");
    repo.write("staged.txt", "checkpoint\n");
    repo.commit_all("base");
    // Captured by the checkpoint, and untracked so ignoring it later really
    // removes it from the snapshot.
    repo.write("debug.log", "captured before it was ignored\n");
    repo.write("edited.txt", "checkpoint edited\n");
    repo.write("removed.txt", "checkpoint removed\n");
    repo.write("staged.txt", "checkpoint staged\n");

    let created =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("target"), &repo.ws).unwrap();

    // The working tree moves on after the checkpoint.
    repo.write("edited.txt", "current edit\n");
    repo.write("created-since.txt", "created after the checkpoint\n");
    std::fs::remove_file(repo.root.join("removed.txt")).unwrap();
    repo.write("staged.txt", "staged after the checkpoint\n");
    repo.git(&["add", "staged.txt"]);
    // `debug.log` was captured; ignoring it now means a naive restore would
    // overwrite an ignored file the snapshot no longer contains.
    std::fs::write(repo.root.join(".git/info/exclude"), "*.log\n").unwrap();

    (repo, created.checkpoint)
}

#[test]
fn preview_names_affected_paths_staging_and_head_effects_without_mutating_anything() {
    let (repo, target) = diverged();
    let head_before = head(&repo);
    let index_before = index(&repo);
    let status_before = status(&repo);
    let refs_before = recovery_refs(&repo);
    let edited_before = repo.read("edited.txt");
    let debug_before = repo.read("debug.log");

    let preview =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &target.ref_name, &repo.ws)
            .unwrap();

    assert_eq!(preview.kind, checkpoint::RecoveryKind::Manual);
    assert_eq!(preview.name.as_deref(), Some("target"));
    assert_eq!(preview.commit, target.commit);
    assert_eq!(preview.tree, target.tree);
    assert!(!preview.head_moved);
    assert_eq!(preview.head_effect, "unchanged");
    assert!(preview.requires_safety_capture);
    assert!(!preview.captures_index_state);
    assert!(!preview.captures_ignored_files);
    assert!(!preview.atomic);
    assert!(!preview.fingerprint.is_empty());

    let paths = affected(&preview);
    assert_eq!(
        paths,
        vec![
            // Created after the checkpoint: restore removes it.
            ("created-since.txt", RestoreEffect::Removed, false),
            ("edited.txt", RestoreEffect::Written, false),
            // `removed.txt` is in the checkpoint but gone now: restore writes it back.
            ("removed.txt", RestoreEffect::Written, false),
            // The staged edit is reported as such; its index state is not captured.
            ("staged.txt", RestoreEffect::Written, true),
        ],
        "affected paths and effects: {paths:?}"
    );
    assert_eq!(preview.staged_total, 1);
    assert_eq!(preview.affected_total, 4);
    assert!(!preview.affected_truncated);

    // The ignored file the checkpoint holds is in the way, but it is never
    // overwritten: it is skipped, not listed as affected.
    assert!(preview
        .skipped
        .iter()
        .any(|skip| { skip.path == "debug.log" && skip.reason == "ignored-file-in-the-way" }));
    assert_eq!(preview.ignored_in_the_way, 1);
    assert!(!paths.iter().any(|(path, ..)| *path == "debug.log"));

    // A preview reads; it writes no ref, file or index entry.
    assert_eq!(head(&repo), head_before);
    assert_eq!(index(&repo), index_before);
    assert_eq!(status(&repo), status_before);
    assert_eq!(recovery_refs(&repo), refs_before);
    assert_eq!(repo.read("edited.txt"), edited_before);
    assert_eq!(repo.read("debug.log"), debug_before);

    // A turn checkpoint is the retained per-turn path, not this one.
    let turn = checkpoint::create(&repo.registry, &repo.path(), "t", 1, &repo.ws).unwrap();
    let refused =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &turn.info.ref_name, &repo.ws)
            .unwrap();
    assert_eq!(
        refused.refusal,
        Some(ManualRestoreRefusal::UnsupportedCheckpointKind)
    );
    assert!(refused.affected.is_empty());
}

#[test]
fn staged_affected_paths_refuse_before_mutation_and_force_is_explicit() {
    let (repo, target) = diverged();
    let head_before = head(&repo);
    let index_before = index(&repo);
    let status_before = status(&repo);
    let refs_before = recovery_refs(&repo);
    let preview =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &target.ref_name, &repo.ws)
            .unwrap();

    let refused = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        false,
        &repo.ws,
    )
    .unwrap();
    assert!(!refused.restored);
    assert_eq!(
        refused.refusal,
        Some(ManualRestoreRefusal::StagedAffectedPaths)
    );
    assert!(refused.refusal_detail.is_some());
    assert_eq!(refused.staged_total, 1);
    assert!(refused.safety.is_none(), "nothing ran, so no safety ref");
    assert_eq!(head(&repo), head_before);
    assert_eq!(index(&repo), index_before);
    assert_eq!(status(&repo), status_before);
    assert_eq!(recovery_refs(&repo), refs_before);

    // Force is an explicit acceptance of the index effect. It still publishes
    // the required safety capture first.
    let forced = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
    )
    .unwrap();
    assert!(forced.restored);
    assert!(forced.refusal.is_none());
    assert!(!forced.partial);
    assert_eq!(forced.kind, checkpoint::RecoveryKind::Manual);
    assert!(!forced.content_only);
    assert!(!forced.captures_index_state);
    assert!(!forced.atomic);
    assert_eq!(forced.head_effect, "unchanged");
    assert_eq!(head(&repo), head_before, "restore never moves HEAD");
    assert_eq!(
        forced.written, 3,
        "edited, removed and staged are rewritten"
    );
    assert_eq!(forced.removed, 1, "the file created after the checkpoint");
    assert_eq!(repo.read("edited.txt"), "checkpoint edited\n");
    assert_eq!(repo.read("removed.txt"), "checkpoint removed\n");
    assert_eq!(repo.read("staged.txt"), "checkpoint staged\n");
    assert!(!repo.exists("created-since.txt"));
    assert_eq!(
        repo.read("debug.log"),
        "captured before it was ignored\n",
        "an ignored file in the way is never overwritten"
    );

    // The safety ref preserves the content the restore overwrote, including the
    // staged working copy; it does not preserve the index state itself.
    let safety = forced.safety.as_ref().expect("a required safety ref");
    assert!(forced.safety_retained);
    assert_eq!(
        repo.git(&["show", &format!("{}:staged.txt", safety.commit)]),
        "staged after the checkpoint\n"
    );
    assert_eq!(safety_refs(&repo).len(), 1);
}

#[test]
fn a_failed_or_incomplete_required_capture_refuses_even_with_force_and_changes_nothing() {
    let (repo, target) = diverged();
    let snapshot = |repo: &TestRepo| {
        (
            head(repo),
            index(repo),
            status(repo),
            recovery_refs(repo),
            repo.read("edited.txt"),
            repo.read("debug.log"),
        )
    };
    let before = snapshot(&repo);
    let preview =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &target.ref_name, &repo.ws)
            .unwrap();

    let failed = checkpoint::restore_manual_with_hooks(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
        RestoreHooks {
            fail_safety_capture: true,
            ..RestoreHooks::default()
        },
    )
    .unwrap_err();
    assert!(
        failed.to_string().contains("safety capture"),
        "unexpected error: {failed}"
    );
    assert_eq!(snapshot(&repo), before);

    let incomplete = checkpoint::restore_manual_with_hooks(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
        RestoreHooks {
            inconsistent_capture: true,
            ..RestoreHooks::default()
        },
    )
    .unwrap_err();
    assert!(
        incomplete.to_string().contains("incomplete"),
        "unexpected error: {incomplete}"
    );
    assert_eq!(snapshot(&repo), before);
}

#[test]
fn a_failed_safety_ref_publication_refuses_even_with_force_and_changes_nothing() {
    let (repo, target) = diverged();
    let before = (
        head(&repo),
        index(&repo),
        status(&repo),
        recovery_refs(&repo),
        repo.read("edited.txt"),
    );
    let preview =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &target.ref_name, &repo.ws)
            .unwrap();

    let failed = checkpoint::restore_manual_with_hooks(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
        RestoreHooks {
            fail_safety_ref: true,
            ..RestoreHooks::default()
        },
    )
    .unwrap_err();
    assert!(
        failed.to_string().contains("safety ref"),
        "unexpected error: {failed}"
    );
    assert_eq!(
        (
            head(&repo),
            index(&repo),
            status(&repo),
            recovery_refs(&repo),
            repo.read("edited.txt"),
        ),
        before
    );
}

#[test]
fn a_later_partial_failure_retains_the_safety_ref_reports_effects_and_requires_a_fresh_preview() {
    let (repo, target) = diverged();
    let preview =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &target.ref_name, &repo.ws)
            .unwrap();

    let partial = checkpoint::restore_manual_with_hooks(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
        RestoreHooks {
            fail_after_deletes: true,
            ..RestoreHooks::default()
        },
    )
    .unwrap();
    assert!(!partial.restored);
    assert!(partial.partial);
    assert_eq!(partial.removed, 1, "the delete happened before the failure");
    assert!(partial.failure.is_some());
    assert_eq!(
        partial.failure_stage,
        Some(checkpoint::RestoreFailureStage::Writes)
    );
    assert!(
        partial.safety.is_some(),
        "the safety ref survives the failure"
    );
    assert!(partial.safety_retained);
    assert!(partial.retry_requires_fresh_preview);
    assert!(!repo.exists("created-since.txt"));
    assert_eq!(safety_refs(&repo).len(), 1);
    let safety_commit = partial.safety.as_ref().unwrap().commit.clone();
    assert_eq!(
        repo.git(&["show", &format!("{safety_commit}:created-since.txt")]),
        "created after the checkpoint\n"
    );
    let failed_disk = repo.read("edited.txt");

    // Repeating the old decision is refused: the plan no longer describes the
    // working tree, so a fresh preview is required.
    let stale = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
    )
    .unwrap();
    assert!(!stale.restored);
    assert_eq!(stale.refusal, Some(ManualRestoreRefusal::StalePreview));
    assert_eq!(repo.read("edited.txt"), failed_disk);
    assert_eq!(safety_refs(&repo).len(), 1, "the stale retry ran nothing");

    let fresh =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &target.ref_name, &repo.ws)
            .unwrap();
    assert_ne!(fresh.fingerprint, preview.fingerprint);
    let retried = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &target.ref_name,
        Some(&fresh.fingerprint),
        true,
        &repo.ws,
    )
    .unwrap();
    assert!(retried.restored, "{retried:?}");
    assert_eq!(repo.read("edited.txt"), "checkpoint edited\n");
    assert!(
        safety_refs(&repo).len() >= 2,
        "each restore keeps its own safety ref"
    );
}

#[test]
fn content_recovery_from_the_safety_ref_does_not_claim_a_git_state_undo() {
    let repo = TestRepo::new();
    repo.write("a.txt", "checkpoint\n");
    repo.commit_all("base");
    repo.write("a.txt", "checkpoint content\n");
    let target =
        checkpoint::create_manual(&repo.registry, &repo.path(), Some("target"), &repo.ws).unwrap();

    repo.write("a.txt", "work the user would lose\n");
    repo.git(&["add", "a.txt"]);
    let index_before_restore = index(&repo);
    let head_before = head(&repo);
    let preview = checkpoint::restore_preview(
        &repo.registry,
        &repo.path(),
        &target.checkpoint.ref_name,
        &repo.ws,
    )
    .unwrap();
    let restored = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &target.checkpoint.ref_name,
        Some(&preview.fingerprint),
        true,
        &repo.ws,
    )
    .unwrap();
    assert!(restored.restored);
    let safety = restored.safety.clone().unwrap();
    assert_eq!(repo.read("a.txt"), "checkpoint content\n");

    // Restoring the safety ref brings the content back and labels itself as
    // content recovery: HEAD stays put and the pre-restore index is not
    // recreated.
    let recovery_preview =
        checkpoint::restore_preview(&repo.registry, &repo.path(), &safety.ref_name, &repo.ws)
            .unwrap();
    assert_eq!(recovery_preview.kind, checkpoint::RecoveryKind::Safety);
    let recovered = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &safety.ref_name,
        Some(&recovery_preview.fingerprint),
        false,
        &repo.ws,
    )
    .unwrap();
    assert!(recovered.restored);
    assert_eq!(recovered.kind, checkpoint::RecoveryKind::Safety);
    assert!(recovered.content_only);
    assert!(!recovered.captures_index_state);
    assert!(!recovered.atomic);
    assert_eq!(head(&repo), head_before, "HEAD is not moved");
    assert_eq!(repo.read("a.txt"), "work the user would lose\n");
    assert_ne!(
        index(&repo),
        index_before_restore,
        "the staged copy is not recreated: content recovery is not a Git-state undo"
    );
    assert!(recovered.index_synced);
}

#[test]
fn another_worktrees_checkpoint_is_not_previewed_or_restored_here() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.commit_all("base");
    let (dir, base) = crate::modules::git::testutil::scratch();
    let _dir = dir;
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
    let linked_path = linked.to_string_lossy().into_owned();
    let foreign =
        checkpoint::create_manual(&repo.registry, &linked_path, Some("linked"), &repo.ws).unwrap();

    let preview = checkpoint::restore_preview(
        &repo.registry,
        &repo.path(),
        &foreign.checkpoint.ref_name,
        &repo.ws,
    )
    .unwrap_err();
    assert!(preview.to_string().contains("no such checkpoint"));
    let restore = checkpoint::restore_manual(
        &repo.registry,
        &repo.path(),
        &foreign.checkpoint.ref_name,
        None,
        true,
        &repo.ws,
    )
    .unwrap_err();
    assert!(restore.to_string().contains("no such checkpoint"));
    // The other worktree still owns it.
    assert!(recovery_refs(&repo).contains(&foreign.checkpoint.ref_name));
}

#[test]
fn the_manual_restore_commands_are_registered_in_the_tauri_builder() {
    let lib = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .expect("read src/lib.rs");
    for command in [
        "git_checkpoint_manual_restore_preview",
        "git_checkpoint_manual_restore",
    ] {
        assert!(lib.contains(command), "lib.rs does not register {command}");
    }
}

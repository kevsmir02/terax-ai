//! Removing a worktree while its recovery points are still retained.
//!
//! A checkpoint or a pre-restore safety ref lives in the repository's ref
//! namespace but is owned by one worktree. Deleting the worktree registration
//! would leave that ref with no owner to list, restore or clean it, so removal
//! is refused until the caller deletes exactly those refs. These tests use real
//! scratch repositories: two worktrees of one repository cannot see or delete
//! each other's recovery points, a missing directory is not a reason for a
//! repository-wide prune, and explicit cleanup is what unblocks removal.

use std::path::{Path, PathBuf};

use crate::modules::git::checkpoint;
use crate::modules::git::testutil::{authorized, scratch, TestRepo};
use crate::modules::git::worktree::{self, RemoveBlocker, WorktreeRemoveReport};
use crate::modules::git::worktree::{WorktreeAddRequest, WorktreeBranch};

fn add(repo: &TestRepo, base: &Path, name: &str) -> PathBuf {
    let added = worktree::add(
        &repo.registry,
        &repo.path(),
        &WorktreeAddRequest {
            path: None,
            task_slug: Some(name.to_string()),
            branch: WorktreeBranch::NewBranch {
                name: name.to_string(),
            },
            base: None,
            include: Vec::new(),
        },
        base,
        &repo.ws,
    )
    .unwrap();
    PathBuf::from(added.path)
}

fn preflight(repo: &TestRepo, path: &Path) -> WorktreeRemoveReport {
    worktree::preflight_removal(
        &repo.registry,
        &repo.path(),
        &path.to_string_lossy(),
        &repo.ws,
    )
    .unwrap()
}

fn remove(repo: &TestRepo, path: &Path, force: bool) -> WorktreeRemoveReport {
    worktree::remove(
        &repo.registry,
        &repo.path(),
        &path.to_string_lossy(),
        force,
        &repo.ws,
    )
    .unwrap()
}

fn groups(repo: &TestRepo, path: &Path) -> checkpoint::CheckpointList {
    checkpoint::list_at(
        &repo.registry,
        &repo.path(),
        &path.to_string_lossy(),
        &repo.ws,
    )
    .unwrap()
}

fn cleanup(repo: &TestRepo, path: &Path, refs: &[String]) -> checkpoint::CleanupReport {
    checkpoint::cleanup_at(
        &repo.registry,
        &repo.path(),
        &path.to_string_lossy(),
        refs,
        &repo.ws,
    )
    .unwrap()
}

#[test]
fn a_manual_checkpoint_refuses_removal_until_it_is_deleted_explicitly() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let path = add(&repo, &base, "kept");
    let created = checkpoint::create_manual(
        &repo.registry,
        &path.to_string_lossy(),
        Some("before removal"),
        &repo.ws,
    )
    .unwrap();
    let reference = created.checkpoint.ref_name.clone();

    // The preflight reports the refusal without mutating anything.
    let blocked = preflight(&repo, &path);
    assert!(!blocked.removed, "{blocked:?}");
    assert!(
        blocked.blockers.contains(&RemoveBlocker::RecoveryRefs),
        "{blocked:?}"
    );
    assert_eq!(blocked.recovery.total, 1);
    assert_eq!(blocked.recovery.manual, 1);
    assert_eq!(blocked.recovery.turns, 0);
    assert_eq!(blocked.recovery.safety, 0);
    assert_eq!(blocked.recovery.sample, vec![reference.clone()]);
    assert!(path.is_dir());

    // Force overrides on-disk blockers, never a retained recovery point.
    let forced = remove(&repo, &path, true);
    assert!(!forced.removed, "{forced:?}");
    assert!(forced.blockers.contains(&RemoveBlocker::RecoveryRefs));
    assert!(path.is_dir(), "nothing was deleted");
    assert!(
        repo.git(&["for-each-ref", &reference]).contains(&reference),
        "the checkpoint ref still exists"
    );
    assert!(authorized(&repo.registry, &path));

    // Explicit, scoped cleanup: the caller names the ref it saw.
    let listed = groups(&repo, &path);
    assert_eq!(listed.manual.len(), 1);
    assert_eq!(listed.manual[0].ref_name, reference);
    let cleaned = cleanup(&repo, &path, std::slice::from_ref(&reference));
    assert_eq!(cleaned.removed.len(), 1);
    assert!(cleaned.refused.is_empty(), "{cleaned:?}");
    assert!(cleaned.remaining.manual.is_empty());

    let removed = remove(&repo, &path, false);
    assert!(removed.removed, "{removed:?}");
    assert!(removed.recovery.total == 0);
    assert!(!path.exists());
    assert!(!authorized(&repo.registry, &path), "the grant is revoked");
    assert!(
        repo.git(&["branch", "--list", "kept"]).contains("kept"),
        "the branch survives removal"
    );
}

#[test]
fn a_restore_safety_ref_also_refuses_removal() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let path = add(&repo, &base, "restored");
    let checkpoint =
        checkpoint::create(&repo.registry, &path.to_string_lossy(), "task", 1, &repo.ws).unwrap();
    std::fs::write(path.join("README.md"), "# edited after the checkpoint\n").unwrap();
    let restored = checkpoint::restore(
        &repo.registry,
        &path.to_string_lossy(),
        &checkpoint.info.ref_name,
        true,
        &repo.ws,
    )
    .unwrap();
    assert!(restored.restored, "{restored:?}");
    let safety = restored
        .safety
        .expect("a forced restore keeps a safety ref");

    let blocked = preflight(&repo, &path);
    assert!(!blocked.removed, "{blocked:?}");
    assert!(blocked.blockers.contains(&RemoveBlocker::RecoveryRefs));
    assert_eq!(blocked.recovery.safety, 1);
    assert_eq!(blocked.recovery.turns, 1);
    assert_eq!(blocked.recovery.total, 2);
    assert!(blocked.recovery.sample.contains(&safety.ref_name));

    // Deleting only the safety ref leaves the turn checkpoint blocking.
    let cleaned = cleanup(&repo, &path, std::slice::from_ref(&safety.ref_name));
    assert_eq!(cleaned.removed.len(), 1);
    let still = preflight(&repo, &path);
    assert!(still.blockers.contains(&RemoveBlocker::RecoveryRefs));
    assert_eq!(still.recovery.total, 1);
    assert_eq!(still.recovery.safety, 0);

    let turn_ref = checkpoint.info.ref_name.clone();
    let final_cleanup = cleanup(&repo, &path, &[turn_ref]);
    assert_eq!(final_cleanup.removed.len(), 1);
    assert_eq!(final_cleanup.remaining.storage.owned_refs, 0);
    assert!(remove(&repo, &path, false).removed);
}

#[test]
fn removal_never_counts_or_discards_another_worktrees_recovery_refs() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let left = add(&repo, &base, "left");
    let right = add(&repo, &base, "right");
    let mine = checkpoint::create_manual(
        &repo.registry,
        &left.to_string_lossy(),
        Some("mine"),
        &repo.ws,
    )
    .unwrap();
    let theirs = checkpoint::create_manual(
        &repo.registry,
        &right.to_string_lossy(),
        Some("theirs"),
        &repo.ws,
    )
    .unwrap();

    let report = preflight(&repo, &left);
    assert_eq!(report.recovery.total, 1, "{report:?}");
    assert_eq!(
        report.recovery.sample,
        vec![mine.checkpoint.ref_name.clone()]
    );

    // A foreign ref is refused by name and left alone.
    let foreign = cleanup(
        &repo,
        &left,
        std::slice::from_ref(&theirs.checkpoint.ref_name),
    );
    assert!(foreign.removed.is_empty(), "{foreign:?}");
    assert_eq!(foreign.refused[0].reason, "another-worktree");
    assert_eq!(groups(&repo, &right).manual.len(), 1);

    let cleaned = cleanup(
        &repo,
        &left,
        std::slice::from_ref(&mine.checkpoint.ref_name),
    );
    assert_eq!(cleaned.removed.len(), 1);
    assert!(remove(&repo, &left, false).removed);

    let surviving = groups(&repo, &right);
    assert_eq!(
        surviving.manual.len(),
        1,
        "the other worktree keeps its ref"
    );
    assert_eq!(surviving.manual[0].ref_name, theirs.checkpoint.ref_name);
    assert_eq!(
        surviving.manual[0].name.as_deref(),
        Some("theirs"),
        "not even the label is touched"
    );
    assert_eq!(surviving.storage.owned_refs, 1);
}

#[test]
fn a_missing_directory_is_refused_while_refs_remain_and_removal_never_prunes_others() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let gone = add(&repo, &base, "gone");
    let other = add(&repo, &base, "other");
    let created = checkpoint::create_manual(
        &repo.registry,
        &gone.to_string_lossy(),
        Some("on a deleted directory"),
        &repo.ws,
    )
    .unwrap();
    std::fs::remove_dir_all(&gone).unwrap();
    std::fs::remove_dir_all(&other).unwrap();

    // The owner marker lives in the repository's administrative directory, so
    // the recovery point is still discoverable without the working directory.
    let blocked = preflight(&repo, &gone);
    assert!(!blocked.removed, "{blocked:?}");
    assert!(blocked.blockers.contains(&RemoveBlocker::RecoveryRefs));
    assert_eq!(blocked.recovery.total, 1);
    assert_eq!(groups(&repo, &gone).manual.len(), 1);

    let forced = remove(&repo, &gone, true);
    assert!(!forced.removed, "force does not strand a recovery point");
    assert!(forced.blockers.contains(&RemoveBlocker::RecoveryRefs));

    let cleaned = cleanup(
        &repo,
        &gone,
        std::slice::from_ref(&created.checkpoint.ref_name),
    );
    assert_eq!(cleaned.removed.len(), 1, "{cleaned:?}");
    let removed = remove(&repo, &gone, true);
    assert!(removed.removed, "{removed:?}");

    // Removing one missing-directory registration must not sweep every stale
    // worktree: the other one stays registered (and merely prunable).
    let entries = worktree::list(&repo.registry, &repo.path(), &repo.ws).unwrap();
    let left: Vec<_> = entries
        .iter()
        .filter(|entry| !entry.is_main)
        .map(|entry| (entry.path.as_str(), entry.prunable))
        .collect();
    assert_eq!(left.len(), 1, "{left:?}");
    assert_eq!(
        left[0].0,
        other.to_string_lossy(),
        "no repository-wide prune"
    );
    assert!(left[0].1, "the other stale registration is untouched");
}

#[test]
fn removal_revokes_only_the_derived_grant_and_keeps_a_stronger_one() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let stronger = add(&repo, &base, "stronger");
    let derived = add(&repo, &base, "derived");
    assert!(authorized(&repo.registry, &stronger));
    assert!(authorized(&repo.registry, &derived));

    // A terminal reports its cwd as a root grant; that is not the worktree's
    // derived grant and removal must leave it alone.
    repo.registry.authorize(&stronger).unwrap();

    assert!(remove(&repo, &stronger, false).removed);
    assert!(remove(&repo, &derived, false).removed);
    assert!(
        authorized(&repo.registry, &stronger),
        "a grant that did not come from the worktree survives"
    );
    assert!(
        !authorized(&repo.registry, &derived),
        "the removed worktree's derived grant is gone"
    );
}

#[test]
fn the_retained_archive_path_keeps_its_own_removal_policy() {
    // Task archiving snapshots the worktree and then removes it; its snapshot
    // is a task archive ref, not an owned recovery ref. The product command
    // refuses while an owned ref remains, and the archive helper stays
    // distinguishable instead of inheriting that refusal.
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let path = add(&repo, &base, "archive");
    checkpoint::create_manual(
        &repo.registry,
        &path.to_string_lossy(),
        Some("kept"),
        &repo.ws,
    )
    .unwrap();
    assert!(!remove(&repo, &path, true).removed);
    let archived = worktree::remove_for_archive(
        &repo.registry,
        &repo.path(),
        &path.to_string_lossy(),
        true,
        &repo.ws,
    )
    .unwrap();
    assert!(archived.removed, "{archived:?}");
    assert!(!path.exists());
}

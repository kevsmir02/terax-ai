//! Refusals on the destructive Git paths must leave the worktree, the index and
//! the refs exactly as they were. These run against real temporary repositories:
//! the app-level guard decides *whether* to ask, the native commands are what
//! actually mutate, and an acknowledged-but-refused action must be a no-op.

use std::path::Path;

use crate::modules::git::checkpoint::{self, RestoreRefusal};
use crate::modules::git::testutil::{scratch, TestRepo};
use crate::modules::git::worktree::{self, RemoveBlocker, WorktreeAddRequest, WorktreeBranch};

fn add_worktree(repo: &TestRepo, base: &Path, branch: &str) -> worktree::WorktreeAdded {
    worktree::add(
        &repo.registry,
        &repo.path(),
        &WorktreeAddRequest {
            path: None,
            task_slug: Some(branch.to_string()),
            branch: WorktreeBranch::NewBranch {
                name: branch.to_string(),
            },
            base: None,
            include: Vec::new(),
        },
        base,
        &repo.ws,
    )
    .unwrap()
}

fn worktree_status(path: &Path) -> String {
    let output = crate::modules::git::testutil::git_command(
        path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    )
    .output()
    .expect("spawn git status");
    assert!(output.status.success(), "git status failed");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn worktree_index(path: &Path) -> String {
    let output = crate::modules::git::testutil::git_command(
        path,
        &["diff", "--cached", "--binary", "--no-color"],
    )
    .output()
    .expect("spawn git diff");
    assert!(output.status.success(), "git diff failed");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn refs(path: &Path) -> String {
    let output = crate::modules::git::testutil::git_command(
        path,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/terax",
        ],
    )
    .output()
    .expect("spawn git for-each-ref");
    assert!(output.status.success(), "git for-each-ref failed");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn a_dirty_worktree_removal_refusal_leaves_files_and_index_untouched() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let worktree = add_worktree(&repo, &base, "guard-dirty");
    let path = Path::new(&worktree.path);
    std::fs::write(path.join("README.md"), "changed in the worktree\n").unwrap();
    std::fs::write(path.join("staged.txt"), "staged worktree file\n").unwrap();
    std::fs::write(path.join("untracked.txt"), "untracked worktree file\n").unwrap();
    crate::modules::git::testutil::git_in(path, &["add", "staged.txt"]);

    let before_status = worktree_status(path);
    let before_index = worktree_index(path);
    let before_readme = std::fs::read_to_string(path.join("README.md")).unwrap();

    let report =
        worktree::remove(&repo.registry, &repo.path(), &worktree.path, false, &repo.ws).unwrap();

    assert!(!report.removed);
    assert!(report.blockers.contains(&RemoveBlocker::Dirty));
    assert_eq!(worktree_status(path), before_status);
    assert_eq!(worktree_index(path), before_index);
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        before_readme
    );
    assert!(path.join("staged.txt").is_file());
    assert!(path.join("untracked.txt").is_file());
    assert!(path.is_dir(), "the worktree directory must survive refusal");
}

#[test]
fn force_does_not_remove_a_locked_worktree_or_touch_its_files() {
    let repo = TestRepo::new();
    let (_keep, base) = scratch();
    let worktree = add_worktree(&repo, &base, "guard-locked");
    let path = Path::new(&worktree.path);
    std::fs::write(path.join("README.md"), "locked worktree edit\n").unwrap();
    crate::modules::git::testutil::git_in(
        &repo.root,
        &["worktree", "lock", "--reason", "held by a test", &worktree.path],
    );

    let before_status = worktree_status(path);
    let before_index = worktree_index(path);
    let before_readme = std::fs::read_to_string(path.join("README.md")).unwrap();

    // The guard refuses a locked worktree itself. If it did not, this call would
    // run `git worktree remove --force`, which fails on a locked tree and comes
    // back as a git error instead of a report — so an `Ok` here proves the
    // refusal is the guard's, not git's.
    let report = worktree::remove(&repo.registry, &repo.path(), &worktree.path, true, &repo.ws)
        .expect("a locked worktree is refused with a report, not a git error");

    assert!(!report.removed);
    assert!(report.blockers.contains(&RemoveBlocker::Locked));
    assert_eq!(report.lock_reason.as_deref(), Some("held by a test"));
    assert_eq!(report.recovery.total, 0);
    assert_eq!(worktree_status(path), before_status);
    assert_eq!(worktree_index(path), before_index);
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        before_readme
    );
    assert!(path.is_dir());

    // The archive path forces removal after it captures a snapshot; force is
    // still not an argument a lock answers to.
    let archived =
        worktree::remove_for_archive(&repo.registry, &repo.path(), &worktree.path, true, &repo.ws)
            .expect("a locked worktree is refused with a report on the archive path too");
    assert!(!archived.removed);
    assert!(archived.blockers.contains(&RemoveBlocker::Locked));
    assert_eq!(worktree_status(path), before_status);
    assert_eq!(
        std::fs::read_to_string(path.join("README.md")).unwrap(),
        before_readme
    );
    assert!(path.is_dir());
}

#[test]
fn a_stale_checkpoint_restore_refusal_changes_no_file_index_or_ref() {
    let repo = TestRepo::new();
    repo.write("a.txt", "one\n");
    repo.commit_all("base");
    let checkpoint = checkpoint::create(&repo.registry, &repo.path(), "t", 1, &repo.ws).unwrap();

    repo.write("a.txt", "two\n");
    repo.write("scratch.txt", "only on disk\n");
    crate::modules::git::testutil::git_in(&repo.root, &["add", "a.txt"]);

    let before_status = worktree_status(&repo.root);
    let before_index = worktree_index(&repo.root);
    let before_refs = refs(&repo.root);
    let before_head = repo.git(&["rev-parse", "HEAD"]);

    let report = checkpoint::restore(
        &repo.registry,
        &repo.path(),
        &checkpoint.info.ref_name,
        false,
        &repo.ws,
    )
    .unwrap();

    assert!(!report.restored);
    assert_eq!(report.refusal, Some(RestoreRefusal::ChangedSinceLatest));
    assert!(report.safety.is_none(), "a refusal creates no safety ref");
    assert_eq!(repo.read("a.txt"), "two\n");
    assert_eq!(repo.staged("a.txt"), "two\n");
    assert_eq!(repo.read("scratch.txt"), "only on disk\n");
    assert_eq!(worktree_status(&repo.root), before_status);
    assert_eq!(worktree_index(&repo.root), before_index);
    assert_eq!(refs(&repo.root), before_refs);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]), before_head);
}

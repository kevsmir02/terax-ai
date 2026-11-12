//! App-owned write coordination: an expected disk revision is validated inside
//! native coordination so two buffers (in one Space or across Spaces) cannot
//! both overwrite the same baseline.
//!
//! Limitations asserted here on purpose: this coordinates *app-owned* writes.
//! Independent external writers are not locked out; a change that lands between
//! the revision check and the rename is indistinguishable from one that lands
//! just after (see `docs/architecture/security-model.md`).

use std::path::{Path, PathBuf};

use terax_lib::modules::fs::save::{
    current_revision, save, Conflict, ConflictReason, CurrentState, SaveError,
};

fn file_with(content: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("note.txt");
    std::fs::write(&path, content).unwrap();
    (dir, path)
}

fn revision(path: &Path) -> String {
    match current_revision(path) {
        CurrentState::Present(rev) => rev.to_opaque(),
        other => panic!("expected a present revision, got {other:?}"),
    }
}

#[test]
fn revision_distinguishes_content_changes_with_an_identical_mtime() {
    let (_dir, path) = file_with("baseline\n");
    let stamp = std::fs::metadata(&path).unwrap();
    let before = revision(&path);
    // Same length, same mtime, different bytes: mtime + size cannot see this.
    std::fs::write(&path, "BASEline\n").unwrap();
    restore_mtime(&path, &stamp);
    let after = revision(&path);

    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        stamp.len(),
        "the fixture must not change size"
    );
    // Only the Unix fixture can restore the timestamp exactly; the point of the
    // test is that the revision does not depend on it either way.
    #[cfg(unix)]
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        stamp.modified().unwrap(),
        "the fixture must not change mtime"
    );
    assert_ne!(
        before, after,
        "a content change must change the revision even when mtime and size match"
    );

    // The stale revision must be refused by the write path itself, not merely
    // differ: this is the mtime+size blind spot the old editor had.
    match save(&path, b"mine\n", Some(&before)).unwrap_err() {
        SaveError::Conflict(conflict) => assert_eq!(conflict.reason, ConflictReason::Changed),
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "BASEline\n",
        "the same-mtime change is never overwritten silently"
    );

    // A buffer that reread the file holds the now-current revision.
    save(&path, b"mine\n", Some(&after)).expect("current revision saves");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine\n");
}

#[cfg(unix)]
fn restore_mtime(path: &Path, from: &std::fs::Metadata) {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::AsRawFd;

    let times = [
        libc::timespec {
            tv_sec: from.atime() as libc::time_t,
            tv_nsec: from.atime_nsec() as _,
        },
        libc::timespec {
            tv_sec: from.mtime() as libc::time_t,
            tv_nsec: from.mtime_nsec() as _,
        },
    ];
    let file = std::fs::File::open(path).unwrap();
    assert_eq!(
        unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) },
        0
    );
    drop(file);
    assert_eq!(
        std::fs::metadata(path).unwrap().modified().unwrap(),
        from.modified().unwrap(),
        "the fixture must not change mtime"
    );
}

#[cfg(not(unix))]
fn restore_mtime(_path: &Path, _from: &std::fs::Metadata) {}

#[test]
fn revisions_and_saves_are_coordinated_across_path_spellings() {
    let (dir, path) = file_with("baseline\n");
    // Same canonical file, different spelling: the coordination key is the
    // content revision (digest + size + file identity), not the string.
    let alias = dir.path().join(".").join("note.txt");
    assert_eq!(revision(&path), revision(&alias));

    let baseline = revision(&path);
    save(&alias, b"from alias\n", Some(&baseline)).expect("the alias saves");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "from alias\n");

    // The buffer that held the original spelling's baseline is refused, so a
    // Space cannot bypass coordination by naming the file differently.
    assert!(matches!(
        save(&path, b"from original\n", Some(&baseline)).unwrap_err(),
        SaveError::Conflict(Conflict {
            reason: ConflictReason::Changed,
            ..
        })
    ));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "from alias\n");
}

#[test]
fn two_buffers_from_one_baseline_cannot_both_save() {
    let (_dir, path) = file_with("baseline\n");
    let baseline = revision(&path);

    // Buffer A (Space 1) saves its edit against the shared baseline.
    let first = save(&path, b"from A\n", Some(&baseline)).expect("first save wins");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "from A\n");
    // The write reports the revision it left behind, so the same buffer keeps
    // saving without a reread.
    assert_eq!(first.revision, revision(&path));

    // Buffer B (Space 2) was edited from the same baseline: refused.
    match save(&path, b"from B\n", Some(&baseline)).unwrap_err() {
        SaveError::Conflict(conflict) => {
            assert_eq!(conflict.reason, ConflictReason::Changed);
            assert_eq!(
                conflict.current.as_deref(),
                Some(revision(&path).as_str()),
                "the conflict reports the disk revision the user may review"
            );
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "from A\n",
        "the losing buffer never reaches the disk"
    );
}

#[test]
fn concurrent_buffers_from_one_baseline_produce_exactly_one_winner() {
    for _ in 0..20 {
        let (_dir, path) = file_with("baseline\n");
        let baseline = revision(&path);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        // Two Spaces save at the same instant from the same baseline. Spawn
        // both first: joining inside the loop would wait for a partner that has
        // not been spawned yet.
        let handles: Vec<(&str, std::thread::JoinHandle<_>)> = ["from A\n", "from B\n"]
            .into_iter()
            .map(|text| {
                let path = path.clone();
                let baseline = baseline.clone();
                let barrier = barrier.clone();
                let handle = std::thread::spawn(move || {
                    barrier.wait();
                    save(&path, text.as_bytes(), Some(&baseline))
                });
                (text, handle)
            })
            .collect();
        let outcomes: Vec<(&str, Result<_, _>)> = handles
            .into_iter()
            .map(|(text, handle)| (text, handle.join().unwrap()))
            .collect();

        let winners: Vec<_> = outcomes.iter().filter(|(_, r)| r.is_ok()).collect();
        assert_eq!(
            winners.len(),
            1,
            "exactly one competing save may win: {outcomes:?}"
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            winners[0].0,
            "the winner's text is what the disk holds"
        );

        let (_, loser) = outcomes.iter().find(|(_, r)| r.is_err()).unwrap();
        match loser.as_ref().unwrap_err() {
            SaveError::Conflict(conflict) => {
                assert_eq!(conflict.reason, ConflictReason::Changed);
                assert_eq!(
                    conflict.current.as_deref(),
                    Some(revision(&path).as_str()),
                    "the loser can review the revision that won"
                );
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
    }
}

#[test]
fn a_stale_overwrite_consent_is_refused_and_needs_a_fresh_round() {
    let (_dir, path) = file_with("baseline\n");
    std::fs::write(&path, "external 1\n").unwrap();
    // The user is shown "external 1" and consents to overwrite that revision.
    let reviewed = revision(&path);
    std::fs::write(&path, "external 2\n").unwrap();

    let err = save(&path, b"mine\n", Some(&reviewed)).unwrap_err();
    assert!(matches!(
        err,
        SaveError::Conflict(Conflict {
            reason: ConflictReason::Changed,
            ..
        })
    ));
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "external 2\n",
        "consent for the reviewed revision does not license a later one"
    );

    // A fresh round reviews the current revision and succeeds.
    let reviewed_again = revision(&path);
    save(&path, b"mine\n", Some(&reviewed_again)).expect("fresh consent saves");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine\n");
}

#[test]
fn a_missing_target_is_a_conflict_not_a_recreation() {
    let (_dir, path) = file_with("baseline\n");
    let baseline = revision(&path);
    std::fs::remove_file(&path).unwrap();

    assert!(matches!(
        save(&path, b"mine\n", Some(&baseline)).unwrap_err(),
        SaveError::Conflict(Conflict {
            reason: ConflictReason::Missing,
            ..
        })
    ));
    assert!(
        !path.exists(),
        "a missing file is never recreated by a save"
    );
}

#[cfg(unix)]
#[test]
fn a_replaced_target_is_a_conflict_even_with_identical_content() {
    let (_dir, path) = file_with("baseline\n");
    let baseline = revision(&path);
    // Replace the inode (checkout, `cp`, an editor that renames) without
    // changing the bytes.
    let staged = path.with_extension("staged");
    std::fs::write(&staged, "baseline\n").unwrap();
    std::fs::rename(&staged, &path).unwrap();

    assert!(matches!(
        save(&path, b"mine\n", Some(&baseline)).unwrap_err(),
        SaveError::Conflict(Conflict {
            reason: ConflictReason::Replaced,
            ..
        })
    ));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "baseline\n");
}

#[cfg(unix)]
#[test]
fn a_non_regular_target_is_a_conflict_not_a_write() {
    let dir = tempfile::tempdir().unwrap();
    let fifo = dir.path().join("pipe");
    let name = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

    // A FIFO must never be opened for the revision read, which would block.
    assert!(matches!(current_revision(&fifo), CurrentState::Unreadable));
    assert!(matches!(
        save(&fifo, b"mine\n", Some("r1:unknown")).unwrap_err(),
        SaveError::Conflict(Conflict {
            reason: ConflictReason::Unreadable,
            ..
        })
    ));
    use std::os::unix::fs::FileTypeExt;
    assert!(
        std::fs::symlink_metadata(&fifo)
            .unwrap()
            .file_type()
            .is_fifo(),
        "the FIFO is untouched"
    );
}

#[test]
fn a_plain_save_without_an_expected_revision_still_creates() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fresh.txt");
    let created = save(&path, b"hello\n", None).expect("unconditional create");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\n");
    assert_eq!(created.revision, revision(&path));
}

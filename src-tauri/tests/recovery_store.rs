//! Durable recovery storage through its native seam.
//!
//! These exercise the same `Store` the `recovery_*` commands wrap: private
//! layout, atomic replacement, authoritative quota, revision-aware cleanup, and
//! what a "restart" (a fresh `Store` over the same directory) can still read.
//!
//! A real forced termination of the packaged application is *not* exercised
//! here — that belongs to the real-app seam and is recorded as unverified in
//! the ticket evidence. What is asserted is the property a forced termination
//! relies on: a completed `put` is on disk and a failed `put` leaves the older
//! record byte-identical.

use std::fs;
use std::path::PathBuf;

use terax_lib::modules::recovery::{Policy, QuotaReason, Store, StoreError};

fn record(buffer_id: &str, revision: u64, path: &str, space_id: &str, text: &str) -> String {
    serde_json::json!({
        "version": 1,
        "bufferId": buffer_id,
        "spaceId": space_id,
        "path": path,
        "fileIdentity": "8-9",
        "bufferRevision": revision,
        "diskRevision": "r1:aa:1:8-9",
        "text": text,
        "bytes": text.len(),
        "updatedAt": 1,
    })
    .to_string()
}

fn smoke_store(root: PathBuf) -> Store {
    Store::with_policy(
        root,
        Policy {
            per_file_bytes: 4096,
            total_bytes: 16_384,
            directory: "recovery".into(),
        },
    )
}

#[test]
fn two_spaces_editing_one_pathname_survive_a_restart_independently() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("recovery");
    {
        let store = smoke_store(root.clone());
        store
            .put(&record(
                "buf-a",
                3,
                "/home/me/notes.txt",
                "sp-a",
                "A's draft",
            ))
            .unwrap();
        store
            .put(&record(
                "buf-b",
                1,
                "/home/me/notes.txt",
                "sp-b",
                "B's draft",
            ))
            .unwrap();
    }

    // "Restart": a fresh store over the same directory sees both drafts, with
    // their own identities and revisions — the shared pathname is not an owner.
    let restarted = smoke_store(root.clone());
    let mut records = restarted.list().unwrap();
    records.sort();
    assert_eq!(records.len(), 2);
    assert!(records
        .iter()
        .any(|r| r.contains("\"buf-a\"") && r.contains("A's draft")));
    assert!(records
        .iter()
        .any(|r| r.contains("\"buf-b\"") && r.contains("B's draft")));

    // Resolving one leaves the other intact.
    let outcome = restarted.remove("buf-a", 3).unwrap();
    assert!(outcome.removed);
    let left = restarted.list().unwrap();
    assert_eq!(left.len(), 1);
    assert!(left[0].contains("\"buf-b\""));

    // No torn staging file was left behind; only record files exist.
    let names: Vec<String> = fs::read_dir(root.join("records"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(names.iter().all(|n| n.ends_with(".json")), "{names:?}");
}

#[test]
fn only_a_completed_write_is_reader_visible() {
    let dir = tempfile::tempdir().unwrap();
    let store = smoke_store(dir.path().join("recovery"));
    store
        .put(&record(
            "buf-a",
            1,
            "/home/me/a.txt",
            "sp-a",
            "acknowledged",
        ))
        .unwrap();

    // The next write is refused at the (test) per-file bound: the older record
    // is what a restart must find, not a mixture or a truncation.
    let too_big = record("buf-a", 2, "/home/me/a.txt", "sp-a", &"x".repeat(8192));
    assert_eq!(
        store.put(&too_big).unwrap_err(),
        StoreError::Quota {
            reason: QuotaReason::FileLimit
        }
    );

    let restarted = smoke_store(dir.path().join("recovery"));
    assert_eq!(
        restarted.list().unwrap(),
        vec![record("buf-a", 1, "/home/me/a.txt", "sp-a", "acknowledged")]
    );
}

#[test]
fn a_late_cleanup_cannot_delete_newer_typing() {
    let dir = tempfile::tempdir().unwrap();
    let store = smoke_store(dir.path().join("recovery"));
    store
        .put(&record(
            "buf-a",
            5,
            "/home/me/a.txt",
            "sp-a",
            "newer typing",
        ))
        .unwrap();

    // A cleanup decided against revision 4 arrives after revision 5 landed.
    let outcome = store.remove("buf-a", 4).unwrap();
    assert!(!outcome.removed);
    assert_eq!(outcome.revision, Some(5));
    assert_eq!(store.list().unwrap().len(), 1);

    // The revision that did resolve is removed.
    assert!(store.remove("buf-a", 5).unwrap().removed);
    assert!(store.list().unwrap().is_empty());
}

#[test]
fn the_real_policy_is_wired_into_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path().join("recovery"));

    // Disclosure: the location is reported and usable.
    let location = store.location();
    assert!(location.available);
    assert!(location.root.ends_with("recovery"));

    // 10 MiB per file is policy, not an accident of the test double: a draft
    // one byte over is refused before anything is written.
    let over = record(
        "buf-a",
        1,
        "/home/me/a.txt",
        "sp-a",
        &"x".repeat(10 * 1024 * 1024),
    );
    assert_eq!(
        store.put(&over).unwrap_err(),
        StoreError::Quota {
            reason: QuotaReason::FileLimit
        }
    );
    assert!(store.list().unwrap().is_empty());
}

#[test]
fn an_unusable_directory_is_unavailable_not_silent() {
    let dir = tempfile::tempdir().unwrap();
    // A file where the recovery directory should be: nothing can be created.
    let blocked = dir.path().join("recovery");
    fs::write(&blocked, b"not a directory").unwrap();
    let store = smoke_store(blocked);

    assert!(!store.location().available);
    match store
        .put(&record("buf-a", 1, "/home/me/a.txt", "sp-a", "text"))
        .unwrap_err()
    {
        StoreError::Unavailable { message } => assert!(!message.is_empty()),
        other => panic!("expected unavailable, got {other:?}"),
    }
}

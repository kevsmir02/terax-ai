//! Pure validation and naming for refs, revisions, task ids and slugs. These
//! are the cheap, conservative pre-filters that run before anything reaches a
//! git argument list; `git check-ref-format` stays the authority for branch
//! names (see `plumbing::check_branch_name`).

/// Root of every ref this fork writes: `refs/<namespace>`, never upstream's `refs/terax`.
pub fn ref_root() -> String {
    format!("refs/{}", crate::modules::identity::namespace())
}

/// Checkpoint refs of this fork. A ref namespace shared with another installation would
/// let one application list, restore or prune the other's checkpoints.
pub fn checkpoint_prefix() -> String {
    format!("{}/checkpoints/", ref_root())
}

/// Task archive refs of this fork.
pub fn task_archive_prefix(task_id: &str) -> String {
    format!("{}/tasks/{task_id}/archive/", ref_root())
}

/// Manual checkpoint refs of this fork, deliberately a separate root instead of
/// a `<task>` directory under `checkpoints/`: a task literally named `manual`
/// can then never collide with a manual checkpoint id.
pub fn manual_checkpoint_prefix() -> String {
    format!("{}/manual-checkpoints/", ref_root())
}

/// A manual checkpoint id is 16 random bytes in lowercase hex: opaque, stable
/// and independent of task ids, turn numbers or the user's optional name.
pub fn is_valid_manual_checkpoint_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn manual_checkpoint_ref(id: &str) -> String {
    format!("{}{id}", manual_checkpoint_prefix())
}

/// The id of a manual checkpoint ref, or `None` for anything else.
pub fn parse_manual_checkpoint_ref(name: &str) -> Option<&str> {
    let id = name.strip_prefix(&manual_checkpoint_prefix())?;
    is_valid_manual_checkpoint_id(id).then_some(id)
}

const MAX_REF_BYTES: usize = 255;

/// Characters git forbids anywhere in a ref name, plus whitespace and control
/// characters, which no legitimate name needs and which would corrupt line
/// oriented plumbing output.
fn is_forbidden_ref_char(c: char) -> bool {
    c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
}

/// A necessary condition for a valid branch or ref name. A name that passes is
/// still checked by git; one that fails never reaches it.
pub fn is_plausible_ref_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_REF_BYTES || name == "@" {
        return false;
    }
    if name.starts_with('-') || name.starts_with('/') || name.ends_with('/') || name.ends_with('.')
    {
        return false;
    }
    if name.contains("..") || name.contains("@{") || name.contains("//") {
        return false;
    }
    if name.chars().any(is_forbidden_ref_char) {
        return false;
    }
    name.split('/')
        .all(|part| !part.starts_with('.') && !part.ends_with(".lock"))
}

/// A revision expression safe to hand to `git rev-parse` as a single argument:
/// never an option, never multi-line. What it resolves to is decided by git.
pub fn is_safe_rev(rev: &str) -> bool {
    !rev.is_empty()
        && rev.len() <= MAX_REF_BYTES
        && !rev.starts_with('-')
        && !rev.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Task ids become a path component of a ref, so they are held to a strict
/// alphabet.
pub fn is_valid_task_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= 64
        && first.is_ascii_alphanumeric()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !id.contains("..")
        && !id.ends_with('.')
        && !id.ends_with(".lock")
}

pub fn checkpoint_ref(task_id: &str, turn: u32) -> String {
    format!("{}{task_id}/{turn}", checkpoint_prefix())
}

pub fn checkpoint_task_prefix(task_id: &str) -> String {
    format!("{}{task_id}/", checkpoint_prefix())
}

/// `(task id, turn)` of a checkpoint ref, or `None` for anything else.
pub fn parse_checkpoint_ref(name: &str) -> Option<(&str, u32)> {
    let rest = name.strip_prefix(&checkpoint_prefix())?;
    let (task, turn) = rest.split_once('/')?;
    if !is_valid_task_id(task) || turn.is_empty() || turn.len() > 10 {
        return None;
    }
    if !turn.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((task, turn.parse().ok()?))
}

/// The ref a restore saves the pre-restore working tree under.
pub fn prerestore_ref(task_id: &str, millis: u64) -> String {
    format!("{}{task_id}/prerestore-{millis}", checkpoint_prefix())
}

/// `(task id, millis)` of a pre-restore safety ref.
pub fn parse_prerestore_ref(name: &str) -> Option<(&str, u64)> {
    let rest = name.strip_prefix(&checkpoint_prefix())?;
    let (task, tail) = rest.split_once('/')?;
    let millis = tail.strip_prefix("prerestore-")?;
    if !is_valid_task_id(task) || millis.is_empty() || millis.len() > 20 {
        return None;
    }
    if !millis.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((task, millis.parse().ok()?))
}

/// The task a ref names when it is something a restore may start from: a turn
/// checkpoint or a pre-restore safety snapshot.
pub fn parse_restore_source(name: &str) -> Option<&str> {
    parse_checkpoint_ref(name)
        .map(|(task, _)| task)
        .or_else(|| parse_prerestore_ref(name).map(|(task, _)| task))
}

/// Lowercase `[a-z0-9._-]` slug of at most `max` characters, never empty and
/// never starting with a dot or dash.
pub fn slugify(input: &str, max: usize) -> String {
    let mut out = String::with_capacity(input.len().min(max));
    let mut last_dash = true;
    for c in input.chars() {
        let mapped = if c.is_ascii_alphanumeric() {
            Some(c.to_ascii_lowercase())
        } else if matches!(c, '.' | '_') && !out.is_empty() {
            Some(c)
        } else {
            None
        };
        match mapped {
            Some(c) => {
                out.push(c);
                last_dash = false;
            }
            None if !last_dash => {
                out.push('-');
                last_dash = true;
            }
            None => {}
        }
        if out.len() >= max {
            break;
        }
    }
    let trimmed = out.trim_matches(|c| matches!(c, '-' | '.' | '_'));
    if trimmed.is_empty() {
        "task".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plausible_ref_names() {
        for ok in [
            "main",
            "feature/x",
            "fix-1_2.3",
            "release/v1.0",
            "a/b/c",
            "caf\u{e9}",
        ] {
            assert!(is_plausible_ref_name(ok), "{ok}");
        }
        for bad in [
            "",
            "@",
            "-rf",
            "--force",
            "a..b",
            "a b",
            "a\tb",
            "a\nb",
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[0]",
            "a\\b",
            "/lead",
            "trail/",
            "dot.",
            "a//b",
            "a@{u}",
            ".hidden",
            "a/.hidden",
            "x.lock",
            "a/x.lock/b",
        ] {
            assert!(!is_plausible_ref_name(bad), "{bad:?}");
        }
        assert!(!is_plausible_ref_name(&"a".repeat(256)));
    }

    #[test]
    fn safe_revs() {
        for ok in [
            "HEAD",
            "main",
            "origin/main",
            "HEAD~3",
            "v1.0^{commit}",
            "abc123",
            "@{u}",
        ] {
            assert!(is_safe_rev(ok), "{ok}");
        }
        for bad in ["", "-x", "--output=/etc/passwd", "a b", "a\nb", "a\0b"] {
            assert!(!is_safe_rev(bad), "{bad:?}");
        }
    }

    #[test]
    fn task_ids() {
        for ok in ["t1", "task-42", "A.b_c", "0abc"] {
            assert!(is_valid_task_id(ok), "{ok}");
        }
        for bad in [
            "",
            ".x",
            "-x",
            "a/b",
            "a..b",
            "a b",
            "x.lock",
            "x.",
            "a\0",
            &"a".repeat(65),
        ] {
            assert!(!is_valid_task_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn checkpoint_refs_round_trip() {
        let name = checkpoint_ref("task-1", 7);
        assert_eq!(name, format!("{}task-1/7", checkpoint_prefix()));
        assert_eq!(parse_checkpoint_ref(&name), Some(("task-1", 7)));
        assert_eq!(
            checkpoint_task_prefix("task-1"),
            format!("{}task-1/", checkpoint_prefix())
        );
    }

    #[test]
    fn refs_live_in_the_fork_namespace_so_upstream_refs_stay_foreign() {
        let prefix = checkpoint_prefix();
        assert!(prefix.starts_with(&format!("{}/checkpoints/", ref_root())));
        assert!(!prefix.starts_with("refs/terax/"), "{prefix}");
        // An upstream checkpoint/archive ref is not ours: it never parses, so this
        // application cannot list, restore or prune it.
        assert_eq!(parse_checkpoint_ref("refs/terax/checkpoints/task-1/7"), None);
        assert_eq!(
            parse_prerestore_ref("refs/terax/checkpoints/task-1/prerestore-1"),
            None
        );
        assert!(!task_archive_prefix("task-1").starts_with("refs/terax/"));
        assert_eq!(
            parse_manual_checkpoint_ref("refs/terax/manual-checkpoints/0123456789abcdef0123456789abcdef"),
            None
        );
    }

    #[test]
    fn manual_checkpoint_refs_round_trip_and_never_collide_with_tasks() {
        let id = "0123456789abcdef0123456789abcdef";
        let name = manual_checkpoint_ref(id);
        assert_eq!(
            name,
            format!("{}/manual-checkpoints/{id}", ref_root())
        );
        assert_eq!(parse_manual_checkpoint_ref(&name), Some(id));
        // A task named `manual` cannot shadow a manual checkpoint, and a turn
        // ref is not a manual checkpoint.
        assert_eq!(
            parse_manual_checkpoint_ref(&checkpoint_ref("manual", 1)),
            None
        );
        assert_eq!(parse_checkpoint_ref(&name), None);
        for bad in [
            "".to_string(),
            manual_checkpoint_prefix(),
            format!("{}{id}/extra", manual_checkpoint_prefix()),
            format!("{}{}", manual_checkpoint_prefix(), "a".repeat(31)),
            format!("{}{}", manual_checkpoint_prefix(), "g".repeat(32)),
        ] {
            assert_eq!(parse_manual_checkpoint_ref(&bad), None, "{bad}");
        }
    }

    #[test]
    fn foreign_or_malformed_checkpoint_refs_do_not_parse() {
        let prefix = checkpoint_prefix();
        let bad = [
            "refs/heads/main".to_string(),
            prefix.clone(),
            format!("{prefix}task"),
            format!("{prefix}task/"),
            format!("{prefix}task/x"),
            format!("{prefix}task/-1"),
            format!("{prefix}../7"),
            format!("{prefix}a/b/7"),
            format!("{prefix}task/99999999999"),
        ];
        for bad in bad {
            assert_eq!(parse_checkpoint_ref(&bad), None, "{bad}");
        }
    }

    #[test]
    fn slugs_are_safe_and_bounded() {
        assert_eq!(slugify("Fix Login Bug!", 48), "fix-login-bug");
        assert_eq!(slugify("  --weird__name..  ", 48), "weird__name");
        assert_eq!(slugify("../../etc/passwd", 48), "etc-passwd");
        assert_eq!(slugify("", 48), "task");
        assert_eq!(slugify("!!!", 48), "task");
        assert_eq!(slugify("\u{4f60}\u{597d}", 48), "task");
        assert_eq!(slugify(&"a".repeat(100), 10), "aaaaaaaaaa");
        let slug = slugify("A/B\\C:D", 48);
        assert!(slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_')));
    }
}

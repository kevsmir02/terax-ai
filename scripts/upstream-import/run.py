#!/usr/bin/env python3
"""Selective upstream imports: verify the upstream remote, import one fix, prove the gates.

The fork keeps a working Linux application while upstream Terax keeps moving, so fixes arrive by
selective import, not by merging an unrelated branch wholesale (ADR 0002). That makes the remote
layout and the import a reviewed procedure with refusals:

  remotes       `origin` is this fork and `upstream` is the upstream project. Importing from your
                own fork looks like an upstream import and brings nothing upstream; a rewritten
                `origin` means `git push` lands in someone else's project. Both are refused.
  verify        `git ls-remote` proves the upstream remote is reachable, and the report records
                the upstream head, the merge base with this branch and how far the two have
                drifted. A remote that cannot be reached is UNVERIFIED, never "checked".
  preflight     an import starts from a clean tree (uncommitted work is never carried into an
                import branch), only imports commits reachable from the upstream branch, and is
                not repeated for a commit this branch already carries.
  import        one commit at a time on `upstream-import/<short sha>` with `git cherry-pick -x`,
                so the imported commit names where it came from.
  conflict      a conflicting import stops and lists the conflicted paths; it never resolves
                silently and never pushes.
  gates         after the import: types, lint, formatting, the frontend suite, the repository
                guards and the pinned Ghostty revision check (ticket #32). A Rust change adds the
                locked cargo gates; a terminal-core change additionally rebuilds the artifacts
                with the same Ghostty update procedure.

Usage:

    python3 scripts/upstream-import/run.py --plan
    python3 scripts/upstream-import/run.py --verify --fetch --output /path/evidence
    python3 scripts/upstream-import/run.py --setup-upstream --fetch
    python3 scripts/upstream-import/run.py --import <40-hex upstream commit> --output /path/evidence

Nothing here pushes: the procedure is local, and its report records that (`push` never appears in
the executed git commands).
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent

UPSTREAM_REMOTE = "upstream"
ORIGIN_REMOTE = "origin"
# The project this fork came from. `origin` is deliberately not asserted by URL: a maintainer may
# rename or re-clone the fork, and the refusal that matters is that origin is *not* upstream.
UPSTREAM_SLUG = "crynta/terax-ai"
UPSTREAM_URL = f"https://github.com/{UPSTREAM_SLUG}.git"
UPSTREAM_BRANCH = "main"
IMPORT_BRANCH_PREFIX = "upstream-import/"

ALWAYS_GATES = (
    ("types", "pnpm check-types", "the imported change still type-checks"),
    ("lint", "pnpm lint", "the imported change passes the repository lint"),
    ("format", "pnpm format:check", "the imported change is formatted (never `pnpm format`: it rewrites the tree)"),
    ("tests", "pnpm test", "the imported change passes the frontend suite"),
    ("repo-guards", "python3 -m unittest discover -s scripts/tests", "the repository contracts still hold"),
    (
        "provenance",
        "python3 scripts/ghostty-update/run.py --check",
        "the pinned Ghostty revision and shipped artifacts still agree (ticket #32)",
    ),
)
RUST_GATES = (
    (
        "rust",
        "cargo nextest run --locked",
        "the imported Rust change passes the locked suite",
        "src-tauri",
    ),
    (
        "rust-lint",
        "cargo clippy --all-targets --locked -- -D warnings",
        "the imported Rust change passes the locked lint",
        "src-tauri",
    ),
)
TERMINAL_GATES = (
    (
        "terminal-artifacts",
        "python3 scripts/ghostty-update/run.py --rebuild",
        "the terminal core changed, so both artifacts are rebuilt from the pinned source and the "
        "compatibility, soak, bench and resource gates are re-run",
        None,
    ),
)
# A change here can alter the shipped terminal core, so a revision check is not enough.
TERMINAL_PATHS = ("packages/ghostty-core/",)
RUST_PATHS = ("src-tauri/",)


class Refusal(SystemExit):
    """A preflight decision: the procedure stops before it mutates anything."""

    def __init__(self, message: str) -> None:
        super().__init__(f"refusing: {message}")


@dataclasses.dataclass
class GateResult:
    """One decision of the procedure. `status` is pass, fail or unverified - never absent."""

    name: str
    status: str
    detail: str
    evidence: dict = dataclasses.field(default_factory=dict)


def slug(url: str | None) -> str:
    """`owner/repo` for the GitHub spellings git actually stores (https, ssh, ssh://)."""
    if not url:
        return ""
    trimmed = url.strip()
    match = re.search(r"github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?/?$", trimmed)
    if match:
        return f"{match.group(1)}/{match.group(2)}"
    return trimmed


def parse_remotes(text_body: str) -> dict[str, dict[str, str | None]]:
    """Read `git remote -v` into `{name: {fetch, push}}`."""
    remotes: dict[str, dict[str, str | None]] = {}
    for line in text_body.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        name, url, kind = parts[0], parts[1], parts[2].strip("()")
        remotes.setdefault(name, {"fetch": None, "push": None})
        if kind == "fetch":
            remotes[name]["fetch"] = url
        elif kind == "push":
            remotes[name]["push"] = url
    return remotes


def remote_gate(
    remotes: dict[str, dict[str, str | None]],
    upstream_slug: str = UPSTREAM_SLUG,
    origin_remote: str = ORIGIN_REMOTE,
    upstream_remote: str = UPSTREAM_REMOTE,
) -> GateResult:
    """Upstream and origin must be two different projects, and origin must not be upstream."""
    upstream = remotes.get(upstream_remote)
    origin = remotes.get(origin_remote)
    problems = []
    if upstream is None:
        problems.append(
            f"no `{upstream_remote}` remote: add it with `python3 scripts/upstream-import/run.py "
            f"--setup-upstream` (it must point at {upstream_slug}, never at the fork)"
        )
    elif slug(upstream.get("fetch")) != upstream_slug:
        problems.append(
            f"`{upstream_remote}` points at {slug(upstream.get('fetch')) or 'nothing'}, not "
            f"{upstream_slug}: imports would come from the wrong project"
        )
    if origin is None:
        problems.append(
            f"no `{origin_remote}` remote: this checkout has no fork to push to, so it is not the "
            f"fork layout the import procedure assumes"
        )
    elif slug(origin.get("fetch")) == upstream_slug:
        problems.append(
            f"`{origin_remote}` is the upstream project {upstream_slug}: a push from this checkout "
            f"would publish there, so the fork origin must be a separate remote"
        )
    if problems:
        return GateResult("upstream", "fail", "; ".join(problems), {"remotes": remotes})
    return GateResult(
        "upstream",
        "pass",
        f"upstream {upstream_slug}, fork origin {slug(origin.get('fetch'))}",
        {"upstream": upstream, "origin": origin},
    )


def setup_actions(
    remotes: dict[str, dict[str, str | None]],
    upstream_url: str = UPSTREAM_URL,
    upstream_remote: str = UPSTREAM_REMOTE,
) -> list[list[str]]:
    """The `git` argument lists that make the upstream remote exist, without rewriting anything."""
    existing = remotes.get(upstream_remote)
    if existing is None:
        return [["remote", "add", upstream_remote, upstream_url]]
    found = slug(existing.get("fetch"))
    if found != slug(upstream_url):
        raise Refusal(
            f"`{upstream_remote}` already points at {found}; this procedure does not rewrite an "
            f"existing remote. Rename or remove it deliberately, then re-run"
        )
    return []


# --------------------------------------------------------------------------- preflight


def dirty_tree_gate(porcelain: str) -> GateResult:
    """An import starts from a committed tree: uncommitted work must not ride along."""
    paths = [line[3:] for line in porcelain.splitlines() if line.strip()]
    if paths:
        return GateResult(
            "clean-tree",
            "fail",
            "uncommitted changes: " + ", ".join(paths) + " - commit or stash them first, the import "
            "branch must not carry work that is not part of the imported commit",
            {"paths": paths},
        )
    return GateResult("clean-tree", "pass", "the tree is clean")


def import_branch_name(sha: str) -> str:
    """A branch per import, named after the commit, so review stays one commit wide."""
    return f"{IMPORT_BRANCH_PREFIX}{sha[:7]}"


def already_imported_gate(sha: str, imported: list[dict]) -> GateResult:
    """The same upstream commit is not imported twice under two branch names."""
    for entry in imported:
        if str(entry.get("sha", "")).startswith(sha[:7]) or sha.startswith(str(entry.get("sha", ""))[:7]):
            return GateResult(
                "not-already-imported",
                "fail",
                f"{sha[:7]} was already imported as `{entry.get('subject', entry.get('sha'))}`; "
                f"re-importing it would duplicate history",
                {"imported": imported},
            )
    return GateResult("not-already-imported", "pass", "not imported yet")


def classify_paths(paths: list[str]) -> dict:
    """Which gate tier a commit's paths require. Derived from the paths, not from the commit message."""
    return {
        "rust": any(path.startswith(RUST_PATHS) for path in paths),
        "terminal": any(path.startswith(TERMINAL_PATHS) for path in paths),
    }


def gate_plan(paths: list[str]) -> list[dict]:
    """The gates an import runs, derived from the paths the imported commit touches."""
    tiers = classify_paths(paths)
    plan = [
        {
            "gate": name,
            "command": command,
            "intent": intent,
            "status": "required",
            "cwd": None,
        }
        for name, command, intent in ALWAYS_GATES
    ]
    if tiers["rust"]:
        plan.extend(
            {"gate": name, "command": command, "intent": intent, "status": "required", "cwd": cwd}
            for name, command, intent, cwd in RUST_GATES
        )
    if tiers["terminal"]:
        plan.extend(
            {"gate": name, "command": command, "intent": intent, "status": "required", "cwd": cwd}
            for name, command, intent, cwd in TERMINAL_GATES
        )
    return plan


def run_gates(plan: list[dict], runner) -> list[GateResult]:
    """Run the planned gates through `runner(entry) -> (code, log)`; a failure is never a pass."""
    results = []
    for entry in plan:
        code, log = runner(entry)
        lines = [line for line in str(log).splitlines() if line.strip()]
        # Keep enough of the tail that a failure names the failing test or command, not just an
        # exit code: the whole log belongs to the terminal, the report keeps the diagnosis.
        tail = lines[-25:]
        results.append(
            GateResult(
                entry["gate"],
                "pass" if code == 0 else "fail",
                " / ".join(tail[-3:]) or ("passed" if code == 0 else f"exit {code}"),
                {"command": entry["command"], "cwd": entry.get("cwd"), "logTail": tail},
            )
        )
    return results


def acceptance(results: list[GateResult], accepted_unverified: tuple[str, ...] = ()) -> int:
    """0 only when nothing failed and every unverified gate was accepted by name."""
    for result in results:
        if result.status == "fail":
            return 1
        if result.status == "unverified" and result.name not in accepted_unverified:
            return 1
    return 0


# --------------------------------------------------------------------------- git


def git(args: list[str], cwd: Path | str | None = None) -> tuple[int, str]:
    process = subprocess.run(
        ["git", *args],
        cwd=str(cwd or REPO),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    # Trailing newlines only: `git status --porcelain` puts the index/worktree state in the first
    # two columns, so a leading space is data, not padding.
    return process.returncode, process.stdout.rstrip("\n")


@dataclasses.dataclass
class ImportReport:
    sha: str
    branch: str
    imported: bool
    status: str
    conflicted: list[str] = dataclasses.field(default_factory=list)
    gates: list[GateResult] = dataclasses.field(default_factory=list)
    touched: list[str] = dataclasses.field(default_factory=list)

    def detail(self) -> str:
        return f"{self.status} {self.sha[:7]}: " + (
            ", ".join(self.conflicted) or "no conflicted paths"
        )

    def summary(self) -> str:
        return f"{self.branch} imported={self.imported} status={self.status}"

    def as_dict(self) -> dict:
        return {
            "sha": self.sha,
            "branch": self.branch,
            "imported": self.imported,
            "status": self.status,
            "conflicted": self.conflicted,
            "touched": self.touched,
            "gates": [dataclasses.asdict(result) for result in self.gates],
        }


def import_commit(
    sha: str,
    *,
    cwd: Path | str | None = None,
    base_ref: str = f"refs/remotes/{UPSTREAM_REMOTE}/{UPSTREAM_BRANCH}",
    git=git,
    gate_runner=None,
) -> ImportReport:
    """Cherry-pick one upstream commit onto a dedicated import branch and run its gate tier.

    Raises `Refusal` for a decision that must be made before anything is mutated (dirty tree,
    commit not on the upstream branch, already imported, branch name taken). A merge conflict is
    not a refusal: it leaves the cherry-pick in progress, lists the paths and returns.
    """
    code, out = git(["rev-parse", "--verify", f"{sha}^{{commit}}"], cwd)
    if code != 0:
        raise Refusal(
            f"{sha} is not in this repository: fetch the upstream branch first "
            f"(`git fetch {UPSTREAM_REMOTE} {UPSTREAM_BRANCH}`)"
        )
    full = out.splitlines()[0]
    if not re.fullmatch(r"[0-9a-f]{40}", full):
        raise Refusal(f"{sha} did not resolve to a commit ({full!r})")

    status_code, porcelain = git(["status", "--porcelain"], cwd)
    if status_code != 0:
        raise Refusal(f"`git status` failed: {porcelain}")
    dirty = dirty_tree_gate(porcelain)
    if dirty.status != "pass":
        raise Refusal(dirty.detail)

    code, _ = git(["merge-base", "--is-ancestor", full, base_ref], cwd)
    if code != 0:
        label = re.sub(r"^refs/remotes/", "", base_ref)
        raise Refusal(
            f"{full[:7]} is not reachable from {label}: import upstream commits, not local ones"
        )

    code, found = git(
        ["log", "--all", "--format=%H", "--fixed-strings", f"--grep=(cherry picked from commit {full})"],
        cwd,
    )
    imported = [{"sha": line, "subject": ""} for line in found.splitlines() if line] if code == 0 else []
    duplicate = already_imported_gate(full, imported)
    if duplicate.status != "pass":
        raise Refusal(duplicate.detail)

    branch = import_branch_name(full)
    code, existing = git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd)
    if code == 0:
        raise Refusal(
            f"branch `{branch}` already exists: finish, merge or delete that import before "
            f"importing {full[:7]} again"
        )
    code, out = git(["switch", "-c", branch], cwd)
    if code != 0:
        raise Refusal(f"could not create `{branch}`: {out}")

    code, out = git(["cherry-pick", "-x", full], cwd)
    if code != 0:
        _, conflicted = git(["diff", "--name-only", "--diff-filter=U"], cwd)
        paths = [line for line in conflicted.splitlines() if line]
        report = ImportReport(full, branch, False, "conflict", paths)
        if not paths:
            # A failure that is not a conflict (missing identity, hooks) must not look resolvable.
            report.status = "failed"
        return report

    _, touched = git(["show", "--name-only", "--format=", full], cwd)
    paths = [line for line in touched.splitlines() if line]
    plan = gate_plan(paths)
    results = (
        gate_runner(plan)
        if gate_runner
        else run_gates(plan, default_gate_runner(plan, cwd))
    )
    report = ImportReport(full, branch, True, "imported", [], results, paths)
    return report


def default_gate_runner(plan: list[dict], cwd: Path | str | None = None):
    """Run the planned commands in this checkout (or in `cwd` for a scratch repository)."""

    def runner(entry: dict) -> tuple[int, str]:
        where = Path(cwd or REPO)
        if entry.get("cwd"):
            where = where / entry["cwd"]
        process = subprocess.run(
            entry["command"],
            cwd=str(where),
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        return process.returncode, process.stdout

    return runner


# --------------------------------------------------------------------------- verification


def verify_report(
    *,
    remotes: dict[str, dict[str, str | None]],
    upstream_head: str | None,
    topology: dict | None,
    branch: str,
    head: str,
    error: str | None = None,
) -> dict:
    """Record what the upstream remote is, where it is, and how far this branch has drifted.

    Reachability is never assumed: without a `git ls-remote` answer the connectivity gate is
    unverified and the report is not `verified`.
    """
    identities = remote_gate(remotes)
    if upstream_head:
        connectivity = GateResult(
            "connectivity",
            "pass",
            f"`git ls-remote --heads {UPSTREAM_REMOTE} {UPSTREAM_BRANCH}` returned {upstream_head}",
            {"head": upstream_head},
        )
    else:
        connectivity = GateResult(
            "connectivity",
            "unverified",
            f"`git ls-remote {UPSTREAM_REMOTE}` did not answer"
            + (f": {error}" if error else "")
            + " - the upstream remote has not been shown to be reachable from this machine",
        )
    if topology:
        drift = GateResult(
            "drift",
            "pass",
            f"merge base {topology.get('mergeBase', '')[:7]}, {topology.get('ahead')} commits ahead, "
            f"{topology.get('behind')} upstream commits not imported",
            topology,
        )
    else:
        drift = GateResult(
            "drift",
            "unverified",
            "no upstream branch in this checkout, so the importable range is unknown "
            f"(`git fetch {UPSTREAM_REMOTE} {UPSTREAM_BRANCH}`)",
        )
    gates = {
        "upstream": dataclasses.asdict(identities),
        "connectivity": dataclasses.asdict(connectivity),
        "drift": dataclasses.asdict(drift),
    }
    verified = identities.status == "pass" and connectivity.status == "pass" and drift.status == "pass"
    origin = remotes.get(ORIGIN_REMOTE) or {}
    upstream = remotes.get(UPSTREAM_REMOTE) or {}
    return {
        "scope": "upstream remote identity, reachability and the importable commit range for this "
                 "branch. Nothing here pushes, and no upstream commit is imported by a verify run.",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "verified": verified,
        "branch": branch,
        "head": head,
        "origin": {"url": origin.get("fetch"), "slug": slug(origin.get("fetch"))},
        "upstream": {
            "url": upstream.get("fetch"),
            "slug": slug(upstream.get("fetch")),
            "branch": UPSTREAM_BRANCH,
            "head": upstream_head,
        },
        "topology": topology,
        "gates": gates,
    }


def topology(cwd: Path | str | None = None, base_ref: str = f"refs/remotes/{UPSTREAM_REMOTE}/{UPSTREAM_BRANCH}") -> dict | None:
    """Merge base and ahead/behind counts against the fetched upstream branch."""
    code, merge_base = git(["merge-base", "HEAD", base_ref], cwd)
    if code != 0:
        return None
    code, ahead = git(["rev-list", "--count", f"{base_ref}..HEAD"], cwd)
    if code != 0:
        return None
    code, behind = git(["rev-list", "--count", f"HEAD..{base_ref}"], cwd)
    if code != 0:
        return None
    return {"mergeBase": merge_base, "ahead": int(ahead), "behind": int(behind)}


def ls_remote_head(cwd: Path | str | None = None, git=git, remote: str = UPSTREAM_REMOTE) -> tuple[str | None, str | None]:
    """The upstream branch head, or `(None, reason)` when it cannot be read."""
    code, out = git(["ls-remote", "--heads", remote, UPSTREAM_BRANCH], cwd)
    if code != 0:
        return None, (out.strip().splitlines() or [f"ls-remote exit {code}"])[-1]
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].endswith(f"/{UPSTREAM_BRANCH}"):
            return parts[0], None
    return None, f"ls-remote returned no refs/heads/{UPSTREAM_BRANCH}"


# --------------------------------------------------------------------------- procedure text


def plan_lines() -> list[str]:
    """The documented procedure, printed by `--plan` and quoted by the repository doc."""
    return [
        "1. Setup    : `git remote add upstream https://github.com/crynta/terax-ai.git` - additive,",
        "              idempotent, and it never rewrites the fork's `origin` remote. Verify with",
        "              `python3 scripts/upstream-import/run.py --verify --fetch`.",
        "2. Fetch    : `git fetch --no-tags upstream main` (the verify run does this with --fetch).",
        "3. Review   : `git log --oneline HEAD..upstream/main` and read the diff of each candidate",
        "              (`git show <sha>`). Import the fixes this fork needs, not a whole branch.",
        "4. Import   : `python3 scripts/upstream-import/run.py --import <sha>` creates",
        "              `upstream-import/<short sha>` and runs `git cherry-pick -x <sha>`.",
        "5. Conflict : the run stops, lists the conflicted paths and leaves the cherry-pick in",
        "              progress. Resolve by hand, keeping the fork's Linux scope (ADR 0002), then",
        "              `git add` and `git cherry-pick --continue`; `git cherry-pick --abort` returns",
        "              to the pre-import branch. A conflict is never resolved by taking one side.",
        "6. Gates    : types, lint, format check, the frontend suite, the repository guards and the",
        "              pinned Ghostty revision check (ticket #32). A change under `src-tauri/` adds",
        "              the locked cargo gates; a change under `packages/ghostty-core/` rebuilds the",
        "              artifacts with `scripts/ghostty-update/run.py --rebuild`, which also re-runs",
        "              compatibility, soak, benchmark and whole-app resource comparisons.",
        "7. Rebuild  : a terminal-core import is not a drop-in binary update; the rebuild gate above",
        "              is what proves the artifacts still come from the pinned source.",
        "8. Land     : review the branch, merge it locally, then delete it. The procedure never pushes:",
        "              publishing is a separate, deliberate action by the maintainer.",
    ]


def render_plan() -> str:
    return "\n".join(
        [
            "Selective upstream import procedure",
            "",
            *plan_lines(),
            "",
            "Refusals: a dirty tree, a commit that is not reachable from upstream/main, an",
            "already-imported commit, a taken import branch name, and an `upstream` remote that",
            "does not point at crynta/terax-ai all stop before anything is mutated.",
        ]
    )


# --------------------------------------------------------------------------- cli


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--verify", action="store_true", help="verify the remotes and the importable range")
    action.add_argument("--setup-upstream", action="store_true", help="add the upstream remote if it is missing")
    action.add_argument("--import", dest="import_sha", metavar="SHA", help="import one upstream commit")
    parser.add_argument("--fetch", action="store_true", help="fetch the upstream branch from the remote")
    parser.add_argument("--output", type=Path, help="directory for the JSON report")
    parser.add_argument("--plan", action="store_true", help="print the documented procedure and exit")
    parser.add_argument("--accept-unverified", default="", help="comma-separated gate names to accept unverified")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.plan:
        print(render_plan())
        return 0
    accepted = tuple(name for name in args.accept_unverified.split(",") if name)
    output = args.output

    code, remote_text = git(["remote", "-v"])
    if code != 0:
        print(remote_text, file=sys.stderr)
        return 1
    remotes = parse_remotes(remote_text)

    if args.setup_upstream:
        actions = setup_actions(remotes)
        if not actions:
            print(f"upstream: already configured as {slug(remotes[UPSTREAM_REMOTE].get('fetch'))}")
        for action in actions:
            code, out = git(action)
            print(f"git {' '.join(action)}: {'ok' if code == 0 else out}")
            if code != 0:
                return 1
        if args.fetch:
            code, out = git(["fetch", "--no-tags", UPSTREAM_REMOTE, UPSTREAM_BRANCH])
            print(f"git fetch {UPSTREAM_REMOTE} {UPSTREAM_BRANCH}: {'ok' if code == 0 else out}")
            if code != 0:
                return 1
        return 0

    if args.fetch:
        code, out = git(["fetch", "--no-tags", UPSTREAM_REMOTE, UPSTREAM_BRANCH])
        print(f"git fetch {UPSTREAM_REMOTE} {UPSTREAM_BRANCH}: {'ok' if code == 0 else out}")

    if args.import_sha:
        report = import_commit(args.import_sha)
        print(f"{report.status:10} {report.branch} {report.detail()}")
        for result in report.gates:
            print(f"  {result.status:10} {result.name:18} {result.detail}")
        payload = {"scope": "one selective upstream import", **report.as_dict()}
        if output:
            print(f"report: {write_json(output / 'upstream-import.json', payload)}")
        if report.status == "conflict":
            print("The cherry-pick is still in progress: resolve the conflicted paths, then")
            print("`git add <paths> && git cherry-pick --continue`, or `git cherry-pick --abort`.")
            return 3
        return acceptance(report.gates, accepted)

    upstream_head, error = ls_remote_head()
    topology_record = topology()
    code, branch = git(["branch", "--show-current"])
    code, head = git(["rev-parse", "HEAD"])
    report = verify_report(
        remotes=remotes,
        upstream_head=upstream_head,
        topology=topology_record,
        branch=branch,
        head=head,
        error=error,
    )
    print(f"origin   : {report['origin']['slug'] or 'missing'}")
    print(f"upstream : {report['upstream']['slug'] or 'missing'} ({UPSTREAM_URL})")
    for name, gate in report["gates"].items():
        print(f"{gate['status']:10} {name:12} {gate['detail']}")
    if output:
        print(f"report: {write_json(output / 'upstream-verify.json', report)}")
    print("VERIFIED" if report["verified"] else "NOT VERIFIED: see the unverified gate above")
    if report["verified"]:
        return 0
    return 0 if accepted else 1


if __name__ == "__main__":
    sys.exit(main())

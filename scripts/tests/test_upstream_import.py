"""The fork's upstream-import contract (issue #35, user stories 95, 98, 99, 100).

The fork keeps importing selected upstream fixes, so the import has to be a procedure with
refusals, not a habit:

* the upstream project and the fork's own origin are two different remotes, and the procedure
  never rewrites `origin` (a rewritten origin means `git push` lands in someone else's project);
* only commits that are actually reachable from the upstream branch may be imported, one at a
  time, with `-x` provenance;
* uncommitted work is never carried into an import branch;
* the gates that matter (types, lint, tests, repository guards, the pinned Ghostty revision) run
  after the import, and a terminal-core import additionally rebuilds the artifacts - the ticket
  #32 gate, not a second mechanism.

Run with: `python3 -m unittest discover -s scripts/tests`
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RUN_PY = REPO / "scripts/upstream-import/run.py"

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Terax Test",
    "GIT_AUTHOR_EMAIL": "test@terax.invalid",
    "GIT_COMMITTER_NAME": "Terax Test",
    "GIT_COMMITTER_EMAIL": "test@terax.invalid",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


def load_module():
    spec = importlib.util.spec_from_file_location("upstream_import", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves string annotations through sys.modules, so register before executing.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        env={**os.environ, **GIT_ENV},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed in {repo}:\n{result.stdout}")
    return result.stdout.strip()


def commit(repo: Path, name: str, content: str, message: str) -> str:
    (repo / name).write_text(content)
    git(repo, "add", name)
    git(repo, "commit", "-m", message)
    return git(repo, "rev-parse", "HEAD")


class ScratchRepos:
    """An `upstream` repository and a fork that was cloned from it one commit earlier."""

    def __enter__(self):
        self._dir = tempfile.TemporaryDirectory()
        root = Path(self._dir.name)
        self.upstream = root / "upstream"
        self.fork = root / "fork"
        self.upstream.mkdir()
        git(self.upstream, "init", "-q", "-b", "main")
        self.base = commit(self.upstream, "app.txt", "line one\n", "base: upstream launch")
        git(root, "clone", "-q", str(self.upstream), str(self.fork))
        self.fix = commit(self.upstream, "app.txt", "line one\nline two\n", "fix: upstream crash fix")
        self.unrelated = commit(self.upstream, "docs.txt", "unrelated\n", "feat: unrelated upstream work")
        return self

    def __exit__(self, *exc):
        self._dir.cleanup()

    def fetch_upstream(self, fork: Path | None = None, remote_name: str = "upstream") -> None:
        fork = fork or self.fork
        git(fork, "remote", "add", remote_name, str(self.upstream))
        git(fork, "fetch", remote_name, "main")


class RemoteIdentityTest(unittest.TestCase):
    """Upstream and origin are separate remotes, and the fork's origin is never rewritten."""

    def setUp(self) -> None:
        self.module = load_module()

    def test_github_urls_are_compared_by_project_not_by_transport(self) -> None:
        for url in (
            "https://github.com/crynta/terax-ai",
            "https://github.com/crynta/terax-ai.git",
            "git@github.com:crynta/terax-ai.git",
            "ssh://git@github.com/crynta/terax-ai.git",
        ):
            with self.subTest(url):
                self.assertEqual(self.module.slug(url), "crynta/terax-ai")

    def test_the_two_remotes_must_be_distinct_projects(self) -> None:
        result = self.module.remote_gate(
            {
                "origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
                "upstream": {"fetch": "https://github.com/crynta/terax-ai.git", "push": None},
            }
        )
        self.assertEqual(result.status, "pass")

    def test_an_upstream_remote_pointing_at_the_fork_is_refused(self) -> None:
        # Importing from your own fork looks like an upstream import and brings nothing upstream.
        result = self.module.remote_gate(
            {
                "origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
                "upstream": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
            }
        )
        self.assertEqual(result.status, "fail")
        self.assertIn("crynta/terax-ai", result.detail)

    def test_a_missing_upstream_remote_is_reported_rather_than_guessed(self) -> None:
        result = self.module.remote_gate(
            {"origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None}}
        )
        self.assertEqual(result.status, "fail")
        self.assertIn("upstream", result.detail)

    def test_a_clone_whose_origin_is_the_upstream_project_is_refused(self) -> None:
        # No fork origin: a `git push` here would publish to the upstream project.
        result = self.module.remote_gate(
            {"origin": {"fetch": "git@github.com:crynta/terax-ai.git", "push": None}}
        )
        self.assertEqual(result.status, "fail")
        self.assertIn("origin", result.detail)

    def test_setup_is_idempotent_and_only_ever_adds_the_upstream_remote(self) -> None:
        remotes = {"origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None}}
        actions = self.module.setup_actions(remotes)
        self.assertEqual(actions, [["remote", "add", "upstream", self.module.UPSTREAM_URL]])
        self.assertEqual(self.module.setup_actions({"origin": remotes["origin"],
                                                    "upstream": {"fetch": self.module.UPSTREAM_URL,
                                                                 "push": None}}), [])

    def test_setup_refuses_to_rewrite_a_different_existing_upstream(self) -> None:
        remotes = {
            "origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
            "upstream": {"fetch": "git@github.com:someone/terax-ai.git", "push": None},
        }
        with self.assertRaises(self.module.Refusal) as refusal:
            self.module.setup_actions(remotes)
        self.assertIn("someone/terax-ai", str(refusal.exception))

    def test_the_fork_origin_is_only_ever_read_and_never_rewritten(self) -> None:
        for remotes in (
            {"origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None}},
            {"origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
             "upstream": {"fetch": self.module.UPSTREAM_URL, "push": None}},
        ):
            actions = self.module.setup_actions(remotes)
            self.assertNotIn("origin", {argument for action in actions for argument in action},
                             "setup must never add, set-url or remove the fork's origin remote")


class ParseRemotesTest(unittest.TestCase):
    def test_remotes_are_read_from_git_remote_v(self) -> None:
        module = load_module()
        text = (
            "origin\tgit@github.com:kevsmir02/terax-ai.git (fetch)\n"
            "origin\tgit@github.com:kevsmir02/terax-ai.git (push)\n"
            "upstream\thttps://github.com/crynta/terax-ai.git (fetch)\n"
            "upstream\tno_push (push)\n"
        )
        remotes = module.parse_remotes(text)
        self.assertEqual(remotes["origin"]["fetch"], "git@github.com:kevsmir02/terax-ai.git")
        self.assertEqual(remotes["upstream"]["fetch"], "https://github.com/crynta/terax-ai.git")
        self.assertEqual(remotes["upstream"]["push"], "no_push")


class ImportPreflightTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_a_dirty_tree_is_refused_and_the_paths_are_named(self) -> None:
        result = self.module.dirty_tree_gate(" M src/app.ts\n?? notes.md\n")
        self.assertEqual(result.status, "fail")
        self.assertIn("src/app.ts", result.detail)
        self.assertIn("notes.md", result.detail)

    def test_a_clean_tree_passes(self) -> None:
        self.assertEqual(self.module.dirty_tree_gate("").status, "pass")

    def test_the_import_branch_is_named_after_the_commit_and_never_the_working_branch(self) -> None:
        name = self.module.import_branch_name("abcdef1234567890abcdef1234567890abcdef12")
        self.assertEqual(name, "upstream-import/abcdef1")
        self.assertTrue(name.startswith(self.module.IMPORT_BRANCH_PREFIX))

    def test_a_commit_already_on_the_branch_is_not_imported_twice(self) -> None:
        result = self.module.already_imported_gate("a" * 40, [{"sha": "a" * 40, "subject": "fix: x"}])
        self.assertEqual(result.status, "fail")
        self.assertIn("already", result.detail)
        self.assertEqual(self.module.already_imported_gate("b" * 40, []).status, "pass")


class GatePlanTest(unittest.TestCase):
    """Which gates an import runs, derived from the paths the imported commit touches."""

    def setUp(self) -> None:
        self.module = load_module()

    def command_names(self, plan: list) -> list[str]:
        return [entry["command"] for entry in plan]

    def test_every_import_runs_the_types_lint_test_and_repository_gates(self) -> None:
        plan = self.module.gate_plan(["README.md"])
        joined = "\n".join(self.command_names(plan))
        for command in (
            "pnpm check-types",
            "pnpm lint",
            "pnpm format:check",
            "pnpm test",
            "python3 -m unittest discover -s scripts/tests",
        ):
            self.assertIn(command, joined, f"a frontend import must run {command}")
        for entry in plan:
            self.assertNotEqual(entry["status"], "skipped")

    def test_every_import_rechecks_the_pinned_ghostty_revision(self) -> None:
        # The terminal gate from ticket #32 is the provenance/artifact check; it never runs a
        # second mechanism and never assumes zig is installed.
        plan = self.module.gate_plan(["src/modules/terminal/model.ts"])
        provenance = [entry for entry in plan if entry["gate"] == "provenance"]
        self.assertTrue(provenance, "the import must recheck the pinned Ghostty revision")
        self.assertIn("scripts/ghostty-update/run.py --check", provenance[0]["command"])
        self.assertNotIn("--rebuild", provenance[0]["command"])

    def test_a_terminal_core_import_rebuilds_the_artifacts(self) -> None:
        plan = self.module.gate_plan(["packages/ghostty-core/adapted/wasm/terax.zig"])
        terminal = [entry for entry in plan if entry["gate"] == "terminal-artifacts"]
        self.assertTrue(terminal, "a terminal-core import must rebuild the Ghostty artifacts")
        self.assertIn("--rebuild", terminal[0]["command"])
        self.assertEqual(terminal[0]["status"], "required")

    def test_a_rust_import_runs_the_locked_rust_gates(self) -> None:
        plan = self.module.gate_plan(["src-tauri/src/modules/pty/mod.rs"])
        joined = "\n".join(self.command_names(plan))
        self.assertIn("cargo nextest run --locked", joined)
        self.assertIn("cargo clippy --all-targets --locked -- -D warnings", joined)
        # A frontend-only import does not need the Rust suite, and says so.
        frontend = {entry["gate"] for entry in self.module.gate_plan(["README.md"])}
        self.assertNotIn("rust", frontend)

    def test_a_gate_that_was_not_run_is_unverified_and_blocks_acceptance(self) -> None:
        plan = self.module.gate_plan(["README.md"])
        results = self.module.run_gates(plan, lambda entry: (0, "ok"))
        self.assertTrue(all(result.status == "pass" for result in results))
        refused = self.module.run_gates(plan, lambda entry: (1, "boom"))
        self.assertEqual(refused[0].status, "fail")
        self.assertEqual(self.module.acceptance(refused), 1)
        self.assertEqual(self.module.acceptance(results), 0)

    def test_a_failing_gate_reports_what_failed_not_only_an_exit_code(self) -> None:
        plan = self.module.gate_plan(["README.md"])
        log = "\n".join(["noise"] * 40 + ["FAIL src/modules/terminal/x.test.ts > does the thing"])
        results = self.module.run_gates(plan, lambda entry: (1, log))
        self.assertIn(
            "FAIL src/modules/terminal/x.test.ts",
            "\n".join(results[0].evidence["logTail"]),
            "the report keeps enough of the failing output to diagnose it",
        )


class SelectiveImportTest(unittest.TestCase):
    """A real cherry-pick between two scratch repositories, not a mock of one."""

    def setUp(self) -> None:
        # The procedure spawns its own `git`, so the scratch repositories must not inherit the
        # user's global config (signing keys, hooks, identity): only a temporary HOME-free config.
        patcher = mock.patch.dict(os.environ, GIT_ENV)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.module = load_module()
        self.repos = ScratchRepos().__enter__()
        self.addCleanup(self.repos.__exit__, None, None, None)

    def import_commit(self, sha: str, **kwargs):
        return self.module.import_commit(
            sha,
            cwd=self.repos.fork,
            gate_runner=lambda plan: [self.module.GateResult(entry["gate"], "pass", "stubbed")
                                      for entry in plan],
            **kwargs,
        )

    def test_the_import_brings_only_the_selected_upstream_commit(self) -> None:
        self.repos.fetch_upstream()
        report = self.import_commit(self.repos.fix)
        self.assertTrue(report.imported, report.summary())
        self.assertEqual((self.repos.fork / "app.txt").read_text(), "line one\nline two\n")
        # The other upstream commit is not here, and neither is its file.
        self.assertFalse((self.repos.fork / "docs.txt").exists())
        self.assertEqual(git(self.repos.fork, "branch", "--show-current"),
                         self.module.import_branch_name(self.repos.fix))

    def test_the_imported_commit_records_where_it_came_from(self) -> None:
        self.repos.fetch_upstream()
        self.import_commit(self.repos.fix)
        message = git(self.repos.fork, "log", "-1", "--format=%B")
        self.assertIn(f"(cherry picked from commit {self.repos.fix})", message)
        self.assertIn("fix: upstream crash fix", message)

    def test_a_commit_that_is_not_on_the_upstream_branch_is_refused(self) -> None:
        self.repos.fetch_upstream()
        local = commit(self.repos.fork, "local.txt", "mine\n", "local: not upstream")
        with self.assertRaises(self.module.Refusal) as refusal:
            self.import_commit(local)
        self.assertIn("not reachable from upstream/main", str(refusal.exception))

    def test_a_conflict_stops_the_import_and_lists_the_paths(self) -> None:
        self.repos.fetch_upstream()
        commit(self.repos.fork, "app.txt", "line one\nfork change\n", "fork: local edit")
        report = self.import_commit(self.repos.fix)
        self.assertFalse(report.imported)
        self.assertEqual(report.status, "conflict")
        self.assertIn("app.txt", report.conflicted)
        self.assertIn("app.txt", report.detail())

    def test_uncommitted_work_is_never_carried_into_the_import_branch(self) -> None:
        self.repos.fetch_upstream()
        (self.repos.fork / "app.txt").write_text("uncommitted\n")
        with self.assertRaises(self.module.Refusal) as refusal:
            self.import_commit(self.repos.fix)
        self.assertIn("app.txt", str(refusal.exception))
        self.assertEqual(git(self.repos.fork, "branch", "--show-current"), "main")

    def test_the_procedure_never_pushes(self) -> None:
        self.repos.fetch_upstream()
        calls: list[list[str]] = []
        real_git = self.module.git

        def recording_git(args, cwd=None):
            calls.append(list(args))
            return real_git(args, cwd)

        self.module.import_commit(
            self.repos.fix,
            cwd=self.repos.fork,
            git=recording_git,
            gate_runner=lambda plan: [self.module.GateResult(entry["gate"], "pass", "stubbed")
                                      for entry in plan],
        )
        for call in calls:
            self.assertNotEqual(call[:1], ["push"], f"the import ran `git {' '.join(call)}`")
            self.assertNotIn("--force", call)
        # And the scratch upstream saw no new branch: the import stayed local.
        branches = git(self.repos.upstream, "branch", "--format=%(refname:short)").splitlines()
        self.assertEqual([name for name in branches if name.startswith("upstream-import/")], [])

    def test_the_gate_runner_is_asked_to_run_the_plan(self) -> None:
        self.repos.fetch_upstream()
        seen: list[list] = []
        self.module.import_commit(
            self.repos.fix,
            cwd=self.repos.fork,
            gate_runner=lambda plan: seen.append(plan) or [
                self.module.GateResult(entry["gate"], "pass", "stubbed") for entry in plan
            ],
        )
        self.assertEqual(len(seen), 1)
        gates = [entry["gate"] for entry in seen[0]]
        self.assertIn("types", gates)
        self.assertIn("provenance", gates)

    def test_an_import_whose_gates_cannot_run_is_not_accepted(self) -> None:
        # The default path runs the real commands. In a scratch repository with no toolchain they
        # fail, and a failed gate must make the import unacceptable rather than silently skipped.
        self.repos.fetch_upstream()
        report = self.module.import_commit(self.repos.fix, cwd=self.repos.fork)
        self.assertTrue(report.imported)
        self.assertTrue(report.gates, "an import must always report the gates it ran")
        self.assertTrue(all(hasattr(result, "status") for result in report.gates))
        self.assertEqual(self.module.acceptance(report.gates), 1)


class VerificationTest(unittest.TestCase):
    """`--verify`: prove the remote is real and record the revision range it can import."""

    def setUp(self) -> None:
        self.module = load_module()

    def test_verification_records_the_upstream_head_and_the_merge_base(self) -> None:
        upstream_head = "c" * 40
        report = self.module.verify_report(
            remotes={
                "origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
                "upstream": {"fetch": self.module.UPSTREAM_URL, "push": None},
            },
            upstream_head=upstream_head,
            topology={"mergeBase": "b" * 40, "ahead": 3, "behind": 12},
            branch="integration/personal-linux-workspace",
            head="a" * 40,
        )
        self.assertTrue(report["verified"])
        self.assertEqual(report["upstream"]["head"], upstream_head)
        self.assertEqual(report["upstream"]["slug"], "crynta/terax-ai")
        self.assertEqual(report["topology"]["behind"], 12)
        self.assertEqual(report["origin"]["slug"], "kevsmir02/terax-ai")
        self.assertIn("upstream", report["gates"])

    def test_an_unreachable_upstream_is_unverified_never_verified(self) -> None:
        report = self.module.verify_report(
            remotes={
                "origin": {"fetch": "git@github.com:kevsmir02/terax-ai.git", "push": None},
                "upstream": {"fetch": self.module.UPSTREAM_URL, "push": None},
            },
            upstream_head=None,
            topology=None,
            branch="main",
            head="a" * 40,
        )
        self.assertFalse(report["verified"])
        self.assertEqual(report["gates"]["connectivity"]["status"], "unverified")
        self.assertIn("ls-remote", report["gates"]["connectivity"]["detail"])


class PlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_the_plan_covers_setup_fetch_review_import_conflict_rebuild_and_gates(self) -> None:
        plan = "\n".join(self.module.plan_lines())
        for step in ("remote add upstream", "fetch", "review", "cherry-pick", "conflict",
                     "rebuild", "gates", "never pushes"):
            self.assertIn(step, plan.lower(), f"the procedure must document {step!r}")

    def test_the_documented_procedure_is_in_the_repository_docs(self) -> None:
        doc = (REPO / "docs/architecture/upstream-imports.md").read_text()
        for term in ("upstream", "crynta/terax-ai", "cherry-pick -x", "origin", "never push",
                     "scripts/upstream-import/run.py"):
            self.assertIn(term, doc, f"docs/architecture/upstream-imports.md must document {term!r}")


if __name__ == "__main__":
    unittest.main()

"""Reviewed dependency updates for every ecosystem this repository actually has (issue #35).

User stories 95, 96, 99, 100: exact pins and lockfiles stay reviewable, dependency bots open
checked PRs for the ecosystems that exist here, checks are required before merge, and the pin that
no ecosystem tooling understands (the Ghostty source revision, plus the Rust/Node/pnpm toolchains)
is monitored by the procedure that already owns it.

These are structural guards: they read the real configuration and the real workflow, so a later
edit cannot silently add an unmonitored ecosystem, drop `--frozen-lockfile` coverage from a bot PR,
or remove a required check. Nothing here contacts GitHub.

Run with: `python3 -m unittest discover -s scripts/tests`
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent.parent
RUN_PY = REPO / "scripts/dependency-review/run.py"
DOC = REPO / "docs/architecture/dependency-updates.md"
DEPENDABOT = REPO / ".github/dependabot.yml"
CI = REPO / ".github/workflows/ci.yml"


def load_module():
    spec = importlib.util.spec_from_file_location("dependency_review", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def policy_document(**overrides) -> str:
    """A policy document shaped like the real one, for parser tests."""
    policy = {
        "requiredChecks": ["frontend", "rust"],
        "notRequired": {"coverage": "an artifact upload, not a gate"},
        "toolchainMonitors": [
            {"pin": "rust-toolchain.toml", "command": "python3 scripts/dependency-review/run.py --toolchains"},
        ],
    }
    policy.update(overrides)
    return "# Policy\n\n```json\n" + json.dumps(policy) + "\n```\n"


class PolicyDocumentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_the_machine_readable_policy_is_a_json_block_the_document_explains(self) -> None:
        policy = self.module.parse_policy(policy_document())
        self.assertEqual(policy["requiredChecks"], ["frontend", "rust"])
        self.assertEqual(policy["toolchainMonitors"][0]["pin"], "rust-toolchain.toml")

    def test_a_document_without_the_block_is_refused(self) -> None:
        with self.assertRaises(self.module.Refusal):
            self.module.parse_policy("# no policy here\n")

    def test_the_document_records_the_review_cadence_and_security_triage_as_policy(self) -> None:
        text = DOC.read_text()
        for term in (
            "monthly",
            "security",
            "triage",
            "no maintenance-hour",
            "no new automation",
        ):
            self.assertIn(term, text.lower(), f"the dependency policy must record {term!r}")
        # The policy is a cadence and a decision rule, not an hours commitment.
        self.assertNotIn("hours per week", text.lower())
        self.assertNotIn("hours per month", text.lower())


class EcosystemCoverageTest(unittest.TestCase):
    """Every dependency manifest in this repository has a bot, and no bot covers nothing."""

    def setUp(self) -> None:
        self.module = load_module()

    def entries(self) -> list[dict]:
        return yaml.safe_load(DEPENDABOT.read_text())["updates"]

    def test_the_repository_manifests_are_read_from_the_files_that_exist(self) -> None:
        found = {(entry["ecosystem"], entry["directory"]) for entry in self.module.manifests(REPO)}
        self.assertEqual(
            found,
            {
                ("npm", "/"),
                ("cargo", "/src-tauri"),
                ("github-actions", "/"),
                ("pip", "/scripts/tests"),
            },
        )

    def test_every_manifest_has_a_dependabot_entry_at_the_same_directory(self) -> None:
        result = self.module.coverage_gate(self.module.manifests(REPO), self.entries())
        self.assertEqual(result.status, "pass", result.detail)

    def test_a_manifest_without_a_bot_is_a_failure(self) -> None:
        manifests = [{"ecosystem": "docker", "directory": "/", "manifest": "Dockerfile"}]
        result = self.module.coverage_gate(manifests, self.entries())
        self.assertEqual(result.status, "fail")
        self.assertIn("docker", result.detail)

    def test_a_bot_for_an_ecosystem_this_repository_does_not_have_is_a_failure(self) -> None:
        entries = self.entries() + [
            {"package-ecosystem": "docker", "directory": "/", "schedule": {"interval": "weekly"}}
        ]
        result = self.module.coverage_gate(self.module.manifests(REPO), entries)
        self.assertEqual(result.status, "fail")
        self.assertIn("docker", result.detail)


class EntryPolicyTest(unittest.TestCase):
    """Bot configuration is dependency bumps only: bounded, labelled, cooled down, no majors."""

    def setUp(self) -> None:
        self.module = load_module()
        self.entries = yaml.safe_load(DEPENDABOT.read_text())["updates"]

    def test_the_shipped_configuration_is_a_dependency_bump_policy(self) -> None:
        result = self.module.entry_policy_gate(self.entries)
        self.assertEqual(result.status, "pass", result.detail)

    def test_a_bot_that_is_not_bounded_is_refused(self) -> None:
        entries = [dict(self.entries[0])]
        entries[0].pop("open-pull-requests-limit", None)
        self.assertEqual(self.module.entry_policy_gate(entries).status, "fail")

    def test_a_bot_without_a_review_label_is_refused(self) -> None:
        entries = [dict(self.entries[0], labels=["deps"])]
        self.assertEqual(self.module.entry_policy_gate(entries).status, "fail")
        entries = [dict(self.entries[0], labels=["dependencies"])]
        self.assertEqual(self.module.entry_policy_gate(entries).status, "pass")

    def test_a_group_that_includes_major_updates_is_refused(self) -> None:
        # A grouped major bump arrives as one unreviewable PR; majors stay separate on purpose.
        entry = {
            "package-ecosystem": "npm",
            "directory": "/",
            "schedule": {"interval": "weekly"},
            "open-pull-requests-limit": 5,
            "labels": ["dependencies"],
            "cooldown": {"default-days": 3},
            "groups": {"all": {"patterns": ["*"], "update-types": ["minor", "patch", "major"]}},
        }
        result = self.module.entry_policy_gate([entry])
        self.assertEqual(result.status, "fail")
        self.assertIn("major", result.detail)

    def test_a_grouped_major_bump_without_update_types_is_refused(self) -> None:
        entry = {
            "package-ecosystem": "github-actions",
            "directory": "/",
            "schedule": {"interval": "weekly"},
            "open-pull-requests-limit": 5,
            "labels": ["dependencies"],
            "cooldown": {"default-days": 3},
            "groups": {"github-actions": {"patterns": ["*"]}},
        }
        self.assertEqual(self.module.entry_policy_gate([entry]).status, "fail")

    def test_a_daily_schedule_is_refused(self) -> None:
        entry = {
            "package-ecosystem": "npm",
            "directory": "/",
            "schedule": {"interval": "daily"},
            "open-pull-requests-limit": 5,
            "labels": ["dependencies"],
            "cooldown": {"default-days": 3},
            "groups": {},
        }
        self.assertEqual(self.module.entry_policy_gate([entry]).status, "fail")


class RequiredChecksTest(unittest.TestCase):
    """A dependency PR is only mergeable when the repository's checks ran and passed."""

    def setUp(self) -> None:
        self.module = load_module()
        self.policy = json.loads(
            DOC.read_text().split("```json", 1)[1].split("```", 1)[0]
        )
        self.workflow = yaml.safe_load(CI.read_text())

    def test_every_required_check_names_a_real_ci_job(self) -> None:
        result = self.module.required_checks_gate(self.policy, self.workflow)
        self.assertEqual(result.status, "pass", result.detail)

    def test_a_required_check_that_names_no_job_is_refused(self) -> None:
        policy = dict(self.policy, requiredChecks=["frontend", "not-a-job"])
        result = self.module.required_checks_gate(policy, self.workflow)
        self.assertEqual(result.status, "fail")
        self.assertIn("not-a-job", result.detail)

    def test_every_ci_job_is_either_required_or_explicitly_not_required(self) -> None:
        result = self.module.unrequired_jobs_gate(self.policy, self.workflow)
        self.assertEqual(result.status, "pass", result.detail)
        workflow = json.loads(json.dumps(self.workflow))
        workflow["jobs"]["brand-new"] = {"runs-on": "ubuntu-latest", "steps": []}
        result = self.module.unrequired_jobs_gate(self.policy, workflow)
        self.assertEqual(result.status, "fail")
        self.assertIn("brand-new", result.detail)

    def test_matrix_jobs_expand_to_the_check_names_github_reports(self) -> None:
        # Ticket #34 narrowed the fork to one platform, so the shipped workflow has no matrix
        # jobs left; GitHub still reports one check per matrix entry, so the expansion itself
        # stays tested against a workflow that has one.
        workflow = {
            "jobs": {
                "frontend": {"runs-on": "ubuntu-latest", "steps": []},
                "terminal-test": {
                    "name": "terminal-test (${{ matrix.os }})",
                    "runs-on": "ubuntu-latest",
                    "strategy": {"matrix": {"os": ["windows-latest", "macos-latest"]}},
                    "steps": [],
                },
                "rust-test": {
                    "name": "rust-test (${{ matrix.os }}, ${{ matrix.target }})",
                    "runs-on": "ubuntu-latest",
                    "strategy": {"matrix": {"os": ["windows-latest"], "target": ["x86_64"]}},
                    "steps": [],
                },
            }
        }
        names = self.module.expand_required(
            ["frontend", "terminal-test", "rust-test"], workflow
        )
        self.assertIn("frontend", names)
        self.assertIn("terminal-test (windows-latest)", names)
        self.assertIn("terminal-test (macos-latest)", names)
        self.assertIn("rust-test (windows-latest, x86_64)", names)

    def test_the_shipped_workflow_needs_no_matrix_expansion(self) -> None:
        for job_name, job in self.workflow["jobs"].items():
            with self.subTest(job=job_name):
                self.assertNotIn("strategy", job)

    def test_the_required_checks_can_be_applied_without_editing_github_settings(self) -> None:
        payload = self.module.required_checks_payload(self.policy, self.workflow, branch="main")
        self.assertTrue(payload["required_status_checks"]["strict"])
        contexts = payload["required_status_checks"]["contexts"]
        self.assertIn("frontend", contexts)
        self.assertIn("repo-guards", contexts)
        command = self.module.required_checks_command(payload)
        self.assertIn("gh api", command)
        self.assertIn("required_status_checks", command)


class ToolchainMonitorTest(unittest.TestCase):
    """The pins no ecosystem bot understands are monitored by the procedure that owns them."""

    def setUp(self) -> None:
        self.module = load_module()
        self.policy = json.loads(DOC.read_text().split("```json", 1)[1].split("```", 1)[0])

    def test_every_exact_pin_has_a_declared_monitor(self) -> None:
        result = self.module.monitor_gate(self.policy, self.module.toolchain_pins(REPO), REPO)
        self.assertEqual(result.status, "pass", result.detail)

    def test_the_pins_themselves_are_read_from_the_files(self) -> None:
        pins = self.module.toolchain_pins(REPO)
        self.assertRegex(pins["rust-toolchain.toml"], r"^\d+\.\d+\.\d+$")
        self.assertRegex(pins[".nvmrc"], r"^\d+$")
        self.assertRegex(pins["package.json#packageManager"], r"^pnpm@\d+\.\d+\.\d+")
        self.assertRegex(pins["packages/ghostty-core/adapted/UPSTREAM.md"], r"^[0-9a-f]{40}$")
        self.assertRegex(pins["packages/ghostty-core/adapted/wasm/build.zig.zon"], r"^\d+\.\d+\.\d+$")

    def test_a_new_pin_without_a_monitor_is_refused(self) -> None:
        pins = dict(self.module.toolchain_pins(REPO), **{".python-version": "3.14"})
        result = self.module.monitor_gate(self.policy, pins, REPO)
        self.assertEqual(result.status, "fail")
        self.assertIn(".python-version", result.detail)

    def test_a_monitor_that_points_at_a_missing_script_is_refused(self) -> None:
        policy = json.loads(json.dumps(self.policy))
        policy["toolchainMonitors"][0]["command"] = "python3 scripts/does-not-exist/run.py"
        result = self.module.monitor_gate(policy, self.module.toolchain_pins(REPO), REPO)
        self.assertEqual(result.status, "fail")
        self.assertIn("does-not-exist", result.detail)

    def test_the_ghostty_revision_is_monitored_by_the_ticket_32_gate_not_a_second_mechanism(self) -> None:
        monitors = {entry["pin"]: entry["command"] for entry in self.policy["toolchainMonitors"]}
        ghostty = [command for pin, command in monitors.items() if pin.startswith("packages/ghostty-core")]
        self.assertTrue(ghostty, "the Ghostty source revision needs a named monitor")
        for command in ghostty:
            self.assertIn("scripts/ghostty-update/run.py", command)
            self.assertNotIn("dependabot", command.lower())

    def test_a_toolchain_report_names_the_pin_latest_and_verdict(self) -> None:
        pins = {
            "rust-toolchain.toml": "1.99.1",
            ".nvmrc": "22",
            "package.json#packageManager": "pnpm@11.9.0",
        }
        latest = {"rust-toolchain.toml": "1.100.0", ".nvmrc": "24", "package.json#packageManager": "pnpm@11.9.0"}
        rows = {row["pin"]: row for row in self.module.toolchain_rows(pins, latest)}
        self.assertEqual(rows["rust-toolchain.toml"]["verdict"], "update available")
        self.assertEqual(rows[".nvmrc"]["verdict"], "update available")
        self.assertEqual(rows["package.json#packageManager"]["verdict"], "current")

    def test_a_toolchain_that_could_not_be_checked_is_unverified_never_current(self) -> None:
        rows = self.module.toolchain_rows({"rust-toolchain.toml": "1.99.1"}, None)
        self.assertEqual(rows[0]["verdict"], "unverified")


class ReportTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_module()

    def test_the_report_passes_on_the_shipped_repository(self) -> None:
        report = self.module.report(REPO)
        self.assertTrue(report["accepted"], json.dumps(report, indent=2))
        names = {gate["name"]: gate["status"] for gate in report["gates"]}
        self.assertEqual(names["ecosystems"], "pass")
        self.assertEqual(names["entry-policy"], "pass")
        self.assertEqual(names["required-checks"], "pass")
        self.assertEqual(names["toolchain-monitors"], "pass")

    def test_a_repository_with_an_uncovered_manifest_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Dockerfile").write_text("FROM scratch\n")
            (root / "go.mod").write_text("module example.com/x\n")
            report = self.module.report(root)
            self.assertFalse(report["accepted"])
            self.assertIn("go", json.dumps(report))


if __name__ == "__main__":
    unittest.main()

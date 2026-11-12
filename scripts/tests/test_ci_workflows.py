"""Repository contracts that no compiler checks: exact toolchain pins, locked installs, the
lifecycle rules of ordinary CI (no auto-merge, no release publishing) and the disposable-profile
boundary of the Linux real-app smoke job.

Run with: python3 -m unittest discover -s scripts/tests

These guard decisions the workflows only state in YAML, so a later edit cannot silently drop them:
a `stable` toolchain, a `node-version` literal, a `pnpm install` without `--frozen-lockfile`, a
`cargo check` without `--locked`, a release upload added to `ci.yml`, or a smoke job that points
at the product identifier or has no bounded timeout.
"""

import json
import re
import unittest
from pathlib import Path

# Tests fail (not skip) when this is missing: a silent skip would report "all green" while the
# only workflow-YAML validation in the repository never ran. The workflows install
# `scripts/tests/requirements.txt`; locally: `python3 -m pip install -r scripts/tests/requirements.txt`.
try:
    import yaml
except ImportError:  # pragma: no cover - exercised only on an environment missing the dependency
    yaml = None

REPO = Path(__file__).resolve().parent.parent.parent
WORKFLOWS = REPO / ".github/workflows"
CI = WORKFLOWS / "ci.yml"
SMOKE = WORKFLOWS / "linux-app-smoke.yml"
TOOLCHAIN = REPO / "rust-toolchain.toml"
NVMRC = REPO / ".nvmrc"
PRODUCT_IDENTIFIER = "app.crynta.terax"
APP_LAB_NAMESPACE = f"{PRODUCT_IDENTIFIER}.app-lab"

# Subcommands that resolve the dependency graph, so they must never rewrite Cargo.lock in CI.
RESOLVING_CARGO = ("cargo check", "cargo clippy", "cargo nextest", "cargo test", "cargo build",
                   "cargo metadata", "cargo llvm-cov", "cargo run")


def workflow_files() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))


def text(path: Path) -> str:
    return path.read_text()


def lines(path: Path) -> list[str]:
    return [line.strip() for line in text(path).splitlines()]


def toolchain_channel() -> str:
    match = re.search(r'^channel\s*=\s*"([^"]+)"', text(TOOLCHAIN), re.MULTILINE)
    if not match:
        raise AssertionError(f"{TOOLCHAIN} has no `channel = \"...\"` entry")
    return match.group(1)


class ToolchainPinTest(unittest.TestCase):
    def test_the_rust_toolchain_is_an_exact_version(self) -> None:
        channel = toolchain_channel()
        self.assertRegex(channel, r"^\d+\.\d+\.\d+$", "pin an exact Rust version, not a channel")
        self.assertNotIn(channel, ("stable", "beta", "nightly"))

    def test_the_pinned_toolchain_has_the_lint_and_format_components(self) -> None:
        components = re.search(r"^components\s*=\s*\[(.*)\]", text(TOOLCHAIN), re.MULTILINE)
        self.assertIsNotNone(components, "rust-toolchain.toml must declare components")
        declared = {part.strip().strip('"') for part in components.group(1).split(",")}
        self.assertIn("clippy", declared)
        self.assertIn("rustfmt", declared)

    def test_every_workflow_installs_exactly_the_pinned_rust_channel(self) -> None:
        channel = toolchain_channel()
        for path in workflow_files():
            body = text(path)
            if "dtolnay/rust-toolchain" not in body:
                continue
            # `@stable` would install whatever stable is that day; the pin must be explicit.
            self.assertNotRegex(
                body,
                r"dtolnay/rust-toolchain@(stable|beta|nightly)",
                f"{path.name}: install the channel pinned in rust-toolchain.toml, not a moving one",
            )
            found = re.findall(r'^\s*toolchain:\s*"?([^"\s]+)"?\s*$', body, re.MULTILINE)
            self.assertTrue(found, f"{path.name}: dtolnay/rust-toolchain needs an explicit `toolchain:`")
            for value in found:
                self.assertEqual(
                    value,
                    channel,
                    f"{path.name}: toolchain {value!r} differs from rust-toolchain.toml ({channel})",
                )

    def test_the_node_major_is_pinned_in_one_file(self) -> None:
        # A bare version only: `actions/setup-node` and `nvm` both read the whole file as a
        # version, so a comment here would break every workflow that reads it.
        pinned = text(NVMRC).strip()
        self.assertRegex(pinned, r"^\d+$", ".nvmrc must hold exactly one bare Node major")
        for path in workflow_files():
            body = text(path)
            if "actions/setup-node" not in body:
                continue
            self.assertNotRegex(
                body,
                r"^\s*node-version:",
                f"{path.name}: use `node-version-file: .nvmrc`, not a second Node pin",
            )
            self.assertEqual(
                body.count("actions/setup-node"),
                body.count("node-version-file: .nvmrc"),
                f"{path.name}: every setup-node step must read .nvmrc",
            )

    def test_the_package_manager_is_still_pinned_with_a_lockfile(self) -> None:
        package = text(REPO / "package.json")
        self.assertRegex(package, r'"packageManager":\s*"pnpm@\d+\.\d+\.\d+\+sha512\.')
        self.assertRegex(package, r'"engines":\s*\{[^}]*"node":')
        self.assertTrue((REPO / "pnpm-lock.yaml").exists())
        self.assertTrue((REPO / "src-tauri/Cargo.lock").exists())


class LockedDependencyTest(unittest.TestCase):
    def test_frontend_installs_are_frozen(self) -> None:
        for path in workflow_files():
            for command in lines(path):
                if re.match(r"^pnpm (install|i)\b", command):
                    self.assertIn(
                        "--frozen-lockfile",
                        command,
                        f"{path.name}: `{command}` must not resolve dependencies afresh",
                    )

    def test_rust_commands_are_locked(self) -> None:
        for path in workflow_files():
            for command in lines(path):
                if not command.startswith(RESOLVING_CARGO):
                    continue
                self.assertIn(
                    "--locked",
                    command,
                    f"{path.name}: `{command}` must not update Cargo.lock in CI",
                )

    def test_ci_proves_the_locked_cargo_graph_stays_unchanged(self) -> None:
        body = text(CI)
        self.assertIn("cargo metadata --locked", body)
        self.assertIn("git diff --exit-code -- Cargo.lock", body)


class OrdinaryCiTest(unittest.TestCase):
    def test_ci_publishes_nothing_and_merges_nothing(self) -> None:
        body = text(CI)
        for forbidden in ("gh release", "tauri-action", "gh pr merge", "enable-pull-request-automerge",
                          "automerge", "pull_request_target"):
            self.assertNotIn(forbidden, body, f"ci.yml must not contain {forbidden!r}")
        self.assertNotIn("contents: write", body, "ordinary CI needs no write permission")

    def test_ci_keeps_the_platform_coverage_this_ticket_must_not_drop(self) -> None:
        body = text(CI)
        self.assertIn("windows-latest", body)
        self.assertIn("macos-latest", body)

    def test_ci_runs_the_repository_guards(self) -> None:
        self.assertIn("python3 -m unittest discover -s scripts/tests", text(CI))

    def test_the_dist_graph_check_builds_the_sourcemaps_it_needs(self) -> None:
        # The duplicate-package half only runs with sourcemaps, so the command must produce them
        # rather than analysing whatever `dist/` happens to hold (CI's `pnpm build` has none).
        scripts = json.loads(text(REPO / "package.json"))["scripts"]
        self.assertIn("--sourcemap", scripts["check:dist"])
        self.assertIn("--outDir", scripts["check:dist"])
        self.assertIn("scripts/dist-graph.mjs", scripts["check:dist"])
        self.assertIn("pnpm check:dist", text(CI), "CI must run the sourcemapped graph check")


class WorkflowYamlTest(unittest.TestCase):
    """Every workflow must parse. Nothing else in the repository would catch a YAML typo."""

    def setUp(self) -> None:
        if yaml is None:
            self.fail(
                "PyYAML is not installed, so workflow YAML validation cannot run. Install the "
                "guard tests' dependency: python3 -m pip install -r scripts/tests/requirements.txt"
            )

    def test_every_workflow_is_valid_yaml(self) -> None:
        for path in workflow_files():
            with self.subTest(path.name):
                self.assertIsInstance(yaml.safe_load(text(path)), dict)

    def test_the_workflows_install_the_dependency_they_use(self) -> None:
        self.assertRegex(
            text(REPO / "scripts/tests/requirements.txt"),
            r"(?m)^PyYAML==",
            "scripts/tests/requirements.txt must pin PyYAML",
        )
        for path in (CI, SMOKE):
            self.assertIn(
                "scripts/tests/requirements.txt",
                text(path),
                f"{path.name} runs scripts/tests, so it must install their dependencies first",
            )


class LinuxSmokeWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.body = text(SMOKE)

    def test_it_is_not_a_blocking_pull_request_gate(self) -> None:
        triggers = self.body.split("permissions:", 1)[0]
        self.assertIn("workflow_dispatch:", triggers)
        self.assertIn("schedule:", triggers)
        self.assertNotIn("push:", triggers, "the smoke job is evidence, not a push gate")
        # Opt-in per pull request through a label, never on every PR.
        self.assertIn("linux-smoke", triggers)

    def test_it_has_a_bounded_timeout(self) -> None:
        self.assertRegex(self.body, re.compile(r"^\s+timeout-minutes:\s*\d+", re.MULTILINE),
                         "the job must not hang a runner")

    def test_it_runs_the_workflow_scenario_from_the_isolated_profile(self) -> None:
        self.assertIn("--scenario workflow", self.body)
        self.assertIn("--profile debug", self.body)
        self.assertIn("--self-test", self.body, "prove the refusals, do not assume them")
        identifiers = re.findall(r"--identifier\s+(\S+)", self.body)
        self.assertTrue(identifiers, "the run must name its disposable identifier")
        for identifier in identifiers:
            self.assertTrue(
                identifier.startswith(f"{APP_LAB_NAMESPACE}-"),
                f"identifier {identifier!r} is not a disposable app-lab profile",
            )

    def test_it_uploads_the_failure_evidence(self) -> None:
        self.assertIn("actions/upload-artifact", self.body)
        self.assertIn("if: always()", self.body)
        for artifact in ("report.json", "page.log", "app.log", "build.log"):
            self.assertIn(artifact, self.body, f"the report must ship {artifact}")

    def test_it_proves_the_profile_invariants_before_building(self) -> None:
        self.assertIn("python3 -m unittest discover -s scripts/tests", self.body)


class TerminalCoverageTest(unittest.TestCase):
    """The terminal checks ticket #33 ports must run somewhere in ordinary CI, not just locally.

    `terminal-test` keeps Windows and macOS until ticket #34 narrows platforms; `terminal-linux`
    is the Linux half. A check that runs nowhere is the silent coverage drop this guard exists to
    prevent, so each one is asserted by the command that runs it rather than by job name.
    """

    def setUp(self) -> None:
        if yaml is None:
            self.fail("PyYAML is not installed, so workflow YAML validation cannot run.")
        self.workflow = yaml.safe_load(text(CI))
        self.body = text(CI)

    def step_runs(self, job: str) -> list[str]:
        return [step.get("run", "") for step in self.workflow["jobs"][job]["steps"] if "run" in step]

    def test_the_linux_terminal_job_runs_the_terminal_strategy_and_is_not_advisory(self) -> None:
        self.assertIn("terminal-linux", self.workflow["jobs"], "the Linux terminal strategy needs a job")
        for step in self.workflow["jobs"]["terminal-linux"]["steps"]:
            self.assertNotEqual(
                step.get("continue-on-error"), True,
                f"terminal-linux step {step.get('name', step.get('run'))!r} must not be advisory",
            )
        commands = " ".join(self.step_runs("terminal-linux"))
        for command in (
            "pnpm exec vitest run src/modules/terminal",
            "pnpm soak:ghostty",
            "pnpm test:terminal-scaling",
        ):
            self.assertIn(command, commands, f"terminal-linux must run {command}")

    def test_the_compositor_parity_gate_runs_for_every_platform_that_claims_it(self) -> None:
        scaling = [step for step in self.workflow["jobs"]["terminal-platforms"]["steps"]
                   if "test:terminal-scaling" in step.get("run", "")]
        self.assertTrue(scaling, "macOS still runs the full pixel gate")
        self.assertNotEqual(scaling[0].get("continue-on-error"), True)
        self.assertTrue(
            any("test:terminal-scaling" in command for command in self.step_runs("terminal-linux")),
            "Linux runs the same gate against the WebGL fallback",
        )

    def test_the_linux_job_records_why_a_renderer_is_not_compared(self) -> None:
        # Narrowing a gate is allowed; narrowing it silently is not. The gap sentence travels with
        # the job and lands in scaling.json.
        self.assertIn("TERAX_VISUAL_RENDERERS_GAP", self.body)
        self.assertIn("TERAX_VISUAL_RENDERERS", self.body)


class ApplicationIdentityTest(unittest.TestCase):
    def test_no_workflow_launches_the_product_identifier(self) -> None:
        for path in workflow_files():
            for identifier in re.findall(r"--identifier\s+(\S+)", text(path)):
                self.assertNotEqual(
                    identifier.strip('"\''),
                    PRODUCT_IDENTIFIER,
                    f"{path.name}: tests and benchmarks never run in the product profile",
                )


if __name__ == "__main__":
    unittest.main()

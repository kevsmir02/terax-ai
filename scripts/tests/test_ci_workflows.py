"""Repository contracts that no compiler checks: exact toolchain pins, locked installs, the
lifecycle rules of ordinary CI (no auto-merge, no release publishing), the disposable-profile
boundary of the Linux real-app smoke job, and the narrowed Linux x86-64 platform set.

Run with: python3 -m unittest discover -s scripts/tests

These guard decisions the workflows only state in YAML, so a later edit cannot silently drop them:
a `stable` toolchain, a `node-version` literal, a `pnpm install` without `--frozen-lockfile`, a
`cargo check` without `--locked`, a release upload added to `ci.yml`, a smoke job that points
at the product identifier or has no bounded timeout, or a workflow/doc that quietly re-adds a
Windows, macOS, Nix or non-x86-64 target that this fork does not build or distribute.
"""

import json
import re
import sys
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
sys.path.insert(0, str(REPO / "scripts"))

import packaging  # noqa: E402  (the candidate identity table lives in scripts/packaging.py)

WORKFLOWS = REPO / ".github/workflows"
CI = WORKFLOWS / "ci.yml"
RELEASE = WORKFLOWS / "release.yml"
LINUX_PACKAGES_DOC = REPO / "docs/architecture/linux-packages.md"
SMOKE = WORKFLOWS / "linux-app-smoke.yml"
TOOLCHAIN = REPO / "rust-toolchain.toml"
NVMRC = REPO / ".nvmrc"
README = REPO / "README.md"
TRANSLATED_READMES = REPO / "docs/readme"
CONTRIBUTOR_TESTING = REPO / "docs/contributing/testing.md"
PRODUCT_IDENTIFIER = "app.crynta.terax"
APP_LAB_NAMESPACE = f"{PRODUCT_IDENTIFIER}.app-lab"

# The supported distribution set after ticket #34: Linux x86-64, and nothing else. A workflow
# may only run on one of these images, and ordinary CI may not grow a matrix that is not listed
# here. Adding a runner means changing this tuple in the same reviewed change.
LINUX_RUNNERS = ("ubuntu-latest", "ubuntu-22.04", "ubuntu-24.04")
SUPPORTED_RELEASE_TARGET = "x86_64-unknown-linux-gnu"

# Every ordinary-CI job that must keep running. Narrowing platforms removed `terminal-platforms`
# and `rust-platforms`, so the Linux jobs below are now the only coverage: dropping one is a
# silent coverage loss, not a platform narrowing.
REQUIRED_CI_JOBS = ("frontend", "rust", "terminal-linux", "coverage", "repo-guards")

# Markers of build/distribution support this fork does not have. Checked against every workflow
# so a removed platform cannot come back through a copied upstream job.
REMOVED_BUILD_MARKERS = (
    "windows-latest",
    "windows-20",
    "macos-latest",
    "macos-1",
    "ubuntu-24.04-arm",
    "pwsh",
    "signpath",
    "SignPath",
    "APPLE_",
    "nsis",
    "dmg",
    "AppImage",
    "appimage",
    "flake.nix",
    "nixos",
    "update-nix-sources",
)

# Subcommands that resolve the dependency graph, so they must never rewrite Cargo.lock in CI.
RESOLVING_CARGO = ("cargo check", "cargo clippy", "cargo nextest", "cargo test", "cargo build",
                   "cargo metadata", "cargo llvm-cov", "cargo run")


def workflow_files() -> list[Path]:
    return sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))


def text(path: Path) -> str:
    return path.read_text()


def lines(path: Path) -> list[str]:
    return [line.strip() for line in text(path).splitlines()]


def workflow_code(path: Path) -> str:
    """The workflow YAML with its full-line comments removed.

    A comment may legitimately name a removed platform ("the Windows/macOS matrix is gone"),
    while a workflow key, runner or command may not. Only full-line comments are dropped, so
    every configured value is still checked.
    """
    return "\n".join(
        line for line in text(path).splitlines() if not line.lstrip().startswith("#")
    )


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


class PlatformSupportTest(unittest.TestCase):
    """The support commitment is Linux x86-64 only (ticket #34, user stories 85 and 86).

    `test_ci_keeps_the_platform_coverage_this_ticket_must_not_drop` used to assert the Windows
    and macOS jobs were present. Narrowing platforms is exactly the opposite decision, so the
    guard now asserts the *new* explicit set instead of being deleted: every job runs on a Linux
    runner from a named list, the jobs that carry the coverage must all still exist, and none of
    the removed build/distribution platforms may reappear in any workflow.
    """

    def setUp(self) -> None:
        if yaml is None:
            self.fail("PyYAML is not installed, so workflow YAML validation cannot run.")
        self.workflow = yaml.safe_load(text(CI))

    def test_every_ci_job_runs_on_a_named_linux_runner(self) -> None:
        for job in REQUIRED_CI_JOBS:
            self.assertIn(job, self.workflow["jobs"], f"{job} carries coverage and must keep running")
        for name, job in self.workflow["jobs"].items():
            runs_on = job.get("runs-on")
            self.assertIsInstance(runs_on, str, f"{name}: runs-on must be one explicit image")
            self.assertIn(
                runs_on,
                LINUX_RUNNERS,
                f"{name}: {runs_on!r} is not in the supported Linux runner set {LINUX_RUNNERS}; "
                "widen the documented platform commitment first",
            )

    def test_the_terminal_and_rust_platform_matrices_are_gone(self) -> None:
        # Their Linux halves are `terminal-linux` and `rust`; keeping the matrices would keep
        # building platforms this fork does not distribute.
        for removed in ("terminal-platforms", "rust-platforms"):
            self.assertNotIn(removed, self.workflow["jobs"], f"{removed} must not be a CI job")
        self.assertNotIn("matrix", workflow_code(CI), "ordinary CI runs one platform, not a matrix")

    def test_no_workflow_builds_or_distributes_a_removed_platform(self) -> None:
        for path in workflow_files():
            body = workflow_code(path)
            for marker in REMOVED_BUILD_MARKERS:
                self.assertNotIn(
                    marker,
                    body,
                    f"{path.name}: {marker!r} belongs to a platform this fork does not build or "
                    "distribute; remove it or narrow the docs as well",
                )

    def test_the_removed_build_definitions_are_not_in_the_tree(self) -> None:
        # Nix distribution and the Windows signing test were the only owners of these files.
        for removed in (
            "flake.nix",
            "nix/package.nix",
            "nix/sources.json",
            ".github/workflows/update-nix-sources.yml",
            ".github/workflows/signpath-test.yml",
            "src-tauri/tauri.windows.conf.json",
            "src-tauri/installer-hooks.nsh",
            "src-tauri/entitlements.plist",
            "src-tauri/Info.plist",
        ):
            self.assertFalse((REPO / removed).exists(), f"{removed} belongs to a removed platform")

    def test_the_platform_neutral_build_inputs_stay(self) -> None:
        # The Linux config and the Rust/TS portability seams stay: they are what an upstream
        # import still compiles against, and removing them is a different change.
        for kept in ("src-tauri/tauri.linux.conf.json", "rust-toolchain.toml", ".nvmrc"):
            self.assertTrue((REPO / kept).exists(), f"{kept} must stay")


class ReleaseWorkflowTest(unittest.TestCase):
    """The workflow builds one x86-64 Linux candidate set and publishes nothing yet.

    Publication gating is ticket #40 (GitHub issue #41) and is on an execution hold, so the
    half-built path fails closed: no tag trigger, no release object, no upload to a release. The
    spec says a version tag publishes only *subject to* passing checks and tag/application-version
    agreement, and that "a tag alone is not successful validation" — until the gate that compares
    those exists, a tag must produce no artifact set at all.
    """

    def setUp(self) -> None:
        if yaml is None:
            self.fail("PyYAML is not installed, so workflow YAML validation cannot run.")
        self.workflow = yaml.safe_load(text(RELEASE))
        self.body = text(RELEASE)
        self.jobs = self.workflow["jobs"]

    def candidate_job(self) -> dict:
        self.assertIn("build-candidate", self.jobs, "the release build keeps its job identity")
        return self.jobs["build-candidate"]

    def run_commands(self) -> list[str]:
        return [step.get("run", "") for step in self.candidate_job()["steps"] if "run" in step]

    def staged_packages(self) -> list[str]:
        staged = [line for line in lines(RELEASE) if line.startswith("for package in ")]
        self.assertTrue(
            staged,
            "the candidate artifacts must be staged from the packaging runner's output "
            f"({packaging.OUTPUT_ROOT.relative_to(REPO).as_posix()}/): that is where the "
            "candidate identity is applied",
        )
        return staged

    def test_the_release_is_one_explicit_x86_64_linux_job(self) -> None:
        job = self.candidate_job()
        self.assertEqual(job["runs-on"], "ubuntu-22.04")
        self.assertNotIn("strategy", job, "one platform needs no matrix")
        self.assertIn(
            f"targets: {SUPPORTED_RELEASE_TARGET}",
            self.body,
            "the toolchain must install the only released target",
        )

    def test_the_workflow_builds_the_candidate_the_packaging_runner_describes(self) -> None:
        # A bare `pnpm tauri build` uses `src-tauri/tauri.conf.json`: upstream's product name,
        # binary name and descriptions. The fork identity is a generated overlay
        # (`scripts/packaging.py: candidate_config()`), written and applied by the packaging
        # runner, so the workflow must go through that one code path.
        commands = " ".join(self.run_commands())
        self.assertIn(
            "python3 scripts/package-candidate/run.py",
            commands,
            "the candidate job must build with the packaging runner, not the base config",
        )
        self.assertNotIn(
            "pnpm tauri build",
            workflow_code(RELEASE),
            "a direct `pnpm tauri build` here would ship upstream's identity instead of the "
            "candidate identity the runner generates",
        )

    def test_the_candidate_identity_is_not_restated_in_the_workflow(self) -> None:
        # The identity table is the single source (`src/modules/identity/namespace.json`, read
        # by `scripts/packaging.py`). A literal here is a second place that can drift, and it is
        # how the base identity survived in this workflow before.
        identity = packaging.candidate()
        upstream = packaging.identity_table()["upstream"]
        code = workflow_code(RELEASE)
        for literal in (
            identity.product_name,
            identity.package_name,
            identity.cli_binary_name,
            identity.vendor,
            upstream["productName"],
            upstream["publisher"],
        ):
            self.assertNotIn(
                literal,
                code,
                f"release.yml restates {literal!r}: derive it from scripts/packaging.py",
            )

    def test_the_workflow_refuses_an_upstream_install_path(self) -> None:
        # The concrete symptom of a build without the overlay: the deb installs upstream's
        # `/usr/bin/terax` instead of the candidate binary. Naming the forbidden path is the
        # point (like the removed-platform markers), not a second source of the candidate name.
        upstream = packaging.identity_table()["upstream"]
        self.assertIn(
            f"test ! -e unpacked-deb/usr/bin/{upstream['namespace']}",
            workflow_code(RELEASE),
            "the staged deb must be proven not to install upstream's binary path",
        )

    def test_the_staged_artifacts_come_from_the_runners_candidate_directory(self) -> None:
        output_root = packaging.OUTPUT_ROOT.relative_to(REPO).as_posix()
        self.assertIn(f"{output_root}/*/manifest.json", self.body)
        self.assertIn("sha256sum -c SHA256SUMS", self.body, "the runner's own hashes are checked")

    def test_the_candidate_job_installs_what_the_runner_reads_back(self) -> None:
        # `scripts/package-candidate/run.py` verifies the built packages with `rpm`/`rpm2cpio`
        # and `cpio`; a runner image without them fails the job after a full build.
        commands = " ".join(self.run_commands())
        self.assertIn("sudo apt-get install", commands)
        for tool in ("rpm", "cpio"):
            # `rpm2cpio`, which reads the rpm payload back, ships in the `rpm` package.
            self.assertIn(tool, commands, f"the candidate job needs {tool}")

    def test_the_release_only_stages_the_package_formats_the_config_declares(self) -> None:
        configured = json.loads(text(REPO / "src-tauri/tauri.conf.json"))["bundle"]["targets"]
        self.assertEqual(sorted(configured), ["deb", "rpm"])
        staged = self.staged_packages()
        for fmt in ("rpm", "deb"):
            self.assertIn(fmt, staged[0], f"the release must stage the configured {fmt} output")
        for unsupported in ("appimage", "nsis", "msi", "dmg"):
            self.assertNotIn(unsupported, " ".join(staged).lower())

    def test_the_runner_builds_for_the_one_released_target(self) -> None:
        # A `--target` build writes under the target triple; `src-tauri/target/release/bundle/`
        # only exists for a build without it. The runner is where that lives now that the
        # workflow does not call `pnpm tauri build` itself.
        run_py = text(REPO / "scripts/package-candidate/run.py")
        self.assertIn('"--target"', run_py)
        self.assertIn("packaging.TARGET_TRIPLE", run_py)
        self.assertIn(
            'REPO_ROOT / "src-tauri" / "target" / packaging.TARGET_TRIPLE / PROFILE / "bundle"',
            run_py,
            "the packaging runner is the proven producer; the workflow must follow its output",
        )
        self.assertEqual(packaging.TARGET_TRIPLE, SUPPORTED_RELEASE_TARGET)

    def test_the_candidate_checks_the_architecture_it_stages(self) -> None:
        # A package for another architecture is refused rather than staged: this is the
        # release-output half of "no non-x86-64 initial release outputs". The architectures
        # come from the packaging module, not a second literal pair.
        self.assertIn(f'"{packaging.DEB_ARCH}"', self.body, "the deb must be checked as amd64")
        self.assertIn(f'"{packaging.RPM_ARCH}"', self.body, "the rpm must be checked as x86_64")
        self.assertIn("sha256sum", self.body, "staged artifacts keep their hashes")

    def test_a_version_tag_cannot_start_the_workflow(self) -> None:
        # A tag is the publication trigger the gate will own (#41). Taking it away is what makes
        # the ungated path fail closed; re-adding it requires the tag/version + green-CI gate.
        triggers = self.body.split("jobs:", 1)[0]
        self.assertIn("workflow_dispatch:", triggers, "a candidate is built on request")
        self.assertNotIn("push:", triggers, "no push, and so no tag, may start this workflow")
        self.assertNotIn("tags:", triggers)
        self.assertNotIn("v*", triggers)
        self.assertNotIn("schedule:", triggers)

    def test_nothing_in_the_workflow_creates_or_uploads_a_release(self) -> None:
        code = workflow_code(RELEASE)
        for forbidden in (
            "gh release",
            "tauri-action",
            "tagName",
            "releaseName",
            "releaseBody",
            "releaseDraft",
            "prerelease",
            "contents: write",
        ):
            self.assertNotIn(
                forbidden,
                code,
                f"release.yml must not contain {forbidden!r} while the publication gate (#41) "
                "does not exist; a tag or dispatch would otherwise publish unchecked artifacts",
            )

    def test_the_candidate_set_leaves_as_a_workflow_artifact(self) -> None:
        self.assertIn("actions/upload-artifact", self.body)
        self.assertIn("name: linux-x86_64-packages", self.body)
        self.assertIn("if-no-files-found: error", self.body)

    def test_the_candidate_docs_do_not_claim_a_built_in_updater(self) -> None:
        # Updates are a package-tool action for the user (spec: never download or install by
        # itself). With no release text, the candidate docs carry that promise.
        docs = text(LINUX_PACKAGES_DOC)
        self.assertNotIn("Auto-update is built in", docs)
        self.assertIn("package manager", docs)
        for path in workflow_files():
            self.assertNotIn("Auto-update is built in", text(path), f"{path.name}")


class DocumentationPlatformClaimTest(unittest.TestCase):
    """Support claims in the docs must match what is built: Linux x86-64 only."""

    def test_the_readme_platform_badge_names_only_linux_x86_64(self) -> None:
        body = text(README)
        self.assertIn("platform-Linux%20x86_64", body)
        self.assertNotIn("platform-macOS", body)

    def test_the_readme_offers_only_the_distributed_install_paths(self) -> None:
        body = text(README)
        for kept in ("RPM", "DEB", "x86-64"):
            self.assertIn(kept, body, f"the install section must still document {kept}")
        for removed in ("nix profile install", "**AppImage", "- **AppImage", "Windows notes",
                        "SignPath"):
            self.assertNotIn(removed, body, f"the README must not offer {removed!r}")

    def test_every_translated_readme_carries_the_same_platform_set(self) -> None:
        for path in sorted(TRANSLATED_READMES.glob("README.*.md")):
            body = text(path)
            with self.subTest(path.name):
                self.assertIn("platform-Linux%20x86_64", body, f"{path.name} badge is stale")
                self.assertNotIn("platform-macOS", body, f"{path.name} still claims macOS support")

    def test_no_translated_readme_offers_a_removed_platform_install(self) -> None:
        for path in sorted(TRANSLATED_READMES.glob("README.*.md")):
            body = text(path)
            with self.subTest(path.name):
                for removed in ("nix profile install", "- **AppImage", "SignPath.io"):
                    self.assertNotIn(removed, body, f"{path.name} must not offer {removed!r}")

    def test_the_contributor_docs_list_the_jobs_that_actually_run(self) -> None:
        body = text(CONTRIBUTOR_TESTING)
        for job in REQUIRED_CI_JOBS:
            self.assertIn(f"`{job}`", body, f"docs/contributing/testing.md must document {job}")
        # The removed matrices may be *explained* (that is how a reader learns they are gone),
        # but they must not be listed as jobs that run.
        for line in body.splitlines():
            self.assertFalse(
                line.startswith("|") and ("`rust-platforms`" in line or "`terminal-platforms`" in line),
                f"docs/contributing/testing.md still lists a removed job: {line}",
            )
        self.assertNotIn("update-nix-sources", body, "the Nix workflow no longer exists")

    def test_the_support_intake_forms_ask_about_the_supported_platform(self) -> None:
        # The bug-report dropdown and the PR checklist are where a user or contributor learns
        # which platforms are in scope, so they carry the same commitment as the README.
        bug_report = text(REPO / ".github/ISSUE_TEMPLATE/bug_report.yml")
        options = [line.strip().lstrip("- ").strip() for line in bug_report.splitlines()
                   if line.strip().startswith("- ") and "Linux" in line]
        self.assertTrue(options, "the bug report must still offer the supported platforms")
        self.assertNotIn("Windows", bug_report)
        self.assertNotIn("macOS", bug_report)
        pull_request = text(REPO / ".github/PULL_REQUEST_TEMPLATE.md")
        self.assertNotIn("macOS / Linux / Windows", pull_request)
        self.assertIn("Linux x86-64 only", pull_request)


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
    """The terminal checks ticket #33 ports must run in ordinary CI, not just locally.

    Ticket #34 removed the Windows/macOS `terminal-platforms` matrix, so `terminal-linux` is now
    the only job that runs them. A check that runs nowhere is the silent coverage drop this guard
    exists to prevent, so each one is asserted by the command that runs it rather than by job name.
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

    def test_the_compositor_parity_gate_still_runs_on_the_only_supported_platform(self) -> None:
        # It moved from macOS to the Linux job rather than disappearing with the matrix: the
        # WebGL fallback the application uses on WebKitGTK is compared at every DPR.
        scaling = [step for step in self.workflow["jobs"]["terminal-linux"]["steps"]
                   if "test:terminal-scaling" in step.get("run", "")]
        self.assertTrue(scaling, "the only supported platform must still run the pixel gate")
        self.assertNotEqual(scaling[0].get("continue-on-error"), True)

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

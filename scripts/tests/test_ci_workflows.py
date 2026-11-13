"""Repository contracts that no compiler checks: exact toolchain pins, locked installs, the
lifecycle rules of ordinary CI (no auto-merge, no release publishing), the disposable-profile
boundary of the Linux real-app smoke job, and the narrowed Linux x86-64 platform set.

Run with: python3 -m unittest discover -s scripts/tests

These guard decisions the workflows only state in YAML, so a later edit cannot silently drop them:
a `stable` toolchain, a `node-version` literal, a `pnpm install` without `--frozen-lockfile`, a
`cargo check` without `--locked`, a release upload added to `ci.yml`, a smoke job that launches
the product identifier (or an identifier in upstream Terax's namespace, which the preflight
refuses) or has no bounded timeout, or a workflow/doc that quietly re-adds a Windows, macOS, Nix
or non-x86-64 target that this fork does not build or distribute.
"""

import json
import subprocess
import re
import sys
import tempfile
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
import linux_profile  # noqa: E402  (the preflight the runners actually call)

WORKFLOWS = REPO / ".github/workflows"
CI = WORKFLOWS / "ci.yml"
RELEASE = WORKFLOWS / "release.yml"
RELEASE_GATE = REPO / "scripts/release_gate.py"
RELEASE_CONTRACT = REPO / "src/modules/updater/releaseContract.json"
LINUX_PACKAGES_DOC = REPO / "docs/architecture/linux-packages.md"
SMOKE = WORKFLOWS / "linux-app-smoke.yml"
TOOLCHAIN = REPO / "rust-toolchain.toml"
NVMRC = REPO / ".nvmrc"
README = REPO / "README.md"
TRANSLATED_READMES = REPO / "docs/readme"
CONTRIBUTOR_TESTING = REPO / "docs/contributing/testing.md"

# Derived from the identity table (`src/modules/identity/namespace.json`), never restated: a
# literal here is a second source of truth, and the guard then asserts identifiers under the
# wrong namespace. Both values have drifted exactly this way once already.
IDENTITY = packaging.identity_table()
PRODUCT_IDENTIFIER = IDENTITY["appIdentifier"]
UPSTREAM_IDENTIFIER = IDENTITY["upstream"]["appIdentifier"]
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


# Actions that publish: they upload where users download, or create a release object. They are
# exactly what must stay out of `release.yml` while the contract is provisional. A run-scoped
# `actions/upload-artifact` is *not* one of them (it is build evidence on the run, not a
# publication), and the release workflow is required to keep shipping its candidate that way.
PUBLICATION_ACTIONS = (
    "tauri-action",
    "gh release",
    "actions/upload-release-asset",
    "actions/create-release",
    "softprops/action-gh-release",
    "release-drafter",
    "pypi-publish",
    "docker push",
)

# The only repository secrets the release workflow may read: the maintainer's
# passphrase-protected minisign key and its passphrase, injected for the signer step only. They
# grant authenticity, not publication, and the gate still decides.
RELEASE_SIGNING_SECRETS = (
    "TERAX_RELEASE_SIGNING_KEY",
    "TERAX_RELEASE_SIGNING_KEY_PASSPHRASE",
)


def release_contract() -> dict:
    return json.loads(text(RELEASE_CONTRACT))


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

    def test_a_version_tag_starts_the_workflow_only_through_the_gate(self) -> None:
        # A `v*` tag now starts the workflow. That is safe for exactly one reason: the gate runs
        # before the build and refuses everything while the release contract is provisional. The
        # ordering below is the invariant, not the presence of a step name.
        triggers = self.body.split("jobs:", 1)[0]
        self.assertIn("workflow_dispatch:", triggers, "a candidate is also built on request")
        self.assertIn("tags:", triggers, "a version tag must reach the gate, not be ignored")
        self.assertIn("v*", triggers)
        self.assertNotIn("schedule:", triggers)

        steps = self.candidate_job()["steps"]
        runs = [step.get("run", "") for step in steps]

        def invokes(run: str, script: str) -> bool:
            # The executed command, not a mention in a comment: `package-candidate/run.py` and
            # `release_gate.py` are both described in the shell comments above their steps.
            return any(line.strip().startswith(f"python3 {script}")
                       for line in run.splitlines())

        preconditions = [index for index, run in enumerate(runs)
                         if invokes(run, "scripts/release_gate.py")
                         and "--preconditions-only" in run]
        build = [index for index, run in enumerate(runs)
                 if invokes(run, "scripts/package-candidate/run.py")]
        artifacts = [index for index, run in enumerate(runs)
                     if invokes(run, "scripts/release_gate.py") and "--candidate" in run]
        uploads = [index for index, step in enumerate(steps)
                   if "actions/upload-artifact" in str(step.get("uses", ""))]
        self.assertTrue(preconditions, "the gate must run before the build")
        self.assertTrue(build, "the candidate build keeps its runner")
        self.assertTrue(artifacts, "the staged set must be gated as well")
        self.assertTrue(uploads, "the candidate set still leaves as a workflow artifact")
        self.assertLess(preconditions[0], build[0],
                        "a failed precondition must fail the job before any artifact exists")
        self.assertLess(build[0], artifacts[0],
                        "the artifact stage evaluates the set the build produced")
        self.assertLess(artifacts[0], uploads[0])

    def test_the_gate_reads_the_check_runs_of_the_tagged_commit(self) -> None:
        # The gate cannot fetch anything itself (it has no network path), so the workflow must
        # hand it the check runs for the commit the tag resolved to.
        self.assertIn("check-runs", self.body)
        self.assertIn("steps.target.outputs.commit", self.body)
        self.assertIn("--ci-status", self.body)
        self.assertRegex(self.body, r"(?m)^\s+timeout-minutes:\s*\d+",
                         "a tag-triggered build needs a bounded timeout")

    def test_publication_stays_impossible_while_the_contract_is_provisional(self) -> None:
        # Derived from `src/modules/updater/releaseContract.json`: while the fork has not decided
        # its publication identity and signing trust, the release workflow must have no way to
        # publish. Flipping `provisional` to false is the deliberate change that relaxes this,
        # and even then the gate has to remain the thing that decides.
        #
        # The one secret the workflow is allowed to read is the release signing key: it grants
        # authenticity, not publication, it is injected only for the signer step, and the gate
        # still refuses every release while the contract is provisional. Any other `secrets.`
        # reference, any write permission and every publication action stay forbidden, and the
        # secret may not be echoed (see `ReleaseSigningWorkflowTest`).
        contract = release_contract()
        code = workflow_code(RELEASE)
        permissions = yaml.safe_load(code).get("permissions") or {}
        if contract.get("provisional") is not True:
            self.assertIn("scripts/release_gate.py", code)
            return
        for forbidden in (*PUBLICATION_ACTIONS, "tagName", "releaseName", "releaseBody",
                          "releaseDraft", "prerelease", "contents: write", "id-token: write"):
            self.assertNotIn(
                forbidden,
                code,
                f"release.yml must not contain {forbidden!r} while "
                "releaseContract.json is provisional: a tag or dispatch would otherwise publish "
                "unchecked, untrusted artifacts",
            )
        allowed_secrets = set(RELEASE_SIGNING_SECRETS)
        found = set(re.findall(r"secrets\.([A-Za-z0-9_]+)", code))
        self.assertEqual(
            found - allowed_secrets,
            set(),
            "release.yml may read only the release signing secrets while the contract is "
            "provisional; anything else could publish",
        )
        for name, granted in permissions.items():
            self.assertNotIn("write", str(granted), f"release.yml grants {name}: write")

    def test_the_gate_it_pins_exists_and_has_no_publish_path(self) -> None:
        # The workflow names a script; a deleted script would leave a tag doing nothing at all.
        self.assertTrue(RELEASE_GATE.is_file(), "release.yml calls scripts/release_gate.py")
        source = text(RELEASE_GATE)
        for publishing in (*PUBLICATION_ACTIONS, "requests.post", "urllib.request"):
            self.assertNotIn(publishing, source,
                             "the gate only decides; it must not be able to publish")

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


class ReleaseSigningWorkflowTest(unittest.TestCase):
    """A tag signs the staged bytes before the artifact gate, and refuses without a key.

    The security property here is narrow and absolute: the workflow may not publish, and it may
    not treat unsigned bytes as a release. Asserting the order (staging → signing → artifact gate
    → upload) and the named refusals is what keeps a later edit from "simplifying" the signer
    step away.
    """

    def setUp(self) -> None:
        if yaml is None:
            self.fail("PyYAML is not installed, so workflow YAML validation cannot run.")
        self.workflow = yaml.safe_load(text(RELEASE))
        self.body = text(RELEASE)
        self.code = workflow_code(RELEASE)

    def steps(self) -> list[dict]:
        return self.workflow["jobs"]["build-candidate"]["steps"]

    def step_index(self, needle: str) -> int:
        for index, step in enumerate(self.steps()):
            if needle in str(step.get("run", "")):
                return index
        raise AssertionError(f"no release step runs {needle!r}")

    def signer_step(self) -> dict:
        index = self.step_index("tauri signer sign")
        return self.steps()[index]

    def test_the_signer_runs_after_staging_and_before_the_artifact_gate(self) -> None:
        staging = self.step_index("sha256sum -c SHA256SUMS")
        signing = self.step_index("tauri signer sign")
        gate = next(
            index for index, step in enumerate(self.steps())
            if "scripts/release_gate.py" in str(step.get("run", ""))
            and "--candidate" in str(step.get("run", ""))
        )
        upload = next(
            index for index, step in enumerate(self.steps())
            if "actions/upload-artifact" in str(step.get("uses", ""))
        )
        self.assertLess(staging, signing, "the signed bytes must be the staged bytes")
        self.assertLess(signing, gate, "the gate verifies what was signed and announced")
        self.assertLess(gate, upload)
        # The manifest is written inside the signer step, after the signatures exist.
        run = self.signer_step()["run"]
        self.assertLess(run.index("tauri signer sign"),
                        run.index("scripts/release_signing.py"),
                        "latest.json describes signatures that already exist")

    def test_gate_steps_receive_signing_presence_without_secret_bytes(self) -> None:
        job_env = self.workflow["jobs"]["build-candidate"].get("env") or {}
        secret_env_vars = (
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
            *RELEASE_SIGNING_SECRETS,
        )
        for name in secret_env_vars:
            self.assertNotIn(name, job_env)

        gate_steps = [
            step for step in self.steps()
            if "scripts/release_gate.py" in str(step.get("run", ""))
        ]
        self.assertEqual(len(gate_steps), 2)
        expected_presence = (
            f"${{{{ secrets.{RELEASE_SIGNING_SECRETS[0]} != '' && "
            f"secrets.{RELEASE_SIGNING_SECRETS[1]} != '' }}}}"
        )
        for step in gate_steps:
            env = step.get("env") or {}
            self.assertEqual(env.get("TERAX_RELEASE_SIGNING_KEY_PRESENT"), expected_presence)
            for name in secret_env_vars:
                self.assertNotIn(name, env)

    def test_release_workflow_stays_read_only_and_bounded_to_signing_secrets(self) -> None:
        # Until #45 implements publication, release.yml must remain non-publishing regardless of
        # contract provisional status.
        permissions = self.workflow.get("permissions") or {}
        for forbidden in (*PUBLICATION_ACTIONS, "tagName", "releaseName", "releaseBody",
                          "releaseDraft", "prerelease", "contents: write", "id-token: write"):
            self.assertNotIn(forbidden, self.code)
        for name, granted in permissions.items():
            self.assertNotIn("write", str(granted), f"release.yml grants {name}: write")
        found = set(re.findall(r"secrets\.([A-Za-z0-9_]+)", self.code))
        self.assertEqual(found - set(RELEASE_SIGNING_SECRETS), set())

    def test_the_signer_uses_the_release_secret_and_the_workflows_signer(self) -> None:
        step = self.signer_step()
        env = step.get("env") or {}
        self.assertEqual(
            env.get("TAURI_SIGNING_PRIVATE_KEY"),
            f"${{{{ secrets.{RELEASE_SIGNING_SECRETS[0]} }}}}",
        )
        self.assertEqual(
            env.get("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
            f"${{{{ secrets.{RELEASE_SIGNING_SECRETS[1]} }}}}",
        )
        run = step["run"]
        # `tauri signer sign` reads the passphrase-protected key itself; the signing material is
        # never handed to another process or written into the checkout.
        self.assertIn("node_modules/.bin/tauri signer sign", run)
        self.assertIn("--app-version", run, "the signature is bound to the release version")
        for artifact in ('*.rpm', '*.deb', "PKGBUILD"):
            self.assertIn(artifact, run, f"every released artifact format is signed ({artifact})")
        self.assertNotIn("src/modules/identity", run)

    def test_the_signer_refuses_by_name_when_the_key_is_absent(self) -> None:
        run = self.signer_step()["run"]
        self.assertIn("signing-key-missing", run)
        self.assertIn("signing-passphrase-missing", run)
        self.assertIn("exit 3", run, "a missing key fails the job instead of skipping signing")
        self.assertIn("nothing is published", run)
        # The refusal happens before any signing call, so a missing secret cannot leave a
        # partially signed set behind for a later step to announce.
        self.assertLess(run.index("signing-key-missing"),
                        run.index("tauri signer sign"))

    def test_no_secret_is_echoed_and_only_public_details_are_logged(self) -> None:
        run = self.signer_step()["run"]
        self.assertNotIn("set -x", run)
        for leak in ("echo $TAURI_SIGNING_PRIVATE_KEY",
                     'echo "$TAURI_SIGNING_PRIVATE_KEY"',
                     "env | ", "printenv"):
            self.assertNotIn(leak, run)
        self.assertIn("--show-key-id", run, "the public key id is the one signing detail logged")
        self.assertIn("sha256sum", run, "artifact hashes are logged")
        self.assertIn("$GITHUB_STEP_SUMMARY", run)

    def test_no_committed_file_holds_a_minisign_secret_key(self) -> None:
        # A secret in the tree is unrecoverable once pushed. The provisioning script writes keys
        # outside the repository; this guard is the one that would catch a mistake.
        listing = subprocess.run(
            ["git", "-C", str(REPO), "ls-files"], capture_output=True, text=True, check=True
        ).stdout.splitlines()
        # Assembled from parts so this guard file does not itself trip the scan.
        markers = (
            "untrusted comment: " + "minisign secret key",
            "trusted comment: " + "minisign secret key",
        )
        for relative in listing:
            path = REPO / relative
            if not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
                continue
            body = path.read_text(errors="ignore")
            for marker in markers:
                self.assertNotIn(marker, body, f"{relative} appears to contain a signing secret")

    def test_the_manifest_is_produced_by_the_signer_not_by_hand(self) -> None:
        run = self.steps()[self.step_index("scripts/release_signing.py")]["run"]
        self.assertIn("--candidate linux-packages", run)
        self.assertIn("--from-signatures", run)
        self.assertIn("--commit", run, "the manifest is bound to the triggering commit")
        self.assertIn("steps.target.outputs.commit", run)
        self.assertIn("steps.target.outputs.tag", run)

    def test_an_unannotated_tag_falls_back_to_adr_0010_release_notes(self) -> None:
        import os
        import minisign
        import release_signing

        notes_step = self.steps()[self.step_index("release-notes.md")]
        version = packaging.version()
        tag = f"v{version}"
        script = notes_step["run"].replace("${{ steps.target.outputs.tag }}", tag)

        with tempfile.TemporaryDirectory(prefix="terax-notes-workflow-") as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            runner_temp = root / "runner-temp"
            runner_temp.mkdir()
            git_env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "test",
                "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "test",
                "GIT_COMMITTER_EMAIL": "test@example.invalid",
            }
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            (repo / "README").write_text("x\n", encoding="utf-8")
            subprocess.run(["git", "add", "README"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, env=git_env, check=True)
            subprocess.run(["git", "tag", tag], cwd=repo, check=True)
            subprocess.run(
                ["bash", "-c", script],
                cwd=repo,
                env={**os.environ, "RUNNER_TEMP": str(runner_temp)},
                check=True,
            )

            candidate = root / "linux-packages"
            candidate.mkdir()
            identity = packaging.candidate()
            for name, payload in (
                (f"{identity.slug}-{version}-1.{packaging.RPM_ARCH}.rpm", b"rpm\n"),
                (f"{identity.slug}_{version}_{packaging.DEB_ARCH}.deb", b"deb\n"),
                ("PKGBUILD", b"pkgname=codr\n"),
            ):
                (candidate / name).write_bytes(payload)
            key = minisign.generate_keypair(seed=b"\x01" * 32, key_id=b"\x02" * 8)
            contract_doc = release_contract()
            contract_doc["provisional"] = False
            contract_doc["endpoints"] = ["https://releases.codr.dev/stable/latest.json"]
            contract_doc["trust"] = {
                "provisioned": True,
                "publicKey": minisign.TrustedKey(key.key_id, key.public_key).tauri_text(),
                "note": "fixture trust root for release-notes workflow test",
            }
            contract_path = runner_temp / "contract.json"
            contract_path.write_text(json.dumps(contract_doc), encoding="utf-8")
            commit = "0123456789abcdef0123456789abcdef01234567"
            result = subprocess.run(
                [
                    sys.executable,
                    str(REPO / "scripts/release_signing.py"),
                    "--candidate", str(candidate),
                    "--version", version,
                    "--tag", tag,
                    "--commit", commit,
                    "--contract", str(contract_path),
                    "--notes-file", str(runner_temp / "release-notes.md"),
                ],
                cwd=REPO,
                env={**os.environ, release_signing.SIGNING_KEY_ENV: release_signing.key_to_text(key)},
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            notes = json.loads((candidate / "latest.json").read_text(encoding="utf-8"))["notes"]
            self.assertIn("unofficial", notes.lower())
            self.assertIn("not affiliated", notes.lower())
            self.assertIn("crynta", notes.lower())
            base_commit = release_contract()["upstream"]["baseCommit"]
            self.assertIn(base_commit[:7], notes)

    def test_the_signed_set_still_leaves_only_as_a_workflow_artifact(self) -> None:
        self.assertIn("name: linux-x86_64-packages", self.body)
        self.assertIn("linux-packages/", self.body)
        for forbidden in PUBLICATION_ACTIONS:
            self.assertNotIn(forbidden, self.code)


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
        # The form asks for the artifact (this fork ships packages, not platforms) and states the
        # narrowed platform commitment in its own words; an OS dropdown would restate the same
        # fact a second time and drift from it.
        self.assertIn("Linux x86-64", bug_report)
        for artifact in ("RPM package", "DEB package", "Arch recipe built locally"):
            self.assertIn(artifact, bug_report)
        self.assertNotIn("Windows", bug_report)
        self.assertNotIn("macOS", bug_report)
        self.assertNotIn("AppImage", bug_report)
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

    def test_the_identifier_it_names_is_one_the_preflight_accepts(self) -> None:
        # The assertion that would have caught this workflow being dead on arrival: an identifier
        # inside upstream's namespace passes a name-shape check but `scripts/app-lab/run.py`
        # refuses it before the build, so no job could ever start. Derive the answer from the
        # preflight itself rather than from a second reading of the namespace rules.
        identifiers = re.findall(r"--identifier\s+(\S+)", self.body)
        self.assertTrue(identifiers, "the run must name its disposable identifier")
        with tempfile.TemporaryDirectory(prefix="terax-smoke-guard-") as tmp:
            root = Path(tmp) / "run"
            root.mkdir()
            env = linux_profile.profile_env(root / "home")
            for identifier in identifiers:
                with self.subTest(identifier=identifier):
                    problems = linux_profile.problems(
                        identifier, env, root, require_isolated=False
                    )
                    self.assertEqual(
                        problems,
                        [],
                        f"{identifier!r} is refused by the preflight, so every smoke job "
                        "aborts before the build",
                    )
                    self.assertTrue(
                        identifier.startswith(f"{PRODUCT_IDENTIFIER}."),
                        f"{identifier!r} is not in the fork identifier namespace",
                    )

    def test_the_contributor_doc_names_a_profile_the_preflight_accepts(self) -> None:
        # The doc told a contributor to reproduce the job with the very identifier the preflight
        # refuses; it was the same stale literal as the workflow. A doc that cannot run is a gap.
        identifiers = [
            token.strip("`,")
            for token in re.findall(r"--identifier\s+(\S+)", text(CONTRIBUTOR_TESTING))
        ]
        self.assertTrue(
            identifiers, "the smoke section must name the identifier the job uses"
        )
        with tempfile.TemporaryDirectory(prefix="terax-smoke-doc-") as tmp:
            root = Path(tmp) / "run"
            root.mkdir()
            env = linux_profile.profile_env(root / "home")
            for identifier in identifiers:
                with self.subTest(identifier=identifier):
                    self.assertEqual(
                        linux_profile.problems(
                            identifier, env, root, require_isolated=False
                        ),
                        [],
                        f"docs/contributing/testing.md documents {identifier!r}, which the "
                        "preflight refuses",
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

    def test_no_workflow_launches_an_upstream_identifier(self) -> None:
        # The preflight refuses upstream's identifier *and anything under it*, so a workflow that
        # names one never reaches a build. Naming the upstream namespace here is the point (like
        # the removed-platform markers), not a second source of the fork's names.
        for path in workflow_files():
            for identifier in re.findall(r"--identifier\s+(\S+)", text(path)):
                identifier = identifier.strip('"\'')
                with self.subTest(workflow=path.name, identifier=identifier):
                    self.assertNotEqual(identifier, UPSTREAM_IDENTIFIER)
                    self.assertFalse(
                        identifier.startswith(f"{UPSTREAM_IDENTIFIER}."),
                        f"{path.name}: {identifier!r} belongs to upstream Terax, which the "
                        "linux_profile preflight refuses",
                    )


if __name__ == "__main__":
    unittest.main()

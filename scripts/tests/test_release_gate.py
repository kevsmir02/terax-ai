"""The publication gate for tagged stable releases (ticket #40, GitHub issue #41).

These tests exercise `scripts/release_gate.py` — the one code path the release workflow calls —
through the seam the ticket names: a tag, the commit it points at, a CI-status record for that
commit, the candidate artifact set and `src/modules/updater/releaseContract.json`. Nothing here
talks to GitHub, uploads, tags or publishes: the gate has no publish path at all, so every
assertion below is about a refusal it must produce, or about the identity it must bind.

Run with: python3 -m unittest discover -s scripts/tests
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import packaging  # noqa: E402
import release_gate  # noqa: E402

# A recorded revision; the gate compares against the real files, not this literal.
COMMIT = "0123456789abcdef0123456789abcdef01234567"
OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98"
VERSION = packaging.version()
TAG = f"v{VERSION}"
CONTRACT = REPO / "src/modules/updater/releaseContract.json"


def codes(decision) -> set:
    return {refusal.code for refusal in decision.refusals}


def refusal(decision, code: str):
    match = [entry for entry in decision.refusals if entry.code == code]
    if not match:
        raise AssertionError(
            f"expected a {code!r} refusal, got {sorted(codes(decision))}:\n"
            + "\n".join(f"  {entry.code}: {entry.message}" for entry in decision.refusals)
        )
    return match[0]


def settled_contract(path: Path, **overrides) -> Path:
    """A copy of the contract with the publication inputs supplied (what #40 would decide).

    `overrides` replaces top-level keys, so a test can settle only the flag and prove the gate
    still refuses while the endpoint or the trust root is missing.
    """
    document = json.loads(CONTRACT.read_text())
    document["provisional"] = False
    # A plausible settled host. Nothing fetches it: the gate has no network path, it only refuses
    # endpoints under a reserved, non-public domain.
    document["endpoints"] = ["https://releases.terax-workspace.dev/stable/latest.json"]
    document["trust"] = {
        "provisioned": True,
        "publicKey": "RWQ" + "A" * 50,
        "note": "settled by the trust ticket",
    }
    document.update(overrides)
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return path


def ci_record(commit: str = COMMIT, jobs=None, conclusions=None) -> dict:
    """A GitHub `commits/{sha}/check-runs` payload with every required job green."""
    jobs = list(jobs if jobs is not None else release_gate.required_ci_jobs())
    conclusions = conclusions or {}
    return {
        "total_count": len(jobs),
        "check_runs": [
            {
                "name": job,
                "status": "completed",
                "conclusion": conclusions.get(job, "success"),
                "head_sha": commit,
                "html_url": "https://github.com/kevsmir02/terax-ai/actions",
            }
            for job in jobs
        ],
    }


class GateTestCase(unittest.TestCase):
    """One place to build the inputs, so every refusal test differs in exactly one thing."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="terax-release-gate-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.candidate = self.build_candidate()
        self.ci = ci_record()
        self.env = {release_gate.SIGNING_KEY_ENV: "not-a-real-key"}

    def build_candidate(
        self,
        *,
        commit: str = COMMIT,
        version: str = VERSION,
        dirty: bool = False,
        disclosed_version: str | None = None,
        directory: str = "candidate",
    ) -> Path:
        """A candidate directory shaped exactly like the workflow's staged artifact set.

        The manifest is assembled by the packaging module itself, so the gate is tested against
        the real document the runner writes rather than a hand-rolled copy of its schema.
        """
        root = self.tmp / directory
        root.mkdir(parents=True, exist_ok=True)
        identity = packaging.candidate()
        artifacts = []
        for fmt, arch in (("rpm", packaging.RPM_ARCH), ("deb", packaging.DEB_ARCH)):
            if fmt == "rpm":
                name = f"{identity.slug}-{version}-1.{arch}.rpm"
            else:
                name = f"{identity.slug}_{version}_{arch}.deb"
            payload = f"{fmt} artifact for {commit}\n".encode()
            (root / name).write_bytes(payload)
            artifacts.append(
                {
                    "format": fmt,
                    "arch": arch,
                    "fileName": name,
                    "path": f"{root.name}/{name}",
                    "sizeBytes": len(payload),
                    "sha256": packaging.sha256_bytes(payload),
                    "packageName": identity.package_name,
                    "version": version,
                    "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"],
                    "files": [{"path": f"/usr/bin/{identity.package_name}", "kind": "binary"}],
                    "binaries": [
                        {"path": f"/usr/bin/{identity.package_name}", "kind": "binary"},
                        {"path": f"/usr/bin/{identity.cli_binary_name}", "kind": "cli"},
                    ],
                    "licenses": [{"path": "/usr/share/doc/LICENSE.txt", "kind": "license"}],
                }
            )
        document = packaging.manifest_document(
            revision={"commit": commit, "branch": "ticket/41-release-gate", "describe": "test",
                      "dirty": dirty, "recordedAt": "2026-11-13T00:00:00+00:00"},
            host={"system": "Linux", "machine": "x86_64"},
            toolchain={"rustc": "rustc 1.99.1"},
            inputs=[{"path": "package.json", "sha256": packaging.sha256_bytes(b"x"),
                     "sizeBytes": 1}],
            artifacts=artifacts,
            dependencies={"declared": {}, "observedElf": [], "unresolvedOnHost": []},
            validation={"build": {"status": "complete"}},
        )
        if disclosed_version is not None:
            # A stale candidate set: the manifest records the version the artifacts carry.
            document["candidate"]["version"] = disclosed_version
            for artifact in document["artifacts"]:
                artifact["version"] = disclosed_version
        (root / "manifest.json").write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        (root / "SHA256SUMS").write_text(packaging.sha256sums(artifacts), encoding="utf-8")
        return root

    def decide(self, **overrides):
        arguments = {
            "tag": TAG,
            "commit": COMMIT,
            "candidate": self.candidate,
            "ci_status": self.ci,
            "contract_path": CONTRACT,
            "environment": self.env,
        }
        arguments.update(overrides)
        return release_gate.decide(**arguments)


class TagVersionAgreementTest(GateTestCase):
    """A tag is a claim about the version; the gate checks the claim, not the tag's existence."""

    def test_a_tag_that_matches_the_application_version_is_accepted(self) -> None:
        decision = self.decide()
        self.assertNotIn("tag-version-mismatch", codes(decision))
        self.assertNotIn("prerelease-tag", codes(decision))

    def test_a_tag_for_another_version_is_refused_and_names_both_versions(self) -> None:
        decision = self.decide(tag="v0.8.7")
        message = refusal(decision, "tag-version-mismatch").message
        self.assertIn("v0.8.7", message)
        self.assertIn(VERSION, message)
        self.assertFalse(decision.publishable)

    def test_a_tag_that_is_not_a_stable_semantic_version_is_refused(self) -> None:
        for tag in (VERSION, f"release-{VERSION}", "v1.0", "latest", f"v{VERSION}-rc.1"):
            with self.subTest(tag=tag):
                decision = self.decide(tag=tag)
                self.assertFalse(decision.publishable)
                self.assertTrue(
                    {"tag-version-mismatch", "prerelease-tag"} & codes(decision),
                    f"{tag!r} must not be accepted as a stable release tag: {sorted(codes(decision))}",
                )

    def test_a_prerelease_tag_is_refused_even_when_the_version_agrees(self) -> None:
        # The release contract is stable-only; a `-beta` tag on a matching version is exactly the
        # case where a naive `startswith` check would publish.
        decision = self.decide(tag=f"v{VERSION}-beta.1")
        self.assertIn("prerelease-tag", codes(decision))
        self.assertFalse(decision.publishable)


class RequiredCiTest(GateTestCase):
    """Green means every job in `ci.yml` reported success *for the tagged commit*."""

    def test_the_required_jobs_are_the_jobs_the_ci_workflow_declares(self) -> None:
        self.assertEqual(
            set(release_gate.required_ci_jobs()),
            {"frontend", "rust", "terminal-linux", "coverage", "repo-guards"},
        )

    def test_green_ci_for_the_tagged_commit_satisfies_the_gate(self) -> None:
        decision = self.decide()
        self.assertFalse([entry for entry in decision.refusals
                          if entry.code.startswith("ci-")])

    def test_a_green_result_for_a_different_commit_is_refused(self) -> None:
        decision = self.decide(ci_status=ci_record(commit=OTHER_COMMIT))
        self.assertIn("ci-commit-mismatch", codes(decision))
        message = refusal(decision, "ci-commit-mismatch").message
        self.assertIn(OTHER_COMMIT[:12], message)
        self.assertIn(COMMIT[:12], message)

    def test_a_missing_required_job_is_refused_by_name(self) -> None:
        jobs = [job for job in release_gate.required_ci_jobs() if job != "repo-guards"]
        decision = self.decide(ci_status=ci_record(jobs=jobs))
        self.assertIn("ci-job-missing", codes(decision))
        self.assertIn("repo-guards", refusal(decision, "ci-job-missing").message)

    def test_a_failed_required_job_is_refused_by_name(self) -> None:
        decision = self.decide(ci_status=ci_record(conclusions={"rust": "failure"}))
        self.assertIn("ci-job-not-green", codes(decision))
        message = refusal(decision, "ci-job-not-green").message
        self.assertIn("rust", message)
        self.assertIn("failure", message)

    def test_a_skipped_or_pending_job_is_not_green(self) -> None:
        for conclusion in ("skipped", "neutral", "cancelled", "timed_out", None):
            with self.subTest(conclusion=conclusion):
                record = ci_record(conclusions={"frontend": conclusion})
                self.assertFalse(self.decide(ci_status=record).publishable)

    def test_absent_ci_evidence_is_refused_rather_than_skipped(self) -> None:
        decision = self.decide(ci_status=None)
        self.assertIn("ci-evidence-missing", codes(decision))
        self.assertFalse(decision.publishable)

    def test_a_paginated_check_run_payload_is_understood(self) -> None:
        # `gh api --paginate --slurp` writes an array of pages; the gate reads the same evidence
        # the workflow collects instead of needing a bespoke serialisation step.
        record = ci_record()
        halves = [
            {"total_count": record["total_count"], "check_runs": record["check_runs"][:2]},
            {"total_count": record["total_count"], "check_runs": record["check_runs"][2:]},
        ]
        decision = self.decide(ci_status=halves)
        self.assertFalse([entry for entry in decision.refusals
                          if entry.code.startswith("ci-")])


class ArtifactIdentityTest(GateTestCase):
    """The candidate is bound to the triggering commit and to the bytes on disk.

    The manifest schema rules are the packaging runner's (`packaging.manifest_problems`), so this
    class only asserts the gate *uses* them and adds what the runner cannot know: which commit
    triggered the release and which artifact set is allowed to exist at all.
    """

    def artifact_names(self) -> list[str]:
        return sorted(
            path.name for path in self.candidate.iterdir() if path.is_file()
        )

    def test_the_decision_binds_the_commit_and_every_artifact_hash(self) -> None:
        identity = self.decide().identity
        self.assertIsNotNone(identity, "the gate must describe what it would publish")
        self.assertEqual(identity.commit, COMMIT)
        self.assertEqual(identity.tag, TAG)
        self.assertEqual(identity.version, VERSION)
        self.assertEqual(
            identity.artifacts,
            {
                name: packaging.sha256_file(self.candidate / name)
                for name in self.artifact_names()
                if name not in ("manifest.json", "SHA256SUMS")
            },
        )
        self.assertRegex(identity.digest, r"^[0-9a-f]{64}$")
        # The identity is immutable: a changed byte changes the digest.
        other = self.decide(commit=OTHER_COMMIT).identity
        self.assertNotEqual(identity.digest, other.digest)

    def test_a_candidate_built_from_another_commit_is_refused(self) -> None:
        decision = self.decide(candidate=self.build_candidate(commit=OTHER_COMMIT,
                                                             directory="other"))
        self.assertIn("artifact-commit-mismatch", codes(decision))
        self.assertIn(COMMIT[:12], refusal(decision, "artifact-commit-mismatch").message)

    def test_a_dirty_build_is_refused(self) -> None:
        decision = self.decide(candidate=self.build_candidate(dirty=True, directory="dirty"))
        self.assertIn("artifact-dirty-build", codes(decision))

    def test_a_missing_artifact_is_refused_by_name(self) -> None:
        deb = next(self.candidate.glob("*.deb"))
        name = deb.name
        deb.unlink()
        decision = self.decide()
        self.assertIn("artifact-missing", codes(decision))
        self.assertIn(name, refusal(decision, "artifact-missing").message)

    def test_an_unexpected_artifact_is_refused(self) -> None:
        # The AppImage assumption the ticket removes: a third format (or any stray file) in the
        # staged set is not silently ignored, because it is a platform commitment nobody made.
        (self.candidate / "terax-workspace_0.9.0_amd64.AppImage").write_bytes(b"appimage\n")
        decision = self.decide()
        self.assertIn("artifact-extra", codes(decision))
        self.assertIn("AppImage", refusal(decision, "artifact-extra").message)

    def test_tampered_bytes_are_refused_even_when_the_names_still_match(self) -> None:
        rpm = next(self.candidate.glob("*.rpm"))
        rpm.write_bytes(b"substituted payload\n")
        decision = self.decide()
        self.assertIn("artifact-checksum-mismatch", codes(decision))
        self.assertIn(rpm.name, refusal(decision, "artifact-checksum-mismatch").message)

    def test_a_checksum_listing_that_disagrees_with_the_manifest_is_refused(self) -> None:
        sums = self.candidate / "SHA256SUMS"
        lines = sums.read_text().splitlines()
        lines[0] = "0" * 64 + lines[0][64:]
        sums.write_text("\n".join(lines) + "\n")
        self.assertIn("artifact-checksum-mismatch", codes(self.decide()))

    def test_an_absent_manifest_is_refused(self) -> None:
        (self.candidate / "manifest.json").unlink()
        self.assertIn("artifact-manifest-missing", codes(self.decide()))

    def test_a_manifest_the_packaging_runner_would_reject_is_refused(self) -> None:
        # Reuses the runner's own rules instead of restating them: a manifest that does not
        # install the candidate binaries (the symptom of a build without the identity overlay)
        # must not reach a publication decision as a valid set.
        path = self.candidate / "manifest.json"
        document = json.loads(path.read_text())
        for artifact in document["artifacts"]:
            artifact["binaries"] = [{"path": "/usr/bin/terax", "kind": "binary"}]
        path.write_text(json.dumps(document, indent=2) + "\n")
        decision = self.decide()
        self.assertIn("artifact-manifest-problem", codes(decision))
        self.assertTrue(
            any("/usr/bin/terax" in entry.message or "candidate binary" in entry.message
                for entry in decision.refusals if entry.code == "artifact-manifest-problem"),
            "the packaging runner's own complaint must be the message",
        )

    def test_the_artifact_version_must_match_the_tag(self) -> None:
        decision = self.decide(candidate=self.build_candidate(disclosed_version="0.8.7",
                                                             directory="old-version"))
        self.assertIn("artifact-version-mismatch", codes(decision))

    def test_a_preconditions_run_needs_no_artifacts(self) -> None:
        decision = self.decide(candidate=None, require_artifacts=False)
        self.assertFalse([entry for entry in decision.refusals
                          if entry.code.startswith("artifact-")])


class PublicationInputTest(GateTestCase):
    """Publication identity and signing trust are undecided (#40), so this must refuse loudly."""

    def test_publication_is_refused_while_the_contract_is_provisional(self) -> None:
        decision = self.decide()
        self.assertFalse(decision.publishable)
        self.assertIn("publication-provisional", codes(decision))
        self.assertIn("releaseContract.json",
                      refusal(decision, "publication-provisional").message)

    def test_the_refusal_names_every_missing_publication_input(self) -> None:
        # Nothing supplied: the state this fork is actually in today.
        messages = {entry.code: entry.message
                    for entry in self.decide(environment={}).refusals}
        for code in ("publication-provisional", "publication-endpoint-missing",
                     "signing-trust-missing", "signing-input-missing"):
            self.assertIn(code, messages, f"{code} must be its own named refusal")
        self.assertIn(".invalid", messages["publication-endpoint-missing"])
        self.assertIn("provisioned", messages["signing-trust-missing"])
        self.assertIn(release_gate.SIGNING_KEY_ENV, messages["signing-input-missing"])

    def test_each_missing_input_names_the_ticket_that_supplies_it(self) -> None:
        contract = json.loads(CONTRACT.read_text())
        expected = release_gate.BREAKDOWN_TO_ISSUE[contract["finalTrustTicket"]]
        for entry in self.decide().refusals:
            if entry.code.startswith(("publication-", "signing-")):
                with self.subTest(code=entry.code):
                    self.assertEqual(entry.ticket, expected,
                                     f"{entry.code} must name the ticket that supplies it")

    def test_the_ticket_translation_covers_the_contract_field(self) -> None:
        # The contract records breakdown ticket numbers; a new field value must not silently
        # produce a refusal that points at the wrong (or no) GitHub issue.
        contract = json.loads(CONTRACT.read_text())
        self.assertIn(contract["finalTrustTicket"], release_gate.BREAKDOWN_TO_ISSUE)

    def test_flipping_provisional_alone_does_not_publish(self) -> None:
        # The deliberate relaxation is the flag; it must not become a bypass for the inputs the
        # flag was standing in for.
        contract = settled_contract(self.tmp / "flag-only.json", trust={
            "provisioned": False, "publicKey": "", "note": "not provisioned",
        })
        decision = self.decide(contract_path=contract)
        self.assertIn("signing-trust-missing", codes(decision))
        self.assertFalse([entry for entry in decision.refusals
                          if entry.code == "publication-provisional"])

    def test_a_non_public_endpoint_is_refused_even_when_the_contract_is_settled(self) -> None:
        for endpoint in (
            "https://updates.invalid/terax-workspace/stable/latest.json",
            "https://updates.terax-workspace.test/stable/latest.json",
            "http://127.0.0.1:8787/stable.json",
        ):
            with self.subTest(endpoint=endpoint):
                contract = settled_contract(self.tmp / "endpoint.json", endpoints=[endpoint])
                self.assertIn("publication-endpoint-missing",
                              codes(self.decide(contract_path=contract)))

    def test_an_upstream_endpoint_is_refused(self) -> None:
        contract = settled_contract(
            self.tmp / "upstream.json",
            endpoints=["https://github.com/crynta/terax-ai/releases/latest/download/latest.json"],
        )
        self.assertIn("publication-endpoint-upstream", codes(self.decide(contract_path=contract)))

    def test_a_non_stable_channel_is_refused(self) -> None:
        contract = settled_contract(self.tmp / "beta.json", channel="beta")
        self.assertIn("channel-not-stable", codes(self.decide(contract_path=contract)))

    def test_a_settled_contract_with_every_input_present_is_publishable(self) -> None:
        # The gate has to be able to say yes, or "refuses today" proves nothing about tomorrow.
        contract = settled_contract(self.tmp / "settled.json")
        decision = self.decide(contract_path=contract)
        self.assertEqual(decision.refusals, (),
                         "\n".join(f"{entry.code}: {entry.message}"
                                   for entry in decision.refusals))
        self.assertTrue(decision.publishable)
        self.assertIsNotNone(decision.identity)

    def test_a_missing_signing_input_is_refused_without_its_value(self) -> None:
        self.assertIn("signing-input-missing", codes(self.decide(environment={})))

    def test_no_secret_value_ever_reaches_the_decision(self) -> None:
        secret = "SECRET-SIGNING-MATERIAL-DO-NOT-LOG"
        contract = settled_contract(self.tmp / "settled.json")
        decision = self.decide(contract_path=contract,
                               environment={release_gate.SIGNING_KEY_ENV: secret})
        rendered = json.dumps(decision.as_dict()) + "\n".join(
            entry.message for entry in decision.refusals
        )
        self.assertNotIn(secret, rendered)
        self.assertTrue(decision.publishable)

    def test_the_gate_reads_the_contract_instead_of_restating_its_values(self) -> None:
        # The endpoint and public key live in one provisional file. A literal copy in the gate is
        # a second source of truth that would survive the real decision silently.
        source = (REPO / "scripts/release_gate.py").read_text()
        contract = json.loads(CONTRACT.read_text())
        for value in [*contract["endpoints"], *contract["upstream"]["endpoints"]]:
            self.assertNotIn(value, source)
        self.assertNotIn(contract["trust"]["publicKey"] or "\0", source)


class CommandLineTest(GateTestCase):
    """The seam the workflow actually calls: `python3 scripts/release_gate.py ...`."""

    def run_gate(self, *arguments: str, env: dict | None = None) -> subprocess.CompletedProcess:
        command = [sys.executable, str(REPO / "scripts/release_gate.py"), *arguments]
        environment = {key: value for key, value in os.environ.items()
                       if key != release_gate.SIGNING_KEY_ENV}
        environment.update(env or {})
        return subprocess.run(command, cwd=REPO, env=environment, capture_output=True, text=True)

    def ci_path(self) -> Path:
        path = self.tmp / "ci-status.json"
        path.write_text(json.dumps(self.ci), encoding="utf-8")
        return path

    def base_arguments(self) -> list[str]:
        return [
            "--tag", TAG,
            "--commit", COMMIT,
            "--candidate", str(self.candidate),
            "--ci-status", str(self.ci_path()),
        ]

    def test_a_dry_run_prints_the_decision_and_exits_zero(self) -> None:
        # The workflow's dry-run input: the whole gate runs against a local artifact set and the
        # decision is printed, with nothing published (there is no publish path to reach).
        result = self.run_gate(*self.base_arguments(), "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        decision = json.loads(result.stdout)
        self.assertFalse(decision["publishable"])
        codes_here = {entry["code"] for entry in decision["refusals"]}
        self.assertIn("publication-provisional", codes_here)
        self.assertIn("gate", result.stderr.lower())

    def test_a_refusal_without_dry_run_exits_non_zero_and_says_why(self) -> None:
        result = self.run_gate(*self.base_arguments())
        self.assertEqual(result.returncode, release_gate.EXIT_REFUSED, result.stderr)
        self.assertIn("refus", result.stderr.lower())
        self.assertIn("publication-provisional", result.stderr)
        self.assertIn("releaseContract.json", result.stderr)

    def test_a_passing_gate_exits_zero(self) -> None:
        contract = settled_contract(self.tmp / "settled.json")
        result = self.run_gate(*self.base_arguments(), "--contract", str(contract),
                               env={release_gate.SIGNING_KEY_ENV: "not-a-real-key"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["publishable"])

    def test_the_preconditions_stage_does_not_need_artifacts(self) -> None:
        # This is what runs before the build: no candidate exists yet, and that is not an error.
        result = self.run_gate("--tag", TAG, "--commit", COMMIT,
                               "--ci-status", str(self.ci_path()), "--preconditions-only")
        self.assertEqual(result.returncode, release_gate.EXIT_REFUSED)
        codes_here = {entry["code"] for entry in json.loads(result.stdout)["refusals"]}
        self.assertFalse([code for code in codes_here if code.startswith("artifact-")], codes_here)

    def test_absent_ci_evidence_is_a_refusal_not_a_usage_error(self) -> None:
        result = self.run_gate("--tag", TAG, "--commit", COMMIT,
                               "--candidate", str(self.candidate))
        self.assertEqual(result.returncode, release_gate.EXIT_REFUSED, result.stderr)
        codes_here = {entry["code"] for entry in json.loads(result.stdout)["refusals"]}
        self.assertIn("ci-evidence-missing", codes_here)

    def test_the_report_and_step_summary_carry_no_secret(self) -> None:
        secret = "SECRET-SIGNING-MATERIAL-DO-NOT-LOG"
        report = self.tmp / "gate-report.json"
        summary = self.tmp / "step-summary.md"
        contract = settled_contract(self.tmp / "settled.json")
        result = self.run_gate(
            *self.base_arguments(),
            "--contract", str(contract),
            "--dry-run",
            "--report", str(report),
            "--step-summary", str(summary),
            env={release_gate.SIGNING_KEY_ENV: secret},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in (report, summary):
            self.assertTrue(path.is_file(), f"{path.name} must be written")
            self.assertNotIn(secret, path.read_text(), f"{path.name} leaked the signing input")
            self.assertNotIn(secret, result.stdout)
            self.assertNotIn(secret, result.stderr)
        self.assertIn("publishable", json.loads(report.read_text()))
        self.assertIn("## Release gate", summary.read_text())

    def test_the_unstaged_tag_is_refused_before_any_artifact_exists(self) -> None:
        # `--preconditions-only` with a mismatched tag is the workflow's pre-build step: it must
        # be red, so the job stops before the build rather than after producing bytes.
        result = self.run_gate("--tag", "v0.8.7", "--commit", COMMIT,
                               "--ci-status", str(self.ci_path()), "--preconditions-only")
        self.assertEqual(result.returncode, release_gate.EXIT_REFUSED)
        codes_here = {entry["code"] for entry in json.loads(result.stdout)["refusals"]}
        self.assertIn("tag-version-mismatch", codes_here)

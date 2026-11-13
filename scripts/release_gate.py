#!/usr/bin/env python3
"""The publication gate for tagged stable releases (ticket #40, GitHub issue #41).

A version tag is a claim: *this commit, this version, these bytes*. This module turns that claim
into a decision. It is the only code path `.github/workflows/release.yml` consults, and it has no
publish path at all — it can only answer `publishable: true/false` and print why. The workflow
asks twice:

1. `--preconditions-only`, before anything is built, so a tag or dispatch that fails the
   tag/version comparison or the green-CI requirement fails the job before an artifact exists;
2. after the build and signing, over the staged artifact set, so the candidate is bound to an
   immutable identity (triggering commit + per-artifact sha256) **and** every announced artifact
   carries a minisign signature that verifies under the committed trust root before anything
   could be published.

Artifact authenticity is verified here, not asserted: `latest.json` must announce the triggering
commit and the application version, every target must point at a staged artifact whose bytes hash
to the announced sha256, that artifact's signature must verify under
`releaseContract.json`'s `trust.publicKey`, and the published `<artifact>.minisig` must be the same
signature. A missing manifest, a missing signature, a signature from another key, a signature over
other bytes and a staged artifact nobody announced are all refusals.

Publication inputs - release owner/URL and signing trust root - live in
`src/modules/updater/releaseContract.json` (breakdown ticket 39 = GitHub issue #40). While a
contract is `"provisional": true` the gate refuses, naming every input it is missing. Even once
settled (`"provisional": false`), the gate keeps failing closed if an endpoint uses a reserved
host or upstream URL, if the trust root is missing/invalid, if the signing secret input is absent
in the environment, or if any signature fails verification under `trust.publicKey`.

The gate never prints a secret: it reports whether the signing input is present, never its value.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import minisign  # noqa: E402
import packaging  # noqa: E402
import release_signing  # noqa: E402

CI_WORKFLOW = REPO_ROOT / ".github/workflows/ci.yml"
RELEASE_CONTRACT = packaging.RELEASE_CONTRACT
# The environment variables that could carry fork signing material. Only presence is ever read;
# the value never enters a message, a report or the step summary. `TERAX_RELEASE_SIGNING_KEY` is
# the offline/emergency fixture form, `TAURI_SIGNING_PRIVATE_KEY` is what the release workflow
# injects for `tauri signer sign`.
SIGNING_KEY_ENV = "TERAX_RELEASE_SIGNING_KEY"
SIGNING_KEY_ENVS = release_signing.SIGNING_KEY_ENVS
# Release tags are `v<major>.<minor>.<patch>` here; the fork publishes stable only.
TAG_PATTERN = re.compile(r"^v(?P<version>\d+\.\d+\.\d+)$")
PRERELEASE_PATTERN = re.compile(r"^v\d+\.\d+\.\d+-[0-9A-Za-z.]+$")
STABLE_CHANNEL = "stable"
# The staged set also holds the update manifest, the Arch-facing recipe and one signature file per
# signed artifact. Nothing else belongs in it.
EXTRA_STAGED_FILES = (
    "manifest.json",
    "SHA256SUMS",
    release_signing.MANIFEST_NAME,
    release_signing.ARCH_ARTIFACT,
)
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_REFUSED = 3
# Non-resolving / reserved endpoint hosts (RFC 2606, RFC 6761) that can never be a publication
# endpoint. Matched as a host suffix so the whole reserved domain family is covered.
NON_PUBLIC_HOSTS = (
    ".invalid",
    ".test",
    ".example",
    ".example.com",
    ".example.net",
    ".example.org",
    ".localhost",
    "localhost",
    "127.0.0.1",
    "::1",
)

# `releaseContract.json` records *breakdown* ticket numbers; the GitHub issues that carry them are
# one higher (breakdown 39 = issue 40). Both are printed so no reader has to guess which is meant.
# tests/test_release_gate.py pins this translation against the contract's own field.
BREAKDOWN_TO_ISSUE = {39: 40, 40: 41, 41: 42, 42: 43, 43: 44, 44: 45}


@dataclass(frozen=True)
class Refusal:
    """One reason this release must not be published."""

    code: str
    message: str
    ticket: int | None = None

    def as_dict(self) -> dict:
        value = {"code": self.code, "message": self.message}
        if self.ticket is not None:
            value["ticket"] = self.ticket
        return value


@dataclass(frozen=True)
class Identity:
    """What the gate would publish, if it ever said yes: tag, version, commit, artifact hashes."""

    tag: str
    version: str
    commit: str
    artifacts: dict[str, str] = field(default_factory=dict)
    digest: str = ""

    def as_dict(self) -> dict:
        return {
            "tag": self.tag,
            "version": self.version,
            "commit": self.commit,
            "artifacts": dict(sorted(self.artifacts.items())),
            "digest": self.digest,
        }


@dataclass(frozen=True)
class Decision:
    publishable: bool
    refusals: tuple[Refusal, ...]
    identity: Identity | None

    def as_dict(self) -> dict:
        return {
            "publishable": self.publishable,
            "identity": self.identity.as_dict() if self.identity else None,
            "refusals": [refusal.as_dict() for refusal in self.refusals],
        }

    def codes(self) -> list[str]:
        return [refusal.code for refusal in self.refusals]


def required_ci_jobs(workflow: Path | None = None) -> list[str]:
    """Every job `ci.yml` declares, in file order.

    Derived from the workflow rather than restated: dropping a job or adding one to CI changes
    what "required CI is green" means, and the gate follows without a second list to update.
    """
    path = workflow or CI_WORKFLOW
    jobs: list[str] = []
    in_jobs = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if not in_jobs:
            in_jobs = line.rstrip() == "jobs:"
            continue
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if match:
            jobs.append(match.group(1))
        elif line and not line.startswith(" "):
            break
    if not jobs:
        raise ValueError(f"{path} declares no jobs, so required CI cannot be determined")
    return jobs


def _check_runs(payload: object) -> list[dict]:
    """Check runs from a GitHub payload, a page array (`gh api --paginate --slurp`) or one page."""
    if payload is None:
        return []
    pages = payload if isinstance(payload, list) else [payload]
    runs: list[dict] = []
    for page in pages:
        if isinstance(page, dict):
            runs.extend(page.get("check_runs") or [])
    return [run for run in runs if isinstance(run, dict)]


def _version_refusals(tag: str) -> tuple[list[Refusal], str | None]:
    """The tag/application-version comparison. Returns the refusals and the resolved version."""
    try:
        version = packaging.version()
    except (ValueError, OSError) as error:
        # Three inputs (tauri.conf.json, package.json, Cargo.toml) must agree; if they do not,
        # there is no application version for a tag to agree with.
        return [
            Refusal(
                "application-version-disagreement",
                f"the packaging inputs disagree on the application version: {error}",
            )
        ], None

    refusals: list[Refusal] = []
    if PRERELEASE_PATTERN.match(tag):
        refusals.append(
            Refusal(
                "prerelease-tag",
                f"tag {tag!r} is a prerelease; releaseContract.json declares channel "
                f"{STABLE_CHANNEL!r} only, so a prerelease tag has no publication path",
            )
        )
    match = TAG_PATTERN.match(tag)
    if match is None:
        refusals.append(
            Refusal(
                "tag-version-mismatch",
                f"tag {tag!r} is not a stable version tag; expected v{version} "
                "(v<major>.<minor>.<patch>, matching the application version)",
            )
        )
    elif match.group("version") != version:
        refusals.append(
            Refusal(
                "tag-version-mismatch",
                f"tag {tag!r} names version {match.group('version')} but the application "
                f"version is {version} (tauri.conf.json, package.json and Cargo.toml)",
            )
        )
    return refusals, version


def _ci_refusals(
    payload: object, commit: str, jobs: list[str], note: str | None = None
) -> list[Refusal]:
    """Green CI means every required job succeeded on exactly the tagged commit."""
    runs = _check_runs(payload)
    if not runs:
        return [
            Refusal(
                "ci-evidence-missing",
                "no check-run record was supplied for the commit, so required CI cannot be shown "
                f"green for {commit}; refusing rather than assuming"
                + (f" ({note})" if note else ""),
            )
        ]
    refusals: list[Refusal] = []
    for run in runs:
        head = str(run.get("head_sha") or "")
        if head and head != commit:
            refusals.append(
                Refusal(
                    "ci-commit-mismatch",
                    f"CI evidence is for commit {head[:12]}, not the triggering commit "
                    f"{commit[:12]}; a green run on another commit says nothing about these bytes",
                )
            )
            break
    by_name: dict[str, list[dict]] = {}
    for run in runs:
        by_name.setdefault(str(run.get("name") or ""), []).append(run)
    for job in jobs:
        candidates = by_name.get(job) or []
        if not candidates:
            refusals.append(
                Refusal("ci-job-missing", f"required CI job {job!r} has no check run for this commit")
            )
            continue
        green = [
            run for run in candidates
            if run.get("conclusion") == "success" and run.get("status") in (None, "completed")
        ]
        if not green:
            conclusions = sorted({str(run.get("conclusion")) for run in candidates})
            refusals.append(
                Refusal(
                    "ci-job-not-green",
                    f"required CI job {job!r} concluded {', '.join(conclusions)} on this commit, "
                    "not success",
                )
            )
    return refusals


def _identity_digest(commit: str, tag: str, artifacts: dict[str, str]) -> str:
    lines = [f"{name} {artifacts[name]}" for name in sorted(artifacts)]
    return packaging.sha256_bytes(
        ("\n".join([commit, tag, *lines]) + "\n").encode("utf-8")
    )


def _identity(tag: str, version: str | None, commit: str,
              artifacts: dict[str, str] | None = None) -> Identity:
    bound = dict(artifacts or {})
    return Identity(
        tag=tag,
        version=version or "",
        commit=commit,
        artifacts=bound,
        digest=_identity_digest(commit, tag, bound) if bound else "",
    )


# ---------------------------------------------------------------------------------------------
# Publication inputs: releaseContract.json is the single source of identity and trust root
# ---------------------------------------------------------------------------------------------


def _host(endpoint: str) -> str:
    return (urlsplit(endpoint).hostname or "").lower()


def _publication_refusals(contract_path: Path, environment: dict) -> list[Refusal]:
    """Why this repository must not publish yet, and the ticket that decides each input."""
    try:
        contract = json.loads(Path(contract_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [
            Refusal(
                "contract-unreadable",
                f"the release contract {Path(contract_path).name} cannot be read ({error}), so "
                "publication identity and trust are unknown: refusing to publish",
            )
        ]

    breakdown = contract.get("finalTrustTicket")
    ticket = BREAKDOWN_TO_ISSUE.get(breakdown, 0)
    refusals: list[Refusal] = []

    channel = contract.get("channel")
    if channel != STABLE_CHANNEL:
        refusals.append(
            Refusal(
                "channel-not-stable",
                f"releaseContract.json channel is {channel!r}; this repository publishes "
                f"{STABLE_CHANNEL} only",
            )
        )

    if contract.get("provisional") is True:
        refusals.append(
            Refusal(
                "publication-provisional",
                "releaseContract.json is still provisional: the release owner and endpoint, and "
                "the signing trust root, are undecided, so these bytes would be published by "
                "nobody accountable. Each missing input is named separately below; the gate "
                f"refuses rather than skipping publication (breakdown ticket {breakdown} = "
                f"GitHub issue #{ticket})",
                ticket or None,
            )
        )

    endpoints = [str(endpoint) for endpoint in contract.get("endpoints") or []]
    upstream = {str(endpoint) for endpoint in (contract.get("upstream") or {}).get("endpoints") or []}
    upstream_repository = str((contract.get("upstream") or {}).get("repository") or "")
    if not endpoints:
        refusals.append(
            Refusal(
                "publication-endpoint-missing",
                "releaseContract.json declares no update/release endpoint, so there is nowhere "
                "for a published artifact set to be discovered",
                ticket or None,
            )
        )
    for endpoint in endpoints:
        host = _host(endpoint)
        if endpoint in upstream or (upstream_repository and upstream_repository in endpoint):
            refusals.append(
                Refusal(
                    "publication-endpoint-upstream",
                    f"releaseContract.json endpoint {endpoint!r} is upstream Terax's release "
                    "feed; this fork publishes its own artifacts only",
                    ticket or None,
                )
            )
            continue
        if urlsplit(endpoint).scheme != "https":
            refusals.append(
                Refusal(
                    "publication-endpoint-missing",
                    f"releaseContract.json endpoint {endpoint!r} is not https",
                    ticket or None,
                )
            )
            continue
        if not host or any(host == live or host.endswith(live) for live in NON_PUBLIC_HOSTS):
            refusals.append(
                Refusal(
                    "publication-endpoint-missing",
                    f"releaseContract.json endpoint {endpoint!r} is under a reserved, "
                    "non-public domain (RFC 2606/6761): it can never serve a real release, so "
                    "this is a placeholder, not a publication identity",
                    ticket or None,
                )
            )

    trust = contract.get("trust") or {}
    if trust.get("provisioned") is not True or not str(trust.get("publicKey") or "").strip():
        refusals.append(
            Refusal(
                "signing-trust-missing",
                "no fork signing trust root is provisioned in releaseContract.json "
                f"(trust.provisioned={trust.get('provisioned')!r}, "
                f"publicKey={'set' if str(trust.get('publicKey') or '').strip() else 'empty'}), "
                "so an artifact's authenticity cannot be established",
                ticket or None,
            )
        )

    signing_input = next(
        (
            name for name in SIGNING_KEY_ENVS
            if str(environment.get(name) or "").strip() != ""
        ),
        "",
    )
    if signing_input == "":
        refusals.append(
            Refusal(
                "signing-input-missing",
                f"no signing input is present in the environment ({' or '.join(SIGNING_KEY_ENVS)}); "
                "it is a fork-owned secret provisioned outside the repository, never in it (its "
                "value is never read into a message, report or log)",
                ticket or None,
            )
        )
    return refusals


# ---------------------------------------------------------------------------------------------
# Artifact identity: the staged set for the triggering commit, nothing more, nothing less
# ---------------------------------------------------------------------------------------------


def _staged_files(candidate: Path) -> set[str]:
    return {path.name for path in candidate.iterdir() if path.is_file()}


def _checksum_listing(path: Path) -> dict[str, str]:
    """`sha256sum -c` lines as a name→digest map (a listing that does not parse is empty)."""
    listing: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = re.match(r"^([0-9a-f]{64})\s+\*?(.+)$", line.strip())
        if match:
            listing[match.group(2).strip()] = match.group(1)
    return listing


def _artifact_refusals(
    candidate: Path | None, commit: str, version: str | None
) -> tuple[list[Refusal], dict[str, str]]:
    """The candidate set as an immutable identity: commit, versions, names, bytes."""
    if candidate is None:
        return [
            Refusal(
                "artifact-set-missing",
                "no candidate artifact set was supplied, so there is nothing whose identity "
                "could be bound to the triggering commit",
            )
        ], {}
    root = Path(candidate)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        return [
            Refusal(
                "artifact-manifest-missing",
                f"{root.name}/manifest.json is absent: the packaging runner's record of the "
                "revision and hashes is what binds the artifacts, and it cannot be assumed",
            )
        ], {}
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [
            Refusal("artifact-manifest-invalid", f"{root.name}/manifest.json is not JSON: {error}")
        ], {}

    refusals: list[Refusal] = []
    revision = document.get("revision") or {}
    recorded_commit = str(revision.get("commit") or "")
    if recorded_commit != commit:
        refusals.append(
            Refusal(
                "artifact-commit-mismatch",
                f"the candidate was built from {recorded_commit[:12] or '<no revision>'}, not the "
                f"triggering commit {commit[:12]}: a tag must publish the artifacts built for its "
                "own commit",
            )
        )
    if revision.get("dirty") is not False:
        refusals.append(
            Refusal(
                "artifact-dirty-build",
                "the candidate was built from a dirty working tree, so its sources cannot be "
                "reconstructed from the recorded commit",
            )
        )
    candidate_identity = document.get("candidate") or {}
    if version is not None and candidate_identity.get("version") != version:
        refusals.append(
            Refusal(
                "artifact-version-mismatch",
                f"the candidate carries version {candidate_identity.get('version')!r}, not the "
                f"application version {version!r}",
            )
        )

    # The runner's own schema and identity rules, not a second copy of them.
    for problem in packaging.manifest_problems(document):
        refusals.append(Refusal("artifact-manifest-problem", problem))

    expected = {
        str(artifact.get("fileName") or ""): artifact
        for artifact in document.get("artifacts") or []
        if isinstance(artifact, dict)
    }
    expected.pop("", None)
    present = _staged_files(root)
    signed = set(expected) | {release_signing.ARCH_ARTIFACT}
    allowed = signed | set(EXTRA_STAGED_FILES)
    allowed |= {f"{name}{release_signing.SIGNATURE_SUFFIX}" for name in signed}

    measured: dict[str, str] = {}
    for name in sorted(allowed):
        if name not in present:
            refusals.append(
                Refusal("artifact-missing", f"the candidate set is missing {name!r}")
            )
    for name in sorted(present - allowed):
        refusals.append(
            Refusal(
                "artifact-extra",
                f"the candidate set contains {name!r}, which no manifest entry, signature file "
                "or update manifest accounts for: the published set is exactly the recorded, "
                "signed artifacts",
            )
        )
    for name, artifact in sorted(expected.items()):
        if name not in present:
            continue
        measured[name] = packaging.sha256_file(root / name)
        if measured[name] != artifact.get("sha256"):
            refusals.append(
                Refusal(
                    "artifact-checksum-mismatch",
                    f"{name} hashes to {measured[name]}, but the packaging manifest recorded "
                    f"{artifact.get('sha256')}",
                )
            )

    sums_path = root / "SHA256SUMS"
    if sums_path.is_file():
        listing = _checksum_listing(sums_path)
        recorded = {name: str(artifact.get("sha256")) for name, artifact in expected.items()}
        if listing != recorded:
            refusals.append(
                Refusal(
                    "artifact-checksum-mismatch",
                    f"{root.name}/SHA256SUMS does not list exactly the manifest's artifacts and "
                    "digests",
                )
            )
    return refusals, measured


def _signed_artifact_refusals(
    candidate: Path, commit: str, version: str | None, contract_path: Path
) -> tuple[list[Refusal], dict[str, str]]:
    """The update manifest and the signatures over the staged bytes.

    This is the half that makes authenticity a decision rather than a claim: `latest.json` must
    name this commit and version, and every announced artifact's signature must verify under the
    trust root the contract commits to.
    """
    root = Path(candidate)
    manifest_path = root / release_signing.MANIFEST_NAME
    if not manifest_path.is_file():
        return [
            Refusal(
                "artifact-update-manifest-missing",
                f"{root.name}/{release_signing.MANIFEST_NAME} is absent: it is the signed "
                "release's announcement of version, commit, artifact urls, sha256 and signatures",
            )
        ], {}
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        return [
            Refusal(
                "artifact-update-manifest-invalid",
                f"{manifest_path.name} is not JSON: {error}",
            )
        ], {}

    try:
        contract = json.loads(Path(contract_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [
            Refusal(
                "artifact-signing-trust-unreadable",
                f"the release contract cannot be read ({error}), so no signature can be checked "
                "against a trust root: refusing rather than trusting",
            )
        ], {}
    try:
        trusted = release_signing.trusted_key_from_contract(contract)
    except minisign.MinisignError as error:
        return [
            Refusal(
                "artifact-signing-trust-unreadable",
                f"the contract's trust.publicKey is not a usable minisign public key: {error}",
            )
        ], {}

    problems, bound = release_signing.update_problems(
        document, directory=root, version=version, commit=commit, trusted=trusted
    )
    return [Refusal(code, message) for code, message in problems], bound


def decide(
    *,
    tag: str,
    commit: str,
    candidate: Path | None = None,
    ci_status: object = None,
    contract_path: Path | None = None,
    ci_workflow_path: Path | None = None,
    environment: dict | None = None,
    require_artifacts: bool = True,
    ci_status_note: str | None = None,
) -> Decision:
    """Evaluate every precondition. A single refusal makes the release unpublishable."""
    environment = dict(os.environ if environment is None else environment)
    contract_path = Path(contract_path or RELEASE_CONTRACT)
    refusals: list[Refusal] = []

    version_refusals, version = _version_refusals(tag)
    refusals.extend(version_refusals)
    refusals.extend(
        _ci_refusals(ci_status, commit, required_ci_jobs(ci_workflow_path), ci_status_note)
    )
    refusals.extend(_publication_refusals(contract_path, environment))

    artifacts: dict[str, str] = {}
    if require_artifacts:
        artifact_refusals, measured = _artifact_refusals(candidate, commit, version)
        refusals.extend(artifact_refusals)
        signing_refusals, bound = _signed_artifact_refusals(
            Path(candidate) if candidate is not None else Path("."), commit, version,
            contract_path,
        )
        refusals.extend(signing_refusals)
        # The identity is the signed set when the update manifest accounts for it: that is
        # exactly what would be published.
        artifacts = bound or measured

    return Decision(
        publishable=not refusals,
        refusals=tuple(refusals),
        identity=_identity(tag, version, commit, artifacts),
    )


# ---------------------------------------------------------------------------------------------
# Command line: print the decision. There is deliberately no publish code path to call.
# ---------------------------------------------------------------------------------------------


def render_human(decision: Decision, *, dry_run: bool) -> str:
    """The log lines a maintainer reads. Refusals are loud; the identity is always shown."""
    verdict = "would publish" if decision.publishable else "REFUSED"
    lines = [
        f"release gate: {verdict}"
        + (" (dry run: the gate has no publish path, nothing was uploaded)" if dry_run else ""),
    ]
    identity = decision.identity
    if identity is not None:
        lines.append(
            f"identity: tag {identity.tag or '<none>'} version {identity.version or '<unknown>'} "
            f"commit {identity.commit} digest {identity.digest or '<unbound>'}"
        )
        for name, digest in sorted(identity.artifacts.items()):
            lines.append(f"  {name} {digest}")
    for refusal in decision.refusals:
        ticket = f" [issue #{refusal.ticket}]" if refusal.ticket else ""
        lines.append(f"refusing: {refusal.code}: {refusal.message}{ticket}")
    if decision.publishable:
        lines.append(
            "note: a passing gate is a precondition, not a publication: no upload step exists"
        )
    return "\n".join(lines) + "\n"


def render_step_summary(decision: Decision, *, tag: str, commit: str) -> str:
    """A GitHub step summary a reviewer can read without opening the log."""
    status = "publishable" if decision.publishable else "refused"
    lines = [
        "## Release gate",
        "",
        f"| field | value |",
        f"| --- | --- |",
        f"| verdict | {status} |",
        f"| tag | `{tag}` |",
        f"| commit | `{commit}` |",
    ]
    if decision.identity is not None:
        lines.append(f"| identity digest | `{decision.identity.digest or '<unbound>'}` |")
        for name, digest in sorted(decision.identity.artifacts.items()):
            lines.append(f"| `{name}` | `{digest}` |")
    lines.extend(["", "### Refusals", ""])
    if decision.refusals:
        lines.extend(["| code | why | ticket |", "| --- | --- | --- |"])
        for refusal in decision.refusals:
            ticket = f"#{refusal.ticket}" if refusal.ticket else "—"
            lines.append(f"| `{refusal.code}` | {refusal.message} | {ticket} |")
    else:
        lines.append("None. A passing gate is a precondition, not a publication.")
    return "\n".join(lines) + "\n"


def load_ci_status(path: Path | None) -> tuple[object, str | None]:
    """The collected check-run record, plus why it could not be read (never a silent absence)."""
    if path is None:
        return None, "no --ci-status record was given"
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")), None
    except OSError as error:
        return None, f"{Path(path).name} could not be read: {error}"
    except json.JSONDecodeError as error:
        return None, f"{Path(path).name} is not readable JSON: {error}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Decide whether a tagged stable release may be published. This command never "
            "publishes: it prints the decision and exits 0 (publishable), 3 (refused) or 2 "
            "(usage). Run it with --preconditions-only before building and over the staged "
            "artifact set afterwards."
        )
    )
    parser.add_argument("--tag", required=True, help="release tag, e.g. v0.9.0")
    parser.add_argument("--commit", default=None,
                        help="commit the tag points at (default: git rev-parse HEAD)")
    parser.add_argument("--candidate", default=None,
                        help="staged artifact directory holding the packages, SHA256SUMS and "
                             "manifest.json")
    parser.add_argument("--ci-status", default=None,
                        help="check-runs JSON for the commit; absent is a refusal, not a skip")
    parser.add_argument("--contract", default=str(RELEASE_CONTRACT),
                        help="release contract (publication identity + trust)")
    parser.add_argument("--ci-workflow", default=str(CI_WORKFLOW),
                        help="workflow whose jobs are the required CI set")
    parser.add_argument("--preconditions-only", action="store_true",
                        help="evaluate tag/version, CI and publication inputs before any build")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the decision and exit 0 even when refused; publishes nothing")
    parser.add_argument("--report", default=None, help="write the decision JSON to this path")
    parser.add_argument("--step-summary", default=None,
                        help="append a markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
    arguments = parser.parse_args(argv)

    try:
        commit = arguments.commit or subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"error: cannot resolve the triggering commit: {error}", file=sys.stderr)
        return EXIT_USAGE

    ci_status, note = load_ci_status(Path(arguments.ci_status) if arguments.ci_status else None)
    decision = decide(
        tag=arguments.tag,
        commit=commit,
        candidate=Path(arguments.candidate) if arguments.candidate else None,
        ci_status=ci_status,
        contract_path=Path(arguments.contract),
        ci_workflow_path=Path(arguments.ci_workflow),
        require_artifacts=not arguments.preconditions_only,
        ci_status_note=note,
    )

    payload = decision.as_dict()
    payload["dryRun"] = bool(arguments.dry_run)
    payload["stage"] = "preconditions" if arguments.preconditions_only else "artifacts"
    rendered = json.dumps(payload, indent=2)
    if arguments.report:
        Path(arguments.report).write_text(rendered + "\n", encoding="utf-8")
    if arguments.step_summary:
        with Path(arguments.step_summary).open("a", encoding="utf-8") as summary:
            summary.write(render_step_summary(decision, tag=arguments.tag, commit=commit))
    print(render_human(decision, dry_run=arguments.dry_run), end="", file=sys.stderr)
    print(rendered)

    if decision.publishable:
        return EXIT_OK
    return EXIT_OK if arguments.dry_run else EXIT_REFUSED


if __name__ == "__main__":
    raise SystemExit(main())

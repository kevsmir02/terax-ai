"""Release signing and the stable update manifest (issue #41, breakdown ticket 40).

A tag claims *this commit, this version, these bytes*. `scripts/release_gate.py` decides whether
that claim holds; this module produces the evidence it checks and the manifest a client reads:

    linux-packages/
      <package>-<version>-<release>.x86_64.rpm   + .minisig
      <package>_<version>_amd64.deb              + .minisig
      PKGBUILD                                   + .minisig   (the Arch-facing artifact)
      latest.json                                (channel stable, version, notes, per-target
                                                  url + sha256 + signature)
      manifest.json, SHA256SUMS                  (the packaging runner's record)

The manifest is `latest.json`-style so a client needs one schema, and it is *not* the Tauri
updater's download contract: it names per-target artifacts, including the Arch recipe, and every
entry is bound to the artifact's sha256 as well as to its signature. Nothing here downloads or
installs anything; the manifest is what a package-tool handoff points a person at.

Signing has two entry points on purpose:

* the release workflow signs with `tauri signer sign`, which reads the maintainer's
  passphrase-protected minisign key from a workflow secret and never exposes it to Python
  (`--from-signatures`: signatures already exist, this module normalises and verifies them);
* tests and offline recovery sign with a fixture/emergency key supplied as
  `TERAX_RELEASE_SIGNING_KEY` (base64 of `{"keyId", "secretKey"}`), which this module reads.

Both produce the same envelope. `scripts/minisign.py` is the verifier in either case.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import minisign  # noqa: E402
import packaging  # noqa: E402

RELEASE_CONTRACT = REPO_ROOT / "src/modules/updater/releaseContract.json"
MANIFEST_NAME = "latest.json"
SIGNATURE_SUFFIX = ".minisig"
TAURI_SIGNATURE_SUFFIX = ".sig"
CHANNEL = "stable"
ARCH_ARTIFACT = "PKGBUILD"
# The target key the application's discovery reads (`src/modules/updater/checkForUpdate.ts`).
PRIMARY_TARGET = "linux-x86_64"
# Which staged artifact each announced target points at. `linux-x86_64` is the app's discovery
# key and carries the deb (Debian/Ubuntu is the widest desktop base); the other two are explicit
# so no format is silently missing from a release.
TARGET_ARTIFACTS = {
    "linux-x86_64": "deb",
    "linux-x86_64-rpm": "rpm",
    "linux-x86_64-arch": "arch",
}
ARTIFACT_TARGETS = {kind: target for target, kind in TARGET_ARTIFACTS.items()}
SIGNING_KEY_ENV = "TERAX_RELEASE_SIGNING_KEY"
# A signing input is present when either the workflow's Tauri-compatible secret or the offline
# emergency key is set. Only presence is ever read into a message.
SIGNING_KEY_ENVS = (SIGNING_KEY_ENV, "TAURI_SIGNING_PRIVATE_KEY")
ISO_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class SigningError(ValueError):
    """A release that cannot be signed or a manifest that cannot be built."""


@dataclass(frozen=True)
class Artifact:
    name: str
    path: Path
    kind: str
    sha256: str
    size: int

    @property
    def target(self) -> str:
        return ARTIFACT_TARGETS[self.kind]


def artifact_kind(name: str) -> str | None:
    """`rpm`, `deb`, `arch` for a release artifact; None for records and signatures."""
    lower = name.lower()
    if lower.endswith(".rpm"):
        return "rpm"
    if lower.endswith(".deb"):
        return "deb"
    if name == ARCH_ARTIFACT:
        return "arch"
    return None


def staged_artifacts(directory: Path) -> list[Artifact]:
    """Every signable artifact in a staged candidate set, in a stable order."""
    root = Path(directory)
    artifacts = []
    for path in sorted(root.iterdir()):
        if not path.is_file():
            continue
        kind = artifact_kind(path.name)
        if kind is None:
            continue
        artifacts.append(
            Artifact(
                name=path.name,
                path=path,
                kind=kind,
                sha256=_sha256_file(path),
                size=path.stat().st_size,
            )
        )
    return artifacts


def _sha256_file(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------------------------
# Key material: fixture / offline emergency only. The workflow never uses this path.
# ---------------------------------------------------------------------------------------------


def key_from_text(value: str) -> minisign.KeyPair:
    """Read a fixture/emergency key: JSON or base64-wrapped JSON, never echoed in errors."""
    text = (value or "").strip()
    if text == "":
        raise SigningError("the signing key is empty")
    document = None
    try:
        document = json.loads(text)
    except json.JSONDecodeError:
        try:
            document = json.loads(base64.b64decode(text, validate=True).decode("utf-8"))
        except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
            raise SigningError(
                f"{SIGNING_KEY_ENV} is neither JSON nor base64-wrapped JSON "
                '({"keyId": "<hex>", "secretKey": "<base64 Ed25519 seed>"})'
            ) from None
    if not isinstance(document, dict):
        raise SigningError(f"{SIGNING_KEY_ENV} is not a key object")
    helper = str(document.get("helper") or "")
    if helper == "minisign-secret-key":
        raise SigningError(
            f"{SIGNING_KEY_ENV} holds a passphrase-protected minisign secret key; decrypting it "
            "outside minisign is not supported. Sign with `tauri signer sign` and pass "
            "--from-signatures, or provide the fixture/emergency Ed25519 seed form"
        )
    try:
        key_id = minisign.key_id_from_hex(str(document["keyId"]))
        seed = base64.b64decode(str(document["secretKey"]), validate=True)
    except (KeyError, ValueError, binascii.Error) as error:
        raise SigningError(f"{SIGNING_KEY_ENV} is missing a usable keyId/secretKey: {error}") from None
    if len(seed) != 32:
        raise SigningError("the Ed25519 secret seed must be exactly 32 bytes")
    return minisign.KeyPair(seed=seed, key_id=key_id,
                            public_key=minisign.public_key_from_seed(seed))


def key_to_text(key: minisign.KeyPair) -> str:
    """The fixture/emergency export form (used by tests and the offline recovery procedure)."""
    document = {
        "keyId": key.key_id_text,
        "secretKey": base64.b64encode(key.seed).decode("ascii"),
        "note": "Ed25519 seed for offline signing only; never commit or paste into an issue",
    }
    return base64.b64encode(json.dumps(document).encode("utf-8")).decode("ascii")


def signing_key_from_environment(environment: dict) -> minisign.KeyPair | None:
    value = str(environment.get(SIGNING_KEY_ENV) or "").strip()
    return key_from_text(value) if value else None


# ---------------------------------------------------------------------------------------------
# The contract: identity, endpoint, and the one trusted key
# ---------------------------------------------------------------------------------------------


def load_contract(path: Path | None = None) -> dict:
    return json.loads(Path(path or RELEASE_CONTRACT).read_text(encoding="utf-8"))


def endpoint_from_contract(contract: dict) -> str:
    """The base URL artifacts are announced under, derived from the contract's manifest URL.

    A contract endpoint names the release feed; the artifacts sit beside it. `.../stable/` and
    `.../stable/latest.json` therefore both resolve to the same base, and a GitHub
    `releases/latest/download/` endpoint keeps its trailing segment.
    """
    endpoints = [str(endpoint) for endpoint in contract.get("endpoints") or []]
    if not endpoints:
        raise SigningError("releaseContract.json declares no endpoint to announce artifacts under")
    endpoint = endpoints[0]
    if endpoint.endswith("/"):
        return endpoint
    base, _, last = endpoint.rpartition("/")
    if "." in last:
        # A file name (e.g. `latest.json`): artifacts are siblings, not children.
        return base + "/"
    return endpoint + "/"


def trusted_key_from_contract(contract: dict) -> minisign.TrustedKey | None:
    """The committed trust root, or None while it is unprovisioned."""
    trust = contract.get("trust") or {}
    if trust.get("provisioned") is not True:
        return None
    value = str(trust.get("publicKey") or "").strip()
    if value == "":
        return None
    return minisign.parse_public_key(value)


# ---------------------------------------------------------------------------------------------
# Manifest assembly
# ---------------------------------------------------------------------------------------------


def default_notes(version: str) -> str:
    # The product name comes from the shared identity table, not a second literal.
    product = packaging.candidate().product_name
    return (
        f"{product} {version} - stable Linux release (RPM, DEB and the Arch recipe). "
        "Unofficial fork of Terax; not affiliated with Crynta."
    )


def build_manifest(
    *,
    version: str,
    tag: str,
    commit: str,
    endpoint: str,
    artifacts: list[Artifact],
    signatures: dict[str, str],
    notes: str,
    pub_date: str,
    trusted: minisign.TrustedKey | None,
    key_id: str,
) -> dict:
    """The `latest.json` document. Pure: every value comes from the caller's measurements.

    `trusted=None` is the unprovisioned-trust-root case: the manifest records the key id that
    signed it and no fingerprint, and the gate refuses until the contract carries the public key.
    """
    by_kind: dict[str, Artifact] = {}
    for artifact in artifacts:
        if artifact.kind in by_kind:
            raise SigningError(
                f"multiple {artifact.kind} artifacts staged ({by_kind[artifact.kind].name} and "
                f"{artifact.name}); expected exactly one per format"
            )
        by_kind[artifact.kind] = artifact
    missing = [kind for kind in TARGET_ARTIFACTS.values() if kind not in by_kind]
    if missing:
        raise SigningError(
            "the staged set has no " + ", ".join(sorted(missing)) +
            " artifact, so the manifest would announce a release it cannot point at"
        )
    platforms: dict[str, dict] = {}
    for target, kind in TARGET_ARTIFACTS.items():
        artifact = by_kind[kind]
        signature = signatures.get(artifact.name, "")
        if signature.strip() == "":
            raise SigningError(f"no signature was supplied for {artifact.name}")
        platforms[target] = {
            "url": endpoint + artifact.name,
            "signature": signature if signature.endswith("\n") else signature + "\n",
            "size": artifact.size,
            "sha256": artifact.sha256,
            "format": artifact.kind,
        }
    return {
        "version": version,
        "channel": CHANNEL,
        "notes": notes,
        "pub_date": pub_date,
        "tag": tag,
        "commit": commit,
        "signing": {
            "keyId": key_id,
            "fingerprint": trusted.fingerprint if trusted is not None else "",
            "algorithm": "minisign",
        },
        "platforms": platforms,
    }


def manifest_text(document: dict) -> str:
    return json.dumps(document, indent=2, sort_keys=False) + "\n"


def iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------------------------
# Signing a staged candidate set
# ---------------------------------------------------------------------------------------------


def signature_path(directory: Path, name: str) -> Path:
    return Path(directory) / (name + SIGNATURE_SUFFIX)


def read_existing_signature(directory: Path, name: str) -> str | None:
    """The signature for `name` from `.minisig` (envelope) or `.sig` (Tauri's base64 wrap)."""
    root = Path(directory)
    for suffix in (SIGNATURE_SUFFIX, TAURI_SIGNATURE_SUFFIX):
        path = root / (name + suffix)
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8").strip()
        if text == "":
            continue
        return minisign.signature_text(text)
    return None


def sign_candidate(
    *,
    directory: Path,
    version: str,
    tag: str,
    commit: str,
    notes: str,
    key: minisign.KeyPair | None = None,
    trusted: minisign.TrustedKey | None = None,
    endpoint: str | None = None,
    pub_date: str | None = None,
    timestamp: int | None = None,
    from_signatures: bool = False,
    prehashed: bool = True,
) -> dict:
    """Sign (or collect signatures for) every artifact and write `latest.json`.

    Returns the manifest document that was written. Raises `SigningError` (never writes a
    half-signed release) when the set is incomplete, a signature is missing, or a supplied
    signature does not verify under the key it is supposed to belong to.
    """
    root = Path(directory)
    artifacts = staged_artifacts(root)
    if not artifacts:
        raise SigningError(f"{root} holds no rpm, deb or {ARCH_ARTIFACT} artifact to sign")
    seen_kinds: dict[str, str] = {}
    for artifact in artifacts:
        if artifact.kind in seen_kinds:
            raise SigningError(
                f"multiple {artifact.kind} artifacts staged ({seen_kinds[artifact.kind]} and "
                f"{artifact.name}); expected exactly one per format"
            )
        seen_kinds[artifact.kind] = artifact.name

    if key is not None:
        signer_key = minisign.TrustedKey(key.key_id, key.public_key)
        expected = trusted or signer_key
    else:
        expected = trusted
    if expected is None and not from_signatures:
        raise SigningError(
            f"no signing input: set {SIGNING_KEY_ENV} or sign with `tauri signer sign` and pass "
            "--from-signatures"
        )

    signatures: dict[str, str] = {}
    observed_key_ids: set[str] = set()
    for artifact in artifacts:
        try:
            if key is not None:
                comment = minisign.trusted_comment(
                    file_name=artifact.name, version=version, timestamp=timestamp
                )
                text = minisign.sign_bytes(
                    key, artifact.path.read_bytes(), comment, prehashed=prehashed
                )
            else:
                existing = read_existing_signature(root, artifact.name)
                if existing is None:
                    raise SigningError(
                        f"{artifact.name} has no signature: run `tauri signer sign` for it first"
                    )
                text = existing
            parsed = minisign.parse_signature(text)
        except minisign.MinisignError as error:
            raise SigningError(f"{artifact.name}: {error}") from error
        observed_key_ids.add(parsed.key_id_text)
        signed_version = minisign.trusted_comment_version(parsed.trusted_comment)
        if signed_version is not None and signed_version != version:
            raise SigningError(
                f"{artifact.name} is signed for version {signed_version}, not {version}"
            )
        if expected is not None:
            problems = minisign.signature_problems(expected, artifact.path.read_bytes(), text)
            if problems:
                raise SigningError(
                    f"{artifact.name}: {problems[0]}"
                )
        signatures[artifact.name] = text
        signature_path(root, artifact.name).write_text(text, encoding="utf-8")
        tauri_path = root / (artifact.name + TAURI_SIGNATURE_SUFFIX)
        if tauri_path.is_file():
            tauri_path.unlink()

    if len(observed_key_ids) != 1:
        raise SigningError(
            "the staged signatures were made by different keys: "
            + ", ".join(sorted(observed_key_ids))
        )
    key_id = expected.key_id_text if expected is not None else next(iter(observed_key_ids))
    document = build_manifest(
        version=version, tag=tag, commit=commit, endpoint=endpoint or "",
        artifacts=artifacts, signatures=signatures, notes=notes,
        pub_date=pub_date or iso_now(), trusted=expected, key_id=key_id,
    )
    (root / MANIFEST_NAME).write_text(manifest_text(document), encoding="utf-8")
    return document


# ---------------------------------------------------------------------------------------------
# Verification: the gate's artifact stage, in one place
# ---------------------------------------------------------------------------------------------

Problem = tuple[str, str]


def update_problems(
    document: object,
    *,
    directory: Path,
    version: str | None,
    commit: str,
    trusted: minisign.TrustedKey | None,
) -> tuple[list[Problem], dict[str, str]]:
    """Why this `latest.json` cannot be published (empty when it can), and the bound hashes.

    Fails closed on every axis: the manifest must name the triggering commit and the application
    version, every announced target must point at a staged artifact whose bytes hash to the
    announced sha256 and whose signature verifies under the trusted key, and every staged
    artifact must be announced by at least one target.
    """
    root = Path(directory)
    problems: list[Problem] = []
    if not isinstance(document, dict):
        return [("artifact-update-manifest-invalid", "latest.json is not a JSON object")], {}

    declared_version = document.get("version")
    if not isinstance(declared_version, str) or declared_version.strip() == "":
        problems.append(
            ("artifact-update-manifest-invalid", "latest.json declares no version")
        )
    elif version is not None and declared_version != version:
        problems.append(
            (
                "artifact-update-version-mismatch",
                f"latest.json announces version {declared_version!r}, not the application "
                f"version {version!r}",
            )
        )

    channel = document.get("channel")
    if channel != CHANNEL:
        problems.append(
            (
                "artifact-update-channel-mismatch",
                f"latest.json declares channel {channel!r}; this repository publishes "
                f"{CHANNEL!r} only",
            )
        )

    recorded_commit = str(document.get("commit") or "")
    if recorded_commit == "":
        problems.append(
            (
                "artifact-update-manifest-invalid",
                "latest.json does not record the commit the artifacts were built from",
            )
        )
    elif recorded_commit != commit:
        problems.append(
            (
                "artifact-update-commit-mismatch",
                f"latest.json was built for commit {recorded_commit[:12]}, not the triggering "
                f"commit {commit[:12]}",
            )
        )

    if not str(document.get("notes") or "").strip():
        problems.append(
            ("artifact-update-manifest-invalid", "latest.json carries no release notes")
        )
    pub_date = str(document.get("pub_date") or "")
    if not ISO_PATTERN.match(pub_date):
        problems.append(
            (
                "artifact-update-manifest-invalid",
                f"latest.json pub_date {pub_date!r} is not an ISO-8601 UTC timestamp",
            )
        )

    signing = document.get("signing") or {}
    if not isinstance(signing, dict):
        problems.append(
            ("artifact-update-manifest-invalid", "latest.json signing entry is not an object")
        )
        signing = {}
    announced_key_id = str(signing.get("keyId") or "")
    if announced_key_id == "":
        problems.append(
            (
                "artifact-update-manifest-invalid",
                "latest.json names no signing key, so no signature can be attributed",
            )
        )
    elif trusted is not None:
        if announced_key_id != trusted.key_id_text:
            problems.append(
                (
                    "artifact-signature-key-mismatch",
                    f"latest.json announces signing key {announced_key_id}, but the committed "
                    f"trust root is {trusted.key_id_text}",
                )
            )
        announced_fingerprint = str(signing.get("fingerprint") or "")
        if announced_fingerprint and announced_fingerprint != trusted.fingerprint:
            problems.append(
                (
                    "artifact-signature-key-mismatch",
                    "latest.json's key fingerprint does not match the committed public key",
                )
            )

    platforms = document.get("platforms")
    if not isinstance(platforms, dict) or not platforms:
        problems.append(
            ("artifact-update-manifest-invalid", "latest.json announces no platform artifacts")
        )
        return problems, {}
    if PRIMARY_TARGET not in platforms:
        problems.append(
            (
                "artifact-update-manifest-invalid",
                f"latest.json has no {PRIMARY_TARGET!r} entry, which is the target the "
                "application's discovery reads",
            )
        )

    measured = {artifact.name: artifact for artifact in staged_artifacts(root)}
    covered: set[str] = set()
    bound: dict[str, str] = {}
    for target in sorted(platforms):
        entry = platforms[target]
        if not isinstance(entry, dict):
            problems.append(
                ("artifact-update-manifest-invalid", f"latest.json {target!r} entry is not an object")
            )
            continue
        url = str(entry.get("url") or "")
        parsed = urlsplit(url)
        name = Path(parsed.path).name
        if name == "":
            problems.append(
                ("artifact-update-manifest-invalid", f"latest.json {target!r} entry has no url")
            )
            continue
        if parsed.scheme != "https":
            problems.append(
                (
                    "artifact-update-manifest-invalid",
                    f"latest.json {target!r} url {url!r} is not https, so a download could be "
                    "redirected in transit",
                )
            )
        artifact = measured.get(name)
        if artifact is None:
            problems.append(
                (
                    "artifact-update-artifact-missing",
                    f"latest.json {target!r} points at {name!r}, which is not in the staged set",
                )
            )
            continue
        covered.add(name)
        # Bind the hash as soon as the entry points at a staged file: the identity describes what
        # would be published even when a signature check below refuses it.
        bound[name] = artifact.sha256

        announced_sha = str(entry.get("sha256") or "")
        if not SHA256_PATTERN.match(announced_sha):
            problems.append(
                (
                    "artifact-update-checksum-mismatch",
                    f"latest.json {target!r} carries no sha256 for {name}",
                )
            )
        elif announced_sha != artifact.sha256:
            problems.append(
                (
                    "artifact-update-checksum-mismatch",
                    f"latest.json announces {announced_sha} for {name}, but the staged bytes "
                    f"hash to {artifact.sha256}",
                )
            )
        announced_size = entry.get("size")
        if announced_size != artifact.size:
            problems.append(
                (
                    "artifact-update-checksum-mismatch",
                    f"latest.json announces {announced_size!r} bytes for {name}, but the staged "
                    f"file is {artifact.size} bytes",
                )
            )

        signature = entry.get("signature")
        if not isinstance(signature, str) or signature.strip() == "":
            problems.append(
                (
                    "artifact-signature-missing",
                    f"latest.json {target!r} carries no signature for {name}",
                )
            )
            continue
        try:
            envelope = minisign.signature_text(signature)
            parsed_signature = minisign.parse_signature(envelope)
        except minisign.MinisignError as error:
            problems.append(
                (
                    "artifact-signature-invalid",
                    f"latest.json {target!r} signature for {name} is unreadable: {error}",
                )
            )
            continue
        if trusted is None:
            problems.append(
                (
                    "artifact-signature-unverifiable",
                    "no release trust root is provisioned in releaseContract.json, so the "
                    f"signature over {name} cannot be verified; refusing to call it authentic",
                )
            )
            continue
        signature_problems = minisign.signature_problems(
            trusted, artifact.path.read_bytes(), envelope
        )
        if signature_problems:
            key_mismatch = parsed_signature.key_id != trusted.key_id
            problems.append(
                (
                    "artifact-signature-key-mismatch" if key_mismatch else "artifact-signature-invalid",
                    f"{name}: {signature_problems[0]}",
                )
            )
            continue
        signed_version = minisign.trusted_comment_version(parsed_signature.trusted_comment)
        if signed_version is not None and version is not None and signed_version != version:
            problems.append(
                (
                    "artifact-signature-version-mismatch",
                    f"{name} is signed for version {signed_version}, not the announced "
                    f"{version}",
                )
            )
            continue

        signature_file = signature_path(root, name)
        if not signature_file.is_file():
            problems.append(
                (
                    "artifact-signature-missing",
                    f"the staged set has no {signature_file.name}: the published signature file "
                    "and the manifest entry must be the same signature",
                )
            )
        else:
            try:
                file_envelope = minisign.signature_text(signature_file.read_text(encoding="utf-8"))
            except minisign.MinisignError as error:
                problems.append(
                    (
                        "artifact-signature-invalid",
                        f"{signature_file.name} is unreadable: {error}",
                    )
                )
                file_envelope = ""
            if file_envelope and file_envelope != envelope:
                problems.append(
                    (
                        "artifact-signature-mismatch",
                        f"{signature_file.name} disagrees with the signature latest.json "
                        f"announces for {name}",
                    )
                )
        bound[name] = artifact.sha256

    for name in sorted(set(measured) - covered):
        problems.append(
            (
                "artifact-update-artifact-uncovered",
                f"{name} is staged but no latest.json target announces it: the published set is "
                "exactly the signed artifacts",
            )
        )
    return problems, bound


# ---------------------------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------------------------


def _parse_arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Sign a staged Linux candidate set and write its stable latest.json. Refuses without "
            "a signing input; never downloads, installs or publishes anything."
        )
    )
    parser.add_argument("--candidate", default=None,
                        help="staged directory holding the rpm, deb, PKGBUILD and their signatures")
    parser.add_argument("--version", default=None, help="application version, e.g. 1.0.0")
    parser.add_argument("--tag", default=None, help="release tag, e.g. v1.0.0")
    parser.add_argument("--commit", default=None, help="commit the artifacts were built from")
    parser.add_argument("--notes", default=None, help="release notes text")
    parser.add_argument("--notes-file", default=None, help="read release notes from this file")
    parser.add_argument("--contract", default=str(RELEASE_CONTRACT),
                        help="release contract (endpoint and trust root)")
    parser.add_argument("--endpoint", default=None,
                        help="override the announced artifact base URL (default: the contract's)")
    parser.add_argument("--pub-date", default=None, help="ISO-8601 UTC publication timestamp")
    parser.add_argument("--timestamp", type=int, default=None,
                        help="signature trusted-comment timestamp (fixture determinism)")
    parser.add_argument("--from-signatures", action="store_true",
                        help="use the .sig/.minisig files already next to the artifacts")
    parser.add_argument("--legacy-envelope", action="store_true",
                        help="sign with minisign's legacy `Ed` algorithm instead of `Ed`+prehash")
    parser.add_argument("--show-key-id", default=None,
                        help="print the key id of an existing signature file and exit")
    parser.add_argument("--step-summary", default=None,
                        help="append a markdown summary (e.g. $GITHUB_STEP_SUMMARY)")
    arguments = parser.parse_args(argv)
    if not arguments.show_key_id:
        missing = [
            f"--{name}"
            for name in ("candidate", "version", "tag", "commit")
            if not getattr(arguments, name)
        ]
        if missing:
            parser.error("the following arguments are required: " + ", ".join(missing))
    return arguments


def render_step_summary(document: dict) -> str:
    lines = [
        "## Signed release manifest",
        "",
        "| field | value |",
        "| --- | --- |",
        f"| version | `{document.get('version', '')}` |",
        f"| channel | `{document.get('channel', '')}` |",
        f"| tag | `{document.get('tag', '')}` |",
        f"| commit | `{document.get('commit', '')}` |",
        f"| signing key id | `{(document.get('signing') or {}).get('keyId', '')}` |",
        "",
        "| target | artifact | sha256 |",
        "| --- | --- | --- |",
    ]
    for target, entry in sorted((document.get("platforms") or {}).items()):
        name = Path(urlsplit(str(entry.get("url") or "")).path).name
        lines.append(f"| `{target}` | `{name}` | `{entry.get('sha256', '')}` |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    arguments = _parse_arguments(argv)
    if arguments.show_key_id:
        try:
            parsed = minisign.parse_signature(
                Path(arguments.show_key_id).read_text(encoding="utf-8")
            )
        except (OSError, minisign.MinisignError) as error:
            print(f"refusing: signature-key-unreadable: {error}", file=sys.stderr)
            return 3
        print(f"signing key id: {parsed.key_id_text}")
        return 0

    try:
        contract = load_contract(Path(arguments.contract))
        trusted = trusted_key_from_contract(contract)
    except (OSError, json.JSONDecodeError, minisign.MinisignError) as error:
        print(f"refusing: contract-unreadable: {error}", file=sys.stderr)
        return 3
    environment = dict(__import__("os").environ)
    key = None if arguments.from_signatures else signing_key_from_environment(environment)
    if not arguments.from_signatures and key is None:
        print(
            "refusing: signing-input-missing: neither "
            f"{SIGNING_KEY_ENV} nor {SIGNING_KEY_ENVS[1]} is present in the environment, and "
            "--from-signatures was not given: an unsigned release is not a release",
            file=sys.stderr,
        )
        return 3

    notes = arguments.notes
    if arguments.notes_file:
        notes = Path(arguments.notes_file).read_text(encoding="utf-8").strip()
    notes = (notes or "").strip() or default_notes(arguments.version)

    try:
        document = sign_candidate(
            directory=Path(arguments.candidate),
            version=arguments.version,
            tag=arguments.tag,
            commit=arguments.commit,
            notes=notes,
            key=key,
            trusted=trusted,
            endpoint=arguments.endpoint or endpoint_from_contract(contract),
            pub_date=arguments.pub_date,
            timestamp=arguments.timestamp,
            from_signatures=arguments.from_signatures,
            prehashed=not arguments.legacy_envelope,
        )
    except SigningError as error:
        print(f"refusing: {error}", file=sys.stderr)
        return 3

    for target, entry in sorted(document["platforms"].items()):
        print(f"{target}: {Path(urlsplit(entry['url']).path).name} sha256 {entry['sha256']}")
    print(f"signing key id: {document['signing']['keyId']}")
    print(f"wrote {Path(arguments.candidate) / MANIFEST_NAME}")
    if arguments.step_summary:
        with Path(arguments.step_summary).open("a", encoding="utf-8") as summary:
            summary.write(render_step_summary(document))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

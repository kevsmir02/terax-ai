#!/usr/bin/env python3
"""Pre-publication and live-release verification for tagged Codr releases (issue #45).

Delegates manifest, checksum, and signature verification to `release_gate.verify_staged_artifacts`
so CI pre-publication checks and live GitHub Release checks enforce one set of rules.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import minisign  # noqa: E402
import packaging  # noqa: E402
import release_gate  # noqa: E402
import release_signing  # noqa: E402


@dataclass(frozen=True)
class VerificationResult:
    """Structured outcome of a pre-publication or live-release check."""

    problems: tuple[str, ...] = field(default_factory=tuple)
    manifest: dict | None = None

    @property
    def ok(self) -> bool:
        return len(self.problems) == 0


def _read_json(path: Path, label: str) -> tuple[dict | None, str | None]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, f"{label} could not be read: {error}"
    if not isinstance(data, dict):
        return None, f"{label} is not a JSON object"
    return data, None


def verify_gated_candidate(
    *,
    candidate: Path,
    gate_report: Path,
    tag: str,
    commit: str,
    contract_path: Path = release_signing.RELEASE_CONTRACT,
) -> VerificationResult:
    """Verify gate report, checksums, and signatures before creating a GitHub Release."""
    problems: list[str] = []
    report, report_error = _read_json(gate_report, "gate report")
    if report_error:
        return VerificationResult(problems=(report_error,))

    assert report is not None
    if report.get("publishable") is not True:
        problems.append("gate report did not approve publication (publishable != true)")
    if report.get("dryRun") is not False:
        problems.append("gate report was produced in dry-run mode")
    if report.get("stage") != "artifacts":
        problems.append(f"gate report stage is {report.get('stage')!r}, expected 'artifacts'")

    identity = report.get("identity") or {}
    if not isinstance(identity, dict):
        problems.append("gate report identity is not an object")
    else:
        if identity.get("tag") != tag:
            problems.append(f"gate report tag {identity.get('tag')!r} != {tag!r}")
        if identity.get("commit") != commit:
            problems.append(f"gate report commit {identity.get('commit')!r} != {commit!r}")

    contract = release_signing.load_contract(contract_path)
    if contract.get("provisional") is True:
        problems.append("releaseContract.json is still provisional")
    if release_signing.trusted_key_from_contract(contract) is None:
        problems.append("releaseContract.json has no provisioned trust root")

    root = Path(candidate)
    manifest, manifest_error = _read_json(root / release_signing.MANIFEST_NAME, "latest.json")
    if manifest_error:
        problems.append(manifest_error)
        return VerificationResult(problems=tuple(problems))

    assert manifest is not None
    expected_version = tag[1:] if tag.startswith("v") else tag
    if manifest.get("tag") != tag:
        problems.append(f"latest.json tag {manifest.get('tag')!r} != {tag!r}")
    refusals = release_gate.verify_staged_artifacts(
        candidate=root,
        commit=commit,
        version=expected_version,
        contract_path=contract_path,
    )
    problems.extend(f"{r.code}: {r.message}" for r in refusals)
    return VerificationResult(problems=tuple(problems), manifest=manifest)


def render_release_body(
    *,
    candidate: Path,
    manifest: dict,
    contract: dict,
) -> str:
    """Build GitHub Release notes from `latest.json`, staged artifacts, and `releaseContract.json`."""
    product = packaging.candidate().product_name
    version = str(manifest.get("version") or packaging.version())
    tag = str(manifest.get("tag") or f"v{version}")
    commit = str(manifest.get("commit") or "")
    trust = contract.get("trust") or {}
    key_id = str(trust.get("keyId") or (manifest.get("signing") or {}).get("keyId") or "")
    fingerprint = str(trust.get("fingerprint") or "")
    public_key = str(trust.get("publicKey") or "")
    raw_pubkey = "<minisign-pubkey>"
    if public_key:
        try:
            raw_pubkey = minisign.parse_public_key(public_key).file_text().splitlines()[1]
        except minisign.MinisignError:
            raw_pubkey = "<minisign-pubkey>"
    notes = str(manifest.get("notes") or release_signing.default_notes(version, contract)).strip()

    artifacts = release_signing.staged_artifacts(Path(candidate))
    rows = "\n".join(
        f"| `{a.name}` | `{a.kind}` | {a.size} | `{a.sha256}` |" for a in artifacts
    )
    example_name = artifacts[0].name if artifacts else f"{packaging.candidate().slug}_{version}_{packaging.DEB_ARCH}.deb"

    lines = [
        f"## {product} {tag}",
        "",
        notes,
        "",
        f"- Tag: `{tag}`",
        f"- Commit: `{commit}`",
        f"- Minisign key ID: `{key_id}`",
        f"- Key fingerprint: `{fingerprint}`",
        "",
        "## Artifacts (Linux x86-64 only)",
        "",
        "| File | Format | Size (bytes) | SHA-256 |",
        "| --- | --- | ---: | --- |",
        rows,
        "",
        "## Verify signatures before installing",
        "",
        f"{product} never downloads, installs, or restarts itself. Verify the downloaded artifact "
        "against its `.minisig` file before running your package manager:",
        "",
        "```sh",
        "sha256sum -c SHA256SUMS",
        f"minisign -Vm {example_name} -x {example_name}.minisig -P {raw_pubkey}",
        "```",
    ]
    return "\n".join(lines) + "\n"


def _default_fetch(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "codr-release-verify/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def verify_published_release(
    *,
    manifest_url: str,
    expected_tag: str,
    expected_commit: str | None = None,
    contract_path: Path = release_signing.RELEASE_CONTRACT,
    fetch: Callable[[str], bytes] = _default_fetch,
) -> VerificationResult:
    """Fetch a live GitHub Release's assets into a temp dir and run the release gate over them."""
    problems: list[str] = []
    try:
        manifest_raw = fetch(manifest_url)
        manifest = json.loads(manifest_raw.decode("utf-8"))
    except Exception as error:
        return VerificationResult(problems=(f"failed to fetch/parse {manifest_url}: {error}",))

    if not isinstance(manifest, dict):
        return VerificationResult(problems=("latest.json is not a JSON object",))

    expected_version = expected_tag[1:] if expected_tag.startswith("v") else expected_tag
    if manifest.get("tag") != expected_tag:
        problems.append(f"latest.json tag {manifest.get('tag')!r} != {expected_tag!r}")
    commit = str(expected_commit or manifest.get("commit") or "")
    if not commit:
        return VerificationResult(problems=("latest.json has no commit and none was supplied",))

    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict) or release_signing.PRIMARY_TARGET not in platforms:
        problems.append(f"latest.json missing primary target {release_signing.PRIMARY_TARGET!r}")
        return VerificationResult(problems=tuple(problems), manifest=manifest)

    base_url = manifest_url.rsplit("/", 1)[0] + "/"
    with tempfile.TemporaryDirectory(prefix="codr-live-release-") as tmp:
        staged = Path(tmp)
        (staged / release_signing.MANIFEST_NAME).write_bytes(manifest_raw)

        for sibling in ("SHA256SUMS", "manifest.json"):
            try:
                (staged / sibling).write_bytes(fetch(base_url + sibling))
            except Exception as error:
                problems.append(f"failed to fetch {sibling}: {error}")

        for target, entry in sorted(platforms.items()):
            if not isinstance(entry, dict):
                problems.append(f"platform {target!r} entry is not an object")
                continue
            url = str(entry.get("url") or "")
            parsed = urlsplit(url)
            if parsed.scheme != "https":
                problems.append(f"platform {target!r} URL {url!r} is not https")
                continue
            name = Path(parsed.path).name
            if not name:
                problems.append(f"platform {target!r} URL {url!r} has no filename")
                continue
            try:
                payload = fetch(url)
                (staged / name).write_bytes(payload)
                if entry.get("size") is not None and len(payload) != entry.get("size"):
                    problems.append(f"{name}: size {len(payload)} != announced {entry.get('size')}")
            except Exception as error:
                problems.append(f"failed to fetch artifact {url}: {error}")
                continue
            try:
                sig_bytes = fetch(base_url + name + release_signing.SIGNATURE_SUFFIX)
                (staged / (name + release_signing.SIGNATURE_SUFFIX)).write_bytes(sig_bytes)
            except Exception as error:
                problems.append(f"failed to fetch sibling .minisig for {name}: {error}")

        refusals = release_gate.verify_staged_artifacts(
            candidate=staged,
            commit=commit,
            version=expected_version,
            contract_path=contract_path,
        )
        problems.extend(f"{r.code}: {r.message}" for r in refusals)

    return VerificationResult(problems=tuple(problems), manifest=manifest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify gated or live Codr release artifacts.")
    parser.add_argument("--candidate", type=Path, help="Staged linux-packages directory")
    parser.add_argument("--gate-report", type=Path, help="gate-artifacts.json path")
    parser.add_argument("--tag", help="Expected git tag (e.g. v1.0.0)")
    parser.add_argument("--commit", help="Expected git commit SHA")
    parser.add_argument("--notes-out", type=Path, help="Write GitHub Release markdown notes")
    parser.add_argument("--live-url", help="Live latest.json URL to fetch and verify")
    parser.add_argument("--contract", type=Path, default=release_signing.RELEASE_CONTRACT)
    args = parser.parse_args(argv)

    if args.live_url:
        if not args.tag:
            parser.error("--tag is required with --live-url")
        result = verify_published_release(
            manifest_url=args.live_url,
            expected_tag=args.tag,
            expected_commit=args.commit,
            contract_path=args.contract,
        )
    else:
        if not (args.candidate and args.gate_report and args.tag and args.commit):
            parser.error("--candidate, --gate-report, --tag, and --commit are required")
        result = verify_gated_candidate(
            candidate=args.candidate,
            gate_report=args.gate_report,
            tag=args.tag,
            commit=args.commit,
            contract_path=args.contract,
        )
        if result.ok and args.notes_out and result.manifest is not None:
            contract = release_signing.load_contract(args.contract)
            args.notes_out.write_text(
                render_release_body(
                    candidate=args.candidate,
                    manifest=result.manifest,
                    contract=contract,
                ),
                encoding="utf-8",
            )

    if not result.ok:
        for problem in result.problems:
            print(f"release-verify error: {problem}", file=sys.stderr)
        return 1
    print("release-verify: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

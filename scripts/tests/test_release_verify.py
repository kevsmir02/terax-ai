"""Tests for pre-publication and live-release verification (issue #45).

Exercises `scripts/release_verify.py` at its pure boundaries:
1. `verify_gated_candidate` against a staged candidate directory, gate report, and contract;
2. `render_release_body` for truthful GitHub Release notes (attribution, hashes, verification,
   and support/scope limits);
3. `verify_published_release` against a mock HTTPS fetcher serving `latest.json` and signed assets.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import minisign  # noqa: E402
import packaging  # noqa: E402
import release_signing  # noqa: E402
import release_verify  # noqa: E402

COMMIT = "0123456789abcdef0123456789abcdef01234567"
OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98"
VERSION = packaging.version()
TAG = f"v{VERSION}"
CONTRACT_SOURCE = REPO / "src/modules/updater/releaseContract.json"
ENDPOINT = "https://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _setup_fixture(root: Path):
    candidate = root / "linux-packages"
    candidate.mkdir()
    identity = packaging.candidate()
    rpm_name = f"{identity.slug}-{VERSION}-1.{packaging.RPM_ARCH}.rpm"
    deb_name = f"{identity.slug}_{VERSION}_{packaging.DEB_ARCH}.deb"
    arch_name = "PKGBUILD"
    payloads = {
        rpm_name: b"rpm-fixture-payload\n",
        deb_name: b"deb-fixture-payload\n",
        arch_name: b"pkgname=codr\npkgver=" + VERSION.encode("ascii") + b"\n",
    }
    for name, data in payloads.items():
        (candidate / name).write_bytes(data)

    sums_lines = [f"{_sha256(data)}  {name}" for name, data in sorted(payloads.items())]
    (candidate / "SHA256SUMS").write_text("\n".join(sums_lines) + "\n", encoding="utf-8")

    manifest = {
        "schemaVersion": packaging.MANIFEST_SCHEMA_VERSION,
        "revision": {"commit": COMMIT, "dirty": False},
        "package": {
            "productName": identity.product_name,
            "packageName": identity.package_name,
            "version": VERSION,
        },
        "artifacts": [
            {
                "name": name,
                "format": "rpm" if name.endswith(".rpm") else "deb",
                "sha256": _sha256(data),
                "size": len(data),
            }
            for name, data in sorted(payloads.items())
            if name != arch_name
        ],
    }
    (candidate / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    key = minisign.generate_keypair(seed=b"\x07" * 32, key_id=b"\x11\x22\x33\x44\x55\x66\x77\x88")
    trusted = minisign.TrustedKey(key.key_id, key.public_key)
    contract = json.loads(CONTRACT_SOURCE.read_text(encoding="utf-8"))
    contract["provisional"] = False
    contract["endpoints"] = [ENDPOINT]
    contract["trust"] = {
        "provisioned": True,
        "keyId": trusted.key_id_text,
        "fingerprint": trusted.fingerprint,
        "publicKey": trusted.tauri_text(),
        "note": "fixture trust root",
    }
    contract_path = root / "releaseContract.json"
    contract_path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")

    release_signing.sign_candidate(
        directory=candidate,
        version=VERSION,
        tag=TAG,
        commit=COMMIT,
        notes=release_signing.default_notes(VERSION, contract),
        key=key,
        trusted=trusted,
        endpoint="https://github.com/kevsmir02/terax-ai/releases/latest/download/",
        pub_date="2026-11-13T16:00:00Z",
    )

    gate_report = root / "gate-artifacts.json"
    gate_report.write_text(
        json.dumps(
            {
                "publishable": True,
                "refusals": [],
                "dryRun": False,
                "stage": "artifacts",
                "identity": {
                    "tag": TAG,
                    "version": VERSION,
                    "commit": COMMIT,
                    "artifacts": {name: _sha256(data) for name, data in sorted(payloads.items())},
                    "digest": "fixture-digest",
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return candidate, gate_report, contract_path, contract, trusted


class VerifyGatedCandidateTest(unittest.TestCase):
    def test_accepts_publishable_non_dry_run_candidate(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-release-verify-") as tmp:
            candidate, gate_report, contract_path, _, _ = _setup_fixture(Path(tmp))
            result = release_verify.verify_gated_candidate(
                candidate=candidate,
                gate_report=gate_report,
                tag=TAG,
                commit=COMMIT,
                contract_path=contract_path,
            )
            self.assertEqual(result.problems, ())
            self.assertTrue(result.ok)

    def test_refuses_dry_run_or_unpublishable_gate_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-release-verify-") as tmp:
            root = Path(tmp)
            candidate, gate_report, contract_path, _, _ = _setup_fixture(root)

            for mutation in ({"dryRun": True}, {"publishable": False}, {"stage": "preconditions"}):
                data = json.loads(gate_report.read_text(encoding="utf-8"))
                data.update(mutation)
                gate_report.write_text(json.dumps(data), encoding="utf-8")
                result = release_verify.verify_gated_candidate(
                    candidate=candidate,
                    gate_report=gate_report,
                    tag=TAG,
                    commit=COMMIT,
                    contract_path=contract_path,
                )
                self.assertFalse(result.ok, f"expected refusal for {mutation!r}")
                self.assertTrue(result.problems)

    def test_refuses_commit_mismatch_and_tampered_artifact_bytes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-release-verify-") as tmp:
            root = Path(tmp)
            candidate, gate_report, contract_path, _, _ = _setup_fixture(root)

            mismatch = release_verify.verify_gated_candidate(
                candidate=candidate,
                gate_report=gate_report,
                tag=TAG,
                commit=OTHER_COMMIT,
                contract_path=contract_path,
            )
            self.assertFalse(mismatch.ok)

            pkgbuild = candidate / "PKGBUILD"
            pkgbuild.write_bytes(b"pkgname=tampered\n")
            tampered = release_verify.verify_gated_candidate(
                candidate=candidate,
                gate_report=gate_report,
                tag=TAG,
                commit=COMMIT,
                contract_path=contract_path,
            )
            self.assertFalse(tampered.ok)


class RenderReleaseBodyTest(unittest.TestCase):
    def test_renders_truthful_release_notes_without_em_dash(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-release-notes-") as tmp:
            candidate, _, contract_path, contract, trusted = _setup_fixture(Path(tmp))
            manifest = json.loads((candidate / "latest.json").read_text(encoding="utf-8"))
            body = release_verify.render_release_body(
                candidate=candidate,
                manifest=manifest,
                contract=contract,
            )
            self.assertNotIn("\u2014", body)
            self.assertIn("Unofficial fork of Terax; not affiliated with Crynta", body)
            self.assertIn(trusted.key_id_text, body)
            self.assertIn("minisign -Vm", body)
            self.assertIn("Fedora 45 KDE Wayland", body)
            self.assertIn("Debian 13", body)
            self.assertIn("Arch", body)
            self.assertIn("never downloads, installs, or restarts itself", body.lower())


class VerifyPublishedReleaseTest(unittest.TestCase):
    def test_verifies_live_manifest_and_all_signed_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-live-verify-") as tmp:
            candidate, _, contract_path, _, _ = _setup_fixture(Path(tmp))
            base = "https://github.com/kevsmir02/terax-ai/releases/latest/download/"
            served = {base + path.name: path.read_bytes() for path in candidate.iterdir() if path.is_file()}

            def fake_fetch(url: str) -> bytes:
                if url not in served:
                    raise KeyError(f"unexpected URL {url}")
                return served[url]

            result = release_verify.verify_published_release(
                manifest_url=ENDPOINT,
                expected_tag=TAG,
                expected_commit=COMMIT,
                contract_path=contract_path,
                fetch=fake_fetch,
            )
            self.assertTrue(result.ok, result.problems)

    def test_refuses_tampered_remote_artifact_or_mismatched_minisig(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-live-verify-") as tmp:
            candidate, _, contract_path, _, _ = _setup_fixture(Path(tmp))
            base = "https://github.com/kevsmir02/terax-ai/releases/latest/download/"
            served = {base + path.name: path.read_bytes() for path in candidate.iterdir() if path.is_file()}
            served[base + "PKGBUILD"] = b"pkgname=evil\n"

            def fake_fetch(url: str) -> bytes:
                return served[url]

            result = release_verify.verify_published_release(
                manifest_url=ENDPOINT,
                expected_tag=TAG,
                expected_commit=COMMIT,
                contract_path=contract_path,
                fetch=fake_fetch,
            )
            self.assertFalse(result.ok)
            self.assertTrue(any("sha256" in p or "signature" in p for p in result.problems))


if __name__ == "__main__":
    unittest.main()

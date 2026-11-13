"""Guards the boundary between gated candidate artifacts and GitHub Release publication (#45).

Builds fixtures using `packaging.manifest_document` and `packaging.sha256sums` (so `SHA256SUMS`
covers only the RPM and DEB bundles while `PKGBUILD` is signed alongside them) so the tests
mirror the real `scripts/package-candidate/run.py` staging layout.
"""

from __future__ import annotations

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


def _setup_fixture(root: Path):
    candidate = root / "linux-packages"
    candidate.mkdir()
    identity = packaging.candidate()
    artifacts = []
    for fmt, arch in (("rpm", packaging.RPM_ARCH), ("deb", packaging.DEB_ARCH)):
        name = (
            f"{identity.slug}-{VERSION}-1.{arch}.rpm"
            if fmt == "rpm"
            else f"{identity.slug}_{VERSION}_{arch}.deb"
        )
        payload = f"{fmt}-fixture-payload\n".encode("utf-8")
        (candidate / name).write_bytes(payload)
        artifacts.append(
            {
                "format": fmt,
                "arch": arch,
                "fileName": name,
                "path": f"linux-packages/{name}",
                "sizeBytes": len(payload),
                "sha256": packaging.sha256_bytes(payload),
                "packageName": identity.package_name,
                "version": VERSION,
                "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"],
                "files": [{"path": f"/usr/bin/{identity.package_name}", "kind": "binary"}],
                "binaries": [
                    {"path": f"/usr/bin/{identity.package_name}", "kind": "binary"},
                    {"path": f"/usr/bin/{identity.cli_binary_name}", "kind": "cli"},
                ],
                "licenses": [{"path": "/usr/share/doc/LICENSE.txt", "kind": "license"}],
            }
        )

    manifest = packaging.manifest_document(
        revision={
            "commit": COMMIT,
            "branch": "main",
            "describe": TAG,
            "dirty": False,
            "recordedAt": "2026-11-13T16:00:00+00:00",
        },
        host={"system": "Linux", "machine": "x86_64"},
        toolchain={"rustc": "rustc 1.99.1"},
        inputs=[{"path": "package.json", "sha256": packaging.sha256_bytes(b"x"), "sizeBytes": 1}],
        artifacts=artifacts,
        dependencies={"declared": {}, "observedElf": [], "unresolvedOnHost": []},
        validation={"build": {"status": "complete"}},
    )
    (candidate / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    # Real candidate builds list only RPM and DEB in SHA256SUMS, never PKGBUILD.
    (candidate / "SHA256SUMS").write_text(packaging.sha256sums(artifacts), encoding="utf-8")
    (candidate / "PKGBUILD").write_text(
        f"pkgname={identity.package_name}\npkgver={VERSION}\n_commit={COMMIT}\n",
        encoding="utf-8",
    )

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
                    "artifacts": {
                        a["fileName"]: a["sha256"] for a in artifacts
                    },
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
    def test_accepts_publishable_non_dry_run_candidate_without_pkgbuild_in_sha256sums(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-release-verify-") as tmp:
            candidate, gate_report, contract_path, _, _ = _setup_fixture(Path(tmp))
            self.assertNotIn("PKGBUILD", (candidate / "SHA256SUMS").read_text(encoding="utf-8"))
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
    def test_renders_release_notes_from_manifest_and_contract_without_em_dash(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codr-release-notes-") as tmp:
            candidate, _, _, contract, trusted = _setup_fixture(Path(tmp))
            manifest = json.loads((candidate / "latest.json").read_text(encoding="utf-8"))
            body = release_verify.render_release_body(
                candidate=candidate,
                manifest=manifest,
                contract=contract,
            )
            self.assertNotIn("\u2014", body)
            self.assertIn("Unofficial fork of Terax; not affiliated with Crynta", body)
            self.assertIn(trusted.key_id_text, body)
            self.assertIn(trusted.file_text().splitlines()[1], body)
            self.assertIn("minisign -Vm", body)
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
            self.assertTrue(any("signature" in p or "sha256" in p for p in result.problems))


if __name__ == "__main__":
    unittest.main()

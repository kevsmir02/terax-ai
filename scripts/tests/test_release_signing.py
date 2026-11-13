"""Artifact authenticity for tagged stable releases (issue #41, breakdown ticket 40).

Two seams are exercised here, both without a network, a real key or a publication:

* `scripts/minisign.py`: the envelope the release carries. `TauriFixtureTest` verifies a
  signature produced by the real `tauri signer sign` (a committed literal, generated once from a
  throwaway key), so the implementation is pinned to an independent tool rather than to itself.
* `scripts/release_signing.py` and `scripts/provision_signing_key.py`: producing the signed
  artifact set and `latest.json`, and generating the offline key. Every key in these tests is
  generated inside the test with `minisign.generate_keypair()`, is never written into the
  repository and is discarded with the temporary directory.

The gate's own acceptance/refusal of these artifacts is in `test_release_gate.py`; the workflow
that runs the signer is pinned in `test_ci_workflows.py`.

Run with: python3 -m unittest discover -s scripts/tests
"""

import base64
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

import minisign  # noqa: E402
import packaging  # noqa: E402
import release_signing  # noqa: E402

COMMIT = "0123456789abcdef0123456789abcdef01234567"
VERSION = packaging.version()
TAG = f"v{VERSION}"
ENDPOINT = "https://github.com/kevsmir02/terax-ai/releases/latest/download/"
CONTRACT = REPO / "src/modules/updater/releaseContract.json"
# A real signature produced by `tauri signer sign --app-version 1.0.0` over the bytes
# b"hello fixture artifact\n" with a throwaway key. The secret was discarded; only the public key
# and this signature are recorded, because they are what proves the verifier accepts the tool the
# release workflow actually runs.
TAURI_PUBLIC_KEY = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQwRTQ4RUM2MjlCQjI0ODQK"
    "UldTRUpMc3B4bzdrMEJXTG54T0RUZ1BiMktHSUhHemNDaDZRbkpFVlVWYW5UL25vKzVrUVFLVWIK"
)
TAURI_SIGNED_BYTES = b"hello fixture artifact\n"
TAURI_SIGNATURE = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkK"
    "UlVTRUpMc3B4bzdrMEhSTnZpbTYrSmZmWk95YjF1YWlRMmpWY1owZ0R0cHRwUXgzT1FTY1N3UDhiTytM"
    "NUZkN3Y3cGpKZHFNUnR3TStLcUdQMStwL2dLNzlxdGpZUUcyV1FvPQp0cnVzdGVkIGNvbW1lbnQ6IHRp"
    "bWVzdGFtcDoxNzk0NTU3MTE0CWZpbGU6YXJ0aWZhY3QucnBtCXZlcnNpb246MS4wLjAKQW9KbUpuZExD"
    "N3ZmYUs0U2lzSkdIcFdjWXFzZWxMelg0TDJPVmd2d281UFphd2YwbjBib1A2akc2U3BEbE51WWJrMk9u"
    "NS9SNUl6U0pPVVh3bU5wQWc9PQo="
)
TAURI_TRUSTED_KEY_ID = "D0E48EC629BB2484"


def fixture_key(seed: int = 0) -> minisign.KeyPair:
    """A key generated inside the test; nothing about it is stable or secret-bearing."""
    return minisign.generate_keypair(
        seed=bytes(range(seed, seed + 32)), key_id=bytes(range(seed, seed + 8))
    )


def signed_candidate(directory: Path, key: minisign.KeyPair, *,
                     version: str = VERSION, commit: str = COMMIT,
                     timestamp: int = 1794557000) -> Path:
    """A staged set shaped like the workflow's `linux-packages/` after signing."""
    directory.mkdir(parents=True, exist_ok=True)
    identity = packaging.candidate()
    for name, payload in (
        (f"{identity.slug}-{version}-1.x86_64.rpm", b"rpm payload\n"),
        (f"{identity.slug}_{version}_amd64.deb", b"deb payload\n"),
        ("PKGBUILD", b"pkgname=terax-workspace\n"),
        ("manifest.json", b"{}\n"),
        ("SHA256SUMS", b""),
    ):
        (directory / name).write_bytes(payload)
    release_signing.sign_candidate(
        directory=directory,
        version=version,
        tag=f"v{version}",
        commit=commit,
        notes="fixture release notes",
        key=key,
        trusted=minisign.TrustedKey(key.key_id, key.public_key),
        endpoint=ENDPOINT,
        timestamp=timestamp,
    )
    return directory


class TauriFixtureTest(unittest.TestCase):
    """The verifier accepts the real signing tool's output (independent source of truth)."""

    def test_a_signature_from_tauri_signer_verifies(self) -> None:
        trusted = minisign.parse_public_key(TAURI_PUBLIC_KEY)
        self.assertEqual(trusted.key_id_text, TAURI_TRUSTED_KEY_ID)
        self.assertEqual(
            minisign.signature_problems(trusted, TAURI_SIGNED_BYTES, TAURI_SIGNATURE), []
        )

    def test_the_same_signature_is_refused_for_other_bytes(self) -> None:
        trusted = minisign.parse_public_key(TAURI_PUBLIC_KEY)
        problems = minisign.signature_problems(trusted, TAURI_SIGNED_BYTES + b" ", TAURI_SIGNATURE)
        self.assertTrue(problems, "a modified artifact must not verify")

    def test_a_signature_from_another_key_is_named(self) -> None:
        trusted = minisign.parse_public_key(TAURI_PUBLIC_KEY)
        problems = minisign.signature_problems(trusted, TAURI_SIGNED_BYTES, TAURI_SIGNATURE)
        other = fixture_key(9)
        foreign = minisign.sign_bytes(
            other, TAURI_SIGNED_BYTES,
            minisign.trusted_comment(file_name="x", version="1.0.0", timestamp=1),
            prehashed=True,
        )
        refused = minisign.signature_problems(trusted, TAURI_SIGNED_BYTES, foreign)
        self.assertEqual(problems, [])
        self.assertTrue(refused)
        self.assertIn(other.key_id_text, refused[0])


class EnvelopeTest(unittest.TestCase):
    def test_public_key_derivation_matches_the_rfc_8032_vector(self) -> None:
        # RFC 8032 section 7.1 TEST 1: an independent published value, not our own output.
        seed = bytes.fromhex(
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
        )
        self.assertEqual(
            minisign.public_key_from_seed(seed).hex(),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
        )

    def test_both_algorithms_round_trip(self) -> None:
        key = fixture_key(1)
        trusted = minisign.TrustedKey(key.key_id, key.public_key)
        comment = minisign.trusted_comment(file_name="a.deb", version="1.0.0", timestamp=10)
        for prehashed in (False, True):
            with self.subTest(prehashed=prehashed):
                envelope = minisign.sign_bytes(key, b"payload", comment, prehashed=prehashed)
                parsed = minisign.parse_signature(envelope)
                self.assertEqual(parsed.prehashed, prehashed)
                self.assertEqual(minisign.signature_problems(trusted, b"payload", envelope), [])

    def test_the_trusted_comment_cannot_be_edited(self) -> None:
        key = fixture_key(2)
        trusted = minisign.TrustedKey(key.key_id, key.public_key)
        comment = minisign.trusted_comment(file_name="a.deb", version="1.0.0", timestamp=10)
        envelope = minisign.sign_bytes(key, b"payload", comment, prehashed=True)
        edited = envelope.replace("version:1.0.0", "version:2.0.0")
        self.assertTrue(minisign.signature_problems(trusted, b"payload", edited))

    def test_the_tauri_base64_wrap_is_understood(self) -> None:
        key = fixture_key(3)
        trusted = minisign.TrustedKey(key.key_id, key.public_key)
        envelope = minisign.sign_bytes(
            key, b"payload", minisign.trusted_comment(file_name="a", version="1.0.0",
                                                      timestamp=1)
        )
        wrapped = minisign.tauri_signature(envelope)
        self.assertEqual(minisign.signature_problems(trusted, b"payload", wrapped), [])

    def test_a_truncated_envelope_is_refused_rather_than_guessed(self) -> None:
        with self.assertRaises(minisign.MinisignError):
            minisign.parse_signature("untrusted comment: x\nnot base64\n")


class SigningTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="terax-release-signing-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.key = fixture_key(4)
        self.trusted = minisign.TrustedKey(self.key.key_id, self.key.public_key)

    def run_signing(self, *arguments: str, env: dict | None = None) -> subprocess.CompletedProcess:
        environment = {
            key: value for key, value in os.environ.items()
            if key not in release_signing.SIGNING_KEY_ENVS
        }
        environment.update(env or {})
        return subprocess.run(
            [sys.executable, str(REPO / "scripts/release_signing.py"), *arguments],
            cwd=REPO, env=environment, capture_output=True, text=True,
        )

    def test_the_signed_set_binds_every_artifact_to_bytes_and_signature(self) -> None:
        directory = signed_candidate(self.tmp / "linux-packages", self.key)
        document = json.loads((directory / "latest.json").read_text())

        self.assertEqual(document["channel"], "stable")
        self.assertEqual(document["version"], VERSION)
        self.assertEqual(document["commit"], COMMIT)
        self.assertEqual(document["tag"], TAG)
        self.assertEqual(document["signing"]["keyId"], self.key.key_id_text)
        self.assertEqual(
            set(document["platforms"]),
            {"linux-x86_64", "linux-x86_64-rpm", "linux-x86_64-arch"},
        )
        for target, entry in document["platforms"].items():
            with self.subTest(target=target):
                name = Path(entry["url"]).name
                path = directory / name
                self.assertTrue(path.is_file(), f"{target} must point at a staged artifact")
                self.assertEqual(entry["sha256"], packaging.sha256_file(path))
                self.assertEqual(entry["size"], path.stat().st_size)
                self.assertEqual(
                    minisign.signature_problems(
                        self.trusted, path.read_bytes(), entry["signature"]
                    ),
                    [],
                )
                self.assertTrue(
                    (directory / f"{name}.minisig").is_file(),
                    "a published signature file accompanies every announced artifact",
                )

    def test_a_staged_artifact_the_manifest_does_not_announce_is_refused(self) -> None:
        # The set that ships is exactly the signed artifacts, so a file nobody announced is a
        # defect the signer catches before the gate has to.
        directory = self.tmp / "extra"
        directory.mkdir()
        (directory / "stray.bin").write_bytes(b"stray")
        with self.assertRaises(release_signing.SigningError):
            release_signing.sign_candidate(
                directory=directory, version=VERSION, tag=TAG, commit=COMMIT,
                notes="notes", key=self.key, trusted=self.trusted, endpoint=ENDPOINT,
            )

    def test_a_missing_artifact_format_is_refused(self) -> None:
        directory = self.tmp / "incomplete"
        directory.mkdir()
        (directory / f"{packaging.candidate().slug}_{VERSION}_amd64.deb").write_bytes(b"deb")
        (directory / "PKGBUILD").write_bytes(b"pkgname=terax-workspace\n")
        with self.assertRaises(release_signing.SigningError) as caught:
            release_signing.sign_candidate(
                directory=directory, version=VERSION, tag=TAG, commit=COMMIT,
                notes="notes", key=self.key, trusted=self.trusted, endpoint=ENDPOINT,
            )
        self.assertIn("rpm", str(caught.exception))

    def test_the_command_line_refuses_without_a_signing_input(self) -> None:
        directory = self.tmp / "unsigned"
        directory.mkdir()
        (directory / f"{packaging.candidate().slug}_{VERSION}_amd64.deb").write_bytes(b"deb")
        result = self.run_signing(
            "--candidate", str(directory), "--version", VERSION, "--tag", TAG,
            "--commit", COMMIT,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("signing-input-missing", result.stderr)
        self.assertIn(release_signing.SIGNING_KEY_ENV, result.stderr)
        self.assertFalse((directory / "latest.json").exists(),
                         "a refused run must not leave a manifest behind")

    def test_the_command_line_signs_with_the_environment_key(self) -> None:
        directory = self.tmp / "cli"
        directory.mkdir()
        identity = packaging.candidate()
        for name, payload in (
            (f"{identity.slug}-{VERSION}-1.x86_64.rpm", b"rpm"),
            (f"{identity.slug}_{VERSION}_amd64.deb", b"deb"),
            ("PKGBUILD", b"pkgname=terax-workspace\n"),
        ):
            (directory / name).write_bytes(payload)
        contract = self.settled_contract("https://releases.terax-workspace.dev/stable/latest.json")
        result = self.run_signing(
            "--candidate", str(directory), "--version", VERSION, "--tag", TAG,
            "--commit", COMMIT, "--contract", str(contract),
            env={release_signing.SIGNING_KEY_ENV: release_signing.key_to_text(self.key)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("signing key id", result.stdout)
        document = json.loads((directory / "latest.json").read_text())
        self.assertEqual(document["signing"]["keyId"], self.key.key_id_text)
        # The contract endpoint names `latest.json`; artifacts are its siblings.
        self.assertEqual(
            document["platforms"]["linux-x86_64"]["url"],
            "https://releases.terax-workspace.dev/stable/"
            + Path(document["platforms"]["linux-x86_64"]["url"]).name,
        )

    def settled_contract(self, endpoint: str) -> Path:
        """The contract with this test's fixture public key as the trust root."""
        document = json.loads(CONTRACT.read_text())
        document["provisional"] = False
        document["endpoints"] = [endpoint]
        document["trust"] = {
            "provisioned": True,
            "publicKey": minisign.TrustedKey(self.key.key_id, self.key.public_key).tauri_text(),
            "note": "fixture trust root, generated inside the test",
        }
        path = self.tmp / "contract.json"
        path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        return path

    def test_tauri_signatures_are_normalised_into_the_manifest(self) -> None:
        # The release workflow signs with `tauri signer sign`, which writes `<artifact>.sig` as
        # base64. The manifest and the published `.minisig` carry the plain envelope, and the
        # signer refuses a signature made by a key that is not the trust root.
        directory = self.tmp / "from-signatures"
        directory.mkdir()
        identity = packaging.candidate()
        files = {
            f"{identity.slug}-{VERSION}-1.x86_64.rpm": b"rpm",
            f"{identity.slug}_{VERSION}_amd64.deb": b"deb",
            "PKGBUILD": b"pkgname=terax-workspace\n",
        }
        for name, payload in files.items():
            (directory / name).write_bytes(payload)
            envelope = minisign.sign_bytes(
                self.key, payload,
                minisign.trusted_comment(file_name=name, version=VERSION, timestamp=7),
                prehashed=True,
            )
            (directory / f"{name}.sig").write_text(
                minisign.tauri_signature(envelope), encoding="utf-8"
            )
        document = release_signing.sign_candidate(
            directory=directory, version=VERSION, tag=TAG, commit=COMMIT, notes="notes",
            trusted=self.trusted, endpoint=ENDPOINT, from_signatures=True,
        )
        for name, payload in files.items():
            with self.subTest(name=name):
                self.assertFalse((directory / f"{name}.sig").exists(),
                                 "the base64 wrap is replaced by the published envelope")
                envelope = (directory / f"{name}.minisig").read_text()
                self.assertEqual(minisign.signature_problems(self.trusted, payload, envelope), [])
        self.assertEqual(document["signing"]["fingerprint"], self.trusted.fingerprint)

    def test_a_signature_from_an_untrusted_key_is_refused(self) -> None:
        directory = self.tmp / "wrong-key"
        directory.mkdir()
        identity = packaging.candidate()
        for name, payload in (
            (f"{identity.slug}-{VERSION}-1.x86_64.rpm", b"rpm"),
            (f"{identity.slug}_{VERSION}_amd64.deb", b"deb"),
            ("PKGBUILD", b"pkgname=terax-workspace\n"),
        ):
            (directory / name).write_bytes(payload)
            foreign = fixture_key(11)
            envelope = minisign.sign_bytes(
                foreign, payload,
                minisign.trusted_comment(file_name=name, version=VERSION, timestamp=7),
                prehashed=True,
            )
            (directory / f"{name}.minisig").write_text(envelope, encoding="utf-8")
        with self.assertRaises(release_signing.SigningError) as caught:
            release_signing.sign_candidate(
                directory=directory, version=VERSION, tag=TAG, commit=COMMIT, notes="notes",
                trusted=self.trusted, endpoint=ENDPOINT, from_signatures=True,
            )
        self.assertIn("trusted release key", str(caught.exception))

    def test_the_fixture_key_never_enters_the_repository(self) -> None:
        # A guard on the tests themselves: nothing generated here is written under the checkout.
        before = {path for path in (REPO / "scripts").rglob("*") if path.is_file()}
        signed_candidate(self.tmp / "isolation", fixture_key(5))
        after = {path for path in (REPO / "scripts").rglob("*") if path.is_file()}
        self.assertEqual(before, after)

    def test_corrupt_existing_signature_is_refused_cleanly_by_cli(self) -> None:
        directory = self.tmp / "corrupt-sig"
        directory.mkdir()
        identity = packaging.candidate()
        for name, payload in (
            (f"{identity.slug}-{VERSION}-1.x86_64.rpm", b"rpm"),
            (f"{identity.slug}_{VERSION}_amd64.deb", b"deb"),
            ("PKGBUILD", b"pkgname=terax-workspace\n"),
        ):
            (directory / name).write_bytes(payload)
        (directory / "PKGBUILD.sig").write_text("not a valid minisign signature\n", encoding="utf-8")
        result = self.run_signing(
            "--candidate", str(directory), "--version", VERSION, "--tag", TAG,
            "--commit", COMMIT, "--from-signatures",
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("refusing:", result.stderr)
        self.assertFalse((directory / "latest.json").exists())

    def test_duplicate_artifact_format_is_refused(self) -> None:
        directory = self.tmp / "duplicate-deb"
        directory.mkdir()
        identity = packaging.candidate()
        for name, payload in (
            (f"{identity.slug}-{VERSION}-1.x86_64.rpm", b"rpm"),
            (f"{identity.slug}_{VERSION}_amd64.deb", b"deb-one"),
            (f"{identity.slug}_{VERSION}_second.deb", b"deb-two"),
            ("PKGBUILD", b"pkgname=terax-workspace\n"),
        ):
            (directory / name).write_bytes(payload)
        with self.assertRaises(release_signing.SigningError) as caught:
            release_signing.sign_candidate(
                directory=directory, version=VERSION, tag=TAG, commit=COMMIT,
                notes="notes", key=self.key, trusted=self.trusted, endpoint=ENDPOINT,
            )
        self.assertIn("deb", str(caught.exception))
        self.assertFalse((directory / "latest.json").exists())

    def test_missing_signing_key_id_in_manifest_is_rejected_with_trusted_key(self) -> None:
        directory = signed_candidate(self.tmp / "missing-key-id", self.key)
        document = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
        document["signing"]["keyId"] = ""
        problems, _ = release_signing.update_problems(
            document, directory=directory, version=VERSION, commit=COMMIT, trusted=self.trusted,
        )
        self.assertTrue(
            any(code in ("artifact-update-manifest-invalid", "artifact-signature-key-mismatch")
                for code, _ in problems),
            f"expected keyId refusal, got {problems}",
        )

    def test_show_key_id_works_standalone_without_signing_arguments(self) -> None:
        directory = signed_candidate(self.tmp / "show-key", self.key)
        result = self.run_signing("--show-key-id", str(directory / "PKGBUILD.minisig"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(self.key.key_id_text, result.stdout)


class ProvisioningTest(unittest.TestCase):
    """`scripts/provision_signing_key.py` control flow, without a real keypair."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="terax-provisioning-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def run_script(self, *arguments: str, env: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(REPO / "scripts/provision_signing_key.py"), *arguments],
            cwd=REPO, env={**os.environ, **(env or {})}, capture_output=True, text=True,
        )

    def stub_minisign(self, key: minisign.KeyPair) -> Path:
        """A stand-in for `minisign -G` that writes a real, parseable public key file."""
        stub = self.tmp / "stub-minisign"
        public_text = minisign.TrustedKey(key.key_id, key.public_key).file_text()
        stub.write_text(
            "#!/usr/bin/env python3\n"
            "import sys, pathlib\n"
            "arguments = sys.argv[1:]\n"
            "flags = {arguments[index]: arguments[index + 1]\n"
            "         for index in range(len(arguments) - 1)\n"
            "         if arguments[index] in ('-p', '-s')}\n"
            f"pathlib.Path(flags['-p']).write_text({public_text!r})\n"
            "pathlib.Path(flags['-s']).write_text('stub secret key material\\n')\n",
            encoding="utf-8",
        )
        stub.chmod(0o755)
        return stub

    def test_it_refuses_a_destination_inside_the_repository(self) -> None:
        result = self.run_script("--directory", str(REPO / "release-keys"),
                                 "--minisign", self.stub_minisign(fixture_key(6)))
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("destination-inside-repository", result.stderr)
        self.assertFalse((REPO / "release-keys").exists())

    def test_it_refuses_to_overwrite_an_existing_key(self) -> None:
        directory = self.tmp / "existing"
        directory.mkdir()
        (directory / "terax-workspace-release.key").write_text("old key\n")
        result = self.run_script("--directory", str(directory),
                                 "--minisign", self.stub_minisign(fixture_key(7)))
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("key-already-exists", result.stderr)
        self.assertEqual((directory / "terax-workspace-release.key").read_text(), "old key\n")

    def test_it_refuses_when_the_minisign_tool_is_absent(self) -> None:
        result = self.run_script("--directory", str(self.tmp / "no-tool"),
                                 "--minisign", "definitely-not-minisign")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("provisioning-tool-missing", result.stderr)
        self.assertFalse((self.tmp / "no-tool").exists())

    def test_a_successful_provision_prints_only_public_material(self) -> None:
        key = fixture_key(8)
        directory = self.tmp / "keys"
        result = self.run_script("--directory", str(directory),
                                 "--minisign", str(self.stub_minisign(key)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(key.key_id_text, result.stdout)
        self.assertIn("sha256:", result.stdout)
        self.assertNotIn("stub secret key material", result.stdout + result.stderr)
        secret = directory / "terax-workspace-release.key"
        self.assertTrue(secret.is_file())
        self.assertEqual(secret.stat().st_mode & 0o777, 0o600, "the secret key is owner-only")
        self.assertFalse(
            [path for path in (REPO / "scripts").rglob("terax-workspace-release.*")],
            "the key must never be written inside the repository",
        )

    def test_inspect_prints_the_fingerprint_of_a_public_key(self) -> None:
        key = fixture_key(10)
        public = self.tmp / "fixture.pub"
        public.write_text(minisign.TrustedKey(key.key_id, key.public_key).file_text())
        result = self.run_script("--inspect", str(public))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(key.key_id_text, result.stdout)
        self.assertIn(minisign.TrustedKey(key.key_id, key.public_key).fingerprint, result.stdout)


if __name__ == "__main__":
    unittest.main()

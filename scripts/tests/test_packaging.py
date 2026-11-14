"""The Linux package-candidate contract (issue #36).

`python3 -m unittest discover -s scripts/tests`

These are structural guards, not a build: they prove that the candidate path can only emit
x86-64 RPM/DEB from a private identity whose runtime dependencies include WebKitGTK and GTK3,
that the manifest schema carries the evidence a later acceptance ticket needs, and that the deb
reader used to inspect the artifact works without `dpkg`. Artifact production itself is recorded
by `scripts/package-candidate/run.py` and must never be simulated here.
"""

import gzip
import io
import json
import struct
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import packaging  # noqa: E402


def ar_archive(members: list[tuple[str, bytes]]) -> bytes:
    """A minimal System V ar archive (what a .deb is) written by hand."""
    out = bytearray(b"!<arch>\n")
    for name, payload in members:
        header = (
            f"{name:<16}"
            f"{0:<12}"
            f"{0:<6}"
            f"{0:<6}"
            f"{0o100644:<8}"
            f"{len(payload):<10}"
            "`\n"
        ).encode("ascii")
        assert len(header) == 60, len(header)
        out += header + payload
        if len(payload) % 2:
            out += b"\n"
    return bytes(out)


def tar_gz(files: dict[str, bytes], modes: dict[str, int] | None = None) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, payload in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = (modes or {}).get(name, 0o644)
            archive.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def sample_deb() -> bytes:
    control = (
        "Package: codr\n"
        "Version: 1.0.0\n"
        "Architecture: amd64\n"
        "Maintainer: candidate\n"
        "Installed-Size: 1\n"
        "Depends: libwebkit2gtk-4.1-0, libgtk-3-0\n"
        "Description: candidate fixture\n"
    ).encode()
    data = {
        "usr/bin/codr": b"\x7fELF candidate",
        "usr/bin/codr-cli": b"\x7fELF cli",
        "usr/lib/Codr/licenses/terminal/ghostty.txt": b"license\n",
        "usr/share/applications/Codr.desktop": b"[Desktop Entry]\n",
    }
    return ar_archive(
        [
            ("debian-binary", b"2.0\n"),
            ("control.tar.gz", tar_gz({"control": control})),
            ("data.tar.gz", tar_gz(data, {"usr/bin/codr": 0o755})),
        ]
    )


def fake_artifact(fmt: str) -> dict:
    identity = packaging.candidate()
    return {
        "format": fmt,
        "arch": "x86_64" if fmt == "rpm" else "amd64",
        "fileName": f"candidate.{fmt}",
        "path": f"dist-packages/candidate.{fmt}",
        "sizeBytes": 1024,
        "sha256": "0" * 64,
        "packageName": identity.package_name,
        "version": "0.9.0",
        "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"],
        "files": [],
        "binaries": [
            {"path": f"/usr/bin/{identity.package_name}", "kind": "binary"},
            {"path": f"/usr/bin/{identity.cli_binary_name}", "kind": "cli"},
        ],
        "licenses": [{"path": "/usr/lib/x/licenses/a.txt", "kind": "license"}],
    }


def sample_manifest() -> dict:
    return packaging.manifest_document(
        revision={"commit": "0" * 40, "branch": "ticket/35-packages", "dirty": False},
        host={"system": "Linux", "machine": "x86_64"},
        toolchain={"rpm": "RPM version 6"},
        inputs=[{"path": "src-tauri/tauri.conf.json", "sha256": "1" * 64}],
        artifacts=[fake_artifact("rpm"), fake_artifact("deb")],
        dependencies={"declared": {}},
        validation={"build": {"status": "complete"}},
    )


class CandidateIdentityTest(unittest.TestCase):
    def test_the_candidate_identity_is_private_and_not_upstream(self) -> None:
        self.assertEqual(packaging.identity_problems(), [])
        identity = packaging.candidate()
        upstream = packaging.identity_table()["upstream"]
        self.assertNotEqual(identity.product_name.lower(), upstream["productName"].lower())
        self.assertNotEqual(identity.vendor.lower(), upstream["publisher"].lower())
        self.assertNotEqual(identity.package_name, upstream["namespace"])
        self.assertNotEqual(identity.cli_binary_name, f"{upstream['namespace']}-cli")
        self.assertEqual(identity.app_identifier, packaging.identity_table()["appIdentifier"])

    def test_the_derived_linux_package_name_matches_the_bundler(self) -> None:
        self.assertEqual(packaging.package_name_problems(), [])
        # A product name whose kebab form is not the declared package name is refused.
        identity = packaging.candidate()
        mismatched = packaging.Candidate(
            product_name=identity.product_name + " Dev",
            vendor=identity.vendor,
            package_name=identity.package_name,
            cli_binary_name=identity.cli_binary_name,
            short_description=identity.short_description,
            long_description=identity.long_description,
            app_identifier=identity.app_identifier,
            namespace=identity.namespace,
            version=identity.version,
        )
        self.assertTrue(packaging.package_name_problems(mismatched))

    def test_the_version_is_one_value_in_every_input(self) -> None:
        version = packaging.version()
        self.assertEqual(version, "1.0.0")
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        self.assertEqual(json.loads(packaging.TAURI_CONFIG.read_text())["version"], version)
        self.assertEqual(json.loads(packaging.PACKAGE_JSON.read_text())["version"], version)
        cargo = tomllib.loads(packaging.CARGO_MANIFEST.read_text())
        self.assertEqual(cargo["package"]["version"], version)
        self.assertEqual(cargo["workspace"]["package"]["version"], version)


class TargetTest(unittest.TestCase):
    def test_only_x86_64_rpm_and_deb_are_configured(self) -> None:
        self.assertEqual(packaging.config_problems(), [])
        bundle = packaging.merged_bundle_config()
        self.assertEqual(sorted(bundle["targets"]), ["deb", "rpm"])
        self.assertIs(bundle["createUpdaterArtifacts"], False)
        self.assertEqual(
            bundle["externalBin"],
            [f"binaries/{packaging.candidate().cli_binary_name}"],
        )

    def test_a_broader_target_set_is_refused(self) -> None:
        base = json.loads(packaging.TAURI_CONFIG.read_text())
        base["bundle"]["targets"] = "all"
        problems = packaging.config_problems(base=base)
        self.assertTrue(any("bundle.targets" in problem for problem in problems))
        base["bundle"]["targets"] = ["rpm", "deb", "appimage"]
        self.assertTrue(
            any("appimage" in problem for problem in packaging.config_problems(base=base))
        )

    def test_the_overlay_may_not_repeat_bundle_arrays(self) -> None:
        # Tauri's config merge concatenates arrays (it duplicated `depends` once), so the
        # overlay must leave targets/dependencies to the base config only.
        overlay = packaging.candidate_config()
        overlay["bundle"]["targets"] = ["rpm", "deb"]
        overlay["bundle"]["linux"] = {"deb": {"depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"]}}
        problems = packaging.config_problems(overlay=overlay)
        self.assertTrue(any("repeat bundle.targets" in p for p in problems), problems)
        self.assertTrue(any("bundle.linux.depends" in p for p in problems), problems)

    def test_other_host_architectures_are_refused(self) -> None:
        self.assertEqual(packaging.target_problems("Linux", "x86_64"), [])
        self.assertTrue(packaging.target_problems("Linux", "aarch64"))
        self.assertTrue(packaging.target_problems("Darwin", "arm64"))
        self.assertTrue(packaging.target_problems("Windows", "AMD64"))

    def test_the_explicit_bundle_target_is_x86_64_linux(self) -> None:
        self.assertEqual(packaging.TARGET_TRIPLE, "x86_64-unknown-linux-gnu")
        self.assertEqual(packaging.DEB_ARCH, "amd64")
        self.assertEqual(packaging.RPM_ARCH, "x86_64")


class DependencyTest(unittest.TestCase):
    def test_the_candidate_follows_the_fork_release_contract(self) -> None:
        contract = json.loads(packaging.RELEASE_CONTRACT.read_text())
        settings = packaging.updater_settings()
        self.assertFalse(contract["provisional"])
        self.assertEqual(settings["endpoints"], contract["endpoints"])
        self.assertEqual(settings["pubkey"], contract["trust"]["publicKey"])
        self.assertTrue(settings["pubkey"])
        self.assertEqual(packaging.updater_problems(), [])
        for endpoint in contract["endpoints"]:
            self.assertTrue(endpoint.startswith("https://"))
            self.assertNotIn(".invalid", endpoint)

    def test_an_upstream_endpoint_or_key_is_refused(self) -> None:
        base = json.loads(packaging.TAURI_CONFIG.read_text())
        contract = json.loads(packaging.RELEASE_CONTRACT.read_text())
        base["plugins"]["updater"]["endpoints"] = contract["upstream"]["endpoints"]
        base["plugins"]["updater"]["pubkey"] = "upstream-minisign-key"
        problems = packaging.updater_problems(base=base)
        self.assertTrue(any("upstream" in problem for problem in problems), problems)
        self.assertTrue(any("pubkey" in problem for problem in problems), problems)

    def test_deb_and_rpm_require_the_webkit_and_gtk_runtime(self) -> None:
        deb = packaging.deb_depends()
        rpm = packaging.rpm_depends()
        self.assertEqual(deb, ["libwebkit2gtk-4.1-0", "libgtk-3-0"])
        for label, depends in (("deb", deb), ("rpm", rpm)):
            self.assertTrue(
                any(packaging.WEBKIT_GTK.search(dep) for dep in depends), label
            )
            self.assertTrue(any(packaging.GTK.search(dep) for dep in depends), label)
            self.assertEqual(len(depends), len(set(depends)), label)

    def test_the_injected_runtime_is_required_even_without_config_names(self) -> None:
        # Tauri CLI always appends the deb packages and rpm sonames, so an empty configured
        # list still yields WebKitGTK/GTK requirements rather than a silently bare package.
        base = json.loads(packaging.TAURI_CONFIG.read_text())
        base["bundle"]["linux"]["deb"].pop("depends", None)
        base["bundle"]["linux"]["rpm"].pop("depends", None)
        self.assertEqual(packaging.config_problems(base=base), [])
        self.assertTrue(any("webkit2gtk" in dep for dep in packaging.deb_depends(base)))
        self.assertTrue(any("libgtk-3" in dep for dep in packaging.deb_depends(base)))

    def test_repeating_a_tauri_injected_dependency_is_refused(self) -> None:
        base = json.loads(packaging.TAURI_CONFIG.read_text())
        base["bundle"]["linux"]["deb"]["depends"] = ["libwebkit2gtk-4.1-0"]
        problems = packaging.config_problems(base=base)
        self.assertTrue(any("repeats a dependency" in problem for problem in problems), problems)

    def test_the_arch_recipe_requires_the_same_runtime(self) -> None:
        self.assertEqual(packaging.arch_problems(), [])
        recipe = packaging.PKGBUILD.read_text()
        for dependency in packaging.ARCH_DEPENDS:
            self.assertIn(dependency, recipe)


class ManifestTest(unittest.TestCase):
    def test_a_candidate_manifest_has_every_required_field(self) -> None:
        document = sample_manifest()
        self.assertEqual(packaging.manifest_problems(document), [])
        self.assertEqual(document["schemaVersion"], packaging.MANIFEST_SCHEMA_VERSION)
        self.assertEqual(document["kind"], packaging.MANIFEST_KIND)

    def test_a_manifest_without_evidence_is_refused(self) -> None:
        for field in ("artifacts", "notValidated", "knownGaps", "candidate"):
            document = sample_manifest()
            del document[field]
            self.assertTrue(
                any(field in problem for problem in packaging.manifest_problems(document)),
                field,
            )

    def test_an_artifact_without_a_hash_or_licence_is_refused(self) -> None:
        document = sample_manifest()
        document["artifacts"][0]["sha256"] = ""
        document["artifacts"][1]["licenses"] = []
        problems = packaging.manifest_problems(document)
        self.assertTrue(any("sha256" in problem for problem in problems), problems)
        self.assertTrue(any("licence" in problem for problem in problems), problems)

    def test_an_upstream_identity_is_refused_in_a_manifest(self) -> None:
        document = sample_manifest()
        document["candidate"]["appIdentifier"] = packaging.identity_table()["upstream"][
            "appIdentifier"
        ]
        problems = packaging.manifest_problems(document)
        self.assertTrue(any("upstream" in problem for problem in problems), problems)

    def test_only_x86_64_artifacts_are_accepted(self) -> None:
        document = sample_manifest()
        document["artifacts"][0]["arch"] = "aarch64"
        problems = packaging.manifest_problems(document)
        self.assertTrue(any("x86-64" in problem for problem in problems), problems)

    def test_a_build_without_the_overlay_is_refused(self) -> None:
        """The package must install the candidate binaries, not the base config's `terax`."""
        document = sample_manifest()
        upstream = packaging.identity_table()["upstream"]
        for artifact in document["artifacts"]:
            artifact["binaries"] = [{"path": f"/usr/bin/{upstream['namespace']}", "kind": "binary"}]
        problems = packaging.manifest_problems(document)
        self.assertTrue(
            any("candidate binary" in problem for problem in problems),
            problems,
        )

    def test_an_artifact_installing_an_upstream_path_is_refused(self) -> None:
        document = sample_manifest()
        upstream = packaging.identity_table()["upstream"]
        for artifact in document["artifacts"]:
            artifact["binaries"].append(
                {"path": f"/usr/bin/{upstream['namespace']}-cli", "kind": "cli"}
            )
        problems = packaging.manifest_problems(document)
        self.assertTrue(any("upstream" in problem for problem in problems), problems)

    def test_a_built_candidate_manifest_is_consistent(self) -> None:
        """When the runner has produced candidates, their own manifest must satisfy the schema."""
        manifests = sorted(packaging.OUTPUT_ROOT.glob("*/manifest.json"))
        if not manifests:
            self.skipTest("no candidate has been built in this checkout")
        for manifest in manifests:
            document = json.loads(manifest.read_text())
            if document.get("validation", {}).get("build", {}).get("status") != "complete":
                continue
            with self.subTest(manifest=str(manifest)):
                self.assertEqual(packaging.manifest_problems(document), [])
                for artifact in document["artifacts"]:
                    path = packaging.REPO_ROOT / artifact["path"]
                    self.assertTrue(path.is_file(), artifact["path"])
                    self.assertEqual(packaging.sha256_file(path), artifact["sha256"])
                    self.assertEqual(path.stat().st_size, artifact["sizeBytes"])


class DebReaderTest(unittest.TestCase):
    """The inspection path must work on a host without dpkg."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="terax-package-deb-")
        self.root = Path(self._tmp.name)
        self.deb = self.root / "candidate_0.9.0_amd64.deb"
        self.deb.write_bytes(sample_deb())

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_control_fields_are_read_from_the_archive(self) -> None:
        control = packaging.deb_control(self.deb)
        self.assertEqual(control["Package"], "codr")
        self.assertEqual(control["Architecture"], "amd64")
        self.assertEqual(control["Depends"], "libwebkit2gtk-4.1-0, libgtk-3-0")

    def test_contents_are_enumerated_with_modes_and_roles(self) -> None:
        files = packaging.extract_deb(self.deb, self.root / "data")
        paths = {entry["path"]: entry for entry in files}
        self.assertEqual(paths["/usr/bin/codr"]["kind"], "binary")
        self.assertEqual(paths["/usr/bin/codr"]["mode"], "0o755")
        self.assertEqual(paths["/usr/bin/codr-cli"]["kind"], "cli")
        self.assertEqual(
            paths["/usr/lib/Codr/licenses/terminal/ghostty.txt"]["kind"], "license"
        )
        self.assertEqual(paths["/usr/share/applications/Codr.desktop"]["kind"], "desktop")

    def test_a_non_archive_is_refused(self) -> None:
        bad = self.root / "bad.deb"
        bad.write_bytes(b"not an archive")
        with self.assertRaises(ValueError):
            packaging.ar_members(bad)


class BundleTypeMarkerTest(unittest.TestCase):
    """The only allowed deb/rpm payload difference is the main binary's bundle-type marker."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="terax-package-marker-")
        self.root = Path(self._tmp.name)
        prefix = b"\x7fELF" + b"\x00" * 16 + b"TAURI_BUNDLE_TYPE_VAR_"
        self.deb = self.root / "deb.bin"
        self.rpm = self.root / "rpm.bin"
        self.deb.write_bytes(prefix + b"DEB" + b"\x01" * 64)
        self.rpm.write_bytes(prefix + b"RPM" + b"\x01" * 64)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_the_bundle_type_marker_is_accepted(self) -> None:
        self.assertTrue(packaging.bundle_type_marker_difference(self.deb, self.rpm))

    def test_any_other_byte_difference_is_refused(self) -> None:
        payload = bytearray(self.rpm.read_bytes())
        payload[10] ^= 0xFF
        self.rpm.write_bytes(bytes(payload))
        self.assertFalse(packaging.bundle_type_marker_difference(self.deb, self.rpm))

    def test_a_length_difference_is_refused(self) -> None:
        self.rpm.write_bytes(self.rpm.read_bytes() + b"\x00")
        self.assertFalse(packaging.bundle_type_marker_difference(self.deb, self.rpm))


class RpmDumpTest(unittest.TestCase):
    """`rpm -qlp --dump` parses binary, resource, and license entries."""
    def setUp(self) -> None:
        self.lines = [
            "/usr/bin/codr 14816432 1794460064 "
            "2d23cca23316ec63df95abe2af21dfa96aeceecb3b3d7b998cc40c1fb64fa78b "
            "0100755 root root 0 0 0 X",
            "/usr/lib/Codr 0 1794460064 "
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 "
            "040755 root root 0 0 0 X",
            "/usr/lib/Codr/licenses/terminal/ghostty.txt 1062 1794458330 "
            "5eccd0eeca906db6d661b64dd05e1d4a4b2e49d37d43bbcfd2c8cce4d7832920 "
            "0100644 root root 0 0 0 X",
        ]

    def test_a_directory_is_skipped_and_a_license_path_is_kept(self) -> None:
        files = packaging.parse_rpm_dump(self.lines)
        self.assertEqual(
            [entry["path"] for entry in files],
            [
                "/usr/bin/codr",
                "/usr/lib/Codr/licenses/terminal/ghostty.txt",
            ],
        )
        self.assertEqual(files[0]["mode"], "0755")
        self.assertEqual(files[0]["kind"], "binary")
        self.assertEqual(files[1]["kind"], "license")


class RpmPayloadExtractionTest(unittest.TestCase):
    """Verify the fallback RPM payload reader and cpio handoff when rpm2cpio returns non-zero."""

    @staticmethod
    def _synthetic_rpm(payload: bytes) -> bytes:
        lead = bytearray(96)
        lead[:4] = b"\xed\xab\xee\xdb"
        sig_header = b"\x8e\xad\xe8\x01" + b"\x00\x00\x00\x00" + struct.pack(">II", 0, 1) + b"\xaa"
        # Pad signature header to an 8-byte boundary (17 bytes -> 24 bytes).
        sig_padded = sig_header + b"\x00" * ((8 - len(sig_header) % 8) % 8)
        main_header = b"\x8e\xad\xe8\x01" + b"\x00\x00\x00\x00" + struct.pack(">II", 0, 2) + b"\xbb\xcc"
        return bytes(lead) + sig_padded + main_header + gzip.compress(payload)

    def test_rpm_cpio_payload_reads_gzip_payload_after_digest_check(self) -> None:
        raw_cpio = b"070701" + b"synthetic-cpio-stream"
        with tempfile.TemporaryDirectory() as tmp:
            rpm_path = Path(tmp) / "codr.rpm"
            rpm_path.write_bytes(self._synthetic_rpm(raw_cpio))
            with (
                mock.patch("packaging._run", return_value=b"") as run_mock,
                mock.patch("packaging.rpm_query", return_value="gzip\n") as query_mock,
            ):
                extracted = packaging.rpm_cpio_payload(rpm_path)
        self.assertEqual(extracted, raw_cpio)
        run_mock.assert_called_once_with(["rpm", "-K", "--nosignature", str(rpm_path)])
        query_mock.assert_called_once_with(rpm_path, "-qp", "--queryformat", "%{PAYLOADCOMPRESSOR}")

    def test_extract_rpm_falls_back_when_rpm2cpio_fails(self) -> None:
        raw_cpio = b"fallback-cpio"
        with tempfile.TemporaryDirectory() as tmp:
            rpm_path = Path(tmp) / "codr.rpm"
            rpm_path.write_bytes(b"placeholder")
            dest = Path(tmp) / "out"
            failed = subprocess.CompletedProcess(["rpm2cpio", str(rpm_path)], 1, b"", b"")
            ok_cpio = subprocess.CompletedProcess(["cpio"], 0, b"", b"")
            with (
                mock.patch("packaging.subprocess.run", side_effect=[failed, ok_cpio]) as sub_mock,
                mock.patch("packaging.rpm_cpio_payload", return_value=raw_cpio) as payload_mock,
                mock.patch("packaging.describe_tree", return_value=[{"path": "/usr/bin/codr"}]),
            ):
                entries = packaging.extract_rpm(rpm_path, dest)
        self.assertEqual(entries, [{"path": "/usr/bin/codr"}])
        payload_mock.assert_called_once_with(rpm_path)
        self.assertEqual(sub_mock.call_count, 2)
        self.assertEqual(sub_mock.call_args_list[1].kwargs["input"], raw_cpio)

    def test_rpm_cpio_payload_rejects_bad_magic(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.rpm"
            bad.write_bytes(b"not-an-rpm" * 12)
            with mock.patch("packaging._run", return_value=b""):
                with self.assertRaises(ValueError):
                    packaging.rpm_cpio_payload(bad)


class ArchRecipeTest(unittest.TestCase):
    def test_the_recipe_is_aligned_and_flagged_as_unbuilt(self) -> None:
        self.assertEqual(packaging.arch_problems(), [])
        recipe = packaging.PKGBUILD.read_text()
        self.assertIn("pkgname=codr", recipe)
        self.assertIn("pkgver=1.0.0", recipe)
        self.assertIn("arch=('x86_64')", recipe)
        self.assertIn("NOT BUILT", recipe)
        # No upstream package/binary identity in the recipe.
        self.assertNotIn("usr/bin/terax\n", recipe)
        self.assertNotIn("pkgname=terax\n", recipe)


if __name__ == "__main__":
    unittest.main()

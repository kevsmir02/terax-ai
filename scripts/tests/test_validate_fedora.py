"""Unit tests for the Fedora 45 RPM validation core (issue #44)."""

import importlib.util
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MODULE_PATH = REPO_ROOT / "scripts" / "package-candidate" / "validate_fedora.py"


def load_module():
    spec = importlib.util.spec_from_file_location("validate_fedora", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["validate_fedora"] = module
    spec.loader.exec_module(module)
    return module


MOD = load_module()


class RpmRequiresResolutionTest(unittest.TestCase):
    def test_satisfies_host_packages_and_rpmlib_and_flags_missing(self) -> None:
        resolved = MOD.parse_rpm_requires_resolution(
            [
                ("webkit2gtk4.1", "webkit2gtk4.1-2.54.2-1.fc45.x86_64"),
                ("gtk3", "gtk3-3.24.52-6.fc45.x86_64"),
                (
                    "rpmlib(CompressedFileNames) = 3.0.4-1",
                    "no package provides rpmlib(CompressedFileNames) = 3.0.4-1",
                ),
            ]
        )
        self.assertTrue(resolved["ok"])
        self.assertEqual(
            resolved["satisfied"],
            [
                {
                    "requirement": "webkit2gtk4.1",
                    "provider": "webkit2gtk4.1-2.54.2-1.fc45.x86_64",
                },
                {
                    "requirement": "gtk3",
                    "provider": "gtk3-3.24.52-6.fc45.x86_64",
                },
            ],
        )
        self.assertEqual(resolved["rpmlib"], ["rpmlib(CompressedFileNames) = 3.0.4-1"])
        self.assertEqual(resolved["missing"], [])

    def test_reports_missing_non_rpmlib_dependency(self) -> None:
        resolved = MOD.parse_rpm_requires_resolution(
            [("libmissing.so.1()(64bit)", "no package provides libmissing.so.1()(64bit)")]
        )
        self.assertFalse(resolved["ok"])
        self.assertEqual(resolved["missing"], ["libmissing.so.1()(64bit)"])


class PackagePathDisjointnessTest(unittest.TestCase):
    def test_detects_disjoint_codr_and_terax_paths(self) -> None:
        result = MOD.check_package_path_disjointness(
            ["/usr/bin/codr", "/usr/bin/codr-cli", "/usr/share/applications/Codr.desktop"],
            ["/usr/bin/terax", "/usr/bin/terax-cli", "/usr/share/applications/Terax.desktop"],
        )
        self.assertTrue(result["disjoint"])
        self.assertEqual(result["overlappingPaths"], [])
        self.assertEqual(result["candidateCount"], 3)
        self.assertEqual(result["upstreamCount"], 3)

    def test_reports_overlapping_paths(self) -> None:
        result = MOD.check_package_path_disjointness(
            ["/usr/bin/codr", "/usr/bin/terax-cli"],
            ["/usr/bin/terax", "/usr/bin/terax-cli"],
        )
        self.assertFalse(result["disjoint"])
        self.assertEqual(result["overlappingPaths"], ["/usr/bin/terax-cli"])


class RpmSignatureCheckTest(unittest.TestCase):
    def test_parses_unsigned_rpm_with_valid_digests(self) -> None:
        parsed = MOD.parse_rpm_signature_check(
            "/tmp/codr-1.0.0-1.x86_64.rpm: digests SIGNATURES NOT OK"
        )
        self.assertTrue(parsed["digestsOk"])
        self.assertFalse(parsed["signed"])

    def test_parses_signed_rpm_with_valid_digests(self) -> None:
        parsed = MOD.parse_rpm_signature_check(
            "/tmp/codr-1.0.0-1.x86_64.rpm: digests signatures OK"
        )
        self.assertTrue(parsed["digestsOk"])
        self.assertTrue(parsed["signed"])


class CliProbeEvaluationTest(unittest.TestCase):
    def test_all_probes_pass_when_exit_zero_and_json_ok(self) -> None:
        # `codr-cli --version` emits the Cargo package string (`terax 1.0.0`) by design.
        result = MOD.evaluate_cli_probes(
            [
                {"args": ["--version"], "exitCode": 0, "stdout": "terax 1.0.0\n", "stderr": ""},
                {
                    "args": ["ping", "--json"],
                    "exitCode": 0,
                    "stdout": '{"ok":true,"result":{"pong":true}}',
                    "stderr": "",
                },
            ]
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["failures"], [])

    def test_flags_nonzero_or_json_error(self) -> None:
        result = MOD.evaluate_cli_probes(
            [
                {
                    "args": ["identify", "--json"],
                    "exitCode": 5,
                    "stdout": "",
                    "stderr": '{"ok":false,"error":{"code":"frontend_not_ready"}}',
                }
            ]
        )
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["failures"]), 1)


if __name__ == "__main__":
    unittest.main()

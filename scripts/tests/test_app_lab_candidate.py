"""Contract tests for the combined `candidate` app-lab scenario (issue #42)."""

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
APP_LAB_RUN = REPO_ROOT / "scripts/app-lab/run.py"


def load_run_module():
    spec = importlib.util.spec_from_file_location("app_lab_run_candidate", APP_LAB_RUN)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CandidateScenarioContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app_lab = load_run_module()

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="terax-candidate-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_candidate_is_a_supported_linux_scenario(self) -> None:
        self.assertIn("candidate", self.app_lab.LINUX_SCENARIOS)

    def test_prepare_candidate_fixture_creates_repo_with_bare_remote_and_multi_hunk_diff(
        self,
    ) -> None:
        fixture = self.app_lab.prepare_candidate_fixture(self.tmp)
        repo = Path(fixture["repo"])
        remote = Path(fixture["remote"])
        self.assertTrue((repo / ".git").exists())
        self.assertTrue((remote / "HEAD").exists())
        self.assertTrue(Path(fixture["notesMd"]).is_file())
        self.assertTrue(Path(fixture["csvFile"]).is_file())
        self.assertTrue(Path(fixture["tsvFile"]).is_file())
        self.assertTrue(Path(fixture["multiFile"]).is_file())

        diff = subprocess.run(
            ["git", "diff", "-U1", "multi.txt"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        hunk_headers = [line for line in diff.splitlines() if line.startswith("@@ ")]
        self.assertGreaterEqual(len(hunk_headers), 2)

        origin_url = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=repo,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(origin_url, str(remote))


if __name__ == "__main__":
    unittest.main()

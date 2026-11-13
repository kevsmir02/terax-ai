"""The isolation block a Linux startup/measured report must carry cannot be silently missing.

Run with: python3 -m unittest discover -s scripts/tests
"""

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "app-lab"))

import isolation_report  # noqa: E402
import linux_profile  # noqa: E402
import namespace_sentinels  # noqa: E402

LAB = f"{linux_profile.PRODUCT_IDENTIFIER}.app-lab-unittest"


class IsolationBlockTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="terax-isolation-report-")
        self.root = Path(self._tmp.name) / "run"
        self.root.mkdir()
        self.home = self.root / "home"
        linux_profile.prepare(self.home, self.root)
        self.env = {**linux_profile.profile_env(self.home), "TERAX_BENCH_ISOLATED": "1"}
        self.sentinels = namespace_sentinels.seed(self.home)
        # What a real launch leaves behind: the fork's own identifier-keyed data dir and the
        # published control descriptor (never the upstream ones).
        (self.home / ".local/share" / LAB).mkdir(parents=True)
        cache = self.home / ".cache" / namespace_sentinels.FORK_NS
        cache.mkdir(parents=True, exist_ok=True)
        (cache / "control.json").write_text('{"pid": 4242}\n')

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def finished_block(self) -> dict:
        block = isolation_report.block(LAB, self.env, self.home, self.sentinels, self.root)
        changes = isolation_report.finish(block, self.home, self.sentinels)
        self.assertEqual(changes, [])
        return block

    def test_a_startup_report_with_the_full_block_is_accepted(self) -> None:
        report = {
            "config": {"scenario": "startup"},
            "startup": [{"kind": "cold", "exec_to_boot_ms": 4200}],
            "isolation": self.finished_block(),
        }
        self.assertEqual(isolation_report.problems(report, self.root), [])

    def test_a_startup_report_without_the_isolation_block_is_rejected(self) -> None:
        report = {
            "config": {"scenario": "startup"},
            "startup": [{"kind": "cold", "exec_to_boot_ms": 4200}],
            "samples": [],
        }
        found = isolation_report.problems(report, self.root)
        self.assertTrue(found, "a startup report without isolation must be rejected")
        self.assertIn("isolation block is missing", found[0])

    def test_an_empty_or_defaulted_block_is_rejected(self) -> None:
        for block in ({}, {"benchIsolated": "1"}, {"identifier": LAB, "profile": {}}):
            found = isolation_report.problems({"isolation": block}, self.root)
            self.assertTrue(found, f"block {block!r} must be rejected")

    def test_the_block_is_produced_by_the_preflight_not_defaulted(self) -> None:
        unsafe = dict(self.env)
        unsafe.pop("TERAX_BENCH_ISOLATED")
        with self.assertRaises(ValueError):
            isolation_report.block(LAB, unsafe, self.home, self.sentinels, self.root)
        with self.assertRaises(ValueError):
            isolation_report.block(
                linux_profile.PRODUCT_IDENTIFIER, self.env, self.home, self.sentinels, self.root
            )
        with self.assertRaises(ValueError):
            isolation_report.block(
                LAB,
                {**self.env, "XDG_CACHE_HOME": str(linux_profile.real_cache_dir())},
                self.home,
                self.sentinels,
                self.root,
            )

    def test_the_recorded_profile_is_the_launch_environment(self) -> None:
        block = self.finished_block()
        self.assertEqual(block["profile"], {name: self.env[name] for name in linux_profile.PROFILE_ENV})
        self.assertEqual(block["benchIsolated"], "1")
        self.assertTrue(block["profileVerified"])
        self.assertEqual(block["preflightProblems"], [])
        self.assertGreaterEqual(block["upstreamSentinels"]["files"], 1)
        self.assertTrue(block["controlDescriptorPublished"])
        self.assertTrue(block["forkRuntimeDirIsNotUpstream"])
        self.assertTrue(block["forkDataDirIsIdentifierKeyed"])
        self.assertTrue(block["forkDataDirIsNotUpstream"])
        self.assertEqual(block["fork"]["descriptorPid"], 4242)

    def test_a_changed_upstream_sentinel_is_recorded_not_suppressed(self) -> None:
        # A violation is a finding about the measured revision: it must stay in the report with
        # reasons, and the run fails on it (run.py returns 3), but the evidence is not deleted.
        block = self.finished_block()
        (self.home / ".cache" / linux_profile.UPSTREAM_NAMESPACE / "control.json").write_text("{}\n")
        changes = isolation_report.finish(block, self.home, self.sentinels)
        self.assertTrue(changes)
        self.assertFalse(block["upstreamStateUnchanged"])
        self.assertEqual(block["namespaceIsolation"], "violated")
        self.assertTrue(block["upstreamStateChanges"])
        self.assertEqual(isolation_report.problems({"isolation": block}, self.root), [])

    def test_a_recorded_change_without_reasons_is_rejected(self) -> None:
        block = self.finished_block()
        block["upstreamStateUnchanged"] = False
        block["upstreamStateChanges"] = []
        found = isolation_report.problems({"isolation": block}, self.root)
        self.assertTrue(any("upstreamStateChanges is empty" in reason for reason in found), found)

    def test_a_profile_outside_the_run_output_is_rejected(self) -> None:
        block = self.finished_block()
        other = self.root.parent / "elsewhere"
        other.mkdir()
        found = isolation_report.problems({"isolation": block}, other)
        self.assertTrue(any("not under the run output" in reason for reason in found), found)

    def test_every_recorded_field_is_required(self) -> None:
        block = self.finished_block()
        for key in isolation_report.REQUIRED_KEYS:
            partial = {k: v for k, v in block.items() if k != key}
            found = isolation_report.problems({"isolation": partial}, self.root)
            self.assertTrue(found, f"a block without {key} must be rejected")


if __name__ == "__main__":
    unittest.main()

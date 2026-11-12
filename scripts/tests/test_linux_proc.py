"""Parsers, role attribution and aggregation of the Linux `/proc` sampler.

Run with: python3 -m unittest discover -s scripts/tests
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "app-lab"))

import linux_proc  # noqa: E402

SMAPS = """\
00400000-13600000 r-xp 00000000 00:00 0 /usr/bin/terax
Rss:               1200 kB
Pss:                900 kB
Pss_Anon:           400 kB
Pss_File:           500 kB
Pss_Shmem:            0 kB
Shared_Clean:       600 kB
Shared_Dirty:       100 kB
Private_Clean:      300 kB
Private_Dirty:      200 kB
Referenced:        1100 kB
Anonymous:          400 kB
Swap:                50 kB
SwapPss:             10 kB
Locked:               0 kB
THPeligible:          0
ProtectionKey:        0
VmFlags: rd ex mr mw me
"""

STAT = "1234 (WebKitWebProc (x)) S 1200 1234 1234 0 -1 4194560 12 0 0 0 3 4 0 0 20 0 7 0 98765 100 200\n"


class SmapsTest(unittest.TestCase):
    def test_bytes_and_units(self):
        parsed = linux_proc.parse_smaps_rollup(SMAPS)
        self.assertEqual(parsed["Pss"], 900 * 1024)
        self.assertEqual(parsed["Pss_Anon"], 400 * 1024)
        self.assertEqual(parsed["Anonymous"], 400 * 1024)
        # Non-kB lines carry no unit and must not be parsed as sizes.
        self.assertNotIn("THPeligible", parsed)
        self.assertNotIn("ProtectionKey", parsed)

    def test_pss_breakdown_fields_are_not_confused_with_pss(self):
        parsed = linux_proc.parse_smaps_rollup(SMAPS)
        self.assertEqual(parsed["Pss"], 900 * 1024)
        self.assertNotEqual(parsed["Pss"], parsed["Pss_Shmem"])

    def test_memory_of_keeps_private_shared_and_overcount_apart(self):
        memory = linux_proc.memory_of(linux_proc.parse_smaps_rollup(SMAPS))
        self.assertEqual(memory["pss"], 900 * 1024)
        self.assertEqual(memory["rss"], 1200 * 1024)
        self.assertEqual(memory["private"], 500 * 1024)
        self.assertEqual(memory["shared"], 700 * 1024)
        # Summing Rss would claim 1200 KiB of unique memory where Pss says 900 KiB.
        self.assertEqual(memory["rssOvercount"], 300 * 1024)

    def test_a_torn_smaps_read_is_not_an_error(self):
        self.assertEqual(linux_proc.parse_smaps_rollup(""), {})
        self.assertEqual(linux_proc.memory_of({}), {
            "pss": 0, "rss": 0, "private": 0, "shared": 0, "swap": 0,
            "rssOvercount": 0, "anon": 0,
        })


class StatTest(unittest.TestCase):
    def test_comm_with_spaces_and_parentheses(self):
        stat = linux_proc.parse_stat(STAT)
        self.assertEqual(stat["ppid"], 1200)
        self.assertEqual(stat["threads"], 7)
        self.assertEqual(stat["starttime"], 98765)
        self.assertEqual(stat["utime"], 3)
        self.assertEqual(stat["stime"], 4)
        self.assertEqual(linux_proc.cpu_seconds(stat), 7 / linux_proc.CLK_TCK)

    def test_garbage_and_short_stat(self):
        self.assertIsNone(linux_proc.parse_stat("garbage"))
        self.assertIsNone(linux_proc.parse_stat("1 (x) S 2"))


class RoleTest(unittest.TestCase):
    def test_helper_prefixes_match_full_and_truncated_names(self):
        for command in ("WebKitWebProcess", "WebKitWebProces"):
            self.assertEqual(linux_proc.role_of(command, 102, 100), "web_content")
        self.assertEqual(linux_proc.role_of("WebKitNetworkProcess", 103, 100), "networking")
        self.assertEqual(linux_proc.role_of("WebKitNetworkPr", 103, 100), "networking")
        self.assertEqual(linux_proc.role_of("WebKitGPUProcess", 104, 100), "gpu")
        self.assertEqual(linux_proc.role_of("terax", 100, 100), "host")
        self.assertEqual(linux_proc.role_of("bash", 105, 100), "workload")
        self.assertEqual(linux_proc.role_of("node", 106, 100), "workload")
        self.assertEqual(linux_proc.role_of("bwrap", 107, 100), "sandbox")
        self.assertEqual(linux_proc.role_of("other-app", 200, 100), "workload")

    def test_command_of_prefers_argv0_and_falls_back_to_comm(self):
        self.assertEqual(
            linux_proc.command_of(b"/usr/libexec/webkit2gtk-4.1/WebKitWebProcess\0-x\0"),
            "WebKitWebProcess",
        )
        self.assertEqual(linux_proc.command_of(b"", "kthreadd"), "kthreadd")
        self.assertEqual(linux_proc.command_of(b"\0\0", ""), "")

    def test_role_order_keeps_the_documented_order(self):
        self.assertEqual(linux_proc.role_order({"workload", "gpu", "host"}), ["host", "gpu", "workload"])
        self.assertEqual(linux_proc.role_order({"future"}), ["future"])


class TreeTest(unittest.TestCase):
    def test_descendants_follow_wrappers_and_skip_foreign_trees(self):
        table = {100: 1, 101: 100, 102: 101, 103: 102, 200: 1, 201: 200}
        self.assertEqual(sorted(linux_proc.descendants(table, 100)), [101, 102, 103])
        self.assertEqual(linux_proc.descendants(table, 999), [])


class AggregateTest(unittest.TestCase):
    def test_pss_is_the_unique_total_and_rss_is_only_the_overcount(self):
        processes = {
            100: {"pid": 100, "role": "host", "pss": 100, "rss": 200, "private": 80, "shared": 120, "swap": 0, "rssOvercount": 100, "cpuSeconds": 1.0, "threads": 10, "fds": 20},
            101: {"pid": 101, "role": "web_content", "pss": 50, "rss": 200, "private": 40, "shared": 160, "swap": 0, "rssOvercount": 150, "cpuSeconds": 2.0, "threads": 5, "fds": 10},
            105: {"pid": 105, "role": "workload", "pss": 7, "rss": 7, "private": 7, "shared": 0, "swap": 0, "rssOvercount": 0, "cpuSeconds": 0.5, "threads": 1, "fds": 3},
        }
        found = linux_proc.aggregate(processes)
        self.assertEqual(found["total"]["pss"], 157)
        self.assertEqual(found["app"]["pss"], 150)
        self.assertEqual(found["workload"]["pss"], 7)
        self.assertEqual(found["total"]["rss"], 407)
        self.assertEqual(found["total"]["rssOvercount"], 250)
        self.assertEqual(found["total"]["processes"], 3)
        self.assertEqual(found["total"]["threads"], 16)
        self.assertEqual(found["byRole"]["web_content"]["cpuSeconds"], 2.0)

    def test_empty_aggregation_is_all_zeros(self):
        found = linux_proc.aggregate({})
        self.assertEqual(found["total"]["pss"], 0)
        self.assertEqual(found["byRole"], {})
        self.assertEqual(found["app"]["processes"], 0)


class CurveTest(unittest.TestCase):
    def test_percentiles_are_interpolated(self):
        self.assertIsNone(linux_proc.percentile([], 50))
        self.assertEqual(linux_proc.percentile([5], 95), 5.0)
        values = [1, 2, 3, 4]
        self.assertEqual(linux_proc.percentile(values, 0), 1.0)
        self.assertEqual(linux_proc.percentile(values, 50), 2.5)
        self.assertEqual(linux_proc.percentile(values, 100), 4.0)
        self.assertAlmostEqual(linux_proc.percentile(values, 95), 3.85, places=6)
        with self.assertRaises(ValueError):
            linux_proc.percentile(values, 101)

    def test_curve_of_an_empty_series_is_zeroed(self):
        self.assertEqual(linux_proc.curve([]), {"n": 0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0})
        self.assertEqual(linux_proc.curve([10, 20])["p50"], 15.0)


class FakeProc:
    """A /proc tree with the files the sampler reads."""

    def __init__(self, root: Path):
        self.root = root

    def add(self, pid: int, ppid: int, command: str, rss_kb: int = 1000, pss_kb: int = 800, cpu_ticks: int = 0, threads: int = 3):
        base = self.root / str(pid)
        base.mkdir(parents=True)
        state = "S"
        # pid (comm) state ppid ... utime stime ... num_threads ... starttime vsize rss
        fields = [state, str(ppid), str(pid), str(pid), "0", "-1", "4194560", "100", "0", "0", "0", str(cpu_ticks), "0", "0", "0", "20", "0", str(threads), "0", "12345", "100", "200"]
        (base / "stat").write_text(f"{pid} ({command}) " + " ".join(fields) + "\n")
        (base / "cmdline").write_bytes(f"/opt/x/{command}\0--flag\0".encode())
        (base / "comm").write_text(command[:15] + "\n")
        (base / "smaps_rollup").write_text(
            f"Rss: {rss_kb} kB\nPss: {pss_kb} kB\nPrivate_Clean: {pss_kb // 2} kB\n"
            f"Private_Dirty: {pss_kb // 2} kB\nShared_Clean: {rss_kb - pss_kb} kB\nSwap: 0 kB\n"
        )
        (base / "fd").mkdir()
        for index in range(2):
            (base / "fd" / str(index)).symlink_to("/dev/null")


class SampleTest(unittest.TestCase):
    def test_sample_reads_the_subtree_and_excludes_foreign_processes(self):
        with tempfile.TemporaryDirectory(prefix="terax-linux-proc-") as tmp:
            fake = FakeProc(Path(tmp))
            fake.add(100, 1, "terax", rss_kb=2000, pss_kb=1500, cpu_ticks=20)
            fake.add(101, 100, "bwrap", rss_kb=100, pss_kb=100)
            fake.add(102, 101, "WebKitWebProcess", rss_kb=4000, pss_kb=3000, cpu_ticks=40)
            fake.add(103, 102, "WebKitWebProcess", rss_kb=1000, pss_kb=900)
            fake.add(104, 100, "WebKitNetworkProcess", rss_kb=500, pss_kb=400)
            fake.add(105, 100, "bash", rss_kb=300, pss_kb=250)
            fake.add(200, 1, "other-app", rss_kb=99999, pss_kb=99999)
            fake.add(201, 200, "WebKitWebProcess", rss_kb=99999, pss_kb=99999)

            found = linux_proc.sample(100, root=tmp)

            self.assertNotIn("200", found["processes"])
            self.assertNotIn("201", found["processes"])
            self.assertEqual(
                sorted(int(pid) for pid in found["processes"]), [100, 101, 102, 103, 104, 105]
            )
            self.assertEqual(found["byRole"]["host"]["processes"], 1)
            self.assertEqual(found["byRole"]["sandbox"]["processes"], 1)
            self.assertEqual(found["byRole"]["web_content"]["processes"], 2)
            self.assertEqual(found["workload"]["pss"], 250 * 1024)
            self.assertEqual(found["app"]["pss"], (1500 + 100 + 3000 + 900 + 400) * 1024)
            self.assertEqual(found["total"]["processes"], 6)
            self.assertEqual(found["byRole"]["host"]["fds"], 2)
            self.assertEqual(found["byRole"]["web_content"]["cpuSeconds"], round(40 / linux_proc.CLK_TCK, 3))

    def test_process_identity_reports_start_time_from_btime(self):
        with tempfile.TemporaryDirectory(prefix="terax-linux-proc-") as tmp:
            fake = FakeProc(Path(tmp))
            fake.add(100, 1, "terax")
            (Path(tmp) / "stat").write_text("cpu 0 0 0 0\nbtime 1700000000\n")
            identity = linux_proc.process_identity(100, root=tmp)
            self.assertEqual(identity["pid"], 100)
            self.assertEqual(identity["startedUnixS"], round(1700000000 + 12345 / linux_proc.CLK_TCK, 3))

    def test_rate_math_and_missing_processes(self):
        series = [
            {"tMonoNs": 1_000_000_000, "byRole": {"host": {"cpuSeconds": 1.0}, "workload": {"cpuSeconds": 0.0}}, "app": {}, "workload": {}, "total": {}},
            {"tMonoNs": 3_000_000_000, "byRole": {"host": {"cpuSeconds": 1.5}, "workload": {"cpuSeconds": 1.0}}, "app": {}, "workload": {}, "total": {}},
        ]
        found = linux_proc.rates(series)
        self.assertEqual(found["intervals"], 1)
        self.assertEqual(found["cpu_pct"]["host"], 25.0)
        self.assertEqual(found["cpu_pct"]["workload"], 50.0)
        self.assertEqual(found["cpu_pct_app_total"], 25.0)
        self.assertEqual(found["cpu_pct_total"], 75.0)

    def test_cpu_percent_is_a_mean_over_the_timeline_not_a_sum_of_intervals(self):
        # host used 1 CPU-second over 3 s in two intervals: 33.3% of one core, not 2 x 50%.
        series = [
            {"tMonoNs": 0, "byRole": {"host": {"cpuSeconds": 0.0}}},
            {"tMonoNs": 2_000_000_000, "byRole": {"host": {"cpuSeconds": 1.0}}},
            {"tMonoNs": 3_000_000_000, "byRole": {"host": {"cpuSeconds": 1.0}}},
        ]
        found = linux_proc.rates(series)
        self.assertAlmostEqual(found["cpu_pct"]["host"], 100 / 3, places=3)
        self.assertEqual(found["seconds"], 3.0)

    def test_a_process_that_exits_between_entries_does_not_subtract_cpu(self):
        series = [
            {"tMonoNs": 0, "byRole": {"host": {"cpuSeconds": 0.0}, "gpu": {"cpuSeconds": 0.5}}},
            {"tMonoNs": 1_000_000_000, "byRole": {"host": {"cpuSeconds": 1.0}}},
        ]
        found = linux_proc.rates(series)
        self.assertEqual(found["cpu_pct"]["host"], 100.0)
        self.assertNotIn("gpu", found["cpu_pct"])


class PollerTest(unittest.TestCase):
    def test_one_sample_entry_has_no_pid_lists_and_keeps_roles(self):
        with tempfile.TemporaryDirectory(prefix="terax-linux-proc-") as tmp:
            fake = FakeProc(Path(tmp))
            fake.add(100, 1, "terax", rss_kb=2000, pss_kb=1500)
            fake.add(105, 100, "bash", rss_kb=300, pss_kb=250)
            poller = linux_proc.Poller(0.5)
            sample = linux_proc.sample(100, root=tmp)
            with mock.patch.object(linux_proc, "sample", return_value=sample):
                entry = poller.sample_once(100)
            self.assertIn("host", entry["byRole"])
            self.assertIn("workload", entry["byRole"])
            self.assertEqual(entry["workload"]["pss"], 250 * 1024)
            self.assertNotIn("pids", entry["app"])
            self.assertEqual(entry["total"]["pss"], 1500 * 1024 + 250 * 1024)


if __name__ == "__main__":
    unittest.main()

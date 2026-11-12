"""Comparable metric names, the human summary and baseline/candidate comparison for Linux.

Run with: python3 -m unittest discover -s scripts/tests
"""

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "app-lab"))

import linux_proc  # noqa: E402
import linux_report  # noqa: E402

MIB = linux_proc.MIB


def memory(host=100, web=200, gpu=50, net=20, workload=30, private=None):
    """A `memory` block as linux_proc.aggregate produces it, with MiB figures as bytes."""
    processes = {
        1: {"pid": 1, "role": "host", "pss": host * MIB, "rss": host * MIB, "private": (private or host) * MIB, "shared": 0, "swap": 0, "rssOvercount": 0, "cpuSeconds": 1.0, "threads": 10, "fds": 30},
        2: {"pid": 2, "role": "web_content", "pss": web * MIB, "rss": (web + 40) * MIB, "private": web * MIB, "shared": 0, "swap": 0, "rssOvercount": 40 * MIB, "cpuSeconds": 2.0, "threads": 20, "fds": 40},
        3: {"pid": 3, "role": "gpu", "pss": gpu * MIB, "rss": gpu * MIB, "private": gpu * MIB, "shared": 0, "swap": 0, "rssOvercount": 0, "cpuSeconds": 0.5, "threads": 4, "fds": 10},
        4: {"pid": 4, "role": "networking", "pss": net * MIB, "rss": net * MIB, "private": net * MIB, "shared": 0, "swap": 0, "rssOvercount": 0, "cpuSeconds": 0.2, "threads": 3, "fds": 12},
        5: {"pid": 5, "role": "workload", "pss": workload * MIB, "rss": workload * MIB, "private": workload * MIB, "shared": 0, "swap": 0, "rssOvercount": 0, "cpuSeconds": 0.9, "threads": 8, "fds": 20},
    }
    return linux_proc.aggregate(processes)


def sample(phase, t=1_000_000_000, cpu=1.0, **figures):
    block = memory(**figures)
    for entry in block["byRole"].values():
        entry["cpuSeconds"] = round(entry["cpuSeconds"] * cpu, 3)
    return {
        "phase": phase,
        "tMonoNs": t,
        "event": {"phase": phase, "diag": {"tabs": []}},
        "memory": block,
    }


def report() -> dict:
    samples = [
        sample("booted", t=1_000_000_000, host=60, web=80, gpu=20, net=10, workload=0),
        sample("baseline", t=6_000_000_000, cpu=2.0, host=100, web=200, gpu=50, net=20, workload=30),
        sample("measure-start", t=11_000_000_000, host=100, web=220, gpu=50, net=20, workload=35),
        sample("stream-start", t=16_000_000_000, host=100, web=230, gpu=50, net=20, workload=35),
        sample("stream-end", t=21_000_000_000, host=105, web=260, gpu=50, net=20, workload=40),
        sample("measure-end", t=26_000_000_000, host=104, web=250, gpu=50, net=20, workload=40),
        sample("cycle-1-hidden", t=31_000_000_000, host=104, web=250, gpu=50, net=20, workload=40),
        sample("cycle-1-visible", t=36_000_000_000, host=104, web=251, gpu=50, net=20, workload=40),
        sample("close-cycle-1-open", t=41_000_000_000, host=105, web=255, gpu=50, net=20, workload=40),
        sample("close-cycle-1-closed", t=46_000_000_000, host=104, web=251, gpu=50, net=20, workload=40),
        sample("end+30s", t=51_000_000_000, host=103, web=248, gpu=50, net=20, workload=40),
    ]
    series = [
        {"tMonoNs": 1_000_000_000, "wallMs": 1700000000000, "loadAverage": [1.0],
         "byRole": {"host": {"cpuSeconds": 10.0}, "web_content": {"cpuSeconds": 20.0}, "workload": {"cpuSeconds": 5.0}},
         "app": {"pss": 300 * MIB}, "workload": {"pss": 30 * MIB}, "total": {"pss": 330 * MIB}},
        {"tMonoNs": 3_000_000_000, "wallMs": 1700000002000, "loadAverage": [1.5],
         "byRole": {"host": {"cpuSeconds": 11.0}, "web_content": {"cpuSeconds": 21.0}, "workload": {"cpuSeconds": 7.0}},
         "app": {"pss": 310 * MIB}, "workload": {"pss": 32 * MIB}, "total": {"pss": 342 * MIB}},
    ]
    return {
        "schema": "terax-app-lab/1",
        "scope": "test",
        "config": {"scenario": "resource", "profile": "release", "label": "unit"},
        "sourceRevision": "a" * 40,
        "platform": "Linux-test",
        "environment": {"cpu": "test cpu", "logicalCpus": 8, "memoryBytes": 8 * 2**30, "os": "Fedora", "kernel": "6.0",
                        "session": "wayland", "desktop": "GNOME", "loadAverageStart": [1.0], "loadAverageEnd": [2.0]},
        "qualification": {"qualified": True, "failures": [], "advisories": []},
        "samples": samples,
        "series": series,
        "startup": [
            {"launch": 1, "kind": "cold", "exec_to_nav_ms": 300.0, "nav_to_boot_ms": 1200.0, "exec_to_boot_ms": 1500.0, "first_paint_ms": 400.0},
            {"launch": 2, "kind": "warm", "exec_to_nav_ms": 200.0, "nav_to_boot_ms": 900.0, "exec_to_boot_ms": 1100.0, "first_paint_ms": 300.0},
            {"launch": 3, "kind": "warm", "exec_to_nav_ms": 220.0, "nav_to_boot_ms": 800.0, "exec_to_boot_ms": 1020.0, "first_paint_ms": 290.0},
        ],
        "package": {"benchBinaryBytes": 100 * MIB, "frontendDistBytes": 5 * MIB, "bundle": "not produced"},
        "limitations": ["PDF rendering is not exercised"],
        "linux": {"pollIntervalS": 1.0, "workloadFiles": ["notes.txt"]},
    }


class MetricsTest(unittest.TestCase):
    def test_memory_metrics_separate_app_and_workload(self):
        metrics = linux_report.compute_metrics(report())
        self.assertAlmostEqual(metrics["mem.baseline.total_pss_mib"], 400.0)
        self.assertAlmostEqual(metrics["mem.baseline.app_pss_mib"], 370.0)
        self.assertAlmostEqual(metrics["mem.baseline.workload_pss_mib"], 30.0)
        # RSS is 40 MiB higher because WebContent's shared pages are counted twice on purpose.
        self.assertAlmostEqual(metrics["mem.baseline.total_rss_mib"], 440.0)
        self.assertAlmostEqual(metrics["mem.baseline.rss_overcount_mib"], 40.0)
        self.assertAlmostEqual(metrics["mem.baseline.web_content_pss_mib"], 200.0)
        self.assertEqual(metrics["mem.baseline.processes"], 5)

    def test_streaming_and_settle_deltas(self):
        metrics = linux_report.compute_metrics(report())
        self.assertAlmostEqual(metrics["delta.stream.app_pss_mib"], 35.0)  # web +30, host +5
        # baseline -> settle: app 370 -> 421, total 400 -> 451
        self.assertAlmostEqual(metrics["delta.baseline_to_settle.total_pss_mib"], 61.0)

    def test_segment_cpu_between_consecutive_phases(self):
        metrics = linux_report.compute_metrics(report())
        name = "booted->baseline"  # 5 s apart; host 1.0 -> 2.0 CPU-seconds is 20% of one core
        self.assertIn(f"segment.{name}.cpu_pct.host", metrics)
        self.assertAlmostEqual(metrics[f"segment.{name}.cpu_pct.host"], 20.0)
        self.assertGreater(metrics[f"segment.{name}.cpu_pct.app_total"], 0)

    def test_startup_metrics_and_warm_median(self):
        metrics = linux_report.compute_metrics(report())
        self.assertEqual(metrics["startup.cold.exec_to_boot_ms"], 1500.0)
        self.assertEqual(metrics["startup.cold.launches"], 1)
        self.assertEqual(metrics["startup.warm.launches"], 2)
        self.assertEqual(metrics["startup.warm_median.exec_to_boot_ms"], 1060.0)
        self.assertEqual(metrics["startup.warm_median.first_paint_ms"], 295.0)

    def test_timeline_metrics_and_cpu_rates_exclude_workload_from_the_app_total(self):
        metrics = linux_report.compute_metrics(report())
        self.assertEqual(metrics["timeline.samples"], 2)
        self.assertEqual(metrics["timeline.seconds"], 2.0)
        self.assertAlmostEqual(metrics["timeline.app_pss_mean_mib"], 305.0)
        self.assertAlmostEqual(metrics["timeline.cpu_pct.host"], 50.0)
        self.assertAlmostEqual(metrics["timeline.cpu_pct.workload"], 100.0)
        self.assertAlmostEqual(metrics["timeline.cpu_pct.app_total"], 100.0)  # host 50 + web 50
        self.assertAlmostEqual(metrics["timeline.cpu_pct.total"], 200.0)

    def test_cycles_and_close_cycles(self):
        metrics = linux_report.compute_metrics(report())
        self.assertAlmostEqual(metrics["cycles.hidden_mean_mib"], 464.0)
        self.assertAlmostEqual(metrics["cycles.visible_mean_mib"], 465.0)
        self.assertAlmostEqual(metrics["close.closed_mean_mib"], 465.0)
        self.assertAlmostEqual(metrics["close.open_mean_mib"], 470.0)
        self.assertAlmostEqual(metrics["close.per_cycle_mean_mib"], -5.0)
        self.assertAlmostEqual(metrics["close.retained_vs_baseline_mib"], 65.0)

    def test_peak_memory_is_the_worst_phase(self):
        metrics = linux_report.compute_metrics(report())
        self.assertAlmostEqual(metrics["mem.peak_total_pss_mib"], 475.0)  # stream-end: 105+260+50+20+40
        self.assertAlmostEqual(metrics["mem.peak_app_pss_mib"], 435.0)

    def test_a_partial_report_yields_no_invented_memory_metrics(self):
        broken = {**report(), "samples": [], "series": [], "startup": []}
        self.assertEqual(linux_report.compute_metrics(broken), {})
        # And one event without a memory block is skipped, not zero-filled.
        broken["samples"] = [{"phase": "done", "event": {"phase": "done"}}]
        self.assertEqual(linux_report.compute_metrics(broken), {})


class SummaryTest(unittest.TestCase):
    def test_summary_states_the_workload_fixtures_and_limitations(self):
        text = linux_report.summarize(report())
        self.assertIn("Whole-application memory", text)
        self.assertIn("PSS counts each shared page once", text)
        self.assertIn("Startup (cold = fresh disposable profile", text)
        self.assertIn("1          cold", text)
        self.assertIn("notes.txt", text)
        self.assertIn("PDF rendering is not exercised", text)
        self.assertIn("load average start", text)
        self.assertIn("timeline", text.lower())

    def test_summary_of_an_empty_report_does_not_crash(self):
        text = linux_report.summarize({"config": {"scenario": "startup"}, "samples": [], "series": []})
        self.assertIn("no startup measurement", text)


class CompareTest(unittest.TestCase):
    def test_text_comparison_prints_one_line_per_metric(self):
        base, cand = report(), report()
        cand["samples"] = [base["samples"][0], sample("baseline", host=110, web=220, gpu=50, net=20, workload=30)] + base["samples"][2:]
        text = linux_report.compare([base], [cand])
        self.assertIn("mem.baseline.web_content_pss_mib", text)
        self.assertIn("+20.00", text)
        self.assertIn("comparison (Linux): resource", text)

    def test_tsv_has_a_header_and_metric_rows(self):
        text = linux_report.compare([report()], [report()], format="tsv")
        lines = text.splitlines()
        self.assertEqual(lines[0], "metric\tbaseline\tcandidate\tdelta\tpercent")
        self.assertTrue(any(line.startswith("startup.cold.exec_to_boot_ms\t") for line in lines[1:]))

    def test_json_comparison_is_machine_readable(self):
        found = json.loads(linux_report.compare([report()], [report()], format="json"))
        self.assertEqual(found["metrics"]["mem.baseline.total_pss_mib"]["baseline"], 400.0)


if __name__ == "__main__":
    unittest.main()

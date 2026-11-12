"""Contracts of the Ghostty revision update procedure (`scripts/ghostty-update/run.py`).

The procedure exists so a Ghostty revision update cannot be accepted on "the tests still pass":
the pinned source revision and the checked-in artifacts must agree, the adapted bridge must stay
compatible, the soak must stay inside its stack and memory bounds, and the recorded whole-app
resource baseline must not regress. These tests pin the decisions, not the subprocess plumbing.

Run with: python3 -m unittest discover -s scripts/tests
"""

import importlib.util
import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
RUN_PY = REPO / "scripts/ghostty-update/run.py"


def load_module():
    spec = importlib.util.spec_from_file_location("ghostty_update", RUN_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UpstreamPinTest(unittest.TestCase):
    """The procedure reads its truth from the recorded provenance, not from the code under test."""

    def setUp(self) -> None:
        self.update = load_module()

    def test_the_pinned_revision_and_artifact_hashes_are_read_from_the_recorded_provenance(self) -> None:
        pin = self.update.parse_upstream(
            "## Terax Ghostty WASM adaptation\n"
            "- Ghostty commit: `ad97d331459a0762f7aea5f56fe86748e03b860f`\n"
            "- Zig: `0.16.0`\n"
            "- SIMD artifact size: `755971` bytes\n"
            "- Scalar artifact size: `753894` bytes\n"
            "- SIMD SHA-256: `32b630675916b3122c2c187c640191e90ae848ee9f196ec5fe091681560c1f11`\n"
            "- Scalar SHA-256: `3749923e6d7c9ad8f1919f0072073843d9792dcd41d6628b42f208b1f733aa13`\n"
        )
        self.assertEqual(pin["commit"], "ad97d331459a0762f7aea5f56fe86748e03b860f")
        self.assertEqual(pin["zig"], "0.16.0")
        self.assertEqual(pin["simd"]["size"], 755971)
        self.assertEqual(pin["simd"]["sha256"], "32b630675916b3122c2c187c640191e90ae848ee9f196ec5fe091681560c1f11")
        self.assertEqual(pin["scalar"]["size"], 753894)
        self.assertEqual(pin["scalar"]["sha256"][:8], "3749923e")

    def test_the_rebuild_pin_in_build_zig_zon_names_the_same_revision(self) -> None:
        pin = self.update.parse_zig_pin(
            "        .ghostty = .{\n"
            '            .url = "https://github.com/ghostty-org/ghostty/archive/'
            'ad97d331459a0762f7aea5f56fe86748e03b860f.tar.gz",\n'
            '            .hash = "ghostty-1.3.2-dev-5UdBC8RaewWXxNoW1McNciOrmX8kUX0OUgZwDcJkmg2M",\n'
            "        },\n"
            '    .minimum_zig_version = "0.16.0",\n'
        )
        self.assertEqual(pin["commit"], "ad97d331459a0762f7aea5f56fe86748e03b860f")
        self.assertEqual(pin["minimum_zig"], "0.16.0")
        self.assertTrue(pin["hash"].startswith("ghostty-1.3.2-dev-"))

    def test_a_revision_that_disagrees_with_the_recorded_provenance_is_refused(self) -> None:
        result = self.update.identity_gate(
            {"commit": "a" * 40, "zig": "0.16.0"},
            {"commit": "a" * 40, "minimum_zig": "0.16.0"},
            requested="b" * 40,
        )
        self.assertEqual(result.status, "fail")
        self.assertIn("b" * 40, result.detail)
        self.assertIn("a" * 40, result.detail)

    def test_documentation_and_rebuild_pin_must_agree(self) -> None:
        result = self.update.identity_gate(
            {"commit": "a" * 40, "zig": "0.16.0"},
            {"commit": "c" * 40, "minimum_zig": "0.16.0"},
            requested=None,
        )
        self.assertEqual(result.status, "fail")
        self.assertIn("UPSTREAM.md", result.detail)
        self.assertIn("build.zig.zon", result.detail)

    def test_the_shipped_repository_is_internally_consistent(self) -> None:
        result = self.update.identity_gate(
            self.update.parse_upstream(self.update.UPSTREAM.read_text()),
            self.update.parse_zig_pin(self.update.ZIG_ZON.read_text()),
            requested=None,
        )
        self.assertEqual(result.status, "pass", result.detail)


class ArtifactTest(unittest.TestCase):
    def setUp(self) -> None:
        self.update = load_module()
        self.pin = {
            "commit": "a" * 40,
            "zig": "0.16.0",
            "simd": {"size": 10, "sha256": "1" * 64},
            "scalar": {"size": 20, "sha256": "2" * 64},
        }

    def test_the_shipped_artifacts_match_their_recorded_hashes(self) -> None:
        recorded = self.update.parse_upstream(self.update.UPSTREAM.read_text())
        result = self.update.artifact_gate(recorded, self.update.artifact_evidence(self.update.CORE))
        self.assertEqual(result.status, "pass", result.detail)

    def test_a_rebuilt_artifact_that_differs_from_the_record_is_refused_until_it_is_recorded(self) -> None:
        evidence = self.update.artifact_evidence(self.update.CORE)
        evidence["ghostty-vt.wasm"]["sha256"] = "0" * 64
        result = self.update.artifact_gate(self.pin, evidence)
        self.assertEqual(result.status, "fail")
        self.assertIn("ghostty-vt.wasm", result.detail)
        self.assertIn("UPSTREAM.md", result.detail, "the refusal must name what has to be updated")


class SoakTest(unittest.TestCase):
    def setUp(self) -> None:
        self.update = load_module()
        self.baseline = {
            "reports": [
                {"artifact": "ghostty-vt.wasm", "renderFormat": "soa", "plateauGrowthBytes": 0,
                 "finalWasmBytes": 78708736},
            ],
            "stackReports": [
                {"artifact": "ghostty-vt.wasm", "renderFormat": "soa", "peakStackBytes": 35200,
                 "peakStackFraction": 0.358},
            ],
        }

    def report(self, **over):
        report = json.loads(json.dumps(self.baseline))
        for key, value in over.items():
            target, field = key.split("__")
            index = 0
            report[target][index][field] = value
        return report

    def test_a_soak_inside_its_bounds_passes_and_compares_against_the_recorded_baseline(self) -> None:
        result = self.update.soak_gate(self.report(), self.baseline)
        self.assertEqual(result.status, "pass", result.detail)
        self.assertEqual(result.evidence["comparedArtifacts"], 1)

    def test_plateau_growth_above_the_absolute_bound_fails(self) -> None:
        result = self.update.soak_gate(self.report(reports__plateauGrowthBytes=65 * 1024), None)
        self.assertEqual(result.status, "fail")
        self.assertIn("plateau", result.detail)

    def test_deep_stack_use_fails(self) -> None:
        result = self.update.soak_gate(
            self.report(stackReports__peakStackFraction=0.51, stackReports__peakStackBytes=50000), None
        )
        self.assertEqual(result.status, "fail")
        self.assertIn("stack", result.detail)

    def test_a_memory_regression_against_the_recorded_baseline_fails(self) -> None:
        grown = self.report(reports__finalWasmBytes=78_708_736 + 8 * 1024 * 1024)
        result = self.update.soak_gate(grown, self.baseline)
        self.assertEqual(result.status, "fail")
        self.assertIn("finalWasmBytes", result.detail)

    def test_missing_artifact_coverage_against_the_baseline_fails(self) -> None:
        candidate = self.report()
        candidate["reports"] = []
        result = self.update.soak_gate(candidate, self.baseline)
        self.assertEqual(result.status, "fail")
        self.assertIn("ghostty-vt.wasm", result.detail)


class BenchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.update = load_module()

    @staticmethod
    def suite(mean: float) -> dict:
        return {
            "files": [
                {
                    "filepath": "AdaptedGhostty.bench.ts",
                    "groups": [
                        {
                            "name": "ghostty-vt.wasm",
                            "benchmarks": [{"name": "write + update", "mean": mean, "hz": 1 / mean}],
                        }
                    ],
                }
            ]
        }

    def test_an_unchanged_workload_passes(self) -> None:
        result = self.update.bench_gate(self.suite(2.0), self.suite(2.0))
        self.assertEqual(result.status, "pass", result.detail)

    def test_a_slower_task_fails(self) -> None:
        result = self.update.bench_gate(self.suite(3.0), self.suite(2.0))
        self.assertEqual(result.status, "fail")
        self.assertIn("write + update", result.detail)

    def test_a_task_the_baseline_covered_but_the_candidate_dropped_fails(self) -> None:
        candidate = self.suite(2.0)
        candidate["files"][0]["groups"][0]["benchmarks"] = []
        result = self.update.bench_gate(candidate, self.suite(2.0))
        self.assertEqual(result.status, "fail")
        self.assertIn("write + update", result.detail)


class ResourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.update = load_module()
        # Every metric the shipped rules name, so a rule added without evidence fails here.
        self.baseline = {metric: 100.0 for metric in self.update.RESOURCE_RULES}

    def test_a_candidate_within_the_recorded_tolerances_passes(self) -> None:
        result = self.update.resource_gate(dict(self.baseline), self.baseline)
        self.assertEqual(result.status, "pass", result.detail)

    def test_a_memory_regression_beyond_tolerance_fails_and_names_the_metric(self) -> None:
        candidate = dict(self.baseline, **{"mem.baseline.app_pss_mib": 100.0 + 200})
        result = self.update.resource_gate(candidate, self.baseline)
        self.assertEqual(result.status, "fail")
        self.assertIn("mem.baseline.app_pss_mib", result.detail)

    def test_a_metric_the_candidate_did_not_report_fails_rather_than_passing_silently(self) -> None:
        candidate = dict(self.baseline)
        del candidate["timeline.cpu_pct.app_total"]
        result = self.update.resource_gate(candidate, self.baseline)
        self.assertEqual(result.status, "fail")
        self.assertIn("timeline.cpu_pct.app_total", result.detail)

    def test_no_recorded_baseline_is_unverified_not_passed(self) -> None:
        result = self.update.resource_gate({}, None)
        self.assertEqual(result.status, "unverified")
        self.assertIn("baseline", result.detail)


class VerdictTest(unittest.TestCase):
    def setUp(self) -> None:
        self.update = load_module()

    def test_a_failed_gate_makes_the_update_unacceptable(self) -> None:
        results = [
            self.update.GateResult("artifacts", "pass", "ok"),
            self.update.GateResult("soak", "fail", "plateau grew"),
        ]
        self.assertEqual(self.update.acceptance(results, accepted_unverified=()), 1)

    def test_unverified_evidence_blocks_acceptance_unless_it_is_explicitly_accepted(self) -> None:
        results = [self.update.GateResult("resource", "unverified", "no display")]
        self.assertEqual(self.update.acceptance(results, accepted_unverified=()), 1)
        self.assertEqual(self.update.acceptance(results, accepted_unverified=("resource",)), 0)

    def test_accepting_one_unverified_gate_does_not_accept_another(self) -> None:
        results = [
            self.update.GateResult("rebuild", "unverified", "no zig"),
            self.update.GateResult("resource", "unverified", "no display"),
        ]
        self.assertEqual(self.update.acceptance(results, accepted_unverified=("rebuild",)), 1)

    def test_every_gate_passing_is_accepted(self) -> None:
        results = [self.update.GateResult(name, "pass", "ok") for name in self.update.GATE_ORDER]
        self.assertEqual(self.update.acceptance(results, accepted_unverified=()), 0)


class PlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.update = load_module()

    def test_a_recorded_soak_baseline_is_shipped_so_the_soak_gate_can_compare(self) -> None:
        report = json.loads(self.update.RECORDED_SOAK_BASELINE.read_text())
        measured = {(entry["artifact"], entry["renderFormat"]) for entry in report["reports"]}
        self.assertEqual(
            measured,
            {
                ("ghostty-vt.wasm", "soa"),
                ("ghostty-vt-scalar.wasm", "soa"),
            },
            "the recorded soak baseline must cover both shipped artifacts",
        )
        self.assertEqual(len(report["stackReports"]), 2)
        result = self.update.soak_gate(report, report)
        self.assertEqual(result.status, "pass", result.detail)

    def test_the_plan_runs_the_gates_the_ticket_requires_in_order(self) -> None:
        plan = self.update.plan(baseline=Path("/baseline/evidence"))
        names = [step["gate"] for step in plan]
        self.assertEqual(names, list(self.update.GATE_ORDER))
        self.assertEqual(names.index("compatibility") < names.index("soak") < names.index("bench"), True)

    def test_the_resource_step_compares_against_the_recorded_baseline_with_the_existing_tool(self) -> None:
        plan = {step["gate"]: step for step in self.update.plan(baseline=Path("/baseline/evidence"))}
        command = plan["resource"]["command"]
        self.assertIn("scripts/app-lab/run.py", command)
        self.assertIn("--scenario resource", command)
        self.assertIn("--compare", command)
        self.assertIn("/baseline/evidence", command)

    def test_the_plan_names_the_rebuild_commands_and_the_provenance_file_to_update(self) -> None:
        plan = {step["gate"]: step for step in self.update.plan(baseline=Path("/baseline/evidence"))}
        rebuild = plan["rebuild"]["command"]
        self.assertIn("zig build -Dtarget=wasm32-freestanding", rebuild)
        self.assertIn("-Dwasm-simd=false", rebuild)
        self.assertIn("UPSTREAM.md", " ".join(plan["artifacts"]["needs"]))


class ShippedWorkflowTest(unittest.TestCase):
    """The repository's own CI must keep the Linux terminal evidence the ticket ports."""

    def setUp(self) -> None:
        self.ci = (REPO / ".github/workflows/ci.yml").read_text()

    def test_ci_runs_the_ghostty_soak_on_linux(self) -> None:
        self.assertTrue(
            "pnpm soak:ghostty" in self.ci,
            "the sustained-output soak needs a Linux runner",
        )

    def test_ci_runs_the_scaling_gate_on_linux_but_keeps_the_full_gate_elsewhere(self) -> None:
        self.assertIn("pnpm test:terminal-scaling", self.ci)
        # The Linux job names the renderer it can prove; the default stays WebGL + WebGPU.
        self.assertIn("TERAX_VISUAL_RENDERERS", self.ci)


if __name__ == "__main__":
    unittest.main()

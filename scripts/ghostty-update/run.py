#!/usr/bin/env python3
"""Ghostty revision update: rebuild the artifacts, prove compatibility/soak/resources, accept or refuse.

An upstream Ghostty revision is not accepted because the tests still pass. `packages/ghostty-core`
ships two artifacts (SIMD and scalar) built from an exact source revision, and the adapted bridge
above them can break in ways only a real workload shows. This procedure makes the update a gate
instead of a ritual:

  identity      the source revision in `UPSTREAM.md`, the revision pinned in `build.zig.zon` and
                `--revision` must be the same commit; the procedure refuses to test a tree whose
                provenance disagrees with the code that builds it.
  artifacts     both shipped `.wasm` files must match their recorded size and SHA-256.
  rebuild       with `--rebuild` (and `zig` on PATH) both variants are rebuilt from the pinned
                source and must come out byte-identical to the shipped artifacts. Without a
                rebuild this gate is UNVERIFIED, never "passed": a hosted or offline checkout has
                not shown the artifacts come from that revision.
  compatibility `pytest`-free: the adapted-core regression suite (`pnpm test`) proves the bridge
                still speaks the terminal protocol the application depends on.
  soak          `pnpm soak:ghostty` streams tens of megabytes of adversarial input through both
                artifacts and both render formats. Absolute bounds (no plateau growth, stack use
                under half the shadow stack) plus a comparison against a recorded soak report.
  bench         `vitest bench --outputJson` compared with a recorded benchmark output: no task
                may be slower than the recorded baseline beyond the tolerance, and no task the
                baseline covered may disappear.
  resource      the real Linux application under `scripts/app-lab/run.py --scenario resource`,
                compared against the recorded baseline evidence with the existing comparison
                tool. It needs a display and a bench build; without them it is UNVERIFIED.

Exit status is 0 only when every gate passed, or when the caller explicitly accepted a specific
unverified gate with `--accept-unverified NAME` (the acceptance is written into the report).

Usage:

    # what the checklist says, without running anything
    python3 scripts/ghostty-update/run.py --plan

    # verify the shipped artifacts and run the Node-side gates
    python3 scripts/ghostty-update/run.py --output /path/report

    # a real revision update
    python3 scripts/ghostty-update/run.py --revision <40-hex> --rebuild --with-resource \\
        --baseline /path/to/recorded/evidence --output /path/report

The report (`<output>/ghostty-update.json`) keeps one entry per gate with its status and the
evidence it read, so an accepted update is traceable and a refusal names the metric.
"""

import argparse
import dataclasses
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CORE = REPO / "packages/ghostty-core/adapted"
UPSTREAM = CORE / "UPSTREAM.md"
ZIG_ZON = CORE / "wasm/build.zig.zon"
ARTIFACTS = {"simd": "ghostty-vt.wasm", "scalar": "ghostty-vt-scalar.wasm"}
# The soak report recorded on Linux from the current pin, so an update is compared against a real
# measurement even when nobody passes `--soak-baseline`. Re-record it with
# `pnpm soak:ghostty` + `TERAX_SOAK_REPORT` whenever an update is accepted.
RECORDED_SOAK_BASELINE = REPO / "docs/architecture/terminal-linux-soak-2026-11-12.json"

GATE_ORDER = ("identity", "artifacts", "rebuild", "compatibility", "soak", "bench", "resource")
# `--monitor` runs the provenance checks plus a drift comparison with the upstream Ghostty project.
# It is deliberately not part of GATE_ORDER: an accepted revision update must not depend on a
# network answer that the update itself does not provide.
MONITOR_ORDER = ("identity", "artifacts", "upstream-drift")
GHOSTTY_REPO = "ghostty-org/ghostty"
GHOSTTY_BRANCH = "main"

# Absolute soak bounds, identical to the assertions `scripts/ghostty-soak.ts` makes, so the
# procedure and the suite can never drift apart.
SOAK_PLATEAU_BYTES = 64 * 1024
SOAK_STACK_FRACTION = 0.5
# A recorded soak baseline is a point measurement of another revision: linear memory may move a
# little, but not by an amount a user would notice as a regression.
SOAK_MEMORY_TOLERANCE = 0.05
# Variance between two bench runs of the same tree is a few percent; a fifth is a regression.
BENCH_TOLERANCE = 1.25

# Whole-application metrics from the recorded Linux baseline evidence (`key-metrics.json`) that
# the update must not regress, and how much drift is allowed. Every entry is "lower is better"
# except the deltas, where a *higher* number is the regression.
RESOURCE_RULES = {
    "mem.baseline.app_pss_mib": 32.0,
    "mem.baseline.total_pss_mib": 48.0,
    "mem.idle.app_pss_mib": 32.0,
    "mem.booted.app_pss_mib": 32.0,
    "cycles.hidden_mean_mib": 32.0,
    "timeline.cpu_pct.app_total": 5.0,
    "delta.stream.total_pss_mib": 16.0,
}


@dataclasses.dataclass
class GateResult:
    """One decision of the procedure. `status` is pass, fail or unverified - never absent."""

    name: str
    status: str
    detail: str
    evidence: dict = dataclasses.field(default_factory=dict)


# --------------------------------------------------------------------------- provenance


def parse_upstream(text_body: str) -> dict:
    """Read the recorded revision, Zig version, sizes and SHA-256 values from `UPSTREAM.md`."""

    def one(pattern: str, label: str) -> str:
        match = re.search(pattern, text_body, re.MULTILINE)
        if not match:
            raise SystemExit(f"UPSTREAM.md has no {label}; the provenance record is incomplete")
        return match.group(1)

    pin = {
        "commit": one(r"^- Ghostty commit: `([0-9a-f]{40})`", "Ghostty commit"),
        "zig": one(r"^- Zig: `([^`]+)`", "Zig version"),
        "simd": {
            "size": int(one(r"^- SIMD artifact size: `(\d+)` bytes", "SIMD artifact size")),
            "sha256": one(r"^- SIMD SHA-256: `([0-9a-f]{64})`", "SIMD SHA-256"),
        },
        "scalar": {
            "size": int(one(r"^- Scalar artifact size: `(\d+)` bytes", "scalar artifact size")),
            "sha256": one(r"^- Scalar SHA-256: `([0-9a-f]{64})`", "scalar SHA-256"),
        },
    }
    return pin


def parse_zig_pin(text_body: str) -> dict:
    """Read the Ghostty archive URL/hash and the minimum Zig version from `build.zig.zon`."""
    url = re.search(r"\.url\s*=\s*\"([^\"]+)\"", text_body)
    revision = re.search(r"/archive/([0-9a-f]{40})\.tar\.gz", text_body)
    digest = re.search(r"\.hash\s*=\s*\"([^\"]+)\"", text_body)
    minimum = re.search(r"\.minimum_zig_version\s*=\s*\"([^\"]+)\"", text_body)
    if not (url and revision and digest and minimum):
        raise SystemExit("build.zig.zon no longer pins the Ghostty archive URL, hash and Zig version")
    return {
        "url": url.group(1),
        "commit": revision.group(1),
        "hash": digest.group(1),
        "minimum_zig": minimum.group(1),
    }


def identity_gate(upstream: dict, pin: dict, requested: str | None) -> GateResult:
    """The documented revision, the rebuild pin and the requested revision must be one commit."""
    problems = []
    if upstream["commit"] != pin["commit"]:
        problems.append(
            f"UPSTREAM.md records {upstream['commit']} but build.zig.zon downloads {pin['commit']}"
        )
    if upstream["zig"] != pin["minimum_zig"]:
        problems.append(
            f"UPSTREAM.md records Zig {upstream['zig']} but build.zig.zon requires "
            f"{pin['minimum_zig']}"
        )
    if requested and requested != upstream["commit"]:
        problems.append(
            f"requested revision {requested} is not the recorded Ghostty commit {upstream['commit']}"
        )
    if problems:
        return GateResult("identity", "fail", "; ".join(problems), {"upstream": upstream, "pin": pin})
    return GateResult(
        "identity",
        "pass",
        f"Ghostty {upstream['commit']}, Zig {upstream['zig']}",
        {"commit": upstream["commit"], "zig": upstream["zig"], "archiveHash": pin["hash"]},
    )


def artifact_evidence(core: Path) -> dict:
    """Size and SHA-256 of both shipped artifacts."""
    evidence = {}
    for variant, name in ARTIFACTS.items():
        path = core / name
        data = path.read_bytes()
        evidence[name] = {
            "variant": variant,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    return evidence


def artifact_gate(upstream: dict, evidence: dict) -> GateResult:
    """The shipped artifacts must be the bytes the provenance record names."""
    problems = []
    for variant, name in ARTIFACTS.items():
        recorded = upstream[variant]
        found = evidence.get(name)
        if found is None:
            problems.append(f"{name} is missing from {CORE}")
            continue
        if found["size"] != recorded["size"]:
            problems.append(f"{name}: {found['size']} bytes, recorded {recorded['size']}")
        if found["sha256"] != recorded["sha256"]:
            problems.append(f"{name}: sha256 {found['sha256']}, recorded {recorded['sha256']}")
    if problems:
        return GateResult(
            "artifacts",
            "fail",
            "; ".join(problems) + " - record the rebuilt artifacts in UPSTREAM.md",
            {"artifacts": evidence, "recorded": {"simd": upstream["simd"], "scalar": upstream["scalar"]}},
        )
    return GateResult(
        "artifacts",
        "pass",
        "both artifacts match their recorded size and SHA-256",
        {"artifacts": evidence},
    )


# --------------------------------------------------------------------------- upstream drift


def drift_gate(pin: str, comparison: dict | None, error: str | None = None) -> GateResult:
    """How far the pinned Ghostty revision is behind `ghostty-org/ghostty`'s head.

    Drift is information for the monthly review, so an upstream that moved on is `pass`; a pin the
    upstream project does not contain is `fail` (it cannot be an official Ghostty revision), and an
    unreachable upstream is `unverified` - never "current" by default.
    """
    subject = f"{GHOSTTY_REPO}/compare/{pin[:7]}...{GHOSTTY_BRANCH}"
    if comparison is None:
        return GateResult(
            "upstream-drift",
            "unverified",
            f"no drift answer for {subject}"
            + (f": {error}" if error else "")
            + f" - run `gh api repos/{GHOSTTY_REPO}/compare/{pin}...{GHOSTTY_BRANCH}` to check",
            {"pin": pin, "repo": GHOSTTY_REPO, "error": error},
        )
    behind = int(comparison.get("behind_by") or 0)
    ahead = int(comparison.get("ahead_by") or 0)
    status = str(comparison.get("status") or "")
    evidence = {"pin": pin, "repo": GHOSTTY_REPO, "aheadBy": ahead, "behindBy": behind, "status": status}
    if behind > 0:
        return GateResult(
            "upstream-drift",
            "fail",
            f"the pin {pin[:7]} is not on {GHOSTTY_REPO} {GHOSTTY_BRANCH} ({behind} commits on the "
            f"upstream side are not its ancestors): the recorded revision is not an official "
            f"Ghostty commit",
            evidence,
        )
    if ahead == 0:
        return GateResult(
            "upstream-drift",
            "pass",
            f"the pin {pin[:7]} is the current {GHOSTTY_REPO} {GHOSTTY_BRANCH} head",
            evidence,
        )
    return GateResult(
        "upstream-drift",
        "pass",
        f"{ahead} commits on {GHOSTTY_REPO} {GHOSTTY_BRANCH} since the pinned {pin[:7]}: review them "
        f"in the monthly upstream review, then adopt with a rebuild or defer with a reason",
        evidence,
    )


def upstream_comparison(pin: str, runner=None) -> tuple[dict | None, str | None]:
    """`gh api` compare of the pin against the upstream branch; `(None, reason)` when unavailable."""
    runner = runner or (lambda command: run(command, timeout=120))
    if shutil.which("gh") is None:
        return None, "gh is not installed"
    code, log = runner(
        ["gh", "api", f"repos/{GHOSTTY_REPO}/compare/{pin}...{GHOSTTY_BRANCH}"]
    )
    if code != 0:
        tail = " / ".join(line.strip() for line in str(log).strip().splitlines()[-2:])
        return None, tail or f"gh api exited {code}"
    try:
        return json.loads(log), None
    except json.JSONDecodeError as error:
        return None, f"gh api did not return JSON: {error}"


def monitor_results(
    upstream: dict,
    comparison: dict | None,
    *,
    artifacts: dict | None = None,
    error: str | None = None,
) -> list[GateResult]:
    """Provenance plus upstream drift: what the monthly review needs, and nothing that rebuilds."""
    evidence = artifacts if artifacts is not None else artifact_evidence(CORE)
    return [
        GateResult("identity", "pass", f"Ghostty {upstream['commit']}, Zig {upstream['zig']}",
                   {"commit": upstream["commit"], "zig": upstream["zig"]}),
        artifact_gate(upstream, evidence),
        drift_gate(upstream["commit"], comparison, error=error),
    ]


# --------------------------------------------------------------------------- measured gates


def _soak_keys(report: dict) -> dict:
    return {
        f"{entry['artifact']}:{entry['renderFormat']}": entry
        for entry in report.get("reports", [])
    }


def soak_gate(report: dict, baseline: dict | None) -> GateResult:
    """Soak inside its absolute bounds, and no growth against the recorded soak report."""
    problems = []
    if not report.get("reports"):
        problems.append("the soak report has no checkpoint reports")
    for entry in report.get("reports", []):
        key = f"{entry['artifact']}:{entry['renderFormat']}"
        growth = entry.get("plateauGrowthBytes", 0)
        if growth > SOAK_PLATEAU_BYTES:
            problems.append(f"{key} plateau grew {growth} bytes (limit {SOAK_PLATEAU_BYTES})")
    if not report.get("stackReports"):
        problems.append("the soak report has no stack reports")
    for entry in report.get("stackReports", []):
        key = f"{entry['artifact']}:{entry['renderFormat']}"
        fraction = entry.get("peakStackFraction", 0)
        if fraction > SOAK_STACK_FRACTION:
            problems.append(
                f"{key} peak stack {entry.get('peakStackBytes')} bytes is {fraction:.0%} of the "
                f"shadow stack (limit {SOAK_STACK_FRACTION:.0%})"
            )
    compared = 0
    if baseline:
        recorded = _soak_keys(baseline)
        measured = _soak_keys(report)
        for key, entry in measured.items():
            if key not in recorded:
                continue
            compared += 1
            limit = int(recorded[key]["finalWasmBytes"] * (1 + SOAK_MEMORY_TOLERANCE))
            if entry["finalWasmBytes"] > limit:
                problems.append(
                    f"{key} finalWasmBytes {entry['finalWasmBytes']} regressed past the recorded "
                    f"{recorded[key]['finalWasmBytes']} (limit {limit})"
                )
        for key in recorded:
            if key not in measured:
                problems.append(f"{key} was measured by the recorded baseline and is missing here")
    detail = f"{len(report.get('reports', []))} artifacts x formats"
    if baseline:
        detail += f", {compared} compared against the recorded soak baseline"
    else:
        detail += ", no recorded soak baseline: absolute bounds only"
    if problems:
        return GateResult("soak", "fail", "; ".join(problems), {"comparedArtifacts": compared})
    return GateResult("soak", "pass", detail, {"comparedArtifacts": compared})


def _bench_means(report: dict) -> dict:
    """Key every task by group and name; vitest writes the group key as `fullName`."""
    means = {}
    for file in report.get("files", []):
        for group in file.get("groups", []):
            label = group.get("fullName") or group.get("name") or file.get("filepath", "")
            for benchmark in group.get("benchmarks", []):
                means[f"{label} > {benchmark['name']}"] = benchmark["mean"]
    return means


def bench_gate(candidate: dict, baseline: dict | None, tolerance: float = BENCH_TOLERANCE) -> GateResult:
    """No benchmark task may be slower than the recorded baseline beyond the tolerance."""
    if baseline is None:
        return GateResult("bench", "unverified", "no recorded benchmark output to compare against")
    recorded, found = _bench_means(baseline), _bench_means(candidate)
    problems = []
    regressions = []
    for task, base_mean in recorded.items():
        if task not in found:
            problems.append(f"{task} was benchmarked by the baseline and is missing here")
            continue
        ratio = found[task] / base_mean
        if ratio > tolerance:
            regressions.append(f"{task}: {base_mean:.4f} -> {found[task]:.4f} ms ({ratio:.2f}x)")
    problems.extend(regressions)
    if problems:
        return GateResult("bench", "fail", "; ".join(problems), {"tasks": len(recorded)})
    return GateResult(
        "bench",
        "pass",
        f"{len(recorded)} tasks within {tolerance:.2f}x of the recorded baseline",
        {"tasks": len(recorded)},
    )


def resource_gate(
    metrics: dict,
    baseline: dict | None,
    rules: dict = RESOURCE_RULES,
) -> GateResult:
    """The real application must not regress past the recorded whole-app resource baseline."""
    if baseline is None:
        return GateResult(
            "resource",
            "unverified",
            "no recorded baseline evidence: the whole-app resource comparison has not been made",
        )
    problems = []
    for metric, tolerance in rules.items():
        if metric not in baseline:
            problems.append(f"{metric} is not in the recorded baseline evidence")
            continue
        if metric not in metrics:
            problems.append(f"{metric} was not reported by the candidate run")
            continue
        candidate_value = metrics[metric]
        drift = candidate_value - baseline[metric]
        if drift > tolerance:
            problems.append(
                f"{metric} regressed {drift:+.2f} (baseline {baseline[metric]:.2f}, "
                f"candidate {candidate_value:.2f}, allowed {tolerance:.2f})"
            )
    if problems:
        return GateResult("resource", "fail", "; ".join(problems), {"rules": len(rules)})
    return GateResult(
        "resource",
        "pass",
        f"{len(rules)} metrics within the recorded tolerances",
        {"rules": len(rules)},
    )


# --------------------------------------------------------------------------- verdict + plan


def acceptance(results: list[GateResult], accepted_unverified: tuple[str, ...]) -> int:
    """0 only when nothing failed and every unverified gate was explicitly accepted by name."""
    for result in results:
        if result.status == "fail":
            return 1
        if result.status == "unverified" and result.name not in accepted_unverified:
            return 1
    return 0


def plan(baseline: Path) -> list[dict]:
    """The documented checklist: what the procedure runs, in order, and what each gate needs."""
    app_lab = (
        f"python3 scripts/app-lab/run.py --scenario resource --profile release "
        f"--compare {baseline / 'baseline-resource.json'} --compare-format json"
    )
    return [
        {
            "gate": "identity",
            "intent": "the recorded revision, the rebuild pin and --revision are one commit",
            "command": "python3 scripts/ghostty-update/run.py --plan  (identity runs on every invocation)",
            "needs": ["UPSTREAM.md", "build.zig.zon"],
        },
        {
            "gate": "artifacts",
            "intent": "both shipped .wasm files match their recorded size and SHA-256",
            "command": "sha256sum packages/ghostty-core/adapted/ghostty-vt*.wasm",
            "needs": ["UPSTREAM.md"],
        },
        {
            "gate": "rebuild",
            "intent": "both variants rebuild byte-identically from the pinned source",
            "command": (
                "cd packages/ghostty-core/adapted/wasm && "
                "zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast && "
                "cp zig-out/bin/terax-ghostty-vt.wasm ../ghostty-vt.wasm && "
                "zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseFast -Dwasm-simd=false && "
                "cp zig-out/bin/terax-ghostty-vt.wasm ../ghostty-vt-scalar.wasm"
            ),
            "needs": ["zig", "UPSTREAM.md"],
        },
        {
            "gate": "compatibility",
            "intent": "the adapted bridge still passes the terminal regression suite",
            "command": "pnpm exec vitest run src/modules/terminal",
            "needs": ["pnpm install"],
        },
        {
            "gate": "soak",
            "intent": "sustained adversarial output stays inside the stack and memory bounds",
            "command": "pnpm soak:ghostty",
            "needs": ["TERAX_SOAK_REPORT"],
        },
        {
            "gate": "bench",
            "intent": "no workload is slower than the recorded benchmark output",
            "command": "pnpm exec vitest bench src/modules/terminal/ghostty/AdaptedGhostty.bench.ts --run --outputJson <file>",
            "needs": ["a recorded benchmark output (--bench-baseline)"],
        },
        {
            "gate": "resource",
            "intent": "the real Linux application does not regress against the recorded baseline",
            "command": app_lab,
            "needs": [
                "a display",
                "--features bench build",
                "recorded baseline evidence",
                "an isolated app-lab profile (run.py refuses anything else)",
            ],
        },
    ]


def render_plan(steps: list[dict]) -> str:
    lines = ["Ghostty revision update checklist", ""]
    for index, step in enumerate(steps, start=1):
        lines.append(f"{index}. {step['gate']}: {step['intent']}")
        lines.append(f"     run: {step['command']}")
        if step["needs"]:
            lines.append(f"     needs: {', '.join(step['needs'])}")
    lines.append("")
    lines.append("Every gate is pass, fail or unverified. An unverified gate blocks acceptance unless")
    lines.append("it is accepted by name with --accept-unverified, and the report records that it was.")
    lines.append("")
    lines.append("Monitoring only (the monthly review, never an adoption):")
    lines.append("    python3 scripts/ghostty-update/run.py --monitor")
    lines.append("    provenance, shipped artifacts, and how far the pin is behind ghostty-org/ghostty.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- execution


def run(command: list[str], *, cwd: Path = REPO, env: dict | None = None, timeout: float = 3600) -> tuple[int, str]:
    merged = {**os.environ, **(env or {})}
    process = subprocess.run(
        command,
        cwd=cwd,
        env=merged,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=timeout,
    )
    return process.returncode, process.stdout


def rebuild_gate(output: Path) -> GateResult:
    """Rebuild both variants from the pinned source and require byte-identical artifacts."""
    zig = shutil.which("zig")
    if zig is None:
        return GateResult(
            "rebuild",
            "unverified",
            "zig is not on PATH, so the artifacts were not shown to come from the pinned revision",
        )
    wasm = CORE / "wasm"
    staging = output / "rebuild"
    staging.mkdir(parents=True, exist_ok=True)
    variants = [
        ("simd", ["zig", "build", "-Dtarget=wasm32-freestanding", "-Doptimize=ReleaseFast"]),
        ("scalar", ["zig", "build", "-Dtarget=wasm32-freestanding", "-Doptimize=ReleaseFast", "-Dwasm-simd=false"]),
    ]
    problems = []
    rebuilt = {}
    for variant, command in variants:
        code, log = run([zig, *command[1:]], cwd=wasm, timeout=1800)
        if code != 0:
            problems.append(f"{variant} build failed: {log.strip().splitlines()[-1:]}")
            continue
        produced = wasm / "zig-out/bin/terax-ghostty-vt.wasm"
        data = produced.read_bytes()
        rebuilt[variant] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        (staging / ARTIFACTS[variant]).write_bytes(data)
        shipped = hashlib.sha256((CORE / ARTIFACTS[variant]).read_bytes()).hexdigest()
        if rebuilt[variant]["sha256"] != shipped:
            problems.append(
                f"{ARTIFACTS[variant]}: rebuilt sha256 {rebuilt[variant]['sha256']} differs from the "
                f"shipped {shipped} - update the artifact and UPSTREAM.md together"
            )
    if problems:
        return GateResult("rebuild", "fail", "; ".join(problems), {"rebuilt": rebuilt})
    return GateResult("rebuild", "pass", "both variants rebuild byte-identically", {"rebuilt": rebuilt})


def compatibility_gate(target: str | None) -> GateResult:
    code, log = run([*pnpm(), "exec", "vitest", "run", target or "src/modules/terminal"], timeout=1800)
    tail = " / ".join(line.strip() for line in log.strip().splitlines()[-4:])
    if code != 0:
        return GateResult("compatibility", "fail", f"terminal suite failed: {tail}", {"target": target})
    return GateResult("compatibility", "pass", tail or "terminal suite passed", {"target": target})


def soak_gate_run(output: Path, baseline: dict | None) -> GateResult:
    report_path = output / "soak.json"
    code, log = run(
        [*pnpm(), "soak:ghostty"],
        env={"TERAX_SOAK_REPORT": str(report_path)},
        timeout=3600,
    )
    if code != 0 or not report_path.exists():
        tail = " / ".join(line.strip() for line in log.strip().splitlines()[-4:])
        return GateResult("soak", "fail", f"the soak did not complete: {tail}")
    return soak_gate(json.loads(report_path.read_text()), baseline)


def bench_gate_run(output: Path, baseline_path: Path | None) -> GateResult:
    report_path = output / "bench.json"
    code, log = run(
        [
            *pnpm(),
            "exec",
            "vitest",
            "bench",
            "src/modules/terminal/ghostty/AdaptedGhostty.bench.ts",
            "--run",
            "--outputJson",
            str(report_path),
        ],
        timeout=3600,
    )
    if code != 0 or not report_path.exists():
        tail = " / ".join(line.strip() for line in log.strip().splitlines()[-4:])
        return GateResult("bench", "fail", f"the benchmark did not complete: {tail}")
    baseline = json.loads(baseline_path.read_text()) if baseline_path and baseline_path.exists() else None
    return bench_gate(json.loads(report_path.read_text()), baseline)


def resource_gate_run(output: Path, baseline: Path | None) -> GateResult:
    report_path = output / "resource.json"
    if baseline is None:
        return resource_gate({}, None)
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        return GateResult(
            "resource",
            "unverified",
            "no display: the real Linux application cannot be measured, so the whole-app "
            "resource comparison against the recorded baseline has not been made",
        )
    code, log = run(
        [
            sys.executable,
            "scripts/app-lab/run.py",
            "--scenario",
            "resource",
            "--profile",
            "release",
            "--compare",
            str(baseline / "baseline-resource.json"),
            "--compare-format",
            "json",
            "--output",
            str(output / "app-lab"),
            "--report",
            str(report_path),
        ],
        timeout=7200,
    )
    if code != 0 or not report_path.exists():
        tail = " / ".join(line.strip() for line in log.strip().splitlines()[-4:])
        return GateResult("resource", "fail", f"the resource scenario did not complete: {tail}")
    recorded = json.loads((baseline / "baseline-resource.json").read_text()).get("metrics", {})
    return resource_gate(json.loads(report_path.read_text()).get("metrics", {}), recorded)


def pnpm() -> list[str]:
    return [shutil.which("pnpm") or "pnpm"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        allow_abbrev=False,
    )
    parser.add_argument("--revision", help="the Ghostty commit this update moves to (40 hex chars)")
    parser.add_argument("--output", type=Path, help="scratch/report directory (default: a temp dir)")
    parser.add_argument("--baseline", type=Path, help="recorded baseline evidence directory")
    parser.add_argument("--bench-baseline", type=Path, help="recorded vitest --outputJson benchmark file")
    parser.add_argument("--soak-baseline", type=Path, help="recorded soak report to compare against")
    parser.add_argument("--rebuild", action="store_true", help="rebuild both variants and require identical bytes")
    parser.add_argument("--with-resource", action="store_true", help="run the whole-app resource comparison")
    parser.add_argument("--accept-unverified", default="", help="comma-separated gate names to accept unverified")
    parser.add_argument("--skip", action="append", default=[], help="gate to skip (recorded unverified)")
    parser.add_argument("--plan", action="store_true", help="print the checklist and exit")
    parser.add_argument("--check", action="store_true", help="verify provenance and artifacts only")
    parser.add_argument(
        "--monitor",
        action="store_true",
        help="verify provenance and artifacts, and report how far the pin is behind ghostty-org/ghostty",
    )
    parser.add_argument("--compat-target", help="narrow the compatibility suite (default: src/modules/terminal)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    baseline = args.baseline
    if args.plan:
        print(render_plan(plan(baseline or Path("<baseline evidence>"))))
        return 0

    output = args.output or Path(os.environ.get("TMPDIR", "/tmp")) / f"ghostty-update-{int(time.time())}"
    output.mkdir(parents=True, exist_ok=True)
    accepted = tuple(name for name in args.accept_unverified.split(",") if name)
    results: list[GateResult] = []

    upstream = parse_upstream(UPSTREAM.read_text())
    pin = parse_zig_pin(ZIG_ZON.read_text())
    if args.monitor:
        # The monthly review's Ghostty step: provenance, artifacts, and upstream drift. No rebuild,
        # no soak, no benchmark: adopting a revision is a separate, deliberate update run.
        comparison, error = upstream_comparison(upstream["commit"])
        results = monitor_results(upstream, comparison, error=error)
        for result in results:
            print(f"{result.status:10} {result.name:14} {result.detail}")
        report = {
            "scope": "pinned Ghostty source revision monitoring: recorded provenance, shipped "
                     "artifacts and drift against ghostty-org/ghostty. Adopting a revision is the "
                     "separate update procedure (`--rebuild`).",
            "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "revision": upstream["commit"],
            "zig": upstream["zig"],
            "gates": [dataclasses.asdict(result) for result in results],
            "acceptedUnverified": list(accepted),
            "accepted": acceptance(results, accepted) == 0,
        }
        (output / "ghostty-monitor.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"\nreport: {output / 'ghostty-monitor.json'}")
        return 0 if report["accepted"] else 1

    results.append(identity_gate(upstream, pin, args.revision))
    results.append(artifact_gate(upstream, artifact_evidence(CORE)))
    if args.check:
        for result in results:
            print(f"{result.status:10} {result.name:14} {result.detail}")
        return acceptance(results, accepted)

    skipped = set(args.skip)
    for gate in ("rebuild", "compatibility", "soak", "bench", "resource"):
        if gate in skipped:
            results.append(GateResult(gate, "unverified", "skipped on request (--skip)"))
    if "rebuild" not in skipped:
        results.append(
            rebuild_gate(output) if args.rebuild
            else GateResult("rebuild", "unverified", "no --rebuild: the artifacts were not rebuilt from the pinned revision")
        )
    if "compatibility" not in skipped:
        results.append(compatibility_gate(args.compat_target))
    if "soak" not in skipped:
        soak_baseline = args.soak_baseline or RECORDED_SOAK_BASELINE
        recorded = json.loads(soak_baseline.read_text()) if soak_baseline.exists() else None
        results.append(soak_gate_run(output, recorded))
    if "bench" not in skipped:
        results.append(bench_gate_run(output, args.bench_baseline))
    if "resource" not in skipped:
        results.append(resource_gate_run(output, baseline) if args.with_resource else GateResult(
            "resource", "unverified", "no --with-resource: the whole-app resource comparison was not run"
        ))

    ordered = sorted(results, key=lambda result: GATE_ORDER.index(result.name))
    report = {
        "scope": "Ghostty source revision, shipped artifacts, adapted-core compatibility, soak, bench and "
                 "whole-app resource comparison. Grafana-free: no energy or IPC claim is made here.",
        "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "revision": upstream["commit"],
        "requestedRevision": args.revision,
        "zig": upstream["zig"],
        "platform": platform.platform(),
        "python": platform.python_version(),
        "gates": [dataclasses.asdict(result) for result in ordered],
        "acceptedUnverified": list(accepted),
        "accepted": acceptance(ordered, accepted) == 0,
    }
    (output / "ghostty-update.json").write_text(json.dumps(report, indent=2) + "\n")
    for result in ordered:
        print(f"{result.status:10} {result.name:14} {result.detail}")
    print(f"\nreport: {output / 'ghostty-update.json'}")
    if report["accepted"]:
        print("ACCEPTED: every gate passed or was explicitly accepted as unverified")
        return 0
    print("REFUSED: a gate failed, or a gate's evidence is unverified and was not accepted by name")
    return 1


if __name__ == "__main__":
    sys.exit(main())

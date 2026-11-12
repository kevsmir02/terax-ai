"""Metrics, human summary and comparison for the Linux app-lab reports.

The macOS runner derives its numbers from `footprint`/`vmmap`/rusage; a Linux report carries
`memory` samples (`linux_proc.sample`), a 1 Hz `series` timeline and a `startup` table. This
module turns those into flat, comparable metric names (the same names `--compare` prints) and a
human summary. It never invents a figure: an absent sample yields no metric.

Metric naming, stable across runs so a baseline JSON stays comparable after a feature is removed:

    startup.cold.exec_to_boot_ms      process start -> the scenario's boot milestone
    startup.cold.nav_to_boot_ms       navigation start -> the boot milestone (page clock)
    startup.cold.first_paint_ms       first contentful paint from navigation start
    startup.warm.*                    median of the warm relaunches
    mem.<phase>.app_pss_mib           app's own processes, sum of Pss (shared counted once)
    mem.<phase>.workload_pss_mib      PTY shells/agents, reported separately, never added
    mem.<phase>.total_pss_mib         app + workload
    mem.<phase>.total_rss_mib         naive sum of Rss: kept to show the shared-page overcount
    mem.<phase>.rss_overcount_mib     total_rss - total_pss
    mem.<phase>.<role>_pss_mib        per role (host, web_content, gpu, networking, workload)
    timeline.pss_p95_mib              the 1 Hz timeline, not a single event's snapshot
    timeline.cpu_pct.app_total        CPU% of one core over the timeline, app only
"""

from __future__ import annotations

import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(HERE.parent / "renderer-profile") not in sys.path:
    sys.path.insert(0, str(HERE.parent / "renderer-profile"))

import lab_report  # noqa: E402
import linux_proc  # noqa: E402

MIB = linux_proc.MIB

# Phases every summary prints, in order (after them, any phase present in the report).
KEY_PHASES = (
    "blank", "booted", "idle", "setup", "space-a", "space-b", "baseline", "measure-start", "stream-start",
    "stream-end", "measure-end", "cycles-complete", "end+10s", "end+30s",
)
# The metric families this module produces, for `run.py --list-metrics` and for anyone writing a
# comparison after a feature is removed. `<phase>` is a scenario phase and `<role>` a process role.
METRIC_NAMES = (
    "startup.cold.exec_to_nav_ms", "startup.cold.nav_to_boot_ms", "startup.cold.exec_to_boot_ms",
    "startup.cold.first_paint_ms", "startup.warm_median.exec_to_boot_ms",
    "mem.<phase>.total_pss_mib", "mem.<phase>.app_pss_mib", "mem.<phase>.workload_pss_mib",
    "mem.<phase>.total_rss_mib", "mem.<phase>.rss_overcount_mib", "mem.<phase>.total_private_mib",
    "mem.<phase>.swap_mib", "mem.<phase>.threads", "mem.<phase>.processes", "mem.<phase>.fds",
    "mem.<phase>.<role>_pss_mib", "mem.<phase>.<role>_processes",
    "mem.peak_total_pss_mib", "mem.peak_app_pss_mib",
    "timeline.samples", "timeline.seconds", "timeline.app_pss_mean_mib", "timeline.app_pss_p95_mib",
    "timeline.total_pss_max_mib", "timeline.workload_pss_mean_mib",
    "timeline.cpu_pct.<role>", "timeline.cpu_pct.app_total", "timeline.cpu_pct.total",
    "delta.measure.total_pss_mib", "delta.settle.total_pss_mib",
    "delta.baseline_to_end.total_pss_mib", "delta.baseline_to_settle.total_pss_mib",
    "delta.stream.app_pss_mib",
    "cycles.visible_mean_mib", "cycles.visible_max_mib", "cycles.visible_growth_mib_per_cycle",
    "cycles.hidden_mean_mib", "cycles.hidden_max_mib", "cycles.hidden_growth_mib_per_cycle",
    "close.open_mean_mib", "close.closed_mean_mib", "close.last_closed_mib",
    "close.retained_vs_baseline_mib", "close.per_cycle_mean_mib",
)


def samples(report: dict) -> list[dict]:
    return [sample for sample in report.get("samples") or [] if "memory" in sample]


def is_linux_report(report: dict) -> bool:
    """A report produced by the Linux/WebKitGTK sampler (memory samples or the linux block)."""
    return bool(report.get("linux")) or any("memory" in sample for sample in report.get("samples") or [])


def internals(report: dict) -> dict:
    return report.get("linux") or {}


def phase_of(sample: dict) -> str:
    return sample.get("phase") or (sample.get("event") or {}).get("phase", "")


def by_phase(report: dict) -> dict[str, dict]:
    return {phase_of(sample): sample for sample in samples(report)}


def memory(sample: dict) -> dict:
    return sample["memory"]


def mib(value: float | int | None) -> float | None:
    return None if value is None else value / MIB


def role_pss_mib(sample: dict, role: str) -> float | None:
    entry = (memory(sample).get("byRole") or {}).get(role)
    return None if entry is None else entry["pss"] / MIB


def roles_in(report: dict) -> list[str]:
    seen = {role for sample in samples(report) for role in sample["memory"].get("byRole") or {}}
    return [role for role in linux_proc.ROLE_ORDER if role in seen] + sorted(seen - set(linux_proc.ROLE_ORDER))


# ---------------------------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------------------------


def _memory_metrics(metrics: dict, name: str, sample: dict) -> None:
    found = memory(sample)
    metrics[f"mem.{name}.total_pss_mib"] = mib(found["total"]["pss"]) or 0.0
    metrics[f"mem.{name}.app_pss_mib"] = mib(found["app"]["pss"]) or 0.0
    metrics[f"mem.{name}.workload_pss_mib"] = mib(found["workload"]["pss"]) or 0.0
    metrics[f"mem.{name}.total_rss_mib"] = mib(found["total"]["rss"]) or 0.0
    metrics[f"mem.{name}.rss_overcount_mib"] = mib(found["total"]["rssOvercount"]) or 0.0
    metrics[f"mem.{name}.total_private_mib"] = mib(found["total"]["private"]) or 0.0
    metrics[f"mem.{name}.swap_mib"] = mib(found["total"]["swap"]) or 0.0
    metrics[f"mem.{name}.threads"] = found["total"]["threads"]
    metrics[f"mem.{name}.processes"] = found["total"]["processes"]
    metrics[f"mem.{name}.fds"] = found["total"]["fds"]
    for role, entry in (found.get("byRole") or {}).items():
        metrics[f"mem.{name}.{role}_pss_mib"] = entry["pss"] / MIB
        metrics[f"mem.{name}.{role}_processes"] = entry["processes"]


def _startup_metrics(metrics: dict, report: dict) -> None:
    for entry in report.get("startup") or []:
        kind = entry.get("kind")
        if not kind:
            continue
        for field in ("exec_to_boot_ms", "exec_to_nav_ms", "nav_to_boot_ms", "first_paint_ms", "dom_content_loaded_ms", "load_ms"):
            value = entry.get(field)
            if isinstance(value, (int, float)):
                metrics[f"startup.{kind}.{field}"] = float(value)
        metrics[f"startup.{kind}.launches"] = metrics.get(f"startup.{kind}.launches", 0) + 1
    # Medians over repeated warm launches are the comparable warm figure.
    warm = [entry for entry in report.get("startup") or [] if entry.get("kind") == "warm"]
    for field in ("exec_to_boot_ms", "nav_to_boot_ms", "first_paint_ms"):
        values = [entry[field] for entry in warm if isinstance(entry.get(field), (int, float))]
        if values:
            metrics[f"startup.warm_median.{field}"] = round(statistics.median(values), 3)


def _timeline_metrics(metrics: dict, report: dict, prefix: str = "timeline") -> None:
    series = report.get("series") or []
    if not series:
        return
    app = [entry["app"]["pss"] / MIB for entry in series]
    total = [entry["total"]["pss"] / MIB for entry in series]
    workload = [entry["workload"]["pss"] / MIB for entry in series]
    metrics[f"{prefix}.samples"] = len(series)
    metrics[f"{prefix}.seconds"] = round((series[-1]["tMonoNs"] - series[0]["tMonoNs"]) / 1e9, 3)
    for name, values in (("app_pss", app), ("total_pss", total), ("workload_pss", workload)):
        curve = linux_proc.curve(values)
        for field in ("mean", "p50", "p95", "max"):
            metrics[f"{prefix}.{name}_{field}_mib"] = curve[field]
    found = linux_proc.rates(series)
    for role, value in (found.get("cpu_pct") or {}).items():
        metrics[f"{prefix}.cpu_pct.{role}"] = value
    metrics[f"{prefix}.cpu_pct.app_total"] = found["cpu_pct_app_total"]
    metrics[f"{prefix}.cpu_pct.total"] = found["cpu_pct_total"]
    metrics[f"{prefix}.cpu_percent_intervals"] = found["intervals"]


def _segment_metrics(metrics: dict, report: dict) -> None:
    """CPU and wall time between consecutive event samples (e.g. booted -> idle).

    Each sample carries the cumulative utime+stime of every role, so the difference over a known
    span is a real per-phase average (idle terminal, streaming window, hide cycle), independent of
    the 1 Hz whole-run timeline.
    """
    ordered = samples(report)
    for before, after in zip(ordered, ordered[1:]):
        seconds = (after["tMonoNs"] - before["tMonoNs"]) / 1e9
        if seconds <= 0:
            continue
        name = f"{phase_of(before)}->{phase_of(after)}"
        roles = set(memory(before).get("byRole") or {}) | set(memory(after).get("byRole") or {})
        cpu: dict[str, float] = {}
        for role in roles:
            first = ((memory(before).get("byRole") or {}).get(role) or {}).get("cpuSeconds")
            second = ((memory(after).get("byRole") or {}).get(role) or {}).get("cpuSeconds")
            if first is None or second is None:
                continue
            delta = float(second) - float(first)
            if delta > 0:
                cpu[role] = 100.0 * delta / seconds
        if not cpu:
            continue
        metrics[f"segment.{name}.seconds"] = round(seconds, 3)
        for role, value in sorted(cpu.items()):
            metrics[f"segment.{name}.cpu_pct.{role}"] = round(value, 3)
        metrics[f"segment.{name}.cpu_pct.app_total"] = round(
            sum(value for role, value in cpu.items() if role in linux_proc.APP_ROLES), 3
        )


def _interval_memory(metrics: dict, name: str, start: dict, end: dict) -> None:
    before, after = memory(start), memory(end)
    metrics[f"delta.{name}.total_pss_mib"] = (after["total"]["pss"] - before["total"]["pss"]) / MIB
    metrics[f"delta.{name}.app_pss_mib"] = (after["app"]["pss"] - before["app"]["pss"]) / MIB
    metrics[f"delta.{name}.workload_pss_mib"] = (after["workload"]["pss"] - before["workload"]["pss"]) / MIB
    for role in set(before.get("byRole") or {}) | set(after.get("byRole") or {}):
        first = (before.get("byRole") or {}).get(role) or {}
        second = (after.get("byRole") or {}).get(role) or {}
        delta = (second.get("pss", 0) - first.get("pss", 0)) / MIB
        if abs(delta) >= 0.05:
            metrics[f"delta.{name}.{role}_pss_mib"] = delta


def compute_metrics(report: dict) -> dict[str, float]:
    """Flat metric dict; safe on a partial (incomplete) report."""
    metrics: dict[str, float] = {}
    found = by_phase(report)
    for phase, sample in found.items():
        _memory_metrics(metrics, phase, sample)
    _startup_metrics(metrics, report)
    _timeline_metrics(metrics, report)
    _segment_metrics(metrics, report)
    for start, end, name in (
        ("measure-start", "measure-end", "measure"),
        ("measure-end", "end+30s", "settle"),
        ("baseline", "measure-end", "baseline_to_end"),
        ("baseline", "end+30s", "baseline_to_settle"),
    ):
        if start in found and end in found:
            _interval_memory(metrics, name, found[start], found[end])

    hidden = [(index, sample) for index, sample in enumerate(samples(report)) if "-hidden" in phase_of(sample)]
    visible = [sample for sample in samples(report) if "-visible" in phase_of(sample) or "-shown" in phase_of(sample)]
    if visible:
        values = [memory(sample)["total"]["pss"] / MIB for sample in visible]
        metrics["cycles.visible_mean_mib"] = statistics.fmean(values)
        metrics["cycles.visible_max_mib"] = max(values)
        fit = lab_report.slope(list(range(len(values))), values)
        if fit is not None:
            metrics["cycles.visible_growth_mib_per_cycle"] = fit
    if hidden:
        values = [memory(sample)["total"]["pss"] / MIB for _, sample in hidden]
        metrics["cycles.hidden_mean_mib"] = statistics.fmean(values)
        metrics["cycles.hidden_max_mib"] = max(values)
        fit = lab_report.slope(list(range(len(values))), values)
        if fit is not None:
            metrics["cycles.hidden_growth_mib_per_cycle"] = fit

    opened = [sample for sample in samples(report) if phase_of(sample).startswith("close-cycle-") and phase_of(sample).endswith("-open")]
    closed = [sample for sample in samples(report) if phase_of(sample).startswith("close-cycle-") and phase_of(sample).endswith("-closed")]
    if opened and closed:
        baseline = found.get("baseline") or found.get("measure-start")
        open_values = [memory(sample)["total"]["pss"] / MIB for sample in opened]
        closed_values = [memory(sample)["total"]["pss"] / MIB for sample in closed]
        metrics["close.open_mean_mib"] = statistics.fmean(open_values)
        metrics["close.closed_mean_mib"] = statistics.fmean(closed_values)
        metrics["close.last_closed_mib"] = closed_values[-1]
        if baseline is not None:
            metrics["close.retained_vs_baseline_mib"] = closed_values[-1] - memory(baseline)["total"]["pss"] / MIB
        metrics["close.per_cycle_mean_mib"] = statistics.fmean(
            after - before for before, after in zip(open_values, closed_values)
        )

    stream_start, stream_end = found.get("stream-start"), found.get("stream-end")
    if stream_start and stream_end:
        _interval_memory(metrics, "stream", stream_start, stream_end)
    peak = max(samples(report), key=lambda sample: memory(sample)["total"]["pss"], default=None)
    if peak is not None:
        metrics["mem.peak_total_pss_mib"] = memory(peak)["total"]["pss"] / MIB
        metrics["mem.peak_app_pss_mib"] = memory(peak)["app"]["pss"] / MIB
    return metrics


def round_metrics(metrics: dict) -> dict:
    return {name: round(value, 4) if isinstance(value, float) else value for name, value in metrics.items()}


# ---------------------------------------------------------------------------------------------
# Human summary
# ---------------------------------------------------------------------------------------------


def _m(value: float | None, digits: int = 1) -> str:
    return "-" if value is None else f"{value:,.{digits}f}"


def _memory_table(report: dict) -> str:
    present = by_phase(report)
    roles = roles_in(report)
    order = [phase for phase in KEY_PHASES if phase in present]
    order += [phase for phase in present if phase not in order and not phase.startswith("cycle-")]
    headers = ["phase", "processes", "threads"] + [linux_proc.ROLE_LABEL.get(role, role) for role in roles] + ["APP PSS", "workload", "TOTAL PSS", "TOTAL RSS", "overcount"]
    rows = []
    previous: float | None = None
    for phase in order:
        sample = present[phase]
        found = memory(sample)
        total = found["total"]["pss"] / MIB
        rows.append(
            [phase, str(found["total"]["processes"]), str(found["total"]["threads"])]
            + [_m(role_pss_mib(sample, role)) for role in roles]
            + [
                _m(found["app"]["pss"] / MIB),
                _m(found["workload"]["pss"] / MIB),
                _m(total) + ("" if previous is None else f" ({total - previous:+.1f})"),
                _m(found["total"]["rss"] / MIB),
                _m(found["total"]["rssOvercount"] / MIB),
            ]
        )
        previous = total
    return lab_report.table(headers, rows)


def _startup_table(report: dict) -> str:
    entries = report.get("startup") or []
    if not entries:
        return "  (no startup measurement in this report)"
    headers = ["launch", "profile", "exec->nav ms", "nav->boot ms", "exec->boot ms", "first paint ms", "FCP ms", "DOMContentLoaded ms", "load ms", "boot PSS MiB"]
    rows = []
    for entry in entries:
        rows.append([
            str(entry.get("launch", "-")), entry.get("kind", "-"),
            _m(entry.get("exec_to_nav_ms"), 0), _m(entry.get("nav_to_boot_ms"), 0),
            _m(entry.get("exec_to_boot_ms"), 0), _m(entry.get("first_paint_ms"), 0),
            _m(entry.get("first_contentful_paint_ms"), 0),
            _m(entry.get("dom_content_loaded_ms"), 0), _m(entry.get("load_ms"), 0),
            _m(entry.get("pssMiB"), 1),
        ])
    return lab_report.table(headers, rows)


def _timeline_table(report: dict) -> str:
    series = report.get("series") or []
    if not series:
        return "  (no timeline in this report)"
    rates = linux_proc.rates(series)
    lines = [
        f"  {len(series)} samples over {rates['seconds']:.1f} s at "
        f"{internals(report).get('pollIntervalS', '-')} s; CPU% is of one core, from cumulative "
        f"utime+stime deltas (app total excludes workload)"
    ]
    columns = [f"{linux_proc.ROLE_LABEL.get(role, role)} {value:.1f}%" for role, value in (rates.get("cpu_pct") or {}).items()]
    lines.append("  CPU: " + (", ".join(columns) if columns else "no CPU counters") + f"; app total {rates['cpu_pct_app_total']:.1f}%")
    curve = linux_proc.curve([entry["total"]["pss"] / MIB for entry in series])
    app = linux_proc.curve([entry["app"]["pss"] / MIB for entry in series])
    workload = linux_proc.curve([entry["workload"]["pss"] / MIB for entry in series])
    lines.append(
        f"  PSS MiB: total mean {curve['mean']:.1f} p95 {curve['p95']:.1f} max {curve['max']:.1f}; "
        f"app mean {app['mean']:.1f} p95 {app['p95']:.1f}; workload mean {workload['mean']:.1f}"
    )
    loads = [entry.get("loadAverage", [0])[0] for entry in series]
    if loads:
        lines.append(f"  load average during the timeline: mean {statistics.fmean(loads):.2f}, max {max(loads):.2f}")
    return "\n".join(lines)


def summarize(report: dict) -> str:
    config = report.get("config") or {}
    environment = report.get("environment") or {}
    found = by_phase(report)
    metrics = compute_metrics(report)
    out = [f"== app lab (Linux): {config.get('scenario')}{('/' + config['variant']) if config.get('variant') else ''} ==" + (f" [{config.get('label')}]" if config.get("label") else "")]
    out.append(
        f"  source {str(report.get('sourceRevision'))[:12]}  profile {config.get('profile')}  "
        f"qualified: {(report.get('qualification') or {}).get('qualified', 'n/a')}"
    )
    workload = report.get("workload") or internals(report).get("workload") or ""
    if isinstance(workload, dict):
        workload = workload.get("description", "")
    if workload:
        out.append(f"  workload: {workload}")
    roles = report.get("linux", {}).get("roles") or []
    if roles:
        out.append(f"  process roles the sampler knows: {', '.join(roles)}")
    isolation = report.get("isolation") or {}
    if isolation:
        out.append(
            f"  isolation: identifier {isolation.get('identifier')}, benchIsolated "
            f"{isolation.get('benchIsolated')}, profile verified {isolation.get('profileVerified')}, "
            f"namespace {isolation.get('namespaceIsolation')}, upstream unchanged "
            f"{isolation.get('upstreamStateUnchanged')}, binary identifier "
            f"{report.get('appIdentifier')}"
        )
    if internals(report).get("workloadFiles"):
        out.append(f"  fixtures: {', '.join(internals(report)['workloadFiles'])}")
    out.append("")
    out.append("Startup (cold = fresh disposable profile; warm = same profile relaunched):")
    out.append(_startup_table(report))
    out.append("")
    out.append("Whole-application memory (MiB; PSS counts each shared page once, RSS is the naive sum):")
    out.append(_memory_table(report))
    out.append("")
    out.append("Timeline and CPU:")
    out.append(_timeline_table(report))
    cycles = [phase for phase in found if phase.startswith("cycle-")]
    if cycles:
        out.append("")
        out.append(
            f"Hidden/show cycles: {len([phase for phase in cycles if phase.endswith('-hidden')])} hide holds, "
            f"{len([phase for phase in cycles if phase.endswith('-visible')])} shows; "
            f"visible mean {_m(metrics.get('cycles.visible_mean_mib'))} MiB, "
            f"hidden mean {_m(metrics.get('cycles.hidden_mean_mib'))} MiB, "
            f"visible growth {_m(metrics.get('cycles.visible_growth_mib_per_cycle'), 2)} MiB/cycle"
        )
    close_cycles = sorted(phase for phase in found if phase.startswith("close-cycle-"))
    if close_cycles:
        out.append(
            f"Close cycles: {len(close_cycles)} samples; open mean {_m(metrics.get('close.open_mean_mib'))} MiB, "
            f"closed mean {_m(metrics.get('close.closed_mean_mib'))} MiB, last closed "
            f"{_m(metrics.get('close.last_closed_mib'))} MiB, retained vs baseline "
            f"{_m(metrics.get('close.retained_vs_baseline_mib'))} MiB"
        )
    package = report.get("package") or {}
    if package:
        out.append("")
        out.append("Package/build size (observable without packaging):")
        for key, value in package.items():
            if isinstance(value, int):
                out.append(f"  {key}: {value / MIB:.1f} MiB ({value} bytes)")
            elif isinstance(value, str):
                out.append(f"  {key}: {value}")
    limits = report.get("limitations") or []
    if limits:
        out.append("")
        out.append("Limitations (explicit, not measured or not claimed):")
        for line in limits:
            out.append(f"  - {line}")
    advisories = (report.get("qualification") or {}).get("advisories") or []
    for advisory in advisories:
        out.append(f"\nADVISORY: {advisory}")
    load = report.get("environment") or {}
    out.append("")
    out.append(
        f"  host: {load.get('cpu', '?')} / {load.get('logicalCpus', '?')} CPUs / "
        f"{int(load.get('memoryBytes') or 0) / 2**30:.1f} GiB; {load.get('os', '?')} {load.get('kernel', '?')}; "
        f"session {load.get('session', '?')} ({load.get('desktop', '?')}); "
        f"load average start {load.get('loadAverageStart')} end {load.get('loadAverageEnd')}"
    )
    out.append(f"  scope: {report.get('scope')}")
    return "\n".join(out)


# ---------------------------------------------------------------------------------------------
# Comparison (usable after feature removal: two JSON files in, one line per metric out)
# ---------------------------------------------------------------------------------------------


def _fmt(value: float | None) -> str:
    if value is None:
        return "-"
    return f"{value:,.2f}" if abs(value) < 100000 else f"{value:,.0f}"


def medians(reports: list[dict]) -> dict[str, float]:
    per_report = [compute_metrics(report) for report in reports]
    names = [name for name in per_report[0] if all(name in other for other in per_report)]
    return {name: statistics.median(metrics[name] for metrics in per_report) for name in names}


def compare_rows(baseline: list[dict], candidate: list[dict]) -> list[list[str]]:
    base, cand = medians(baseline), medians(candidate)
    names = list(base) + [name for name in cand if name not in base]
    rows = []
    for name in names:
        a, b = base.get(name), cand.get(name)
        if not isinstance(a, (int, float)) and not isinstance(b, (int, float)):
            continue
        delta = None if a is None or b is None else b - a
        percent = "" if delta is None or not a else f"{100 * delta / abs(a):+.1f}%"
        rows.append([name, _fmt(a), _fmt(b), "-" if delta is None else f"{delta:+,.2f}", percent])
    return rows


def compare_text(baseline: list[dict], candidate: list[dict]) -> str:
    first, second = baseline[0], candidate[0]
    scenario = (first.get("config") or {}).get("scenario")
    lines = [
        f"== comparison (Linux): {scenario} "
        f"(baseline {str(first.get('sourceRevision'))[:10]} x{len(baseline)} -> "
        f"candidate {str(second.get('sourceRevision'))[:10]} x{len(candidate)}; medians when repeated) =="
    ]
    if scenario != (second.get("config") or {}).get("scenario"):
        lines.append("  warning: scenarios differ; matching metric names only")
    if (first.get("config") or {}).get("scenarioVariant") != (second.get("config") or {}).get("scenarioVariant"):
        lines.append("  warning: workload configuration differs")
    lines.append(lab_report.table(["metric", "baseline", "candidate", "delta", "%"], compare_rows(baseline, candidate)))
    return "\n".join(lines)


def compare_tsv(baseline: list[dict], candidate: list[dict]) -> str:
    lines = ["metric\tbaseline\tcandidate\tdelta\tpercent"]
    lines += ["\t".join(row) for row in compare_rows(baseline, candidate)]
    return "\n".join(lines)


def compare_json(baseline: list[dict], candidate: list[dict]) -> str:
    import json

    base, cand = medians(baseline), medians(candidate)
    names = [name for name in list(base) + [name for name in cand if name not in base] if isinstance(name, str)]
    rows = {name: {"baseline": base.get(name), "candidate": cand.get(name)} for name in names}
    return json.dumps({"baseline": base, "candidate": cand, "metrics": rows}, indent=1, sort_keys=True) + "\n"


def compare(baseline, candidate, format: str = "text") -> str:
    baselines = baseline if isinstance(baseline, list) else [baseline]
    candidates = candidate if isinstance(candidate, list) else [candidate]
    if format == "tsv":
        return compare_tsv(baselines, candidates)
    if format == "json":
        return compare_json(baselines, candidates)
    return compare_text(baselines, candidates)

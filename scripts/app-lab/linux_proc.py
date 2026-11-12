"""Whole-application process accounting on Linux, from `/proc` only (no root, no ptrace).

The macOS runner reads `footprint -j` / `vmmap` / rusage; WebKitGTK has no such tooling, so this
module samples the same facts from procfs:

* **Memory** from `/proc/<pid>/smaps_rollup`: `Pss` (proportional set size) is the figure that
  does not double count shared pages; `Rss` is kept too because it is what a user sees in `top`,
  but summing it across the app's processes counts every shared page many times. The report keeps
  both and states which one the total means.
* **CPU** from `/proc/<pid>/stat` (`utime`+`stime`, `CLK_TCK` ticks), **threads** from stat,
  **open descriptors** from `/proc/<pid>/fd`.
* **Roles** by command name: the host (`terax`), WebKitGTK helpers (`WebKitWebProcess`,
  `WebKitNetworkProcess`, `WebKitGPUProcess`, compared by prefix because `/proc/<pid>/comm`
  truncates to 15 bytes), the WebKit sandbox wrapper (`bwrap`), and everything else under the
  host — PTY shells, the synthetic agent, the streaming fixture — as **workload**. Workload is
  reported separately and never folded into the app's own total.

Only descendants of the host pid are considered, so another user's browser, the compositor or a
stray process cannot enter a measurement. A process that exits between the `/proc` scan and the
read is skipped rather than reported as zero.

The parsers and aggregations are pure functions (unit-tested in `scripts/tests/test_linux_proc.py`);
`sample()` and `Poller` are the only code that touches the filesystem.
"""

from __future__ import annotations

import os
import re
import threading
import time

MIB = 1048576.0

# Roles the app owns. `sandbox` is WebKitGTK's bwrap wrapper around a web process: it is app
# infrastructure, not external work.
APP_ROLES = ("host", "web_content", "web_content_prewarmed", "gpu", "networking", "sandbox")
WORKLOAD_ROLE = "workload"
ROLES = APP_ROLES + (WORKLOAD_ROLE,)
ROLE_LABEL = {
    "host": "host",
    "web_content": "WebContent",
    "web_content_prewarmed": "WC-prewarm",
    "gpu": "GPU",
    "networking": "Network",
    "sandbox": "sandbox",
    "workload": "PTY-procs",
}
# Order used in tables; any role not listed is appended in first-seen order.
ROLE_ORDER = list(ROLES)

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


# ---------------------------------------------------------------------------------------------
# Pure parsers
# ---------------------------------------------------------------------------------------------

_SMAPS_LINE = re.compile(r"^([A-Za-z0-9_()]+):\s+(\d+)\s+kB$")


def parse_smaps_rollup(text: str) -> dict[str, int]:
    """`/proc/<pid>/smaps_rollup` as a dict of byte counts (only the fields the kernel printed).

    Lines are `Key:   <n> kB`. `Pss_Anon`/`Pss_File`/`Pss_Shmem` share the `Pss` prefix, so the
    key is matched exactly (up to the colon) instead of by prefix. Unknown/numeric-only lines
    (`THPeligible:`, `ProtectionKey:`) are ignored because they carry no `kB` unit.
    """
    values: dict[str, int] = {}
    for line in text.splitlines():
        match = _SMAPS_LINE.match(line.strip())
        if match:
            values[match.group(1)] = int(match.group(2)) * 1024
    return values


def memory_of(smaps: dict[str, int]) -> dict[str, int]:
    """The memory figures a report rows up: pss, rss, private, shared, swap, shared-overcount.

    `private` is what no other process can see (private clean+dirty+hugetlb); `shared` is the
    resident shared pages before proportional splitting; `rss_overcount` is `rss - pss`, i.e. how
    much a naive sum of Rss over the app's processes would overstate unique memory.
    """
    private = smaps.get("Private_Clean", 0) + smaps.get("Private_Dirty", 0) + smaps.get("Private_Hugetlb", 0)
    shared = smaps.get("Shared_Clean", 0) + smaps.get("Shared_Dirty", 0) + smaps.get("Shared_Hugetlb", 0)
    pss = smaps.get("Pss", 0)
    rss = smaps.get("Rss", 0)
    return {
        "pss": pss,
        "rss": rss,
        "private": private,
        "shared": shared,
        # `Swap` is the resident swap of this process; `SwapPss` is its proportional share and is
        # not added, so swap follows the same private-first convention as the resident figures.
        "swap": smaps.get("Swap", 0),
        "rssOvercount": max(0, rss - pss),
        "anon": smaps.get("Anonymous", 0),
    }


def parse_stat(text: str) -> dict[str, int] | None:
    """The numeric fields of `/proc/<pid>/stat` this module needs.

    `comm` is in parentheses and may itself contain spaces and parentheses, so parsing starts
    after the *last* `)`; from there field 3 (state) is index 0: ppid=1, utime=11, stime=12,
    num_threads=17, starttime=19, vsize=20, rss=21 (in pages).
    """
    end = text.rfind(")")
    if end < 0:
        return None
    rest = text[end + 1:].split()
    if len(rest) < 22:
        return None
    try:
        return {
            "ppid": int(rest[1]),
            "utime": int(rest[11]),
            "stime": int(rest[12]),
            "threads": int(rest[17]),
            "starttime": int(rest[19]),
            "vsize": int(rest[20]),
            "rssPages": int(rest[21]),
        }
    except ValueError:
        return None


def cpu_seconds(stat: dict[str, int]) -> float:
    return (stat["utime"] + stat["stime"]) / CLK_TCK


def command_of(cmdline: bytes, comm: str = "") -> str:
    """Basename of argv[0], falling back to comm (kernel threads have an empty cmdline)."""
    first = next((part for part in cmdline.split(b"\0") if part), b"")
    if first:
        text = first.decode("utf-8", "replace")
        return text.rsplit("/", 1)[-1]
    return comm.strip()


_HELPER_ROLES = (
    ("WebKitWebProces", "web_content"),
    ("WebKitNetworkPr", "networking"),
    ("WebKitGPUProces", "gpu"),
)


def role_of(command: str, pid: int, host_pid: int) -> str:
    """Role of one process. Prefix matching covers both the full cmdline name and comm's 15 bytes."""
    if pid == host_pid:
        return "host"
    for prefix, role in _HELPER_ROLES:
        if command.startswith(prefix):
            return role
    if command == "bwrap" or command.startswith("bwrap "):
        return "sandbox"
    return WORKLOAD_ROLE


def role_order(seen) -> list[str]:
    """Known roles in table order, then any unexpected role by name."""
    seen = set(seen)
    return [role for role in ROLE_ORDER if role in seen] + sorted(seen - set(ROLE_ORDER))


def descendants(table: dict[int, int], root: int) -> list[int]:
    """Every transitive child of `root` in a `pid -> ppid` table (root excluded)."""
    children: dict[int, list[int]] = {}
    for pid, ppid in table.items():
        children.setdefault(ppid, []).append(pid)
    found: list[int] = []
    stack = [root]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


# ---------------------------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------------------------


def _empty_role() -> dict:
    return {
        "pss": 0, "rss": 0, "private": 0, "shared": 0, "swap": 0, "rssOvercount": 0,
        "cpuSeconds": 0.0, "threads": 0, "processes": 0, "fds": 0, "pids": [],
    }


def aggregate(processes: dict[int, dict]) -> dict:
    """Sum per-process samples into roles, the app's own subtree and the workload.

    Unique memory is `pss`; `rss` is the naive sum a `top`-style reader would produce and is kept
    only to show the overcount. CPU seconds stay per role so a report can compute a rate from
    consecutive timeline entries. A role's `processes`/`threads`/`fds` are counts, not sums of
    memory.
    """
    by_role: dict[str, dict] = {}
    for sample in processes.values():
        role = by_role.setdefault(sample["role"], _empty_role())
        role["pids"].append(sample["pid"])
        for key in ("pss", "rss", "private", "shared", "swap", "rssOvercount"):
            role[key] += sample[key]
        role["cpuSeconds"] += sample["cpuSeconds"]
        role["threads"] += sample["threads"]
        role["fds"] += sample["fds"]
        role["processes"] += 1
    for role in by_role.values():
        role["pids"].sort()
        role["cpuSeconds"] = round(role["cpuSeconds"], 3)
    total = _sum_roles(by_role.values())
    app = _sum_roles(role for name, role in by_role.items() if name in APP_ROLES)
    workload = _sum_roles(role for name, role in by_role.items() if name == WORKLOAD_ROLE)
    return {
        "byRole": {name: by_role[name] for name in role_order(by_role)},
        "total": total,
        "app": app,
        "workload": workload,
    }


def _sum_roles(roles) -> dict:
    total = {key: 0 for key in ("pss", "rss", "private", "shared", "swap", "rssOvercount", "cpuSeconds", "threads", "processes", "fds")}
    for role in roles:
        for key in total:
            total[key] += role.get(key, 0)
    total["cpuSeconds"] = round(total["cpuSeconds"], 3)
    return total


# ---------------------------------------------------------------------------------------------
# Live sampling
# ---------------------------------------------------------------------------------------------


def _read(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None


def read_table(root: str = "/proc") -> dict[int, int]:
    """pid -> ppid for every process visible in procfs."""
    table: dict[int, int] = {}
    try:
        names = os.listdir(root)
    except OSError:
        return table
    for name in names:
        if not name.isdigit():
            continue
        text = _read(f"{root}/{name}/stat")
        if not text:
            continue
        stat = parse_stat(text)
        if stat:
            table[int(name)] = stat["ppid"]
    return table


def read_process(pid: int, host_pid: int, root: str = "/proc") -> dict | None:
    """One process: role, memory, CPU counters, threads and descriptors. None if it exited."""
    base = f"{root}/{pid}"
    stat_text = _read(f"{base}/stat")
    if not stat_text:
        return None
    stat = parse_stat(stat_text)
    if stat is None:
        return None
    cmdline = b""
    try:
        with open(f"{base}/cmdline", "rb") as handle:
            cmdline = handle.read()
    except OSError:
        pass
    comm = _read(f"{base}/comm") or ""
    command = command_of(cmdline, comm)
    smaps_text = _read(f"{base}/smaps_rollup")
    memory = memory_of(parse_smaps_rollup(smaps_text or ""))
    try:
        fds = len(os.listdir(f"{base}/fd"))
    except OSError:
        fds = -1  # not readable for a process that just exited; keep the sample honest
    return {
        "pid": pid,
        "ppid": stat["ppid"],
        "command": command,
        "role": role_of(command, pid, host_pid),
        **memory,
        "cpuSeconds": round(cpu_seconds(stat), 3),
        "threads": stat["threads"],
        "fds": fds,
        "startTicks": stat["starttime"],
        "exe": _readlink(f"{base}/exe"),
    }


def _readlink(path: str) -> str:
    try:
        return os.readlink(path)
    except OSError:
        return ""


def sample(host_pid: int, root: str = "/proc") -> dict:
    """One full sample of the app subtree. `processes` maps pid -> per-process sample."""
    table = read_table(root)
    processes: dict[int, dict] = {}
    for pid in [host_pid, *descendants(table, host_pid)]:
        found = read_process(pid, host_pid, root)
        if found is not None:
            processes[pid] = found
    aggregated = aggregate(processes)
    return {
        "tMonoNs": time.monotonic_ns(),
        "wallMs": int(time.time() * 1000),
        "hostPid": host_pid,
        "processes": {str(pid): found for pid, found in processes.items()},
        **aggregated,
    }


def process_identity(pid: int, root: str = "/proc") -> dict | None:
    """Start time and executable of one process, for startup timing and provenance."""
    stat_text = _read(f"{root}/{pid}/stat")
    stat = parse_stat(stat_text or "")
    if stat is None:
        return None
    btime = 0
    for line in (_read(f"{root}/stat") or "").splitlines():
        if line.startswith("btime "):
            btime = int(line.split()[1])
            break
    started = btime + stat["starttime"] / CLK_TCK if btime else 0.0
    return {
        "pid": pid,
        "ppid": stat["ppid"],
        "startTicks": stat["starttime"],
        "startedUnixS": round(started, 3),
        "exe": _readlink(f"{root}/{pid}/exe"),
        "cpuSeconds": round(cpu_seconds(stat), 3),
    }


# ---------------------------------------------------------------------------------------------
# Curves
# ---------------------------------------------------------------------------------------------


def percentile(values: list[float], q: float) -> float | None:
    """Linear-interpolated percentile (q in 0..100), like numpy's default. None for no values."""
    if not values:
        return None
    if not 0 <= q <= 100:
        raise ValueError(f"percentile q must be 0..100, got {q}")
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * q / 100
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    fraction = position - low
    return float(ordered[low] + (ordered[high] - ordered[low]) * fraction)


def curve(values: list[float]) -> dict:
    """n/mean/p50/p95/max of a series; empty series yields zeros so a report field is stable."""
    return {
        "n": len(values),
        "mean": round(sum(values) / len(values), 3) if values else 0.0,
        "p50": round(percentile(values, 50) or 0.0, 3),
        "p95": round(percentile(values, 95) or 0.0, 3),
        "max": round(max(values), 3) if values else 0.0,
    }


# ---------------------------------------------------------------------------------------------
# 1 Hz counter timeline
# ---------------------------------------------------------------------------------------------


class Poller:
    """Samples the app subtree every `interval` seconds on a daemon thread.

    The timeline is deliberately cheap: one `/proc` scan plus one `smaps_rollup` read per process
    per second, no tool that suspends or attaches to the target. Each entry carries per-role
    memory and cumulative CPU seconds; rates are derived later from consecutive entries.
    """

    def __init__(self, interval: float = 1.0):
        self.interval = max(0.2, float(interval))
        self.series: list[dict] = []
        self._host: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.errors = 0

    def set_host(self, pid: int) -> None:
        self._host = pid

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, name="linux-proc-poller", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            host = self._host
            if host:
                try:
                    entry = self.sample_once(host)
                except Exception:  # a torn /proc read must not kill the run
                    self.errors += 1
                    entry = None
                if entry is not None and entry.get("byRole"):
                    with self._lock:
                        self.series.append(entry)
            self._stop.wait(self.interval)

    def sample_once(self, host: int) -> dict:
        found = sample(host)
        by_role = {
            role: {
                "pss": value["pss"], "rss": value["rss"], "private": value["private"],
                "shared": value["shared"], "swap": value["swap"],
                "cpuSeconds": value["cpuSeconds"], "threads": value["threads"],
                "processes": value["processes"],
            }
            for role, value in found["byRole"].items()
        }
        return {
            "tMonoNs": found["tMonoNs"],
            "wallMs": found["wallMs"],
            "loadAverage": [round(value, 2) for value in os.getloadavg()],
            "byRole": by_role,
            "app": {key: value for key, value in found["app"].items() if key != "pids"},
            "workload": {key: value for key, value in found["workload"].items() if key != "pids"},
            "total": found["total"],
        }


def rates(series: list[dict]) -> dict:
    """Per-role CPU% between consecutive timeline entries, plus the elapsed span.

    `cpu_pct` is percent of one core (the app-lab convention); `app_total` excludes workload, so
    an external agent's CPU is never charged to the application.
    """
    cpu_seconds: dict[str, float] = {}
    spans: list[float] = []
    for before, after in zip(series, series[1:]):
        seconds = (after["tMonoNs"] - before["tMonoNs"]) / 1e9
        if seconds <= 0:
            continue
        spans.append(seconds)
        roles = set(before.get("byRole") or {}) | set(after.get("byRole") or {})
        for role in roles:
            first = (before.get("byRole") or {}).get(role) or {}
            second = (after.get("byRole") or {}).get(role) or {}
            delta = float(second.get("cpuSeconds", 0)) - float(first.get("cpuSeconds", 0))
            # A process that exited between two entries has no second value; its last delta was
            # already counted. Never treat a missing role as zero CPU going backwards.
            if delta > 0:
                cpu_seconds[role] = cpu_seconds.get(role, 0.0) + delta
    span = sum(spans)
    # Percent of one core averaged over the whole timeline (100 x seconds of CPU / seconds of
    # wall time), not the sum of per-interval percentages.
    cpu = {role: (100.0 * seconds / span if span else 0.0) for role, seconds in cpu_seconds.items()}
    total = sum(cpu.get(role, 0.0) for role in APP_ROLES)
    return {
        "seconds": round(sum(spans), 3),
        "intervals": len(spans),
        "cpu_pct": {role: round(value, 3) for role, value in sorted(cpu.items())},
        "cpu_pct_app_total": round(total, 3),
        "cpu_pct_total": round(sum(cpu.values()), 3),
    }

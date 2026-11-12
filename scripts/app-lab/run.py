"""App lab: ground-truth resource benchmark of the REAL Terax application (macOS), plus the
Linux/WebKitGTK acceptance workflow (`--scenario workflow`, ticket 01).

Unlike scripts/renderer-profile (a synthetic renderer in a bare WKWebView) this builds the real
app, with the full React shell, real PTYs, real tabs/splits and the real window, from a source
tree compiled with the `bench` cargo feature and `TERAX_BENCH=1`. A scenario driver compiled into
that build (src/bench) runs inside the UI using the app's own tab actions and reports phase events
to this orchestrator over a local HTTP server (the scripts/pty-smoke pattern). For every event the
orchestrator samples exactly the app's own processes (host, WebContent, GPU, Networking: the pids
come from the webview itself, see src-tauri/src/modules/bench.rs), with per-category `footprint`,
`vmmap`, rusage V6 CPU/energy/wakeups, and the in-app diagnostics the driver attached.

Scenarios (`--scenario`):
  tabs           shell tab + agent tab (`--variant 4`: shell, agent, split agent+agent, shell);
                 switch tabs `--cycles` times with `--dwell-ms` dwell, sample after each switch
  resize         window drag-resize cycles with live-resize semantics (shrink/grow in steps)
  split-drag     pane divider dragged back and forth with real mouse events (shell|agent split)
  occlusion      order the window out/front `--cycles` times
  agents-steady  1 visible + `--hidden-agents` hidden agent tabs for `--duration` s (CPU/energy)
  idle           one idle shell for `--duration` s
  input          native key events / input-method calls into a PTY reader (pass/fail in page.log)
  workflow       Linux acceptance workflow: shell spawn, exact echo, new tab, split, switch back,
                 open a temp file and assert the editor's text (pass/fail in page.log)
  preview        Linux preview acceptance: a served dev-server page in the real iframe (redirect,
                 sandbox, no native access, hidden-tab/Space/window teardown and reload) and PDF
                 documents (served content type and byte ranges, the frame as a separate document,
                 open/close stability, memory) — pass/fail in page.log

Linux currently implements `workflow`, `preview`, `resource`, `stress` and `startup`
(WebKitGTK); the measured scenarios above stay
macOS-only until ticket 02 (sampling) and ticket 32 (input/resize/layers). On Linux the app is
built with `--no-bundle` into `<target>/<profile>/terax`.

The app runs from an isolated bundle (an identifier inside the fork product namespace, its own
HOME), never
the user's profile; the bench build refuses to start under the product identifier. Build once
(`--build-only`, release with the feature, a separate cargo target dir) and reuse with
`--reuse-build`. To measure a pristine revision rather than the working tree use
`scripts/app-lab/export-tree.sh DEST [REV]` and pass `--source DEST`.

Every run writes one JSON report (raw samples, a 1 Hz counter timeline, derived metrics and a
human summary); `--compare A.json [B.json ...]` prints deltas (medians when repeated).
"""

import argparse
import fcntl
import functools
import hashlib
import http.server
import json
import os
import platform
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts/renderer-profile"))
import app_report  # noqa: E402
import linux_profile  # noqa: E402
import linux_proc  # noqa: E402
import isolation_report  # noqa: E402
import linux_report  # noqa: E402
import namespace_sentinels  # noqa: E402
import pdf_fixtures  # noqa: E402
import procstats  # noqa: E402

SYSTEM = platform.system()
# Scenarios the Linux/WebKitGTK runner implements with real /proc sampling. The macOS-only
# measured scenarios (tabs, resize, split-drag, occlusion, agents-steady, idle, fs-churn, input)
# stay unavailable here: WebKitGTK has no occlusion signal, no layer-tree mirror and no native
# input hook (ticket 32).
LINUX_SCENARIOS = ("workflow", "preview", "resource", "stress", "startup")
SCENARIOS = list(dict.fromkeys([*app_report.SCENARIOS, *LINUX_SCENARIOS]))
IDENTIFIER = linux_profile.disposable_identifier("app-lab", "stable")
PRODUCT_NAME = "Terax App Lab"
MAX_ATTEMPTS = 3
LOCK_PATH = Path(tempfile.gettempdir()) / "terax-app-lab.lock"
SCOPE = (
    "The real Terax application (bench build: full React shell, real PTYs and tabs, real window) "
    "in an isolated profile, driven by an in-app scenario driver; process pids come from the "
    "webview itself. A synthetic coding-agent program runs in the PTYs. Single machine, "
    "single display; not packaged-app signing, other users' fonts/shell config or cross-platform."
)
procstats.ROLE_BY_NAME["terax"] = "host"
procstats.ROLE_ORDER[:] = ["host", "web_content", "web_content_prewarmed", "gpu", "networking", "workload"]
procstats.ROLE_LABEL["workload"] = "PTY-procs"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter, allow_abbrev=False)
    p.add_argument("--scenario", choices=SCENARIOS)
    p.add_argument("--self-test", action="store_true", help="prove the preflight refusal and the bench binary's isolation guard, then exit")
    p.add_argument(
        "--identifier",
        help="disposable app identifier (Linux default: <fork product identifier>.app-lab-<hex>)",
    )
    p.add_argument("--variant", default=None, help="tabs: 2 (default) or 4")
    p.add_argument("--source", type=Path, help="source tree to build (default: this checkout; see export-tree.sh)")
    p.add_argument("--revision", help="label for a source tree without Git metadata")
    p.add_argument("--target-dir", type=Path, help="cargo target dir (default: app-lab-target-<profile> next to --output); use a private one so the shared src-tauri/target lock is not contended")
    p.add_argument("--profile", choices=["release", "debug"], default="release", help="release (default): what users run, with the bench feature")
    p.add_argument("--build-only", action="store_true")
    p.add_argument("--reuse-build", action="store_true", help="reuse the frontend and app already built for this source/profile")
    p.add_argument("--app", type=Path, help="run this prebuilt bench .app instead of building")
    p.add_argument("--output", type=Path, help="scratch directory (default: a temp directory)")
    p.add_argument("--report", type=Path, help="JSON report path (default: <output>/report.json)")
    p.add_argument("--label", help="free-form label stored in the report")
    p.add_argument("--toggle", action="append", default=[], metavar="NAME=VALUE", help="experiment toggle: localStorage terax:bench:NAME (repeatable)")
    p.add_argument("--local-storage", action="append", default=[], metavar="KEY=VALUE", help="raw localStorage entry (VALUE 'null' removes), e.g. terax:terminal-canvas-park-ms=off")
    p.add_argument("--window", default="1280x820", help="window size in points, WxH")
    p.add_argument("--instrument", action="store_true", help="patch WebGPU/DOM prototypes with lifecycle counters (calls, wrappers created/finalized, canvas re-parenting); compare with an uninstrumented run")
    p.add_argument("--gc", nargs="?", const="private", choices=["private", "alloc"], help="after the idle tail, request a full garbage collection and sample +2 s/+10 s: 'private' (default) is WebKit's testing SPI, 'alloc' is allocation pressure from the page (what an in-app valve could do)")
    p.add_argument("--tick", type=float, help="idle, fs-churn: take a full sample (with the layer tree and the page event log) every this many seconds (fs-churn default 30)")
    p.add_argument("--unfocused", action="store_true", help="fs-churn: after measure-start move Finder to the front, so the window stays visible but is not key (an app left behind another one)")
    p.add_argument("--no-churn", action="store_true", help="fs-churn: do not start the file-system churn (dev server and explorer only)")
    p.add_argument("--churn-args", default="", help="fs-churn: extra arguments for scripts/app-lab/fs-churn.mjs run (--build-every S, --build-files N, --build-seconds S, --seed N)")
    p.add_argument("--hold-tab", type=int, help="tabs: index of the tab shown at baseline (and for the whole run with --no-switch), in creation order")
    p.add_argument("--valve", metavar="EVERY_S:CHUNKS:MB", help="mitigation probe: every EVERY_S seconds the page allocates CHUNKS zero-filled ArrayBuffers of MB MiB to push JavaScriptCore into a full GC (tabs scenario)")
    p.add_argument("--probe", choices=["blur", "readonly", "caret-transparent", "caret-animation-manual", "zero-size", "clip", "display-contents", "selection", "selection-nofocus-div"], help="idle: remove one suspected source of idle display refreshes before measuring")
    p.add_argument("--no-switch", action="store_true", help="tabs control: same loop, timing, samples and workload, but never switch tabs")
    p.add_argument("--vibrancy", choices=["on", "off"], help="set the window vibrancy preference through the app's own store before the scenario (default: the app default, off)")
    p.add_argument("--cwd-shell", type=Path, help="working directory of shell tabs; the app is launched in it, so the first tab and the file explorer start there (default: the isolated HOME)")
    p.add_argument("--cwd-agent", type=Path, help="working directory of agent tabs (different directories make the explorer and git panel follow each tab switch)")
    p.add_argument("--agent-args", default="", help="extra arguments for scripts/app-lab/agent-sim.mjs")
    p.add_argument("--cycles", type=int)
    p.add_argument("--dwell-ms", type=int, default=3000)
    p.add_argument("--hidden-ms", type=int, default=3000)
    p.add_argument("--visible-ms", type=int, default=2000)
    p.add_argument("--duration", type=float, help="measured seconds (agents-steady default 60, idle default 30)")
    p.add_argument("--warmup", type=float, default=5)
    p.add_argument("--hidden-agents", type=int, default=6)
    p.add_argument("--steps", type=int, default=120)
    p.add_argument("--step-points", type=float, default=4)
    p.add_argument("--step-interval-ms", type=float, default=16)
    p.add_argument("--drag-seconds", type=float, help="split-drag: seconds of divider motion per drag (default 6)")
    p.add_argument("--drag-amplitude", type=float, help="split-drag: sweep amplitude as a share of the split axis (default 0.2)")
    p.add_argument("--mouse-hz", type=float, help="split-drag: mouse sample rate (default 125)")
    p.add_argument("--grow-first", action="store_true", help="resize: grow the window before shrinking it (past the size the canvas was allocated for)")
    p.add_argument("--resize-mode", choices=["live", "plain"], default="live")
    p.add_argument("--vmmap", action=argparse.BooleanOptionalAction, default=None, help="`vmmap -summary` of WebContent and GPU per sample (default: on for tabs/resize/occlusion; it briefly suspends the target)")
    p.add_argument("--iosurfaces", action="store_true", help="list the IOSurface regions of WebContent and GPU (`vmmap -v`: count, sizes, volatile) in every full sample")
    p.add_argument("--categories", action=argparse.BooleanOptionalAction, default=True, help="keep footprint's per-category breakdown (default on)")
    p.add_argument("--poll-interval", type=float, default=1.0, help="seconds between timeline counter samples (phys_footprint, CPU, energy per process)")
    p.add_argument("--agents", type=int, help="resource: busy synthetic agents (default 2; stress default 4)")
    p.add_argument("--streams", type=int, help="resource: terminal panes receiving the streaming fixture (default 2; stress default 4)")
    p.add_argument("--stream-rate", type=float, default=400, help="resource: streaming lines per second per pane (default 400)")
    p.add_argument("--stream-seconds", type=float, help="resource: seconds of sustained terminal streaming (default: --duration or 30)")
    p.add_argument("--close-cycles", type=int, default=3, help="resource: editor open/close cycles (default 3)")
    p.add_argument("--idle-seconds", type=float, default=5, help="resource: idle-terminal hold before the workload (default 5)")
    p.add_argument("--startup-repeats", type=int, default=3, help="startup: launches per run; the first is cold (fresh profile), the rest warm (default 3)")
    p.add_argument("--compare-format", choices=["table", "tsv", "json"], default="table", help="with --compare/--candidate: one line per metric (tsv) or machine-readable json")
    p.add_argument("--list-metrics", action="store_true", help="print every metric name a Linux report can produce and exit")
    p.add_argument("--sampling", choices=["full", "light"], default="full", help="full: footprint+vmmap after every event (they briefly suspend the target and perturb it); light: only every --full-every-th cycle and the non-cycle phases are sampled with them, the rest rely on the cheap timeline (use a small --poll-interval)")
    p.add_argument("--light-phases", default=r"^(switch-\d+|cycle-\d+-(hidden|visible)|shrink-\d+|grow-\d+|drag-\d+)$", help="light sampling: regular expression of the phases that get only the cheap counters (every other phase, setup, the tail and GC samples, is sampled in full)")
    p.add_argument("--full-every", type=int, default=10, help="light sampling: still take a full sample every N cycles")
    p.add_argument("--wait-unlocked", type=float, default=0, metavar="SECONDS")
    p.add_argument("--wait-exclusive", type=float, default=1800, metavar="SECONDS", help="wait this long while another benchmark window (renderer-lab, app-lab) is running")
    p.add_argument("--max-consecutive-failures", type=int, default=3)
    p.add_argument("--timeout", type=float, help="hard lifetime of the app in seconds (default derived)")
    p.add_argument("--compare", type=Path, nargs="+", metavar="BASELINE.json")
    p.add_argument("--candidate", type=Path, nargs="+", metavar="CANDIDATE.json", help="with --compare: compare existing reports without running")
    p.add_argument("--recompute", type=Path, nargs="+", metavar="REPORT.json", help="recompute metrics and summary of existing reports")
    return p.parse_args()


def sh(*command: str) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def session_locked() -> bool:
    import plistlib

    result = subprocess.run(["ioreg", "-n", "Root", "-d1", "-a"], capture_output=True)
    try:
        tree = plistlib.loads(result.stdout)
    except Exception:
        return False
    stack = [tree]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get("CGSSessionScreenIsLocked") is True:
                return True
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return False


def other_benchmarks() -> list[str]:
    """Benchmark windows that would steal focus or distort CPU from this one."""
    found = []
    for pid, (_, command) in procstats.process_table().items():
        name = os.path.basename(command)
        if name == "renderer-lab" or (name == "terax" and "Terax App Lab" in command and pid != os.getpid()):
            found.append(f"{name}[{pid}]")
    return found


# ---------------------------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------------------------


def build(args, source: Path, output: Path, target_dir: Path) -> Path:
    if SYSTEM == "Linux":
        return build_linux(args, source, output, target_dir)
    """Frontend with TERAX_BENCH=1, then the Tauri bundle with the `bench` feature. Returns the .app."""
    dist = output / "dist"
    bundle_dir = target_dir / args.profile / "bundle/macos"
    app = bundle_dir / f"{PRODUCT_NAME}.app"
    if args.reuse_build and app.exists() and (dist / "index.html").exists():
        print(f"Reusing {app}", flush=True)
        return app
    config = output / "tauri.conf.json"
    config.write_text(json.dumps({
        "productName": PRODUCT_NAME,
        "identifier": IDENTIFIER,
        "build": {"beforeBuildCommand": "", "frontendDist": str(dist)},
        "bundle": {"createUpdaterArtifacts": False},
    }))
    env = {**os.environ, "TERAX_BENCH": "1", "TERAX_BENCH_IDENTIFIER": IDENTIFIER, "CARGO_TARGET_DIR": str(target_dir)}
    started = time.monotonic()
    with (output / "build.log").open("w") as log:
        print("Building the frontend (TERAX_BENCH=1)...", flush=True)
        subprocess.run([str(source / "node_modules/.bin/vite"), "build", "--outDir", str(dist), "--emptyOutDir"], cwd=source, env=env, stdout=log, stderr=log, check=True)
        frontend_s = time.monotonic() - started
        print("Building the app (cargo %s, feature bench)..." % args.profile, flush=True)
        command = [str(source / "node_modules/.bin/tauri"), "build", "--bundles", "app", "--features", "bench", "--config", str(config)]
        if args.profile == "debug":
            command.append("--debug")
        subprocess.run(command, cwd=source, env=env, stdout=log, stderr=log, check=True)
    print(f"Built in {time.monotonic() - started:.0f}s (frontend {frontend_s:.0f}s)", flush=True)
    (output / "build-seconds.json").write_text(json.dumps({"frontend": frontend_s, "total": time.monotonic() - started}))
    if not app.exists():
        raise RuntimeError(f"build produced no {app}")
    return app


def build_linux(args, source: Path, output: Path, target_dir: Path) -> Path:
    """Frontend with TERAX_BENCH=1, then the app binary with the `bench` feature (no bundle).

    `--no-bundle` skips deb/rpm/appimage (and the CLI sidecar those would need); the binary is
    `<target>/<profile>/terax`. The generated config maps onto src-tauri/tauri.conf.json and
    overrides the identifier, the frontend location and the hidden main window.
    """
    dist = output / "dist"
    binary = target_dir / args.profile / "terax"
    config = output / "tauri.conf.json"
    config.write_text(json.dumps({
        "productName": PRODUCT_NAME,
        "identifier": args.identifier,
        "build": {"beforeBuildCommand": "", "frontendDist": str(dist)},
        # The real config starts hidden and relies on the page to show the window; a page error
        # would then leave an invisible app hanging the run.
        "app": {"windows": [{
            "label": "main", "title": PRODUCT_NAME, "width": 1280, "height": 820, "visible": True,
        }]},
        "bundle": {"active": False, "createUpdaterArtifacts": False},
    }))
    if args.reuse_build and binary.exists() and (dist / "index.html").exists():
        print(f"Reusing {binary}", flush=True)
        return binary
    env = {**os.environ, "TERAX_BENCH": "1", "TERAX_BENCH_IDENTIFIER": args.identifier, "CARGO_TARGET_DIR": str(target_dir)}
    started = time.monotonic()
    with (output / "build.log").open("w") as log:
        print("Building the frontend (TERAX_BENCH=1)...", flush=True)
        subprocess.run([str(source / "node_modules/.bin/vite"), "build", "--outDir", str(dist), "--emptyOutDir"], cwd=source, env=env, stdout=log, stderr=log, check=True)
        frontend_s = time.monotonic() - started
        print("Building the app (cargo %s, feature bench)..." % args.profile, flush=True)
        command = [str(source / "node_modules/.bin/tauri"), "build", "--no-bundle", "--features", "bench", "--config", str(config)]
        if args.profile == "debug":
            command.append("--debug")
        subprocess.run(command, cwd=source, env=env, stdout=log, stderr=log, check=True)
    print(f"Built in {time.monotonic() - started:.0f}s (frontend {frontend_s:.0f}s)", flush=True)
    (output / "build-seconds.json").write_text(json.dumps({"frontend": frontend_s, "total": time.monotonic() - started}))
    if not binary.exists():
        raise RuntimeError(f"build produced no {binary}")
    return binary


# ---------------------------------------------------------------------------------------------
# Profile isolation
# ---------------------------------------------------------------------------------------------


def clean_profile(home: Path) -> None:
    """Removes everything a previous run left for the bench identifier (never the product's)."""
    assert IDENTIFIER != linux_profile.PRODUCT_IDENTIFIER
    assert IDENTIFIER.startswith(f"{linux_profile.PRODUCT_IDENTIFIER}.")
    assert linux_profile.UPSTREAM_IDENTIFIER not in IDENTIFIER
    shutil.rmtree(home, ignore_errors=True)
    # WebKit, Tauri and cfprefsd may resolve the user's real library even with HOME overridden.
    import pwd

    real = Path(pwd.getpwuid(os.getuid()).pw_dir)
    for base in (real / "Library/Application Support", real / "Library/WebKit", real / "Library/Caches", real / "Library/HTTPStorages", real / "Library/Saved Application State", real / "Library/Preferences"):
        for name in (IDENTIFIER, f"{IDENTIFIER}.savedState", f"{IDENTIFIER}.plist"):
            target = base / name
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink()
    home.mkdir(parents=True, exist_ok=True)


def descendants(root: int, table: dict[int, tuple[int, str]]) -> list[int]:
    children: dict[int, list[int]] = {}
    for pid, (ppid, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    found, stack = [], [root]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


# ---------------------------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------------------------

PREVIEW_FIXTURE = """<!doctype html>
<html><head><meta charset="utf-8"><title>preview fixture</title></head>
<body><h1>preview fixture</h1><p id="state"></p>
<script>
const instance = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
const native = {
  tauri: typeof window.__TAURI__ !== "undefined",
  internals: typeof window.__TAURI_INTERNALS__ !== "undefined",
  invoke: typeof (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
};
// A sandboxed frame without allow-top-navigation* must not be able to move the app window.
const topNav = { attempted: false, error: null };
try { topNav.attempted = true; window.top.location.href = "http://127.0.0.1:1/preview-escape"; }
catch (error) { topNav.error = String(error); }
// A popup must not become a window outside the application's control: the app installs no
// new-window handler, so WebKit has to refuse the request rather than hand the page one.
const popup = (() => {
  try {
    const opened = window.open("about:blank", "terax-preview-popup", "width=200,height=120");
    if (opened) { try { opened.close(); } catch (error) {} }
    return { requested: true, opened: Boolean(opened), error: null };
  } catch (error) {
    return { requested: true, opened: false, error: String(error) };
  }
})();
let seq = 0;
function payload(kind) {
  return {
    source: "terax-preview-fixture", kind, instance, href: location.href, seq: seq++,
    redirected: location.pathname === "/preview-redirected", visibility: document.visibilityState,
    native, topNav, popup,
  };
}
function post(kind) { try { window.parent.postMessage(payload(kind), "*"); } catch (error) {} }
setInterval(function () { post("beat"); }, 200);
post("beat");
addEventListener("pagehide", function () { post("pagehide"); });
document.getElementById("state").textContent = instance + " " + location.pathname;
if (location.search.indexOf("redirect=1") !== -1) {
  setTimeout(function () { location.href = "/preview-redirected?from=fixture"; }, 600);
}
</script></body></html>
"""


class ReportServer:
    """Receives phase events. A handler thread blocks until the main thread has sampled."""

    def __init__(self):
        self.events: queue.Queue = queue.Queue()
        self.log: list[str] = []
        self.fixture_loads = 0
        self.redirect_hits = 0
        self.pings = 0
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _cors(self):
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "*")

            def _send(self, status: int, body: bytes, content_type: str) -> None:
                self.send_response(status)
                self._cors()
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.end_headers()

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == "/preview-ping":
                    outer.pings += 1
                    body = json.dumps({
                        "pong": True,
                        "hits": outer.pings,
                        "fixtureLoads": outer.fixture_loads,
                        "redirectHits": outer.redirect_hits,
                    }).encode()
                    self._send(200, body, "application/json")
                elif path in ("/preview-fixture", "/preview-redirected"):
                    # Fixture loads are served for as long as this server lives: frame teardown
                    # must never stop it.
                    outer.fixture_loads += 1
                    if path == "/preview-redirected":
                        outer.redirect_hits += 1
                    self._send(200, PREVIEW_FIXTURE.encode(), "text/html")
                else:
                    self._send(404, b"not found", "text/plain")

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                if self.path == "/log":  # page errors and console output, no sampling handshake
                    outer.log.append(body.decode("utf-8", "replace"))
                    self.send_response(204)
                    self._cors()
                    self.end_headers()
                    return
                done = threading.Event()
                reply: dict = {}
                try:
                    outer.events.put((json.loads(body), done, reply))
                except ValueError:
                    pass
                done.wait(900)
                payload = json.dumps(reply).encode()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_port}"


def _terminate(signum, frame):  # run the cleanup in `run` (kill the app, remove the profile)
    raise KeyboardInterrupt(f"signal {signum}")


def main() -> int:
    args = parse_args()
    signal.signal(signal.SIGTERM, _terminate)
    if args.list_metrics:
        print("\n".join(linux_report.METRIC_NAMES))
        return 0
    if args.recompute:
        for path in args.recompute:
            stored = app_report.load(path)
            stored.pop("metricsError", None)
            if linux_report.is_linux_report(stored):
                stored["metrics"] = linux_report.round_metrics(linux_report.compute_metrics(stored))
                stored["humanSummary"] = linux_report.summarize(stored)
            else:
                stored["metrics"] = app_report.round_metrics(app_report.compute_metrics(stored))
                stored["humanSummary"] = app_report.summarize(stored)
            Path(path).write_text(app_report.dump(stored))
            print(f"Recomputed {path}")
        return 0
    if args.compare and args.candidate:
        reports = [app_report.load(p) for p in args.compare]
        candidates = [app_report.load(p) for p in args.candidate]
        if linux_report.is_linux_report(reports[0]):
            print(linux_report.compare(reports, candidates, args.compare_format))
        else:
            print(app_report.compare(reports, candidates))
        return 0
    if SYSTEM not in ("Darwin", "Linux"):
        raise SystemExit(f"The app lab requires macOS or Linux, not {SYSTEM}.")
    if not args.scenario and not args.build_only:
        raise SystemExit("--scenario is required")
    if SYSTEM == "Linux" and not args.build_only and args.scenario not in LINUX_SCENARIOS:
        raise SystemExit(
            f"On Linux the implemented scenarios are {', '.join(LINUX_SCENARIOS)}; the macOS-only "
            "measured scenarios wait for ticket 32 (WebKitGTK has no occlusion signal, layer tree "
            "or native input hook)."
        )
    if SYSTEM == "Darwin" and args.scenario not in app_report.SCENARIOS:
        raise SystemExit(
            f"The Linux scenarios ({', '.join(LINUX_SCENARIOS)}) are measured with /proc sampling "
            "and do not run on macOS; use the macOS measured scenarios."
        )
    source = (args.source or REPO).resolve()
    output = (args.output or Path(tempfile.mkdtemp(prefix="terax-app-lab-"))).resolve()
    output.mkdir(parents=True, exist_ok=True)
    target_dir = (args.target_dir or output.parent / f"app-lab-target-{args.profile}").resolve()
    args.identifier = args.identifier or (
        f"{IDENTIFIER}-{uuid.uuid4().hex[:8]}" if SYSTEM == "Linux" else IDENTIFIER
    )
    if SYSTEM == "Linux":
        # Fail before the build: an unsafe identifier/profile never reaches the application.
        linux_profile.preflight(
            args.identifier,
            {**linux_profile.profile_env(output / "home"), "TERAX_BENCH_ISOLATED": "1"},
            output,
            require_isolated=True,
        )
    app = args.app.resolve() if args.app else build(args, source, output, target_dir)
    if args.build_only:
        print(f"Built {app}")
        return 0
    if args.self_test:
        if SYSTEM != "Linux":
            raise SystemExit("--self-test proves the Linux disposable-profile preflight; run it on Linux")
        return self_test(args, app, output)
    # Only one benchmark window at a time (building is fine alongside a run).
    lock = LOCK_PATH.open("w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise SystemExit(f"Another app-lab run holds {LOCK_PATH}")

    if SYSTEM == "Darwin" and session_locked():
        deadline = time.monotonic() + args.wait_unlocked
        while session_locked() and time.monotonic() < deadline:
            time.sleep(10)
        if session_locked():
            raise SystemExit("The login session is locked, so the benchmark window cannot be visible. Unlock the screen and rerun (or pass --wait-unlocked SECONDS).")
    deadline = time.monotonic() + args.wait_exclusive
    while other_benchmarks():
        if time.monotonic() > deadline:
            raise SystemExit(f"Another benchmark window is running: {other_benchmarks()}")
        print(f"waiting for {other_benchmarks()} to finish...", flush=True)
        time.sleep(20)

    return run(args, app, source, output)


def scenario_json(args) -> dict:
    width, height = (float(v) for v in args.window.lower().split("x"))
    node = shutil.which("node")
    if not node:
        raise SystemExit("node is required for the synthetic agent")
    agent = f"exec {node} {HERE / 'agent-sim.mjs'} {args.agent_args}".strip()
    local = {}
    for entry in args.local_storage:
        key, _, value = entry.partition("=")
        local[key] = None if value == "null" else value
    for entry in args.toggle:
        key, _, value = entry.partition("=")
        local[f"terax:bench:{key}"] = value or "1"
    scenario = {
        "name": args.scenario, "variant": args.variant, "agentCommand": agent,
        "window": {"width": width, "height": height},
        "dwellMs": args.dwell_ms, "hiddenMs": args.hidden_ms, "visibleMs": args.visible_ms,
        "warmupS": args.warmup, "hiddenAgents": args.hidden_agents,
        "steps": args.steps, "stepPoints": args.step_points, "stepIntervalMs": args.step_interval_ms,
        "live": args.resize_mode == "live", "localStorage": local,
        "cwds": {k: str(v.resolve()) for k, v in (("shell", args.cwd_shell), ("agent", args.cwd_agent)) if v} or None,
        "gc": args.gc,
        "noSwitch": True if args.no_switch else None,
        "probe": args.probe,
        "valve": dict(zip(("everyS", "chunks", "chunkMb"), (float(v) for v in args.valve.split(":")))) if args.valve else None,
        "holdTab": args.hold_tab,
        "growFirst": True if args.grow_first else None,
        "dragS": args.drag_seconds, "dragAmplitude": args.drag_amplitude, "mouseHz": args.mouse_hz,
        "instrument": True if args.instrument else None,
        "tickS": args.tick if args.tick is not None else (30 if args.scenario == "fs-churn" else None),
        "unfocused": True if args.unfocused else None,
        "prefs": {"windowVibrancy": args.vibrancy == "on"} if args.vibrancy else None,
    }
    defaults = {"tabs": 40, "occlusion": 20, "resize": 3, "split-drag": 3}
    if args.cycles is not None or args.scenario in defaults:
        scenario["cycles"] = args.cycles if args.cycles is not None else defaults[args.scenario]
    if args.duration is not None:
        scenario["durationS"] = args.duration
    return {k: v for k, v in scenario.items() if v is not None}


def host_timeout(args, scenario: dict) -> float:
    if args.timeout is not None:
        return args.timeout
    name = args.scenario
    if name == "workflow":
        return 600
    if name == "preview":
        # The web-preview teardown/reload cycle plus the PDF document checks (open, sample,
        # close, memory) each take a rendered sample.
        return 720
    if name == "startup":
        return max(1, args.startup_repeats) * 150 + 120
    if name in ("resource", "stress"):
        cycles = scenario.get("cycles") or 3
        return (
            (cycles * (scenario.get("hiddenMs", 3000) + scenario.get("visibleMs", 2000)) / 1000)
            + (scenario.get("closeCycles", 3) * 5)
            + scenario.get("streamSeconds", 30)
            + 300
        )
    if name == "tabs":
        return scenario["cycles"] * (scenario["dwellMs"] / 1000 + 12) + 240
    if name == "occlusion":
        return scenario["cycles"] * ((scenario["hiddenMs"] + scenario["visibleMs"]) / 1000 + 12) + 240
    if name == "resize":
        return scenario["cycles"] * 40 + 300
    if name == "split-drag":
        return scenario["cycles"] * (scenario.get("dragS", 6) + 30) + 360
    return (scenario.get("durationS") or 60) + args.warmup + 240


def run(args, app: Path, source: Path, output: Path) -> int:
    if SYSTEM == "Linux":
        return run_linux(args, app, source, output)
    home = output / "home"
    clean_profile(home)
    report_path = (args.report or output / "report.json").resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    scenario = scenario_json(args)
    timeout = host_timeout(args, scenario)
    vmmap_enabled = args.vmmap if args.vmmap is not None else args.scenario in ("tabs", "resize", "split-drag", "occlusion")
    import plistlib

    executable = app / "Contents/MacOS" / plistlib.loads((app / "Contents/Info.plist").read_bytes())["CFBundleExecutable"]

    revision = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], text=True, capture_output=True)
    has_git = revision.returncode == 0 and (source / ".git").exists()
    build_seconds = {}
    if (output / "build-seconds.json").exists():
        build_seconds = json.loads((output / "build-seconds.json").read_text())
    manifest = {
        "schema": "terax-app-lab/1",
        "scope": SCOPE,
        "config": {
            "scenario": args.scenario, "label": args.label, "profile": args.profile, "vmmap": vmmap_enabled,
            "categories": args.categories, "pollIntervalS": args.poll_interval, "hostTimeoutS": timeout,
            "scenarioJson": {k: v for k, v in scenario.items() if k != "agentCommand"},
            "agentArgs": args.agent_args, "buildSeconds": build_seconds,
        },
        "sourceRevision": revision.stdout.strip() if has_git else args.revision,
        "sourceTree": str(source),
        "platform": platform.platform(),
        "environment": {
            "chip": sh("sysctl", "-n", "machdep.cpu.brand_string"), "logicalCpus": sh("sysctl", "-n", "hw.ncpu"),
            "memoryBytes": sh("sysctl", "-n", "hw.memsize"), "macOS": sh("sw_vers", "-productVersion"), "build": sh("sw_vers", "-buildVersion"),
            "power": (sh("pmset", "-g", "batt").splitlines() or [""])[0], "thermal": sh("pmset", "-g", "therm"),
            "displays": sh("system_profiler", "SPDisplaysDataType").count("Resolution:"),
            "loadAverageStart": [round(v, 2) for v in os.getloadavg()],
        },
        "appBinarySha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
        "qualification": {"qualified": True, "failures": []},
        "warnings": [],
        "samples": [],
        "series": [],
    }

    server = ReportServer()
    window_server = procstats.find_pid("WindowServer")
    poller = procstats.Poller(args.poll_interval, window_server)
    started = time.monotonic()
    warnings: set[str] = set()
    env = {
        **{k: v for k, v in os.environ.items() if not k.startswith(("TAURI_", "VITE_", "CARGO_"))},
        "HOME": str(home), "TERAX_BENCH_ISOLATED": "1",
        "TERAX_BENCH_SCENARIO": json.dumps(scenario), "TERAX_BENCH_REPORT_URL": server.url,
        "SHELL": os.environ.get("SHELL", "/bin/zsh"),
    }
    env.pop("ZDOTDIR", None)
    log = (output / "app.log").open("w")
    churn = None
    if args.scenario == "fs-churn":
        if not args.cwd_shell:
            args.cwd_shell = output / "workspace"
            subprocess.run([shutil.which("node"), str(HERE / "fs-churn.mjs"), "prepare", str(args.cwd_shell), str(REPO)], check=True)
        scenario["cwds"] = {"shell": str(args.cwd_shell.resolve())}
        env["TERAX_BENCH_SCENARIO"] = json.dumps(scenario)
    launch_args = [str(args.cwd_shell.resolve())] if args.cwd_shell else []
    process = subprocess.Popen([str(executable), *launch_args], cwd=home, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    manifest["hostPid"] = process.pid
    # Hold the display awake (like the lab host's process assertion) so the idle timer cannot lock
    # the screen and occlude the window mid-run; -w ends it with the app.
    awake = subprocess.Popen(["caffeinate", "-d", "-i", "-u", "-w", str(process.pid)])
    poller.start()
    failed: BaseException | None = None
    consecutive_failures = 0
    final_phase = None

    light_phases = re.compile(args.light_phases)

    def after_sample(phase: str) -> None:
        """Scenario side effects that must start right after a phase was sampled."""
        nonlocal churn
        if args.scenario != "fs-churn":
            return
        if phase == "measure-start" and churn is None and not args.no_churn:
            churn = subprocess.Popen([shutil.which("node"), str(HERE / "fs-churn.mjs"), "run", str(args.cwd_shell.resolve()), *args.churn_args.split()], stdout=(output / "churn.log").open("w"), stderr=subprocess.STDOUT, start_new_session=True)
        if phase == "measure-start" and args.unfocused:
            subprocess.run(["open", "-a", "Finder"], check=False)
        if phase == "measure-end" and churn is not None:
            stop_churn()

    def stop_churn() -> None:
        nonlocal churn
        if churn is not None and churn.poll() is None:
            try:
                os.killpg(churn.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            churn.wait(timeout=10)
        churn = None

    def take_sample(event: dict) -> dict:
        native = event.get("native") or {}
        members, member_warnings = procstats.resolve_members(native)
        if "host" not in members.values():
            raise RuntimeError(f"Cannot identify the app's host process: {member_warnings}")
        warnings.update(member_warnings)
        table = procstats.process_table()
        kids = [pid for pid in descendants(process.pid, table) if pid not in members]
        ids = list(members)
        t_pre = time.monotonic_ns()
        wall = time.time()
        pre = {str(pid): app_report.compact_rusage(procstats.rusage(pid)) for pid in ids + kids}
        ws_pre = procstats.ps_cpu_ns(window_server) if window_server else None
        cycle = event.get("cycle") or 0
        light = args.sampling == "light" and bool(light_phases.match(event["phase"])) and not (args.full_every and cycle % args.full_every == 0)
        if light:
            # Counters only: no tool touches the target, so the timeline shows its own behaviour.
            roles = {str(pid): role for pid, role in members.items()}
            roles.update({str(pid): "workload" for pid in kids})
            by_role = {members[pid]: (pre[str(pid)] or {}).get("phys_footprint", 0) for pid in ids}
            poller.set_members(members)
            return {
                "phase": event["phase"], "light": True, "tMonoNs": t_pre, "tMonoNsPost": t_pre, "tWall": wall,
                "elapsedS": time.monotonic() - started, "event": app_report.slim_event(event),
                "members": ids, "roles": roles, "rusage": pre, "rusagePost": pre,
                "windowServerCpuNs": ws_pre, "windowServerCpuNsPost": ws_pre,
                "footprintByRole": by_role, "footprintTotal": sum(by_role.values()),
                "loadAverage": [round(v, 2) for v in os.getloadavg()],
            }
        raw = footprint_of(ids, output / "sample-footprint.json", args.categories)
        vmmap = {}
        if vmmap_enabled:
            vmmap = {role: app_report.compact_vmmap(procstats.vmmap_summary(pid)) for pid, role in members.items() if role in ("web_content", "gpu")}
        surfaces = {}
        if args.iosurfaces:
            surfaces = {role: app_report.vmmap_iosurfaces(pid) for pid, role in members.items() if role in ("web_content", "gpu", "host")}
        t_post = time.monotonic_ns()
        post = {str(pid): app_report.compact_rusage(procstats.rusage(pid)) for pid in ids + kids}
        ws_post = procstats.ps_cpu_ns(window_server) if window_server else None
        compact = app_report.compact_footprint(raw, members)
        roles = {str(pid): role for pid, role in members.items()}
        roles.update({str(pid): "workload" for pid in kids})
        poller.set_members(members)
        return {
            "phase": event["phase"], "tMonoNs": t_pre, "tMonoNsPost": t_post, "tWall": wall,
            "elapsedS": time.monotonic() - started, "event": app_report.slim_event(event),
            "members": ids, "roles": roles, "rusage": pre, "rusagePost": post,
            "windowServerCpuNs": ws_pre, "windowServerCpuNsPost": ws_post,
            "footprint": compact, "footprintByRole": compact["byRole"], "footprintTotal": compact["total"],
            **({"vmmap": vmmap} if vmmap else {}),
            **({"iosurfaces": surfaces} if surfaces else {}),
            "loadAverage": [round(v, 2) for v in os.getloadavg()],
        }

    try:
        deadline = time.monotonic() + timeout
        first_event_by = time.monotonic() + 120
        while True:
            try:
                event, done, reply = server.events.get(timeout=1)
            except queue.Empty:
                if process.poll() is not None:
                    raise RuntimeError(f"The app exited ({process.returncode}) before finishing; see {output / 'app.log'}")
                if time.monotonic() > deadline:
                    raise RuntimeError(f"Timed out after {timeout:.0f}s")
                if not manifest["samples"] and time.monotonic() > first_event_by:
                    raise RuntimeError(f"The scenario driver never reported (page log: {server.log[-3:]}); see {output / 'app.log'}")
                continue
            phase = event.get("phase")
            try:
                if phase == "error":
                    raise RuntimeError(event)
                if phase == "done":
                    manifest["samples"].append({"phase": "done", "tMonoNs": time.monotonic_ns(), "event": app_report.slim_event(event)})
                    final_phase = "done"
                    break
                reasons = app_report.qualify(args.scenario, phase, event)
                if reasons and event.get("attempt", 1) < MAX_ATTEMPTS and phase not in ("setup", "blank"):
                    # Focus was taken by something else just before the event: have the page bring
                    # the window back and report the same phase again instead of keeping bad evidence.
                    reply["retry"] = True
                    manifest["qualification"].setdefault("retried", []).append({"phase": phase, "reasons": reasons})
                    print(json.dumps({"phase": phase, "retry": reasons}), flush=True)
                    continue
                sample = take_sample(event)
                if reasons:
                    manifest["qualification"]["qualified"] = False
                    manifest["qualification"]["failures"].append({"phase": phase, "reasons": reasons})
                    consecutive_failures += 1
                    if consecutive_failures >= args.max_consecutive_failures:
                        locked = " (the login session is locked)" if session_locked() else ""
                        raise RuntimeError(f"Aborting after {consecutive_failures} consecutive unqualified samples{locked}: {reasons}")
                else:
                    consecutive_failures = 0
                manifest["samples"].append(sample)
                after_sample(phase)
                print(json.dumps({"phase": phase, "footprintMiB": round(sample["footprintTotal"] / 1048576, 1), **({"unqualified": reasons} if reasons else {})}), flush=True)
            finally:
                done.set()
    except BaseException as error:  # a partial report is still worth keeping
        failed = error
        manifest["incomplete"] = True
        manifest["error"] = repr(error)
    finally:
        stop_churn()
        poller.stop()
        for kill in (signal.SIGTERM, signal.SIGKILL):
            if process.poll() is not None:
                break
            try:
                os.killpg(process.pid, kill)
            except ProcessLookupError:
                break
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        awake.terminate()
        server.httpd.shutdown()
        log.close()
        if server.log:
            (output / "page.log").write_text("\n".join(server.log))
        manifest["series"] = poller.series
        manifest["environment"]["loadAverageEnd"] = [round(v, 2) for v in os.getloadavg()]
        manifest["warnings"] = sorted(warnings)
        samples = [s for s in manifest["samples"] if "footprint" in s]
        cpus = int(manifest["environment"].get("logicalCpus") or 0)
        busiest = max((s["loadAverage"][0] for s in samples), default=0)
        if cpus and busiest > cpus / 2:
            manifest["qualification"].setdefault("advisories", []).append(
                f"system load average reached {busiest:.1f} on {cpus} logical CPUs; CPU, energy and timing figures may be inflated by other work"
            )
        if samples:
            try:
                manifest["metrics"] = app_report.round_metrics(app_report.compute_metrics({**manifest, "samples": samples}))
                manifest["humanSummary"] = app_report.summarize({**manifest, "samples": samples})
            except Exception as error:
                manifest["metricsError"] = repr(error)
        report_path.write_text(app_report.dump(manifest))
        clean_profile(home)
        shutil.rmtree(home, ignore_errors=True)
    if "humanSummary" in manifest:
        print("\n" + manifest["humanSummary"])
    if args.compare:
        print("\n" + app_report.compare([app_report.load(p) for p in args.compare], app_report.load(report_path)))
    print(f"\nSaved {report_path}")
    if failed is not None:
        raise failed
    if not manifest["qualification"]["qualified"]:
        print("Run failed qualification: keep the app window visible/focused and rerun.", file=sys.stderr)
        return 2
    return 0


def scenario_json_linux(
    args,
    file: Path | None,
    first_line: str | None,
    workspace: Path,
    fixtures: dict | None,
    pdf: dict | None = None,
) -> dict:
    """The scenario as the driver receives it (Linux; no synthetic agent)."""
    local: dict[str, str | None] = {}
    for entry in args.local_storage:
        key, _, value = entry.partition("=")
        local[key] = None if value == "null" else value
    for entry in args.toggle:
        key, _, value = entry.partition("=")
        local[f"terax:bench:{key}"] = value or "1"
    # The bench build mounts the real App, whose updater auto-checks on mount: on Linux that
    # fetches api.github.com and can raise a dialog over the window. Preseed the throttle.
    local.setdefault("terax:updater:last-check", str(int(time.time() * 1000)))
    width, height = (float(value) for value in args.window.lower().split("x"))
    # The preview driver builds its fixture URL from TERAX_BENCH_REPORT_URL, which the
    # run's own server serves; it needs no extra scenario fields.
    scenario = {
        "name": args.scenario,
        "window": {"width": width, "height": height},
        "cwds": {"shell": str(workspace)},
        "localStorage": local,
    }
    if args.scenario == "workflow":
        scenario.update({"file": str(file), "fileText": first_line})
    if args.scenario == "preview" and pdf:
        files = pdf["manifest"]["files"]
        scenario["pdf"] = {
            "files": pdf["paths"],
            "sizes": {key: files[key]["bytes"] for key in pdf["paths"]},
            "textPages": files["text"]["pages"],
            "searchPrefix": "SEARCH-NEEDLE-",
            "searchTemplate": files["text"]["tokens"]["searchTemplate"],
            "uniqueNeedle": files["text"]["tokens"]["unique"],
            "uniquePage": files["text"]["tokens"]["uniquePage"],
            "ceilingBytes": pdf["manifest"]["ceiling"]["pageBytes"],
            "renders": {
                key: files[key].get("renders", [])
                for key in ("text", "zoomed-a4", "large-page")
            },
            "pagePt": {key: files[key].get("page") for key in ("text", "zoomed-a4", "large-page")},
        }
    if args.scenario in ("resource", "stress") and fixtures:
        node = shutil.which("node")
        if not node:
            raise SystemExit("node is required for the streaming terminal fixture")
        stress = args.scenario == "stress"
        scenario.update({
            "agentCommand": f"exec {node} {HERE / 'agent-sim.mjs'}",
            "workspace": str(workspace),
            "files": fixtures["files"],
            "closeFile": fixtures["closeFile"],
            "previewUrl": fixtures["previewUrl"],
            "workload": fixtures["workload"],
            "agents": args.agents if args.agents is not None else (4 if stress else 2),
            "streams": args.streams if args.streams is not None else (4 if stress else 2),
            "streamSeconds": int(args.stream_seconds if args.stream_seconds is not None else (args.duration or 30)),
            "closeCycles": args.close_cycles,
            "cycles": args.cycles if args.cycles is not None else 3,
            "idleSeconds": args.idle_seconds,
            "hiddenMs": args.hidden_ms,
            "visibleMs": args.visible_ms,
            "streamCommand": f"exec {node} {HERE / 'stream-sim.mjs'} --rate {args.stream_rate:g}",
        })
    return scenario


def build_startup_entry(kind: str, launch: int, event: dict, spawned_wall_s: float) -> dict:
    """One startup measurement from the boot milestone event.

    `native.startedUnixMs` is the host process's wall-clock start (btime + start ticks, read by
    the app itself); `perf.timeOrigin` is the page's navigation start. The difference is the work
    before the page exists (loader, GTK, WebKit); `perf.uptimeMs` is navigation -> boot. The
    harness's own spawn timestamp is kept as a cross-check, never as the primary figure.
    """
    native = event.get("native") or {}
    perf = event.get("perf") or {}

    def number(value):
        return round(value, 3) if isinstance(value, (int, float)) else None

    started = native.get("startedUnixMs") or 0
    origin = perf.get("timeOrigin")
    uptime = perf.get("uptimeMs")
    wall = event.get("tWall")
    exec_to_nav = number(origin - started) if started and origin else None
    nav_to_boot = number(uptime)
    exec_to_boot = None
    if exec_to_nav is not None and nav_to_boot is not None:
        exec_to_boot = round(exec_to_nav + nav_to_boot, 3)
    elif started and wall:
        exec_to_boot = number(wall - started)
    return {
        "launch": launch,
        "kind": kind,
        "phase": event.get("phase"),
        "exec_to_nav_ms": exec_to_nav,
        "nav_to_boot_ms": nav_to_boot,
        "exec_to_boot_ms": exec_to_boot,
        "first_paint_ms": number(perf.get("firstPaintMs")),
        "first_contentful_paint_ms": number(perf.get("firstContentfulPaintMs")),
        "dom_content_loaded_ms": number(perf.get("domContentLoadedMs")),
        "load_ms": number(perf.get("loadEventMs")),
        "harness_spawn_to_boot_ms": round((time.time() - spawned_wall_s) * 1000, 3),
        "native_started_unix_ms": int(started) if started else None,
        "time_origin_unix_ms": number(origin),
        "event_wall_ms": wall,
    }


# ---------------------------------------------------------------------------------------------
# Fixtures (small, deterministic documents/media for the resource workload)
# ---------------------------------------------------------------------------------------------

LIMITATIONS_LINUX = [
    "PDF: the fixture documents are generated and verified by "
    "scripts/app-lab/pdf_fixtures.py, but the reader functions themselves (navigation, zoom, "
    "search, text selection inside the page) cannot be driven from this harness: WebKitGTK hands "
    "the PDF to its own separate document (the built-in PDF.js viewer at "
    "webkit-pdfjs-viewer://), which the app page cannot script or even read. Those checks are "
    "named manual checks in docs/architecture/pdf-reader.md, not automated passes.",
    "Audio and video codecs are not exercised: the only media fixture is a 64x64 PNG decoded by "
    "the HTML preview.",
    "GPU/VRAM use is not per-process attributable on Linux: /proc exposes no per-process GPU "
    "figure, so dmabuf/shared pages appear only inside Pss/Rss where they are mapped.",
    "The app's own structures are not split by allocator: Linux has no footprint --categories "
    "equivalent here, so only Pss/Rss/private/shared/swap per role are reported. WebKit's JS "
    "heap and malloc zones cannot be separated from the rest of the web process.",
    "The 1 Hz timeline can miss sub-second peaks; event samples are the more precise figures.",
    "No layer tree, occlusion state or native input injection exists on WebKitGTK (ticket 32), "
    "so hidden-window behaviour is measured from window visibility only and document "
    "visibility is advisory.",
    "Package size covers the bench binary and the frontend dist only; real deb/rpm/AppImage "
    "packages are ticket #36 and are not produced by --no-bundle.",
    "Single machine, single display, single session: not another user's fonts, shell config, "
    "compositor or a packaged/signed install.",
]


def _png_bytes(width: int, height: int) -> bytes:
    import struct
    import zlib

    rows = []
    for y in range(height):
        row = bytearray(b"\x00")  # filter: none
        for x in range(width):
            row += bytes(((x * 4) % 256, (y * 4) % 256, ((x + y) * 2) % 256))
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def _text_file(path: Path, lines: int, width: int = 96, seed: int = 1) -> None:
    words = (
        "renderer terminal scrollback pane split space preview editor memory baseline streaming "
        "window hidden process helper sampler counter fixture workload"
    ).split()
    with path.open("w") as handle:
        for line in range(lines):
            handle.write(f"{line:05d} " + " ".join(words[(line + offset + seed) % len(words)] for offset in range(width // 8))[:width] + "\n")


def prepare_fixtures(workspace: Path, stress: bool) -> dict:
    """Create the accepted workload's fixtures deterministically (no random content)."""
    workspace.mkdir(parents=True, exist_ok=True)
    notes = workspace / "notes.txt"
    todos = workspace / "todos.md"
    data = workspace / "data.csv"
    medium = workspace / "medium.txt"
    large = workspace / "large.txt"
    preview = workspace / "preview.html"
    image = workspace / "pixel.png"
    document = workspace / "fixture.pdf"

    _text_file(notes, 120, seed=1)
    todos.write_text(
        "# Baseline fixtures\n\n"
        "- [x] note the toolchain and the host stack\n"
        "- [x] record the cold and warm startup\n"
        "- [ ] compare a candidate build with the baseline\n\n"
        "| metric | unit |\n| --- | --- |\n| memory | MiB PSS |\n| startup | ms |\n"
    )
    with data.open("w") as handle:
        handle.write("line,role,pss_kib,cpu_ticks\n")
        for row in range(400):
            handle.write(f"{row},host,{(row * 37) % 5000},{row % 200}\n")
    _text_file(medium, 3000, seed=2)
    _text_file(large, 40000, seed=3)
    image.write_bytes(_png_bytes(64, 64))
    preview.write_text(
        "<!doctype html><html><head><meta charset='utf-8'><title>fixture preview</title>"
        "<style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse}"
        "td,th{border:1px solid #888;padding:4px 8px}</style></head><body>"
        "<h1>Preview fixture</h1><p>Static, local, deterministic. The image is a real 64x64 PNG.</p>"
        "<img src='pixel.png' width='128' height='128' alt='gradient fixture'>"
        "<table><tr><th>metric</th><th>unit</th></tr><tr><td>memory</td><td>MiB PSS</td></tr>"
        "<tr><td>startup</td><td>ms</td></tr></table>"
        "<p id='dom'>dom ready</p><script>document.querySelector('#dom').textContent='dom script ran';</script>"
        "</body></html>"
    )
    document.write_bytes(
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R"
        b"/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
        b"4 0 obj<</Length 45>>stream\nBT /F1 12 Tf 20 100 Td (fixture) Tj ET\nendstream endobj\n"
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
        b"trailer<</Root 1 0 R>>\n%%EOF\n"
    )
    (workspace / "README-FIXTURES.md").write_text(
        "# App-lab fixtures\n\n"
        f"Generated deterministically by `scripts/app-lab/run.py` for the {'stress' if stress else 'representative'} workload.\n\n"
        "- notes.txt (120 lines) and todos.md: opened as editor tabs\n"
        "- data.csv (400 rows): opened as an editor tab\n"
        "- medium.txt (3000 lines): opened and closed in every close cycle\n"
        "- large.txt (40000 lines): the stress workload's close-cycle file\n"
        "- preview.html + pixel.png: served over local HTTP and shown in the active preview pane\n"
        "- fixture.pdf: exists only to document that PDF is not rendered\n"
    )
    files = [str(notes), str(todos), str(data), str(medium)]
    return {
        "files": files,
        "closeFile": str(large if stress else medium),
        "previewFile": str(preview),
        "imageFile": str(image),
        "documentFile": str(document),
        "workloadFiles": [str(path.relative_to(workspace)) for path in (notes, todos, data, medium, large, preview, image, document)],
    }


def prepare_pdf_fixtures(workspace: Path) -> dict:
    """Generate the PDF documents the preview scenario opens, and verify them independently.

    The files are written by `scripts/app-lab/pdf_fixtures.py` (deterministic; a rebuild is
    byte-identical) into the run's own workspace, never the repository. Verification is real: a
    PDF tool reads each document, counts its pages, finds its searchable tokens and rasterises a
    page, so a fixture that does not have the property the scenario relies on stops the run here
    instead of producing a passing scenario about the wrong file.
    """
    directory = workspace / "pdf"
    manifest = pdf_fixtures.build(directory)
    verification = pdf_fixtures.verify(directory, manifest)
    files = manifest["files"]
    print(
        f"pdf fixtures: {len(files)} documents in {directory} "
        f"({files['text']['pages']} pages, ceiling {manifest['ceiling']['pageBytes'] // (1024 * 1024)} MiB/page)"
    )
    return {
        "directory": str(directory),
        "manifest": manifest,
        "verification": verification,
        "paths": {key: str(directory / entry["name"]) for key, entry in files.items()},
    }


class FixtureServer:
    """Serves the fixture directory on 127.0.0.1 and records what was actually fetched.

    The request log is evidence that the active preview loaded the local HTML and decoded the
    PNG; the runner does not pretend to inspect the rendered pixels.
    """

    def __init__(self, directory: Path):
        self.requests: list[str] = []
        outer = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *_args):  # keep the run log clean
                pass

            def do_GET(self):  # noqa: N802 - http.server's spelling
                outer.requests.append(self.path)
                super().do_GET()

        handler = functools.partial(Handler, directory=str(directory))
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, name: str) -> str:
        return f"http://127.0.0.1:{self.httpd.server_port}/{name}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


def harness_revision() -> dict:
    """The revision of the runner itself, so an `--app` run says which harness measured it."""
    root = HERE.parent.parent
    try:
        revision = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10
        )
        dirty = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain", "--", "scripts/app-lab", "scripts/linux_profile.py", "scripts/namespace_sentinels.py"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"revision": "", "dirty": None}
    return {
        "revision": revision.stdout.strip() if revision.returncode == 0 else "",
        "dirty": bool(dirty.stdout.strip()) if dirty.returncode == 0 else None,
    }


def toolchains() -> dict:
    """The compilers/runtimes a report was built with (recorded, never asserted)."""
    def version(*command: str) -> str:
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return (result.stdout or result.stderr).strip().splitlines()[0] if result.returncode == 0 and (result.stdout or result.stderr) else ""

    return {
        "rustc": version("rustc", "-V"),
        "cargo": version("cargo", "-V"),
        "node": version("node", "--version"),
        "pnpm": version("pnpm", "--version"),
        "python": platform.python_version(),
        "vite": version("node", "node_modules/vite/bin/vite.js", "--version"),
        "cc": version("cc", "--version"),
    }


def package_sizes(binary: Path, output: Path) -> dict:
    """Every size that is observable without packaging a release artifact."""
    def tree_bytes(path: Path) -> int:
        if not path.exists():
            return 0
        return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())

    no_bundle = "not produced (--no-bundle): deb/rpm/AppImage belong to ticket #36"
    sizes = {
        "benchBinaryBytes": binary.stat().st_size if binary.exists() else 0,
        "frontendDistBytes": tree_bytes(output / "dist"),
        "bundle": no_bundle,
        "note": (
            "The bench binary is a release-mode binary with the `bench` feature and a "
            "diagnostics-enabled frontend; it is an upper bound for the shipped Linux binary, "
            "not a package. Installed footprint, .deb/.rpm/.AppImage compression and the CLI "
            "sidecar are not observable from --no-bundle."
        ),
    }
    build_seconds = output / "build-seconds.json"
    if build_seconds.exists():
        sizes["buildSeconds"] = json.loads(build_seconds.read_text())
    return sizes


def describe_workload(args, fixtures: dict) -> str:
    stress = args.scenario == "stress"
    agents = args.agents if args.agents is not None else (4 if stress else 2)
    streams = args.streams if args.streams is not None else (4 if stress else 2)
    files = len(fixtures["files"]) if fixtures else 0
    kind = "stress" if stress else "representative"
    return (
        f"{kind} workload (provisional, accepted by the spec; not observed user usage): "
        f"2 Spaces, 4 terminal panes, {agents} synthetic busy agents, {files} text files, "
        f"1 active local preview, {streams} streaming panes"
    )


def open_focus_stealer() -> dict:
    """Opens a separate application window so the app loses focus while staying visible.

    Wayland offers no way to take focus from a process, but a newly mapped toplevel usually
    takes it; the scenario driver records whether a blur was actually observed, so a desktop
    that refuses to hand focus over is reported instead of assumed.
    """
    for tool in ("zenity", "yad"):
        binary = shutil.which(tool)
        if not binary:
            continue
        try:
            process = subprocess.Popen(
                [binary, "--info", "--text=Terax preview focus probe", "--timeout=6"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError as error:
            return {"tool": None, "reason": f"{tool}: {error}"}
        return {"tool": tool, "pid": process.pid}
    return {"tool": None, "reason": "no zenity or yad on this host"}


def run_linux(args, binary: Path, source: Path, output: Path) -> int:
    """Launch the real WebKitGTK app in a disposable profile and measure it from /proc.

    Everything the report calls a measurement is sampled here: per-event memory (Pss/Rss per
    role), a 1 Hz counter timeline, startup from the app's own process start and page clock, and
    the workload's files. The app never reports its own resource use; only pids and the page's
    timing come from inside it.
    """
    if args.scenario == "startup":
        return run_linux_startup(args, binary, source, output)
    home = output / "home"
    linux_profile.prepare(home, output)
    # Coexistence: a synthetic installed upstream Terax owns state in this same profile. The
    # run must create only fork-namespaced state and leave every upstream byte untouched.
    sentinels = namespace_sentinels.seed(home)
    workspace = output / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    fixture_server = None
    fixtures = None
    pdf = None
    file = None
    first_line = ""
    if args.scenario in ("resource", "stress"):
        fixtures = prepare_fixtures(workspace, args.scenario == "stress")
        fixture_server = FixtureServer(workspace)
        fixtures["previewUrl"] = fixture_server.url("preview.html")
        fixtures["workload"] = describe_workload(args, fixtures)
    elif args.scenario == "preview":
        pdf = prepare_pdf_fixtures(workspace)
    else:
        token = uuid.uuid4().hex[:10]
        first_line = f"workflow-file {token}"
        file = output / "workflow-file.txt"
        file.write_text(f"{first_line}\nsecond line for the editor\n")
    report_path = (args.report or output / "report.json").resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    scenario = scenario_json_linux(args, file, first_line, workspace, fixtures, pdf)
    timeout = host_timeout(args, scenario)
    load_average = [round(value, 2) for value in os.getloadavg()]

    server = ReportServer()
    env = {**{key: value for key, value in os.environ.items() if not key.startswith(("TAURI_", "VITE_", "CARGO_"))}}
    env.update(linux_profile.profile_env(home))
    env.update(linux_profile.session_env())
    env.update({
        "TERAX_BENCH_ISOLATED": "1",
        "TERAX_BENCH_SCENARIO": json.dumps(scenario),
        "TERAX_BENCH_REPORT_URL": server.url,
    })
    linux_profile.preflight(args.identifier, env, output, require_isolated=True)

    revision = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], text=True, capture_output=True)
    has_git = revision.returncode == 0 and (source / ".git").exists()
    build_seconds = {}
    if (output / "build-seconds.json").exists():
        build_seconds = json.loads((output / "build-seconds.json").read_text())
    manifest = {
        "schema": "terax-app-lab/1",
        "scope": (
            "The real Linux/WebKitGTK application (bench build: full React shell, real PTYs, tabs, "
            "Spaces, splits, editor and preview) in a disposable profile, driven by the in-app "
            "scenario driver over the local report server. Whole-application memory, CPU and "
            "startup are sampled from /proc by this orchestrator, not reported by the app; "
            "external PTY/agent processes are reported separately. Package sizes are the bench "
            "binary and frontend dist only (no deb/rpm/AppImage)."
        ),
        "config": {
            "scenario": args.scenario, "label": args.label, "profile": args.profile,
            "hostTimeoutS": timeout, "scenarioJson": {k: v for k, v in scenario.items() if k != "localStorage"},
            "scenarioVariant": {
                key: scenario.get(key)
                for key in ("agents", "streams", "streamSeconds", "cycles", "closeCycles", "hiddenMs", "visibleMs", "window", "files")
            },
            "buildSeconds": build_seconds, "window": args.window,
            "pollIntervalS": args.poll_interval, "harness": harness_revision(),
        },
        "sourceRevision": revision.stdout.strip() if has_git else args.revision,
        "sourceTree": str(source),
        "platform": platform.platform(),
        "environment": {**linux_profile.host_stack(), "toolchains": toolchains()},
        "isolation": isolation_report.block(args.identifier, env, home, sentinels, output),
        "appBinarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "qualification": {"qualified": True, "failures": [], "advisories": []},
        "warnings": [],
        "samples": [],
        "series": [],
        "startup": [],
        "workload": fixtures["workload"] if fixtures else (
            "Linux preview acceptance (web-frame teardown/reload plus PDF fixtures)"
            if pdf else "Linux acceptance workflow only (no resource workload)"
        ),
        "limitations": list(LIMITATIONS_LINUX),
    }
    if pdf:
        # The generated fixtures and their independent (poppler) verification travel with the
        # report, so the evidence names the exact documents the app opened.
        manifest["pdf"] = {
            "directory": pdf["directory"],
            "documents": pdf["manifest"],
            "verification": pdf["verification"],
        }
    manifest["environment"]["loadAverageStart"] = load_average
    log = (output / "app.log").open("w")
    spawned_wall = time.time()
    process = subprocess.Popen(
        [str(binary), str(workspace)],
        cwd=home,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    manifest["hostPid"] = process.pid
    poller = linux_proc.Poller(args.poll_interval)
    poller.set_host(process.pid)
    poller.start()
    failed: BaseException | None = None
    workflow: dict = {}
    started = time.monotonic()

    def take_sample(phase: str, event: dict, elapsed: float) -> dict:
        found = linux_proc.sample(process.pid)
        return {
            "phase": phase,
            "tMonoNs": found["tMonoNs"],
            "elapsedS": elapsed,
            "event": app_report.slim_event(event),
            "memory": found,
            "loadAverage": [round(value, 2) for value in os.getloadavg()],
        }

    try:
        deadline = started + timeout
        first_event_by = started + 180
        while True:
            try:
                event, done, _reply = server.events.get(timeout=1)
            except queue.Empty:
                if process.poll() is not None:
                    raise RuntimeError(f"The app exited ({process.returncode}) before finishing; see {output / 'app.log'}")
                if time.monotonic() > deadline:
                    raise RuntimeError(f"Timed out after {timeout:.0f}s")
                if not manifest["samples"] and time.monotonic() > first_event_by:
                    raise RuntimeError(f"The scenario driver never reported (page log: {server.log[-3:]}); see {output / 'app.log'}")
                continue
            phase = event.get("phase")
            try:
                if "appIdentifier" not in manifest and isinstance(event.get("identifier"), str):
                    manifest["appIdentifier"] = event["identifier"]
                    manifest["appIdentifierInForkNamespace"] = event["identifier"].startswith(
                        f"{linux_profile.PRODUCT_IDENTIFIER}."
                    )
                if phase == "error":
                    raise RuntimeError(event)
                if phase == "done":
                    manifest["samples"].append({"phase": "done", "tMonoNs": time.monotonic_ns(), "event": app_report.slim_event(event)})
                    workflow = event.get("workflow") or {}
                    if event.get("preview") is not None:
                        # Scenario-specific evidence that is not a pass/fail step: how many
                        # frame instances were loaded, whether the blur was exercised, and what
                        # the desktop reported for minimize.
                        manifest["preview"] = event["preview"]
                    break
                if phase == "preview-blur":
                    # The window must lose OS focus while staying visible, so a separate
                    # application window is opened. The driver records whether a blur was
                    # actually observed instead of assuming it.
                    focus_stealer = open_focus_stealer()
                    manifest["focusStealer"] = focus_stealer
                    if not focus_stealer.get("tool"):
                        manifest["qualification"]["advisories"].append(
                            "visible blur could not be exercised: no zenity/yad on this host"
                        )
                reasons = app_report.qualify(args.scenario, phase, event)
                elapsed = time.monotonic() - started
                sample = take_sample(phase, event, elapsed)
                if not manifest["startup"] and phase in ("booted", "workflow-shell"):
                    manifest["startup"].append(build_startup_entry("cold", 1, event, spawned_wall))
                manifest["samples"].append(sample)
                if reasons:
                    manifest["qualification"]["qualified"] = False
                    manifest["qualification"]["failures"].append({"phase": phase, "reasons": reasons})
                print(json.dumps({
                    "phase": phase,
                    "pssMiB": round(sample["memory"]["total"]["pss"] / linux_proc.MIB, 1),
                    "appMiB": round(sample["memory"]["app"]["pss"] / linux_proc.MIB, 1),
                    "workloadMiB": round(sample["memory"]["workload"]["pss"] / linux_proc.MIB, 1),
                    **({"unqualified": reasons} if reasons else {}),
                }), flush=True)
            finally:
                done.set()
    except BaseException as error:  # a partial report is still worth keeping
        failed = error
        manifest["incomplete"] = True
        manifest["error"] = repr(error)
    finally:
        poller.stop()
        for kill in (signal.SIGTERM, signal.SIGKILL):
            if process.poll() is not None:
                break
            try:
                os.killpg(process.pid, kill)
            except ProcessLookupError:
                break
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        if fixture_server is not None:
            manifest["environment"]["fixtureRequests"] = sorted(set(fixture_server.requests))
            fixture_server.close()
        server.httpd.shutdown()
        log.close()
        if server.log:
            (output / "page.log").write_text("\n".join(server.log))
        manifest["workflow"] = workflow
        # The fixture server is the independent process previews are served by; these counters
        # show it kept answering across every frame teardown.
        manifest["previewServer"] = {
            "fixtureLoads": server.fixture_loads,
            "redirectHits": server.redirect_hits,
            "pings": server.pings,
        }
        # Coexistence evidence: the hashes of the upstream installation's files, taken before
        # the launch, must still match now that the application has run and exited.
        if manifest.get("appIdentifierInForkNamespace") is False:
            manifest["qualification"]["advisories"].append(
                f"the measured binary was compiled with the identifier "
                f"{manifest.get('appIdentifier')!r}, which is outside the fork identifier namespace; "
                f"the profile is still private, but this revision predates the fork identity table"
            )
        unchanged = isolation_report.finish(manifest["isolation"], home, sentinels)
        if unchanged:
            manifest["qualification"]["qualified"] = False
            manifest["qualification"]["failures"].append(
                {"phase": "coexistence", "reasons": unchanged}
            )
        manifest["environment"]["loadAverageEnd"] = [round(value, 2) for value in os.getloadavg()]
        unfocused = [
            sample["phase"] for sample in manifest["samples"]
            if (sample["event"].get("native") or {}).get("appActive") is False
        ]
        if unfocused:
            shown = ", ".join(unfocused[:6]) + ("..." if len(unfocused) > 6 else "")
            manifest["qualification"]["advisories"].append(
                f"focus is advisory on Wayland (the compositor decides): appActive=false in "
                f"{len(unfocused)} of {len(manifest['samples'])} phases ({shown})"
            )
        busy = max((entry.get("loadAverage", [0])[0] for entry in poller.series), default=0)
        cpus = int(manifest["environment"].get("logicalCpus") or 0)
        if cpus and busy > cpus / 2:
            manifest["qualification"]["advisories"].append(
                f"host load average reached {busy:.1f} on {cpus} logical CPUs during the run; "
                f"startup and CPU figures may be inflated by other work"
            )
        manifest["series"] = poller.series
        manifest["linux"] = {
            "sampler": "procfs",
            "pollIntervalS": args.poll_interval,
            "pssIsUniqueMemory": True,
            "roles": list(linux_proc.ROLE_ORDER),
            "workloadFiles": fixtures["workloadFiles"] if fixtures else [],
            "fixtures": {
                key: value
                for key, value in (fixtures or {}).items()
                if key in ("previewFile", "imageFile", "documentFile", "closeFile")
            },
            "pollerErrors": poller.errors,
        }
        manifest["package"] = package_sizes(binary, output)
        for sample in reversed(manifest["samples"]):
            diag = (sample.get("event") or {}).get("diag") or {}
            if "devicePixelRatio" in diag:
                manifest["environment"]["observedDevicePixelRatio"] = diag["devicePixelRatio"]
                break
        if workflow:
            manifest["qualification"]["workflowPass"] = bool(workflow.get("pass"))
        completed = [sample for sample in manifest["samples"] if "memory" in sample]
        if completed:
            try:
                manifest["metrics"] = linux_report.round_metrics(linux_report.compute_metrics(manifest))
                manifest["humanSummary"] = linux_report.summarize(manifest)
            except Exception as error:  # a report without metrics is still evidence
                manifest["metricsError"] = repr(error)
        reasons = isolation_report.problems(manifest, output)
        if reasons:
            raise RuntimeError("refusing to write a report without isolation evidence: " + "; ".join(reasons))
        report_path.write_text(app_report.dump(manifest))
        linux_profile.cleanup(home, output)
    if failed is not None:
        raise failed
    if args.scenario in ("workflow", "preview"):
        steps = workflow.get("steps") or []
        passed = sum(1 for step in steps if step.get("ok"))
        print(f"{args.scenario} {'PASS' if workflow.get('pass') else 'FAIL'}: {passed}/{len(steps)} steps")
        for step in steps:
            if not step.get("ok"):
                print(f"  FAIL {step.get('name')}: {step.get('detail')}")
    isolation = manifest["isolation"]
    print(
        f"coexistence {'PASS' if isolation['upstreamStateUnchanged'] else 'FAIL'}: "
        f"{isolation['upstreamSentinels']['files']} upstream files unchanged; "
        f"descriptor {'published' if isolation['controlDescriptorPublished'] else 'MISSING'} at "
        f"{isolation['fork']['controlDescriptor']}"
    )
    if "humanSummary" in manifest:
        print("\n" + manifest["humanSummary"])
    if args.compare:
        print("\n" + linux_report.compare(
            [app_report.load(path) for path in args.compare], [manifest], args.compare_format
        ))
    print(f"\nSaved {report_path}")
    if args.scenario in ("workflow", "preview") and not workflow.get("pass"):
        print(f"Run failed: the {args.scenario} scenario reported a failing step (see page.log).", file=sys.stderr)
        return 2
    if not isolation["upstreamStateUnchanged"]:
        print(
            "Run failed: the run changed upstream state: "
            + "; ".join(isolation["upstreamStateChanges"]),
            file=sys.stderr,
        )
        return 3
    return 0


def run_linux_startup(args, binary: Path, source: Path, output: Path) -> int:
    """Cold and warm startup: one fresh profile, then relaunches against the same profile.

    The first launch runs against an empty profile directory (cold: no WebKit caches, no
    localStorage, no control descriptor); later launches reuse that profile (warm: the app's own
    caches are populated). Every launch is the same boot-only scenario, so the difference is
    caches, not workload.
    """
    home = output / "home"
    linux_profile.prepare(home, output)
    sentinels = namespace_sentinels.seed(home)
    workspace = output / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    report_path = (args.report or output / "report.json").resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    repeats = max(1, args.startup_repeats)
    revision = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], text=True, capture_output=True)
    has_git = revision.returncode == 0 and (source / ".git").exists()
    manifest = {
        "schema": "terax-app-lab/1",
        "scope": (
            "Cold and warm startup of the real Linux/WebKitGTK application in a disposable "
            "profile. Startup is measured from the host process's /proc start time and the "
            "page's navigation-start clock to the first live terminal tab; the harness's spawn "
            "timestamp is recorded as a cross-check only."
        ),
        "config": {
            "scenario": "startup", "label": args.label, "profile": args.profile, "window": args.window,
            "scenarioVariant": {"repeats": repeats, "window": args.window},
            "pollIntervalS": args.poll_interval, "harness": harness_revision(),
        },
        "sourceRevision": revision.stdout.strip() if has_git else args.revision,
        "sourceTree": str(source),
        "platform": platform.platform(),
        "environment": {**linux_profile.host_stack(), "toolchains": toolchains()},
        "appBinarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "qualification": {"qualified": True, "failures": [], "advisories": []},
        "warnings": [],
        "samples": [],
        "series": [],
        "startup": [],
        "workload": "boot-only startup scenario (no terminal workload besides the boot shell)",
        "limitations": list(LIMITATIONS_LINUX),
        "package": package_sizes(binary, output),
    }
    manifest["environment"]["loadAverageStart"] = [round(value, 2) for value in os.getloadavg()]
    env = {**{key: value for key, value in os.environ.items() if not key.startswith(("TAURI_", "VITE_", "CARGO_"))}}
    env.update(linux_profile.profile_env(home))
    env.update(linux_profile.session_env())
    # The startup report carries the same isolation evidence as the measured scenarios: the
    # profile the preflight accepts and, after every launch, the upstream sentinels unchanged.
    manifest["isolation"] = isolation_report.block(
        args.identifier, {**env, "TERAX_BENCH_ISOLATED": "1"}, home, sentinels, output
    )
    scenario = scenario_json_linux(args, None, None, workspace, None)
    try:
        for launch in range(1, repeats + 1):
            kind = "cold" if launch == 1 else "warm"
            server = ReportServer()
            launch_env = {**env, "TERAX_BENCH_ISOLATED": "1", "TERAX_BENCH_REPORT_URL": server.url,
                          "TERAX_BENCH_SCENARIO": json.dumps(scenario)}
            linux_profile.preflight(args.identifier, launch_env, output, require_isolated=True)
            log = (output / f"app-{launch}.log").open("w")
            spawned_wall = time.time()
            process = subprocess.Popen(
                [str(binary), str(workspace)], cwd=home, env=launch_env,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            poller = linux_proc.Poller(args.poll_interval)
            poller.set_host(process.pid)
            poller.start()
            started = time.monotonic()
            booted = None
            try:
                while True:
                    try:
                        event, done, _reply = server.events.get(timeout=1)
                    except queue.Empty:
                        if process.poll() is not None:
                            raise RuntimeError(f"launch {launch} exited ({process.returncode}) before booting; see {output / f'app-{launch}.log'}")
                        if time.monotonic() - started > 180:
                            raise RuntimeError(f"launch {launch} did not boot within 180 s")
                        continue
                    phase = event.get("phase")
                    try:
                        if "appIdentifier" not in manifest and isinstance(event.get("identifier"), str):
                            manifest["appIdentifier"] = event["identifier"]
                            manifest["appIdentifierInForkNamespace"] = event["identifier"].startswith(
                                f"{linux_profile.PRODUCT_IDENTIFIER}."
                            )
                        if phase == "booted":
                            booted = build_startup_entry(kind, launch, event, spawned_wall)
                            found = linux_proc.sample(process.pid)
                            booted["pssMiB"] = round(found["total"]["pss"] / linux_proc.MIB, 2)
                            booted["appPssMiB"] = round(found["app"]["pss"] / linux_proc.MIB, 2)
                            booted["workloadPssMiB"] = round(found["workload"]["pss"] / linux_proc.MIB, 2)
                            manifest["startup"].append(booted)
                            manifest["samples"].append({
                                "phase": "booted",
                                "launch": launch,
                                "kind": kind,
                                "tMonoNs": found["tMonoNs"],
                                "event": app_report.slim_event(event),
                                "memory": found,
                                "loadAverage": [round(value, 2) for value in os.getloadavg()],
                            })
                        if phase == "done":
                            break
                        if phase == "error":
                            raise RuntimeError(event)
                    finally:
                        done.set()
            finally:
                poller.stop()
                for kill in (signal.SIGTERM, signal.SIGKILL):
                    if process.poll() is not None:
                        break
                    try:
                        os.killpg(process.pid, kill)
                    except ProcessLookupError:
                        break
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
                server.httpd.shutdown()
                log.close()
                if server.log:
                    (output / f"page-{launch}.log").write_text("\n".join(server.log))
                manifest["series"] = poller.series
            if booted is None:
                raise RuntimeError(f"launch {launch} reported no boot milestone")
            print(json.dumps({key: booted.get(key) for key in ("launch", "kind", "exec_to_boot_ms", "nav_to_boot_ms", "first_paint_ms")}), flush=True)
        if manifest.get("appIdentifierInForkNamespace") is False:
            manifest["qualification"]["advisories"].append(
                f"the measured binary was compiled with the identifier "
                f"{manifest.get('appIdentifier')!r}, which is outside the fork identifier namespace; "
                f"the profile is still private, but this revision predates the fork identity table"
            )
        unchanged = isolation_report.finish(manifest["isolation"], home, sentinels)
        if unchanged:
            manifest["qualification"]["qualified"] = False
            manifest["qualification"]["failures"].append(
                {"phase": "coexistence", "reasons": unchanged}
            )
        manifest["environment"]["loadAverageEnd"] = [round(value, 2) for value in os.getloadavg()]
        manifest["linux"] = {
            "sampler": "procfs",
            "pollIntervalS": args.poll_interval,
            "pssIsUniqueMemory": True,
            "roles": list(linux_proc.ROLE_ORDER),
            "seriesLaunch": repeats,
            "seriesNote": "the timeline covers the last (warm) launch; startup entries cover every launch",
        }
        manifest["metrics"] = linux_report.round_metrics(linux_report.compute_metrics(manifest))
        manifest["humanSummary"] = linux_report.summarize(manifest)
    except BaseException as error:
        manifest["incomplete"] = True
        manifest["error"] = repr(error)
        isolation_report.finish(manifest["isolation"], home, sentinels)
        reasons = isolation_report.problems(manifest, output)
        if reasons:
            raise RuntimeError(
                "refusing to write an incomplete report without isolation evidence: "
                + "; ".join(reasons)
            ) from error
        report_path.write_text(app_report.dump(manifest))
        linux_profile.cleanup(home, output)
        raise
    reasons = isolation_report.problems(manifest, output)
    if reasons:
        raise RuntimeError("refusing to write a report without isolation evidence: " + "; ".join(reasons))
    report_path.write_text(app_report.dump(manifest))
    linux_profile.cleanup(home, output)
    print(
        f"\ncoexistence {'PASS' if manifest['isolation']['upstreamStateUnchanged'] else 'FAIL'}: "
        f"{manifest['isolation']['upstreamSentinels']['files']} upstream files unchanged; "
        f"descriptor {'published' if manifest['isolation']['controlDescriptorPublished'] else 'MISSING'}"
    )
    print("\n" + manifest["humanSummary"])
    if args.compare:
        print("\n" + linux_report.compare(
            [app_report.load(path) for path in args.compare], [manifest], args.compare_format
        ))
    print(f"\nSaved {report_path}")
    if not manifest["isolation"]["upstreamStateUnchanged"]:
        print(
            "Run failed: the run changed upstream state: "
            + "; ".join(manifest["isolation"]["upstreamStateChanges"]),
            file=sys.stderr,
        )
        return 3
    return 0


def self_test(args, binary: Path, output: Path) -> int:
    """Prove the two refusals: an unsafe profile is rejected, and the binary's own gate refuses.

    The preflight cases are pure path/identity checks. The last case launches the real bench
    binary without TERAX_BENCH_ISOLATED=1: `modules::bench::guard` fails in `setup`, so the app
    exits nonzero with the reason instead of starting against an undeclared environment.
    """
    scratch = Path(tempfile.mkdtemp(prefix="terax-app-lab-selftest-"))
    failures: list[str] = []
    home = scratch / "home"
    scratch.mkdir(parents=True, exist_ok=True)
    try:
        linux_profile.prepare(home, scratch)
        safe = {**linux_profile.profile_env(home), "TERAX_BENCH_ISOLATED": "1"}
        cases = [
            ("product identifier", linux_profile.PRODUCT_IDENTIFIER, safe),
            ("upstream identifier", linux_profile.UPSTREAM_IDENTIFIER, safe),
            ("foreign identifier namespace", "com.example.other", safe),
            ("HOME outside the run output", f"{IDENTIFIER}-test", {**safe, "HOME": str(Path.home())}),
            ("control-descriptor cache dir", f"{IDENTIFIER}-test", {**safe, "XDG_CACHE_HOME": str(linux_profile.real_cache_dir())}),
            ("missing isolation declaration", f"{IDENTIFIER}-test", {**safe, "TERAX_BENCH_ISOLATED": ""}),
        ]
        for name, identifier, env in cases:
            found = linux_profile.problems(identifier, env, scratch, require_isolated=True)
            print(f"[self-test] {'PASS' if found else 'FAIL'} {name}: {found or 'accepted'}")
            if not found:
                failures.append(name)
        accepted = linux_profile.problems(f"{IDENTIFIER}-test", safe, scratch, require_isolated=True)
        print(f"[self-test] {'PASS' if not accepted else 'FAIL'} disposable profile accepted: {accepted}")
        if accepted:
            failures.append("disposable profile accepted")

        # The coexistence checker must be able to fail: an untouched upstream tree passes, and
        # one modified upstream file is reported.
        sentinels = namespace_sentinels.seed(home)
        untouched = namespace_sentinels.verify(home, sentinels)
        print(f"[self-test] {'PASS' if not untouched else 'FAIL'} upstream sentinels untouched: {untouched}")
        if untouched:
            failures.append("upstream sentinels untouched")
        tampered = home / ".cache" / linux_profile.UPSTREAM_NAMESPACE / "control.json"
        tampered.write_text("{}\n")
        detected = namespace_sentinels.verify(home, sentinels)
        print(f"[self-test] {'PASS' if detected else 'FAIL'} a changed upstream sentinel is detected: {detected}")
        if not detected:
            failures.append("a changed upstream sentinel is detected")

        env = {**os.environ}
        env.update(linux_profile.profile_env(home))
        env.update(linux_profile.session_env())
        env.pop("TERAX_BENCH_ISOLATED", None)
        completed = subprocess.run(
            [str(binary)], cwd=home, env=env, capture_output=True, text=True, timeout=180,
        )
        output_text = completed.stdout + completed.stderr
        refused = completed.returncode != 0 and "TERAX_BENCH_ISOLATED" in output_text
        print(f"[self-test] {'PASS' if refused else 'FAIL'} bench binary refuses an undeclared environment: exit {completed.returncode}")
        if not refused:
            failures.append("bench binary isolation guard")
            print(output_text[-2000:])
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return 1 if failures else 0


def footprint_of(ids: list[int], path: Path, categories: bool) -> dict:
    command = ["footprint", "--swapped", "-j", str(path)]
    if not categories:
        command.insert(1, "--noCategories")
    for pid in ids:
        command += ["-p", str(pid)]
    subprocess.run(command, stdout=subprocess.DEVNULL, check=True)
    footprint = json.loads(path.read_text())
    path.unlink(missing_ok=True)
    if footprint.get("errors"):
        raise RuntimeError(footprint["errors"])
    return footprint


if __name__ == "__main__":
    raise SystemExit(main())

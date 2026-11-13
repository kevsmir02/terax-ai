# App lab: resource benchmark of the real application

`scripts/app-lab` measures the **real** Terax app (full React shell, real PTYs, real
tabs and splits, real window, the release profile users run) instead of the synthetic
renderer in `scripts/renderer-profile`. It exists because the renderer lab did not reproduce
what the user sees every day: memory that jumps on every tab switch and does not come back.
Reports are written to the output directory you pass; they are never committed.

Nothing of it ships. The Rust side is behind the cargo feature `bench`, the frontend behind
`TERAX_BENCH=1` (a Vite `define` that is the literal `false` otherwise, so the driver, its
lazy chunk and every bench-only string are removed before bundling). `src/app/dist-budget.test.ts`
builds the normal frontend and fails if any `bench` chunk or marker string is emitted.

## Running

```sh
# one scenario against this checkout (builds the bench app first; release, private target dir)
python3 scripts/app-lab/run.py --scenario tabs --target-dir /tmp/app-lab-target --report tabs.json

# measure a pristine revision instead of the working tree (HEAD or any rev, plus the overlay)
scripts/app-lab/export-tree.sh /tmp/app-lab-src HEAD
python3 scripts/app-lab/run.py --scenario tabs --source /tmp/app-lab-src --target-dir /tmp/app-lab-target

python3 scripts/app-lab/run.py --compare base.json [base2.json ...] --candidate cand.json
python3 scripts/app-lab/app_report.py report1.json report2.json    # one comparable line per report
```

Build time on an M4 (10 cores): cold release build including every dependency 2 min 14 s;
after a frontend or app change 88 to 90 s (the frontend itself 6 s). `--reuse-build` skips
the build, `--build-only` stops after it, `--app` runs a prebuilt `.app`.

### Linux (WebKitGTK): the workflow and preview seams

`--scenario workflow` drives the real WebKitGTK app through the actions this program's acceptance
seam needs and asserts what the page renders. `--scenario preview` does the same for a web preview
frame: it serves a fixture page from the orchestrator's own HTTP server and drives the app's own
tab, Space and window actions around it.

```sh
# build (debug binary, private target dir, no bundle) and run the workflow
pnpm profile:app:linux
# equivalent, with explicit paths
python3 scripts/app-lab/run.py --scenario workflow --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run

# the preview seam (tab/Space/window teardown, visible blur, frame boundaries)
python3 scripts/app-lab/run.py --scenario preview --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-preview

# the Markdown seam (Space-root assets, consent, symlink escape, grant revocation)
python3 scripts/app-lab/run.py --scenario markdown --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-markdown

# the Spaces lifecycle seam (shared checkout, switch, close guards, Space deletion)
python3 scripts/app-lab/run.py --scenario spaces --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-spaces

# the worktree seam (creation through the panel dialog, derived access, opening the
# result as a Space, and four refusals that leave their targets untouched)
python3 scripts/app-lab/run.py --scenario worktree --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-worktree

# the quit seam (survey across Spaces, repeated close, save-then-quit, graceful
# termination, survivor prompt, forced exit, reload without command replay)
python3 scripts/app-lab/run.py --scenario quit --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-quit

# the image seam (real decode per format, oversized/corrupt refusal, hidden-tab and
# close-cycle release of decoded viewers and grants)
python3 scripts/app-lab/run.py --scenario images --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-images

# the media seam (real container/codec outcomes, ranged delivery and seeking, hidden
# pause without auto-resume, unsupported/corrupt/interrupted inputs, close cleanup)
python3 scripts/app-lab/run.py --scenario media --profile debug \
    --target-dir /tmp/terax-lab-target --output /tmp/terax-lab-run-media

# prove both refusals without running a scenario (preflight + the binary's isolation guard)
python3 scripts/app-lab/run.py --scenario workflow --self-test
```

**Prerequisites** (Fedora 44 KDE Plasma Wayland is the primary host):
`webkit2gtk4.1-devel`, `gtk3-devel`, `librsvg2-devel`, `openssl-devel` (the same set CI installs
for `cargo check`), Rust stable, Node 22+, pnpm, and a live graphical session. The runner launches
the app with `--no-bundle`; no RPM/DEB/AppImage and no `terax-cli` sidecar are involved. Under
Xvfb a window manager is required for focus/visibility and transparency will not work; a real
session is the supported target.

**Automated run.** `.github/workflows/linux-app-smoke.yml` executes this scenario on Xvfb +
openbox in a hosted runner, after `--self-test` proves the refusals, and uploads `report.json`,
`page.log` and the app/build logs as the `linux-app-smoke` artifact. It runs nightly, on demand,
and on pull requests labelled `linux-smoke`; it is evidence, not a required check
(`docs/contributing/testing.md`, "CI").

**Host stack** is recorded in the report's `environment` (never asserted): `/etc/os-release`,
`uname -r`, architecture, `XDG_SESSION_TYPE`/`XDG_CURRENT_DESKTOP`, the live Wayland/X11 display
names, GDK scale variables, the text-scaling factor, matched monospace/sans fonts, the
webkit2gtk/GTK package versions (rpm, dpkg or `pkg-config`), the CPU model, logical CPUs and RAM
from `/proc`, and the observed page `devicePixelRatio` from the last phase. Load average is
recorded at start and end.

**Isolation** (`scripts/linux_profile.py`, shared with `scripts/pty-smoke`): the run gets a
per-run identifier (`<fork identifier>.app-lab-<hex>`, derived from
`src/modules/identity/namespace.json`), its own `HOME` **and** its own
`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`XDG_STATE_HOME` under `<output>/home`, while
`XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` keep coming from the
live session. `XDG_CACHE_HOME` is mandatory: the control server writes
`$XDG_CACHE_HOME/terax-workspace/control.json` and `terax-workspace/run/<pid>/bin/terax`, which are
keyed by the fork namespace, *not* by identifier — inheriting the real cache directory would
overwrite the installed application's live descriptor. The preflight refuses (before the build and
again before the launch) the fork product identifier, **any upstream Terax identifier**, an
identifier outside the fork product namespace, a missing/relative or out-of-output `HOME`/`XDG_*`
directory, the installed app's cache directory, and a bench launch without
`TERAX_BENCH_ISOLATED=1`. `--self-test` exercises every case, proves the coexistence checker both
passes on an untouched upstream tree and fails on a modified one, and then launches the real bench
binary without that variable, asserting it exits nonzero with the guard's message. The profile is
removed before and after the run; `linux_profile.cleanup` refuses paths outside the output
directory. `python3 -m unittest discover -s scripts/tests` covers the same invariants (allow and
deny) without a build.

**Coexistence** (`scripts/namespace_sentinels.py`): before the launch the runner writes a synthetic
*installed upstream Terax* into the same disposable profile — its app config/data/state files, its
`control.json` and per-pid launcher under `$XDG_CACHE_HOME/terax/`, its shell-integration files, its
`conf.d/terax.fish`, and the hook groups it owns in `~/.claude/settings.json`,
`~/.codex/hooks.json`, `~/.gemini/settings.json` and `.pi/agent/extensions/terax-notifications.ts`.
After the app exits, every file and every upstream directory tree is re-hashed. The manifest records
`isolation.upstreamStateUnchanged`, the list of any changes, and the fork's own state
(`isolation.fork`): the descriptor it published, its data directory and its shell-integration
directory. A changed, deleted or newly created upstream file fails the run (exit 3).

`scripts/app-lab/isolation_report.py` builds that block for **every** Linux report — including the
cold/warm `startup` scenario — from the environment the preflight actually accepted (it re-runs
`linux_profile.problems()` and refuses to record a block otherwise), and validates it before the
report is written. A startup report without the private-HOME/XDG record, the disposable identifier
or the upstream-sentinel result cannot exist; `scripts/tests/test_isolation_report.py` asserts the
rejection an empty/defaulted block would otherwise slip through. `config.harness.revision` records
which harness produced a report, which matters when `--app` measures a binary built from another
tree.

**The workflow** (in `src/bench/driver.ts`): a real login shell spawns in the first tab; a written
marker is echoed back and asserted to appear exactly once; a second terminal tab opens; the first
tab's active pane splits and the new leaf gets a live session; the app switches away and back with
the marker still in scrollback; a temp file opens through the app's own tab planner (`openFileTab`)
and the editor's rendered text is asserted. Each step emits `[workflow] PASS|FAIL …` to
`page.log`; the structured summary (`token`, `pass`, `steps`) rides the final `done` sync, the
report stores it under `workflow`, and the runner exits 2 when any step failed.

**The Markdown preview** (`--scenario markdown`) drives the real preview against fixtures the runner
writes: a document inside the Space root, an outside document, a symlink escape, a remote pixel the
runner counts, a link document, a document of hostile references and a document above the 4 MiB
syntax ceiling. It asserts the image
loads from the configured Space root, that changing the terminal cwd through `setLeafCwd` leaves the
same `asset://` token and pixels in place, that an inline image whose header declares a
20 000 x 20 000 raster (~1.5 GiB decoded) is refused with the 64 MiB reason and **no `<img>` in
the document**, that the same oversized image at the end of the 4 MiB document stays `deferred`
(not probed) until it is scrolled into view and is then refused, that the symlink escape is
refused (the bounded surface ends in a read/decode error with no `<img>`), that
an outside document loads from its own folder and only loads a sibling image after the "Allow"
button, that the remote image is absent and the fixture server recorded zero hits until "Load remote
images" is chosen (then one), that a relative link neither navigates the app nor opens a tab, that a
hostile document leaves no executed effect, no `<script>`, no event-handler attribute, no
`javascript:` href and no asset URL the app did not mint with a token, that
the large document renders with `data-syntax="off"`, that closing the tab makes its old asset URL
fail while no content resurfaces, and that closing it while its 4 MiB read is still in flight
leaves no tab, no marker text and no syntax block behind. Pass/fail steps and the remote hit
counters are in the report's `markdown` and `markdownServer` blocks.

**The Spaces lifecycle** (`--scenario spaces`): two Spaces are created on one real checkout and the
rendered `[data-shared-root]` badge is asserted; a shell in the first Space streams five lines
while the app switches to the second Space, and after switching back the scrollback holds all five
while the hidden terminal tab reported `visibility: hidden` (presentation off, output processing
on). The scenario then drives the app's own close guards: a tab whose shell runs `sleep 30` opens
the running-process dialog and cancel keeps it; an editor buffer edited through the real CodeMirror
path opens the unsaved-changes dialog, cancel keeps it dirty, and Save & Close reads the persisted
text back from disk before the tab disappears. A third Space with a dirty buffer and a running
process is asked about and canceled first (Space, tabs and dirty text still there), then saved and
deleted; the report records that the project directory and its `spaces-keep.txt` still exist under
`spaceDeletion`. The runner exits 2 when any step failed. The scenario does not relaunch the app:
restart restoration (layout, cwd and file locations cold, no command replay) is verified at the
planning seam in `src/modules/spaces/lib/restore.test.ts`, and — for quit — by the reload pass of
`--scenario quit` (below).

**Quit** (`--scenario quit`, ticket #18): the real application quits. Two Spaces hold a dirty
buffer (edited through CodeMirror) and a busy terminal — one job honours `SIGTERM`, one runs
`sh -c 'trap "" TERM; exec sleep 300'`. Asking to quit opens the survey, which must name both
Spaces, both buffers and both processes and must state that detached services keep running. A
second close request while the dialog is open is asserted **not** to quit. Cancel keeps the window
and both processes. Save All & Quit writes both buffers (read back from disk) and asks again with
only the processes left. Confirming runs the bounded recovery flush, then the native graceful pass:
the cooperating job is gone, the survivor's terminal still runs, and the survivor prompt has
appeared. Cancelling there keeps the window open; a second round forces only after that prompt.
Before the window would close the scenario appends one line to a replay-marker file and reloads the
page (the boot path reaps every PTY, exactly as a relaunch would); the second pass asserts the
Spaces and editor tabs came back, the marker still has one line — no command was replayed — and a
quiet restored application closes without a question. The runner exits 2 when any step failed.
A full process relaunch needs two profiles; the reload exercises the same restore path, and the
difference is stated rather than papered over.

**The preview** (`previewScenario`): a preview tab opens through the app's own planner
(`openPreviewTab`) at `/preview-fixture?redirect=1`, which the orchestrator serves. The fixture page
posts a 200 ms beat and a `pagehide` notice to the app page, so a teardown is observed as the
frame's document really stopping rather than as an attribute change:

- the server redirects the frame once; the frame follows it and the application's own document is
  unchanged;
- the frame is a separate untrusted document — `__TAURI__`/`__TAURI_INTERNALS__` are absent while
  the app page has IPC, top-level navigation is refused, and a requested popup is refused (the app
  installs no new-window handler);
- switching to another tab, and switching to another Space, unloads the frame in the same turn (no
  further beats) and returning re-mounts a fresh document that says why it reloaded and that
  transient page state was lost (`[data-preview-reloaded]`). The Space cycle is repeated without
  creating a tab, because creating one activates it and the cause is then legitimately the tab:
  the plain switch asserts the notice names the Space, and that the intermediate render while the
  app restores the Space's active tab does not rewrite the recorded cause;
- the fixture server answers a ping after the tab teardown and after the tab closes, so frame
  teardown never owns the dev server process;
- `preview-blur` opens a separate application window (zenity/yad) so the app loses focus while its
  window stays visible: the frame and its instance must survive, or the step is recorded as
  skipped when no window could take focus;
- `hide` unmaps the window: the frame unloads while `document.visibilityState` is not `visible`,
  and showing the window reloads it; `minimize` records whatever signal this desktop reports and
  asserts the frame unloaded only when that signal says hidden. A compositor that never reports
  iconification is recorded as `SKIP minimize`, not as a pass: the unmapped-window step above is
  the exercised hidden case (WebKitGTK exposes no occlusion state either);
- closing the tab releases the frame and the fixture server still answers.

The step list and the observed signals (`blurExercised`, minimize `visibility`, `reportedHidden`)
ride the final `done` sync as `preview` next to `workflow`; the fixture server's counters
(`fixtureLoads`, `redirectHits`, `pings`) are recorded as `previewServer`.

**PDF documents** (`pdfDocuments` in `src/bench/driver.ts`, issues #30 and #31). The preview
scenario opens six generated documents through the app's file planner.

Issue #30 recorded the iframe path: the app's delivery gate, the bytes the asset server served
(natively, through `fs::bench_probe`/`bench_asset_log`), the cross-origin frame the app could not
read, and the lifecycle. That path is gone.

Since issue #31 the reader is the app's own DOM, so the same scenario asserts, from the reader's
own `data-pdf-*` attributes and text layer:

- page count and page number, and navigation through the toolbar and the reader's key handling;
- zoom with a real re-render: the canvas's backing-store size, its inked pixels read through
  `getImageData`, and the bounded raster cache's byte counts;
- the 32 MiB per-page ceiling: a 400 % A4 page renders 32,090,304 B, 800 % refuses naming the
  ceiling and “409 %”, and taking the offered zoom really paints within the ceiling; a 72-inch page
  refuses 100 % and offers 64 %;
- search (match count, page navigation, highlighted span) and selectable text through a DOM
  `Selection`;
- the whole-file gate (12 MiB document: explicit choice with zero bytes read, then one `200` with
  `override=1`), the corrupt-document state, and the misnamed `.pdf` opening as text;
- hidden-tab unloading over three cycles, tab-close grant release, and no reader element left
  behind.

What it still cannot do: inject native input or take a screenshot (ticket #32), so a physical key
press, a real drag and the clipboard round-trip, the visual crispness of a re-render, a network
capture, a password/unsupported-feature fixture and the 4-viewer admission refusal stay named
manual checks in `docs/architecture/pdf-reader.md`.

A display render is scheduled on animation frames, which WebKit suspends for an occluded window —
even while the page reports itself visible on this host. The reader retries a render that makes no
progress for four seconds with print-intent scheduling and reports
`data-pdf-render-fallback="print"`; the driver records which path painted each canvas instead of
assuming.

Fixtures are written and re-verified by `scripts/app-lab/pdf_fixtures.py` (poppler as the
independent check) into the run's workspace, never the repository, and the manifest travels in the
report with its verification. `--pdf-hold-ms N` keeps `text.pdf` on screen for `N` milliseconds
after its sample so the remaining manual checks can be run against the real window.

**The images** (`imagesScenario`): committed containers from
`src-tauri/tests/fixtures/images/` are copied into the run's workspace and opened through the
app's own file-tab planner. The driver asserts the rendered element's
`naturalWidth`/`naturalHeight` for every format claimed as supported (it does not infer support
from the extension), the oversized refusal before an element exists (a valid 5000×5000 IHDR with
no pixel data), the corrupt notice, the hidden tab dropping the raster and releasing its
decoded-viewer slot, and three open/close cycles leaving zero decoded viewers and zero tab-owned
grant scopes. An explicitly opened SVG is asserted to stay an editable text tab. The result
(`images.pass`, `steps`, `formats`) rides the same final `done` sync; the runner exits 2 when a
step fails.

**The media** (`mediaScenario`): committed containers from
`src-tauri/tests/fixtures/media/` (plus a generated ~3.5 MiB WAV) are copied into the run's
workspace and opened through the app's own file-tab planner. Support is recorded from the
element's own `loadedmetadata`/`error` events — the extension only routes the file, and the native
`fs_media_probe` reports the real container first. `canPlayType` is recorded beside each outcome as
the hint it is. Because WebKitGTK cannot load media from the custom `asset:` scheme
(`MEDIA_ERR_SRC_NOT_SUPPORTED`; WebKit bug 146351), the element is served from the same tab-owned
grant over the bounded loopback endpoint, and the driver fetches a byte range through that endpoint
to prove the range path. The driver asserts:

- every measured container loads and reports its real container (`mp4`, `m4a`, `mov`, `webm`,
  `ogg`, `wav`, `mp3`, `flac`, `aac` on this host);
- a valid MP4 whose sample entry names `zzzz` reaches an honest codec error (not a blank player),
  and Matroska is refused as unmeasured; a corrupt EBML header and WebM bytes named `.mp4` are
  refused before an element mounts;
- the native delivery log shows every response inside its bound — a range response at most one
  1 MiB chunk, a whole response at most the 10 MiB read ceiling — and seeking past the first
  chunk issues a new mid-file range;
- playback (muted; WebKitGTK has no input injection) pauses when the tab is hidden, releases the
  playback slot, and does not resume when the tab returns;
- closing while playing, and closing during an interrupted load, leave no element, playback
  session or tab-owned grant scope; reopening after the interrupt works.

The result (`media.pass`, `steps`, `formats`, `manual`) rides the same final `done` sync; the
runner exits 2 when a step fails. If this build requires a trusted gesture for playback, that
step is reported under `media.manual` as a named manual check instead of a pass.

**Focus is advisory on Linux.** Wayland lets the compositor decide focus (`set_focus` is a hint)
and WebKitGTK exposes no occlusion state, so `qualify()` does not fail the workflow or preview
scenario on focus: `native.appActive`/`key` are recorded per phase and summarised as a
`qualification.advisories` entry. The snapshot's process ids come from a `/proc` scan of the app's descendants
(`bench.rs`, Linux `platform` module), not from WebKit private API.

**Whole-application measurement (ticket 02).** The Linux runner samples the app from `/proc`, not
from the app: every phase event takes one `smaps_rollup` read per process in the host's descendant
tree (`Pss` as the total, `Rss` kept only to show the shared-page overcount, plus
`Private`/`Shared`/`Swap`, threads and descriptor counts), and a 1 Hz counter timeline runs for the
whole launch. Processes are attributed by role — `host`, `web_content`, `web_content_prewarmed`,
`gpu`, `networking`, `sandbox` (WebKitGTK's bwrap wrapper) — and everything else under the host
(`bash`, `node` agents, the streaming fixture) is `workload`: reported separately and never added to
the app's own figure. The in-app side of the same capability is `bench_window {cmd:"memory"}`
(`bench.rs`): roles from the `/proc` scan plus the same `smaps_rollup` figures, and the snapshot
carries the host's wall-clock process start (`startedUnixMs`) and the role table.

```sh
# representative workload: 2 Spaces, 4 panes, 2 busy agents, text files, active preview
python3 scripts/app-lab/run.py --scenario resource --reuse-build \
    --source <tree> --target-dir /home/loba/.../target --output /home/loba/.../run-resource
# stress workload: 4 agents, 4 streaming panes, 4 MiB close-cycle file
python3 scripts/app-lab/run.py --scenario stress --reuse-build ...
# cold + warm startup (fresh profile, then relaunches against it)
python3 scripts/app-lab/run.py --scenario startup --startup-repeats 3 --reuse-build ...
# compare a stored baseline with a candidate: one line per metric
python3 scripts/app-lab/run.py --compare baseline.json --candidate candidate.json --compare-format table
```

`--compare-format tsv` prints `metric<TAB>baseline<TAB>candidate<TAB>delta<TAB>percent` (one line
per metric), `json` the same medians machine-readable, `table` the aligned table. `run.py
--list-metrics` lists the metric families. `--compare` also works at the end of a run, and
`--recompute` re-derives metrics and summary from a stored report. Reports carry `startup`
(cold/warm: exec→navigation, navigation→boot, exec→boot, first paint), per-phase `memory` blocks,
`series` (the timeline), `package` (bench binary, frontend dist, and what packaging would add),
`linux.workloadFiles`, `limitations` and the host stack; fixture files themselves are regenerated by
`prepare_fixtures()` and never committed.

**Still not available on Linux:** native key/IME input, stepped/live resize, synthetic divider
drags, the composited layer tree, forced GC and soak scenarios — WebKitGTK exposes no occlusion
signal, no layer-tree mirror and no native input hook, so those scenarios refuse to run rather than
report a vacuous pass. Per-process GPU/VRAM is
not attributable from `/proc`, WebKit malloc zones cannot be split out, and PDF/codec rendering is
not claimed (see each report's `limitations`). `resize`, `split-drag`, `occlusion`, `input`, `tabs`,
`idle`, `agents-steady` and `fs-churn` refuse to run on Linux rather than pretend to measure.

The `preview` scenario is the only Linux user of `hide`/`show`: it switches tabs/Spaces and minimizes the window to prove frame teardown, and restores it to prove the reload disclosure.

**Environment knobs:** `--window WxH` (logical size, default 1280x820), `--local-storage
KEY=VALUE` (the updater throttle is preseeded automatically so no dialog covers the window),
`--toggle NAME=VALUE`, `--identifier` (reproduction), `--reuse-build`, `--app <binary>`, and
`WEBKIT_DISABLE_DMABUF_RENDERER=1` for a broken GL path (pass it through the environment; the
pty-smoke runner has `--disable-dmabuf` for the same workaround).

Keep the machine awake and unlocked and do not touch the keyboard: the benchmark window must
stay visible, key and active. The orchestrator holds a display-sleep assertion
(`caffeinate -d -i -u`), refuses to start while another benchmark window (renderer lab, a second
app lab) is running or the session is locked, asks the page to bring the window back and report
a phase again when focus was taken (`qualification.retried`), and marks anything that still is
not a valid sample (`qualification.failures`). Building is fine alongside a run; CPU numbers are
not.

## Scenarios

| `--scenario` | What it does |
| --- | --- |
| `tabs` | shell tab plus agent tab (`--variant`: `sa` default, `saps` = shell, agent, split agent pair, shell, or any string of `s` shell, `b` block-mode shell, `a` agent, `p` split pair); switches `--cycles` (40) times with `--dwell-ms` (3000) dwell; baseline, one sample per switch, +10/+30 s idle |
| `resize` | one agent tab; 3 cycles of 120 live-resize steps (shrink then grow) through the web view's `viewWillStartLiveResize` / `viewDidEndLiveResize` |
| `occlusion` | window ordered out and back 20 times (3 s hidden, 2 s visible) |
| `agents-steady` | 1 visible plus 6 hidden agent tabs for 60 s |
| `idle` | one idle shell for 30 s |
| `input` | real key events and input-method calls into a raw-mode PTY reader; pass/fail lines in `page.log` (no measurements) |
| `workflow` (Linux) | acceptance workflow: shell spawn, exact echo, new tab, split, switch back, open a file and assert its rendered text; now sampled like the measured scenarios |
| `images` (Linux) | image seam: representative committed containers decode in the real WebKitGTK, oversized/corrupt are refused, hidden tabs release, close cycles leave no decoded viewers or grants |
| `media` (Linux) | media seam: real container/codec outcomes from the element, ranged delivery and seeking, hidden pause without auto-resume, unsupported/corrupt/mismatch/interrupted inputs, close releases elements, playback slots and grants |
| `spaces` (Linux) | Space lifecycle: one checkout shared by two Spaces and its rendered indication, a switch that keeps hidden terminal output flowing while presentation stops, the running-process and unsaved-buffer close guards, and Space deletion that resolves dirty buffers/processes, leaves the project directory intact, and cancel leaving everything as it was |
| `resource` (Linux) | idle terminal for `--idle-seconds` (5), then 2 Spaces, 4 terminal panes, `--agents` (2) busy synthetic agents, several text files, one active local preview; `--streams` (2) streaming panes for `--stream-seconds`, `--close-cycles` editor open/close cycles, `--cycles` hide/show cycles, then +10/+30 s settle |
| `stress` (Linux) | the same shape with 4 agents, 4 streaming panes and the 4 MiB close-cycle file; a separate, clearly described workload |
| `startup` (Linux) | boot only; `--startup-repeats` (3) launches — the first cold (fresh profile), the rest warm (same profile) |

Options that matter: `--window WxH` (default 1280x820 points), `--cwd-shell` / `--cwd-agent`
(different directories make the explorer and git panel follow the switch), `--vibrancy on|off`,
`--sampling light` (cheap counters only between full samples, see below), `--gc [private|alloc]`
(request a full garbage collection after the tail and sample again), `--instrument` (WebGPU, DOM
and IPC call counters with created/finalized wrapper counts), `--no-switch --hold-tab N`
(controls), `--toggle NAME=VALUE` (experiment toggles, below), `--iosurfaces` (every IOSurface
region from `vmmap -v`), `--valve EVERY_S:CHUNKS:MB` (allocation-pressure GC probe), `--probe`
(idle: remove one suspected wakeup source, e.g. `blur`), `--local-storage KEY=VALUE`.

### Experiment toggles

`--toggle NAME=VALUE` sets `localStorage["terax:bench:NAME"]` before the app starts; product code
may read it through `benchFlag` / `benchFlagOn` (`src/bench/flags.ts`, a constant `null` when
`__TERAX_BENCH__` is false). The hooks used for the tab-switch investigation touch files that
change often (`WebGpuTerminalSurface.ts`, `CanvasBackingStore.ts`, `useGhosttyTerminalSession.ts`,
`TerminalStack.tsx`), so they are kept as a patch against `ee836e1`:

```sh
scripts/app-lab/export-tree.sh /tmp/app-lab-exp HEAD
(cd /tmp/app-lab-exp && patch -p1 < scripts/app-lab/experiments/tab-switch-toggles.patch)
python3 scripts/app-lab/run.py --scenario tabs --variant saps --source /tmp/app-lab-exp \
    --target-dir /tmp/app-lab-target-exp --toggle fixed-backing=2560x1700
```

Toggles: `keep-attached` (surface stays in its pane when hidden), `keep-canvas` / `keep-gpu`
(do not release the canvas / buffers, atlas and canvas on hide), `keep-model` (skip
`releasePresentationResources`), `tab-display-none`, `fixed-backing=WxH` (every canvas gets one
backing size, so none is ever resized).

## Isolation

The lab runs under a disposable identifier inside the fork identifier namespace
(`<fork identifier>.app-lab-*`, derived from `src/modules/identity/namespace.json`), launched with
its own `HOME` (so the control-server descriptor, shell-integration files and history never touch
the real user's) and `TERAX_BENCH_ISOLATED=1`. The preflight (`scripts/linux_profile.py`) and the
bench binary refuse the product identifier, upstream Terax's `app.crynta.terax.*` and anything
outside the fork namespace, or a launch without that variable (`modules/bench.rs::guard`, unit
tested), and the profile directories for the lab identifier are removed before and after every run.
The user's running app is never touched. The shells are real login shells with an empty `HOME`; the agent is
`scripts/app-lab/agent-sim.mjs`, an Ink-like program (12-line region erased and rewritten every 80
ms, a spinner, 40 characters of token text every 50 ms, completed lines flushed into scrollback, a
bordered tool block every 7 s, 300 lines of history).

## What is measured

The scenario driver (`src/bench`, mounted by `App.tsx` only when `__TERAX_BENCH__`) uses the app's
own tab actions (`setActiveId`, `newTab`, `newAgentGroupTab`, `splitActivePane`) and
`whenSessionReady` / `writeToSession`. Each phase posts an event to the orchestrator's local HTTP
server (the `scripts/pty-smoke` pattern); the page waits until the orchestrator has sampled.

- Exact processes: host, WebContent, GPU and Networking pids come from the web view itself
  (`_webProcessIdentifier` and friends, `bench_window snapshot`), so attribution is exact even
  with other WebKit apps running. Children of the host (shells, node) are accounted as `PTY-procs`.
- `footprint -j` with categories per process, kept compact: `WebKit malloc`, `IOSurface` (own,
  shared groups, `reclaimable`), owned unmapped graphics, `JS VM Gigacage`, and the rest. `vmmap`
  summary for WebContent and GPU, rusage V6 CPU, energy, wakeups, instructions and cycles per
  process (the lab's `procstats`), a 0.25 to 1 s timeline of the same counters, WindowServer CPU.
- In-app diagnostics per phase: WASM linear memory per instance, canvas pool counters, surface
  backing-store resizes, GPU buffer sizes, presentation state, DOM size. The JS heap cannot be read
  (`performance.memory` does not exist in WebKit).
- Native window control (`bench_window`): stepped live resize, order out/front, miniaturize,
  native sleep, activation, and `_garbageCollectJavaScriptObjectsForTesting` for `--gc`.

Full sampling (`footprint` + `vmmap`) suspends the target for about a second per sample; the
`light` mode keeps only the cheap timeline between full samples every `--full-every` cycles, which
showed the same growth as full sampling.

## Findings that shaped the current design

- Tab switches between differently sized panes resized a presented WebGPU canvas; WebKit keeps
  every retired swapchain until JavaScriptCore collects its wrappers (minutes). Fixed by the window
  canvas (one canvas per terminal area, only viewports change): 726 -> 218 MiB over 40 switches.
- Per-frame WebGPU wrappers pin ~13 KiB of native memory JavaScriptCore does not count (~20 MiB/min
  for a streaming agent). Fixed by `gpu/GcPressure.ts`.
- A focused textarea with a collapsed selection keeps WebKit's display link running (idle 3.1 % CPU,
  254 wakeups/s). Fixed by the input proxy's selected placeholder (0.24 %, ~11/s).
- During a live window resize WebKit allocates a viewport-sized page tile per step (an empty page
  peaks at ~420 MiB). Mitigated on macOS by pinning the document to a 512 px multiple while a drag
  runs (`modules/theme/livePageResize.ts`); at rest the shell composites only the page tile, the
  terminal textarea and the canvas.
- Resizing the model and PTY during a drag made shells and Ink agents redraw per step, duplicating
  prompts and agent regions. Fixed by one synchronized resize at gesture end (see
  `terminal-renderer-v2.md`, Resizing).

Judge memory by the timeline floor and the value after `--gc`: dead native objects are released
when garbage collection runs, so single samples vary between runs.

## Limits

macOS for the measured scenarios: one display (2048x1152 points at 100 Hz here), fresh profile
with default preferences (vibrancy off), no AI panel traffic, a synthetic agent instead of Codex.
Footprint figures vary between runs because garbage collection timing decides when dead native
objects are released; compare medians of repeats and prefer the timeline floor and the after-GC
value. Linux has the `workflow`, `preview`, `images` and `media` acceptance scenarios plus the measured `resource`, `stress` and `startup` scenarios (WebKitGTK, Wayland): memory is Pss from `/proc`, workload processes are separate, and every report states its own `limitations` rather than claiming what was not sampled. The preview scenario also records what the platform cannot report: WebKitGTK has no occlusion state, so a preview covered by another window keeps running, and a minimize the compositor never reports is recorded as skipped rather than as a pass. The media scenario records the decoder outcomes the webview reports; playback can only be started programmatically (muted) because WebKitGTK has no trusted input injection, and that limitation is named when it applies.

# Terminal checks: what runs on Linux, what does not, and how a Ghostty update is accepted

The Linux build keeps the adapted Ghostty WASM bridge as its terminal core
(`packages/ghostty-core/adapted`, pinned source revision recorded in
`adapted/UPSTREAM.md`). The separate official-ABI tree stays an evaluation: it is not the
runtime and this document does not test it as one.

This file is the inventory. Every row names the behaviour the check proves, the command that runs
it, and where it runs. A check that cannot run on Linux yet says which mechanism is missing
instead of disappearing. Ticket #34 narrowed the *platforms* (Linux x86-64 only) and removed the
Windows/macOS terminal jobs in favour of the Linux job below; `scripts/tests/test_ci_workflows.py`
fails if any command in this inventory stops running in ordinary CI.

## Inventory

| Check | Behaviour asserted | Linux command | Runs in |
| --- | --- | --- | --- |
| Adapted core (models, input, blocks, transport) | terminal model and protocol behaviour: writes, modes, queries, key encoding, blocks, PTY transport, renderer lifecycle | `pnpm exec vitest run src/modules/terminal` | `frontend`, `terminal-linux` |
| PTY exactness and backpressure | byte-exact wire frames, credit accounting, forged/duplicate acknowledgements grant nothing, a stalled frontend ends with the drain deadline, credit-blocked PTYs nudge once per state | `cargo test --manifest-path src-tauri/Cargo.toml --lib modules::pty` | `rust` |
| Shell integration: bash | prompt marks (133 A/B/C/D), `7;file://` cwd report, `ble.sh` entry forks nothing, frameworks that rebuild `PS1` display correctly | `bash src-tauri/src/modules/pty/scripts/bashrc.test.bash` | `rust` (green on Ubuntu; fails on a Fedora host, see below) |
| Shell integration: zsh | marks through `zshrc`/`zshenv`/`zprofile`/`zlogin`, 200 KB command lines stay cheap, `exec zsh` restarts the sequence | `python3 src-tauri/src/modules/pty/scripts/zshrc.test.py` | `rust` |
| Shell integration: fish | prompt rewrapping preserves a Conda prompt and replacement functions, marks present exactly once | `fish --no-config src-tauri/src/modules/pty/scripts/init.test.fish` | `rust` |
| Search and selection | find next/previous over the model, tracked selections that survive streaming and reflow, rectangular selection, clamped pruning | `pnpm exec vitest run src/modules/terminal/ghostty/search src/modules/terminal/backend` | `frontend`, `terminal-linux` |
| Renderer fallback | WebGPU device loss/recovery and quarantine of a replacement, the surface's own background until the WebGL fallback takes over, WebGL presentation of cached frames, session renderer loading | `pnpm exec vitest run src/modules/terminal/ghostty/gpu src/modules/terminal/ghostty/webgl` | `frontend`, `terminal-linux` |
| Clipboard and paste | OSC 52 and clipboard writes (latest-wins), bracketed paste, paste-key routing, no double paste | `pnpm exec vitest run src/modules/terminal/lib/terminalClipboard.test.ts src/modules/terminal/lib/terminalPaste.test.ts src/modules/terminal/ghostty/input` | `frontend`, `terminal-linux` |
| IME / text input traces | the documented DOM sequences of each platform's text stack — `keydown`, `beforeinput`, `compositionstart/update/end` — deliver each character exactly once, in order | `pnpm exec vitest run src/modules/terminal/ghostty/input/textInputTraces.test.ts src/modules/terminal/ghostty/input/keyEncoding.conformance.test.ts` | `frontend`, `terminal-linux` |
| Compositor parity / scaling | composited pixels equal the renderer texture at DPR 1, 1.25, 1.5 and 2, at an integer and a fractional CSS origin; the native device-pixel box equals the backing | `TERAX_VISUAL_SOFTWARE=1 pnpm test:terminal-scaling` | `terminal-linux` (WebGL, the fallback WebKitGTK uses) |
| Sustained-output soak | five models stream 64 epochs of adversarial fixtures, reflow and presentation recycling; no plateau growth; both artifacts and both render formats; stack canary stays under half the shadow stack | `TERAX_SOAK_REPORT=<file> pnpm soak:ghostty` | `terminal-linux` |
| Adapted-core benchmark | write/update/synchronize cost of both artifacts and both render formats; the comparison source for a Ghostty update | `pnpm bench:ghostty` | `terminal-linux` (artifacts uploaded) |
| Ghostty revision update | revision provenance, artifact identity, a byte-identical rebuild, compatibility, soak and resource comparison against recorded evidence | `pnpm ghostty:update --plan`, then `pnpm ghostty:update` | local / release procedure |
| Ghostty revision monitor | the recorded revision and shipped artifacts still agree, and how far the pin is behind `ghostty-org/ghostty` main (no rebuild, no Zig required) | `pnpm ghostty:monitor` | local / monthly upstream review (`docs/architecture/dependency-updates.md`) |
| Real-app sustained output | the real Linux application with four terminal panes, two Spaces and sustained streaming, sampled from `/proc` | `python3 scripts/app-lab/run.py --scenario resource --profile release` | manual, `linux-app-smoke.yml` (workflow scenario only) |

## Evidence recorded 2026-11-12 (Linux, this checkout)

| Check | Result |
| --- | --- |
| `pnpm exec vitest run src/modules/terminal` | 124 files, 3034 passed, 34 skipped |
| `cargo test --lib modules::pty` | 242 passed, 0 failed, 1 ignored |
| zsh shell integration | exit 0 |
| fish shell integration | exit 0 |
| bash shell integration | **4 failures on this Fedora host** — see "Bash integration is not host-hermetic" below; green on the Ubuntu CI runner |
| `pnpm soak:ghostty` | both artifacts, structure-of-arrays format: plateau growth 0 bytes, final linear memory 78,708,736 bytes, peak stack 35,200 and 35,184 bytes of the 96 KiB shadow stack (35.8%) |
| `pnpm test:terminal-scaling` (WebGL) | DPR 1: 570,000 px, 1.25: 891,000 px, 1.5: 1,282,500 px, 2: 2,280,000 px; 0 differing pixels at both origins, max channel delta 0 |
| `pnpm bench:ghostty` | 20 tasks across both artifacts |
| `pnpm ghostty:update --check` | identity and artifacts pass against the recorded provenance |

The soak measurement is committed as `docs/architecture/terminal-linux-soak-2026-11-12.json`; it
is the baseline `pnpm ghostty:update` compares a new revision against, so the gate works without
anyone remembering a flag.

### Bash integration is not host-hermetic (recorded 2026-11-12, Fedora 44 KDE)

`bashrc.bash` emulates login-shell init, so it sources `/etc/profile` and `/etc/bashrc`. On this
host `/etc/profile.d/80-systemd-osc-context.sh` appends `__systemd_osc_context_precmdline` to
`PROMPT_COMMAND`, and four assertions in `bashrc.test.bash` compare the whole chain:

- `scalar PROMPT_COMMAND is kept after the hook`
- `the prompt end is the last PROMPT_COMMAND entry`
- `an array PROMPT_COMMAND gets the hooks as elements`
- `the ble.sh entry puts the prompt end back last`

The check is identical at the pre-ticket commit `a657b3c`, so this ticket did not introduce it, and
it passes on the `rust` job's `ubuntu-22.04` runner, whose `/etc/profile` installs no such hook.
It is recorded rather than silenced: the primary validation target is Fedora 44 on Wayland, so the
bash chain has to be correct with a system hook appended, and today that is unproven. Reproduce
with `bash src-tauri/src/modules/pty/scripts/bashrc.test.bash`; the zsh and fish equivalents pass
here.

## Checks that are still not Linux, and why

| Check | Where it runs | Missing mechanism on Linux |
| --- | --- | --- |
| WebGPU compositor parity | nowhere: the macOS job that ran it was removed with the platform narrowing (ticket #34) | On Linux Chromium the software WebGPU device is destroyed while the surface initializes (`A valid external Instance reference no longer exists`) and the runtime's recovery cannot re-acquire an adapter, so the harness has no surface to read back. `terminal-linux` compares the WebGL fallback — the renderer WebKitGTK actually uses — and records the gap sentence in `scaling.json`. WebGPU compositing in the real WebKitGTK app is therefore unverified here, not silently covered. |
| Native input, IME and clipboard in the real app (`--scenario input`) | macOS app-lab | WebKitGTK has no native input hook in the harness: there is no way to inject a key event or an input-method composition into the real webview and observe the PTY reader. DOM-level sequences are covered by `textInputTraces.test.ts`; the real-app path is unverified on Linux. |
| Layer tree, forced GC, native resize and divider drags | macOS app-lab | No WebKitGTK layer-tree mirror, no testing SPI for a full collection, and no stepped/live resize driver. Scaling is covered synthetically by the pixel gate; window resize cost on Linux is unmeasured. |
| Occlusion and energy | macOS app-lab | WebKitGTK reports no occlusion signal; energy is not measurable without the platform's power APIs. |

These are recorded as gaps, not as passing checks. When one of them gains a Linux mechanism, it
moves into the inventory above and the gap row is deleted in the same change.

## The real Linux application

`scripts/app-lab/run.py` on Linux implements `workflow`, `preview`, `resource`, `stress` and
`startup`. `resource` and `stress` are the sustained-output path in the real app: four terminal
panes streaming at 400 lines/s, hidden/show cycles and editor open/close, sampled from `/proc`.
They are not in `ci.yml` because they need a display and a bench build; `linux-app-smoke.yml`
runs `workflow` nightly. Recorded reports live outside the repository at
`/home/loba/Documents/projects/personal/terax-baseline/evidence/2026-11-12/` and are compared with
`python3 scripts/app-lab/run.py --compare <baseline>.json --candidate <candidate>.json
--compare-format json`.

## Ghostty revision update procedure

An update moves the pin; it does not move the expectations. `scripts/ghostty-update/run.py` is the
executable form of this checklist, and `pnpm ghostty:update --plan` prints it.

```sh
pnpm ghostty:update --plan                       # what the procedure will do, and what it needs
pnpm ghostty:update --check                      # provenance and artifact identity only
pnpm ghostty:update --revision <40-hex> --rebuild --with-resource \
    --baseline /path/to/recorded/evidence --output /path/to/reports
```

1. **Identity.** The Ghostty commit in `adapted/UPSTREAM.md`, the archive URL in
   `adapted/wasm/build.zig.zon` and `--revision` must name the same commit, and the Zig version
   recorded in the document must be the `minimum_zig_version` the build requires. A tree whose
   provenance disagrees with the code that builds it is refused before anything runs.
2. **Artifacts.** Both `.wasm` files must match the size and SHA-256 recorded in `UPSTREAM.md`.
   A rebuilt artifact is not accepted until the artifact and its record are updated together.
3. **Rebuild.** With `--rebuild` and `zig` on `PATH`, both variants are rebuilt from the pinned
   source and must come out byte-identical to the shipped files. Without a rebuild the gate is
   **unverified**, never "passed".
4. **Compatibility.** `pnpm exec vitest run src/modules/terminal` — the adapted bridge still
   speaks the protocol the application depends on.
5. **Soak.** `pnpm soak:ghostty` with `TERAX_SOAK_REPORT`, checked against the absolute bounds in
   `scripts/ghostty-soak.ts` (no plateau growth, stack under half the shadow stack) and against
   the recorded soak baseline (`--soak-baseline`, defaulting to
   `docs/architecture/terminal-linux-soak-2026-11-12.json`): linear memory may not grow more than
   5% per artifact and render format, and an artifact the baseline measured may not go missing.
6. **Bench.** `vitest bench --outputJson` against a recorded benchmark output
   (`--bench-baseline`); no task may be more than 1.25x slower, and no task the baseline covered
   may disappear.
7. **Resource.** `scripts/app-lab/run.py --scenario resource --profile release --compare
   <baseline>/baseline-resource.json`, compared with the recorded baseline evidence
   (`key-metrics.json`) on `mem.baseline.app_pss_mib`, `mem.baseline.total_pss_mib`,
   `mem.idle.app_pss_mib`, `mem.booted.app_pss_mib`, `cycles.hidden_mean_mib`,
   `timeline.cpu_pct.app_total` and `delta.stream.total_pss_mib`. This needs a display and a bench
   build; without them the gate is unverified.

Each gate reports `pass`, `fail` or `unverified`, and the report is written to
`<output>/ghostty-update.json`. The procedure exits 0 only when every gate passed, or when a
specific unverified gate was accepted by name with `--accept-unverified NAME` — and that acceptance
is recorded in the report. A release gate that has not been run is never reported as satisfied.

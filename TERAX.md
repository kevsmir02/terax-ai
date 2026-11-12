# TERAX.md

Terax loads `TERAX.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md). This file is also the project's living architecture doc - read it before making changes.

## Project

**Terax**: open-source terminal workspace for external coding agents. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + libghostty-vt WASM client (WebGPU, Terax WebGL fallback). Built-in AI chat, providers and API-key management were removed; agents run in their own terminals.

- Bundle id: `dev.terax-workspace.fork` — provisional fork identity, not shippable
  (`src/modules/identity/namespace.json`; final branding is ticket #39/#40). Upstream Terax is
  `app.crynta.terax`; the two must coexist without sharing state — see
  `docs/architecture/namespace-isolation.md`.
- Package manager: **pnpm**
- Platforms: **Linux x86-64 only** for build and distribution (RPM/DEB, plus an authored Arch
  recipe). The Windows, macOS and WSL code paths upstream shares with Linux are retained in the
  source as inert seams so upstream imports keep compiling; they are not supported
  configurations, and their build/distribution workflows and platform bundle config were removed
  in ticket #34. See `docs/architecture/linux-packages.md`.
- Frontend checks: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (local fallback: `cargo test --locked`)

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, AI tool surface). The secret-path deny-list applies on both read and write and is never bypassed.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo nextest run --locked` (or `cargo test --locked`)

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or AI tool surface) needs a test that locks the invariant.

## Terminal migration status

libghostty-vt is the only terminal model. WebGPU is the default renderer and
Terax WebGL is the compatibility fallback. Each leaf owns one persistent model
in its own WebAssembly instance (the module is compiled once and shared), so
closing a leaf drops its linear memory and scrollback instead of leaving a
high-water mark; nothing may retain a view into a disposed model's memory.
Scrollback summed over all leaves is capped by a budget (192 MiB, scaled fairly
between leaves, never pruning history already held). Presentation resources are
shared, bounded, and released for hidden leaves.
All visible WebGPU panes of a window draw into one canvas that covers the
terminal area (`gpu/WebGpuWindowCanvas.ts`; the `[data-terminal-area]` layer of
`TerminalStack`, behind the tab layers). Each pane renders into its device-pixel
snapped rectangle (`gpu/PaneRects.ts`, measured on layout changes only) with
`setViewport` and `setScissorRect`, which keeps glyph overhang out of the
neighbour; the shader takes viewport size and origin from the uniform, so a
pane's pixels equal what a canvas of its own showed (verified byte for byte,
`scripts/terminal-visual/grid.html`). Canvas textures are not preserved between
frames, so a window frame clears the canvas and encodes every visible pane in one
pass (cell buffers stay resident on the GPU, no per-cell work). Per-pane dirty
tracking still decides whether a frame is needed: an unchanged window acquires
no texture (`windowFrameNeeded`). `SurfaceFramePacer` decides which panes prepare
in a frame; a pane whose rectangle moved always does. Pane DOM is transparent
once the canvas has shown the pane's first frame (until then it paints the theme
colour, so a tab switch never flashes the card behind); scrollbars, selection,
IME, block overlays and cursor styles stay per-pane DOM above the canvas.
A presented WebGPU canvas is never destroyed, unconfigured, shrunk or
dropped while the runtime lives: WebKit (macOS 26) keeps the swapchain of such a
canvas in the WebContent process for good (three buffers, about 30 MiB for a
2000x1300 canvas, whatever the teardown order and garbage collection), and keeps
every swapchain a resizing canvas retires until JavaScriptCore collects its
wrappers (minutes), so every teardown or resize leaks. A tab switch, a split or a
divider drag therefore only changes viewports: zero canvas allocations. The
canvas is reallocated only when the terminal area itself changes size, at most
twice per window drag (below). With no visible pane (an editor tab is active) or
an occluded window it is paused (hidden after a short delay when empty), never released. A replaced or
recovered GPU device reconfigures the same element, and a remounted area takes
over the old one's canvas. Only disposing the runtime tears it down. The WebGL
fallback stays per pane (its own canvas and opaque background inside the pane
root): a WebGPU failure in one pane falls that pane back, and a failure of the
shared runtime falls every pane back.
Every submitted window frame is mirrored to JavaScriptCore (`gpu/GcPressure.ts`):
the wrappers of a frame (texture, view, encoder, pass, command buffer) pin about
13 KiB of WebKit malloc that JavaScriptCore does not count, so without help it
collects them after minutes (20 MiB a minute for a streaming agent). Allocating and
dropping a 126 KiB `ArrayBuffer` per frame (ten times the native cost; measured:
unfinalized canvas textures after 120 s 2,626 without, 195 with it, no change in
instructions per second) makes young-generation collections run steadily. At most
4 MiB a second is mirrored, so display-rate frames allocate no more than a 25 fps agent.
Resizing applies one synchronized model + PTY resize per gesture. Every SIGWINCH
makes zsh/fish and Ink-based agents redraw, and redraws that do not line up with a
reflowed grid leave duplicates in scrollback, so during a resize gesture (native
macOS live resize via `NSWindowWillStart/DidEndLiveResize`, forwarded as
`liveResize` in `terax:window-presentation`; a pane divider drag via
`terminalResizeInteraction`; elsewhere a burst of size changes less than 150 ms
apart, `lib/terminalResizeGesture.ts`) neither the model nor the PTY changes. The
pane follows the pointer at display rate (`SurfaceFramePacer` gesture mode) and
draws its existing grid: shifted up (`shift_y`) so the cursor row stays visible
when the pane is shorter, clipped on the right or padded with the background
otherwise. At release `TerminalResizeSync` resizes the model and tells the PTY in
one call, model first. Ghostty clears the prompt on that resize and relies on the
shell's redraw, so the pane holds its previous frame until the redraw ends or
70 ms pass (`core/ResizePromptHold.ts`; only at an OSC 133 prompt, never in the
alternate screen). Resizes outside a gesture (sidebar, font, ratio, first fit,
showing a hidden pane) apply at once. During a gesture the window canvas's backing
store is grow-only: it keeps its allocation while the area shrinks and, when the
area outgrows it, allocates once to the largest size it can reach
(`gpu/GestureBacking.ts`: the area plus the screen room left when the window
itself is dragged, else the window; capped by the device limit), then compacts at
release, so a drag costs at most one growth and one compaction. The WebGL
fallback defers the same way per pane (top-anchored).

The WebGPU path (renderer v2, `docs/architecture/terminal-renderer-v2.md`) runs
no per-cell JavaScript. Ghostty encodes 16-byte cell records natively and
reports only rows whose bytes changed. The surface uploads those ranges straight
from WASM memory (`consumeGpuFrame`) into a storage buffer, and nothing may call
the model between that frame and the upload because the view is borrowed. It
never touches the structure-of-arrays APIs, which would flip the model's format;
only the WebGL fallback uses them. A background pass derives each cell from its
pixel (background, search, selection, cursor, decorations) and an instanced
glyph pass draws integer-pixel quads with unfiltered `textureLoad`. Selection and
cursor are uniforms and the search highlight is a mask buffer that exists only
while something is highlighted, so none of them rewrites cell records.
Geometry is pixel exact. Fonts are measured at size times ratio and cells are
whole device pixels (`TerminalFontMetrics.deviceCell*`). `cellWidth` and
`cellHeight` are the CSS size, device divided by ratio, and are what fit,
hit-testing, selection, links and block overlays use. A pane's rectangle in the
window canvas holds at least cols by rows device cells (slack is background, the
scissor clips the rest) and the canvas origin is translated onto the device
pixel grid when the observer, ratio or window size changes. A ratio change
re-measures the font and rebuilds atlas and buffers.
Each terminal maps Ghostty glyph ids to a glyph atlas shared per font and ratio.
The atlas grows (coverage 1024 to 2048 to 4096, colour 512 to 2048) before it
flushes into a new epoch; after a flush each surface rescans its visible cells and
re-rasterizes only what it shows. Rasterization is limited to about two
milliseconds per frame across surfaces, leftover glyphs draw on follow-up frames,
and a backlog from scrolled-away output keeps only visible glyphs queued.
Both renderers draw identical glyph pixels at every ratio (visual harness parity
at 1, 1.25, 1.5 and 2), so grayscale text gets no contrast curve unless
`localStorage["terax:terminal-text-contrast"]` is `on` or a strength; when set, both
renderers apply the same curve. Private-use glyphs follow a constraint per range
(`gpu/GlyphPlacement.ts`): version-control icons as designed, other icons as designed
but shrunk past their room or the cell height, Powerline separators and extras
stretched to fill their cells exactly. An icon or extra that may take two cells has two
forms and takes two only when the next cell is blank, it is not the last column and
the cell before is not a symbol (Ghostty's `constraintWidth`); otherwise it is held and
clipped to its own cell. WebGPU stores the forms as two consecutive atlas entries and
the glyph vertex shader picks one from the neighbouring cell records (glyph id 0 after
it, the symbol flag of the glyph before it), so no per-cell JavaScript runs; WebGL
decides per cell in the row rebuild. A solid block cursor
draws the glyph it covers in the theme's cursor accent (both cells of a wide
character), and the fit keeps a 14 px gutter free at the right of the grid.
Box drawing, block elements, braille, powerline separators and common legacy
computing shapes are drawn procedurally at exactly the cell size, not from the
font, with Ghostty's sprite geometry (`gpu/BuiltinGlyphs.ts`, pure, shared by
the WebGPU and WebGL atlases), so borders and bars join seamlessly at every size
and ratio. They ignore bold and italic and skip the text contrast curve.
Native cell, grapheme and hyperlink presentation buffers allocate on first use
and return to the WASM allocator when a pane is hidden. Hidden parsing does not
rebuild them. Window pauses (occlusion, sleep) retain them and the uploaded cell
data.
Unchanged frames do not acquire presentation textures or draw; cursor-only
updates upload only the uniform. WebGL background and decoration geometry uses
row range uploads while rectangle counts are stable; structural changes rebuild
the compact stream. Scrollbar synchronization never reads the DOM on presented
frames; moving the thumb under a bottom-pinned view costs at most ten position
writes and four ARIA updates a second. Blink timers stop in unfocused windows,
and native cursor hiding stops cursor timers. Selection is a uniform and needs no
row damage; streaming search invalidations coalesce instead of rebuilding per
output chunk.
WebGL surface and renderer code load only when selected, needed for fallback,
or explicitly requested by diagnostics. Delayed imports cannot install into a
closed, restarted, or replaced session.
xterm, its addons, CSS, snapshots, session pool, and dormant byte ring are removed.
Unsupported graphics produce a visible error with retry instead of changing models.

Command blocks use parser-time Ghostty tracked pins, including endpoint columns,
so command ranges survive reflow and exclude following prompts and commands.
The native marker ring is capped at 2,048 pins; JavaScript history is capped at
1,000 blocks and 512 KiB of estimated UTF-16 command/cwd text. Block implementation
and UI load only for block sessions, and hidden/occluded block presentation stops.
Block search yields after 128 rows or four milliseconds, retains at most 500
matches, and cancels obsolete queries. Block copy, search, sticky headers, navigation, rerun, shared shell input,
and selection all use the same persistent Ghostty model.
Block chrome commits with its matching renderer frame; it is recomputed only when
the viewport origin, scrollback, size, cell height, block mode or block set
(`GhosttyBlocks.revision`) changed, so frames that only repaint cells cost no
block work and no React commit. The per-frame path reads cached cell metrics, never
layout, and the shell/prompt input switch runs on block-mode changes, not per PTY
chunk. Command-editor focus does
not lower active-pane cadence. Divider padding is presentation-only and does not
change copied command boundaries. Scrollbars preserve native fractional positions
and ignore delayed programmatic scroll events. Hidden output does no surface DOM
or search-mask work until presentation resumes.

Terminal clipboard shortcuts use the native text clipboard plugin on all desktop
platforms. Context clicks expose the selected text through the input element to
restore the webview's native text menu; no persistent DOM scrollback is maintained.
On macOS the input `<textarea>` always holds one selected placeholder character
(`TerminalInputProxy`; elsewhere it stays empty, a selection could take X11 PRIMARY): a focused editable with a collapsed selection keeps
WebKit's caret animation (a display link at display rate) running at ~3 % CPU and
~250 wakeups/s while idle, a non-collapsed selection paints no caret (0.2 %, ~10/s).
It re-arms after input, key release and focus, never during IME composition, and
native Copy/Cut without terminal text must not copy the placeholder.
Unclaimed macOS Command shortcuts reach the native menu after explicit clipboard,
block-editor, and readline bindings, including when Kitty keyboard mode is active.
The block prompt retains an enabled terminal input proxy for native menus and
routes editing keys, composed text and paste back to its command editor.
Character drags retain a native selection pin from pointerdown, including before
the first pointermove. Unmoved clicks and lost captures discard provisional pins.
Clipboard shortcuts match the letter the layout types (the physical key only for layouts without Latin letters), AltGr is read from `getModifierState("AltGraph")`, and the macOS Option-as-Alt setting (`off`, `left`, `right`, `both`) tracks which Option key is held. Key encoding supplies the base character only where Kitty keyboard mode escape-codes
text (a held Ctrl, Alt or Super, or report-all-keys); Shift-only and plain text stay text, Ctrl+Shift+letter is the control byte outside the protocol, Windows/Linux Ctrl+Backspace is Ctrl+W outside it,
lock modifiers are reported only at the report-all-keys level, and key releases follow
the presses that were escape-coded. The wheel accumulates whole lines scaled by the
`terminalScrollSpeed` preference (history and cursor keys move a line at a time, a mouse
report stands for three lines, at most ten per event) and becomes cursor keys on the
alternate screen under DEC 1007; the input element is moved onto the cursor cell only for the length of an IME
composition (`ImeAnchor`).
Terminal text uses the configured font, an installed Nerd Font when detected,
or bundled JetBrains Mono. Per codepoint the chain is that font, JetBrains Mono, an
installed Symbols Nerd Font, then two bundled private-use-only faces: the BMP area
(365 kB, loaded with the first terminal before rasterization) and the Material
Design icons (349 kB, fetched when such a glyph is first drawn, blank until then;
its arrival rebuilds the atlases through `TerminalFontSpec.symbols`). Neither is in
the startup graph. Installed fonts are detected by canvas measurement, never
`document.fonts.check`. Native color emoji remain on the system fallback path. Rerun requires the complete command
submitted through Terax; truncated shell labels are never executed.
Primary-screen full erase, scrollback erase, and terminal reset invalidate block
pins at parse time and clear block chrome, selection, and search. Commands after
an erase in the same output chunk retain their new pins. Alternate-screen erases
preserve primary block history. Block scrollbar status dots are removed along
with their timers and history scans.

The shared command bar activates after shell integration confirms prompt input.
Bare shells keep direct terminal input. Bash before 4.4 reports
`OSC 133;B;terax_blocks=0` and keeps its native prompt because it lacks PS0.

Settings offer Automatic, WebGPU or WebGL for new terminals (Automatic and WebGPU
use WebGPU where the webview has it, WebGL otherwise on every platform;
`window.__teraxTerm().renderer` reports the choice), plus opt-in screen reader
output. Accessible text is limited to 256 rows / 64 KiB and refreshes at most four
times per second while visible. Link detection (URLs, file paths with `:line:col`) runs on pointer demand while Cmd (Ctrl elsewhere) is held, and its code (`terminalLinksRuntime`: detection, hover chip, confirmation and activation) loads on the first such movement, press or key press so the first terminal does not pay for it (`terminalLinksLoader` is the only eager part: one dynamic import made once the surface exists. `LazyTerminalLinks`, loaded by it, is a few listeners and a short queue that replays the pointer and key events that happened while the runtime loaded, so the first Cmd/Ctrl-click needs no second one, and it lets go of the key listener when the pointer leaves; `eager-budget.test.ts` locks the boundary);
OSC 8 links take precedence. Links use pointer events (the selection controller cancels `pointerdown`, which suppresses mouse events), underline across wrapped rows, open http and https directly, confirm mailto, tel, credentials, punycode and HTTP(S) OSC 8 links whose text is not their address (a chip names the destination while the modifier is held), block other schemes, and open existing files in the editor at their line. Local file URLs open in the editor without confirmation even when their OSC 8 text differs from the destination. OSC 52 side effects retain one in-flight write and
only the latest pending value across the window.

The adapted Ghostty revision is pinned in `packages/ghostty-core/adapted/UPSTREAM.md`.
Both SIMD and scalar artifacts are shipped; the loader fetches only the variant
the webview supports. Scalar validation explicitly disables SIMD instructions
and types. This avoids changing OS minimums solely for the WASM SIMD requirement;
actual older WKWebView and WebKitGTK compatibility still needs platform tests.

PTY output is one multiplexed pull stream per window (`docs/architecture/pty-transport-v2.md`),
not a channel per terminal. The async `terax-pty` URI scheme (`pty/protocol.rs`) has two POST
endpoints: `poll`, kept outstanding exactly once per webview, and `ack`. One process-wide hub
thread (`pty/hub.rs`, scheduler in plain data driven by explicit time) holds the poll's responder
and answers with framed binary data (`pty/wire.rs`: `[u32 id][u8 kind][u32 len]`, kinds data, exit,
failed, sync; data frames carry their stream offset; responses are capped at 1 MiB) for every
terminal whose coalescing deadline is due. A terminal's presentation class picks its deadline:
focused 4 ms (16 ms sustained), visible 16 ms, hidden 100 ms, window occluded or asleep 250 ms;
256 KiB pending is always due, and terminals due within 4 ms ride in the same response (one
terminal contributes at most 512 KiB per response, so floods pipeline and share). The
frontend reports classes only on change (`pty_set_presentation`, from `lib/ptyPresentation.ts`);
each report carries a growing sequence number and a terminal keeps the newest one that named it,
because async commands can be applied out of order. macOS occlusion and sleep reach the hub natively
from `window_presentation.rs`. The stream token from `pty_stream_open` is the credential: any frame
can reach the scheme but only the page can invoke, so every request is admitted (`pty/gate.rs`) on
the handler's thread before it may wake the hub: the `Origin` must be the app's own
(`tauri://localhost`, `http(s)://tauri.localhost` on Windows, the dev server in dev builds; a request
without `Origin` is token-only), the body at most 3084 bytes (413) and well framed (400), and the
token the live one for the requesting webview (403; the hub publishes label to token, compared in
constant time). Responses echo the allowed origin with `Vary: Origin`, never `*`. Tokens come from OS
entropy only: if it fails, `pty_stream_open` fails instead of falling back to the clock. A terminal's
output is held until its receiver announces itself, and reload or window
destruction drops the held responder, kills the token and detaches that window's terminals.
Frontend `PtyOutputHub` owns the loop: it re-polls on a response before parsing and demultiplexes
to the `PtyOutputReceiver`s, whose cumulative parsed offsets ride on the next poll. An ack-only
request goes out only for new receivers, for more than 512 KiB of unsent progress, or when native
sends `sync` because it waits on that terminal (credit blocked or exiting).

Receivers parse in at most 32 KiB slices with a four-millisecond work budget on a shared FIFO
MessageChannel task queue, which closes its ports when idle. Only fully parsed original chunks
earn credit. Credit is bytes: at most 1 MiB in flight (128 chunks) and 2 MiB pending plus in
flight per terminal. Acknowledgments are cumulative offsets validated against delivered chunk
boundaries, so duplicates and retries cannot grant credit; a bad boundary or stream gap fails only
that terminal visibly. Parser failures stop delivery without acknowledging unconsumed bytes.
Transport failures retry with capped backoff and surface as one stalled/failed toast per
terminal. Exit waits for the reader drain and the final acknowledgments; the `exit` frame always
follows that terminal's last data frame. Unix readers sleep on PTY readiness plus an explicit
shutdown signal without a polling timer. After shell exit they consume ready output, bounded to
2 MiB / 30 seconds, rather than wait indefinitely for an inherited slave descriptor to close.
Exceeding this drain bound reports a reader failure and exit status -1. After shell exit,
30 seconds without acknowledgment progress closes a stalled queue with a logged delivery failure
and exit status -1. The deadline is armed before ConPTY close and thread joins; it does not run
during live-shell backpressure. Close wakes blocked queue workers and the Unix reader; Windows
keeps draining the pipe while ConPTY closes. Per-read costs stay low: the agent and DA filters
scan with `memchr` and copy runs, the reader checks an atomic `closed` flag and reuses its
buffers, input goes through one bounded queue to a per-session writer thread, worker threads use
128-256 KiB stacks, and `pty_has_foreground_process` lists children with `proc_listchildpids` or
`/proc/<pid>/task/*/children` instead of forking `pgrep`.

Enable release diagnostics with `localStorage.setItem("terax:terminal-diagnostics", "1")`
and reload. `window.__teraxTerm()` reads frontend counters;
`await window.__teraxTermSnapshot()` adds native queue counters and explicitly
labeled host RSS. Host RSS
excludes WebContent and GPU processes and is not total application memory.

Ghostty presentation uses shared native macOS occlusion/sleep and DOM visibility
tracking. Every renderer pauses immediately. The WebGPU renderer does nothing
more: frames and timers stop, while the window canvas (configured, at full size), cell
buffers, glyph maps and atlas textures stay resident, so coming back from a
Space switch, minimize or sleep costs one redraw and no allocation. Releasing
them is worse than keeping them (see the window canvas above). The WebGL fallback
still reclaims its renderer after two seconds of continuous occlusion, and at
once on sleep, because its dropped canvases are garbage collected (measured:
transient, no growth). Hidden tabs release their buffers and atlas lease immediately and
leave the window canvas (its size is kept). Per-pane pacing prevents focused output from
raising background pane cadence. Panes that are neither focused nor being
interacted with snap to one shared tick (30 Hz, 15 Hz in an unfocused window):
a pane that turns dirty waits for the end of its tick and presents with every
other pane of that tick in one encoder, submission and commit, at most once per
tick. The planner asks for an animation frame only for the vsync that can serve
the next deadline (the refresh interval and phase are learned from callback
timestamps), sleeping on a timer otherwise, so a 120 Hz display does not pay a
callback per vsync. A timer sleeping for a later tick is re-planned when a pane
that is due sooner turns dirty, so the focused pane never waits behind it.
WebGPU permits at most two outstanding frame submissions and keeps one
`onSubmittedWorkDone` wait outstanding at a time: frames submitted while it is
pending ride the next wait, which starts when it resolves (waiting only every
second frame was tried and cut a 32 Hz producer to 23 presented frames a second).
User wheel, drag, and keyboard interaction gives only its pane 150 ms of focused
cadence, including in an unfocused visible window. It starts no idle timer or
frame loop.
`window.__teraxTermTrace()` explicitly starts a bounded ten-minute resource trace;
it is never started automatically. `pnpm soak:ghostty` exercises real WASM models
without launching the application. `pnpm profile:ghostty` compares allocation
and parsing workloads in a fresh process per artifact and optional baseline.
`pnpm profile:renderer:macos` exercises the real renderer in an isolated native
WKWebView, including optional four-pane layouts and live visual inspection; it is a
macOS-only lab retained as upstream evidence tooling and runs on no supported
platform, so it establishes nothing about the Linux build on its own.
`scripts/terminal-visual` draws a fixed pattern through any source tree and reads
the canvas back as exact pixels for comparison.
The macOS-only IPC profile that exercised the built-in AI streaming and
conversation-storage commands was removed with the client surfaces (ticket #12);
the native commands behind it went in ticket #14, so no profile covers them.
Resource evidence and limitations live in
`docs/architecture/ghostty-resource-efficiency.md`.

The release gates and current verification evidence are in
`docs/architecture/ghostty-release-readiness.md`. Automated checks alone do not
establish production readiness, platform parity, or multi-day resource stability.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (portable-pty ↔ Ghostty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams over the `terax-pty` multiplexed pull stream (hub thread, `pty_stream_open`, `pty_set_presentation`); input goes through a per-session writer thread.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_move`, `fs_delete`, `fs_delete_batch`), `fs::copy::fs_copy`, `fs::clipboard::fs_clipboard_paths`: file explorer + editor IO. File paste captures the workspace and root before clipboard IPC. AppKit and GTK clipboard requests run on the main thread; Windows clipboard retries and filesystem copies run on blocking workers. `fs_copy` requires an authorized root, stages each item and publishes with a no-replace rename, and returns `{ created, failed }` with paths in the caller’s workspace representation. Conflict renaming uses `name copy N` siblings. Symbolic links are preserved without traversing them; copying a folder into itself is rejected. Explorer refresh and pasted selection ignore completions from an obsolete workspace.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_grep_interactive`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates). File lists are cached per root in `fs::index` (packed buffer, at most two roots, 45 s TTL) and dropped by watcher events and our own mutations, so a keystroke ranks the cached list instead of re-walking the tree (a change reported during a cold walk marks that walk stale: its result is returned but not cached). Interactive searches bump a `fs::supersede` generation when the command is dispatched, so the walk of an older query stops while a newer one starts. Every command that touches the disk is `async` and runs on the blocking pool (`fs::blocking`): Tauri runs a plain command on the main thread, and the async runtime has two workers (`modules/runtime.rs`), so nothing blocking may run inline in an `async fn` either.
- `fs::assets` (`asset_grant`, `asset_revoke`, `asset_revoke_scope`) backs the `asset://` scheme: the only native path that serves a file to document content. A grant names one file or one directory, owned by the webview and by the requesting tab scope; every request re-canonicalizes the requested path, re-applies `fs::access_policy` and re-checks the opened descriptor (`fs::access::opened_path`) against the grant, so a symlink or replaced target cannot step outside it. Delivery is bounded by the approved read ceilings (10 MiB whole-file, an explicit `override=1` up to 50 MiB, one-chunk range responses, at most four outstanding deliveries reserving one override read's bytes), and a revoke during a read aborts the response. See `docs/architecture/resource-limits.md`.
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`). All gated through the workspace authorization registry. `git_status` asks git for `--untracked-files=normal` (one `dir/` entry per untracked directory) and expands small untracked directories back into files with a bounded `git ls-files --others` (500 files and 16 directories per refresh, listing abandoned at a 256 KiB cap); a directory over budget stays collapsed as `dir/`, which stage and discard handle natively.
- `git::commands_review::*` (review view, tasks and worktrees; pure cores in `git/diff.rs`, `git/patch.rs`, `git/refs.rs`, imperative parts in `review.rs`, `worktree.rs`, `checkpoint.rs`, `branch.rs`, `watch.rs`): `git_diff_summary` / `git_diff_file` / `git_merge_base` take a `GitDiffScope` (`uncommitted | staged | unstaged | range{base,head} | commit{sha} | checkpoint{from,to}`, a checkpoint end is a ref or the live worktree). Revisions are screened and resolved to ids before they reach an argument list, paths go through `resolve_within_repo` and `--literal-pathspecs`. Summaries come from one `diff --raw --numstat -z` (cap 4 MiB, `truncated`), untracked files are listed (2000) and line-counted under budgets (300 files / 1 MiB each / 16 MiB total, else `approximate`); a file diff is parsed into hunks with stable content ids (cap 2 MiB, `truncated`, complete hunks only) plus both full contents when each side is under 1 MiB (`contentsOmitted` says why not). `git_apply_hunks` re-diffs under the per-worktree lock (`plumbing::lock_for_repo`, the same one checkpoint create / restore / prune take), selects hunks (and optionally lines) by id, builds the patch with `patch::build_patch` and applies it with `git apply --recount`: stage is `--cached` against the unstaged diff, unstage is `--cached --reverse` against the staged diff, a revert of an unstaged hunk is `--reverse` on the working tree only (the index is untouched), and a revert in the uncommitted scope is `--index --reverse` (refused with `needsSeparateScopes` when the file also has unstaged edits). Whole-file operations (new, deleted, renamed, binary, untracked) use `git add -A` / `reset` / `restore` / `rm` / `clean` instead of a patch; stale ids, whole-file-only changes (added, deleted, renamed, binary, symlink, submodule, mode-only, end-of-file newline with line picks) and rejected patches come back as a structured `refusal`, never a half apply. Worktrees default to `~/.terax/worktrees/<project>-<hash>/<task>` (claimed atomically, collision-safe); each is authorized with `WorkspaceRegistry::authorize_derived(child, parent)` (revoked on remove/prune, and `git_worktree_list` re-grants only worktrees whose `.git` file points back into the repo); `include` globs copy ignored files (never overwrite, no symlinks, confined to both roots, budgeted; `*` stays inside one path component and only `**` crosses `/`, and a wildcard walk is limited to the pattern's depth and skips `.git` and dependency / cache trees). `git_worktree_remove` without `force` returns blockers (`dirty`, `unmerged`, `locked`, `ignored`: non-regenerable ignored files such as `.env`; dependency caches and files byte-identical to the main checkout's copy, e.g. unchanged `include` copies, do not count; `inconclusive`: a safety check timed out, failed or hit its output cap, named in `inconclusive`, so removal fails closed and only `force` goes on) instead of deleting, and removing a worktree whose directory is gone drops only that one administrative entry (never a repository-wide prune). Checkpoints (`refs/terax/checkpoints/<task>/<turn>`) are built from a seeded private `GIT_INDEX_FILE` (`add -A` + `write-tree` + `commit-tree`), so the real index, HEAD and files are untouched; vanished or unreadable files are retried/excluded and reported (`consistent`, `unstablePaths`, `limits`); every checkpoint commit carries the random id kept in the worktree's own git directory (`terax-worktree-id`; refs are shared by all worktrees of a repository, and the id survives renaming or moving the directory), and only that worktree may list, restore or prune it; restore refuses with the changed files when the worktree differs from the latest checkpoint, or from the tree the last restore wrote when that is newer (so restoring forward is not a change; making or pruning checkpoints clears that marker), unless forced, saves the working tree it is about to overwrite under `refs/terax/checkpoints/<task>/prerestore-<ms>` (returned as `safety`; restoring that ref undoes the restore) before touching anything, writes only differing paths, never touches ignored files and resets the index entries of touched paths to HEAD. Checkpoint plumbing runs with `core.fsmonitor=false`, `core.hooksPath` pointing at an empty directory in the git dir and `core.safecrlf=false`; file diffs force `a/` `b/` prefixes whatever `diff.mnemonicPrefix` / `diff.noprefix` say, and the git runner strips redirecting variables but keeps the user's `GIT_CEILING_DIRECTORIES`. A checkpoint scope's live worktree end can be pinned to the snapshot a summary returned (`{kind:"worktree", tree}`) so file diffs reuse it instead of re-walking the tree; diff output is capped at 20k lines (`truncated`). `git_watch` / `git_unwatch` (refcounted per repository under one lock together with the worker; `git_unwatch` takes the `repo` key `git_watch` returned and touches no repository, so it works after the worktree is removed; a touched directory costs a bounded number of stats and a burst of more than 64 directories is answered with one resync walk) register the non-ignored directories, git dir and refs with the shared `fs::watch` backend through a tap on its touched-directory stream and emit `terax:git-changed {repo, kinds}`; no subscriber means no worker, tap or OS watch; directories only another watcher registered (an ignored build tree) report nothing. The first push of a branch without upstream goes to `branch.<name>.pushRemote`, then `remote.pushDefault` (a configured name that is not a remote refuses instead of guessing), only then `origin` or the sole remote, as the full refspec `refs/heads/<b>:refs/heads/<b>`; `git_upstream_info` resolves the tracking ref through git's own `%(upstream)`, so a custom fetch refspec works. Checkpoints, `git_watch` and worktree creation/removal are not available for WSL workspaces yet (listing resolves paths through the workspace env).
- `shell::shell_run_command`: one-shot subshell exec used by the external formatter (bounded `proc::capture`: two short reader threads, no wait on pipes a backgrounded grandchild keeps open). Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`), on Unix via `/bin/sh -c`. Shared helper `build_oneshot_command`.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn/git/formatter cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section).
- `vibrancy::window_*`: native window backdrop (`window_backdrop_kind`, `window_set_backdrop`). macOS gets `NSVisualEffectMaterial::UnderWindowBackground`, Windows 11 gets Mica (gated on build >= 22000 via `RtlGetVersion`, since `apply_mica` fails on Windows 10), Linux reports `none` because blur there belongs to the compositor. The `window-vibrancy` crate is a macOS/Windows-only dependency so Linux builds never pull it.

### PTY shell integration

PTY shells are bootstrapped via injected init scripts in `src-tauri/src/modules/pty/scripts/`:

- **Unix** (`zshenv.zsh`, `zprofile.zsh`, `zlogin.zsh`, `zshrc.zsh`, `bashrc.bash`) for zsh/bash, plus `init.fish` installed to `~/.config/fish/conf.d/terax.fish` for fish. Emit OSC 7 (cwd) and OSC 133 A/B/C/D (prompt boundaries + exit code) so the host can track cwd and detect command boundaries without re-parsing the prompt. Fish 4.0+ writes its own OSC 133 prompt markers; Terax sets `fish_features=no-mark-prompt` and re-asserts its own prompt via `-C` to avoid doubling.
- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) → `powershell.exe` (PS 5.1) → `cmd.exe` (cwd only: the spawn sets `PROMPT` to emit OSC 7 from `$P` ahead of the user's prompt, `cmd_prompt` in `shell_init.rs`; the path keeps its backslashes and `parseOsc7` reads it literally, without percent-decoding, and normalizes it). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

zsh wrappers source the user's files with `ZDOTDIR` switched to their own directory (`TERAX_USER_ZDOTDIR` remembers a value their `.zshenv` sets) and keep it that way at the prompt, in hooks and widgets, so `$ZDOTDIR` loaders, `HISTFILE` and `.zlogin` behave as without Terax. Only a command line that starts a zsh (first word of a list or pipeline segment, after `exec` and its flags, `command`, `time`, `coproc`, `env` by name or path with `VAR=1`, `sudo` flags, an alias, `$SHELL`; only the first 512 characters and eight segments are inspected) gets Terax's directory exported in `preexec` (pure zsh word splitting, no forks) and the next precmd puts the user's value back, so a typed `vim $ZDOTDIR/.zshrc` finds their file, a script or `zsh -c` keeps the user's value, while `exec zsh`, a nested `zsh` and `zsh -l` read the integration scripts and the user's files once each (`su -` clears the environment and gets neither). The user's value travels in an exported `TERAX_USER_ZDOTDIR`. Our zsh code runs under `emulate -L zsh`, so KSH_ARRAYS and NO_UNSET cannot break it. The prompt end (OSC 133;B) goes after the prompt text in `PS1` and is also emitted from `zle-line-init`, because powerlevel10k rebuilds `PS1` in a precmd that runs after ours and redraws it asynchronously; a prompt that carries its own B is left alone. bash puts a last `PROMPT_COMMAND` entry (`_terax_finish_prompt`) behind every framework that rebuilds `PS1` (starship) so B follows the prompt text, keeps `PROMPT_COMMAND` arrays intact, returns the status it got so later entries see `$?`, and under ble.sh registers a `PRECMD` hook (`_terax_ble_precmd`) that stays silent while `PROMPT_COMMAND` still names the hook. Neither runs a command substitution per prompt (a fork is slow on MSYS). The prompt presentation gate (`PromptPresentationGate`) holds rendering from A to B for at most one second and learns: prompts that ended on the watchdog shorten it to 120 ms and then 16 ms until a B is seen again. `scripts/zshrc.test.py` and `bashrc.test.bash` drive real shells and run in CI.

Terminal colour queries (`OSC 4/10/11/12`, `CSI ? 996 n`, and `CSI ? 2031` scheme-change reports) are answered by `DaFilter` on the reader thread from the theme the page pushes at spawn and on every theme change (`pty_set_colors`, `terminal_colors.rs`), because a program that asks gives up after a short timeout and a late reply is echoed as text. A colour a program changed itself is left to the model that holds it.

`pty/shell_init.rs` is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules - keep new platform-specific code in the right cfg arm.

ConPTY on Windows requires `CONPTY_LIFECYCLE_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam. The lock must never be held across anything that waits on the frontend: the waiter lets the reader overdraft the output queue (`close_pseudoconsole`) before taking the lock for `ClosePseudoConsole`, so a backlog the page has not acknowledged cannot stall other `pty_open` calls.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`pty/job.rs`). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Terax process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child. macOS/Linux rely on `Drop for Session → killer.kill()`; on dev-`Ctrl-C` of `cargo run` destructors don't fire and orphans are possible there too - acceptable for now since dev only.

`App.tsx` returns the workspace shell from one stable root (`ThemeProvider` → `TooltipProvider`). Do not wrap it in a provider that appears only after asynchronous startup work: changing the parent element type remounts the whole tree and re-spawns every live PTY. The removed built-in AI used to need exactly that constant parent (`AiComposerProvider`); preferences hydration now runs through `usePreferencesBootstrap` without adding a wrapper.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` → `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `git-diff` | `git-history` | `git-commit-file`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps live leaves mounted. `useGhosttyTerminalSession` owns one persistent model and PTY per leaf; GPU/WebGL surfaces lease shared presentation resources independently. `terminalSessionApi.ts` exposes renderer-neutral product actions. OSC 7 paths and OSC 52 payloads are validated by pure parsers; Ghostty supplies OSC 133 events and native command anchors to the lazy block controller; OSC 133;A carries a parser-time tracked pin, so a command ended by the next prompt, with no D, ends at that prompt even after reflow or later output in the same write. Breadcrumb commands require a tracked idle prompt; unintegrated shells and Bash before 4.4 cannot safely accept injected commands because builtins can read stdin without a foreground child. WebGPU can fail over to WebGL without replacing the model, PTY, selection, search, or block history. Hidden models keep parsing through bounded PTY transport while presentation is released. There is no snapshot replay or second terminal parser. Theme colors come from the central theme engine.
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`) via a per-pane compartment. Saves are conflict-checked against the disk mtime returned by `fs_read_file`/`fs_write_file` (mismatch → warning toast with explicit Overwrite, never silent last-writer-wins); external format-on-save only applies the disk read-back if the doc is unchanged since the save snapshot. Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); above 4 MB syntax highlighting stays off. Cmd-F routes to CodeMirror's own search panel (find/replace/regex) when an editor tab is active, Ctrl-G opens go-to-line; both panels styled in `chromeTheme.ts`. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default, a global external default only runs on languages its tool understands, and a language with no applicable formatter saves unformatted. `lib/fileNavigator.ts` is the app-shell bridge that lets terminal links open a file at a line in an editor tab. Diff panes resolve the language before mounting CodeMirror: a late compartment reconfigure leaves the merge view's deleted-chunk widgets unhighlighted. CodeMirror's own completion popup is not AI completion: the `Tab` key accepts an open popup, and the `editor.codeComplete` registry shortcut opens it (guarded to editor tabs so the key falls through to terminals). There is no inline AI completion and no AI edit-review surface. Markdown editing is GFM (`markdownLanguage` base) with fenced-code highlighting resolved through the shared lazy language registry, Cmd/Ctrl+Click URLs, and clickable task checkboxes (`markdownExtras.ts`, all inside the lazy markdown chunk; the eager-budget test enforces this). Dotenv files (`.env`, `.env.*`, and `*.env`) use the lazy shell grammar. Editor theme is decoupled from the app theme: the `editorTheme` pref is `"auto" | EditorThemeId` (default `"auto"`), resolved at render time by `useEditorThemeExt` via `resolveEditorThemeId`. In `auto` the editor follows the active app theme's `editorTheme[mode]` pairing (live, never stale); an explicit pick overrides. Theme ids + labels live in `settings/store.ts` (`EDITOR_THEMES`/`EDITOR_THEME_LABELS`); the matching extensions in `editor/lib/themes.ts` (`EDITOR_THEME_EXT`). Prebuilt `@uiw` themes plus locally-built ones in `editor/lib/cmThemes.ts` (Kanagawa wave/lotus/dragon, Everforest, Dracula, Solarized, Catppuccin, Rosé Pine) via `createTheme` (no extra deps). The CM surfaces (`EditorPane`, `GitDiffPane`) all read the theme through `useEditorThemeExt`.
  Editor code size is stored separately as `editorFontSize` and does not affect `terminalFontSize`.
- **explorer/** - file tree with Catppuccin icons, fuzzy search, keyboard nav, inline rename, context actions. Backslash-aware `basename`. Icons are lazy: `iconResolver.ts` is the startup-safe shell and fetches the ~360 kB set (`iconEngine.ts`) when the first `FileIcon`/`FolderIcon` mounts; until then those components render a same-size blank slot that fades the icon in, and the set is never in either window's startup graph. The tree stays mounted when the sidebar collapses but is `visible={false}`: no native fs watchers (`watchRegistry.ts` disarms them), no `fs:changed` subscription, no drop listener and no reloads; showing it re-registers the watchers and reloads loaded directories once.
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected), plus the bounded local-asset surfaces: `AssetPreview` gates image/PDF/media delivery on the approved read ceilings (with an explicit "load anyway" choice), `ImagePreview` reads intrinsic dimensions with the native `fs_image_probe` header probe and runs `lib/imageViewer` (budget → admission → mount) so an oversized raster is refused before the `<img>` exists; `lib/viewerAdmission` admits decoded viewers against the four-viewer / 192 MiB budget, releasing only hidden ones. Image routing (`lib/imageFormats`) is kept separate from measured decode support; hidden image tabs drop the element and release their decoded slot. Asset grants are tab-owned through `lib/assetScopes`, so a closed tab revokes them and a late grant is revoked instead of installed.
- **tabs/** - `useTabs` is the source of truth for tab list + active id. `useWorkspaceCwd` derives explorer root + inherited cwd for new tabs from active tab. `basename` splits on both `/` and `\`.
- **header/** - top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights).
- **statusbar/** - bottom bar and `CwdBreadcrumb` (handles Unix paths, Windows drive letters, and home `~` segments via `pathUtils.segmentsFromCwd`).
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, `pane.source`, …). Defaults live in `shortcutDefaults.ts`, one table per platform family, and mean the same thing wherever focus is. macOS uses Command. On Windows/Linux no default is a plain Ctrl chord that is a control byte (Ctrl+P/R/E/W/D/F/G/[/]/- belong to the shell), an Alt chord (Meta bindings), a function key or Ctrl+Alt+character (AltGr); app commands use Ctrl+Shift+<key> (Jump to tab is Ctrl+Shift+1 to 9, matched by physical key), Ctrl+, and Ctrl+=. Editor shortcuts keep plain Ctrl chords because the host only runs them in editor tabs. `shortcutDefaults.test.ts` audits both tables (unique chords, no terminal-program, OS or CodeMirror-keymap chord); every on-screen hint comes from `useShortcutHint`, never a literal.
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`), preferences hook, settings window opener. The Settings window is closed (not hidden, so its WebContent process is released) when it hands a theme edit to the main window; `open_settings_window` rebuilds it on demand.
- **sidebar/** - activity bar + collapsible side panels (explorer, source control, git history).
- **source-control/** - git status / stage / commit panel and diff workflow. `useSourceControl` takes a `live` flag (`statusConsumers.ts`): `git status` runs on window focus and context changes only while the Source Control panel, a git tab or the explorer's git decorations are on screen. Otherwise nothing runs, a snapshot for another repository is dropped (never a wrong badge), and the next consumer to appear refreshes it. The rail badge alone is not a consumer; it refreshes lazily.
- **git/** - the only place that talks to the git IPC commands: `types.ts` (mirrors the Rust serde output), `api.ts` (`git.*` typed wrappers carrying the workspace env), and pure helpers with tests: `scope.ts` (scope labels, keys, liveness, which hunk actions a scope allows), `hunks.ts` (immutable hunk/line selection model and the `toApplySelection` payload), `changes.ts` (`subscribeGitChanges`: one shared `terax:git-changed` listener, per-repo routing and kind filters, backend watch released with the last subscriber).
- **git-history/** - commit graph rail, refs, per-commit file diffs.
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind) and the shared fenced-code renderer. `MarkdownPreviewPane` owns the document read/watch loop, the 10/50 MiB override and the tab-scoped asset grant; `MarkdownContent` draws it (sanitised, static Streamdown). Local images load automatically only from the configured Space project root, or from an outside document's own folder, never from the mutable terminal cwd. Anything beyond that boundary needs the explicit per-file grant the notice offers; remote images stay unrequested until the deliberate "load remote images" action; links are inert unless they are a clicked external target. Fenced code goes through `components/CodeBlock` (highlighting off above 4 MiB, copy, run-in-terminal). The run action is published by `App.tsx` through `lib/codeBlockRunner` because only the shell knows the active terminal. See `docs/architecture/markdown-rendering.md`.
- **workspace/** - workspace environment switching (Local + WSL distros).
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/` (terax-default - colours live in `globals.css` since ThemeProvider clears rather than applies for that id - xcode, claude, kanagawa, kanagawa-dragon, tokyo-night, catppuccin, rose-pine, everforest, nord, gruvbox, dracula, solarized, tide, sage, caffeine), each optionally declaring an `editorTheme` pairing consumed by `resolveEditorThemeId` (see editor/). User themes via `customThemes.ts` + `validateTheme.ts`, optional background image via `bgImageStore.ts` + `SurfaceLayer`.
- **updater/** - auto-updater UI built on `tauri-plugin-updater`.
- **agents/** - agent launching, notifications, and management for terminal coding agents (Claude Code, Codex, Gemini CLI, Pi, OpenCode, Grok, Antigravity CLI). The header launcher (`components/AgentLauncherPanel.tsx` + `lib/launcher.ts`) persists per-agent start commands in preferences and atomically builds balanced one-to-four-pane tabs. Shared store (`store/agentStore.ts`: terminal `sessions` + `notifications`) and a shared router (`lib/route.ts`: suppress when focused-and-visible, OS-notify when unfocused, in-app Sonner toast when focused-but-hidden) feed the header `NotificationBell` (management surface with per-agent hook state rows that point at Settings → Agents). Toasts use Sonner (`components/ui/sonner.tsx`) themed via the central engine; `lib/agentIcon.tsx` renders the per-agent brand mark. Terminal detection is Rust-side (`pty/agent_detect.rs`) on the PTY reader's byte filter, armed on `OSC 133;C;<cmd>` (Windows launcher forms `.exe`/`.cmd`/`.ps1`, quoted paths and the call operator included) or self-armed by a structured hook, emitting `terax:agent-signal` transitions (`started`/`working`/`attention`/`finished`/`exited`) driven only by OSC sequences (never raw output, so a repainting TUI never flaps) - zero cost when no agent runs. A process only ever proves running or exited: `finished` needs an agent event, an exit never becomes a completed turn, and a cancelled turn (aborted stop, Codex interrupt) is quiet, so the bell and tab surfaces can say "running", "needs attention" or "turn finished" without implying an agent is working or a task is done. The same filter reports BEL and OSC 9/99/777 from any program that is not a known agent as `terax:terminal-notification` (`ptyId`, `title?`, `body`, `kind`), at most five per ten seconds per terminal with identical repeats dropped. Hook-backed terminal agents deliver structured events instead of terminal bytes: the installed hook runs `terax hook <agent> <event>` through `$TERAX_WORKSPACE_FORK_CLI` (`modules/agent.rs`: a per-dialect command for POSIX shells, cmd and PowerShell, no interpolated input; Claude Code `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Gemini CLI `~/.gemini/settings.json`, and a Terax-owned Pi extension that spawns the CLI), the CLI reads the hook JSON from stdin, trims it, and sends the control `hook` method with the caller's `TERAX_PANE_ID`. `modules/agent_events.rs` authenticates it, requires the pane to belong to a live PTY, normalizes it with the typed adapters in `terax-control-protocol::hook` and emits `terax:agent-event` (session id, transcript path, cwd, message, tool, permission, subagent) while keeping the legacy `terax:agent-signal` stream in step through the shared `AgentLink`; once an agent is hooked its OSC 9/777 hints and bells are ignored, and process lifecycle still comes from OSC 133. Claude Code and Codex `PermissionRequest` hooks can wait for the Terax UI (`agent_decisions_ready`, `agent_decision_respond`, `AgentDecision` in `modules/control/agents.ts`) and receive the agent's own allow/deny JSON; with no UI subscriber, an ended request, a closed pane or an agent that went away the hook falls through to the agent's prompt. Installs are lifecycle-only (session start, prompt, permission request, notification, stop, session end) until something consumes tool events: one declarative table per agent in `modules/agent.rs` marks each supported event wanted or not, per-tool-call hooks are off, and an install removes Terax groups for events that are no longer wanted. Installs splice into the existing file text (`modules/agent_json.rs`), so comments, ordering and indentation survive; `agent_hooks_plan` returns the exact before/after plus the observed file revision and per-agent activation instructions, `agent_hooks_apply` writes only against that reviewed revision and returns `stale` (no write) when the file changed, and removal touches only entries that invoke `$TERAX_WORKSPACE_FORK_CLI` - upstream Terax (`$TERAX_CLI`, `__terax_notify`) and user hooks are foreign and never rewritten or removed. Hooks are opt-in per agent and are never installed by launching one; the only install/remove path is the reviewed dialog in Settings → Agents, which reports "configured, trust required" rather than active. See `docs/architecture/agent-hooks.md`. `src/modules/agents/model/` is the pure reducer from these events to agent states and is not wired to UI yet. OpenCode, Grok and the Antigravity CLI use OSC 133 process-lifecycle detection but do not install hooks. The Antigravity CLI is launched and detected distinctly from its desktop app: a GUI command shape is refused at launch (`lib/launchTarget.ts`) and never arms the CLI (`is_desktop_app_launch`), so the workspace never claims to drive the GUI. Agent notifications carry the agent name, the Space's name and the kind of attention or completion, and are built from that allowlist in `lib/route.ts`; no prompt, transcript, cwd or file text is passed, sound is off by default and delivery never takes focus. Per-agent launch, status, event, notification and control support, and what is not vendor-certified, are recorded in `docs/architecture/agent-capabilities.md`. Hooks installed by upstream or older versions (OSC markers, `__terax_notify`) are treated as foreign: this fork adds its own group and leaves theirs in place. The built-in Terax agent path (`LocalAgentNotificationsBridge` mapping `chatStore.agentMeta`) was removed with built-in chat (ticket #12); the rest of the Agents tab was built-in AI except the reviewed hook install/remove flow.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.
- **spaces/** - workspace spaces/projects (name, root, env, color, per-space tab persistence) via `useSpaces` and `SpaceSwitcher`.

### Removed built-in AI

The built-in AI stack is gone end to end. The client surfaces went in ticket #12 (chat panel/composer/mini-window, conversation sessions and their startup hydration, provider/model selection, API-key management, prompts/snippets, sub-agents, managed review, voice, AI completion/Ask AI, language servers) and the native plumbing went in ticket #14 (issue #14):

- Removed commands: `ai_read_file`, `ai_read_dir`, `ai_grep`, `ai_glob`, `fs_read_project_memory`, `shell_session_*`, `shell_bg_*`, `secrets_*`, `lm_ping`, `ai_http_*` and `ai_session_*`.
- Removed modules: `modules/net` (AI HTTP proxy and SSRF classifier), `modules/secrets` (keyring), `modules/ai_sessions` (conversation files), `modules/ipc_body`, `fs::ai`, `fs::project_memory`, `shell::{session,background,ringbuffer}`.
- Removed dependencies: `reqwest`, `rustls`, `bytes`, `futures-util` and `keyring`. The updater plugin keeps its own `reqwest`/`rustls(ring)` stack and installs the crypto provider itself.
- `agents/` never used any of it. Agent launching, notification routing, hooks and the control plane are terminal-native and untouched.

What survived the removal, on purpose: `shell_run_command` (the retained external formatter runs through it), `src/modules/workspace/{native,policy}.ts`, `pathPolicy.json` and `src-tauri/src/modules/fs/{access,access_policy}.rs` (owned by the retained file/preview features), Markdown rendering, Git and its credentials, PTY, history, hooks, notifications, the CLI/control plane and the updater.

Stored upstream conversations and credentials are never read, migrated or deleted by the fork (see `docs/architecture/namespace-isolation.md`). Guards: `src/app/chat-removal.test.ts` (client entry points and startup graph) and `src/app/ai-native-removal.test.ts` (command table, native module tree, dependency graph, docs).

### UI conventions

- **shadcn/ui** is configured (`components.json`, style `radix-luma`, base `mist`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `pnpm dlx shadcn add` to upgrade.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- **Animation cost**: nothing animates forever at display rate. Tailwind `animate-spin`/`animate-pulse` are redefined in `globals.css` with `steps()` (12 and ~4 fps), the text shimmer uses 40 steps per sweep, recording indicators use `.terax-blink`, a pending tool approval uses the finite `.terax-attention-pulse`, and persisted history (`bash_background`) never animates. `modules/theme/windowActivity.ts` sets `html[data-window-inactive]` while the window is unfocused, hidden or occluded (DOM focus, document visibility and the terminal's shared native presentation feed, no extra native listener); that attribute pauses every CSS animation and an animated background image freezes on a still frame (`surfaceFrame.ts`). `prefers-reduced-motion` still removes the rest.
- **Compositing budget**: every composited layer costs a backing store, and WebKit allocates a new one per window-resize step for each layer that follows the window. At rest the shell has three layers with contents (page tile, terminal canvas, the terminal's hidden textarea); everything else is clip layers without backing. Do not add `will-change`, 3D transforms (`translateZ`, `transform-gpu`), `backdrop-filter`/`backdrop-blur` or blur filters to anything mounted by default; popovers, HUDs and chips use an opaque `bg-popover`/`bg-card` instead of a translucent blurred one. Only the allowlist in `src/styles/compositingBudget.test.ts` (modal scrims, the background-image overlay, ...) may, each with a reason. A static background image gets no layer (`surfaceOwnsLayer`). While a window drag is live, `html[data-live-resize]` (`modules/theme/livePageResize`, macOS only) gives the document an invisible size rounded up to 512 px so WebKit keeps one page tile size across the drag instead of one per step (`docs/architecture/app-lab.md`, "Compositing layers").
- **Startup graph**: neither window may preload Streamdown, CodeMirror or the icon set. `vite.config.ts` splits chunks with two prioritised `codeSplitting` groups (eager `react`/`radix`/`ghostty-vt` outrank lazy features, because a lazy chunk's recursive dependency capture once swallowed React's CJS entry). `src/app/dist-budget.test.ts` builds into a temp dir with sourcemaps and fails if any forbidden package or chunk is reachable from `index.html`/`settings.html`; `pnpm check:dist` runs the same check on `dist/`. `eager-budget.test.ts` keeps the source-graph check.
- **One copy per package**: `src/app/dist-budget.test.ts` also fails when any npm package is bundled in two versions; pin one with a scoped override in `pnpm-workspace.yaml`.
- **Primary terminal chunk** (`.size-limit.json`, what every window loads): keep it to the first terminal's hot path. Rarely used code loads on first use and `eager-budget.test.ts` locks it out of the session import graph: the sextant, octant and legacy-computing glyphs (`gpu/builtin/lazyGlyphs.ts` loads `legacyComputing.ts`; until it arrives those cells draw blank and its arrival bumps `symbolFontEpoch`, which rebuilds every atlas like the icon face), the search engine (`search/GhosttySearchController.ts` is the thin controller each surface owns and imports `GhosttySearchEngine.ts` on the first find) and the release diagnostics (`sessionDiagnostics.ts`).
- **Window vibrancy**: the `windowVibrancy` pref drives `WindowVibrancyBridge` (main window only - `window_set_backdrop` targets its caller). `html[data-vibrancy="on"]` (off by default; an explicitly stored choice always wins) makes `<html>`/`<body>` transparent and redefines `--frame` with alpha, so only the chrome frosts; panes keep `--background` so terminal text stays on a solid surface and the terminal canvas still matches its container. The opaque colour the pre-paint script parks on `<html>` would cover the backdrop, so `applyVibrancy` clears it while the effect is on; there is deliberately no localStorage fast path, since pre-declaring the effect would show a see-through window on any launch where the native call has not landed yet. Repeat applications are deduped, and only Mica is rebuilt on a light/dark flip (NSVisualEffectView adapts on its own).
- **Floating panes**: header and status bar are window chrome painted on `--frame` (derived from `--card`, so no theme declares it); the sidebar and the tab surface are `.terax-pane` cards on `--background` - same tone as the terminal canvas. Panes meet the chrome flush and are inset only horizontally, because the header centers its content and any vertical gutter would stack onto that padding and read as asymmetric. `.terax-pane` carries no drop shadow: `react-resizable-panels` clips panel content at the panel box, so a shadow would only render on the gutter sides.
- Path imports: always `@/…`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.

### Window styling

- Linux is the distributed target: `decorations: false` + `transparent: true` from
  `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD. React renders custom
  `WindowControls` (`USE_CUSTOM_WINDOW_CONTROLS`).
- The macOS/Windows window styling (overlay title bar and native traffic lights,
  `macOSPrivateApi`, `NSVisualEffectView` hosting, transparent-from-creation on Windows) stays in
  the Rust/React code as an inert upstream seam. `macOSPrivateApi`, `bundle.macOS`,
  `bundle.windows`, `tauri.windows.conf.json`, `entitlements.plist`, `Info.plist` and the NSIS
  `installer-hooks.nsh` were bundle/distribution config and were removed with the platform
  narrowing (ticket #34); re-adding any of them is re-adding a platform commitment.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets` is exactly `["rpm", "deb"]` (ticket #34 narrowed the release to Linux x86-64; the
  candidate packaging path owns this and refuses anything broader):
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`.
  - No AppImage, DMG, NSIS or MSI output is produced, and no aarch64 artifact. `scripts/packaging.py`
    and `scripts/tests/test_packaging.py` refuse a broader target set.
- `bundle.createUpdaterArtifacts` is `false` and the updater endpoints are the fork's non-live
  `.invalid` contract values (`src/modules/updater/releaseContract.json`). The application never
  downloads, installs or restarts itself: RPM/DEB upgrades go through the distribution's package
  tool (the explicit package-tool handoff), and Arch stays package-tool managed. Signing, release
  trust and publication gates belong to tickets #39/#40.
- `bundle.resources` includes the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`. Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.

### Known gotchas

- **Syntax highlighting identity**: parsers and editor themes must use the same `@lezer/highlight` instance. The pinned workspace catalog and override keep them aligned; update the catalog version to upgrade all consumers together. Duplicate copies silently hide token styles even when parsing succeeds. Language highlighting tests exercise every editor theme and chat code blocks; the built-output check also requires one highlighter module.
- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `CONPTY_LIFECYCLE_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Terax-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.

## Further reading

Long-form contributor guides live under `docs/`. These guides elaborate on `TERAX.md`; if anything conflicts, `TERAX.md` wins.

- `docs/README.md` - index of contributor guides
- `docs/architecture/two-process-model.md` - IPC boundary and command reference
- `docs/architecture/pty-shell-integration.md` - PTY, shell init scripts, OSC, ConPTY, Job Object
- `docs/architecture/pty-transport-v2.md` - multiplexed PTY output stream: hub, wire format, presentation classes, credit; `scripts/pty-smoke/` drives it in a real debug app (`python3 scripts/pty-smoke/run.py`)
- `docs/architecture/security-model.md` - consolidated security model and boundaries
- `docs/architecture/terminal-renderer-pool.md` - model ownership and presentation pool invariants
- `docs/contributing/testing.md` - testing contract and core-subsystem invariants

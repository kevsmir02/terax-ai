<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Codr" />
  <h1>Codr</h1>

  <p><strong>Unofficial Linux fork of Terax: a lightweight terminal-first workspace for external coding agents.</strong></p>
  <p>
    This repository is not affiliated with Crynta.
    <a href="https://github.com/crynta/terax-ai">Upstream project</a>
    ·
    <a href="SECURITY.md">Security</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="platform" />
    <a href="https://github.com/kevsmir02/terax-ai/releases/tag/v0.1.0"><img src="https://img.shields.io/badge/release-v0.1.0-blue" alt="release v0.1.0" /></a>
  </p>
</div>

<p align="center">
  <a href="docs/readme/README.zh-CN.md">简体中文</a> |
  <a href="docs/readme/README.es.md">Español</a> |
  <a href="docs/readme/README.de.md">Deutsch</a> |
  <a href="docs/readme/README.fr.md">Français</a> |
  <a href="docs/readme/README.ja.md">日本語</a> |
  <a href="docs/readme/README.ko.md">한국어</a> |
  <a href="docs/readme/README.pt-BR.md">Português</a> |
  <a href="docs/readme/README.pl.md">Polski</a> |
  <a href="docs/readme/README.ru.md">Русский</a> |
  <a href="docs/readme/README.id.md">Bahasa Indonesia</a> |
  <a href="docs/readme/README.hi.md">हिन्दी</a>
</p>

---

Codr (an unofficial Linux fork of Terax) is a lightweight open-source terminal-first development workspace built on Tauri 2 + Rust and React 19. A native PTY backend with a WebGL renderer, tabs, splits and a block terminal for launching independently installed coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Grok), plus a code editor, file explorer, source control with a git graph, rendered Markdown and a web preview pane. About 7-8 MB on disk. No telemetry. No account.

> [!NOTE]
> Over the past few months, most of my development time went into building [Zephium](https://zephium.app), a new browser-native work environment rebuilt for humans and agents.
>
> Terax is now returning to active development. A major **v0.9.0** update is already in progress, with some substantial architectural changes, including moving from **xterm.js to libghostty + WebGPU**.
>
> More updates soon.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="docs/web-preview.png" alt="Web preview" /><br/><sub>Web preview of local dev servers</sub></td>
    <td align="center"><img src="docs/editor.png" alt="Code editor" /><br/><sub>CodeMirror editing with syntax highlighting, find and replace</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/themes.png" alt="Themes and background image" style="margin-top: 12px;"/><br/><sub>Custom themes, presets, and background images</sub></td>
    <td align="center"><img src="docs/source-control.png" alt="Source control and git graph" style="margin-top: 12px;"/><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/terminal.png" alt="Terminal" style="border-radius: 4px; margin-top: 12px;" /><br/><sub>Block-based WebGL terminal with editor-like input panel</sub></td>
  </tr>
</table>

## Features

### Terminal

- libghostty terminal model with a WebGPU/WebGL renderer, multi-tab with background streaming
- GPU-accelerated block-based terminal with editor-like command input
- Native PTY backend via `portable-pty` (zsh, bash, fish)
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color
- Drag files from the explorer or desktop into a terminal as shell-safe quoted paths
- Spaces restore tabs, working directories, and split layouts across launches

### Code editor

- CodeMirror 6 (supports all popular languages - TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Syntax highlighting for the bundled languages, find and replace, and vim mode — no language servers or diagnostics
- Rendered Markdown plus image, video, audio, and PDF viewing
- Vim mode
- Built-in editor themes including Kanagawa, Catppuccin, Rosé Pine, Everforest, Dracula, Solarized, Nord, Tokyo Night, GitHub, and Xcode

### Source control

- Stage / unstage hunks, commit (Cmd+Enter / Ctrl+Enter), push with upstream awareness
- Branch display including detached HEAD state
- Git history pane with a real commit graph (lane rendering for merges and branches)
- Commit search and filter, click through to the remote commit page

### File explorer

- Catppuccin icon theme
- Fuzzy search, keyboard navigation, inline rename, context actions
- Live updates when files change on disk

### Web preview

- Auto-detects local dev servers and opens them in a preview tab
- External URL preview via a native child webview

### Themes and customization

- Custom themes built in-app, switch between bundled presets and your own
- Create your own themes, share them or import from the community
- Background images with adjustable opacity and blur
- Editor theme is independent from the app theme

### External coding agents

- **Any terminal agent:** launch Claude Code, Codex, Gemini CLI, OpenCode, Grok or your own command in a tab, pane or balanced 1-4 pane group
- **Attention and completion notifications:** native when unfocused, in-app otherwise; no prompt or transcript excerpts, no focus stealing, sound off by default
- **Hooks are opt-in:** review the exact configuration change before it is written, and only this fork's entries are added or removed
- **Agent-aware tabs:** process status from the PTY; hook-backed agents report structured events
- **No built-in chat:** there is no provider, API-key, conversation or built-in agent UI to maintain

## Install

This fork builds and distributes **Linux x86-64 only**: one RPM and one DEB per release, plus an
authored (not built) Arch recipe (`packaging/arch/PKGBUILD`), published on this repository's
[Releases](https://github.com/kevsmir02/terax-ai/releases) page (`v0.1.0` stable channel).
Update discovery fetches `latest.json` from the fork's stable feed, verifies the minisign Ed25519
global signature and key ID (`94097B75DB498B21`), and never downloads, installs or restarts
itself: upgrades are handed to your package tool (`dnf`, `apt`, or `pacman`) after safe closure.

### Linux routes and validation status

- **Fedora 45 KDE Wayland (primary validated target, #44):** `sudo dnf install ./codr-0.1.0-1.x86_64.rpm`.
  The RPM candidate passed dependency resolution, isolated Wayland smoke, container `rpm` lifecycle
  checks, and maintainer host install (`codr-1.0.0-1.x86_64`). Host-root `dnf upgrade` across
  versions and package-lock/cancellation paths remain unverified.
- **Debian / Ubuntu (waived, unverified):** `sudo apt install ./codr_*.deb`. Debian 13 graphical
  WebKitGTK runtime validation was waived for personal-tool scope (#44), so no `.deb` install or
  upgrade run is claimed.
- **Arch Linux (authored, not built):** `packaging/arch/PKGBUILD` is signed and attached to releases,
  but no `makepkg` or `pacman` run has been executed (`pacman -Syu` / `makepkg -si` remains an
  unbuilt user-managed route, #44).
- On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

### Signature verification and recovery

Download the artifact, its `.minisig` signature, and `SHA256SUMS` from the release, then verify
before running `dnf` or `apt` (native DNF/APT repository GPG signing is deferred):

```sh
sha256sum -c SHA256SUMS
minisign -Vm ./codr_0.1.0_amd64.deb -x ./codr_0.1.0_amd64.deb.minisig \
  -P RWQhi0nbdXsJlFu9b48smjYdtZKzZ3An6rjhKRz+kdL0tG8f7DBJj8lL
```

- **Failed or cancelled package transaction:** Codr makes no rollback and cannot tell whether an
  external `dnf`/`apt` run succeeded. Close Codr completely, re-run the package-manager command, and
  confirm installed files with `rpm -q codr` or `dpkg -s codr`.
- **Signing key custody and replacement:** see [release trust](docs/architecture/release-trust.md)
  and [update handoff](docs/architecture/update-handoff.md) for offline key recovery and rotation.

### Tested limits, capabilities, and exclusions

This personal-use release claims no broad compatibility or production-readiness certification:

- **Terminal and renderer:** WebKitGTK uses the Terax WebGL fallback (`scripts/terminal-visual`
  scaling checked at DPR 1, 1.25, 1.5, and 2); Kitty graphics is incomplete and not advertised;
  physical IME and OS clipboard round-trips remain manual checks.
- **File, preview, and codec bounds:** text syntax highlighting turns off above 4 MiB (10 MiB soft
  override, 50 MiB hard cap), images enforce a 64 MiB decoded cap and 192 MiB / 4-viewer budget,
  PDF pages enforce a 32 MiB cap, and tested media containers (`WebM`, `Ogg`, `WAV`, `MP3`,
  `FLAC`, `M4A`, `AAC`, `MP4`, `MOV`) reflect host WebKitGTK 2.54.2 GStreamer codecs only
  ([resource limits](docs/architecture/resource-limits.md)).
- **External agents:** launching, OSC 133 process status, opt-in hooks, and `terax open` control
  are verified on synthetic fixtures only; no vendor CLI (`claude`, `codex`, `gemini`, `pi`,
  `opencode`, `grok`, `antigravity`) has live turn or hook-trust certification
  ([agent capabilities](docs/architecture/agent-capabilities.md)).
- **Retained exclusions:** no built-in AI chat, API-key storage, telemetry, LSP, or in-app
  updater; macOS, Windows, and WSL code paths remain inert upstream seams only.

### Platform support

Upstream Terax also ships macOS, Windows/WSL and Nix builds. **This fork does not**: those build and
distribution workflows were removed (ticket #34), and no non-x86-64 artifact is produced. The
Windows, macOS and WSL code paths that upstream shares with Linux are retained in the source as inert
seams, because deleting them would make every upstream import a merge conflict — they are not
supported configurations here. See
[docs/architecture/linux-packages.md](docs/architecture/linux-packages.md) for what a package
candidate does and does not prove.

## Build from source

**Prerequisites**
- Linux x86-64 (the only supported build host)
- Rust (stable), https://rustup.rs
- Node 22+ and [pnpm](https://pnpm.io)
- The Tauri Linux prerequisites: WebKitGTK 4.1, GTK3, librsvg and libssl development packages,
  https://tauri.app/start/prerequisites/

**Run**
```bash
pnpm install
pnpm tauri dev          # development
pnpm tauri build        # production bundle
```

**Checks**
```bash
pnpm lint
pnpm check-types
pnpm test
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings   # Rust lint (matches CI)
cd src-tauri && cargo nextest run --locked                           # or: cargo test --locked
```

## Tech stack

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, libghostty (WebGPU/WebGL), CodeMirror 6, Tailwind v4, shadcn/ui, Zustand.

## Contributing

Issues and PRs are welcome! Feel free to open issues, suggest features, or submit pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [architecture docs](docs/README.md) for more details.

## License

Codr is licensed under the Apache-2.0 License (derived from upstream Terax). For more information on our dependencies, see [Apache License 2.0](LICENSE).

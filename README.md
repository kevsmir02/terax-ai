<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="Terax" />
  <h1>Terax</h1>

  <p><strong>Lightweight terminal-first workspace for external coding agents.</strong></p>
  <p>
    <a href="https://terax.app">Website</a>
    ·
    <a href="https://terax.app/docs">Docs</a>
    ·
    <a href="https://github.com/crynta/Terax-website">Website's source code</a>
  </p>

  <p>
    <img src="https://img.shields.io/github/v/release/crynta/terax-ai?label=version&color=blue" alt="version" />
    <img src="https://img.shields.io/github/downloads/crynta/terax-ai/total?label=downloads&color=blue" alt="downloads" />
    <img src="https://img.shields.io/badge/platform-Linux%20x86_64-lightgrey" alt="platform" />
    <a href="https://discord.gg/tyveTUyEp7"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
    <a href="https://www.youtube.com/@crynta"><img src="https://img.shields.io/badge/Youtube-FF0000?logo=youtube&logoColor=white" alt="YouTube" /></a>
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

Terax is a lightweight open-source terminal-first development workspace built on Tauri 2 + Rust and React 19. A native PTY backend with a WebGL renderer, tabs, splits and a block terminal for launching independently installed coding agents (Claude Code, Codex, Gemini CLI, OpenCode, Grok), plus a code editor, file explorer, source control with a git graph, rendered Markdown and a web preview pane. About 7-8 MB on disk. No telemetry. No account.

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

- xterm.js with WebGL renderer, multi-tab with background streaming
- GPU-accelerated block-based terminal with editor-like command input
- Native PTY backend via `portable-pty` (zsh, bash, fish)
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color
- Drag files from the explorer or desktop into a terminal as shell-safe quoted paths
- Spaces restore tabs, working directories, and split layouts across launches

### Code editor

- CodeMirror 6 (supports all popular languages - TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Opt-in language server support with diagnostics, navigation, completion, formatting, and custom servers
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
authored (not yet built) Arch recipe in `packaging/arch`. Download the package from the
[Releases](https://github.com/crynta/terax-ai/releases/latest) page (the upstream project's page
until this fork publishes its own release channel) and install it with your distribution's package
tool. The app checks for a stable update in the background and never downloads, installs or restarts
itself: updates are installed with your package tool (pacman/AUR on Arch, apt/dnf for the DEB/RPM
packages).

### Linux notes

- **Fedora (primary target):** `sudo dnf install ./terax-workspace-*.x86_64.rpm`. Fedora 44 KDE
  Plasma on Wayland is the primary validation target for the application; the *packaged*
  install/upgrade path is not validated yet (ticket #43).
- **Debian:** `sudo apt install ./terax-workspace_*_amd64.deb`. Debian 13 still needs an actual
  graphical WebKitGTK session before support is claimed (ticket #43).
- **Arch / AUR:** `packaging/arch/PKGBUILD` builds the same source and version. It is **authored,
  not built**: no `makepkg` run is recorded yet, so Arch support is a dated clean-environment
  validation still to be done, not a claim.
- On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`.

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

Terax is licensed under the Apache-2.0 License. For more information on our dependencies, see [Apache License 2.0](LICENSE).

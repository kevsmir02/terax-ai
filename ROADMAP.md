# Roadmap

Terax direction, what's shipped, what's coming, and what's deliberately out of scope.

This file is updated as direction evolves. For day-to-day work, see [GitHub Issues](https://github.com/crynta/terax-ai/issues) and the Projects board.

> **Fork note.** This file is upstream Terax's roadmap, kept for context. This fork distributes
> **Linux x86-64 only**, ships **no built-in AI surface**, and updates through the distribution's
> package tool. Sections marked *upstream only* describe upstream's product, not this build — see
> the [README](README.md#platform-support) for what this build actually supports.

## What Terax is

Terax is a fast, lightweight, terminal-first workspace for external coding agents. It pairs a native PTY backend with a modern UI: multi-tab terminals, an integrated code editor, a file explorer, source control, and rendered Markdown and web previews. Agents are CLI processes the person launches in a tab; the application embeds no model, stores no credential and does not drive an agent's process. About 7-8 MB on disk. No telemetry, no account.

The product is opinionated: terminal-first, agent-compatible without hosting an agent, lightweight always.

## What Terax is not

- Not an IDE clone. Terax selectively integrates high-value editor capabilities such as formatting, source control, and previews without adopting the heavyweight runtime and always-on background services of a traditional IDE.
- Not a browser. Web preview exists for local dev servers and lightweight doc viewing only.
- Not a general workspace. Tools and formats that pull the product away from the terminal-first surface are out of scope.
- Not a one-size-fits-all CLI replacement. The goal is the best terminal-first development workspace, not a shell with extras.

## Themes

The themes below frame every scope decision.

1. **Agents are external.** A coding agent is a CLI the person runs in a tab; the workspace keeps the terminal, files, diffs and previews around it instead of embedding a model.
2. **Lightweight always.** 7-8 MB binary. Every dependency justified. Per-tab memory budget enforced.
3. **Terminal-first.** xterm.js correctness, PTY fidelity, TUI app compatibility are non-negotiable.
4. **Cross-platform parity.** macOS, Linux, Windows, WSL. No platform-specific exclusives.
5. **Security by default.** Path guards, SSRF protection, OSC trust, IPC sandboxing. Defaults safe out of the box.

## Shipped

### Terminal

- [x] Multi-tab terminal with WebGL renderer
- [x] Native PTY backend (zsh, bash, pwsh, fish, cmd)
- [x] Split panes
- [x] Shell integration (cwd, prompt markers)
- [x] Inline search, link detection, true-color
- [x] Drag and drop files into terminal panes as shell-safe quoted paths
- [x] WSL bridge as workspace environment
- [x] Spaces with restored tabs, working directories, and split-pane layouts

### Editor

- [x] Multi-language support (TypeScript / JavaScript, Rust, Python, HTML / CSS, JSON, Markdown, Go, C / C++ / Java / C#, PHP)
- [ ] Inline AI autocomplete (including local-model support) and AI edit diffs — upstream only,
      **removed in this fork** with the built-in AI stack (tickets #12/#14)
- [x] Opt-in LSP support with diagnostics, navigation, completion, formatting, and custom servers
- [x] Vim mode

### Themes and Customization

- [x] Prebuilt and custom app and terminal themes with import and sharing
- [x] Background images with adjustable opacity and blur
- [x] App-theme-aware and independently selectable editor themes

### File Explorer

- [x] Icon theme with full file-type coverage
- [x] Fuzzy search, keyboard navigation, inline rename, context actions
- [x] Live filesystem updates in the explorer and open editor tabs

### Git / Source Control

- [x] Source control panel (stage, commit, branch)
- [x] Git history with commit graph
- [x] Per-file diffs

### Agents

- [x] Launch any terminal coding agent in a tab, pane or 1-4 pane group; the workspace records
      the command, not the conversation
- [x] Agent-aware tabs: process status from the PTY, structured events from hook-backed agents
- [x] Attention and completion notifications (native when unfocused, in-app otherwise; no prompt
      or transcript excerpts, no focus stealing)
- [x] Opt-in agent hooks: the exact configuration change is reviewed before it is written, and
      only this fork's entries are added or removed
- **Removed in this fork** (upstream only): the built-in AI stack — providers, credential
  storage, conversation sessions, prompt snippets, project memory, sub-agents and
  approval-gated tool execution. Client surfaces went in ticket #12, the native provider,
  transport and agent-process surfaces in ticket #14.

### Previews

- [x] Auto-detected local dev server preview
- [x] Image, video, audio, and PDF viewers
- [x] Rendered Markdown preview with raw and rendered views
- [x] Sandboxed iframe

### Platform Integration

- [x] Linux x86-64 (.deb / .rpm) — the only platform this fork builds and distributes
- [ ] macOS, Windows (NSIS), WSL, AppImage and Nix: **removed in this fork** (ticket #34); upstream
      Terax still ships them, and the shared source seams stay only so upstream imports keep
      compiling
- [x] AUR (Arch) — upstream only; this fork carries an authored, unbuilt recipe in
      `packaging/arch`
- [x] Windows Explorer context-menu integration — upstream only
- [x] Auto-updater — upstream only; this fork never downloads, installs or restarts itself and
      upgrades through the distribution's package tool
- [x] No telemetry

### Security

- [x] SSRF and DNS rebinding defenses on outbound HTTP
- [x] Trust gating in terminal escape-sequence handling
- [x] Sandboxed preview surface

### Engineering

- [x] Regression coverage across critical PTY, security, editor, explorer, theme, and native-boundary behavior
- [x] Enforced startup and total client bundle budgets with heavy editor, Markdown, and source-control surfaces loaded on demand

## Planned

### Coming next

- [ ] SSH support (PTY auth and known_hosts first; SFTP and port forwarding later)
- [ ] Inline terminal auto-suggestions (history-based)
- [ ] External-agent workspace workflow: reopen an agent's worktree, jump to the file it changed,
      review its diff in the source-control panel. Tool execution, context management and
      recovery belong to the agent, not to this workspace.
- [ ] Hook integration for more external coding agents (the launch path already takes any CLI
      command; hooks are what makes a tab agent-aware)
- [ ] Complete, extensible slash-command and reusable skills system
- [ ] Agent-hook review improvements (project-scoped policies, per-event trust)
- [ ] Persistent terminal processes across app restarts

### Longer horizon

- [ ] Selective TS → Rust migration where the profiler shows measurable wins

## Wanted contributions

Strategic areas where help is welcome. Pick something and propose an approach in Discord or via an issue first.

- **Regression tests.** Add focused coverage for bug fixes and critical PTY, security, editor, and native-boundary invariants.
- **Measured performance work.** Profile first and propose focused changes that preserve startup time, bundle size, memory use, and hot-path latency.
- **Platform-specific bugs.** Rendering issues on niche distros, shell quirks, WSL edge cases.
- **Documentation and translations.** Improvements, screenshots, examples, non-English README sections.
- **Themes.** Terminal and editor themes, UI accent palettes that fit the lightweight aesthetic.

See `good-first-issue` and `help-wanted` labels on GitHub Issues for concrete tasks.

## Out of scope

Categories that will not be built into Terax. Individual feature requests in these categories will be closed.

- **Heavyweight IDE infrastructure.** Integrated debugger and profiler suites, unbounded background indexing, and always-resident extension hosts are out of scope. Focused LSP, autocomplete, formatting, and editor workflows remain in scope when they are opt-in, lazy, and resource-bounded.
- **Notebook and document workspaces.** Anything that turns Terax into a document host rather than a terminal.
- **Package manager and toolchain UIs.** Use `npm`, `pip`, `cargo` and friends in the terminal directly.
- **Full web browser features.** Preview pane stays scoped to local dev servers and lightweight doc viewing. No navigation history, no bookmarks, no dev tools. Sandbox and WebView cookie policies can prevent cookie-based sign-in, so preview offers an external browser fallback instead of relaxing its security boundary.
- **Telemetry, analytics, accounts.** Terax stays local and offline-respectful.
- **Extension marketplaces at IDE scale.** Narrowly-scoped skill bundles may happen eventually. Arbitrary UI or behavior extensions will not.
- **Third-party subscription session bridges.** Forwarding cloud subscription auth (provider-managed login sessions) through Terax is not technically feasible for third-party clients.

## Decision authority

Direction and scope decisions are made by [@crynta](https://github.com/crynta). Trusted reviewers (informal, no fixed roles yet) provide input on security, performance, and platform-specific areas.

If a PR is closed and you disagree, raise it in Discord. Happy to discuss, not happy to be ambushed in a PR comment thread.

This will likely formalize over time as the project grows.

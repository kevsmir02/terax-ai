# Personal Linux workspace scope

Exploratory scope recorded on November 11, 2026. This is the original scope
record, not proof that every recommendation was approved at the time. The
subsequent [design interview](personal-workspace-interview.md) records the
explicitly accepted decisions, additions, qualifications and validation gates.
Where the records differ, use the interview decisions. Neither document is an
implementation spec or evidence of completed work. Product naming remains open.

## Purpose

A lightweight workspace for terminal AI agents, project files, text editing,
and file previews. External agents run independently of the application's
built-in AI features, which will be removed.

## Preserve

- Ghostty-based terminal, tabs, splits, search, clipboard, and shell integration.
- External CLI agent launching, status, notifications, and CLI/control integration.
- Spaces with separate project roots, saved tabs, and layouts.
- File management and CodeMirror editing, syntax highlighting, and find/replace.
- All Git functionality, including diffs, history, worktrees, and checkpoints.
- Themes and customization, with room for future expansion.
- Web/dev-server preview, block terminal mode, external formatters, Vim mode,
  and other optional features not explicitly selected for removal.
- GitHub Actions checks, Linux builds, release publishing, and update support.

## Remove

- Built-in AI chat, provider/model configuration, API-key management, tools,
  subagents, and conversation storage.
- AI editor completion, AI edit review, and Ask AI actions.
- Voice recording and transcription.
- Built-in AI supervision of external terminal agents.
- Language-server integration; retain basic editor functionality.
- Windows, macOS, WSL, and Nix distribution/build support.
- Settings and dependencies used exclusively by removed features.

Shared infrastructure currently located under AI modules must be relocated
or replaced before removal. Preserve file-access checks, native-command
wrappers, Markdown rendering, external agent hooks, and any retained consumers.

## Initial platform and release boundaries

- Linux x86-64 only initially; Fedora is the primary validation target.
- Target RPM for Fedora, DEB for Debian, and an Arch package recipe.
- Stable releases only initially. CI validates changes; version tags trigger
  release publishing.
- Check for updates automatically, asking before downloading or installing.
- RPM/DEB installations offer in-app updating, subject to distribution testing.
  Arch installations update through package tooling.
- Never automatically restart or interrupt running agents to install updates.
- Use a separate application identifier, configuration storage, release
  endpoint, and signing keys. Do not silently import or overwrite upstream data.
- Final product name, repository release URL, and signing setup remain pending.

Remove non-Linux workflows and packaging first. Remove platform-specific
internals selectively, considering both Linux simplification and the cost of
bringing in future upstream fixes.

## Preview coverage

- First version: rendered Markdown, PDF, images, audio/video, and text/code.
- Office document and spreadsheet rendering are deferred. CSV/TSV remain
  editable as text; a dedicated table viewer is not part of the initial scope.
- Validate PDF viewing on Fedora early. If iframe-based viewing is unreliable,
  use a dedicated viewer loaded only when needed.
- Supported image/media codecs must be verified on the target distributions;
  recognizing a file extension alone is not proof of playback support.

## Lifecycle and performance

- Load optional editors and viewers on demand.
- Bound document reads and preview memory; retain sensible large-file limits.
- Pause unnecessary rendering, playback, and background work for hidden tabs.
- Release document data, media handles, and rendering resources when closed.
- Switching Spaces preserves running agents. Hidden terminal models continue
  processing output while presentation work is paused; attention notifications
  remain available.
- Prompt before closing a Space with running processes.
- Reopening the app restores tabs and layout, not live processes from the
  previous run. Persistent agent sessions across app restarts are deferred.
- Agent hooks are opt-in per agent, explain their configuration changes, and
  support removing only this application's own entries. Normal launching must
  not depend on installing hooks.

## Maintenance and validation

- Keep an upstream Terax remote and review/selectively import relevant fixes.
- Avoid unrelated rewrites and preserve clear subsystem boundaries.
- Automate JavaScript, Rust, and GitHub Actions dependency PRs, with a separate
  check for the pinned Ghostty source revision.
- Keep lockfiles and pinned toolchains. Update through reviewed changes that
  pass checks before merging.
- Preserve linting, type checks, frontend/Rust tests, terminal compatibility
  and soak tests, Linux package builds, bundle budgets, and resource checks.
- Measure startup, memory, and package-size effects instead of assuming that
  removing an already lazy-loaded feature reduces idle memory.
- Implement in stages, preserving a working Linux build between stages.

## Implementation notes

Feature removal and release reconfiguration have not started. The interview
closed with shared understanding confirmed; see its record for accepted decisions
and explicit deferrals. Confirmation did not request a spec, tickets or implementation.
Other optional removal candidates remain on watch; no removal has been authorized
for them.

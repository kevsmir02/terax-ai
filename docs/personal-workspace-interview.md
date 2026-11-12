# Personal workspace design interview

Interview opened and closed November 11, 2026. This is a decision record, not a spec or implementation authorization. Recommendations in Q1-Q48 were explicitly accepted in four rounds, and the user confirmed shared understanding at Q49: "Yes. Confirmation closes the interview only." The earlier personal-workspace-scope.md is exploratory context, and this record supplies the examined decisions and qualifications.

## Established boundaries

The user explicitly retains terminal capabilities, external-agent integration, Spaces, file management, basic editing, all Git functionality, and customization. Built-in AI, AI editing features, voice, AI supervision, language servers, and non-Linux build/distribution support are selected for removal. Other removal candidates require discussion.

Initial previews cover Markdown, PDF, images, audio/video, and text/code. Office rendering is deferred; CSV/TSV remain text. Initial platform boundaries are Linux x86-64, Fedora first, RPM/DEB and an Arch recipe, stable tagged releases, checked dependency PRs, automatic update checks with installation approval, and layout restoration without persistent processes across restarts. RPM/DEB in-app installation remains subject to validation.

## Design tree

- Purpose and tradeoffs: accepted in Q1-Q7.
- Agent boundary: independent installation, capability-specific support and terminal permissions accepted in Q7-Q9 and Q33; new structured adapters bounded/deferred in Q47.
- Spaces: organization, shared roots, background work and destructive-action guards accepted in Q10-Q13 and Q22; shutdown escalation settled in Q39.
- Files: conflict choices and opt-in draft recovery accepted in Q14 and Q23-Q24; recovery limits, retention and changed-target behavior settled in Q37-Q38.
- Git: usable worktree/checkpoint controls, manual checkpoints and explicit mutation accepted in Q15 and Q21-Q25; staging effects, restore concurrency and retention settled in Q35-Q36.
- Previews: reading functions, bounded resources, no automatic remote document fetches and codec evidence accepted in Q16 and Q27-Q29; stable asset boundaries and immediate hidden-web teardown settled in Q40-Q41. Exact tested codecs and renderer choice are validation-dependent, not claims of present support.
- Resource envelope: provisional workload and measurement-first budgets accepted in Q17; evidence-based numeric budget approval and release gates accepted in Q42.
- Distribution: separate identity, safe update timing, package-tool preference and Arch handoff accepted in Q18-Q20 and Q31-Q32; trust/recovery, failure behavior and validation environments settled in Q43-Q45. Operational publication inputs explicitly deferred in Q48.
- Maintenance: selective upstream imports and retained customization accepted in Q5 and Q34; monthly review, prompt security triage, exact pins and Ghostty gates accepted in Q46.

The tree expands only when an answer or finding exposes another decision. Explicit deferrals must have a boundary and a prerequisite; they do not silently imply a feature commitment.

## Round 1: recommendations accepted

The user instructed: "Use your recommendation to answer the questions." All seven recommendations below are accepted. This does not supply a real task example, workload counts, a maintenance time allowance, or a daily agent list. Those facts remain unknown; any proposed benchmark is a design assumption, not observed usage.

1. Primary payoff: adopt the fork to reduce daily friction and remove unwanted product complexity, while measuring resource effects rather than presuming them?
2. Representative workflow: use launch agents, switch projects, inspect Git changes, edit files, preview outputs, then commit as the central workflow; what real recent task exposes missing steps?
3. Conflict priority: data/process safety, terminal correctness, useful review/editing, resource efficiency, then convenience/polish, while preserving all explicit keep requirements?
4. Workload: use actual routine and heavy-day concurrency/file sizes to define the performance envelope; what are those workloads?
5. Maintenance: selectively import upstream fixes and preserve compatible internals where useful; what ongoing maintenance time can the user sustain?
6. Public promise: personal-use-first, best-effort public support without a broad compatibility commitment, while retaining requested package formats?
7. Agent contract: launch installed tools unchanged, add integration separately per tool, and avoid making hooks mandatory; which tools are daily requirements and what app-level controls are essential?

## Decisions and evidence

Space, external agent, and built-in AI have initial glossary definitions grounded in explicit user context. Accepted boundary and maintenance tradeoffs are recorded in ADRs 0001 and 0002.

### Verified source findings

- Agent launch entries cover Claude, Codex, Gemini, Pi, OpenCode and Grok; Antigravity has no entry. Hook support varies. Checkout support is not proof of compatibility with current vendor releases (`src/modules/agents/lib/launcher.ts`, `src-tauri/src/modules/agent.rs`).
- Structured permission decisions have backend support, but `connectAgentEvents` has no production caller. Notifications still use legacy signals. Built-in review is called from the retained notifications bridge and must be separated (`src/modules/agents/components/AgentNotificationsBridge.tsx`).
- Space switching retains tabs. Space deletion bypasses normal dirty-buffer/foreground-process guards (`src/app/App.tsx:1205`).
- Ordinary editor reads/writes differ from AI path policy; preserving preview safeguards must not inadvertently prohibit explicit configuration-file editing (`src-tauri/src/modules/fs/file.rs`, `fs/read_policy.rs`).
- PDF uses an iframe (`src/modules/editor/EditorPane.tsx:613`). Fedora reliability has not been established in the actual Tauri application.
- Asset range requests are capped, but a non-range request can allocate an entire file (`src-tauri/src/modules/fs/assets.rs:223`). Decoded image/PDF memory needs separate bounds.
- Worktree creation/removal and checkpoint APIs exist without discovered UI callers. Checkpoints omit ignored files, staging state, and submodule contents; they are not full backups (`src/modules/git/api.ts`, `src-tauri/src/modules/git/checkpoint.rs`).
- Active Ghostty uses the adapted bridge compiled against pinned official source, with SIMD/scalar artifacts. The official-ABI path is separate evaluation code (`packages/ghostty-core/adapted/UPSTREAM.md`).
- The locked updater 2.14.0 has DEB/RPM installation code invoking privileged dpkg/rpm, whereas Terax currently bypasses plugin updates on Linux. Direct installation and dependency-resolving package transactions have different failure behavior. Source: https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.14.0/plugins/updater/src/updater.rs#L1111
- Release tags currently produce drafts without a CI dependency/tag-version gate. Rust and Node are not exactly pinned. Some useful terminal visual coverage is macOS-only and needs replacement when platform workflows are removed.
- GitHub's supported Dependabot ecosystems do not include Zig; source-pin monitoring remains separate. Source: https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories

These findings are source inspection, not package, codec, updater, or multi-day runtime validation.

## Round 2: recommendations accepted

The user accepted all recommendations in Q8-Q20. Permission approval remains in agent terminals for version one; this defers a new centralized approval UI, not existing control infrastructure. Usable worktree/checkpoint controls and PDF search/selection/navigation/zoom are acknowledged completion work. Other accepted recommendations are recorded below.

8. Keep version-one permissions in each agent's terminal; retain existing control infrastructure without requiring a new centralized permission UI?
9. Make hooks opt-in per agent, preview external configuration changes, and remove only fork-owned entries?
10. Keep inactive-Space processes running and route attention notifications without automatically switching Spaces?
11. Distinguish switching, closing tabs, and deleting saved Space organization; guard destructive actions for running work and unsaved buffers?
12. Allow distinct Spaces to reference the same checkout, with an explicit shared-folder indication and no implied isolation?
13. Permit deliberate opening/editing of accessible files outside a project root while retaining separate checks for automatically loaded preview resources?
14. Preserve dirty buffers on external changes; refresh clean buffers when visible and require an explicit conflict choice before overwriting changed disk contents?
15. Make preserved worktree/checkpoint capabilities usable through modest UI, accepting that this is completion work beyond feature removal?
16. Treat previews as readers: PDF navigation/search/selection/zoom, basic image viewing, and basic media playback, with authoring/annotation outside the initial preview contract?
17. Start performance evaluation with a provisional two-Space/four-terminal/two-busy-agent workload, plus a stress workload, then set numeric budgets from baseline evidence?
18. Use a distinct app/storage/hook identity, update endpoint and signing keys, with no automatic upstream data migration?
19. Defer installation while running work or unsaved buffers remain, then require explicit install approval; never automatically relaunch?
20. Gate tagged stable publication on checks, version agreement, signature verification, and distro install/upgrade smoke evidence, with Fedora as the primary interactive validation target?

### Agent compatibility evidence

Read-only checks found OpenCode 2.2.6, Claude Code 2.1.319, Codex CLI 0.167.0-alpha.3.2, and Antigravity CLI `agy` 1.5.5. The separate `antigravity` executable is a GUI. These are installed-version observations, not compatibility certifications or a statement of user preference.

- Claude has lifecycle, notification and permission hooks: https://code.claude.com/docs/en/hooks
- Codex hooks require explicit trust of their definitions through `/hooks`; its permission response differs from Claude's: https://learn.chatgpt.com/docs/hooks
- OpenCode V2 has plugin/server integration surfaces despite Terax lacking an adapter: https://opencode.ai/docs/build/plugins/ and https://opencode.ai/docs/build/plugins/server
- Antigravity CLI hooks have a different payload/event contract from the existing Gemini integration: https://antigravity.google/docs/overview?tab=cli and https://antigravity.google/docs/hooks?tab=cli

No hook installation, event delivery, or permission round trip was executed.

## Round 3: recommendations accepted

The user accepted all recommendations in Q21-Q34. This explicitly adds manual checkpoint controls, worktree-to-Space affordances, richer file-conflict choices, opt-in draft recovery, guarded quit, resource/codec error handling, and `agy` launch/basic-status support to the intended work. None has been implemented. Recovery excludes sensitive files by policy and never restores live processes or reruns commands. Package-tool handoff is an accepted fallback if privileged RPM/DEB integration cannot be validated.

21. Use manual named checkpoints initially, without automatic per-agent-turn snapshots, while preserving existing checkpoint capability?
22. Make each newly created worktree easy to open as a separate Space, without moving running terminals or deleting worktrees when Spaces are deleted?
23. Offer compare, save elsewhere, reload/discard, and explicit overwrite for file conflicts, with a final changed-on-disk check before saving?
24. Offer opt-in bounded local recovery of unsaved buffers, with sensitive-file exclusions and explicit storage disclosure, while restoring no live processes and never automatically rerunning agent commands?
25. Keep normal commit/push explicitly user initiated; confirm destructive Git/worktree/checkpoint operations with concrete affected paths and blockers?
26. On app quit, summarize running work and unsaved buffers, allow cancellation, and require deliberate resolution; do not equate window hiding with process persistence?
27. Disable automatic remote-content fetching in file previews, confirm external navigation, and treat preview content as non-executable?
28. Enforce document and decoded-resource limits with clear explanations and safe alternatives; allow larger reads only within hard safety ceilings?
29. Define tested image/media formats and report unsupported codecs clearly, without automatically installing codecs or promising every recognized extension?
30. Default notifications to agent/Space identity and attention/completion, with no prompt, file-content or transcript snippets, no focus stealing, and sound off?
31. Prefer dependency-resolving package tooling for approved RPM/DEB upgrades; if validated privileged integration is unavailable, show a package-tool handoff rather than silently using raw dpkg/rpm?
32. Keep Arch upgrades package-tool managed; the in-app checker reports availability without invoking a privileged install?
33. Validate launch/basic process behavior for OpenCode, Claude, Codex and terminal `agy`; keep richer adapters capability-specific and make Antigravity CLI baseline support explicit additional work?
34. Preserve existing customization and watch-list features, while excluding new arbitrary-code plugin execution or a customization-system rewrite from version one?

The branches identified after Round 3 were examined in Round 4 below. No numerical memory or startup budget is claimed before baseline measurement.

### Follow-up evidence

- Current checkpoint prune removes the calling worktree's whole task, including prerestore safety refs; deleting refs does not guarantee immediate disk reclamation (`src-tauri/src/modules/git/checkpoint.rs:863`). Snapshot creation parents HEAD, not the preceding checkpoint. Single-ref deletion and retention accounting would be new work.
- Restore can reset touched index entries to HEAD. A safety snapshot preserves captured file contents, not prior staging state; staging-only changes can bypass the current changed-tree refusal (`checkpoint.rs:1115,1177,1259,1319`).
- Markdown assets currently derive a boundary from terminal cwd, not consistently the configured Space root. Native canonical containment checks prevent symlink escape from directory grants (`src/modules/markdown/MarkdownStack.tsx:12`, `src-tauri/src/modules/fs/assets.rs:175`).
- No durable editor draft recovery exists; optional autosave changes the original file. Layout persistence stores paths, not unsaved text (`src/modules/spaces/lib/serialize.ts:80`).
- Primary observed environment is Fedora 44 KDE Plasma on Wayland, x86-64. DEB/Arch runtime validation remains absent. Debian 13 stable is verified from https://www.debian.org/releases/ .
- Web preview currently permits arbitrary HTTP(S) starting URLs and is an ordinary sandboxed iframe without a native command bridge. Subsequent redirects are not covered by initial URL validation. After 30 seconds hidden it tears down and later reloads; hiding alone does not prove script/media/network suspension (`src/modules/preview/PreviewPane.tsx:37,158`, `lib/previewUrl.ts:7`).

## Round 4: recommendations accepted

The user accepted all recommendations in Q35-Q48. This includes immediate hidden-web-preview teardown and its loss of transient page state, checkpoint retention until explicit deletion, staged/unsaved-change guards on restore, opt-in recovery limits, and operational publication inputs remaining deferred. These are future requirements, not descriptions of working behavior.

35. Refuse checkpoint restore while an app-owned process is writing or affected files have staged/unsaved changes; require resolution first, disclose external concurrency and partial-restore limitations, and never describe safety snapshots as full Git-state undo?
36. Keep manual checkpoints until explicit deletion, expose grouped cleanup and safety refs separately, bound snapshot creation, and avoid automatic Git GC or misleading promises of exact reclaimed bytes?
37. Start opt-in draft recovery at 10 MiB per file and 100 MiB total, pause with a warning rather than silently evicting unrecovered drafts, delete drafts after explicit save/discard, and exclude known secret paths by default without claiming perfect secret detection?
38. Treat recovered drafts with missing/changed target files as recovery documents requiring compare/save-as, never automatic recreation or overwrite?
39. On confirmed shutdown, attempt graceful termination, then ask before force-killing nonexiting app-owned work; preserve cancel and do not claim control over deliberately detached external services?
40. Anchor embedded local-document resources to the configured Space root, or document directory for an outside file, with native canonical/symlink checks and explicit grants for outside assets?
41. Preserve explicitly entered HTTP(S) web previews as untrusted web content, but unload them immediately when hidden to enforce resource/media behavior, accepting reload and transient-state loss?
42. Treat exact document/decoded-memory ceilings and performance budgets as measured pre-release gates; preserve current text limits as the starting baseline and require approval of evidenced budgets before claiming lightweight completion?
43. Validate Fedora 44 KDE Wayland as primary, Debian 13 x86-64 in a real graphical session, and a dated Arch environment; other desktops/releases remain best-effort until tested?
44. Sign/verifiably authenticate release artifacts independently of upstream, keep signing secrets outside the repository with offline recovery, and block installation on verification failure; defer managed package repositories initially?
45. Make update checks bounded and nonblocking, handle offline/rate-limit/cancel/package-lock failures without interrupting work, and require explicit recovery for a failed package transaction rather than automatic rollback?
46. Use a monthly upstream/dependency review plus prompt security-fix triage, exact toolchain pins and reproducibility checks, with Ghostty bridge changes gated by rebuild and compatibility/resource evidence?
47. Bound new agent work initially to `agy` launch/basic status and retained integrations; defer new OpenCode/Antigravity structured adapters and centralized permission UI while preserving capability-specific notifications/control?
48. Keep product name, release owner/URL and key provisioning as explicit pre-publication decisions; permit design completion with those operational inputs unresolved, without publishing or guessing them?

## Confirmed shared understanding

The fork is a personal-use-first Linux workspace built around independent terminal agents, with files, basic editing, Git and reading previews available together. It does not supply built-in AI supervision, per-Space sandboxing, or live-process persistence across app restarts. All explicit retained features remain; only selected removals are authorized as product scope. Architecture and resource effects must be evidenced rather than inferred from module names or platform deletion.

### Deliberately accepted completion work

This direction is more than removing features. It includes usable worktree/checkpoint controls; manual checkpoint labels and cleanup that distinguish restore-safety refs; richer file-conflict choices and restore guards; opt-in bounded recovery drafts; Space/tab/quit lifecycle safeguards; PDF navigation/search/selection/zoom; bounded and diagnosable previews; `agy` launch/basic status; independent identity and release trust; and stronger Linux validation and update behavior. These costs are accepted for the intended version, not silently deferred by calling them optional.

The implementation may be staged while keeping Linux working. A stage is not evidence that the full agreed version is complete. Any later scope reduction or deferral of these accepted capabilities returns to the user; current optional features on watch are preserved.

### Explicit deferrals and validation gates

| Item | Accepted boundary or next prerequisite |
| --- | --- |
| Name, owner/release URL and keys | Explicit pre-publication choices; no upstream identity reuse or publication while unresolved. |
| In-app RPM/DEB installation | Use dependency-resolving package tooling only after privilege, cancellation, dependencies, package locks, authenticity, upgrade and live-work behavior pass validation. Otherwise provide the accepted explicit package-tool handoff. |
| PDF mechanism | Actual Fedora application must satisfy reader functions and resource behavior. Retain iframe only if it meets that contract; otherwise use an on-demand dedicated viewer. No iframe reliability claim is accepted from source inspection. |
| Image/media format list | Test actual formats/codecs in supported package environments, document results and failures; do not replace the selected preview categories with extension-only promises. |
| Resource ceilings and budgets | Measure startup, whole-app processes, idle/streaming/hidden/close cycles and package size; separate external-agent resource use. Propose concrete thresholds for user approval before claiming lightweight completion. Current text limits are 10 MiB normally, explicit override to 50 MiB, syntax features off above 4 MiB. |
| New structured agent adapters | Deferred for OpenCode/Antigravity; retain existing per-agent integrations subject to testing. `agy` launching/basic status is included. No centralized approval UI in version one. |
| Existing terminal visual coverage | Relocate useful non-Linux-only test coverage to the Linux validation strategy before dropping its old workflow; preserve compatibility/soak/bundle/resource evidence. |
| Package support claims | Fedora 44 KDE Wayland is primary; Debian 13 graphical and dated Arch environments require package/runtime evidence. Other desktops/releases are best-effort. |
| Key loss/compromise and failed package transactions | Document explicit recovery; never bypass authenticity checks or promise automatic rollback. |
| Office/table authoring and rendering | Office previews later; CSV/TSV are editable text. No dedicated table preview in the initial version. |
| Process persistence | Restore layout/cwd/file locations, never automatically rerun previous commands or restore live processes. Independent CLI resume features remain the agent's responsibility. |
| Future customization | Existing features preserved; no version-one plugin-execution framework or broad rewrite. |

Actual workload counts, maintenance hours, and a real task example remain unknown. The user accepted a provisional benchmark and maintenance policy instead; these must not be represented as observed habits. No agents were launched, hooks installed, settings changed, secrets provisioned, packages installed, remotes modified, or release artifacts published. Inspection of installed versions and source is not end-to-end runtime validation.

### Final checkpoint

Q49: Does the consolidated understanding, including accepted completion work, explicit deferrals and evidence gates, accurately represent the intended direction? Recommendation: yes. Confirmation closes the design interview only; it does not by itself request a spec, tickets, implementation or publication.

Accepted: "Yes. Confirmation closes the interview only." The interview is closed. Its product decisions and explicit deferrals are recorded; validation and publication prerequisites remain outstanding as described above. No spec, tickets, implementation or publication is authorized by this confirmation.

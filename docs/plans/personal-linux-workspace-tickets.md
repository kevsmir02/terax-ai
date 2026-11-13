# Personal Linux workspace ticket breakdown

Approved for ticket publication, November 12, 2026. Publication is complete and verified. See the [published ticket index](personal-linux-workspace-published.md). The parent spec content/status is preserved; only its native sub-issue relationships are being attached. Implementation is explicitly held.

Source: [spec #1](https://github.com/kevsmir02/terax-ai/issues/1), approved challenge revision `877681b8a0130e8fb8a959c0d71fe7ffe82f6b9ec220da24f4e3ba8fc214fb31`.

The approved breakdown has 44 bounded tickets. Prefactoring uses expand, retained-consumer migration and final contraction; infrastructure, evidence and maintainer-input tickets are explicit standalone prerequisites. Product slices deliver observable behavior across applicable UI/native/persistence/test layers.

## Blocking and readiness policy

Native GitHub blocking edges control the execution frontier. A fully specified code ticket may carry `ready-for-agent` while still waiting for another code ticket; it may start only when all native blockers are closed. Tickets 03, 37, 39, 42, 43 and 44 withhold that label while their human/operational inputs or evidence are missing. Evidence-gathering work and release acceptance are separate from unrelated code changes. Ticket 03 gates new bounded-viewer completion; final whole-app resource acceptance does not gate unrelated feature implementation.

All source inspection and baseline experiments remain isolated until ticket 07 proves complete namespace separation. Final branding/keys gate product publication, not those isolated experiments. Tickets were published as approved child issues in dependency order with native blocking edges. Every ticket carries an explicit execution hold; no assignment, implementation dispatch, code change or product publication is authorized. Do not edit or close the parent spec.

## Common acceptance carried into applicable tickets

- Preserve the parent spec's explicit retained scope and exclusions; no feature-on-watch removal or new deferred feature is introduced.
- Use the applicable already-approved real-app, native-command or packaged-app seam; assert observable success/refusal/recovery and keep applicable repository checks green.
- Run only isolated profiles until namespace isolation is complete; never mutate upstream/user credentials, settings or projects in tests.
- Record evidence and distinguish Planned implementation from validated support; never claim a release-only gate is already satisfied.

## Proposed tickets

### 01. Run an isolated Linux real-app smoke workflow

**Blocked by:** None (can start immediately).

**What it delivers:** Launch the real Linux Tauri app in a disposable profile and drive a terminal-to-file workflow through the agreed acceptance seam.

**Stories:** 7, 8, 95, 99.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Adapt the existing app-lab/PTY-smoke approach for Linux rather than introducing a separate product API for each feature.
- [ ] Use a disposable application identity/profile and temporary projects; reject unsafe runs against the installed product profile.
- [ ] Demonstrate shell spawn, input/output exactness, tab/split actions, file opening and structured pass/fail reports in the actual WebKitGTK app.
- [ ] Record build/runtime prerequisites and the host software/display stack; no real agent configuration, credentials or user project is modified.
- [ ] Retain existing frontend/native checks and prove the runner can execute one passing scenario and one intentional refusal/failure.

### 02. Record the reproducible Linux resource baseline

**Blocked by:** 01.

**What it delivers:** Produce comparable reports for the unmodified application and the accepted representative and stress workloads.

**Stories:** 80, 81.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Measure the identified source revision with recorded toolchains, hardware, scale, fonts and fixtures in isolated profiles.
- [ ] Cover cold/warm startup, idle and streaming terminals, two Spaces/four panes/two synthetic busy agents, text files and an active preview.
- [ ] Record whole-app process memory/CPU, hidden/show/close cycles and package size; separate external workload processes and avoid shared-memory double counting.
- [ ] Include a larger stress workload and small document/media fixtures; report limitations instead of claiming untested PDF or codecs work.
- [ ] Save machine-readable results and a comparison procedure usable after feature removal; do not invent user usage counts.

### 03. Approve initial document and decoded-resource limits

**Blocked by:** 02.

**What it delivers:** Turn baseline evidence into explicit user-approved ceilings for bounded document/viewer behavior.

**Stories:** 70, 79, 81, 102.

**Readiness:** Awaiting human/operational inputs: Primary user must approve measured document/decoded-resource ceilings; agent evidence from ticket 2 is required.

- [ ] Propose file-read, decoded-image/PDF/media and simultaneous-viewer ceilings with evidence and documented refusal/override behavior.
- [ ] Retain the existing text starting limits: 10 MiB normally, explicit override to 50 MiB, syntax features off above 4 MiB.
- [ ] Obtain and record the primary user's approval of concrete values; distinguish storage quotas from runtime memory budgets.
- [ ] Do not infer a final whole-app startup/memory target from these viewer ceilings; final product budgets remain in ticket 42.
- [ ] Expose the approved policy as a consumable contract for dependent preview tickets.

### 04. Expand shared native file access and migrate retained consumers

**Blocked by:** None (can start immediately).

**What it delivers:** Keep Spaces, explorer, explicit editing and formatter command access working through neutral shared contracts before deleting AI owners.

**Stories:** 37, 41.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Add shared native-wrapper and file-policy ownership beside old entry points; migrate retained Spaces/explorer/file-command consumers without removing the old form yet.
- [ ] Preserve explicit user editing outside the project root, including legitimate configuration files, while retaining stricter automatic-preview checks.
- [ ] Preserve the shell-command functionality used by retained external formatters and CLI/control consumers.
- [ ] Keep existing checks green and demonstrate equivalent allow/deny behavior, including canonical-path/symlink cases at the existing native seam.
- [ ] Document remaining old consumers so later contract deletion can prove no retained caller is lost.

### 05. Migrate Markdown rendering out of built-in AI ownership

**Blocked by:** 04.

**What it delivers:** Render existing Markdown and fenced code without depending on ownership by the built-in AI feature.

**Stories:** 65, 71.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Move or compose shared Markdown/code rendering and access helpers under retained ownership while keeping compatibility entry points for unmigrated consumers.
- [ ] Preserve highlighting, editor-theme consistency, local image behavior, sanitization and the current lazy-loading boundary.
- [ ] Do not delete Streamdown or AI-named primitives solely because of their names when Markdown still needs them.
- [ ] Verify retained Markdown behavior and production import graphs without implementing new preview consent/lifecycle policy in this prefactor.
- [ ] Leave old entry points removable only after all migration consumers are accounted for.

### 06. Separate external-agent notifications and control from AI supervision

**Blocked by:** None (can start immediately).

**What it delivers:** External agents launch, signal attention and open files without invoking built-in AI review or supervision.

**Stories:** 9, 12, 16, 22, 23.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Detach built-in managed review/supervision from retained external-agent notifications, launching, CLI hooks and control routing.
- [ ] Preserve file opening to the caller's Space and supported line targeting, authenticated/bounded control access and hook-free ordinary launching.
- [ ] Keep existing per-agent adapters and permission fallback infrastructure without introducing a centralized approval UI.
- [ ] Keep any temporary old built-in notification path isolated until its later removal; migrate retained callers without a broken intermediate build.
- [ ] Use current launcher/router/control tests to prove attention still routes and no supervisory prompt is triggered.

### 07. Isolate every fork-owned runtime namespace

**Blocked by:** 01.

**What it delivers:** An ordinary developer or installed run can coexist with upstream without touching its settings or integration state.

**Stories:** 83, 84.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Inventory and isolate application/storage/cache, control descriptors, shell integration, hook ownership and other fork-owned persistent/runtime names; changing the Tauri ID alone is insufficient.
- [ ] Use a non-upstream working identity for development; final branding and release endpoints remain ticket 39 inputs.
- [ ] Do not silently read/import, overwrite or delete upstream settings, data, descriptors or hook groups.
- [ ] Keep isolated baseline profiles usable before ordinary-run isolation is complete.
- [ ] Run coexistence tests with upstream sentinel files/configuration and prove they remain unchanged.

### 08. Establish pinned Linux CI and build checks

**Blocked by:** 01.

**What it delivers:** Changes receive reproducible Linux lint/type/native/build checks before platform support is narrowed.

**Stories:** 85, 95, 99.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Pin exact toolchains and retain package-manager verification, lockfiles and locked dependency checks.
- [ ] Run applicable frontend lint/type/tests and Rust lint/tests plus startup/dependency/bundle checks in Linux CI.
- [ ] Integrate the Linux smoke runner and produce actionable failure artifacts without touching production profiles.
- [ ] Keep useful non-Linux-only coverage until ticket 32 provides its Linux replacement; do not drop it in this ticket.
- [ ] Do not configure unchecked auto-merges or publish release artifacts from ordinary CI.

### 09. Remove voice recording and transcription

**Blocked by:** 01.

**What it delivers:** The application has no recording/transcription actions, permissions or exclusively voice-related runtime costs.

**Stories:** 5.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Remove voice capture/composer/settings behavior and its exclusively associated native commands, permissions and dependencies.
- [ ] Keep remaining text composition and retained terminal/editor clipboard/input behavior working until their selected later changes.
- [ ] Verify no microphone/recording path or transcription request is exposed and no retained feature imports the removed voice code.
- [ ] Keep a working Linux build and relevant tests/import-budget checks.

### 10. Remove language servers while retaining useful basic editing

**Blocked by:** 01.

**What it delivers:** Configuration/code files remain editable with highlighting and find/replace without starting language-server services.

**Stories:** 6, 38, 39, 40.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Remove language-server activation/settings, status UI, clients, native process hosting and exclusively LSP dependencies.
- [ ] Preserve CodeMirror highlighting, language modes, find/replace, line-ending/indent detection, themes and existing Vim/formatter behavior.
- [ ] Exercise Markdown, plain text, JSON, YAML, TOML and representative code editing with no LSP process, PATH probe or eager LSP import.
- [ ] Preserve existing text-size behavior and core editing checks; do not remove generic editing support merely because it once served AI/LSP.

### 11. Remove built-in chat and composer product surfaces

**Blocked by:** 05, 06, 09.

**What it delivers:** The workspace opens and works without built-in chat, sessions, provider selection or built-in agent controls.

**Stories:** 4.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Remove chat/composer/session/provider-model settings and built-in agent UI/navigation while keeping external-agent controls and retained file/Markdown behavior.
- [ ] Replace unconditional root wiring without changing parent identity during startup or respawning live PTYs.
- [ ] Remove startup hydration/subscriptions for unused built-in conversations and AI sessions.
- [ ] Keep old backend forms only as temporary compatibility until ticket 13; do not touch upstream stored conversations or credentials.
- [ ] Verify terminal/file/Git workflows remain usable and built-in chat surfaces cannot be opened.

### 12. Remove AI editor review, completion and terminal actions

**Blocked by:** 01, 05.

**What it delivers:** Basic editing and terminal/Git review work without AI completion, AI diffs or Ask AI actions.

**Stories:** 5, 53, 82.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Remove inline AI completion, AI edit-review surfaces, AI-specific shortcuts/settings and editor/block-terminal Ask AI actions.
- [ ] Preserve ordinary Git diffs/history/hunk review, syntax highlighting, search, clipboard and block terminal functionality.
- [ ] Remove exclusive native/frontend callers without deleting shared rendering/native helpers migrated earlier.
- [ ] Verify removed actions are inaccessible and remaining editor/terminal shortcuts still route correctly.

### 13. Contract the unused built-in AI stack

**Blocked by:** 11, 12.

**What it delivers:** Unused provider, credential, conversation, tool and subagent code is absent while retained shared infrastructure still works.

**Stories:** 4, 5.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Prove retained callers have migrated before deleting old AI compatibility entry points and the closed unused feature subtree.
- [ ] Remove built-in providers/SDK use, API-key management, AI transport, conversations, AI tools/subagents and exclusively associated native registrations/settings/dependencies.
- [ ] Preserve Git/external-agent credentials, formatter command execution, file policies, Markdown, CLI/control and notification infrastructure.
- [ ] Do not delete or migrate upstream's stored state; update fork architecture/settings documentation to reflect the actual retained contracts.
- [ ] Keep Linux green and prove the production source/dependency graph contains no removed-feature import or orphan command requirement.

### 14. Save conflicting files safely across Spaces

**Blocked by:** 01, 04.

**What it delivers:** Two independently dirty buffers cannot both silently overwrite the same disk revision.

**Stories:** 38, 39, 40, 41, 42, 43, 44, 45.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Coordinate app-owned save/format writes by canonical file identity and validate expected disk revision inside native coordination.
- [ ] Detect changed contents even with identical mtime; missing/unreadable/replaced targets become conflict/error outcomes rather than unconditional recreation.
- [ ] Provide compare, Save As, reload/discard and explicit overwrite bound to the reviewed revision; subsequent changes invalidate consent.
- [ ] Preserve dirty buffers, line endings and indentation; clean hidden buffers defer unnecessary rereads until visible.
- [ ] Test two Spaces saving one baseline, same-timestamp changes, stale overwrite consent and newer typing during a pending save; keep external-writer limitations explicit.

### 15. Recover unsaved buffer revisions durably

**Blocked by:** 14.

**What it delivers:** Opt-in draft recovery restores each buffer's last durable revision after a crash without overwriting project files.

**Stories:** 46, 47, 48, 49, 50, 51.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Persist distinct stable buffer/file identities and revisions, including two Spaces with the same pathname.
- [ ] Enforce 10 MiB per file and 100 MiB total in disclosed private storage; exclude known sensitive paths, show unavailable/full/failure states and never silently evict unrecovered drafts.
- [ ] Coalesce healthy continuous edits into persistence scheduled within two seconds; acknowledge only durable success and preserve older valid recovery on failed writes.
- [ ] Cleanup only resolved revisions on successful explicit save/discard; delayed writes cannot delete newer/unrelated drafts or resurrect discarded text, and Save As retargets only after success.
- [ ] Recover changed/missing targets as comparison/Save As documents; crash tests recover acknowledged text without executing commands or writing original files.

### 16. Manage Spaces and tabs without losing work

**Blocked by:** 07, 15.

**What it delivers:** Switching, closing tabs and deleting saved Spaces have distinct safe behavior and preserve project organization.

**Stories:** 26, 27, 28, 29, 30, 31, 32, 33, 36, 37.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Keep separate roots/tab layouts and allow two Spaces to share a checkout with a clear shared-folder indication, not an isolation promise.
- [ ] Switch without stopping agents; preserve output processing and attention routing while unnecessary hidden presentation stops.
- [ ] Resolve dirty buffers and active/uncertain processes before tab/Space closure; a stale save-and-close cannot discard newer typing.
- [ ] Deleting saved organization never deletes project/worktree directories; cancellation leaves the selected work intact.
- [ ] Restart restores layout/cwd/file locations without rerunning old agent commands; test shared roots, changed/missing files and repeated close attempts.

### 17. Quit with durable recovery and deliberate process termination

**Blocked by:** 16.

**What it delivers:** The app can quit safely without silently bypassing failed recovery writes or killing unresolved work.

**Stories:** 34, 35, 36.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Summarize dirty buffers and active/uncertain app-owned work across Spaces; allow cancellation and deliberate resolution.
- [ ] Bound pending recovery flushes and offer retry/cancel/explicit close-with-loss on failure; repeated close events are never consent to loss.
- [ ] After confirmed shutdown, attempt graceful termination and ask before forcing remaining app-owned work to exit.
- [ ] Do not claim lifecycle control of deliberately detached services or process persistence on restart.
- [ ] Test failed/slow storage, edits during save/close, a process that does not exit and restoration without command replay.

### 18. Guard destructive Git actions across shared Spaces

**Blocked by:** 16.

**What it delivers:** Destructive worktree/file operations cannot ignore work in another Space or act on stale confirmation.

**Stories:** 29, 32, 59, 64.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Track affected canonical worktree/file usage across every Space/pane, including outside-root editor views and matching terminal work.
- [ ] Recheck resolved preconditions immediately before mutation and prevent new conflicting app-owned saves/spawns/mutations during execution, or refuse stale confirmation.
- [ ] Force never silently bypasses dirty-buffer protection; show affected paths, staged-state effects and active/uncertain work.
- [ ] Apply the contract to retained destructive Git actions without adding automatic commits/pushes or removing existing review capabilities.
- [ ] Native and real-app tests show refusal leaves files/index unchanged; independent external writers remain outside perfect detection.

### 19. Install and remove agent hooks with fork ownership

**Blocked by:** 06, 07.

**What it delivers:** Each supported agent's hooks can be deliberately reviewed, activated and removed without altering unrelated configuration.

**Stories:** 17, 18, 19, 20, 21.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Keep hooks opt-in per agent and launching functional without them.
- [ ] Show exact before/after configuration; refuse stale apply and preserve unrelated settings, comments and ownership groups.
- [ ] Remove only this fork's entries and distinguish them from upstream Terax; test install/uninstall coexistence and retries.
- [ ] Explain per-agent activation/trust requirements and fallback when no permission UI subscriber exists.
- [ ] Use temporary fixture profiles, not real user credentials/configuration; do not add new OpenCode/Antigravity structured adapters.

### 20. Launch the target CLI agents and report honest attention

**Blocked by:** 06, 07.

**What it delivers:** OpenCode, Claude Code, Codex and terminal Antigravity CLI have clear launch/basic-status behavior and private notifications.

**Stories:** 9, 10, 11, 12, 13, 14, 15, 16, 22, 23, 24, 25.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Add Antigravity CLI launching/basic process detection distinctly from its separate GUI, while preserving existing agent entries and customizable commands/pane launches.
- [ ] Keep normal hook-free launch and caller-Space file-open/line routing; no centralized approval UI or new structured adapters.
- [ ] Document launch, process status, structured events, notifications and control separately per agent; do not equate process exit with a completed turn.
- [ ] Default notifications to agent/Space identity and attention/completion, without prompt/transcript/file excerpts, focus theft or sound; retain rate/dedup suppression.
- [ ] Use synthetic fixtures for deterministic behavior; actual installed/vendor-version certification is recorded by the release validation ticket rather than fabricated here.

### 21. Create a worktree and open it as a Space

**Blocked by:** 18.

**What it delivers:** The user can create a separate file tree and immediately work in it without moving existing terminals.

**Stories:** 30, 54, 55.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Provide modest UI over retained worktree creation with branch/ref/path validation, collision handling and derived authorization.
- [ ] Offer to open the new worktree as a separate Space; existing terminals and their working directories stay unchanged.
- [ ] Preserve bounded ignored-file inclusion rules and report failures without overwriting existing files.
- [ ] Demonstrate successful creation/opening and refusal cases through temporary repositories and the real app.

### 22. Create, inspect and explicitly clean up manual checkpoints

**Blocked by:** 18.

**What it delivers:** Manual optionally named recovery points are usable without agent hooks and remain until explicit deletion.

**Stories:** 56, 57, 58, 61, 62.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Expose checkpoint creation/list/inspection with noncolliding identity and worktree ownership independent of agent turns.
- [ ] Capture tracked/nonignored contents without modifying HEAD or the real index; retain existing bounded capture contracts and disclose instability, exclusions and non-atomicity.
- [ ] Show ignored/submodule/staging limitations and incomplete results instead of full-backup claims.
- [ ] Expose explicit grouped cleanup with safety refs identified and scoped to the selected worktree; no automatic retention deletion or Git garbage collection.
- [ ] Report storage pressure without exact reclaimed-byte promises; test duplicate creation, capture limits and unrelated-ref preservation.

### 23. Restore a checkpoint with preflight and recovery safeguards

**Blocked by:** 22.

**What it delivers:** The user can review and restore captured file contents without bypassing staged/unsaved-work protection.

**Stories:** 59, 60, 64.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Preview affected paths and staging/HEAD effects and reuse all-Space mutation guards; require resolution of relevant dirty/staged/active work.
- [ ] Publish required affected-content safety capture before changing files/index; failed/incomplete required capture or ref publication refuses, even with force.
- [ ] Preserve ignored-file protection and disclose non-atomic behavior and external writers.
- [ ] On failure after mutation, retain recovery information, report partial effects and require a fresh preview before retry.
- [ ] Test staging-only changes, safety/limit/ref failures with no mutation, later partial failures and content recovery without a full Git-state undo claim.

### 24. Remove worktrees without stranding retained checkpoints

**Blocked by:** 21, 22.

**What it delivers:** Worktree removal reports real blockers and requires deliberate cleanup of owned recovery points first.

**Stories:** 54, 61, 64.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Expose removal with dirty/unmerged/locked/ignored/inconclusive blockers and affected-work checks across all Spaces.
- [ ] Refuse while any owned checkpoint or restore-safety ref remains; show cancel or explicit scoped cleanup before removal.
- [ ] Deleting a Space alone never invokes worktree removal, and removal does not discard another worktree's refs.
- [ ] Revoke only the removed worktree's derived access and handle a missing directory without a repository-wide destructive prune.
- [ ] Test checkpoint/safety-ref blockers and successful removal after explicit cleanup; archival restoration after deletion stays deferred.

### 25. Bound asset delivery and revoke preview access

**Blocked by:** 03, 04.

**What it delivers:** Large local previews cannot bypass resource limits through full-file reads or stale asset grants.

**Stories:** 70, 74, 78, 79.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Enforce approved read/preview ceilings, bounded range and non-range delivery and bounded outstanding work rather than allocating an entire large asset by default.
- [ ] Preserve text limits and controlled overrides; show meaningful oversized/unsupported/read errors and safe alternatives.
- [ ] Canonicalize and recheck opened paths against grant boundaries, including symlink escape and replaced targets.
- [ ] Cancel obsolete work and revoke tab-owned grants on close; late completions cannot install into closed/replaced tabs.
- [ ] Test both range/non-range requests, close-during-load, denial paths and bounded native allocation behavior.

### 26. Read Markdown with scoped local assets and deliberate networking

**Blocked by:** 05, 25.

**What it delivers:** Markdown and fenced code render with stable project-root access and no automatic remote-content fetches.

**Stories:** 65, 71, 72, 73, 74.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Anchor embedded local assets to the configured Space root, or an outside document's directory, not mutable terminal cwd.
- [ ] Require explicit grants for outside assets and deliberate remote-resource loading/external navigation; document content cannot execute app commands.
- [ ] Preserve sanitization, code highlighting, lazy loading and informative asset errors under approved document limits.
- [ ] Defer unnecessary hidden refresh/rendering and release document-owned data/grants on close.
- [ ] Test cwd changes, outside-root documents, symlink escapes, malicious/remote resources and stale load completions in the real app.

### 27. View images with bounded decode and cleanup

**Blocked by:** 25.

**What it delivers:** Supported images open inside the workspace with predictable limits and meaningful failure states.

**Stories:** 65, 67, 69, 70, 79.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Provide basic image viewing for actually tested formats, distinguishing file routing from runtime decode support.
- [ ] Enforce approved byte/dimension/decoded-resource limits before unsafe work where possible and show unsupported/corrupt/oversized outcomes.
- [ ] Keep explicit single-file selection separate from automatic directory embedding policy.
- [ ] Avoid unnecessary hidden presentation and release image data/handles/grants on close or replacement.
- [ ] Test representative images, large dimensions, corrupt/unsupported inputs and repeated open/close cycles; no codec installation.

### 28. Play audio/video with hidden-tab and close cleanup

**Blocked by:** 25.

**What it delivers:** Supported media play with controls and stop unnecessary playback/resource use when hidden or closed.

**Stories:** 65, 67, 69, 70, 79.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Provide basic playback controls through bounded asset delivery and approved resource policies.
- [ ] Report actual container/codec support, loading errors and unsupported/corrupt media rather than trusting extension recognition.
- [ ] Pause unnecessary hidden playback and avoid automatic resume that contradicts user playback state; release handles and grants on close.
- [ ] Test seek/range behavior, hidden/show/close cycles, unsupported codecs and interrupted loads.
- [ ] Do not install codecs automatically or promise media editing; final distro-specific support evidence remains release work.

### 29. Validate Fedora PDF behavior and select the reader path

**Blocked by:** 01.

**What it delivers:** Determine whether the current iframe can satisfy the accepted PDF contract before choosing the retained or dedicated viewer.

**Stories:** 66.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Exercise navigation, zoom, search and text selection with representative PDFs in the actual Fedora Tauri app and real asset/CSP context.
- [ ] Record reliability, failure states and resource observations; extension recognition or a standalone browser probe is insufficient.
- [ ] If the iframe cannot meet the contract, document a concrete on-demand dedicated-reader approach compatible with the approved resource/access policy.
- [ ] Keep this a verifiable prerequisite decision based on evidence, not a new PDF annotation/authoring scope.
- [ ] Do not claim the chosen path is shipped before ticket 30 implements and verifies it.

### 30. Read PDFs with lazy, bounded reader functions

**Blocked by:** 25, 29.

**What it delivers:** PDF navigation, zoom, search and text selection work inside the workspace using the validated reader path.

**Stories:** 65, 66, 70, 78, 79.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Implement the retained iframe only if ticket 29 proves it meets the contract; otherwise use the dedicated on-demand viewer approach.
- [ ] Enforce approved document/page/decoded-resource limits with understandable loading, oversized, corrupt and unsupported states.
- [ ] Keep document content non-executable in app authority and honor deliberate external navigation/resource access.
- [ ] Pause unnecessary hidden rendering and release page/document data, tasks and grants on close.
- [ ] Verify reader functions in the actual Fedora app and repeated hidden/open/close cycles; annotation and authoring remain out of scope.

### 31. Unload hidden web previews without unloading on visible blur

**Blocked by:** 01.

**What it delivers:** Web/dev-server previews preserve their separate trust boundary and stop hidden page work immediately.

**Stories:** 75, 76, 77, 79, 82.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Preserve deliberately entered HTTP(S) previews with initial URL restrictions and no native command access.
- [ ] Unload on inactive tab/Space or supported hidden/minimized signals; do not unload a still-visible window solely for focus loss.
- [ ] Explain reload/transient-state loss and avoid promising complete Linux occlusion detection.
- [ ] Frame teardown never stops the independent dev-server process.
- [ ] Test switching, minimize/restore, visible blur, redirects/popups and native-access refusal in the actual webview.

### 32. Port terminal compatibility, soak and Ghostty update checks to Linux

**Blocked by:** 02, 08.

**What it delivers:** Terminal core changes retain real compatibility and resource evidence after platform narrowing.

**Stories:** 7, 8, 97, 99.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Keep the active adapted bridge, pinned official source, SIMD/scalar artifacts and provenance; do not switch to the separate ABI evaluation runtime.
- [ ] Port useful exactness/visual/scaling/renderer checks currently tied to non-Linux runners into the Linux strategy before their jobs disappear.
- [ ] Exercise shell integration, clipboard/IME/input, search/selection, PTY backpressure, renderer fallback and sustained output.
- [ ] Make a Ghostty revision update rebuild artifacts and require compatibility, soak and resource comparisons against recorded baseline evidence.
- [ ] Keep tests bound to terminal behavior and mark missing platform/runtime evidence honestly.

### 33. Narrow build and distribution support to Linux x86-64

**Blocked by:** 32.

**What it delivers:** Only the selected Linux build/distribution commitments remain without losing migrated useful tests.

**Stories:** 85, 86.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Remove Windows/macOS/WSL/Nix build/distribution workflows and non-x86-64 initial release outputs.
- [ ] Keep migrated Linux coverage before removing old jobs and retain a working Linux build throughout.
- [ ] Remove platform internals selectively only when exclusive and beneficial; retain useful inert portability seams for upstream imports.
- [ ] Do not remove themes/customization, Git, web preview, block mode, formatters, Vim, autostart or other features on watch.
- [ ] Verify CI/package target matrices and documentation accurately describe the narrower support commitment.

### 34. Maintain upstream imports and reviewed dependency updates

**Blocked by:** 32.

**What it delivers:** The fork has a practical repeatable path for upstream fixes and dependency changes.

**Stories:** 95, 96, 97, 98, 99, 100.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Keep a verified upstream Terax remote separate from the fork origin and document selective import/conflict handling.
- [ ] Configure reviewed dependency PRs for supported JavaScript/Rust/Actions/toolchain ecosystems with checks required before merge.
- [ ] Separately monitor the pinned Ghostty source revision where ecosystem tooling does not cover it; do not assume native Zig support.
- [ ] Preserve provenance/licenses, lockfiles, exact toolchains, reproducible rebuild instructions and the terminal gate from ticket 32.
- [ ] Record monthly upstream/dependency review and prompt security triage as policy without inventing a maintenance-hours commitment or creating an unsolicited automation.

### 35. Build reproducible Linux package candidates

**Blocked by:** 07, 08.

**What it delivers:** Produce installable x86-64 RPM/DEB candidates and an Arch recipe from a recorded revision.

**Stories:** 85, 86.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Build RPM and DEB packages with correct Linux runtime dependencies and an Arch recipe aligned with the same source/version.
- [ ] Use independent working fork namespaces and private candidate identities until final publication inputs are supplied.
- [ ] Record reproducible build inputs, artifact hashes and installed CLI/resources/licenses; package extraction alone is not runtime certification.
- [ ] Do not silently emit unsupported architectures/platform formats or reuse upstream update identity.
- [ ] Provide immutable candidate outputs usable by updater evaluation and later graphical/package acceptance.

### 36. Discover stable updates without downloading packages

**Blocked by:** 07.

**What it delivers:** The user sees bounded automatic stable-update checks and Arch/package-tool guidance without unsolicited installation.

**Stories:** 88, 91, 93.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Use a configurable fork-owned release contract and isolated fixtures until production endpoint/trust inputs exist; never query upstream as if it were this fork.
- [ ] Check asynchronously with bounded retry/error behavior for offline/rate limits and distinguish no-update, available and failed states.
- [ ] Do not download a package or invoke privileges without approval.
- [ ] Arch availability routes to package-tool instructions and never a separate privileged in-app Arch installer.
- [ ] Keep update checking independent of the optional native installer choice and test it without real releases.

### 37. Validate RPM/DEB transaction integration or choose handoff

**Blocked by:** 35.

**What it delivers:** Establish which dependency-resolving package-tool upgrade path can satisfy privileges, cancellation and safe-work requirements.

**Stories:** 90, 93.

**Readiness:** Awaiting human/operational inputs: Maintainer-supplied disposable package/privilege validation environments and actual transaction evidence are required; withhold ready-for-agent while unavailable.

- [ ] Use disposable RPM/DEB package environments to test dependency resolution, privilege prompts, cancellation, locks, upgrade/removal and failure recovery.
- [ ] Do not accept raw rpm/dpkg support in the updater as proof of dependency-resolving or package-compatible behavior.
- [ ] Prove whether the integration can recheck readiness and protect the privilege/transaction interval without relaunch.
- [ ] If those guarantees cannot be validated, record the accepted explicit package-tool handoff after safe closure as the supported path.
- [ ] Produce a checkable capability/evidence report consumed by ticket 38; never install into a real user's system just to gather evidence.

### 38. Install approved updates safely or hand off after closure

**Blocked by:** 17, 18, 36, 37.

**What it delivers:** An approved update uses the validated path without installing over newly started work or falsely claiming success.

**Stories:** 88, 89, 90, 91, 92, 93.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Require approval before package download/install, verify authenticity and fail closed on verification failure.
- [ ] Recheck work/dirty-state readiness immediately before the transaction; work started during download invalidates the old readiness result.
- [ ] Prevent new conflicting app-owned work throughout privilege/installation, or abort before invoking the package tool.
- [ ] Use ticket 37's safe-closure handoff when enforcement is unavailable; distinguish handed-off from installed and leave external package actions outside app guarantees.
- [ ] Handle cancellation, locks and failed transactions with explicit recovery; never auto-relaunch, interrupt agents or attempt an unvalidated rollback.

### 39. Settle publication identity and provision independent trust

**Blocked by:** None (can start immediately).

**What it delivers:** The maintainer supplies final nonsecret release identity and independently recoverable signing trust before public distribution.

**Stories:** 83, 87, 92, 94, 102.

**Readiness:** Awaiting human/operational inputs: Maintainer must decide final publication identity/endpoint and provision signing/recovery inputs; no ready-for-agent until supplied.

- [ ] Set final product name, repository/release owner and endpoint explicitly rather than inferring them from current origin or upstream defaults.
- [ ] Reconcile final identity with the isolated working namespaces without silent upstream migration.
- [ ] Provision signing secrets outside the repository and public issue bodies, record only public fingerprints/nonsecret configuration, and keep an offline recovery procedure.
- [ ] Distinguish artifact authenticity from native package/repository trust; managed DNF/APT repositories remain deferred.
- [ ] Document key loss/compromise replacement and verification-failure behavior without bypassing authenticity checks.

### 40. Gate tagged stable releases on checked immutable artifacts

**Blocked by:** 35, 39.

**What it delivers:** Version tags produce authenticated candidate artifacts and publish only when the required evidence gates are satisfied.

**Stories:** 87, 94, 95, 96.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Enforce tag/application-version agreement and passing required CI rather than publishing merely because a tag exists.
- [ ] Generate/authenticate the correct RPM/DEB/Arch-facing artifacts and stable update metadata for the fork; do not retain an AppImage-only manifest assumption.
- [ ] Bind package/resource/runtime evidence to the exact immutable candidate/artifact identities; fail closed while required evidence is missing.
- [ ] Exercise the workflow with safe fixtures/dry runs and no public product release in this implementation ticket.
- [ ] Stable-only publication and trust inputs are independent of upstream; secrets never appear in repository or issue logs.

### 41. Assemble the complete candidate and verify retained workflows

**Blocked by:** 10, 13, 19, 20, 23, 24, 26, 27, 28, 30, 31, 33, 34, 38, 40.

**What it delivers:** One immutable candidate demonstrates the complete agreed workspace instead of treating a removal milestone as the finished product.

**Stories:** 1, 2, 3, 7, 8, 26, 37, 38, 39, 40, 52, 53, 63, 68, 82, 101.

**Readiness:** Fully specified for ready-for-agent; obey native code blockers.

- [ ] Run the complete isolated launch-agent/switch-Space/review-Git/edit/preview/commit workflow against a recorded candidate revision.
- [ ] Verify all existing Git status/stage/diff/hunk/history/branch capabilities and explicit commit/push remain usable, alongside new worktree/checkpoint controls.
- [ ] Confirm no selected removed feature is exposed or required, and CSV/TSV remain editable text rather than a new table viewer.
- [ ] Audit themes, shortcuts, existing customization, web previews and block terminal mode, external formatters, Vim, autostart and other unselected optional features for regressions.
- [ ] Retain the priority of data/process safety and terminal correctness; record exact candidate hashes and unresolved failures for tickets 42-43 without closing the parent spec.

### 42. Accept final whole-app resource budgets and stability evidence

**Blocked by:** 41.

**What it delivers:** The primary user can judge lightweight behavior from final-candidate measurements and approve evidence-based product thresholds.

**Stories:** 78, 79, 80, 81, 102.

**Readiness:** Awaiting human/operational inputs: Final candidate evidence and primary-user approval of measured whole-app budgets are required; this gates release/completion, not unrelated implementation.

- [ ] Compare the exact complete candidate with ticket 2's baseline under the same recorded conditions and representative/stress workloads.
- [ ] Measure startup, whole-app process memory/CPU, sustained terminal output, hidden/show/close resource behavior and package size; separate agent processes and shared memory.
- [ ] Verify approved document/decoded ceilings, on-demand imports and repeated close cleanup; investigate persistent growth rather than assuming deletion saved idle memory.
- [ ] Propose and obtain primary-user approval of concrete final resource/performance limits and report practical measurement limitations.
- [ ] Do not mark lightweight completion from lazy-loading claims, isolated host RSS or a single passing sample; preserve artifact identity in acceptance evidence.

### 43. Validate the exact candidate on Fedora, Debian and Arch

**Blocked by:** 41.

**What it delivers:** Published package/support claims are backed by graphical install/upgrade/runtime evidence for the intended environments.

**Stories:** 10, 14, 21, 65, 66, 67, 69, 70, 85, 86, 87, 90, 92, 93, 99.

**Readiness:** Awaiting human/operational inputs: Maintainer must provide the graphical/package/vendor validation environments and operational evidence; no ready-for-agent while unavailable.

- [ ] Validate Fedora 44 KDE Wayland as primary, Debian 13 in a real graphical WebKitGTK session and a dated clean Arch environment with recorded versions.
- [ ] Install/upgrade/remove the exact immutable candidate packages; verify dependencies, signatures, privileges/cancellation/locks, failed-transaction recovery and coexistence.
- [ ] Run WebGL fallback, terminal input/clipboard/scale, PDF reader functions and representative image/media codecs; record the actually tested support matrix and clear failures.
- [ ] Check actual claimed agent integrations/versions, including hook activation/trust where applicable, in explicitly authorized isolated vendor validation.
- [ ] Record artifact-bound pass/fail evidence and limitations; package extraction, generic Ubuntu builds and extension recognition do not establish support.

### 44. Publish and verify the first validated stable release

**Blocked by:** 42, 43.

**What it delivers:** The first stable release is publicly available with verified artifacts and truthful installation/update/support information.

**Stories:** 2, 87, 94, 101, 102.

**Readiness:** Awaiting human/operational inputs: Release waits for final resource/package acceptance and operational publication inputs; keep ready-for-agent off until those gates are met.

- [ ] Publish only the candidate/artifacts whose CI, version, trust, resource and distro acceptance evidence passed; any changed artifact requires applicable revalidation.
- [ ] Use the configured tag-driven release path with settled fork identity and independent trust, stable-only packages/recipe and correct endpoint metadata.
- [ ] Verify public download/update discovery and the supported install/handoff/Arch routes without auto-installing or restarting running agents.
- [ ] Publish tested support/codec/capability limits and recovery/maintenance guidance without claiming broad compatibility or production-readiness certification.
- [ ] Keep incomplete stages and remaining evidence failures from being represented as full completion; do not close or rewrite the parent spec as part of ticket publication.

## Complete user-story coverage

| Parent story | Tickets |
| --- | --- |
| 1 | 41 |
| 2 | 41, 44 |
| 3 | 41 |
| 4 | 11, 13 |
| 5 | 09, 12, 13 |
| 6 | 10 |
| 7 | 01, 32, 41 |
| 8 | 01, 32, 41 |
| 9 | 06, 20 |
| 10 | 20, 43 |
| 11 | 20 |
| 12 | 06, 20 |
| 13 | 20 |
| 14 | 20, 43 |
| 15 | 20 |
| 16 | 06, 20 |
| 17 | 19 |
| 18 | 19 |
| 19 | 19 |
| 20 | 19 |
| 21 | 19, 43 |
| 22 | 06, 20 |
| 23 | 06, 20 |
| 24 | 20 |
| 25 | 20 |
| 26 | 16, 41 |
| 27 | 16 |
| 28 | 16 |
| 29 | 16, 18 |
| 30 | 16, 21 |
| 31 | 16 |
| 32 | 16, 18 |
| 33 | 16 |
| 34 | 17 |
| 35 | 17 |
| 36 | 16, 17 |
| 37 | 04, 16, 41 |
| 38 | 10, 14, 41 |
| 39 | 10, 14, 41 |
| 40 | 10, 14, 41 |
| 41 | 04, 14 |
| 42 | 14 |
| 43 | 14 |
| 44 | 14 |
| 45 | 14 |
| 46 | 15 |
| 47 | 15 |
| 48 | 15 |
| 49 | 15 |
| 50 | 15 |
| 51 | 15 |
| 52 | 41 |
| 53 | 12, 41 |
| 54 | 21, 24 |
| 55 | 21 |
| 56 | 22 |
| 57 | 22 |
| 58 | 22 |
| 59 | 18, 23 |
| 60 | 23 |
| 61 | 22, 24 |
| 62 | 22 |
| 63 | 41 |
| 64 | 18, 23, 24 |
| 65 | 05, 26, 27, 28, 30, 43 |
| 66 | 29, 30, 43 |
| 67 | 27, 28, 43 |
| 68 | 41 |
| 69 | 27, 28, 43 |
| 70 | 03, 25, 27, 28, 30, 43 |
| 71 | 05, 26 |
| 72 | 26 |
| 73 | 26 |
| 74 | 25, 26 |
| 75 | 31 |
| 76 | 31 |
| 77 | 31 |
| 78 | 25, 30, 42 |
| 79 | 03, 25, 27, 28, 30, 31, 42 |
| 80 | 02, 42 |
| 81 | 02, 03, 42 |
| 82 | 12, 31, 41 |
| 83 | 07, 39 |
| 84 | 07 |
| 85 | 08, 33, 35, 43 |
| 86 | 33, 35, 43 |
| 87 | 39, 40, 43, 44 |
| 88 | 36, 38 |
| 89 | 38 |
| 90 | 37, 38, 43 |
| 91 | 36, 38 |
| 92 | 38, 39, 43 |
| 93 | 36, 37, 38, 43 |
| 94 | 39, 40, 44 |
| 95 | 01, 08, 34, 40 |
| 96 | 34, 40 |
| 97 | 32, 34 |
| 98 | 34 |
| 99 | 01, 08, 32, 34, 43 |
| 100 | 34 |
| 101 | 41, 44 |
| 102 | 03, 39, 42, 44 |

## Cross-cutting requirement coverage

| Contract | Tickets |
| --- | --- |
| Purpose, priorities and personal-use-first boundary | 41, 44 |
| Selected removals and exclusively owned settings/dependencies | 09, 10, 11, 12, 13 |
| Shared wrappers, policies, Markdown and formatter ownership | 04, 05, 06, 13 |
| Architecture continuity and bounded prefactoring | 04, 05, 06, 08, 13 |
| Terminal model, artifacts, fallback and Ghostty source upgrades | 01, 32, 34 |
| Per-agent capability matrix, permissions, CLI/control and notifications | 06, 19, 20, 43 |
| Spaces, shared roots, guards, shutdown and layout restoration | 07, 16, 17, 18 |
| Native save revisions, overwrite consent and external-writer limits | 14, 18 |
| Recovery identity, quotas, cadence, acknowledgement and failed close | 15, 16, 17 |
| All retained Git review/stage/history/commit/push behavior | 18, 41 |
| Worktree create/open/remove and retained checkpoint constraints | 21, 22, 23, 24 |
| Safety snapshot preflight, partial failures and no full-state undo | 23 |
| Preview categories, PDF mechanism, format support and refusal | 25, 26, 27, 28, 29, 30, 43 |
| Preview local/remote access, canonical grants and cleanup | 25, 26, 27, 28, 30 |
| Web trust, visibility, immediate teardown and server survival | 31 |
| Read/decode limits, lazy loading, hidden work and closed-tab resources | 03, 25, 26, 27, 28, 30, 31, 42 |
| Baseline workload, empirical ceilings and whole-app budget acceptance | 02, 03, 42 |
| Complete first-run namespace isolation and no upstream import | 01, 07, 19 |
| Linux platform support, packages and graphical validation | 08, 32, 33, 35, 43 |
| Release identity, signing, key recovery and metadata trust | 39, 40, 44 |
| Update approval, safe interval, package integration/handoff and Arch | 36, 37, 38, 43, 44 |
| Reproducibility, CI, dependency PRs and selective upstream imports | 08, 32, 34, 40 |
| Kept customization/optional features and complete milestone honesty | 10, 12, 33, 41, 44 |
| Approved test seams and Linux harness prerequisites | 01, 08, 32, 41, 42, 43 |
| Deferred archival recovery and all other explicit exclusions | 24, 41, 44 |

## Challenge-resolution coverage

| Accepted resolution | Tickets |
| --- | --- |
| C1: first-run isolation | 01, 07 |
| C2: canonical saves and all-Space destructive guards | 14, 18 |
| C3: draft identities, durable acknowledgement and close failure | 15, 16, 17 |
| C4: worktree removal waits for explicit recovery cleanup | 22, 24 |
| C5: failed required safety capture refuses before mutation | 23 |
| C6: update readiness and protected installation interval | 37, 38 |
| C7: hidden/minimized versus visible blur | 31 |

## Approval record and reviewed questions

1. Does this granularity feel right, or is any ticket too coarse or too fine?
2. Do the blocking edges represent genuine prerequisites rather than merely preferred scheduling?
3. Should any tickets be merged or split?
4. Does the requirement mapping cover the complete scope, with human inputs and release evidence blocking only the affected work or release?

The user approved the complete breakdown and native-edge/readiness policy: "Approved but dont implement yet." Publication is authorized; implementation remains explicitly held. The questions above record the review that preceded approval.

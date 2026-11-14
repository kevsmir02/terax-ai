# Personal Linux workspace

Language for the fork's project organization and agent workflow.

## Language

**Space**:
A named project context with its own project folder and open tabs. A Space provides organizational separation, not a sandbox.
_Avoid_: Sandbox

**External agent**:
An independently installed AI tool that runs outside the workspace application's built-in AI system, including terminal CLI agents.
_Avoid_: Built-in agent, subagent

**Built-in AI**:
The application's own AI chat, provider connections, tools, and supervision capabilities.
_Avoid_: External agent

**Project root**:
The folder a Space uses as its starting project context. It is not a boundary on files the user may deliberately open.
_Avoid_: Sandbox root

**Checkpoint**:
A worktree-specific recovery snapshot of tracked and nonignored project files. It is not a complete backup and does not preserve staging state, ignored files, or submodule contents.
_Avoid_: Backup, commit

**Agent integration**:
The set of workspace capabilities supported for a particular external agent, such as launching, process status, structured events, notifications, and control. Support for one capability does not imply support for the others.
_Avoid_: Full support

**Account isolation**:
An opt-in Space setting that binds terminal sessions in that Space to a Space-specific account context instead of the host's shared environment.
_Avoid_: Sandbox, container

**Account context**:
The external-agent authentication and private state scope attached to a Space and its terminal sessions, either the shared host environment or a Space-owned isolated context.
_Avoid_: Session profile, sandbox

**Agent profile**:
A Space-owned private directory holding authentication and non-shared state for one external agent under an isolated account context.
_Avoid_: Harness account, installation

**Candidate**:
A recorded revision and the artifacts built from it, proposed for validation and release. Calling something a candidate is not a support claim.
_Avoid_: Release, beta

**Stable release**:
A published fork-owned version whose artifacts passed the release gate and whose resource and distribution evidence is recorded. It is not the same as a candidate, a merge or a successful build.
_Avoid_: Build, nightly

**Release gate**:
The refusal-first check that decides whether a tag may produce a publishable artifact set: tag/version agreement, required CI, artifact identity and provisioned trust. Passing it is a precondition, never proof that the candidate was meant to ship.
_Avoid_: Publish script

**Publication identity**:
The product name, release owner and update endpoint a release is published under. It is distinct from the build's application identifier and its filesystem namespace.
_Avoid_: Branding, app id

**Signing trust**:
The independently recoverable key material and verification rule that decides whether an artifact is authentic. It is distinct from native package or repository trust, which is deferred.
_Avoid_: Signature check, repository trust

**Package-tool handoff**:
The supported upgrade path: after the application is safely closed, it hands the approved package artifact to the user's package tool. It is not an in-application install, and it never restarts the application.
_Avoid_: Auto-update, in-app install

**Recovery draft**:
A recoverable copy of a particular editor buffer's unsaved text, distinct from the current file on disk and from a Git checkpoint. Independent buffers for the same file can own separate drafts.
_Avoid_: Persistent session, checkpoint

**Document preview**:
A reading view of a project file, such as Markdown, PDF, an image, or media. It is distinct from an interactive web/dev-server preview.
_Avoid_: Browser

**Web preview**:
An interactive view of an HTTP(S) page, including a project dev server. Its page state is distinct from the server process and from a document preview.
_Avoid_: Document preview

**Hidden web preview**:
A web preview in an inactive tab or Space, or in a window reported hidden or minimized. A still-visible preview is not hidden solely because its window loses focus.
_Avoid_: Unfocused preview

**Layout restoration**:
Reopening the saved organization of Spaces, tabs, panes, folders and file locations. It does not imply that previous processes are still running or that their commands will run again.
_Avoid_: Session persistence

**Shell frame**:
The outer window chrome (header bar, tab strip, sidebar panel, and status bar) arranged as flush hairline-divided panels surrounding the main content area.
_Avoid_: Outer pane, Floating pane

**Content stage**:
The primary panel beside the sidebar hosting the active tab's view cleanly behind a terminal card or edge-to-edge across non-terminal editors, diffs, and previews.
_Avoid_: Workspace, Main pane

**Terminal card**:
The rounded, outlined container inside the content stage that frames a terminal tab's pane layout, integrated pane headers, and any docked command input footer.
_Avoid_: Terminal wrapper, Floating pane

**Pane**:
One leaf terminal session inside a terminal card, filling the card on its own or separated from sibling panes by internal hairline dividers.
_Avoid_: Split cell, Top-level panel

**Pane header**:
The slim opaque strip across the top of a pane displaying its session label, external agent activity status, and concise working directory above the terminal output.
_Avoid_: Pane toolbar, Title bar

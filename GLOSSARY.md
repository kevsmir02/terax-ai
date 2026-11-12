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

# Security

This repository builds **Codr**, an **unofficial Linux fork** of Terax (upstream: `crynta/terax-ai`).
It is not affiliated with Crynta, it is not the upstream product, and upstream's security process and
contact address do not apply here. No production-readiness certification or warranty is claimed.

## Reporting a vulnerability

Report privately through this repository's **Security -> Report a vulnerability** form
(<https://github.com/kevsmir02/terax-ai/security/advisories/new>). That keeps the report out of
public view until a fix exists.

If private reporting is unavailable, open an issue that contains **no vulnerability details** and
ask the repository owner for a private channel. Do not describe the flaw in a public issue.

Include:

- what the issue is and what it lets an attacker do;
- steps to reproduce (a small proof of concept is ideal);
- the version or commit you built, the distribution and desktop, the WebKitGTK version, and which
  artifact you ran (RPM, DEB, the Arch recipe built locally, or a source build).

## Supported versions

No stable release is published yet: the first one is gated on artifact, resource and distribution
evidence (issue #45). Until it exists, only the current `main` tip is considered, and no release
binary is supported for production use yet. Once a stable release exists, only the latest stable
minor receives fixes.

## What is in scope

- The Rust backend in `src-tauri/` (PTY, filesystem, IPC, plugins) and the frontend in `src/`
  wherever untrusted input lands (terminal output, file content, previews, workspace state).
- The packaging scripts, the release gate and the app-lab harness in this repository.
- The updater's discovery path and the package-tool handoff.

## What is not in scope

- Upstream dependencies (Tauri, WebKitGTK, libghostty, CodeMirror, coding-agent CLIs). Report those
  upstream; this fork ships the fix once it is released.
- Anything that needs an already-compromised machine or a local attacker with shell access.
- The macOS, Windows and WSL code paths. They are retained as inert seams so upstream imports stay
  cheap, and they are not supported configurations of this fork.
- Third-party agent CLIs: they keep their own permissions, credentials and trust prompts.

## Trust boundaries this build actually has

- **No application AI credentials.** There is no built-in model, no provider key storage and no
  keychain access. Coding agents run as external CLI processes with their own approvals.
- **No telemetry.** The application talks to the network when you ask it to (an update check, a web
  preview) and not otherwise.
- **No Node in the renderer.** The frontend reaches the host only through allow-listed Tauri
  commands, and capabilities grant no updater install command.
- **This application never downloads, installs or restarts itself.** Updates are performed with your
  package tool: the app can hand the package artifact to it after you approve, and a handoff is
  never reported as a completed install or as verified downloaded bytes.
- **Independent artifact trust root (minisign) vs package/repo trust.** The fork's independent
  minisign public key is provisioned (`94097B75DB498B21`,
  `sha256:a02fd6ac492d1f070919bde106c20c0a376fbcdb6db8bc4c17ca0efd68197487`; see
  `docs/architecture/release-trust.md`), and nothing in this repository or its issues holds a
  private signing key. At discovery time the app fails closed on malformed envelopes, version
  mismatches, or non-matching key IDs. Download-time package installation and managed DNF/APT
  repository trust remain separate and deferred: `dnf` and `apt` do not verify minisign signatures,
  so inspect downloaded artifacts with the published `.minisig` files before running your package
  manager.

## What we cannot promise

- The application runs whatever you (or an agent) tell it to run, with your permissions. That is the
  point of a terminal.
- Local model endpoints (LM Studio, OpenAI-compatible servers) are trusted at the network level;
  only point the application at servers you control.
- No release artifact has been validated on Fedora, Debian or Arch yet, and the packaged install path
  is not validated on any distribution until issue #44 records it. Read the supported-matrix
  statements in `README.md` before relying on a package.

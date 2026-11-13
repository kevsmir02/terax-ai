# Update handoff: the supported upgrade path

**Status: decided.** On **2026-11-13** the primary user chose the explicit
**package-tool handoff after safe closure** as this fork's supported upgrade path. No
in-application RPM/DEB transaction is claimed, validated or implemented. This record is the
capability/evidence report that GitHub issue **#38** (plan ticket 37) requires and that
issue **#39** (plan ticket 38) consumes.

## The decision

The app **discovers** a stable update, names the exact artifact and the package-manager
command, and leaves the download and the transaction to the person and their package tool.
It never executes `apt`, `dnf` or `pacman`, never requests privilege, never relaunches and
cannot observe whether the install succeeded.

Why this path rather than a validated in-app integration: every guarantee a safe in-app
transaction needs (dependency resolution, privilege prompt, cancellation, package locks,
upgrade/removal, failure recovery) can only be established by running real transactions in
disposable RPM/DEB environments with privilege access. That environment is not available to
this project, and issue #38's fourth acceptance criterion allows recording this handoff as
the supported path instead of asserting guarantees nobody measured. Raw `rpm`/`dpkg` support
inside the updater is **not** accepted as proof of any of it.

**Accepted risk.** A failed or partial transaction is the package tool's problem: the app
may start against a partially upgraded tree, it cannot distinguish "installed" from
"handed off", and it must not try to roll anything back. The dialog says so rather than
implying success.

## Guarantees: measured or not

| Guarantee an in-app transaction would need | State | Why it is not validated here | What would validate it |
|---|---|---|---|
| Dependency resolution | not validated | needs a real repo set and a disposable target system | a disposable Fedora/Debian box installing the candidate with its package tool while the app is closed |
| Privilege prompt and password flow | not validated | needs privilege access on a disposable system | the same run, recording the prompt, refusal and cancellation |
| Cancellation mid-transaction | not validated | needs a real transaction to interrupt | cancel the package tool at several stages and boot the app afterwards |
| Package locks and concurrent installs | not validated | needs two package operations against one database | a second `dnf`/`apt` while the first holds the lock |
| Upgrade and removal | not validated | needs an installed previous candidate | install N, upgrade to N+1, remove, and check the user profile survives |
| Failure recovery / partial upgrade | not validated | needs a deliberately broken transaction | break a transaction and boot the app against the result |
| Package signature rejection | not validated | native DNF/APT repos are deferred and no clean distro transaction has run yet (#44) | install an unsigned or foreign package with `dnf`/`apt` on a clean VM and verify `.minisig` rejection behavior separately |

Nothing in this table is a hidden pass: the app makes no claim in the UI that an install
succeeded, and `docs/architecture/update-discovery.md` keeps its own "Not claimed" list.

## What the app does today

- **Discovery only.** `checkForUpdate` GETs the manifest endpoint; it never downloads a
  package. `src/modules/updater/requestDownload.ts` returns `not-implemented`, and the state
  machine stops at `handed-off` (or `handoff-blocked`) — there is no `installed` or `ready`
  state.
- **No capability to install.** `src-tauri/capabilities/desktop.json` and the other
  capability files grant no `updater:` permission, so no window can call the plugin's
  `check`, `download`, `install` or `download_and_install`; `scripts/tests/test_capabilities.py`
  parses the plugin's own permission list and fails if one comes back.
- **No relaunch.** Nothing in `src/` imports `@tauri-apps/plugin-process`, and the Rust quit
  path exits the process directly (`src-tauri/src/lib.rs`); the handoff copy says "Terax
  never relaunches itself".
- **The handoff copy** names the artifact and the tool (`apt`/`dnf`, plus pacman/makepkg/AUR
  guidance for Arch) and states that the app does not run the transaction
  (`src/modules/updater/packageGuidance.ts`).


## Safe closure

Safe closure is the quit gate (`docs/architecture/quit-shutdown.md`): the dialog tells the
person to close the app before the package tool replaces it, so unsaved buffers go through
the same survey, recovery flush and process question as any other quit.

## Readiness and the privilege interval (issue #38's third criterion)

There is no privilege interval to protect and no transaction to abort, because the app never
starts one: `requestDownload` stops at `not-implemented` and no capability grants an install
command. The question "can the integration recheck readiness and protect the privilege
interval without relaunching?" therefore cannot be answered by measurement here — the
integration does not exist, and building one to measure it would contradict this decision.
What does exist is the readiness check at *handoff* time, implemented by #39
(`src/modules/updater/handoffReadiness.ts`): it invalidates a previous result when work
starts after the check, and it blocks rather than resolving the work.


## Consumed by issue #39

#39 owns the *handoff* half of the sequencing and must not weaken this decision. It now
does, in code:

- rechecks the live state — unsaved buffers, terminal processes and working agents —
  immediately before the handoff, binding the approval to the snapshot it was taken
  against, so work started after the check invalidates it
  (`src/modules/updater/handoffReadiness.ts`, `handoffWork.ts`, `updateState.ts`);
- distinguishes "handed off to your package tool" from "installed": the furthest state is
  `handed-off`, and there is no `installed`/`ready` member in the state union;
- gives cancellation, package-lock and failed-transaction copy with an explicit recovery
  path (close Terax, run the command again, nothing is rolled back by the app);
- never relaunches, never interrupts an agent, never attempts a rollback. Work in the way
  blocks the handoff and is left for the person to finish, with a "review the work" action
  that only focuses it.

The in-app install half stays absent by this decision, not by oversight: `requestDownload`
still returns `not-implemented`, no capability grants `updater:*`, and the handoff adds no
native capability.

If a real transaction path is ever validated in disposable environments, this record is
superseded by that evidence — with the environments, the transaction logs and the resulting
guarantees named. Until then, "package-tool handoff after safe closure" is the supported
path and no other path may be described as supported.


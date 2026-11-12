# Quit, recovery flush and deliberate termination

Ticket #18 (workspace 17) implements user stories 34–36: quitting summarises what is at
stake across every Space, bounds the recovery flush instead of trusting it, and asks
before forcing work that will not exit. Ticket #17 owns the same questions for closing a
tab or deleting a Space; this document is the quit-time half.

## The decision is a state machine

`src/modules/shutdown/lib/gate.ts` is pure and owns the whole sequence. Effects are
returned, not executed, so the same machine runs against the real terminal backend or a
test double (`src/app/hooks/useQuitGuard.ts` executes them).

```
idle ──close-request──▶ surveying ──nothing at stake──▶ closing ──▶ window closes
                              │
                              └──hazards──▶ resolving ──confirm──▶ flushing
                                                │                     │
                                                │              ┌──────┴────────┐
                                                │           clean            drafts
                                                │              ▼               ▼
                                                │         verifying        flush-failed
                                                │              │           (retry / cancel /
                                                │              │            lose drafts)
                                                │              ▼
                                                └──new work── terminating ──survivors──▶ force-prompt
                                                                   │                         │
                                                              all exited                  force
                                                                   ▼                         ▼
                                                                closing ◀────────────────────┘
```

Rules the tests pin:

- **A repeated close event is never consent.** `close-request` is accepted only from
  `idle`. Every other phase ignores it, including `flush-failed` and `force-prompt`,
  where a second click is most tempting to read as an answer.
- **Only what was asked about is acknowledged.** `confirm` records the buffer tab ids and
  terminal leaf ids it covered. `verifying` re-surveys after the flush and reopens the
  question (`note: "changed"`) when new work appeared. Vanished hazards do not re-open it.
- **A save before quit is revisited, not trusted.** `save-all` runs the app's own save
  (`saveTab`), and the buffer is asked again after the await; an incomplete save returns
  to the question with `note: "save-incomplete"` instead of closing.
- **Late results do nothing.** A flush or termination that lands after `cancel` changes no
  state and causes no effect.

## The survey

`src/modules/shutdown/lib/survey.ts` groups three kinds of evidence by Space:

| evidence | source | not a hazard when |
| --- | --- | --- |
| unsaved buffer | `editorRefs` handle `isDirty()`, not the tab's published flag | the editor is clean |
| running process | `pty_has_foreground_process` per terminal leaf | the shell has no children |
| unsaved draft | `RecoveryManager.statuses()` classified by the same code the flush uses | recovery is off/excluded, or the durable revision covers the buffer's newest text |

A process probe that fails is **not** evidence that the pane is idle. The terminal API
maps an unavailable probe to `true` (busy), and the survey's own `uncertain` state exists
for a probe that throws; both block the quit.

The summary states the limits out loud: processes detached from a terminal or started
outside Terax keep running, and reopening restores organisation, directories and file
locations only — not processes and not commands.

## The flush is bounded, and a bound is not a save

`flushRecovery` races `RecoveryManager.flushAll()` against `QUIT_FLUSH_TIMEOUT_MS`
(3 s). On timeout it reports `unsettled` from the live statuses and never claims the text
is saved; the write itself keeps going, so Retry observes it once it lands. A settled
flush still reports every buffer whose `durableRevision` is older than its
`bufferRevision` — text typed while the write was in flight — as `pending`.

`off`, `excluded` and `idle` are not losses: recovery was never protecting those buffers.

## Graceful termination, then a question

After confirmation the frontend calls `pty_terminate` (Rust, `modules::pty`) with every
terminal leaf and a 2 s grace. It sends `SIGTERM` to the tty's foreground process group
(when that group is not the shell's own) and to the shell's children — which is how
background jobs and every shell without job control are reached — then polls for up to the
grace. It **never escalates**: a job that ignores `SIGTERM` is reported as a survivor.

Only the survivor prompt can call `pty_close_all` (the existing SIGHUP/hang-up path), and
only from an explicit answer. Cancelling there keeps the window open. Services that left
the terminal's process tree are invisible to both calls, which the prompt says.

Bounded and non-escalating is deliberate: `pty_terminate` clamps its grace to 10 s, runs
on a blocking thread, and holds no session lock while sleeping.

## Restoration

Quitting persists the same layout the Spaces feature already stores
(`src/modules/spaces/lib/serialize.ts`); `planSpaceRestore` rebuilds Spaces, tabs and file
locations with terminal and file tabs cold. No command is stored, so none is replayed.
`main.tsx` reaps orphaned PTY sessions on every page load, so a reload (or a restart of
the process) cannot leave the previous terminals running either.

## What is not claimed

- Lifecycle control of deliberately detached services (`setsid`, `systemd-run`, a dev
  server the user started elsewhere). They keep running.
- Process persistence across restart. A CLI's own `--resume` is not application-level
  persistence.
- That a failed draft write recovered on its own: the older valid record is preserved and
  the newest text is reported as not saved.
- The exact bytes that a `SIGTERM`-honouring program writes while shutting down.

## Evidence

- `src/modules/shutdown/lib/*.test.ts` — survey, bounded flush (failed, slow, edits during
  the write, quota pause, unavailable storage) and every gate transition, including
  repeated close, cancel-during-flush and late reports.
- `src-tauri/src/modules/pty/mod.rs` (`graceful_termination_*`) — real PTYs: a cooperating
  job exits; a job that traps `TERM` is reported and survives until the separate force.
- `python3 scripts/app-lab/run.py --scenario quit` — the real application: two Spaces with
  dirty buffers and busy terminals, the survey copy, a repeated close that does not quit,
  cancel, save-then-quit, graceful termination, the survivor prompt, cancel at that prompt,
  a confirmed force, then a reload that restores the layout and replays no command.

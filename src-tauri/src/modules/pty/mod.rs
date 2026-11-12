pub(crate) mod agent_detect;
mod da_filter;
mod foreground;
mod gate;
mod hub;
mod output;
mod presentation;
mod protocol;
mod queue;
mod session;
pub(crate) mod shell_init;
mod terminal_colors;
#[cfg(unix)]
mod unix_reader;
mod wake;
mod wire;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::thread;

use portable_pty::PtySize;
use tauri::Manager;

use crate::modules::control::ControlState;
use crate::modules::workspace::{user_spawn_cwd_or_home, WorkspaceEnv, WorkspaceRegistry};
use hub::{Command, Hub};
pub use presentation::PresentationClass;
pub use protocol::stream_protocol;
use session::Session;
use terminal_colors::TerminalColors;

/// Largest `pty_set_presentation` batch accepted; a window never has more
/// terminals than this, so anything larger is a malformed request.
const MAX_PRESENTATION_BATCH: usize = 4096;

/// A live terminal resolved from a frontend pane id.
#[derive(Clone)]
pub struct PaneTarget {
    pub pty_id: u32,
    pub owner: Arc<str>,
    pub link: Arc<agent_detect::AgentLink>,
}

pub struct PtyState {
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: AtomicU32,
    hub: Hub,
    /// Resolved from the app's config on the first `terax-pty` request.
    origins: OnceLock<gate::AllowedOrigins>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            hub: Hub::new(),
            origins: OnceLock::new(),
        }
    }
}

impl PtyState {
    /// Removes a session from the registry and from the hub's delivery set.
    pub(super) fn take(&self, id: u32) -> Option<Arc<Session>> {
        let session = self.sessions.write().unwrap().remove(&id);
        if session.is_some() {
            self.hub.submit(Command::Unregister { id });
        }
        session
    }

    /// The live terminal currently bound to a frontend pane, newest first when
    /// a pane was respawned. Finished sessions are not live.
    pub fn pane_target(&self, pane_id: u32) -> Option<PaneTarget> {
        let sessions = self.sessions.read().unwrap();
        sessions
            .iter()
            .filter(|(_, session)| {
                session.pane_id == Some(pane_id) && !session.finished.load(Ordering::Acquire)
            })
            .max_by_key(|(id, _)| **id)
            .map(|(id, session)| PaneTarget {
                pty_id: *id,
                owner: session.owner.clone(),
                link: session.link.clone(),
            })
    }

    /// The window's page navigated away (reload, HMR): its stream token dies
    /// and its terminals stop producing output until the new page's
    /// `pty_close_all` reaps them, exactly as when their channel went away.
    pub fn reset_webview(&self, label: &str) {
        self.hub.submit(Command::ResetWebview {
            label: Arc::from(label),
        });
        for session in self.sessions.read().unwrap().values() {
            if &*session.owner == label {
                session.close_output();
            }
        }
    }

    /// The webview is gone: close every terminal it owned.
    pub fn destroy_webview(&self, label: &str) {
        self.hub.submit(Command::RemoveWebview {
            label: Arc::from(label),
        });
        let owned: Vec<(u32, Arc<Session>)> = {
            let mut sessions = self.sessions.write().unwrap();
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, session)| &*session.owner == label)
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|session| (id, session)))
                .collect()
        };
        for (id, session) in owned {
            reap(id, session, "webview destroyed");
        }
    }

    /// Native window occlusion or system sleep: every terminal of the window
    /// drops to the occluded cadence without a frontend round trip.
    pub fn set_window_hidden(&self, label: &str, hidden: bool) {
        self.hub.submit(Command::WindowHidden {
            label: Arc::from(label),
            hidden,
        });
    }
}

fn check_presentation_batch(ids: &[u32]) -> Result<(), String> {
    if ids.len() > MAX_PRESENTATION_BATCH {
        return Err(format!(
            "pty_set_presentation: at most {MAX_PRESENTATION_BATCH} ids per call"
        ));
    }
    Ok(())
}

/// Closes output, kills the child and drops the session off the caller's
/// thread (`ClosePseudoConsole` can block until conhost drains).
fn reap(id: u32, session: Arc<Session>, reason: &str) {
    session.close_output();
    if let Err(e) = session.killer.lock().unwrap().kill() {
        // Non-fatal: the child may already have exited on its own (e.g. the
        // user ran `exit`). Log so this isn't invisible during debugging.
        log::debug!("pty {reason}: kill id={id} returned {e}");
    }
    thread::Builder::new()
        .name(format!("terax-pty-drop-{id}"))
        .spawn(move || {
            let t0 = std::time::Instant::now();
            session::drop_session(session);
            log::info!(
                "pty session id={id} dropped in {}ms",
                t0.elapsed().as_millis()
            );
        })
        .expect("spawn pty drop thread");
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
    control: tauri::State<'_, ControlState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    pane_id: Option<u32>,
    presentation: Option<PresentationClass>,
    colors: Option<TerminalColors>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let blocks = blocks.unwrap_or(false);
    // A Windows helper cannot execute inside WSL without explicit path and
    // network translation. Do not inject credentials for a broken command.
    let control_env = if workspace.is_wsl() {
        None
    } else {
        pane_id.and_then(|pane_id| control.shell_env(pane_id))
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let credential = control_env.clone();
    let pending_credential = credential.as_ref().map(|env| control.pending_shell(env));
    let control_app = app.clone();
    let owner: Arc<str> = Arc::from(webview.label());
    let hub = state.hub.clone();
    let class = presentation.unwrap_or_default();
    let session = tauri::async_runtime::spawn_blocking(move || {
        // Authorizing the directory canonicalizes it, which touches the disk
        // (a network volume, or wsl.exe for a WSL workspace): never on a worker.
        let cwd = user_spawn_cwd_or_home(
            &app.state::<WorkspaceRegistry>(),
            cwd.as_deref(),
            &workspace,
        );
        session::spawn(
            id,
            app,
            owner,
            hub,
            class,
            cols,
            rows,
            cwd,
            workspace,
            blocks,
            shell,
            control_env,
            colors,
            pane_id,
        )
    })
    .await
    .map_err(|e| {
        log::error!("pty_open join failed: {e}");
        e.to_string()
    })?
    .map_err(|e| {
        log::error!("pty_open failed: {e}");
        e
    })?;
    state.sessions.write().unwrap().insert(id, session);
    if let Some(env) = credential {
        control.activate_shell(
            &env,
            id,
            &crate::modules::agent_events::TauriAgentHost(&control_app),
        );
    }
    drop(pending_credential);
    // The shell can exit before this insert (instant failure, `exit` in an rc
    // file); the waiter's reap then ran with the id absent. Re-check and reap
    // so the pseudoconsole isn't stranded.
    let finished = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .map(|s| s.finished.load(Ordering::Acquire))
        .unwrap_or(false);
    if finished {
        if let Some(s) = state.take(id) {
            thread::Builder::new()
                .name(format!("terax-pty-drop-{id}"))
                .spawn(move || session::drop_session(s))
                .expect("spawn pty drop thread");
        }
    }
    log::info!("pty opened id={id} cols={cols} rows={rows}");
    Ok(id)
}

// Input is the latency-critical path: raw body + id header skips JSON
// serialization of every keystroke on both sides of the IPC boundary.
#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let id: u32 = request
        .headers()
        .get("x-pty-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "pty_write: missing x-pty-id header".to_string())?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("pty_write: expected raw body".to_string());
    };
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_write: unknown id={id}");
            "no session".to_string()
        })?;
    // One ordered queue per session feeds a dedicated writer thread: no task
    // spawn or lock per keystroke, and the result is the real pipe write's.
    session.write(bytes.clone()).await.map_err(|e| {
        log::debug!("pty_write id={id} failed: {e}");
        e
    })
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("pty_resize: unknown id={id}");
            "no session".to_string()
        })?;
    let result = session
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            log::warn!("pty_resize id={id} failed: {e}");
            e
        });
    result
}

/// Pushes the terminal's theme so colour queries (`OSC 4/10/11/12`,
/// `CSI ? 996 n`) are answered by the reader without a webview round trip.
#[tauri::command]
pub fn pty_set_colors(
    state: tauri::State<PtyState>,
    id: u32,
    colors: TerminalColors,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| "no session".to_string())?;
    session.set_colors(colors);
    Ok(())
}

#[tauri::command]
pub fn pty_close(state: tauri::State<PtyState>, id: u32) -> Result<(), String> {
    // Detached drop: on Windows `ClosePseudoConsole` can block until conhost
    // drains, which would freeze this Tauri worker thread and stall IPC.
    match state.take(id) {
        Some(session) => {
            log::info!("pty closed id={id}");
            reap(id, session, "close");
        }
        None => log::debug!("pty_close: unknown id={id}"),
    }
    Ok(())
}

#[tauri::command]
pub fn pty_has_foreground_process(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_process: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    Ok(foreground::shell_has_children(shell_pid))
}

// Foreground-only check for the renderer hibernation path: true while a job
// owns the tty (tcgetpgrp != shell pgid). Stricter and cheaper than
// pty_has_foreground_process, which counts background children too.
#[tauri::command]
pub fn pty_has_foreground_job(state: tauri::State<PtyState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or_else(|| {
        log::warn!("pty_has_foreground_job: unknown session id={id}");
        "no session".to_string()
    })?;
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        let leader = session
            .master
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|master| master.process_group_leader());
        Ok(matches!(leader, Some(pid) if pid > 0 && pid as u32 != shell_pid))
    }
    #[cfg(windows)]
    {
        Ok(foreground::shell_has_children(shell_pid))
    }
}

// A fresh webview load orphans the previous frontend's sessions in this still
// running process; reap them on boot before any new tab spawns.
#[tauri::command]
pub fn pty_close_all(state: tauri::State<PtyState>) -> Result<usize, String> {
    let drained: Vec<(u32, Arc<Session>)> = {
        let mut sessions = state.sessions.write().unwrap();
        sessions.drain().collect()
    };
    let count = drained.len();
    for (id, session) in drained {
        state.hub.submit(Command::Unregister { id });
        reap(id, session, "close_all");
    }
    if count > 0 {
        log::info!("pty_close_all: reaped {count} orphaned session(s)");
    }
    Ok(count)
}

/// Opens (or reopens) this webview's output stream and returns the secret
/// that authorizes its `terax-pty` requests. Only the page's own frame can
/// invoke commands, so other frames and origins cannot read terminal output
/// even though the custom protocol is reachable from any frame. Reopening
/// supersedes the previous stream and detaches its terminals.
#[tauri::command]
pub async fn pty_stream_open(
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
) -> Result<String, String> {
    let (reply, token) = tokio::sync::oneshot::channel();
    state.hub.submit(Command::OpenStream {
        label: Arc::from(webview.label()),
        reply: Box::new(move |token| {
            let _ = reply.send(token);
        }),
    });
    let token = token
        .await
        .map_err(|_| "PTY stream is unavailable".to_string())?
        .map_err(|reason| {
            log::error!("pty_stream_open refused: {reason}");
            reason.to_string()
        })?;
    Ok(format!("{token:016x}"))
}

/// Reports which presentation class terminals are in. Called only when a
/// class changes; unknown ids are ignored (the terminal may have just closed).
///
/// This stays `async`, off the main thread, but async commands run on a
/// multi-threaded runtime and two reports can be applied in either order.
/// `seq` is the page's counter of reports (it only grows): a terminal ignores
/// any report not newer than the last one that named it, so the final class
/// is always the latest one sent. Making the command synchronous would order
/// arrivals only if the webview delivered separate requests in order, and
/// would put every report on the main thread for nothing.
#[tauri::command]
pub async fn pty_set_presentation(
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
    ids: Vec<u32>,
    class: PresentationClass,
    seq: u64,
) -> Result<(), String> {
    check_presentation_batch(&ids)?;
    state.hub.submit(Command::SetPresentation {
        label: Arc::from(webview.label()),
        ids,
        class,
        seq,
    });
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDiagnostics {
    host_pid: u32,
    host_rss_bytes: Option<u64>,
    hub: hub::HubDiagnostics,
    sessions: Vec<PtySessionDiagnostics>,
}

#[derive(serde::Serialize)]
struct PtySessionDiagnostics {
    id: u32,
    #[serde(flatten)]
    output: session::OutputDiagnostics,
}

#[tauri::command]
pub fn pty_diagnostics(state: tauri::State<PtyState>) -> PtyDiagnostics {
    let host_pid = std::process::id();
    let sessions = state
        .sessions
        .read()
        .unwrap()
        .iter()
        .map(|(id, session)| PtySessionDiagnostics {
            id: *id,
            output: session.diagnostics(),
        })
        .collect();
    PtyDiagnostics {
        host_pid,
        host_rss_bytes: crate::modules::proc::rss::rss_bytes(host_pid),
        hub: state.hub.diagnostics(),
        sessions,
    }
}

#[tauri::command]
pub fn pty_session_shell(
    state: tauri::State<PtyState>,
    webview: tauri::Webview,
    id: u32,
) -> Result<String, String> {
    let sessions = state.sessions.read().unwrap();
    let session = sessions.get(&id).ok_or("no session")?;
    if session.owner.as_ref() != webview.label() {
        return Err("session belongs to another webview".into());
    }
    Ok(session.shell_program.clone())
}

#[tauri::command]
pub fn pty_shell_name() -> String {
    shell_init::detect_shell_name()
}

/// What a graceful quit pass found: sessions whose work exited after SIGTERM,
/// and sessions that still had running work when the grace period ran out.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateReport {
    pub terminated: Vec<u32>,
    pub survived: Vec<u32>,
}

/// Longest grace period a caller may ask for. A quit that waited longer would
/// look like a hung window, and the answer is the same: ask the user.
const MAX_TERMINATE_GRACE_MS: u64 = 10_000;

/// Sends SIGTERM to the work a terminal started and waits, bounded, for it to
/// exit. **It never escalates**: a job that ignores SIGTERM is reported as a
/// survivor so the window can ask before forcing, and forcing stays the
/// separate, explicitly confirmed `pty_close_all`.
fn terminate_sessions(
    state: &PtyState,
    ids: Vec<u32>,
    grace_ms: u64,
) -> TerminateReport {
    let grace = grace_ms.min(MAX_TERMINATE_GRACE_MS);
    let targets: Vec<(u32, Arc<Session>)> = {
        let sessions = state.sessions.read().unwrap();
        ids.into_iter()
            .filter_map(|id| sessions.get(&id).map(|session| (id, session.clone())))
            .collect()
    };

    for (id, session) in &targets {
        signal_app_owned_work(session);
        log::info!("pty_terminate: asked id={id} to exit");
    }

    // Poll instead of sleeping the whole grace: a cooperating job is usually
    // gone in a few milliseconds, and quit should not wait for the bound.
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(grace);
    loop {
        let busy: Vec<u32> = targets
            .iter()
            .filter(|(_, session)| session_has_work(session))
            .map(|(id, _)| *id)
            .collect();
        if busy.is_empty() || std::time::Instant::now() >= deadline {
            let survived = busy;
            let terminated = targets
                .iter()
                .map(|(id, _)| *id)
                .filter(|id| !survived.contains(id))
                .collect();
            return TerminateReport {
                terminated,
                survived,
            };
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

fn session_has_work(session: &Session) -> bool {
    if session.shell_pid == 0 {
        return false;
    }
    if foreground::shell_has_children(session.shell_pid) {
        return true;
    }
    // The shell going away is the work ending too; a session whose process is
    // gone is not "still running".
    #[cfg(unix)]
    {
        unsafe { libc::kill(session.shell_pid as i32, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// SIGTERM for the job group the terminal is showing, plus any children of the
/// shell that job control did not put in that group (background jobs, and every
/// shell without job control, which includes `sh -c`).
#[cfg(unix)]
fn signal_app_owned_work(session: &Session) {
    let shell_pid = session.shell_pid;
    if shell_pid == 0 {
        return;
    }
    let shell_pid = shell_pid as i32;
    let own_group = unsafe { libc::getpgid(0) };
    let foreground_group = session
        .master
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|master| master.process_group_leader());
    let shell_group = unsafe { libc::getpgid(shell_pid) };

    if let Some(group) = foreground_group {
        // Never signal our own group, pid 1, or the shell's own group: the
        // shell must outlive this pass so survivors can be reported honestly.
        if group > 1 && group != shell_group && group != own_group {
            unsafe {
                libc::kill(-group, libc::SIGTERM);
            }
        }
    }

    for child in foreground::children_of(shell_pid as u32) {
        let child = child as i32;
        if child <= 1 || child == shell_pid {
            continue;
        }
        // A child that made itself a group leader takes its own children with
        // it; anything else is signalled on its own.
        if unsafe { libc::getpgid(child) } == child && child != own_group {
            unsafe {
                libc::kill(-child, libc::SIGTERM);
            }
        } else {
            unsafe {
                libc::kill(child, libc::SIGTERM);
            }
        }
    }
}

#[cfg(not(unix))]
fn signal_app_owned_work(_session: &Session) {
    // Windows has no SIGTERM-handling contract for console programs; the
    // graceful pass reports the work as surviving so quit asks before forcing.
}

/// Asks the terminals' app-owned work to exit, then reports which terminals
/// still have running work. Bounded and non-escalating; the window decides
/// whether to offer a force.
#[tauri::command]
pub async fn pty_terminate(
    app: tauri::AppHandle,
    ids: Vec<u32>,
    grace_ms: u64,
) -> Result<TerminateReport, String> {
    // `terminate_sessions` waits (bounded) on the OS; keep it off the runtime's
    // worker threads and off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PtyState>();
        terminate_sessions(state.inner(), ids, grace_ms)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pty_list_shells() -> Vec<shell_init::ShellInfo> {
    shell_init::list_shells()
}

#[cfg(all(test, unix))]
mod tests {
    use super::session::{spawn_with, Host};
    use super::*;
    use portable_pty::CommandBuilder;
    use std::time::{Duration, Instant};

    fn open(state: &Arc<PtyState>, id: u32, owner: &str) -> Arc<Session> {
        open_in_pane(state, id, owner, None)
    }

    fn open_in_pane(
        state: &Arc<PtyState>,
        id: u32,
        owner: &str,
        pane_id: Option<u32>,
    ) -> Arc<Session> {
        let reaper = state.clone();
        let session = spawn_with(
            Host {
                id,
                owner: Arc::from(owner),
                hub: state.hub.clone(),
                class: PresentationClass::Hidden,
                signal: Arc::new(|_| {}),
                notify: Arc::new(|_| {}),
                pane_id,
                link: agent_detect::AgentLink::new(),
                reap: Box::new(move || {
                    if let Some(session) = reaper.take(id) {
                        session::drop_session(session);
                    }
                }),
                colors: None,
            },
            PtySize::default(),
            || {
                let mut command = CommandBuilder::new("/bin/sh");
                command.arg("-c");
                command.arg("sleep 30");
                Ok(command)
            },
        )
        .unwrap();
        state.sessions.write().unwrap().insert(id, session.clone());
        session
    }

    fn wait_for(what: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A terminal whose shell runs `script` (the `open` helper pins `sleep 30`).
    fn open_running(state: &Arc<PtyState>, id: u32, script: &str) -> Arc<Session> {
        let reaper = state.clone();
        let session = spawn_with(
            Host {
                id,
                owner: Arc::from("main"),
                hub: state.hub.clone(),
                class: PresentationClass::Hidden,
                signal: Arc::new(|_| {}),
                notify: Arc::new(|_| {}),
                pane_id: None,
                link: agent_detect::AgentLink::new(),
                reap: Box::new(move || {
                    if let Some(session) = reaper.take(id) {
                        session::drop_session(session);
                    }
                }),
                colors: None,
            },
            PtySize::default(),
            || {
                let mut command = CommandBuilder::new("/bin/sh");
                command.arg("-c");
                command.arg(script);
                Ok(command)
            },
        )
        .unwrap();
        state.sessions.write().unwrap().insert(id, session.clone());
        session
    }

    #[test]
    fn graceful_termination_ends_a_cooperating_job() {
        let state = Arc::new(PtyState::default());
        // A trailing command keeps the shell from exec-ing its only child, which
        // is how a foreground job looks in a real terminal.
        let session = open_running(&state, 1, "sleep 30; true");
        wait_for("the shell to start its job", || {
            foreground::shell_has_children(session.shell_pid)
        });

        let report = terminate_sessions(&state, vec![1], 3000);

        assert_eq!(report.terminated, vec![1]);
        assert!(report.survived.is_empty());
        wait_for("the job to exit after SIGTERM", || {
            !foreground::shell_has_children(session.shell_pid)
        });
    }

    #[test]
    fn graceful_termination_reports_a_job_that_ignores_sigterm_without_killing_it() {
        let state = Arc::new(PtyState::default());
        // The child ignores SIGTERM, so only an explicit force can end it. It
        // writes a marker once the trap is in place: signalling in the window
        // between fork and `trap` would kill it with the default disposition and
        // the test would prove nothing (and, under a loaded machine, flake).
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        let session = open_running(
            &state,
            1,
            &format!(
                r#"sh -c 'trap "" TERM; printf ok > {}; exec sleep 30'; true"#,
                ready.display()
            ),
        );
        wait_for("the job to install its TERM trap", || {
            ready.exists() && foreground::shell_has_children(session.shell_pid)
        });

        let report = terminate_sessions(&state, vec![1], 400);

        assert_eq!(report.survived, vec![1]);
        assert!(report.terminated.is_empty());
        // Asking is not killing: the job is still there.
        assert!(foreground::shell_has_children(session.shell_pid));

        // The separate, explicitly confirmed escalation ends it.
        if let Some(session) = state.take(1) {
            reap(1, session, "test cleanup");
        }
        wait_for("the forced job to exit", || {
            !foreground::shell_has_children(session.shell_pid)
        });
    }

    #[test]
    fn graceful_termination_ignores_terminals_that_are_already_gone() {
        let state = Arc::new(PtyState::default());
        let report = terminate_sessions(&state, vec![42], 100);
        assert!(report.terminated.is_empty());
        assert!(report.survived.is_empty());
    }

    #[test]
    fn presentation_batches_are_bounded_at_the_boundary() {
        assert!(check_presentation_batch(&[]).is_ok());
        assert!(check_presentation_batch(&vec![1; MAX_PRESENTATION_BATCH]).is_ok());
        assert!(check_presentation_batch(&vec![1; MAX_PRESENTATION_BATCH + 1]).is_err());
    }

    #[test]
    fn reloading_a_page_stops_its_terminals_streaming_but_leaves_them_for_pty_close_all() {
        let state = Arc::new(PtyState::default());
        let main = open(&state, 1, "main");
        let other = open(&state, 2, "settings");
        state.reset_webview("main");
        wait_for("main's output to close", || main.queue_closed());
        assert!(!other.queue_closed());
        // Both sessions are still registered: only pty_close_all reaps them.
        assert_eq!(state.sessions.read().unwrap().len(), 2);
        for id in [1, 2] {
            if let Some(session) = state.take(id) {
                reap(id, session, "test cleanup");
            }
        }
    }

    #[test]
    fn a_pane_resolves_to_its_newest_live_terminal_only() {
        let state = Arc::new(PtyState::default());
        let first = open_in_pane(&state, 1, "main", Some(7));
        let other = open_in_pane(&state, 2, "main", Some(8));
        let unbound = open(&state, 3, "main");
        assert_eq!(state.pane_target(7).map(|t| t.pty_id), Some(1));
        assert_eq!(state.pane_target(8).map(|t| t.pty_id), Some(2));
        assert!(state.pane_target(9).is_none());

        // A respawn in the same pane wins over the older terminal.
        let respawn = open_in_pane(&state, 4, "main", Some(7));
        let target = state.pane_target(7).unwrap();
        assert_eq!(target.pty_id, 4);
        assert_eq!(&*target.owner, "main");
        assert!(std::sync::Arc::ptr_eq(&target.link, &respawn.link));

        // A closed or finished terminal is no longer reachable.
        drop(state.take(4));
        assert_eq!(state.pane_target(7).map(|t| t.pty_id), Some(1));
        first.finished.store(true, Ordering::Release);
        assert!(state.pane_target(7).is_none());
        let _ = (other, unbound);
        for id in [1, 2, 3] {
            if let Some(session) = state.take(id) {
                reap(id, session, "test cleanup");
            }
        }
    }

    #[test]
    fn destroying_a_webview_closes_exactly_its_terminals() {
        let state = Arc::new(PtyState::default());
        let doomed = open(&state, 1, "main");
        let survivor = open(&state, 2, "settings");
        let pid = doomed.shell_pid as i32;
        drop(doomed);
        state.destroy_webview("main");
        assert!(state.sessions.read().unwrap().get(&1).is_none());
        assert!(state.sessions.read().unwrap().get(&2).is_some());
        wait_for("the shell to be killed", || unsafe {
            let mut status = 0;
            libc::waitpid(pid, &mut status, libc::WNOHANG) == pid || libc::kill(pid, 0) != 0
        });
        assert!(!survivor.queue_closed());
        if let Some(session) = state.take(2) {
            reap(2, session, "test cleanup");
        }
    }
}

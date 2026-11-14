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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::PtySize;
use tauri::Manager;

use crate::modules::control::ControlState;
use crate::modules::space_isolation::{AccountIsolationMode, SpaceIsolationRegistry};
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

#[derive(Clone)]
struct ReapTarget {
    space_id: Option<String>,
    pane_id: Option<u32>,
    shell_pid: u32,
    child_exited: Arc<(Mutex<bool>, Condvar)>,
    #[cfg(unix)]
    targets: ProcessTargets,
}

#[cfg(unix)]
#[derive(Clone, Default)]
struct ProcessTargets {
    pgids: Vec<i32>,
    pids: Vec<i32>,
}

#[derive(Clone)]
pub struct PtyState {
    sessions: Arc<RwLock<HashMap<u32, Arc<Session>>>>,
    reaping: Arc<Mutex<HashMap<u32, ReapTarget>>>,
    // Starts at 1 so freshly-handed-out ids are never 0, which the frontend
    // sometimes treats as "unset". Increments monotonically; never reused.
    next_id: Arc<AtomicU32>,
    hub: Hub,
    /// Resolved from the app's config on the first `terax-pty` request.
    origins: Arc<OnceLock<crate::modules::webview_origin::AllowedOrigins>>,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            reaping: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU32::new(1)),
            hub: Hub::new(),
            origins: Arc::new(OnceLock::new()),
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
            self.reap_tracked(id, session, "webview destroyed");
        }
    }

    fn reap_tracked(&self, id: u32, session: Arc<Session>, reason: &str) {
        let entry = ReapTarget::from_session(&session);
        self.reaping.lock().unwrap().insert(id, entry);
        let child_exited = session.child_exited.clone();
        reap_with_cleanup(id, session, reason, move || {
            if *child_exited.0.lock().unwrap() {
                // Keep cleanup lightweight: prune exited entries on next stop/reap.
            }
        });
        self.prune_finished_reaps();
    }

    fn prune_finished_reaps(&self) {
        self.reaping
            .lock()
            .unwrap()
            .retain(|_, entry| !entry.is_completely_dead());
    }

    /// Native window occlusion or system sleep: every terminal of the window
    /// drops to the occluded cadence without a frontend round trip.
    pub fn set_window_hidden(&self, label: &str, hidden: bool) {
        self.hub.submit(Command::WindowHidden {
            label: Arc::from(label),
            hidden,
        });
    }

    /// Stops every Space-owned terminal PTY and POSIX process group,
    /// escalating SIGTERM -> grace -> SIGKILL as needed, and awaits process
    /// exit before returning so profile directories are never deleted under
    /// live agent processes.
    pub(crate) fn stop_space_sessions(
        &self,
        space_id: &str,
        pane_ids: &[u32],
        grace_ms: u64,
    ) -> Result<(), String> {
        let matches_space = |s_space: Option<&str>, s_pane: Option<u32>| -> bool {
            s_space == Some(space_id) || s_pane.is_some_and(|pane| pane_ids.contains(&pane))
        };

        let live: Vec<(u32, Arc<Session>)> = {
            let mut sessions = self.sessions.write().unwrap();
            let ids: Vec<u32> = sessions
                .iter()
                .filter(|(_, s)| matches_space(s.space_id.as_deref(), s.pane_id))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| sessions.remove(&id).map(|s| (id, s)))
                .collect()
        };
        for (id, _) in &live {
            self.hub.submit(Command::Unregister { id: *id });
        }

        let in_flight: Vec<ReapTarget> = {
            self.prune_finished_reaps();
            self.reaping
                .lock()
                .unwrap()
                .values()
                .filter(|entry| matches_space(entry.space_id.as_deref(), entry.pane_id))
                .cloned()
                .collect()
        };

        if live.is_empty() && in_flight.is_empty() {
            return Ok(());
        }

        #[cfg(unix)]
        let mut live_targets: Vec<(&Arc<Session>, ProcessTargets)> = live
            .iter()
            .map(|(_, s)| (s, capture_session_targets(s)))
            .collect();

        #[cfg(unix)]
        for (_, targets) in &live_targets {
            signal_targets(targets, libc::SIGTERM);
        }

        #[cfg(not(unix))]
        for (_, session) in &live {
            session.close_output();
            let _ = session.killer.lock().unwrap().kill();
        }

        let grace = Duration::from_millis(grace_ms.min(MAX_TERMINATE_GRACE_MS));
        let grace_deadline = Instant::now() + grace;

        loop {
            let all_live_done = {
                #[cfg(unix)]
                {
                    live_targets
                        .iter()
                        .all(|(s, t)| *s.child_exited.0.lock().unwrap() && !t.any_alive())
                }
                #[cfg(not(unix))]
                {
                    live.iter().all(|(_, s)| *s.child_exited.0.lock().unwrap())
                }
            };
            let all_inflight_done = in_flight.iter().all(ReapTarget::is_completely_dead);
            if all_live_done && all_inflight_done {
                break;
            }
            if Instant::now() >= grace_deadline {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        // Escalate any survivor via SIGKILL (plus any children spawned during grace).
        #[cfg(unix)]
        for (session, targets) in &mut live_targets {
            if !*session.child_exited.0.lock().unwrap() || targets.any_alive() {
                session.close_output();
                targets.merge(capture_session_targets(session));
                signal_targets(targets, libc::SIGKILL);
                let _ = session.killer.lock().unwrap().kill();
            }
        }
        #[cfg(unix)]
        for entry in &in_flight {
            if !entry.is_completely_dead() {
                let mut refreshed = entry.targets.clone();
                refreshed.merge(capture_descendants_of_pid(entry.shell_pid));
                signal_targets(&refreshed, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        for (_, session) in &live {
            if !*session.child_exited.0.lock().unwrap() {
                session.close_output();
                let _ = session.killer.lock().unwrap().kill();
            }
        }

        let kill_deadline = Instant::now() + Duration::from_millis(3_000);
        let mut timed_out = false;
        loop {
            let all_live_done = {
                #[cfg(unix)]
                {
                    live_targets.iter().all(|(s, t)| {
                        *s.child_exited.0.lock().unwrap()
                            && !t.any_alive()
                            && capture_session_targets(s).is_dead()
                    })
                }
                #[cfg(not(unix))]
                {
                    live.iter().all(|(_, s)| *s.child_exited.0.lock().unwrap())
                }
            };
            let all_inflight_done = in_flight.iter().all(ReapTarget::is_completely_dead);
            if all_live_done && all_inflight_done {
                break;
            }
            if Instant::now() >= kill_deadline {
                timed_out = true;
                break;
            }
            thread::sleep(Duration::from_millis(15));
        }

        for (id, session) in live {
            session.close_output();
            spawn_drop_thread(id, session);
        }
        self.prune_finished_reaps();

        if timed_out {
            return Err("Timed out waiting for Space terminal processes to exit".to_string());
        }
        Ok(())
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

fn spawn_drop_thread(id: u32, session: Arc<Session>) {
    thread::Builder::new()
        .name(format!("terax-pty-drop-{id}"))
        .spawn(move || {
            let t0 = Instant::now();
            session::drop_session(session);
            log::info!(
                "pty session id={id} dropped in {}ms",
                t0.elapsed().as_millis()
            );
        })
        .expect("spawn pty drop thread");
}

fn reap_with_cleanup(
    id: u32,
    session: Arc<Session>,
    reason: &str,
    on_done: impl FnOnce() + Send + 'static,
) {
    session.close_output();
    if let Err(e) = session.killer.lock().unwrap().kill() {
        // Non-fatal: the child may already have exited on its own (e.g. the
        // user ran `exit`). Log so this isn't invisible during debugging.
        log::debug!("pty {reason}: kill id={id} returned {e}");
    }
    thread::Builder::new()
        .name(format!("terax-pty-drop-{id}"))
        .spawn(move || {
            let t0 = Instant::now();
            session::drop_session(session);
            on_done();
            log::info!(
                "pty session id={id} dropped in {}ms",
                t0.elapsed().as_millis()
            );
        })
        .expect("spawn pty drop thread");
}

/// Closes output, kills the child and drops the session off the caller's
/// thread (`ClosePseudoConsole` can block until conhost drains).
#[cfg(test)]
fn reap(id: u32, session: Arc<Session>, reason: &str) {
    reap_with_cleanup(id, session, reason, || {});
}

impl ReapTarget {
    fn from_session(session: &Session) -> Self {
        Self {
            space_id: session.space_id.clone(),
            pane_id: session.pane_id,
            shell_pid: session.shell_pid,
            child_exited: session.child_exited.clone(),
            #[cfg(unix)]
            targets: capture_session_targets(session),
        }
    }

    fn is_completely_dead(&self) -> bool {
        let exited = *self.child_exited.0.lock().unwrap();
        if !exited {
            return false;
        }
        #[cfg(unix)]
        {
            !self.targets.any_alive() && !raw_pid_is_alive(self.shell_pid)
        }
        #[cfg(not(unix))]
        {
            let _ = self.shell_pid;
            true
        }
    }
}

#[cfg(unix)]
impl ProcessTargets {
    fn merge(&mut self, other: Self) {
        for pgid in other.pgids {
            if !self.pgids.contains(&pgid) {
                self.pgids.push(pgid);
            }
        }
        for pid in other.pids {
            if !self.pids.contains(&pid) {
                self.pids.push(pid);
            }
        }
    }

    fn any_alive(&self) -> bool {
        self.pgids.iter().copied().any(pgid_has_alive_process)
            || self
                .pids
                .iter()
                .copied()
                .any(|p| raw_pid_is_alive(p as u32))
    }

    fn is_dead(&self) -> bool {
        !self.any_alive()
    }
}

#[cfg(unix)]
fn raw_pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn pgid_has_alive_process(pgid: i32) -> bool {
    if pgid <= 1 {
        return false;
    }
    let rc = unsafe { libc::kill(-pgid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
fn capture_descendants_of_pid(root_pid: u32) -> ProcessTargets {
    let mut targets = ProcessTargets::default();
    if root_pid == 0 {
        return targets;
    }
    let own_pid = unsafe { libc::getpid() };
    let own_group = unsafe { libc::getpgid(0) };

    let mut queue = vec![root_pid];
    let mut seen = HashSet::new();
    seen.insert(root_pid);

    while let Some(pid) = queue.pop() {
        let pid_i = pid as i32;
        if pid_i > 1 && pid_i != own_pid {
            targets.pids.push(pid_i);
            let pgid = unsafe { libc::getpgid(pid_i) };
            if pgid > 1 && pgid != own_group && !targets.pgids.contains(&pgid) {
                targets.pgids.push(pgid);
            }
        }
        for child in foreground::children_of(pid) {
            if seen.insert(child) {
                queue.push(child);
            }
        }
    }
    targets
}

#[cfg(unix)]
fn capture_session_targets(session: &Session) -> ProcessTargets {
    let mut targets = capture_descendants_of_pid(session.shell_pid);
    let own_group = unsafe { libc::getpgid(0) };
    let fg_group = session
        .master
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|master| master.process_group_leader());
    if let Some(pgid) = fg_group {
        if pgid > 1 && pgid != own_group && !targets.pgids.contains(&pgid) {
            targets.pgids.push(pgid);
        }
    }
    targets
}

#[cfg(unix)]
fn signal_targets(targets: &ProcessTargets, sig: i32) {
    let own_pid = unsafe { libc::getpid() };
    let own_group = unsafe { libc::getpgid(0) };
    for &pgid in &targets.pgids {
        if pgid > 1 && pgid != own_group {
            unsafe {
                libc::kill(-pgid, sig);
            }
        }
    }
    for &pid in &targets.pids {
        if pid > 1 && pid != own_pid {
            unsafe {
                libc::kill(pid, sig);
            }
        }
    }
}

pub(crate) fn preflight_pty_open(
    isolation: &SpaceIsolationRegistry,
    space_id: Option<&str>,
    expected_isolation: Option<AccountIsolationMode>,
    is_wsl: bool,
) -> Result<Option<crate::modules::space_profile::IsolatedProfileEnv>, String> {
    isolation.prepare_pty_isolation(space_id, expected_isolation, is_wsl, false)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_open(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, PtyState>,
    control: tauri::State<'_, ControlState>,
    isolation: tauri::State<'_, SpaceIsolationRegistry>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    workspace: Option<WorkspaceEnv>,
    blocks: Option<bool>,
    shell: Option<String>,
    pane_id: Option<u32>,
    presentation: Option<PresentationClass>,
    colors: Option<TerminalColors>,
    space_id: Option<String>,
    expected_isolation: Option<AccountIsolationMode>,
) -> Result<u32, String> {
    let workspace = WorkspaceEnv::from_option(workspace);
    let isolation_registry = isolation.inner().clone();
    let preflight_space_id = space_id.clone();
    let preflight_is_wsl = workspace.is_wsl();
    let isolated_env = tauri::async_runtime::spawn_blocking(move || {
        preflight_pty_open(
            &isolation_registry,
            preflight_space_id.as_deref(),
            expected_isolation,
            preflight_is_wsl,
        )
    })
    .await
    .map_err(|e| {
        crate::modules::space_isolation::sanitize_error_message(&format!(
            "pty_open preflight failed: {e}"
        ))
    })??;
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
            isolated_env,
            colors,
            pane_id,
            space_id,
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
            state.reap_tracked(id, session, "close");
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
        state.reap_tracked(id, session, "close_all");
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
fn terminate_sessions(state: &PtyState, ids: Vec<u32>, grace_ms: u64) -> TerminateReport {
    let grace = grace_ms.min(MAX_TERMINATE_GRACE_MS);
    let targets: Vec<(u32, Arc<Session>)> = {
        let sessions = state.sessions.read().unwrap();
        ids.into_iter()
            .filter_map(|id| sessions.get(&id).map(|session| (id, session.clone())))
            .collect()
    };

    for (id, session) in &targets {
        signal_app_owned_work(session);
        log::info!(
            "pty_terminate: asked id={id} (shell={} children={}) to exit",
            session.shell_pid,
            foreground::children_of(session.shell_pid).len()
        );
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

/// "Is there still work in this terminal?" means *children of the shell*, not
/// "is the shell alive": every terminal has a shell, so counting the shell would
/// report an idle prompt as a survivor and turn every quit into a force prompt.
/// A shell that exits takes its children with it, so this is also false once the
/// work is gone.
fn session_has_work(session: &Session) -> bool {
    session.shell_pid != 0 && foreground::shell_has_children(session.shell_pid)
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
                space_id: None,
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
                space_id: None,
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
    fn an_idle_shell_waiting_for_input_is_not_a_survivor() {
        // Regression: counting "the shell process is alive" as work made every
        // idle terminal a survivor, so every quit ended in a force prompt.
        let state = Arc::new(PtyState::default());
        let session = open_running(&state, 1, "read line");
        wait_for("the shell to block on input", || {
            !foreground::shell_has_children(session.shell_pid)
        });

        let report = terminate_sessions(&state, vec![1], 200);

        assert_eq!(report.terminated, vec![1]);
        assert!(report.survived.is_empty());
        // Nothing was signalled, so the idle shell is still there.
        assert_eq!(
            unsafe { libc::kill(session.shell_pid as i32, 0) },
            0,
            "an idle shell must not be terminated by the graceful pass"
        );
        if let Some(session) = state.take(1) {
            reap(1, session, "test cleanup");
        }
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

    #[test]
    fn pty_open_preflight_provisions_isolated_space_and_blocks_failures_before_spawn() {
        use std::ffi::OsString;
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let host_home = dir.path().join("host-home");
        std::fs::create_dir_all(&host_home).unwrap();
        let manifest_path = dir.path().join("space-isolation").join("manifest.json");
        let profiles_dir = dir.path().join("space-profiles");
        let registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path.clone(),
            Some(profiles_dir.clone()),
            Some(host_home.clone()),
            Some(OsString::new()),
        );
        registry
            .register_space("sp-default", AccountIsolationMode::Default)
            .unwrap();
        registry
            .register_space("sp-iso", AccountIsolationMode::Isolated)
            .unwrap();
        registry
            .register_space("sp-tomb", AccountIsolationMode::Default)
            .unwrap();
        registry
            .record_tombstone("sp-tomb", None, Some("pending cleanup".to_string()))
            .unwrap();

        assert!(
            preflight_pty_open(&registry, None, Some(AccountIsolationMode::Default), false)
                .is_err()
        );
        assert!(preflight_pty_open(&registry, Some("sp-default"), None, false).is_err());
        assert!(preflight_pty_open(
            &registry,
            Some("sp-unregistered"),
            Some(AccountIsolationMode::Default),
            false,
        )
        .is_err());
        assert!(preflight_pty_open(
            &registry,
            Some("sp-default"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .is_err());
        assert!(preflight_pty_open(
            &registry,
            Some("sp-iso"),
            Some(AccountIsolationMode::Default),
            false,
        )
        .is_err());
        assert!(preflight_pty_open(
            &registry,
            Some("sp-tomb"),
            Some(AccountIsolationMode::Default),
            false,
        )
        .is_err());
        // WSL is out of scope for Space profile isolation and must fail closed.
        assert!(preflight_pty_open(
            &registry,
            Some("sp-iso"),
            Some(AccountIsolationMode::Isolated),
            true,
        )
        .is_err());

        // Valid isolated preflight returns Space profile paths without touching host ~/.claude.
        let iso_env = preflight_pty_open(
            &registry,
            Some("sp-iso"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .unwrap()
        .expect("isolated space should resolve IsolatedProfileEnv");
        assert_eq!(iso_env.shim_dir, profiles_dir.join("sp-iso").join("bin"));
        assert_eq!(
            iso_env.claude_config_dir,
            profiles_dir.join("sp-iso").join("claude")
        );
        assert!(!host_home.join(".claude").exists());

        // Tampering permissions or broken profiles root blocks pty_open fail-closed.
        #[cfg(unix)]
        {
            std::fs::set_permissions(
                &iso_env.claude_config_dir,
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
            assert!(preflight_pty_open(
                &registry,
                Some("sp-iso"),
                Some(AccountIsolationMode::Isolated),
                false,
            )
            .is_err());
        }
        let no_profiles_registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path,
            None,
            Some(host_home),
            Some(OsString::new()),
        );
        assert!(preflight_pty_open(
            &no_profiles_registry,
            Some("sp-iso"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .is_err());

        assert_eq!(
            preflight_pty_open(
                &registry,
                Some("sp-default"),
                Some(AccountIsolationMode::Default),
                false,
            )
            .unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn parallel_isolated_spaces_run_independently_without_touching_home_or_xdg() {
        use std::ffi::OsString;
        let dir = tempfile::tempdir().unwrap();
        let host_home = dir.path().join("host-home");
        std::fs::create_dir_all(host_home.join(".claude")).unwrap();
        let host_claude_sentinel = r#"{"hostSecret":true}"#;
        std::fs::write(
            host_home.join(".claude/.credentials.json"),
            host_claude_sentinel,
        )
        .unwrap();

        let manifest_path = dir.path().join("space-isolation/manifest.json");
        let profiles_dir = dir.path().join("space-profiles");
        let registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path.clone(),
            Some(profiles_dir.clone()),
            Some(host_home.clone()),
            Some(OsString::new()),
        );
        registry
            .register_space("sp-alpha", AccountIsolationMode::Isolated)
            .unwrap();
        registry
            .register_space("sp-beta", AccountIsolationMode::Isolated)
            .unwrap();

        let env_alpha = preflight_pty_open(
            &registry,
            Some("sp-alpha"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .unwrap()
        .unwrap();
        let env_beta = preflight_pty_open(
            &registry,
            Some("sp-beta"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .unwrap()
        .unwrap();

        let expected_home = std::env::var_os("HOME").unwrap_or_default();
        let state = Arc::new(PtyState::default());

        let spawn_probe = |pty_id: u32,
                           iso: &crate::modules::space_profile::IsolatedProfileEnv,
                           token: &str,
                           out_file: &std::path::Path| {
            let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
            shell_init::apply_common(
                &mut cmd,
                Some(dir.path().to_string_lossy().into_owned()),
                false,
                None,
                Some(iso),
            );
            let script = format!(
                "printf 'HOME=%s\\nCLAUDE=%s\\nPATH0=%s\\n' \"$HOME\" \"$CLAUDE_CONFIG_DIR\" \"${{PATH%%:*}}\" > '{out}'; printf '{tok}' > \"$CLAUDE_CONFIG_DIR/.credentials.json\"",
                out = out_file.display(),
                tok = token,
            );
            cmd.args(["-c", &script]);
            let s = session::spawn_with(
                session::Host {
                    id: pty_id,
                    owner: Arc::from("main"),
                    hub: state.hub.clone(),
                    class: PresentationClass::default(),
                    signal: Arc::new(|_| {}),
                    notify: Arc::new(|_| {}),
                    pane_id: None,
                    space_id: None,
                    link: agent_detect::AgentLink::new(),
                    reap: Box::new(|| {}),
                    colors: None,
                },
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                move || Ok(cmd),
            )
            .unwrap();
            state
                .sessions
                .write()
                .unwrap()
                .insert(pty_id, Arc::clone(&s));
            s
        };

        let out_alpha = dir.path().join("probe-alpha.txt");
        let out_beta = dir.path().join("probe-beta.txt");
        let creds_alpha = env_alpha.claude_config_dir.join(".credentials.json");
        let creds_beta = env_beta.claude_config_dir.join(".credentials.json");
        let _s_alpha = spawn_probe(101, &env_alpha, "alpha-login", &out_alpha);
        let _s_beta = spawn_probe(102, &env_beta, "beta-login", &out_beta);

        wait_for(
            "both parallel isolated PTYs to write isolated files",
            || {
                creds_alpha.exists()
                    && creds_beta.exists()
                    && out_alpha.exists()
                    && out_beta.exists()
            },
        );

        let report_alpha = std::fs::read_to_string(&out_alpha).unwrap();
        let report_beta = std::fs::read_to_string(&out_beta).unwrap();
        assert!(report_alpha.contains(&format!("HOME={}", expected_home.to_string_lossy())));
        assert!(report_beta.contains(&format!("HOME={}", expected_home.to_string_lossy())));
        assert!(report_alpha.contains(&format!("CLAUDE={}", env_alpha.claude_config_dir.display())));
        assert!(report_beta.contains(&format!("CLAUDE={}", env_beta.claude_config_dir.display())));
        assert!(report_alpha.contains(&format!("PATH0={}", env_alpha.shim_dir.display())));
        assert!(report_beta.contains(&format!("PATH0={}", env_beta.shim_dir.display())));

        // Simulated independent Space credentials persist across registry reload.
        assert_eq!(
            std::fs::read_to_string(env_alpha.claude_config_dir.join(".credentials.json")).unwrap(),
            "alpha-login"
        );
        assert_eq!(
            std::fs::read_to_string(env_beta.claude_config_dir.join(".credentials.json")).unwrap(),
            "beta-login"
        );
        assert_eq!(
            std::fs::read_to_string(host_home.join(".claude/.credentials.json")).unwrap(),
            host_claude_sentinel
        );

        let reloaded = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path,
            Some(profiles_dir),
            Some(host_home),
            Some(OsString::new()),
        );
        assert!(preflight_pty_open(
            &reloaded,
            Some("sp-alpha"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .is_ok());
        assert!(preflight_pty_open(
            &reloaded,
            Some("sp-beta"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .is_ok());

        for id in [101, 102] {
            if let Some(session) = state.take(id) {
                reap(id, session, "test cleanup");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn parallel_isolated_opencode_spaces_isolate_db_and_config_while_preserving_shell_xdg() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let host_home = dir.path().join("host-home");
        let host_opencode_cfg = host_home.join(".config/opencode");
        let host_opencode_data = host_home.join(".local/share/opencode");
        let host_opencode_bin_dir = host_home.join(".opencode/bin");
        std::fs::create_dir_all(host_opencode_cfg.join("plugins")).unwrap();
        std::fs::create_dir_all(&host_opencode_data).unwrap();
        std::fs::create_dir_all(&host_opencode_bin_dir).unwrap();
        std::fs::write(
            host_opencode_cfg.join("opencode.json"),
            r#"{"model":"shared-sonnet"}"#,
        )
        .unwrap();
        std::fs::write(host_opencode_cfg.join("AGENTS.md"), "# Shared Rules").unwrap();
        std::fs::write(
            host_opencode_cfg.join("service.json"),
            r#"{"password":"host-daemon-password"}"#,
        )
        .unwrap();
        std::fs::write(
            host_opencode_cfg.join("cli.json"),
            r#"{"serverUrl":"http://127.0.0.1:4096"}"#,
        )
        .unwrap();
        let host_db_sentinel = "host-opencode-db-untouched";
        std::fs::write(host_opencode_data.join("opencode.db"), host_db_sentinel).unwrap();

        let stub_opencode = host_opencode_bin_dir.join("opencode");
        std::fs::write(
            &stub_opencode,
            "#!/bin/sh\n\
             if [ \"$1\" = \"--help\" ]; then\n\
               printf 'FLAGS\\n  --standalone\\n'\n\
               exit 0\n\
             fi\n\
             mkdir -p \"$XDG_DATA_HOME/opencode\" \"$XDG_STATE_HOME/opencode\" \"$XDG_CACHE_HOME/opencode\"\n\
             printf 'ARGS=%s\\nCFG=%s\\nHAS_OPENCODE_JSON=%s\\nHAS_SERVICE_JSON=%s\\nHAS_CLI_JSON=%s\\n' \\\n\
               \"$*\" \"$OPENCODE_CONFIG_DIR\" \\\n\
               \"$([ -f \"$OPENCODE_CONFIG_DIR/opencode.json\" ] && echo yes || echo no)\" \\\n\
               \"$([ -e \"$OPENCODE_CONFIG_DIR/service.json\" ] && echo yes || echo no)\" \\\n\
               \"$([ -e \"$OPENCODE_CONFIG_DIR/cli.json\" ] && echo yes || echo no)\" \\\n\
               > \"$XDG_STATE_HOME/opencode/run.log\"\n\
             printf '%s' \"$2\" > \"$XDG_DATA_HOME/opencode/opencode.db\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&stub_opencode, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path_with_opencode = std::env::join_paths([
            host_opencode_bin_dir.as_path(),
            std::path::Path::new("/usr/bin"),
            std::path::Path::new("/bin"),
        ])
        .unwrap();

        let manifest_path = dir.path().join("space-isolation/manifest.json");
        let profiles_dir = dir.path().join("space-profiles");
        let registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path.clone(),
            Some(profiles_dir.clone()),
            Some(host_home.clone()),
            Some(path_with_opencode.clone()),
        );
        registry
            .register_space("sp-alpha", AccountIsolationMode::Isolated)
            .unwrap();
        registry
            .register_space("sp-beta", AccountIsolationMode::Isolated)
            .unwrap();

        let env_alpha = preflight_pty_open(
            &registry,
            Some("sp-alpha"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .unwrap()
        .unwrap();
        let env_beta = preflight_pty_open(
            &registry,
            Some("sp-beta"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .unwrap()
        .unwrap();

        let state = Arc::new(PtyState::default());
        let host_xdg_data = dir.path().join("host-xdg-data");
        let host_xdg_cfg = dir.path().join("host-xdg-cfg");
        std::fs::create_dir_all(&host_xdg_data).unwrap();
        std::fs::create_dir_all(&host_xdg_cfg).unwrap();

        let spawn_opencode_pty = |pty_id: u32,
                                  iso: &crate::modules::space_profile::IsolatedProfileEnv,
                                  account_tag: &str,
                                  shell_report: &std::path::Path| {
            let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
            shell_init::apply_common(
                &mut cmd,
                Some(dir.path().to_string_lossy().into_owned()),
                false,
                None,
                Some(iso),
            );
            let combined_path = std::env::join_paths([
                iso.shim_dir.as_path(),
                host_opencode_bin_dir.as_path(),
                std::path::Path::new("/usr/bin"),
                std::path::Path::new("/bin"),
            ])
            .unwrap();
            cmd.env("PATH", combined_path);
            cmd.env("XDG_DATA_HOME", &host_xdg_data);
            cmd.env("XDG_CONFIG_HOME", &host_xdg_cfg);
            let script = format!(
                "opencode '{tag}' && printf 'SHELL_XDG_DATA=%s\\nSHELL_XDG_CFG=%s\\nSHELL_OPC_CFG=%s\\n' \"$XDG_DATA_HOME\" \"$XDG_CONFIG_HOME\" \"${{OPENCODE_CONFIG_DIR-UNSET}}\" > '{out}'",
                tag = account_tag,
                out = shell_report.display(),
            );
            cmd.args(["-c", &script]);
            let s = session::spawn_with(
                session::Host {
                    id: pty_id,
                    owner: Arc::from("main"),
                    hub: state.hub.clone(),
                    class: PresentationClass::default(),
                    signal: Arc::new(|_| {}),
                    notify: Arc::new(|_| {}),
                    pane_id: None,
                    space_id: None,
                    link: agent_detect::AgentLink::new(),
                    reap: Box::new(|| {}),
                    colors: None,
                },
                PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                },
                move || Ok(cmd),
            )
            .unwrap();
            state
                .sessions
                .write()
                .unwrap()
                .insert(pty_id, Arc::clone(&s));
            s
        };

        let shell_alpha = dir.path().join("shell-alpha.txt");
        let shell_beta = dir.path().join("shell-beta.txt");
        let db_alpha = profiles_dir.join("sp-alpha/opencode/data/opencode/opencode.db");
        let db_beta = profiles_dir.join("sp-beta/opencode/data/opencode/opencode.db");
        let _s_alpha = spawn_opencode_pty(201, &env_alpha, "acct-alpha", &shell_alpha);
        let _s_beta = spawn_opencode_pty(202, &env_beta, "acct-beta", &shell_beta);

        wait_for("both parallel isolated OpenCode PTYs to finish", || {
            db_alpha.exists() && db_beta.exists() && shell_alpha.exists() && shell_beta.exists()
        });

        assert_eq!(std::fs::read_to_string(&db_alpha).unwrap(), "acct-alpha");
        assert_eq!(std::fs::read_to_string(&db_beta).unwrap(), "acct-beta");
        assert_eq!(
            std::fs::read_to_string(host_opencode_data.join("opencode.db")).unwrap(),
            host_db_sentinel
        );

        let log_alpha = std::fs::read_to_string(
            profiles_dir.join("sp-alpha/opencode/state/opencode/run.log"),
        )
        .unwrap();
        assert!(log_alpha.contains("ARGS=--standalone acct-alpha\n"));
        assert!(log_alpha.contains("HAS_OPENCODE_JSON=yes\n"));
        assert!(log_alpha.contains("HAS_SERVICE_JSON=no\n"));
        assert!(log_alpha.contains("HAS_CLI_JSON=no\n"));

        for report_path in [&shell_alpha, &shell_beta] {
            let report = std::fs::read_to_string(report_path).unwrap();
            assert!(
                report.contains(&format!("SHELL_XDG_DATA={}\n", host_xdg_data.display())),
                "got: {report}"
            );
            assert!(
                report.contains(&format!("SHELL_XDG_CFG={}\n", host_xdg_cfg.display())),
                "got: {report}"
            );
            assert!(
                report.contains("SHELL_OPC_CFG=UNSET\n"),
                "got: {report}"
            );
        }

        // Logins in opencode.db persist across registry reload and Layout restoration preflight.
        let reloaded = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path,
            Some(profiles_dir),
            Some(host_home),
            Some(path_with_opencode),
        );
        assert!(reloaded
            .prepare_agent_launch("sp-alpha", AccountIsolationMode::Isolated, "opencode")
            .is_ok());
        assert!(reloaded
            .prepare_agent_launch("sp-beta", AccountIsolationMode::Isolated, "opencode")
            .is_ok());
        assert_eq!(std::fs::read_to_string(&db_alpha).unwrap(), "acct-alpha");
        assert_eq!(std::fs::read_to_string(&db_beta).unwrap(), "acct-beta");

        for id in [201, 202] {
            if let Some(session) = state.take(id) {
                reap(id, session, "test cleanup");
            }
        }
    }

    #[test]
    fn pty_diagnostics_never_exposes_env_credentials_or_profile_secrets() {
        let state = Arc::new(PtyState::default());
        let session = open(&state, 1, "main");
        let diag = PtyDiagnostics {
            host_pid: std::process::id(),
            host_rss_bytes: None,
            hub: state.hub.diagnostics(),
            sessions: vec![PtySessionDiagnostics {
                id: 1,
                output: session.diagnostics(),
            }],
        };
        let serialized = serde_json::to_string(&diag).unwrap();
        for forbidden in [
            "CLAUDE_CONFIG_DIR",
            ".credentials.json",
            "CONTROL_TOKEN",
            "space-profiles",
            "sk-ant-",
            "accessToken",
        ] {
            assert!(
                !serialized.contains(forbidden),
                "pty diagnostics exposed forbidden marker {forbidden}: {serialized}"
            );
        }
        if let Some(session) = state.take(1) {
            reap(1, session, "test cleanup");
        }
    }

    #[cfg(unix)]
    fn open_running_for_space(
        state: &Arc<PtyState>,
        id: u32,
        pane_id: Option<u32>,
        space_id: Option<&str>,
        script: &str,
    ) -> Arc<Session> {
        let reaper = state.clone();
        let session = spawn_with(
            Host {
                id,
                owner: Arc::from("main"),
                hub: state.hub.clone(),
                class: PresentationClass::Hidden,
                signal: Arc::new(|_| {}),
                notify: Arc::new(|_| {}),
                pane_id,
                space_id: space_id.map(str::to_string),
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

    #[cfg(unix)]
    fn pid_is_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        let rc = unsafe { libc::kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    #[cfg(unix)]
    #[test]
    fn stop_space_sessions_kills_process_group_escalates_sigkill_and_awaits_exit() {
        let dir = tempfile::tempdir().unwrap();
        let child_pid_file = dir.path().join("child.pid");
        let state = Arc::new(PtyState::default());

        let stubborn = open_running_for_space(
            &state,
            201,
            Some(10),
            Some("sp-target"),
            &format!(
                "trap '' TERM; (trap '' TERM; sh -c 'sleep 30' & echo $! > '{}'; wait) & wait",
                child_pid_file.display()
            ),
        );
        let default_mode_pane =
            open_running_for_space(&state, 202, Some(20), None, "sleep 30; true");
        let other_space =
            open_running_for_space(&state, 203, Some(30), Some("sp-other"), "sleep 30; true");

        wait_for("stubborn grandchild pid file", || child_pid_file.exists());
        let child_pid: u32 = std::fs::read_to_string(&child_pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        wait_for("other space shell running", || {
            pid_is_alive(other_space.shell_pid)
        });

        state
            .stop_space_sessions("sp-target", &[10, 20], 120)
            .unwrap();

        assert!(stubborn.has_child_exited());
        assert!(default_mode_pane.has_child_exited());
        assert!(!pid_is_alive(stubborn.shell_pid));
        assert!(!pid_is_alive(child_pid));
        assert!(!pid_is_alive(default_mode_pane.shell_pid));

        assert!(!other_space.has_child_exited());
        assert!(pid_is_alive(other_space.shell_pid));
        assert!(state.sessions.read().unwrap().contains_key(&203));

        if let Some(session) = state.take(203) {
            reap(203, session, "test cleanup");
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_space_sessions_sends_sigterm_before_escalating_to_sigkill() {
        let dir = tempfile::tempdir().unwrap();
        let ready = dir.path().join("ready");
        let term_marker = dir.path().join("sigterm.seen");
        let state = Arc::new(PtyState::default());

        let coop = open_running_for_space(
            &state,
            204,
            Some(40),
            Some("sp-coop"),
            &format!(
                "trap 'touch \"{}\"; exit 0' TERM; touch '{}'; while true; do sleep 0.05; done",
                term_marker.display(),
                ready.display()
            ),
        );
        wait_for("coop trap armed", || ready.exists());

        state.stop_space_sessions("sp-coop", &[40], 1500).unwrap();

        assert!(term_marker.exists(), "SIGTERM trap marker should exist");
        assert!(coop.has_child_exited());
        assert!(!pid_is_alive(coop.shell_pid));
    }

    #[cfg(unix)]
    #[test]
    fn remove_space_stops_process_group_before_atomic_tombstone_and_deletion() {
        use std::ffi::OsString;
        let dir = tempfile::tempdir().unwrap();
        let host_home = dir.path().join("host-home");
        let project_root = dir.path().join("project-root");
        let shared_dir = dir.path().join("shared-resources");
        std::fs::create_dir_all(host_home.join(".claude")).unwrap();
        std::fs::create_dir_all(&project_root).unwrap();
        std::fs::create_dir_all(&shared_dir).unwrap();
        std::fs::write(host_home.join(".claude/.credentials.json"), "host-secret").unwrap();
        std::fs::write(project_root.join("README.md"), "repo-data").unwrap();
        std::fs::write(shared_dir.join("skill.md"), "shared-skill").unwrap();

        let manifest_path = dir.path().join("space-isolation/manifest.json");
        let profiles_dir = dir.path().join("space-profiles");
        let registry = SpaceIsolationRegistry::for_paths_with_env(
            manifest_path,
            Some(profiles_dir.clone()),
            Some(host_home.clone()),
            Some(OsString::new()),
        );
        registry
            .register_space("sp-wipe", AccountIsolationMode::Isolated)
            .unwrap();
        registry
            .register_space("sp-other", AccountIsolationMode::Isolated)
            .unwrap();

        let env_wipe = preflight_pty_open(
            &registry,
            Some("sp-wipe"),
            Some(AccountIsolationMode::Isolated),
            false,
        )
        .unwrap()
        .unwrap();
        std::fs::write(
            env_wipe.claude_config_dir.join(".credentials.json"),
            "wipe-tok",
        )
        .unwrap();
        std::os::unix::fs::symlink(&shared_dir, env_wipe.space_dir.join("shared-link")).unwrap();

        let state = Arc::new(PtyState::default());
        let heartbeat = env_wipe.claude_config_dir.join("heartbeat");
        let script = format!(
            "trap '' TERM; (trap '' TERM; while true; do printf x > '{}'; sleep 0.015; done) & wait",
            heartbeat.display()
        );
        let wipe_pty = open_running_for_space(&state, 301, Some(55), Some("sp-wipe"), &script);
        let other_pty =
            open_running_for_space(&state, 302, Some(56), Some("sp-other"), "sleep 30; true");
        wait_for("heartbeat file written by stubborn space process", || {
            heartbeat.exists()
        });

        let status = registry
            .remove_space_with_pty(&state, "sp-wipe", &[55])
            .unwrap();

        assert!(!status.has_retained_profiles);
        assert!(status.cleanup_error.is_none());
        assert!(wipe_pty.has_child_exited());
        assert!(!pid_is_alive(wipe_pty.shell_pid));
        assert!(!profiles_dir.join("sp-wipe").exists());
        assert!(!heartbeat.exists());
        if profiles_dir.join(".tombstones").exists() {
            assert_eq!(
                std::fs::read_dir(profiles_dir.join(".tombstones"))
                    .unwrap()
                    .count(),
                0
            );
        }

        // Strict boundary check: host home, project root, shared symlink targets, and other Space untouched.
        assert_eq!(
            std::fs::read_to_string(host_home.join(".claude/.credentials.json")).unwrap(),
            "host-secret"
        );
        assert_eq!(
            std::fs::read_to_string(project_root.join("README.md")).unwrap(),
            "repo-data"
        );
        assert_eq!(
            std::fs::read_to_string(shared_dir.join("skill.md")).unwrap(),
            "shared-skill"
        );
        assert!(profiles_dir.join("sp-other").exists());
        assert!(pid_is_alive(other_pty.shell_pid));

        if let Some(session) = state.take(302) {
            reap(302, session, "test cleanup");
        }
    }
}

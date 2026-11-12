//! Bounded delivery for automatic preview assets.
//!
//! The asset scheme is the only native path that serves a file to document
//! content (Markdown images, media elements, the PDF frame). Its job is to be
//! a *boundary*, not a file server:
//!
//! - a grant names one file or one directory, owned by a webview and (from
//!   issue #25 on) by the tab scope that asked for it;
//! - every request re-canonicalizes the requested path, re-applies the secret
//!   policy, and re-checks the *opened descriptor* against the grant, so a
//!   symlink or replaced target cannot step outside it;
//! - a response is never an unexamined whole-file allocation: a range is
//!   shortened to one chunk, a whole-file read above the approved read ceiling
//!   is refused unless the caller made the explicit "load anyway" choice, and
//!   outstanding deliveries are bounded by both count and bytes.
//!
//! The ceilings come from the approved contract in
//! `src/modules/preview/lib/limits.ts` (issue #4). `DeliveryLimits` mirrors
//! them; `assetDelivery.test.ts` reads this file and fails if they drift.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use super::access::opened_path;
use super::file::{FORCE_MAX_READ_BYTES, MAX_READ_BYTES};
use crate::modules::workspace::{resolve_path, WorkspaceEnv};

/// The approved concurrent decoded-viewer ceiling
/// (`MAX_CONCURRENT_DECODED_VIEWERS` in `src/modules/preview/lib/limits.ts`).
/// A decoded viewer needs at most one native delivery in flight, so the same
/// approved count bounds outstanding deliveries.
const MAX_OUTSTANDING_DELIVERIES: usize = 4;

/// How a delivery is bounded. Production uses [`DeliveryLimits::approved`];
/// tests pass a small table so bounded allocation is asserted without
/// multi-megabyte fixtures.
#[derive(Clone, Copy)]
struct DeliveryLimits {
    /// Whole-file (non-range) ceiling: the approved 10 MiB normal read.
    read_bytes: u64,
    /// Explicit "load anyway" ceiling: the approved 50 MiB override.
    override_bytes: u64,
    /// Most bytes one response may carry, so a range client is served in
    /// bounded chunks instead of a whole file. A tenth of the normal read
    /// ceiling — delivery granularity, not a second approved ceiling.
    chunk_bytes: u64,
    /// Concurrent deliveries.
    outstanding: usize,
    /// Bytes reserved by concurrent deliveries. At least one approved
    /// override read must fit, or the explicit "load anyway" could never be
    /// served; the bound is shared, so four maximum reads do not run at once.
    outstanding_bytes: u64,
    /// How long a delivery may wait for room before failing explicitly.
    wait: Duration,
}

impl DeliveryLimits {
    fn approved() -> Self {
        Self {
            read_bytes: MAX_READ_BYTES,
            override_bytes: FORCE_MAX_READ_BYTES,
            chunk_bytes: MAX_READ_BYTES / 10,
            outstanding: MAX_OUTSTANDING_DELIVERIES,
            outstanding_bytes: FORCE_MAX_READ_BYTES,
            wait: Duration::from_secs(5),
        }
    }
}

/// A refusal. Every variant names what the caller can do instead; the response
/// carries the code and the alternatives as headers so a refusal is observable
/// without parsing prose.
#[derive(Debug)]
struct AssetError {
    status: u16,
    code: &'static str,
    message: String,
    alternatives: Vec<&'static str>,
    /// Present when an explicit "load anyway" request could reach this file.
    override_allowed: bool,
    /// Present when the asset's size is known.
    size: Option<u64>,
}

impl AssetError {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            alternatives: Vec::new(),
            override_allowed: false,
            size: None,
        }
    }

    fn with_alternative(mut self, alternative: &'static str) -> Self {
        self.alternatives.push(alternative);
        self
    }

    fn too_large(bytes: u64, limits: &DeliveryLimits) -> Self {
        let (message, override_allowed) = if bytes > limits.override_bytes {
            (
                format!(
                    "This asset is {bytes} bytes, above the {} byte ceiling an explicit open can reach. Open it in an external viewer.",
                    limits.override_bytes
                ),
                false,
            )
        } else {
            (
                format!(
                    "This asset is {bytes} bytes, above the {} byte preview read limit. Load it anyway (up to {} bytes) or open it in an external viewer.",
                    limits.read_bytes, limits.override_bytes
                ),
                true,
            )
        };
        let mut error = Self::new(413, "too-large", message);
        error.alternatives = vec!["open-externally"];
        error.override_allowed = override_allowed;
        error.size = Some(bytes);
        error
    }

    fn revoked() -> Self {
        Self::new(
            409,
            "revoked",
            "The preview grant was revoked while the asset was being read, so nothing was served.",
        )
        .with_alternative("open-externally")
    }

    fn busy() -> Self {
        Self::new(
            503,
            "too-many-reads",
            "Too many asset reads are already in flight. Retry when the current previews have finished.",
        )
    }

    fn io(error: std::io::Error) -> Self {
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => 404,
            std::io::ErrorKind::PermissionDenied => 403,
            _ => 500,
        };
        let code = match status {
            404 => "not-found",
            403 => "unreadable",
            _ => "unreadable",
        };
        Self::new(status, code, error.to_string()).with_alternative("open-externally")
    }

    fn response(&self) -> Response<Vec<u8>> {
        let mut body = self.message.clone();
        if !self.alternatives.is_empty() {
            body.push_str("\n\nalternatives: ");
            body.push_str(&self.alternatives.join(", "));
        }
        let mut response = response(
            self.status,
            "text/plain; charset=utf-8",
            body.into_bytes(),
        );
        let headers = response.headers_mut();
        headers.insert("X-Terax-Asset-Error", header(self.code));
        if self.override_allowed {
            headers.insert("X-Terax-Asset-Override", header("1"));
        }
        if let Some(size) = self.size {
            headers.insert("X-Terax-Asset-Size", header(size.to_string()));
        }
        if self.status == 413 {
            headers.insert("Accept-Ranges", header("bytes"));
        }
        if self.status == 503 {
            headers.insert("Retry-After", header("1"));
        }
        if !self.alternatives.is_empty() {
            headers.insert("X-Terax-Asset-Alternatives", header(self.alternatives.join(",")));
        }
        response
    }
}

fn header(value: impl AsRef<str>) -> tauri::http::HeaderValue {
    value
        .as_ref()
        .parse()
        .expect("static asset header value")
}

#[derive(Clone)]
struct Grant {
    owner: String,
    /// The tab scope that asked for this grant. A closed tab revokes its own
    /// scopes; a grant made before the close may not install.
    scope: Option<String>,
    root: PathBuf,
    directory: bool,
    workspace: WorkspaceEnv,
}

#[derive(Default)]
struct GrantState {
    grants: HashMap<String, Grant>,
    /// Bumped on every owner-wide revoke (page reload, window close).
    generations: HashMap<String, u64>,
    /// Scope generations keyed by owner and scope (tab close).
    scopes: HashMap<String, u64>,
    /// Deliveries currently reading; see `DeliveryLimits`.
    in_flight: usize,
    in_flight_bytes: u64,
    /// Bounded record of served requests. Read by the bench scenario so
    /// "the element requested ranges" is evidence, not an assumption.
    deliveries: Vec<DeliveryRecord>,
}

/// One served request, as the app-lab scenario sees it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DeliveryRecord {
    pub start: u64,
    pub length: u64,
    pub size: u64,
    pub status: u16,
    pub ranged: bool,
}

/// Most recent deliveries kept; a sustained stream does not grow this list.
const MAX_DELIVERY_RECORDS: usize = 64;

impl GrantState {
    fn owner_generation(&self, owner: &str) -> u64 {
        *self.generations.get(owner).unwrap_or(&0)
    }

    fn scope_generation(&self, owner: &str, scope: Option<&str>) -> u64 {
        scope
            .and_then(|scope| self.scopes.get(&scope_key(owner, scope)))
            .copied()
            .unwrap_or(0)
    }
}

fn scope_key(owner: &str, scope: &str) -> String {
    format!("{owner}\u{1f}{scope}")
}

/// One in-flight delivery. Dropping it returns the reserved count and bytes, so
/// every exit path (including a refusal after reservation) releases its slot.
struct Delivery<'a> {
    grants: &'a AssetGrants,
    bytes: u64,
}

impl Drop for Delivery<'_> {
    fn drop(&mut self) {
        let mut state = self.grants.state.lock().unwrap();
        state.in_flight = state.in_flight.saturating_sub(1);
        state.in_flight_bytes = state.in_flight_bytes.saturating_sub(self.bytes);
        self.grants.released.notify_all();
    }
}

#[derive(Default)]
pub struct AssetGrants {
    state: Mutex<GrantState>,
    released: Condvar,
    /// The loopback media server's port, once it has been started.
    media_port: Mutex<Option<u16>>,
}

impl AssetGrants {
    /// Drops every grant this webview owns. A queued grant request that started
    /// before this call cannot install afterwards.
    pub fn revoke_owner(&self, owner: &str) {
        let mut state = self.state.lock().unwrap();
        *state.generations.entry(owner.into()).or_default() += 1;
        state.grants.retain(|_, grant| grant.owner != owner);
    }

    /// Live grants across every webview (bench observation, issue #30).
    #[cfg(feature = "bench")]
    pub fn active(&self) -> usize {
        self.state.lock().unwrap().grants.len()
    }

    /// Drops one tab scope's grants. Grants for other tabs in the same webview
    /// stay usable.
    pub fn revoke_scope(&self, owner: &str, scope: &str) {
        let mut state = self.state.lock().unwrap();
        *state.scopes.entry(scope_key(owner, scope)).or_default() += 1;
        state
            .grants
            .retain(|_, grant| !(grant.owner == owner && grant.scope.as_deref() == Some(scope)));
    }

    fn generation(&self, owner: &str) -> u64 {
        self.state.lock().unwrap().owner_generation(owner)
    }

    fn scope_generation(&self, owner: &str, scope: Option<&str>) -> u64 {
        self.state.lock().unwrap().scope_generation(owner, scope)
    }

    fn grant(
        &self,
        owner: String,
        scope: Option<String>,
        path: &str,
        workspace: WorkspaceEnv,
        generation: u64,
        scope_generation: u64,
    ) -> Result<String, String> {
        let root =
            std::fs::canonicalize(resolve_path(path, &workspace)).map_err(|e| e.to_string())?;
        let directory = root.is_dir();
        if directory {
            super::access_policy::readable(&root)?;
        }
        if !directory && media_type(&root).is_none() {
            return Err("only media files can be granted".into());
        }
        let mut state = self.state.lock().unwrap();
        if state.owner_generation(&owner) != generation
            || state.scope_generation(&owner, scope.as_deref()) != scope_generation
        {
            return Err("the asset view was unloaded".into());
        }
        let grants = &mut state.grants;
        if grants.len() >= 1024 {
            return Err("too many active media grants".into());
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let token = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        grants.insert(
            token.clone(),
            Grant {
                owner,
                scope,
                root,
                directory,
                workspace,
            },
        );
        Ok(token)
    }

    /// True while the token describes the same grant the delivery started with.
    /// A revoke during the read therefore aborts the response instead of
    /// serving a token the tab no longer owns.
    fn grant_current(
        &self,
        owner: &str,
        token: &str,
        generation: u64,
        scope_generation: u64,
    ) -> bool {
        let state = self.state.lock().unwrap();
        let Some(grant) = state.grants.get(token) else {
            return false;
        };
        grant.owner == owner
            && state.owner_generation(owner) == generation
            && state.scope_generation(owner, grant.scope.as_deref()) == scope_generation
    }

    /// Reserves one delivery. Waits for a slot for `limits.wait` so a burst of
    /// previews queues instead of failing, then refuses explicitly. A request
    /// larger than the whole byte budget never waits.
    fn reserve(&self, bytes: u64, limits: &DeliveryLimits) -> Result<Delivery<'_>, AssetError> {
        if bytes > limits.outstanding_bytes {
            return Err(AssetError::busy());
        }
        let deadline = Instant::now() + limits.wait;
        let mut state = self.state.lock().unwrap();
        loop {
            if state.in_flight < limits.outstanding
                && state.in_flight_bytes + bytes <= limits.outstanding_bytes
            {
                break;
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(AssetError::busy());
            }
            let (next, _) = self
                .released
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
        state.in_flight += 1;
        state.in_flight_bytes += bytes;
        Ok(Delivery {
            grants: self,
            bytes,
        })
    }

    #[cfg(test)]
    fn outstanding(&self) -> (usize, u64) {
        let state = self.state.lock().unwrap();
        (state.in_flight, state.in_flight_bytes)
    }

    /// The served-request log, oldest first. Bench scenario only.
    #[cfg_attr(not(feature = "bench"), allow(dead_code))]
    pub fn delivery_log(&self) -> Vec<DeliveryRecord> {
        self.state.lock().unwrap().deliveries.clone()
    }

    /// Drops the log; the bench scenario clears it between phases.
    #[cfg_attr(not(feature = "bench"), allow(dead_code))]
    pub fn clear_delivery_log(&self) {
        self.state.lock().unwrap().deliveries.clear();
    }

    fn record_delivery(&self, record: DeliveryRecord) {
        let mut state = self.state.lock().unwrap();
        if state.deliveries.len() >= MAX_DELIVERY_RECORDS {
            state.deliveries.remove(0);
        }
        state.deliveries.push(record);
    }
}

#[tauri::command]
pub async fn asset_grant(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    path: String,
    workspace: Option<WorkspaceEnv>,
    scope: Option<String>,
) -> Result<String, String> {
    let owner = webview.label().to_owned();
    let grants = app.state::<AssetGrants>();
    let generation = grants.generation(&owner);
    let scope_generation = grants.scope_generation(&owner, scope.as_deref());
    super::blocking(move || {
        app.state::<AssetGrants>().grant(
            owner,
            scope,
            &path,
            WorkspaceEnv::from_option(workspace),
            generation,
            scope_generation,
        )
    })
    .await
}

#[tauri::command]
pub fn asset_revoke(state: tauri::State<AssetGrants>, webview: tauri::Webview, token: String) {
    let mut state = state.state.lock().unwrap();
    let grants = &mut state.grants;
    if grants
        .get(&token)
        .is_some_and(|grant| grant.owner == webview.label())
    {
        grants.remove(&token);
    }
}

/// Starts the loopback media server on first use and returns its port.
///
/// WebKitGTK's GStreamer media backend rejects any source outside the
/// `http`/`https`/`blob` family (WebKit bug 146351, still open in 2.54.2):
/// every container from the custom `asset:` scheme reports
/// `MEDIA_ERR_SRC_NOT_SUPPORTED` even though the same bytes play from a blob
/// URL. The media surface therefore receives an `http://127.0.0.1:<port>` URL
/// served here, with the *same* token grants, range chunking, delivery bounds
/// and revocation as the asset scheme. It is a transport for the existing
/// policy, not a second, weaker one.
impl AssetGrants {
    fn ensure_media_server(&self, app: &tauri::AppHandle) -> Result<u16, String> {
        let mut port = self.media_port.lock().unwrap();
        if let Some(port) = *port {
            return Ok(port);
        }
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
        let bound = listener.local_addr().map_err(|error| error.to_string())?.port();
        let app = app.clone();
        std::thread::Builder::new()
            .name("asset-media-server".into())
            .spawn(move || media_accept_loop(listener, app))
            .map_err(|error| error.to_string())?;
        *port = Some(bound);
        Ok(bound)
    }

    /// True while the token still names a live grant (revocation is removal).
    fn token_current(&self, token: &str) -> bool {
        self.state.lock().unwrap().grants.contains_key(token)
    }
}

/// Returns the loopback URL the media element must use for a granted token.
///
/// The URL carries the same bearer token as the asset URL; it grants no new
/// file access and stops working as soon as the tab scope revokes the grant.
#[tauri::command]
pub fn asset_media_url(
    app: tauri::AppHandle,
    state: tauri::State<AssetGrants>,
    token: String,
) -> Result<String, String> {
    let port = state.ensure_media_server(&app)?;
    Ok(format!("http://127.0.0.1:{port}/media?token={token}"))
}

/// Concurrent loopback media connections; a misbehaving local client cannot
/// spawn unbounded handler threads.
const MAX_MEDIA_CONNECTIONS: usize = 8;
static MEDIA_CONNECTIONS: AtomicUsize = AtomicUsize::new(0);

fn media_accept_loop(listener: TcpListener, app: tauri::AppHandle) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if MEDIA_CONNECTIONS.fetch_add(1, Ordering::SeqCst) >= MAX_MEDIA_CONNECTIONS {
            MEDIA_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
            let mut stream = stream;
            let _ = write_media_response(
                &mut stream,
                MediaResponse::error(AssetError::busy()),
                false,
            );
            continue;
        }
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("asset-media-conn".into())
            .spawn(move || {
                let mut stream = stream;
                let _ = handle_media_connection(&mut stream, &app);
                MEDIA_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            MEDIA_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

fn handle_media_connection(stream: &mut TcpStream, app: &tauri::AppHandle) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > 8192 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut lines = text.split("\r\n");
    let request = lines.next().unwrap_or_default();
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("range") {
            Some(value.trim().to_string())
        } else {
            None
        }
    });
    if method == "OPTIONS" {
        // The app page reads the delivery URL with a Range header; that is a
        // non-simple CORS request, so answer the preflight. The token remains
        // the capability; no origin gains file access without it.
        let _ = stream.write_all(
            b"HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\n\
              Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
              Access-Control-Allow-Headers: Range\r\n\
              Access-Control-Max-Age: 600\r\nConnection: close\r\n\r\n",
        );
        return stream.flush();
    }
    let response = if method != "GET" && method != "HEAD" {
        MediaResponse::error(AssetError::new(
            405,
            "method-not-allowed",
            "Only GET and HEAD are served for preview media.",
        ))
    } else if path != "/media" {
        MediaResponse::error(AssetError::new(
            404,
            "not-found",
            "Only /media is served by this preview endpoint.",
        ))
    } else {
        match query_param(query, "token") {
            Some(token) => deliver_media(
                &app.state::<AssetGrants>(),
                &token,
                range.as_deref(),
                &DeliveryLimits::approved(),
            )
            .unwrap_or_else(MediaResponse::error),
            None => MediaResponse::error(AssetError::new(
                403,
                "missing-grant",
                "This media URL has no grant token.",
            )),
        }
    };
    write_media_response(stream, response, method == "HEAD")
}

/// Serves one granted media file with the same bounds as the asset scheme.
fn deliver_media(
    grants: &AssetGrants,
    token: &str,
    range_header: Option<&str>,
    limits: &DeliveryLimits,
) -> Result<MediaResponse, AssetError> {
    let grant = {
        let state = grants.state.lock().unwrap();
        state.grants.get(token).cloned().ok_or_else(|| {
            AssetError::new(
                403,
                "invalid-grant",
                "This media grant is unknown, expired or belongs to another view.",
            )
        })?
    };
    if grant.directory {
        return Err(AssetError::new(
            415,
            "unsupported-media",
            "This media grant is for a directory, not a media file.",
        )
        .with_alternative("open-externally"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(&grant.root).map_err(AssetError::io)?;
    let actual = opened_path(&file).map_err(|error| AssetError::new(500, "unreadable", error))?;
    if actual != grant.root {
        return Err(AssetError::new(
            403,
            "outside-grant",
            "The opened media escaped its grant boundary.",
        ));
    }
    let mime = media_type(&actual).ok_or_else(|| {
        AssetError::new(
            415,
            "unsupported-media",
            "This file type is not a previewable media asset.",
        )
        .with_alternative("open-externally")
    })?;
    let meta = file.metadata().map_err(AssetError::io)?;
    if !meta.is_file() {
        return Err(AssetError::new(
            415,
            "unsupported-media",
            "This asset is not a regular file.",
        ));
    }
    let size = meta.len();
    let range = match range_header {
        Some(value) => {
            let ranges = http_range::HttpRange::parse(value, size).map_err(|_| {
                let mut error =
                    AssetError::new(416, "invalid-range", "The requested range does not exist.");
                error.size = Some(size);
                error
            })?;
            if ranges.len() != 1 {
                let mut error =
                    AssetError::new(416, "invalid-range", "One media range is required.");
                error.size = Some(size);
                return Err(error);
            }
            let range = ranges[0];
            Some((range.start, range.length.min(limits.chunk_bytes)))
        }
        None => None,
    };
    let planned = match range {
        Some((_, length)) => length,
        None if size > limits.override_bytes => return Err(AssetError::too_large(size, limits)),
        None if size > limits.read_bytes => return Err(AssetError::too_large(size, limits)),
        None => size,
    };
    let _delivery = grants.reserve(planned, limits)?;
    if !grants.token_current(token) {
        return Err(AssetError::revoked());
    }
    let (start, mut length) = range.unwrap_or((0, planned));
    let mut body = Vec::new();
    if planned > 0 {
        file.seek(SeekFrom::Start(start)).map_err(AssetError::io)?;
        file.take(planned)
            .read_to_end(&mut body)
            .map_err(AssetError::io)?;
        length = body.len() as u64;
    }
    let status = if range.is_some() { 206 } else { 200 };
    grants.record_delivery(DeliveryRecord {
        start,
        length,
        size,
        status,
        ranged: range.is_some(),
    });
    Ok(MediaResponse {
        status,
        mime,
        size,
        start,
        length,
        ranged: range.is_some(),
        body,
    })
}

#[derive(Debug)]
struct MediaResponse {
    status: u16,
    mime: &'static str,
    size: u64,
    start: u64,
    length: u64,
    ranged: bool,
    body: Vec<u8>,
}

impl MediaResponse {
    fn error(error: AssetError) -> Self {
        Self {
            status: error.status,
            mime: "text/plain; charset=utf-8",
            size: error.size.unwrap_or(0),
            start: 0,
            length: error.message.len() as u64,
            ranged: false,
            body: error.message.into_bytes(),
        }
    }
}

fn write_media_response(
    stream: &mut TcpStream,
    response: MediaResponse,
    head_only: bool,
) -> std::io::Result<()> {
    let mut headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n\
         Accept-Ranges: bytes\r\nCache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n\
         X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\
         Connection: close\r\n",
        response.status,
        reason_phrase(response.status),
        response.mime,
        response.length,
    );
    if response.ranged {
        if response.length > 0 {
            headers.push_str(&format!(
                "Content-Range: bytes {}-{}/{}\r\n",
                response.start,
                response.start + response.length - 1,
                response.size
            ));
        } else {
            headers.push_str(&format!("Content-Range: bytes */{}\r\n", response.size));
        }
    }
    headers.push_str("\r\n");
    stream.write_all(headers.as_bytes())?;
    if !head_only {
        stream.write_all(&response.body)?;
    }
    stream.flush()
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        416 => "Range Not Satisfiable",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

/// Revokes every grant a tab scope owns. A late `asset_grant` for the same
/// scope cannot install: the scope generation already moved.
#[tauri::command]
pub fn asset_revoke_scope(
    state: tauri::State<AssetGrants>,
    webview: tauri::Webview,
    scope: String,
) {
    state.revoke_scope(webview.label(), &scope);
}

/// Served-request log for the app-lab media scenario. Bench builds only: it
/// exists so "the element requested ranges" is observed evidence rather than an
/// assumption from the extension or `canPlayType`.
#[cfg(feature = "bench")]
#[tauri::command]
pub fn asset_delivery_log(
    state: tauri::State<AssetGrants>,
    clear: Option<bool>,
) -> Vec<DeliveryRecord> {
    let log = state.delivery_log();
    if clear.unwrap_or(false) {
        state.clear_delivery_log();
    }
    log
}

pub fn serve<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let owner = context.webview_label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let result = deliver(
            &app.state::<AssetGrants>(),
            &owner,
            &request,
            &DeliveryLimits::approved(),
            &mut |_| {},
        );
        // The PDF acceptance scenario reads what the webview actually asked for from here; the
        // page cannot see it (separate cross-origin document, no `asset:` in `connect-src`).
        #[cfg(feature = "bench")]
        super::bench_probe::record(
            &owner,
            &request,
            &result
                .as_ref()
                .map_err(|error| (error.status, error.message.clone())),
        );
        let response = result.unwrap_or_else(|error| error.response());
        responder.respond(response);
    });
}

fn response(status: u16, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header(
            "Content-Security-Policy",
            "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        )
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .expect("static asset response")
}

/// Where a delivery is, for the cancellation test: a revoke injected here must
/// abort the response instead of serving bytes from a grant that just closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeliveryStage {
    GrantResolved,
    Opened,
    Reserved,
}

/// Serves one asset request the way `serve` does, as a test entry point: a delivery error becomes
/// the same response the handler hands to WebKit (`serve` itself keeps the error so the bench probe
/// can record why a request was refused).
#[cfg(test)]
fn respond(
    grants: &AssetGrants,
    owner: &str,
    request: &Request<Vec<u8>>,
    limits: &DeliveryLimits,
) -> Response<Vec<u8>> {
    deliver(grants, owner, request, limits, &mut |_| {}).unwrap_or_else(|error| error.response())
}

fn deliver(
    grants: &AssetGrants,
    owner: &str,
    request: &Request<Vec<u8>>,
    limits: &DeliveryLimits,
    on_stage: &mut dyn FnMut(DeliveryStage),
) -> Result<Response<Vec<u8>>, AssetError> {
    if request.method() != "GET" && request.method() != "HEAD" {
        return Err(AssetError::new(
            405,
            "method-not-allowed",
            "Only GET and HEAD are served for preview assets.",
        ));
    }
    let query = request.uri().query().unwrap_or("");
    let token = query_param(query, "token")
        .ok_or_else(|| AssetError::new(403, "missing-grant", "This asset URL has no grant token."))?;
    let override_requested = query_param(query, "override").as_deref() == Some("1");

    let (grant, generation, scope_generation) = {
        let state = grants.state.lock().unwrap();
        let grant = state
            .grants
            .get(&token)
            .filter(|grant| grant.owner == owner)
            .cloned()
            .ok_or_else(|| {
                AssetError::new(
                    403,
                    "invalid-grant",
                    "This preview grant is unknown, expired or belongs to another view.",
                )
            })?;
        let generation = state.owner_generation(owner);
        let scope_generation = state.scope_generation(owner, grant.scope.as_deref());
        (grant, generation, scope_generation)
    };
    on_stage(DeliveryStage::GrantResolved);

    let requested = percent_encoding::percent_decode_str(
        request
            .uri()
            .path()
            .strip_prefix('/')
            .ok_or_else(|| AssetError::new(400, "invalid-path", "The asset URL has no path."))?,
    )
    .decode_utf8()
    .map_err(|error| AssetError::new(400, "invalid-path", error.to_string()))?;
    // Canonicalize the spelling the renderer sent; the descriptor check below
    // is the authoritative one.
    let canonical = std::fs::canonicalize(resolve_path(&requested, &grant.workspace))
        .map_err(AssetError::io)?;
    if grant.directory {
        super::access_policy::readable(&canonical)
            .map_err(|error| AssetError::new(403, "sensitive-path", error))?;
    }
    if !within(&canonical, &grant) {
        return Err(AssetError::new(
            403,
            "outside-grant",
            "The requested path is outside the grant the preview was given.",
        ));
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(&canonical).map_err(AssetError::io)?;
    // The descriptor is what is read, so a path swapped after the canonical
    // check above cannot redirect the response.
    let actual = opened_path(&file)
        .map_err(|error| AssetError::new(500, "unreadable", error))?;
    if grant.directory {
        super::access_policy::readable(&actual)
            .map_err(|error| AssetError::new(403, "sensitive-path", error))?;
    }
    if !within(&actual, &grant) {
        return Err(AssetError::new(
            403,
            "outside-grant",
            "The opened asset escaped its grant boundary.",
        ));
    }
    let mime = media_type(&actual).ok_or_else(|| {
        AssetError::new(
            415,
            "unsupported-media",
            "This file type is not a previewable asset.",
        )
        .with_alternative("open-externally")
    })?;
    let meta = file.metadata().map_err(AssetError::io)?;
    if !meta.is_file() {
        return Err(AssetError::new(
            415,
            "unsupported-media",
            "This asset is not a regular file.",
        ));
    }
    let size = meta.len();
    on_stage(DeliveryStage::Opened);

    let range = match request.headers().get("Range") {
        Some(value) => {
            let value = value
                .to_str()
                .map_err(|_| AssetError::new(416, "invalid-range", "The range is not text."))?;
            let ranges = http_range::HttpRange::parse(value, size).map_err(|_| {
                let mut error =
                    AssetError::new(416, "invalid-range", "The requested range does not exist.");
                error.size = Some(size);
                error
            })?;
            if ranges.len() != 1 {
                let mut error =
                    AssetError::new(416, "invalid-range", "One asset range is required.");
                error.size = Some(size);
                return Err(error);
            }
            let range = ranges[0];
            // A media element opens with `bytes=0-`; serve one chunk and let it
            // ask for the next instead of allocating the whole file.
            Some((range.start, range.length.min(limits.chunk_bytes)))
        }
        None => None,
    };

    let planned = match range {
        Some((_, length)) => length,
        None if size > limits.override_bytes => return Err(AssetError::too_large(size, limits)),
        None if size > limits.read_bytes && !override_requested => {
            return Err(AssetError::too_large(size, limits));
        }
        None => size,
    };

    let _delivery = grants.reserve(planned, limits)?;
    on_stage(DeliveryStage::Reserved);
    if !grants.grant_current(owner, &token, generation, scope_generation) {
        return Err(AssetError::revoked());
    }

    let (start, mut length) = range.unwrap_or((0, planned));
    let mut body = Vec::new();
    if request.method() != "HEAD" && planned > 0 {
        file.seek(SeekFrom::Start(start)).map_err(AssetError::io)?;
        file.take(planned)
            .read_to_end(&mut body)
            .map_err(AssetError::io)?;
        length = body.len() as u64;
    }

    let status = if range.is_some() { 206 } else { 200 };
    let mut result = response(status, mime, body);
    let headers = result.headers_mut();
    headers.insert("Accept-Ranges", header("bytes"));
    headers.insert("Content-Length", header(length.to_string()));
    headers.insert("X-Terax-Asset-Size", header(size.to_string()));
    if range.is_some() {
        if length > 0 {
            headers.insert(
                "Content-Range",
                header(format!("bytes {start}-{}/{size}", start + length - 1)),
            );
        } else {
            headers.insert("Content-Range", header(format!("bytes */{size}")));
        }
    }
    grants.record_delivery(DeliveryRecord {
        start,
        length,
        size,
        status,
        ranged: range.is_some(),
    });
    Ok(result)
}

/// One decoded query parameter. `token` is not the only parameter any more, so
/// the query is parsed as pairs rather than by prefix.
fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        let key = percent_encoding::percent_decode_str(key).decode_utf8().ok()?;
        if key != name {
            return None;
        }
        Some(
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()?
                .into_owned(),
        )
    })
}

fn within(path: &Path, grant: &Grant) -> bool {
    #[cfg(unix)]
    {
        path == grant.root || (grant.directory && path.starts_with(&grant.root))
    }
    #[cfg(windows)]
    {
        if path.to_str().is_none() || grant.root.to_str().is_none() {
            return false;
        }
        let path = super::to_canon(path);
        let root = super::to_canon(&grant.root);
        path == root || (grant.directory && Path::new(&path).starts_with(root))
    }
}

fn media_type(path: &Path) -> Option<&'static str> {
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "ogg" => "video/ogg",
            "mkv" => "video/x-matroska",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "aac" => "audio/aac",
            "m4a" => "audio/mp4",
            "pdf" => "application/pdf",
            _ => return None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &Path, token: &str) -> Request<Vec<u8>> {
        let encoded = percent_encoding::utf8_percent_encode(
            &super::super::to_canon(path),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        Request::builder()
            .uri(format!("https://asset.localhost/{encoded}?token={token}"))
            .body(Vec::new())
            .unwrap()
    }

    fn overridden(mut request: Request<Vec<u8>>) -> Request<Vec<u8>> {
        let uri = format!("{}&override=1", request.uri());
        *request.uri_mut() = uri.parse().unwrap();
        request
    }

    fn ranged(mut request: Request<Vec<u8>>, range: &str) -> Request<Vec<u8>> {
        request
            .headers_mut()
            .insert("Range", range.parse().unwrap());
        request
    }

    fn test_limits() -> DeliveryLimits {
        DeliveryLimits {
            read_bytes: 64,
            override_bytes: 128,
            chunk_bytes: 32,
            outstanding: 2,
            outstanding_bytes: 128,
            wait: Duration::ZERO,
        }
    }

    fn code(response: &Response<Vec<u8>>) -> &str {
        response.headers()["X-Terax-Asset-Error"]
            .to_str()
            .unwrap()
    }

    #[test]
    fn revocation_invalidates_queued_grants_but_allows_the_new_page() {
        let dir = tempfile::tempdir().unwrap();
        let grants = AssetGrants::default();
        let path = super::super::to_canon(dir.path());
        let queued = grants.generation("main");
        let scope_queued = grants.scope_generation("main", Some("tab-1"));
        grants.revoke_owner("main");
        assert!(grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &path,
                WorkspaceEnv::Local,
                queued,
                scope_queued,
            )
            .is_err());
        assert!(grants.state.lock().unwrap().grants.is_empty());
        assert!(grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &path,
                WorkspaceEnv::Local,
                grants.generation("main"),
                grants.scope_generation("main", Some("tab-1")),
            )
            .is_ok());
    }

    #[test]
    fn a_closed_tab_scope_revokes_its_grants_and_rejects_queued_ones() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("one.png");
        let second = dir.path().join("two.png");
        for path in [&first, &second] {
            std::fs::write(path, "SYNTHETIC_FIXTURE").unwrap();
        }
        let grants = AssetGrants::default();
        let generation = grants.generation("main");
        let queued_scope = grants.scope_generation("main", Some("tab-1"));
        let doomed = grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &super::super::to_canon(&first),
                WorkspaceEnv::Local,
                generation,
                queued_scope,
            )
            .unwrap();
        let surviving = grants
            .grant(
                "main".into(),
                Some("tab-2".into()),
                &super::super::to_canon(&second),
                WorkspaceEnv::Local,
                generation,
                grants.scope_generation("main", Some("tab-2")),
            )
            .unwrap();

        grants.revoke_scope("main", "tab-1");
        assert_eq!(
            respond(&grants, "main", &request(&first, &doomed), &test_limits()).status(),
            403
        );
        assert_eq!(
            respond(&grants, "main", &request(&second, &surviving), &test_limits()).status(),
            200
        );
        // A grant request that was already in flight when the tab closed must
        // not install a new token.
        assert!(grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &super::super::to_canon(&first),
                WorkspaceEnv::Local,
                generation,
                queued_scope,
            )
            .is_err());
    }

    #[test]
    fn an_explicit_file_grant_does_not_expose_its_directory() {
        // Explicit single-file selection (opening one image in a tab) is a
        // different grant than the automatic directory embedding policy
        // (Markdown images under a document directory). The file grant serves
        // exactly the selected file; a sibling needs its own grant.
        let dir = tempfile::tempdir().unwrap();
        let selected = dir.path().join("selected.png");
        let sibling = dir.path().join("sibling.png");
        for path in [&selected, &sibling] {
            std::fs::write(path, "SYNTHETIC_PNG_FIXTURE").unwrap();
        }
        let grants = AssetGrants::default();
        let file_token = grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &super::super::to_canon(&selected),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let file_grant = grants
            .state
            .lock()
            .unwrap()
            .grants
            .get(&file_token)
            .cloned()
            .unwrap();
        assert!(!file_grant.directory);
        assert_eq!(
            respond(&grants, "main", &request(&selected, &file_token), &test_limits()).status(),
            200
        );
        let sibling_response =
            respond(&grants, "main", &request(&sibling, &file_token), &test_limits());
        assert_eq!(sibling_response.status(), 403);
        assert_eq!(code(&sibling_response), "outside-grant");

        // The automatic directory grant is the other policy: it can serve the
        // sibling because its root is the directory, not one file.
        let directory_token = grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &super::super::to_canon(dir.path()),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let directory_grant = grants
            .state
            .lock()
            .unwrap()
            .grants
            .get(&directory_token)
            .cloned()
            .unwrap();
        assert!(directory_grant.directory);
        assert_eq!(
            respond(&grants, "main", &request(&sibling, &directory_token), &test_limits()).status(),
            200
        );
    }

    #[cfg(unix)]
    #[test]
    fn byte_distinct_siblings_are_not_inside_a_media_grant() {
        use std::os::unix::ffi::OsStrExt;
        let grant = Grant {
            owner: "main".into(),
            scope: None,
            root: PathBuf::from("/repo\u{fffd}"),
            directory: true,
            workspace: WorkspaceEnv::Local,
        };
        assert!(!within(
            Path::new(std::ffi::OsStr::from_bytes(b"/repo\xff/private.png")),
            &grant
        ));
        assert!(within(Path::new("/repo\u{fffd}/safe.png"), &grant));
    }

    #[test]
    fn automatic_images_cannot_read_protected_canonical_paths() {
        let dir = tempfile::tempdir().unwrap();
        let protected = dir.path().join(".git");
        std::fs::create_dir(&protected).unwrap();
        let image = protected.join("secret.svg");
        std::fs::write(&image, "SYNTHETIC_PRIVATE_MEDIA").unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(dir.path()),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();
        assert_eq!(
            respond(&grants, "main", &request(&image, &token), &limits).status(),
            403
        );
        #[cfg(unix)]
        {
            let link = dir.path().join("innocent.svg");
            std::os::unix::fs::symlink(&image, &link).unwrap();
            assert_eq!(
                respond(&grants, "main", &request(&link, &token), &limits).status(),
                403
            );
        }
        // Explicitly selected media retains the user's direct file grant.
        let direct = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&image),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        assert_eq!(
            respond(&grants, "main", &request(&image, &direct), &limits).status(),
            200
        );
    }

    #[test]
    fn symlinks_that_leave_the_grant_boundary_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("private.png");
        std::fs::write(&secret, "SYNTHETIC_PRIVATE_MEDIA").unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(dir.path()),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();
        #[cfg(unix)]
        {
            let linked = dir.path().join("escape.png");
            std::os::unix::fs::symlink(&secret, &linked).unwrap();
            let response = respond(&grants, "main", &request(&linked, &token), &limits);
            assert_eq!(response.status(), 403);
            assert_eq!(code(&response), "outside-grant");
            assert!(!String::from_utf8_lossy(response.body()).contains("SYNTHETIC_PRIVATE_MEDIA"));

            // A replaced grant root is re-canonicalized per request, so the
            // replacement cannot be read through the old grant either.
            let replaced = tempfile::tempdir().unwrap();
            let token = grants
                .grant(
                    "main".into(),
                    None,
                    &super::super::to_canon(replaced.path()),
                    WorkspaceEnv::Local,
                    0,
                    0,
                )
                .unwrap();
            std::fs::remove_dir_all(replaced.path()).unwrap();
            std::os::unix::fs::symlink(outside.path(), replaced.path()).unwrap();
            let installed = replaced.path().join("private.png");
            let response = respond(&grants, "main", &request(&installed, &token), &limits);
            assert_eq!(response.status(), 403);
            assert_eq!(code(&response), "outside-grant");
        }
    }

    #[test]
    fn asset_documents_and_ungranted_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let image = dir.path().join("safe.png");
        let html = dir.path().join("demo.html");
        let secret = outside.path().join("private.png");
        for path in [&image, &html, &secret] {
            std::fs::write(path, "SYNTHETIC_FIXTURE").unwrap();
        }
        let grants = AssetGrants::default();
        let limits = test_limits();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(dir.path()),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        assert_eq!(
            code(&respond(&grants, "main", &request(&html, &token), &limits)),
            "unsupported-media"
        );
        assert_eq!(
            code(&respond(&grants, "main", &request(&secret, &token), &limits)),
            "outside-grant"
        );
        assert_eq!(
            code(&respond(&grants, "main", &request(&image, "unknown"), &limits)),
            "invalid-grant"
        );
        assert_eq!(
            code(&respond(&grants, "other", &request(&image, &token), &limits)),
            "invalid-grant"
        );
        let result = respond(&grants, "main", &request(&image, &token), &limits);
        assert_eq!(result.body(), b"SYNTHETIC_FIXTURE");
        assert_eq!(result.headers()["Content-Type"], "image/png");
        assert!(result.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap()
            .contains("sandbox"));
        grants.revoke_owner("main");
        assert_eq!(
            respond(&grants, "main", &request(&image, &token), &limits).status(),
            403
        );
    }

    /// A PDF is a document the app only ever *reads*: the request for it must be served as
    /// `application/pdf` with ranges advertised, an unbounded request must be answered with the
    /// whole file (the path the PDF iframe actually takes), and a range must be clamped so one
    /// request cannot pull an arbitrary slice into memory. The acceptance scenario (issue #30)
    /// records which of these the real WebKitGTK webview asked for.
    #[test]
    fn pdf_media_is_served_with_ranges_and_each_range_is_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fixture.pdf");
        let body = vec![b'x'; 3 * 1024 * 1024];
        std::fs::write(&path, &body).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                grants.generation("main"),
                grants.scope_generation("main", None),
            )
            .unwrap();

        let limits = DeliveryLimits::approved();
        let whole = respond(&grants, "main", &request(&path, &token), &limits);
        assert_eq!(whole.status(), 200);
        assert_eq!(whole.headers()["Content-Type"], "application/pdf");
        assert_eq!(whole.headers()["Content-Length"], body.len().to_string());
        assert_eq!(whole.headers()["Accept-Ranges"], "bytes");
        assert_eq!(whole.body().len(), body.len());

        let clamped = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=0-2999999"),
            &limits,
        );
        assert_eq!(clamped.status(), 206);
        assert_eq!(clamped.body().len(), 1024 * 1024);
        assert_eq!(
            clamped.headers()["Content-Range"],
            "bytes 0-1048575/3145728"
        );

        let tail = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=1048576-"),
            &limits,
        );
        assert_eq!(tail.status(), 206);
        assert_eq!(tail.body().len(), 1024 * 1024);
        assert_eq!(
            tail.headers()["Content-Range"],
            "bytes 1048576-2097151/3145728"
        );
    }

    #[test]
    fn media_ranges_and_script_disabled_svg_remain_available() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("graphic.svg");
        std::fs::write(&path, "<svg><script>test()</script></svg>").unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let response = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=0-4"),
            &test_limits(),
        );
        assert_eq!(response.status(), 206);
        assert_eq!(response.body(), b"<svg>");
        assert_eq!(
            response.headers()["Content-Security-Policy"],
            "sandbox; default-src 'none'; style-src 'unsafe-inline'"
        );
    }

    #[test]
    fn ranges_are_chunk_bounded_and_never_allocate_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.png");
        std::fs::write(&path, vec![b'x'; 200]).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();

        // `bytes=0-` is what a media element sends: one chunk, not 200 bytes.
        let open_ended = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=0-"),
            &limits,
        );
        assert_eq!(open_ended.status(), 206);
        assert_eq!(open_ended.body().len(), 32);
        assert_eq!(open_ended.headers()["Content-Range"], "bytes 0-31/200");
        assert_eq!(open_ended.headers()["Content-Length"], "32");

        let middle = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=32-199"),
            &limits,
        );
        assert_eq!(middle.body().len(), 32);
        assert_eq!(middle.headers()["Content-Range"], "bytes 32-63/200");

        // A HEAD carries the headers of the chunk without the bytes.
        let mut head = ranged(request(&path, &token), "bytes=0-");
        *head.method_mut() = tauri::http::Method::HEAD;
        let head = respond(&grants, "main", &head, &limits);
        assert_eq!(head.status(), 206);
        assert_eq!(head.headers()["Content-Length"], "32");
        assert!(head.body().is_empty());

        assert_eq!(
            code(&respond(
                &grants,
                "main",
                &ranged(request(&path, &token), "bytes=999-"),
                &limits
            )),
            "invalid-range"
        );
        assert_eq!(
            code(&respond(
                &grants,
                "main",
                &ranged(request(&path, &token), "bytes=0-1,4-5"),
                &limits
            )),
            "invalid-range"
        );
    }

    #[test]
    fn non_range_reads_are_bounded_and_need_an_explicit_override() {
        let dir = tempfile::tempdir().unwrap();
        let grants = AssetGrants::default();
        let limits = test_limits();

        let small = dir.path().join("small.png");
        std::fs::write(&small, vec![b'a'; 60]).unwrap();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&small),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let response = respond(&grants, "main", &request(&small, &token), &limits);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body().len(), 60);

        let medium = dir.path().join("medium.png");
        std::fs::write(&medium, vec![b'b'; 96]).unwrap();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&medium),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let refusal = respond(&grants, "main", &request(&medium, &token), &limits);
        assert_eq!(refusal.status(), 413);
        assert_eq!(code(&refusal), "too-large");
        assert_eq!(refusal.headers()["X-Terax-Asset-Override"], "1");
        assert_eq!(refusal.headers()["Accept-Ranges"], "bytes");
        assert!(!String::from_utf8_lossy(refusal.body()).contains("bbbb"));
        let allowed = respond(&grants, "main", &overridden(request(&medium, &token)), &limits);
        assert_eq!(allowed.status(), 200);
        assert_eq!(allowed.body().len(), 96);

        let huge = dir.path().join("huge.png");
        std::fs::write(&huge, vec![b'c'; 160]).unwrap();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&huge),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let refusal = respond(&grants, "main", &request(&huge, &token), &limits);
        assert_eq!(refusal.status(), 413);
        assert!(refusal.headers().get("X-Terax-Asset-Override").is_none());
        assert_eq!(refusal.headers()["X-Terax-Asset-Alternatives"], "open-externally");
        // Even the explicit override cannot allocate above the hard ceiling.
        assert_eq!(
            respond(&grants, "main", &overridden(request(&huge, &token)), &limits).status(),
            413
        );
    }

    #[test]
    fn outstanding_deliveries_are_bounded_by_count_and_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, vec![b'x'; 200]).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();
        let first = grants.reserve(32, &limits).unwrap();
        let second = grants.reserve(32, &limits).unwrap();
        assert_eq!(grants.outstanding(), (2, 64));
        // A third read is refused explicitly instead of allocating unbounded.
        let busy = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=0-"),
            &limits,
        );
        assert_eq!(busy.status(), 503);
        assert_eq!(code(&busy), "too-many-reads");
        assert_eq!(busy.headers()["Retry-After"], "1");
        drop(first);
        drop(second);
        assert_eq!(grants.outstanding(), (0, 0));
        assert_eq!(
            respond(
                &grants,
                "main",
                &ranged(request(&path, &token), "bytes=0-"),
                &limits
            )
            .status(),
            206
        );
        // A read bigger than the whole byte budget never waits for a slot.
        assert!(grants.reserve(129, &limits).is_err());
    }

    #[test]
    fn revocation_during_a_read_aborts_the_response() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, vec![b'x'; 60]).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                Some("tab-1".into()),
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let mut revoked_at = None;
        let response = deliver(
            &grants,
            "main",
            &request(&path, &token),
            &test_limits(),
            &mut |stage| {
                if stage == DeliveryStage::Reserved {
                    revoked_at = Some(grants.state.lock().unwrap().grants.len());
                    grants.revoke_scope("main", "tab-1");
                }
            },
        )
        .unwrap_err();
        assert!(revoked_at.is_some());
        assert_eq!(response.status, 409);
        assert_eq!(response.code, "revoked");
        assert!(!response.response().body().is_empty());
        assert_eq!(grants.outstanding(), (0, 0));
        // The token is gone for later requests too.
        assert_eq!(
            code(&respond(&grants, "main", &request(&path, &token), &test_limits())),
            "invalid-grant"
        );
    }

    #[test]
    fn one_token_cannot_be_read_after_the_owner_is_revoked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, "SYNTHETIC_FIXTURE").unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        grants.revoke_owner("main");
        assert_eq!(
            code(&respond(&grants, "main", &request(&path, &token), &test_limits())),
            "invalid-grant"
        );
    }

    #[test]
    fn the_token_survives_an_extra_query_parameter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, "SYNTHETIC_FIXTURE").unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let encoded = percent_encoding::utf8_percent_encode(
            &super::super::to_canon(&path),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let probe = Request::builder()
            .uri(format!(
                "https://asset.localhost/{encoded}?override=1&token={token}"
            ))
            .body(Vec::new())
            .unwrap();
        assert_eq!(respond(&grants, "main", &probe, &test_limits()).status(), 200);
    }

    #[test]
    fn a_missing_or_foreign_grant_is_refused_with_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        std::fs::write(&path, "SYNTHETIC_FIXTURE").unwrap();
        let grants = AssetGrants::default();
        let encoded = percent_encoding::utf8_percent_encode(
            &super::super::to_canon(&path),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let probe = Request::builder()
            .uri(format!("https://asset.localhost/{encoded}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            code(&respond(&grants, "main", &probe, &test_limits())),
            "missing-grant"
        );
        let mut post = request(&path, "token");
        *post.method_mut() = tauri::http::Method::POST;
        assert_eq!(
            code(&respond(&grants, "main", &post, &test_limits())),
            "method-not-allowed"
        );
    }

    #[test]
    fn approved_delivery_limits_mirror_the_contract() {
        let limits = DeliveryLimits::approved();
        assert_eq!(limits.read_bytes, 10 * 1024 * 1024);
        assert_eq!(limits.override_bytes, 50 * 1024 * 1024);
        assert!(limits.chunk_bytes <= limits.read_bytes);
        assert!(limits.outstanding > 0);
        assert_eq!(limits.outstanding, MAX_OUTSTANDING_DELIVERIES);
        assert_eq!(limits.outstanding_bytes, limits.override_bytes);
    }

    #[test]
    fn media_seek_ranges_are_served_from_the_requested_offset() {
        // A media element seeks by asking for a new range; the handler must
        // serve from that offset in one bounded chunk, not restart at zero or
        // allocate the rest of the file.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        let body: Vec<u8> = (0..200u8).collect();
        std::fs::write(&path, &body).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                Some("tab-media".into()),
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();

        let seek = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=100-"),
            &limits,
        );
        assert_eq!(seek.status(), 206);
        assert_eq!(seek.headers()["Content-Type"], "video/mp4");
        assert_eq!(seek.headers()["Accept-Ranges"], "bytes");
        assert_eq!(seek.headers()["Content-Range"], "bytes 100-131/200");
        assert_eq!(seek.body(), &body[100..132]);

        // The next chunk continues where the previous one stopped.
        let next = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=132-"),
            &limits,
        );
        assert_eq!(next.headers()["Content-Range"], "bytes 132-163/200");
        assert_eq!(next.body(), &body[132..164]);

        // The tail of the file is short, not padded.
        let tail = respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=190-"),
            &limits,
        );
        assert_eq!(tail.status(), 206);
        assert_eq!(tail.headers()["Content-Range"], "bytes 190-199/200");
        assert_eq!(tail.body(), &body[190..200]);
    }

    #[test]
    fn whole_file_media_reads_cannot_bypass_the_delivery_limits() {
        // Audio/video are streamed through ranges, but a caller that omits
        // `Range` must not get an unexamined whole-file allocation around the
        // approved ceilings.
        let dir = tempfile::tempdir().unwrap();
        let grants = AssetGrants::default();
        let limits = test_limits();

        let medium = dir.path().join("clip.webm");
        std::fs::write(&medium, vec![b'w'; 96]).unwrap();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&medium),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let refusal = respond(&grants, "main", &request(&medium, &token), &limits);
        assert_eq!(refusal.status(), 413);
        assert_eq!(code(&refusal), "too-large");
        assert_eq!(refusal.headers()["X-Terax-Asset-Override"], "1");
        assert!(!String::from_utf8_lossy(refusal.body()).contains("wwww"));

        let huge = dir.path().join("clip.mov");
        std::fs::write(&huge, vec![b'm'; 160]).unwrap();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&huge),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        assert_eq!(
            respond(&grants, "main", &request(&huge, &token), &limits).status(),
            413
        );
        assert_eq!(
            respond(&grants, "main", &overridden(request(&huge, &token)), &limits).status(),
            413
        );
    }

    #[test]
    fn the_delivery_log_records_what_the_element_requested() {
        // The real-app scenario reads this log to assert that playback and
        // seeking actually issued ranged requests, instead of inferring range
        // support from the file extension or from `canPlayType`.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.webm");
        std::fs::write(&path, vec![b'x'; 200]).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();

        respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=0-"),
            &limits,
        );
        respond(
            &grants,
            "main",
            &ranged(request(&path, &token), "bytes=64-"),
            &limits,
        );
        let log = grants.delivery_log();
        assert_eq!(log.len(), 2);
        assert_eq!(
            log[0],
            DeliveryRecord {
                start: 0,
                length: 32,
                size: 200,
                status: 206,
                ranged: true,
            }
        );
        assert_eq!(log[1].start, 64);
        assert_eq!(log[1].length, 32);

        grants.clear_delivery_log();
        assert!(grants.delivery_log().is_empty());
    }

    #[test]
    fn loopback_media_delivery_serves_ranges_under_the_same_bounds() {
        // WebKitGTK's media backend is served over loopback HTTP because it
        // rejects custom URI schemes. The policy must be the asset scheme's:
        // one chunk per range, no whole-file allocation, revocation honoured.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.wav");
        let body: Vec<u8> = (0..200u8).collect();
        std::fs::write(&path, &body).unwrap();
        let grants = AssetGrants::default();
        let token = grants
            .grant(
                "main".into(),
                Some("tab-media".into()),
                &super::super::to_canon(&path),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let limits = test_limits();

        let seek = deliver_media(&grants, &token, Some("bytes=100-"), &limits).unwrap();
        assert_eq!(seek.status, 206);
        assert_eq!(seek.mime, "audio/wav");
        assert_eq!(seek.start, 100);
        assert_eq!(seek.length, 32);
        assert_eq!(seek.size, 200);
        assert_eq!(seek.body, body[100..132]);

        // No range is still bounded: a 200-byte file over a 64-byte ceiling is
        // refused. A file the explicit override can reach still offers it.
        let refusal = deliver_media(&grants, &token, None, &limits).unwrap_err();
        assert_eq!(refusal.status, 413);
        let medium = dir.path().join("medium.wav");
        std::fs::write(&medium, vec![b'm'; 96]).unwrap();
        let medium_token = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(&medium),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        let overrideable = deliver_media(&grants, &medium_token, None, &limits).unwrap_err();
        assert_eq!(overrideable.status, 413);
        assert!(overrideable.override_allowed);
        let bogus = deliver_media(&grants, &token, Some("bytes=999-"), &limits).unwrap_err();
        assert_eq!(bogus.status, 416);
        assert_eq!(bogus.size, Some(200));
        let multi = deliver_media(&grants, &token, Some("bytes=0-1,4-5"), &limits).unwrap_err();
        assert_eq!(multi.status, 416);

        assert_eq!(
            deliver_media(&grants, "unknown", None, &limits)
                .unwrap_err()
                .status,
            403
        );
        // The same log powers the app-lab range evidence.
        let log = grants.delivery_log();
        assert!(log.iter().any(|record| record.ranged
            && record.start == 100
            && record.length == 32));
        grants.revoke_scope("main", "tab-media");
        assert_eq!(
            deliver_media(&grants, &token, Some("bytes=0-"), &limits)
                .unwrap_err()
                .status,
            403
        );

        // A directory grant is not a media source.
        let directory = grants
            .grant(
                "main".into(),
                None,
                &super::super::to_canon(dir.path()),
                WorkspaceEnv::Local,
                0,
                0,
            )
            .unwrap();
        assert_eq!(
            deliver_media(&grants, &directory, Some("bytes=0-"), &limits)
                .unwrap_err()
                .status,
            415
        );
    }

    #[test]
    fn loopback_media_writes_a_valid_range_response() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let body = b"0123456789".to_vec();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            write_media_response(
                &mut stream,
                MediaResponse {
                    status: 206,
                    mime: "audio/wav",
                    size: 10,
                    start: 4,
                    length: 4,
                    ranged: true,
                    body: body[4..8].to_vec(),
                },
                false,
            )
            .unwrap();
            let _ = stream.shutdown(std::net::Shutdown::Write);
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .write_all(b"GET /media?token=t HTTP/1.1\r\nRange: bytes=4-\r\n\r\n")
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        server.join().unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(text.contains("Content-Range: bytes 4-7/10\r\n"));
        assert!(text.contains("Accept-Ranges: bytes\r\n"));
        assert!(text.contains("Access-Control-Allow-Origin: *\r\n"));
        assert!(text.ends_with("4567"));
    }
}

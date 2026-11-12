//! Bench-only observation of what the app's media/asset server actually served.
//!
//! The PDF acceptance scenario (issue #30) has to state what the real WebKitGTK webview did with a
//! local PDF: did it request the file at all, with which method, did it ask for a byte range, what
//! content type and size came back, and did closing the tab release the grant. None of that is
//! visible from the page (the PDF document is a separate, cross-origin document and the app's CSP
//! keeps scripts out of `asset:`), so the one honest place to observe it is the native handler
//! that answered the request.
//!
//! This module exists only with the `bench` cargo feature. It records file *names*, never tokens
//! or absolute paths, and keeps a bounded ring of entries.

use std::sync::Mutex;

use serde::Serialize;
use tauri::http::Request;

const MAX_ENTRIES: usize = 512;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    seq: u64,
    owner: String,
    method: String,
    file: String,
    status: Option<u16>,
    mime: Option<String>,
    bytes: usize,
    /// The client's `Range` header, verbatim (absent when the client asked for the whole file).
    range: Option<String>,
    content_range: Option<String>,
    accept_ranges: bool,
    /// Why the handler refused the request, if it did.
    error: Option<String>,
}

#[derive(Default)]
struct Log {
    entries: Vec<Entry>,
    dropped: usize,
    seq: u64,
}

static LOG: Mutex<Option<Log>> = Mutex::new(None);

/// Records one asset request/response pair from `assets::serve`.
pub fn record(
    owner: &str,
    request: &Request<Vec<u8>>,
    result: &Result<tauri::http::Response<Vec<u8>>, String>,
) {
    let mut file = request
        .uri()
        .path()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_owned();
    // `convertFileSrc` percent-encodes the whole path into one URI segment, so decode before
    // taking the name: the log keeps a basename, never an absolute path.
    if let Ok(decoded) = percent_encoding::percent_decode_str(&file).decode_utf8() {
        file = decoded.rsplit('/').next().unwrap_or("").to_owned();
    }
    let range = request
        .headers()
        .get("Range")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut log = LOG.lock().unwrap();
    let log = log.get_or_insert_with(Log::default);
    log.seq += 1;
    let entry = match result {
        Ok(response) => {
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            };
            Entry {
                seq: log.seq,
                owner: owner.to_owned(),
                method: request.method().as_str().to_owned(),
                file,
                status: Some(response.status().as_u16()),
                mime: header("Content-Type"),
                bytes: response.body().len(),
                range,
                content_range: header("Content-Range"),
                accept_ranges: response.headers().contains_key("Accept-Ranges"),
                error: None,
            }
        }
        Err(error) => Entry {
            seq: log.seq,
            owner: owner.to_owned(),
            method: request.method().as_str().to_owned(),
            file,
            status: None,
            mime: None,
            bytes: 0,
            range,
            content_range: None,
            accept_ranges: false,
            error: Some(error.clone()),
        },
    };
    if log.entries.len() >= MAX_ENTRIES {
        log.entries.remove(0);
        log.dropped += 1;
    }
    log.entries.push(entry);
}

/// The entries recorded so far, plus the number of live grants at the time of the snapshot.
pub fn snapshot(active_grants: usize) -> serde_json::Value {
    let log = LOG.lock().unwrap();
    let log = log.as_ref();
    serde_json::json!({
        "activeGrants": active_grants,
        "dropped": log.map(|log| log.dropped).unwrap_or(0),
        "entries": log.map(|log| log.entries.iter().collect::<Vec<_>>()).unwrap_or_default(),
    })
}

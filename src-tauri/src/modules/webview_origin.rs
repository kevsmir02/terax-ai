//! Which origins the application's own pages are served from.
//!
//! Two native seams answer a request that a webview made outside the IPC
//! boundary: the `terax-pty` scheme (streamed terminal frames) and the loopback
//! media endpoint (a transport for media grants, because WebKitGTK cannot load
//! media from the custom `asset:` scheme). Both must name the application's own
//! origin in `Access-Control-Allow-Origin` and never `*`, and both must refuse
//! a request from any other origin (a preview iframe, a page the person
//! browsed to). Keeping one rule here is what stops the two seams from
//! drifting apart.

use std::sync::Arc;

use tauri::Url;

/// The origins the application's own pages are served from. A request from any
/// other origin (a preview iframe, a page the user browsed to) is refused, and
/// a response only ever names one of these in `Access-Control-Allow-Origin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AllowedOrigins {
    pub(crate) origins: Vec<Arc<str>>,
}

impl AllowedOrigins {
    /// Mirrors how Tauri derives the window origin: the dev server's origin in
    /// a dev build, otherwise `tauri://localhost`, or `{http,https}://tauri.localhost`
    /// on Windows (the scheme depends on `useHttpsScheme`, so both are allowed).
    pub fn for_app(dev_url: Option<&Url>, dev: bool, windows: bool) -> Self {
        let dev_origin = dev_url
            .filter(|_| dev)
            .and_then(|url| Some(format!("{}://{}{}", url.scheme(), url.host()?, port(url))));
        let origins = match dev_origin {
            Some(origin) => vec![origin],
            None if windows => vec![
                "http://tauri.localhost".to_string(),
                "https://tauri.localhost".to_string(),
            ],
            None => vec!["tauri://localhost".to_string()],
        };
        Self {
            origins: origins.into_iter().map(Arc::from).collect(),
        }
    }

    /// The origin to name in the response, or `None` when the request must be
    /// refused. A request without an `Origin` header is not a cross-origin
    /// browser request (browsers always attach one to a CORS read or a POST),
    /// so the capability the request carries — the stream token, the media
    /// grant — authorizes it, and the response names the application's own
    /// origin, which is what a browser enforcing CORS on it would compare.
    pub fn check(&self, header: Option<&[u8]>) -> Option<Arc<str>> {
        match header {
            None => self.origins.first().cloned(),
            Some(value) => self
                .origins
                .iter()
                .find(|origin| origin.as_bytes() == value)
                .cloned(),
        }
    }
}

fn port(url: &Url) -> String {
    url.port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    fn origins() -> AllowedOrigins {
        AllowedOrigins::for_app(None, false, false)
    }

    #[test]
    fn allowed_origins_follow_how_tauri_serves_the_page() {
        assert_eq!(origins().origins, [Arc::<str>::from("tauri://localhost")]);
        let windows = AllowedOrigins::for_app(None, false, true);
        assert_eq!(
            windows.origins,
            [
                Arc::<str>::from("http://tauri.localhost"),
                Arc::<str>::from("https://tauri.localhost")
            ]
        );
        let dev_url = url("http://localhost:1420/some/path?x=1");
        for windows in [false, true] {
            let dev = AllowedOrigins::for_app(Some(&dev_url), true, windows);
            assert_eq!(dev.origins, [Arc::<str>::from("http://localhost:1420")]);
        }
        // A configured dev URL means nothing to a production build.
        assert_eq!(
            AllowedOrigins::for_app(Some(&dev_url), false, false),
            origins()
        );
        let bare = url("https://dev.example");
        assert_eq!(
            AllowedOrigins::for_app(Some(&bare), true, false).origins,
            [Arc::<str>::from("https://dev.example")]
        );
    }

    #[test]
    fn only_an_exact_allowed_origin_is_echoed() {
        let allowed = origins();
        assert_eq!(
            allowed.check(Some(b"tauri://localhost")).as_deref(),
            Some("tauri://localhost")
        );
        for foreign in [
            &b"null"[..],
            b"https://evil.example",
            b"http://localhost:1420",
            b"tauri://localhost.evil.example",
            b"tauri://localhost/",
            b"TAURI://LOCALHOST",
            b"",
            b"*",
        ] {
            assert_eq!(allowed.check(Some(foreign)), None, "{foreign:?}");
        }
        // No Origin header: not a cross-origin browser request.
        assert_eq!(allowed.check(None).as_deref(), Some("tauri://localhost"));
    }
}

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const RELEASE_CONTRACT_JSON: &str =
    include_str!("../../../src/modules/updater/releaseContract.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedContract {
    endpoints: Vec<String>,
    check: EmbeddedCheckConfig,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmbeddedCheckConfig {
    timeout_ms: u64,
}

struct ContractConfig {
    pinned_endpoint: String,
    timeout: Duration,
}

static CONTRACT_CONFIG: OnceLock<ContractConfig> = OnceLock::new();

fn contract_config() -> &'static ContractConfig {
    CONTRACT_CONFIG.get_or_init(|| {
        let parsed: EmbeddedContract =
            serde_json::from_str(RELEASE_CONTRACT_JSON).expect("valid releaseContract.json");
        let pinned_endpoint = parsed
            .endpoints
            .into_iter()
            .next()
            .expect("releaseContract.json must declare a pinned endpoint");
        assert!(
            pinned_endpoint.starts_with("https://"),
            "pinned release endpoint must use HTTPS"
        );
        ContractConfig {
            pinned_endpoint,
            timeout: Duration::from_millis(parsed.check.timeout_ms),
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFetchResponse {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ManifestFailureReason {
    Offline,
    Blocked,
    Timeout,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFetchError {
    pub reason: ManifestFailureReason,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub url: String,
    pub https_only: bool,
}

pub const MAX_REDIRECTS: u32 = 5;
pub const MAX_BODY_BYTES: u64 = 1024 * 1024;

pub fn resolve_target(
    endpoint_override: Option<&str>,
    allow_loopback_override: bool,
) -> Result<ResolvedTarget, ManifestFetchError> {
    let contract = contract_config();
    let pinned = ResolvedTarget {
        url: contract.pinned_endpoint.clone(),
        https_only: true,
    };

    if !allow_loopback_override {
        return Ok(pinned);
    }

    let Some(raw) = endpoint_override.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(pinned);
    };

    let parsed = tauri::Url::parse(raw).map_err(|error| ManifestFetchError {
        reason: ManifestFailureReason::Blocked,
        detail: format!("invalid debug update endpoint override: {error}"),
    })?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ManifestFetchError {
            reason: ManifestFailureReason::Blocked,
            detail: "debug update endpoint override must not include credentials".to_string(),
        });
    }

    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ManifestFetchError {
            reason: ManifestFailureReason::Blocked,
            detail: format!("disallowed update endpoint scheme: {scheme}"),
        });
    }

    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1") {
        return Err(ManifestFetchError {
            reason: ManifestFailureReason::Blocked,
            detail: format!(
                "debug update endpoint override must target a loopback host (127.0.0.1, localhost, or [::1]); got {host}"
            ),
        });
    }

    Ok(ResolvedTarget {
        url: parsed.to_string(),
        https_only: scheme == "https",
    })
}

pub fn contract_timeout() -> Duration {
    contract_config().timeout
}

fn build_agent_config(https_only: bool, timeout: Duration) -> ureq::config::Config {
    ureq::Agent::config_builder()
        .https_only(https_only)
        .max_redirects(MAX_REDIRECTS)
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build()
}

pub fn fetch_manifest_blocking(
    target: &ResolvedTarget,
    timeout: Duration,
) -> Result<ManifestFetchResponse, ManifestFetchError> {
    let config = build_agent_config(target.https_only, timeout);
    let agent = ureq::Agent::new_with_config(config);
    fetch_with_agent(&agent, &target.url)
}

/// Fetches the fork release manifest via a bounded `ureq` request on Tokio's blocking pool.
///
/// In release builds, any caller-provided URL is ignored and only the pinned endpoint in
/// `releaseContract.json` is queried. Debug builds permit loopback overrides for local fixtures.
#[tauri::command]
pub async fn updater_fetch_manifest(
    endpoint_override: Option<String>,
) -> Result<ManifestFetchResponse, ManifestFetchError> {
    let target = resolve_target(endpoint_override.as_deref(), cfg!(debug_assertions))?;
    let timeout = contract_timeout();
    tokio::task::spawn_blocking(move || fetch_manifest_blocking(&target, timeout))
        .await
        .map_err(|error| ManifestFetchError {
            reason: ManifestFailureReason::Offline,
            detail: format!("manifest fetch task failed: {error}"),
        })?
}

fn fetch_with_agent(
    agent: &ureq::Agent,
    url: &str,
) -> Result<ManifestFetchResponse, ManifestFetchError> {
    let mut response = agent
        .get(url)
        .header("accept", "application/json")
        .call()
        .map_err(classify_ureq_error)?;

    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_BODY_BYTES)
        .read_to_string()
        .map_err(classify_ureq_error)?;

    Ok(ManifestFetchResponse {
        status,
        retry_after,
        body,
    })
}

fn classify_ureq_error(error: ureq::Error) -> ManifestFetchError {
    let detail = error.to_string();
    let reason = match error {
        ureq::Error::Timeout(_) => ManifestFailureReason::Timeout,
        ureq::Error::Tls(_)
        | ureq::Error::TlsRequired
        | ureq::Error::Pem(_)
        | ureq::Error::Rustls(_)
        | ureq::Error::RequireHttpsOnly(_)
        | ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::TooManyRedirects
        | ureq::Error::RedirectFailed
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::BadUri(_)
        | ureq::Error::Http(_) => ManifestFailureReason::Blocked,
        ureq::Error::Io(ref io_err) => match io_err.kind() {
            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                ManifestFailureReason::Timeout
            }
            std::io::ErrorKind::InvalidData | std::io::ErrorKind::PermissionDenied => {
                ManifestFailureReason::Blocked
            }
            _ => ManifestFailureReason::Offline,
        },
        _ => ManifestFailureReason::Offline,
    };
    ManifestFetchError { reason, detail }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn spawn_loopback_server<F>(handler: F) -> (String, thread::JoinHandle<()>)
    where
        F: FnOnce(&str) -> Vec<u8> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            let resp = handler(&req);
            let _ = stream.write_all(&resp);
            let _ = stream.flush();
        });
        (format!("http://127.0.0.1:{}", addr.port()), handle)
    }

    #[test]
    fn projects_status_retry_after_and_body_from_loopback_response() {
        let body = r#"{"version":"1.0.1","channel":"stable","platforms":{}}"#;
        let (base_url, handle) = spawn_loopback_server(move |req| {
            assert!(
                req.starts_with("GET /latest.json "),
                "unexpected req: {req}"
            );
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .into_bytes()
        });

        let target = ResolvedTarget {
            url: format!("{base_url}/latest.json"),
            https_only: false,
        };
        let result = fetch_manifest_blocking(&target, Duration::from_secs(2))
            .expect("200 response should succeed");
        handle.join().expect("server thread");

        assert_eq!(result.status, 200);
        assert_eq!(result.retry_after, None);
        assert_eq!(result.body, body);

        let (rate_url, rate_handle) = spawn_loopback_server(|_| {
            b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 45\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        });
        let rate_target = ResolvedTarget {
            url: format!("{rate_url}/latest.json"),
            https_only: false,
        };
        let rate_result = fetch_manifest_blocking(&rate_target, Duration::from_secs(2))
            .expect("429 response should project status and retryAfter");
        rate_handle.join().expect("rate server thread");

        assert_eq!(rate_result.status, 429);
        assert_eq!(rate_result.retry_after.as_deref(), Some("45"));
        assert_eq!(rate_result.body, "");
    }

    #[test]
    fn enforces_pinned_endpoint_in_release_and_loopback_only_in_debug() {
        let pinned = "https://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json";
        assert_eq!(contract_timeout(), Duration::from_millis(8000));

        // Release mode ignores any caller override, even loopback or malicious hosts.
        for candidate in [
            None,
            Some("http://127.0.0.1:8787/stable.json"),
            Some("https://evil.example/latest.json"),
        ] {
            let resolved = resolve_target(candidate, false).expect("release uses pinned endpoint");
            assert_eq!(resolved.url, pinned);
            assert!(resolved.https_only);
        }

        // Debug mode uses pinned endpoint when no override is supplied.
        let debug_default = resolve_target(None, true).expect("debug default");
        assert_eq!(debug_default.url, pinned);
        assert!(debug_default.https_only);

        // Debug mode accepts loopback overrides.
        for loopback in [
            "http://127.0.0.1:8787/stable.json",
            "http://localhost:8787/stable.json",
            "http://[::1]:8787/stable.json",
            "https://127.0.0.1:8443/stable.json",
        ] {
            let resolved = resolve_target(Some(loopback), true).expect(loopback);
            assert_eq!(resolved.url, loopback);
            assert_eq!(resolved.https_only, loopback.starts_with("https://"));
        }

        // Debug mode rejects non-loopback hosts, userinfo tricks, and non-HTTP schemes.
        for rejected in [
            "https://github.com/evil/latest.json",
            "http://192.168.1.10:8787/latest.json",
            "http://127.0.0.1.evil.com/latest.json",
            "http://user@127.0.0.1:8787/latest.json",
            "file:///etc/passwd",
            "ftp://127.0.0.1/latest.json",
            "not-a-url",
        ] {
            let err = resolve_target(Some(rejected), true).expect_err(rejected);
            assert_eq!(err.reason, ManifestFailureReason::Blocked, "{rejected}");
        }
    }

    // Debug mode rejects non-loopback hosts, userinfo tricks, and non-HTTP schemes.
    #[derive(Debug)]
    struct PretendTlsTransport(Box<dyn ureq::unversioned::transport::Transport>);

    impl ureq::unversioned::transport::Transport for PretendTlsTransport {
        fn buffers(&mut self) -> &mut dyn ureq::unversioned::transport::Buffers {
            self.0.buffers()
        }

        fn transmit_output(
            &mut self,
            amount: usize,
            timeout: ureq::unversioned::transport::NextTimeout,
        ) -> Result<(), ureq::Error> {
            self.0.transmit_output(amount, timeout)
        }

        fn await_input(
            &mut self,
            timeout: ureq::unversioned::transport::NextTimeout,
        ) -> Result<bool, ureq::Error> {
            self.0.await_input(timeout)
        }

        fn is_open(&mut self) -> bool {
            self.0.is_open()
        }

        fn is_tls(&self) -> bool {
            true
        }
    }

    #[derive(Debug, Default)]
    struct PretendTlsConnector(ureq::unversioned::transport::TcpConnector);

    impl ureq::unversioned::transport::Connector<()> for PretendTlsConnector {
        type Out = PretendTlsTransport;

        fn connect(
            &self,
            details: &ureq::unversioned::transport::ConnectionDetails,
            chained: Option<()>,
        ) -> Result<Option<Self::Out>, ureq::Error> {
            use ureq::unversioned::transport::Transport as _;
            match self.0.connect(details, chained)? {
                Some(ureq::unversioned::transport::Either::B(tcp)) => {
                    Ok(Some(PretendTlsTransport(tcp.boxed())))
                }
                _ => Ok(None),
            }
        }
    }

    fn pretend_tls_agent(https_only: bool, timeout: Duration) -> ureq::Agent {
        ureq::Agent::with_parts(
            build_agent_config(https_only, timeout),
            PretendTlsConnector::default(),
            ureq::unversioned::resolver::DefaultResolver::default(),
        )
    }

    fn spawn_multi_loopback_server<F>(
        max_requests: usize,
        handler: F,
    ) -> (u16, thread::JoinHandle<()>)
    where
        F: Fn(usize, &str) -> Vec<u8> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        let handle = thread::spawn(move || {
            for idx in 0..max_requests {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let resp = handler(idx, &req);
                let _ = stream.write_all(&resp);
                let _ = stream.flush();
            }
        });
        (port, handle)
    }

    #[test]
    fn enforces_https_only_bounded_redirects_and_downgrade_refusal() {
        // 1. Direct HTTP request refused when https_only is true.
        let (port, handle) = spawn_loopback_server(|_| {
            panic!("HTTP request must be blocked before opening a TCP connection");
        });
        let http_err = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("{port}/latest.json"),
                https_only: true,
            },
            Duration::from_secs(2),
        )
        .expect_err("https_only rejects plain HTTP");
        assert_eq!(http_err.reason, ManifestFailureReason::Blocked);
        drop(handle);

        // 2. Five HTTPS redirects succeed.
        let (ok_port, ok_handle) = spawn_multi_loopback_server(6, move |idx, _req| {
            if idx < 5 {
                let next = idx + 1;
                format!(
                    "HTTP/1.1 302 Found\r\nLocation: /hop-{next}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .into_bytes()
            } else {
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec()
            }
        });
        let agent = pretend_tls_agent(true, Duration::from_secs(2));
        let ok_res = fetch_with_agent(&agent, &format!("https://127.0.0.1:{ok_port}/hop-0"))
            .expect("5 redirects should succeed");
        ok_handle.join().expect("ok redirect server");
        assert_eq!(ok_res.status, 200);
        assert_eq!(ok_res.body, "{}");

        // 3. Sixth HTTPS redirect fails as blocked.
        let (too_many_port, too_many_handle) = spawn_multi_loopback_server(6, |idx, _req| {
            let next = idx + 1;
            format!(
                "HTTP/1.1 302 Found\r\nLocation: /hop-{next}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_bytes()
        });
        let too_many_err =
            fetch_with_agent(&agent, &format!("https://127.0.0.1:{too_many_port}/hop-0"))
                .expect_err("6th redirect must fail");
        too_many_handle.join().expect("too many redirect server");
        assert_eq!(too_many_err.reason, ManifestFailureReason::Blocked);

        // 4. Redirect downgrade from HTTPS to HTTP is refused as blocked without contacting HTTP target.
        let (downgrade_port, downgrade_handle) = spawn_multi_loopback_server(
            1,
            move |idx, _req| {
                assert_eq!(idx, 0, "must not follow downgraded HTTP hop");
                format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/downgraded\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                65000
            )
            .into_bytes()
            },
        );
        let downgrade_err =
            fetch_with_agent(&agent, &format!("https://127.0.0.1:{downgrade_port}/start"))
                .expect_err("HTTPS -> HTTP redirect downgrade must be blocked");
        downgrade_handle.join().expect("downgrade server");
        assert_eq!(downgrade_err.reason, ManifestFailureReason::Blocked);
    }

    #[test]
    fn enforces_one_mib_body_cap_and_timeout() {
        let exact_body = "a".repeat(MAX_BODY_BYTES as usize);
        let exact_body_clone = exact_body.clone();
        let (ok_url, ok_handle) = spawn_loopback_server(move |_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                exact_body_clone.len(),
                exact_body_clone
            )
            .into_bytes()
        });
        let ok_res = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("{ok_url}/exact"),
                https_only: false,
            },
            Duration::from_secs(2),
        )
        .expect("exact 1 MiB body should succeed");
        ok_handle.join().expect("exact server");
        assert_eq!(ok_res.body.len(), MAX_BODY_BYTES as usize);

        let oversized_body = "a".repeat((MAX_BODY_BYTES as usize) + 1);
        let (big_url, big_handle) = spawn_loopback_server(move |_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                oversized_body.len(),
                oversized_body
            )
            .into_bytes()
        });
        let big_err = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("{big_url}/oversized"),
                https_only: false,
            },
            Duration::from_secs(2),
        )
        .expect_err("1 MiB + 1 byte body must be blocked");
        big_handle.join().expect("oversized server");
        assert_eq!(big_err.reason, ManifestFailureReason::Blocked);

        let slow_listener = TcpListener::bind("127.0.0.1:0").expect("bind slow listener");
        let slow_port = slow_listener.local_addr().expect("slow addr").port();
        let slow_handle = thread::spawn(move || {
            if let Ok((_stream, _)) = slow_listener.accept() {
                thread::sleep(Duration::from_millis(300));
            }
        });
        let timeout_err = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("http://127.0.0.1:{slow_port}/slow"),
                https_only: false,
            },
            Duration::from_millis(50),
        )
        .expect_err("slow server must time out");
        slow_handle.join().expect("slow server");
        assert_eq!(timeout_err.reason, ManifestFailureReason::Timeout);
    }

    #[test]
    fn maps_network_errors_to_offline_and_tls_errors_to_blocked() {
        // 1. Connection refused -> offline.
        let closed_listener = TcpListener::bind("127.0.0.1:0").expect("bind closed");
        let closed_port = closed_listener.local_addr().expect("closed addr").port();
        drop(closed_listener);
        let refused_err = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("http://127.0.0.1:{closed_port}/latest.json"),
                https_only: false,
            },
            Duration::from_secs(2),
        )
        .expect_err("closed port must be offline");
        assert_eq!(refused_err.reason, ManifestFailureReason::Offline);

        // 2. Premature socket close / reset before response -> offline.
        let reset_listener = TcpListener::bind("127.0.0.1:0").expect("bind reset");
        let reset_port = reset_listener.local_addr().expect("reset addr").port();
        let reset_handle = thread::spawn(move || {
            let (stream, _) = reset_listener.accept().expect("accept reset");
            drop(stream);
        });
        let reset_err = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("http://127.0.0.1:{reset_port}/latest.json"),
                https_only: false,
            },
            Duration::from_secs(2),
        )
        .expect_err("dropped socket must be offline");
        reset_handle.join().expect("reset server");
        assert_eq!(reset_err.reason, ManifestFailureReason::Offline);

        // 3. TLS handshake / invalid protocol error on HTTPS endpoint -> blocked.
        let (plain_url, plain_handle) = spawn_loopback_server(|_| {
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec()
        });
        let https_url = plain_url.replacen("http://", "https://", 1);
        let tls_err = fetch_manifest_blocking(
            &ResolvedTarget {
                url: format!("{https_url}/latest.json"),
                https_only: true,
            },
            Duration::from_secs(2),
        )
        .expect_err("non-TLS server on https URL must be blocked");
        plain_handle.join().expect("plain server");
        assert_eq!(tls_err.reason, ManifestFailureReason::Blocked);
    }

    #[tokio::test]
    async fn async_command_runs_on_blocking_pool_for_loopback_override() {
        let body = r#"{"version":"1.0.2"}"#;
        let (base_url, handle) = spawn_loopback_server(move |_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .into_bytes()
        });

        let result = updater_fetch_manifest(Some(format!("{base_url}/stable.json")))
            .await
            .expect("command succeeds for debug loopback override");
        handle.join().expect("async test server");
        assert_eq!(result.status, 200);
        assert_eq!(result.body, body);
    }
}

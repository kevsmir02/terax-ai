//! Admission control for the `terax-pty` scheme: everything that can be
//! decided without waking the hub thread.
//!
//! The scheme is reachable from every frame of a webview, including preview
//! iframes that load arbitrary pages, so each request is judged on the
//! handler's own thread by cheap, pure checks before it costs a hub wake-up:
//! the route, the `Origin` header, the body length, the framing, and finally
//! the stream token the hub published for this webview.

use std::collections::HashMap;
use std::sync::{Arc, PoisonError, RwLock};

use tauri::http::{Method, StatusCode};

use super::hub::Endpoint;
use super::wire::{decode_request, StreamRequest, MAX_REQUEST_LEN};
use crate::modules::webview_origin::AllowedOrigins;

/// The stream token of each webview, published by the hub thread (which owns
/// issuing and revoking them) so request handlers can reject a missing or
/// stale token without a round trip to it.
#[derive(Default)]
pub(super) struct StreamTokens {
    by_label: RwLock<HashMap<Arc<str>, u64>>,
}

impl StreamTokens {
    pub fn publish(&self, label: &Arc<str>, token: u64) {
        self.by_label
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(label.clone(), token);
    }

    pub fn revoke(&self, label: &str) {
        self.by_label
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(label);
    }

    pub fn authorizes(&self, label: &str, token: u64) -> bool {
        self.by_label
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(label)
            .is_some_and(|issued| ct_eq(*issued, token))
    }
}

/// Branch-free equality, so the comparison time does not depend on how many
/// leading bits of a guess are right.
fn ct_eq(a: u64, b: u64) -> bool {
    let diff = std::hint::black_box(a ^ b);
    (diff | diff.wrapping_neg()) >> 63 == 0
}

/// One request as the scheme handler sees it.
pub(super) struct Incoming<'a> {
    pub label: &'a str,
    pub method: &'a Method,
    pub path: &'a str,
    pub origin: Option<&'a [u8]>,
    pub body: &'a [u8],
}

/// What to do with a request. `origin` is what the response may name in
/// `Access-Control-Allow-Origin`; a refused request names none.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Admission {
    Preflight {
        origin: Arc<str>,
    },
    Forward {
        endpoint: Endpoint,
        request: StreamRequest,
        origin: Arc<str>,
    },
    Reject {
        status: StatusCode,
        message: &'static str,
        origin: Option<Arc<str>>,
    },
}

fn reject(status: StatusCode, message: &'static str) -> Admission {
    Admission::Reject {
        status,
        message,
        origin: None,
    }
}

pub(super) fn admit(
    origins: &AllowedOrigins,
    tokens: &StreamTokens,
    incoming: &Incoming<'_>,
) -> Admission {
    // First, and for every method: a foreign page learns nothing about the
    // scheme, not even which routes exist.
    let Some(origin) = origins.check(incoming.origin) else {
        return reject(StatusCode::FORBIDDEN, "origin is not allowed");
    };
    let refuse = |status, message| Admission::Reject {
        status,
        message,
        origin: Some(origin.clone()),
    };
    let preflight = incoming.method == Method::OPTIONS;
    let endpoint = match incoming.path {
        "/poll" => Endpoint::Poll,
        "/ack" => Endpoint::Ack,
        _ if preflight => return Admission::Preflight { origin },
        _ => return refuse(StatusCode::NOT_FOUND, "unknown terax-pty endpoint"),
    };
    if preflight {
        return Admission::Preflight { origin };
    }
    if incoming.method != Method::POST {
        return refuse(StatusCode::METHOD_NOT_ALLOWED, "only POST is allowed");
    }
    if incoming.body.len() > MAX_REQUEST_LEN {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, "request body is too large");
    }
    let request = match decode_request(incoming.body) {
        Ok(request) => request,
        Err(error) => return refuse(StatusCode::BAD_REQUEST, error.message()),
    };
    if !tokens.authorizes(incoming.label, request.token) {
        return refuse(StatusCode::FORBIDDEN, "stale or missing stream token");
    }
    Admission::Forward {
        endpoint,
        request,
        origin,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::pty::wire::{encode_request, Ack, MAX_ACKS_PER_REQUEST};

    fn origins() -> AllowedOrigins {
        AllowedOrigins::for_app(None, false, false)
    }

    fn tokens(token: u64) -> StreamTokens {
        let tokens = StreamTokens::default();
        tokens.publish(&Arc::from("main"), token);
        tokens
    }

    fn incoming<'a>(
        method: &'a Method,
        path: &'a str,
        origin: Option<&'a [u8]>,
        body: &'a [u8],
    ) -> Incoming<'a> {
        Incoming {
            label: "main",
            method,
            path,
            origin,
            body,
        }
    }

    fn rejected(admission: Admission) -> (StatusCode, Option<Arc<str>>) {
        match admission {
            Admission::Reject { status, origin, .. } => (status, origin),
            other => panic!("expected a rejection, got {other:?}"),
        }
    }

    #[test]
    fn tokens_authorize_only_their_own_webview_and_can_be_revoked() {
        let tokens = StreamTokens::default();
        tokens.publish(&Arc::from("main"), 0xAB);
        assert!(tokens.authorizes("main", 0xAB));
        assert!(!tokens.authorizes("main", 0xAC));
        assert!(!tokens.authorizes("main", 0));
        assert!(!tokens.authorizes("settings", 0xAB));
        tokens.publish(&Arc::from("main"), 0xCD);
        assert!(!tokens.authorizes("main", 0xAB));
        assert!(tokens.authorizes("main", 0xCD));
        tokens.revoke("main");
        assert!(!tokens.authorizes("main", 0xCD));
        assert!(!tokens.authorizes("never-opened", 0));
    }

    #[test]
    fn constant_time_equality_agrees_with_equality() {
        for (a, b) in [
            (0, 0),
            (1, 1),
            (u64::MAX, u64::MAX),
            (0, 1),
            (1, 0),
            (1 << 63, 0),
            (0, 1 << 63),
            (u64::MAX, u64::MAX - 1),
        ] {
            assert_eq!(ct_eq(a, b), a == b, "{a} {b}");
        }
    }

    #[test]
    fn a_valid_request_is_forwarded_naming_the_app_origin() {
        let body = encode_request(7, &[Ack { id: 3, bytes: 9 }]);
        for endpoint in ["/poll", "/ack"] {
            let admission = admit(
                &origins(),
                &tokens(7),
                &incoming(&Method::POST, endpoint, Some(b"tauri://localhost"), &body),
            );
            let Admission::Forward {
                request, origin, ..
            } = admission
            else {
                panic!("not forwarded: {admission:?}");
            };
            assert_eq!(request.token, 7);
            assert_eq!(&*origin, "tauri://localhost");
        }
        let without_origin = admit(
            &origins(),
            &tokens(7),
            &incoming(&Method::POST, "/poll", None, &body),
        );
        assert!(matches!(without_origin, Admission::Forward { .. }));
    }

    #[test]
    fn a_foreign_origin_is_refused_even_with_a_valid_token_and_names_no_origin() {
        let body = encode_request(7, &[]);
        for origin in [
            &b"https://evil.example"[..],
            b"null",
            b"http://localhost:1420",
        ] {
            for method in [Method::POST, Method::OPTIONS] {
                let admission = admit(
                    &origins(),
                    &tokens(7),
                    &incoming(&method, "/poll", Some(origin), &body),
                );
                assert_eq!(
                    rejected(admission),
                    (StatusCode::FORBIDDEN, None),
                    "{origin:?}"
                );
            }
        }
    }

    #[test]
    fn a_wrong_or_missing_token_is_forbidden_before_the_hub_is_involved() {
        let wrong = encode_request(8, &[Ack { id: 1, bytes: 1 }]);
        let admission = admit(
            &origins(),
            &tokens(7),
            &incoming(&Method::POST, "/ack", Some(b"tauri://localhost"), &wrong),
        );
        let (status, origin) = rejected(admission);
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(origin.as_deref(), Some("tauri://localhost"));
        let none = StreamTokens::default();
        let admission = admit(
            &origins(),
            &none,
            &incoming(&Method::POST, "/poll", None, &encode_request(7, &[])),
        );
        assert_eq!(rejected(admission).0, StatusCode::FORBIDDEN);
        let other_webview = Incoming {
            label: "settings",
            ..incoming(&Method::POST, "/poll", None, &wrong)
        };
        assert_eq!(
            rejected(admit(&origins(), &tokens(8), &other_webview)).0,
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn oversized_bodies_are_refused_without_being_decoded() {
        let at_limit = encode_request(7, &vec![Ack { id: 1, bytes: 1 }; MAX_ACKS_PER_REQUEST]);
        assert_eq!(at_limit.len(), MAX_REQUEST_LEN);
        assert!(matches!(
            admit(
                &origins(),
                &tokens(7),
                &incoming(&Method::POST, "/poll", None, &at_limit)
            ),
            Admission::Forward { .. }
        ));
        let mut over = at_limit.clone();
        over.push(0);
        assert_eq!(
            rejected(admit(
                &origins(),
                &tokens(7),
                &incoming(&Method::POST, "/poll", None, &over)
            ))
            .0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let huge = vec![0u8; 8 * 1024 * 1024];
        assert_eq!(
            rejected(admit(
                &origins(),
                &tokens(7),
                &incoming(&Method::POST, "/ack", None, &huge)
            ))
            .0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[test]
    fn malformed_bodies_are_bad_requests() {
        let good = encode_request(7, &[Ack { id: 1, bytes: 2 }]);
        for body in [
            Vec::new(),
            good[..11].to_vec(),
            good[..good.len() - 1].to_vec(),
            [good.clone(), vec![0]].concat(),
        ] {
            let admission = admit(
                &origins(),
                &tokens(7),
                &incoming(&Method::POST, "/poll", None, &body),
            );
            assert_eq!(rejected(admission).0, StatusCode::BAD_REQUEST, "{body:?}");
        }
    }

    #[test]
    fn routes_and_preflights() {
        let body = encode_request(7, &[]);
        let status = |method: &Method, path, origin| {
            rejected(admit(
                &origins(),
                &tokens(7),
                &incoming(method, path, origin, &body),
            ))
            .0
        };
        assert_eq!(
            status(&Method::GET, "/poll", None),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            status(&Method::PUT, "/ack", None),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            status(&Method::POST, "/poll/extra", None),
            StatusCode::NOT_FOUND
        );
        assert_eq!(status(&Method::POST, "", None), StatusCode::NOT_FOUND);
        assert_eq!(status(&Method::GET, "/other", None), StatusCode::NOT_FOUND);
        // Route errors are readable by the app's own page, and only by it.
        let (_, named) = rejected(admit(
            &origins(),
            &tokens(7),
            &incoming(&Method::GET, "/poll", Some(b"tauri://localhost"), &body),
        ));
        assert_eq!(named.as_deref(), Some("tauri://localhost"));
        for path in ["/poll", "/nope"] {
            for method in [Method::GET, Method::POST, Method::DELETE] {
                let admission = admit(
                    &origins(),
                    &tokens(7),
                    &incoming(&method, path, Some(b"https://evil.example"), &body),
                );
                assert_eq!(
                    rejected(admission),
                    (StatusCode::FORBIDDEN, None),
                    "{method} {path}"
                );
            }
        }
        for path in ["/poll", "/anything"] {
            let admission = admit(
                &origins(),
                &tokens(7),
                &incoming(&Method::OPTIONS, path, Some(b"tauri://localhost"), &[]),
            );
            assert_eq!(
                admission,
                Admission::Preflight {
                    origin: Arc::from("tauri://localhost")
                }
            );
        }
    }
}

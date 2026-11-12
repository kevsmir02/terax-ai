//! Real-application benchmark support ("app lab"). Compiled only with `--features bench`.
//!
//! The scenario driver (`src/bench`, compiled into the frontend only when `TERAX_BENCH=1`) runs
//! inside the real UI and asks this module for what a page cannot know: the exact WebKit
//! helper process ids that belong to this webview, window state, and native window actions
//! (stepped live resizes, order out/front, miniaturize). Nothing here exists in a normal build.
//!
//! Safety: a bench binary refuses to start under this fork's product identifier *or* under an
//! upstream Terax identifier, so it can never run against the profile of an installed
//! application. The orchestrator (`scripts/app-lab/run.py`) gives every run its own identifier
//! and `HOME`.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

/// Identifier of this fork's application (provisional; `modules::identity`).
fn product_identifier() -> &'static str {
    crate::modules::identity::app_identifier()
}

/// Called from `setup` and by every bench command. A bench build must not run under the
/// product identifier (it would share the installed app's profile), and only starts when the
/// orchestrator declared an isolated environment (its own `HOME`, so the control-server
/// descriptor, shell-integration files and history never touch the real user's).
pub fn guard(app: &AppHandle) -> Result<(), String> {
    guard_environment(
        &app.config().identifier,
        std::env::var("TERAX_BENCH_ISOLATED").ok().as_deref(),
    )
}

fn guard_environment(identifier: &str, isolated: Option<&str>) -> Result<(), String> {
    let product = product_identifier();
    if identifier == product {
        return Err(format!(
            "bench build refuses to run under the product identifier {product}; \
             launch it through scripts/app-lab/run.py (isolated identifier and HOME)"
        ));
    }
    if crate::modules::identity::is_upstream_identifier(identifier) {
        return Err(format!(
            "bench build refuses to run under the upstream Terax identifier {identifier}; \
             it would share the installed application's profile"
        ));
    }
    if isolated != Some("1") {
        return Err(
            "bench build requires TERAX_BENCH_ISOLATED=1 (set by scripts/app-lab/run.py together \
             with an isolated HOME)"
                .to_string(),
        );
    }
    Ok(())
}

/// What the orchestrator passed through the environment.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BenchConfig {
    scenario: Option<Value>,
    report_url: Option<String>,
    identifier: String,
}

fn parse_scenario(raw: Option<&str>) -> Result<Option<Value>, String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(text) => serde_json::from_str(text)
            .map(Some)
            .map_err(|error| format!("TERAX_BENCH_SCENARIO is not valid JSON: {error}")),
    }
}

#[tauri::command]
pub fn bench_config(app: AppHandle) -> Result<BenchConfig, String> {
    guard(&app)?;
    Ok(BenchConfig {
        scenario: parse_scenario(std::env::var("TERAX_BENCH_SCENARIO").ok().as_deref())?,
        report_url: std::env::var("TERAX_BENCH_REPORT_URL").ok(),
        identifier: app.config().identifier.clone(),
    })
}

/// A native window action. Sizes are points; resizing keeps the top-left corner fixed.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum WindowAction {
    Snapshot,
    /// Set the content-area frame size once (no live-resize notifications).
    SetSize {
        width: f64,
        height: f64,
    },
    /// Resize in `count` steps of `(dw, dh)` points like a drag on the bottom-right corner.
    #[serde(rename_all = "camelCase")]
    ResizeSteps {
        dw: f64,
        dh: f64,
        count: u32,
        interval_ms: f64,
        #[serde(default = "yes")]
        live: bool,
        /// Also capture the layer tree in the middle of the drag (see `Layers`).
        #[serde(default)]
        layers_mid: bool,
    },
    Hide {
        #[serde(default = "order_out")]
        mode: String,
    },
    Show {
        #[serde(default = "order_out")]
        mode: String,
    },
    /// Make the window key and the app active (a benchmark needs both).
    Activate,
    /// Wait natively: JavaScript timers are throttled while the window is occluded.
    Sleep {
        ms: f64,
    },
    /// WebKit's own full-GC request for the web processes of this pool.
    Gc,
    /// Whole-application process memory: the host and its WebKit helpers, their roles, and
    /// `/proc/<pid>/smaps_rollup` figures (Pss as the non-double-counting total).
    Memory,
    /// The web view's Core Animation layer tree in this (UI) process. WebKit mirrors the web
    /// process's composited layers one to one as `CALayer`s here, so counting them (and their
    /// sizes, contents, masks and clips) shows what the page's CSS made composited.
    Layers,
    /// A real key event through the window's `sendEvent:`: the web view's first responder runs
    /// it through the system input context (input sources, dead keys), like a physical key.
    #[serde(rename_all = "camelCase")]
    Key {
        chars: String,
        #[serde(default)]
        chars_ignoring_modifiers: Option<String>,
        key_code: u16,
        /// `NSEventModifierFlags` (shift 1<<17, control 1<<18, option 1<<19, command 1<<20).
        #[serde(default)]
        flags: usize,
        #[serde(default)]
        up: bool,
        #[serde(default)]
        repeat: bool,
    },
    /// The web view's `NSTextInputClient`, the way an input method drives it.
    #[serde(rename_all = "camelCase")]
    Text {
        /// `setMarked`, `insert` or `unmark`.
        op: String,
        #[serde(default)]
        text: String,
    },
}

fn yes() -> bool {
    true
}

fn order_out() -> String {
    "orderout".to_string()
}

#[tauri::command]
pub async fn bench_window(app: AppHandle, action: WindowAction) -> Result<Value, String> {
    guard(&app)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    platform::run(app, window, action).await
}

#[tauri::command]
pub fn bench_exit(app: AppHandle) {
    app.exit(0);
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSPoint, NSRange, NSRect, NSString};
    use std::time::{Duration, Instant};

    /// Sends a message with an optional `sender` argument (`orderOut:` and friends).
    macro_rules! send_sender {
        ($target:expr, $selector:ident) => {
            unsafe {
                let _: () = msg_send![$target, $selector: None::<&AnyObject>];
            }
        };
    }

    /// Sends a message that takes no argument.
    macro_rules! send_plain {
        ($target:expr, $selector:ident) => {
            unsafe {
                let _: () = msg_send![$target, $selector];
            }
        };
    }

    /// A process-id getter that only exists as private WebKit API: 0 when unavailable.
    macro_rules! process_id {
        ($web:expr, $selector:ident) => {{
            let responds: bool =
                unsafe { msg_send![$web, respondsToSelector: objc2::sel!($selector)] };
            if responds {
                let pid: i32 = unsafe { msg_send![$web, $selector] };
                i64::from(pid)
            } else {
                0
            }
        }};
    }

    /// `NSWindowOcclusionStateVisible`.
    const OCCLUSION_VISIBLE: usize = 1 << 1;
    const MIN_WIDTH: f64 = 480.0;
    const MIN_HEIGHT: f64 = 320.0;

    pub async fn run(
        app: AppHandle,
        window: WebviewWindow,
        action: WindowAction,
    ) -> Result<Value, String> {
        match action {
            WindowAction::Snapshot => snapshot(&window).await,
            WindowAction::SetSize { width, height } => {
                main(&app, move |app| set_size(app, width, height, false)).await?;
                snapshot(&window).await
            }
            WindowAction::ResizeSteps {
                dw,
                dh,
                count,
                interval_ms,
                live,
                layers_mid,
            } => {
                let started = Instant::now();
                let mut mid = Value::Null;
                let live_state = if live {
                    live_resize(&window, true).await?
                } else {
                    Value::Null
                };
                for step in 0..count {
                    if layers_mid && step == count / 2 {
                        mid = layers(&window).await?;
                    }
                    tokio::time::sleep(Duration::from_secs_f64(interval_ms.max(0.0) / 1000.0))
                        .await;
                    main(&app, move |app| {
                        let (width, height) = content_size(app);
                        set_size(app, width + dw, height + dh, true);
                    })
                    .await?;
                }
                let live_end = if live {
                    live_resize(&window, false).await?
                } else {
                    Value::Null
                };
                Ok(json!({
                    "ok": true,
                    "steps": count,
                    "ms": started.elapsed().as_secs_f64() * 1000.0,
                    "live": live_state,
                    "liveEnd": live_end,
                    "layersMid": mid,
                }))
            }
            WindowAction::Hide { mode } => {
                if !matches!(mode.as_str(), "orderout" | "miniaturize") {
                    return Ok(json!({"ok": false, "error": format!("unknown mode {mode}")}));
                }
                let hide_mode = mode.clone();
                main(&app, move |app| {
                    let window = ns_window(app);
                    match hide_mode.as_str() {
                        "miniaturize" => send_sender!(window, miniaturize),
                        _ => send_sender!(window, orderOut),
                    }
                })
                .await?;
                let (ok, ms) = wait_until(&app, is_occluded).await;
                let occluded = main(&app, is_occluded).await?;
                Ok(json!({"ok": ok, "occluded": occluded, "ms": ms, "mode": mode}))
            }
            WindowAction::Show { mode } => {
                let show_mode = mode.clone();
                main(&app, move |app| {
                    let window = ns_window(app);
                    if show_mode == "miniaturize" {
                        send_sender!(window, deminiaturize);
                    } else {
                        send_sender!(window, makeKeyAndOrderFront);
                    }
                    activate_app();
                })
                .await?;
                let (ok, ms) = wait_until(&app, |app| {
                    let ready = !is_occluded(app) && is_key(app) && app_active();
                    if !ready {
                        // Another application may hold activation briefly; keep asking.
                        send_sender!(ns_window(app), makeKeyAndOrderFront);
                        activate_app();
                    }
                    ready
                })
                .await;
                let state = main(&app, |app| {
                    json!({"visible": !is_occluded(app), "key": is_key(app), "active": app_active()})
                })
                .await?;
                Ok(json!({"ok": ok, "ms": ms, "mode": mode, "state": state}))
            }
            WindowAction::Activate => {
                main(&app, |app| {
                    send_sender!(ns_window(app), makeKeyAndOrderFront);
                    activate_app();
                })
                .await?;
                let (ok, ms) =
                    wait_until(&app, |app| !is_occluded(app) && is_key(app) && app_active()).await;
                Ok(json!({"ok": ok, "ms": ms}))
            }
            WindowAction::Sleep { ms } => {
                tokio::time::sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0)).await;
                Ok(json!({"ok": true}))
            }
            WindowAction::Gc => gc(&window).await,
            WindowAction::Layers => layers(&window).await,
            WindowAction::Memory => Err(
                "whole-application /proc memory sampling is Linux-only; on macOS the orchestrator \
                 samples `footprint -j` and `vmmap` instead"
                    .to_string(),
            ),
            WindowAction::Key {
                chars,
                chars_ignoring_modifiers,
                key_code,
                flags,
                up,
                repeat,
            } => {
                main(&app, move |app| {
                    send_key(
                        app,
                        &chars,
                        chars_ignoring_modifiers.as_deref().unwrap_or(&chars),
                        key_code,
                        flags,
                        up,
                        repeat,
                    )
                })
                .await
            }
            WindowAction::Text { op, text } => text_input(&window, op, text).await,
        }
    }

    fn send_key(
        app: &AppHandle,
        chars: &str,
        chars_ignoring_modifiers: &str,
        key_code: u16,
        flags: usize,
        up: bool,
        repeat: bool,
    ) -> Value {
        const KEY_DOWN: usize = 10;
        const KEY_UP: usize = 11;
        let class = AnyClass::get(c"NSEvent").expect("AppKit is loaded");
        let chars = NSString::from_str(chars);
        let ignoring = NSString::from_str(chars_ignoring_modifiers);
        let window = ns_window(app);
        let process_info: Retained<AnyObject> = unsafe {
            msg_send![
                AnyClass::get(c"NSProcessInfo").expect("Foundation is loaded"),
                processInfo
            ]
        };
        let uptime: f64 = unsafe { msg_send![&*process_info, systemUptime] };
        let number: isize = unsafe { msg_send![window, windowNumber] };
        let event: Option<Retained<AnyObject>> = unsafe {
            msg_send![
                class,
                keyEventWithType: if up { KEY_UP } else { KEY_DOWN },
                location: NSPoint::new(0.0, 0.0),
                modifierFlags: flags,
                timestamp: uptime,
                windowNumber: number,
                context: None::<&AnyObject>,
                characters: &*chars,
                charactersIgnoringModifiers: &*ignoring,
                isARepeat: repeat,
                keyCode: key_code
            ]
        };
        let Some(event) = event else {
            return json!({"ok": false, "error": "no event"});
        };
        unsafe {
            let _: () = msg_send![window, sendEvent: &*event];
        }
        json!({"ok": true})
    }

    async fn text_input(window: &WebviewWindow, op: String, text: String) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |platform| {
                let web = unsafe { &*platform.inner().cast::<AnyObject>() };
                let none = NSRange::new(usize::MAX >> 1, 0);
                let string = NSString::from_str(&text);
                let ok = match op.as_str() {
                    "setMarked" => {
                        let selected = NSRange::new(text.encode_utf16().count(), 0);
                        unsafe {
                            let _: () = msg_send![web, setMarkedText: &*string, selectedRange: selected, replacementRange: none];
                        }
                        true
                    }
                    "insert" => {
                        unsafe {
                            let _: () = msg_send![web, insertText: &*string, replacementRange: none];
                        }
                        true
                    }
                    "unmark" => {
                        send_plain!(web, unmarkText);
                        true
                    }
                    _ => false,
                };
                let _ = tx.send(json!({"ok": ok}));
            })
            .map_err(|error| format!("with_webview: {error}"))?;
        rx.await.map_err(|error| format!("text: {error}"))
    }

    /// Runs `work` on the main thread with the app handle and returns its result.
    async fn main<T: Send + 'static>(
        app: &AppHandle,
        work: impl FnOnce(&AppHandle) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(work(&handle));
        })
        .map_err(|error| format!("main thread dispatch: {error}"))?;
        rx.await.map_err(|error| format!("main thread: {error}"))
    }

    async fn wait_until(
        app: &AppHandle,
        condition: impl FnMut(&AppHandle) -> bool + Clone + Send + 'static,
    ) -> (bool, f64) {
        let started = Instant::now();
        loop {
            let check = condition.clone();
            let met = main(app, move |app| {
                let mut check = check;
                check(app)
            })
            .await
            .unwrap_or(false);
            let elapsed = started.elapsed();
            if met {
                return (true, elapsed.as_secs_f64() * 1000.0);
            }
            if elapsed > Duration::from_secs(4) {
                return (false, elapsed.as_secs_f64() * 1000.0);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn ns_window(app: &AppHandle) -> &'static AnyObject {
        let window = app
            .get_webview_window("main")
            .expect("main window exists while the bench runs");
        let pointer = window.ns_window().expect("main window has an NSWindow");
        // Tauri owns the NSWindow for the life of the process; callers run on the main thread.
        unsafe { &*pointer.cast::<AnyObject>() }
    }

    fn is_occluded(app: &AppHandle) -> bool {
        let state: usize = unsafe { msg_send![ns_window(app), occlusionState] };
        state & OCCLUSION_VISIBLE == 0
    }

    fn is_key(app: &AppHandle) -> bool {
        unsafe { msg_send![ns_window(app), isKeyWindow] }
    }

    fn shared_application() -> Retained<AnyObject> {
        let class = AnyClass::get(c"NSApplication").expect("AppKit is loaded");
        unsafe { msg_send![class, sharedApplication] }
    }

    fn app_active() -> bool {
        unsafe { msg_send![&*shared_application(), isActive] }
    }

    fn activate_app() {
        unsafe {
            let _: () = msg_send![&*shared_application(), activateIgnoringOtherApps: true];
        }
    }

    fn frame(app: &AppHandle) -> NSRect {
        unsafe { msg_send![ns_window(app), frame] }
    }

    /// Window frame size in points (what `resizeSteps` in the renderer lab steps).
    fn content_size(app: &AppHandle) -> (f64, f64) {
        let frame = frame(app);
        (frame.size.width, frame.size.height)
    }

    fn set_size(app: &AppHandle, width: f64, height: f64, display: bool) {
        let mut next = frame(app);
        let top = next.origin.y + next.size.height;
        next.size.width = width.max(MIN_WIDTH);
        next.size.height = height.max(MIN_HEIGHT);
        next.origin.y = top - next.size.height;
        unsafe {
            let _: () = msg_send![ns_window(app), setFrame: next, display: display];
        }
    }

    /// Mimics what AppKit sends while the user drags a window edge: the content view is told and
    /// forwards to its subviews; the web view (reached through wry, not by class name) is told
    /// directly when that did not arrive. Reports whether it ended up in live resize.
    async fn live_resize(window: &WebviewWindow, begin: bool) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        window
            .with_webview(move |platform| {
                let web = unsafe { &*platform.inner().cast::<AnyObject>() };
                let content: Option<Retained<AnyObject>> =
                    unsafe { msg_send![ns_window(&app), contentView] };
                let state = if begin {
                    if let Some(content) = &content {
                        send_plain!(&**content, viewWillStartLiveResize);
                    }
                    send_plain!(web, viewWillStartLiveResize);
                    // `inLiveResize` stays false: only AppKit's own window drag sets it. The
                    // notification is what WKWebView acts on (it switches to synchronous resizes).
                    json!({"notified": true, "webViewClass": web.class().name().to_string_lossy()})
                } else {
                    send_plain!(web, viewDidEndLiveResize);
                    if let Some(content) = &content {
                        send_plain!(&**content, viewDidEndLiveResize);
                    }
                    json!({"notified": true})
                };
                let _ = tx.send(state);
            })
            .map_err(|error| format!("with_webview: {error}"))?;
        rx.await.map_err(|error| format!("live resize: {error}"))
    }

    async fn snapshot(window: &WebviewWindow) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let app = window.app_handle().clone();
        window
            .with_webview(move |platform| {
                let web = unsafe { &*platform.inner().cast::<AnyObject>() };
                let frame = frame(&app);
                let scale: f64 = unsafe { msg_send![ns_window(&app), backingScaleFactor] };
                let visible: bool = unsafe { msg_send![ns_window(&app), isVisible] };
                let miniaturized: bool = unsafe { msg_send![ns_window(&app), isMiniaturized] };
                let value = json!({
                    "hostPid": std::process::id(),
                    "webContentPid": process_id!(web, _webProcessIdentifier),
                    "gpuPid": process_id!(web, _gpuProcessIdentifier),
                    "networkingPid": process_id!(web, _networkProcessIdentifier),
                    "windowVisible": visible,
                    "occlusionVisible": !is_occluded(&app),
                    "key": is_key(&app),
                    "appActive": app_active(),
                    "miniaturized": miniaturized,
                    "scale": scale,
                    "frame": [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height],
                });
                let _ = tx.send(value);
            })
            .map_err(|error| format!("with_webview: {error}"))?;
        rx.await.map_err(|error| format!("snapshot: {error}"))
    }

    /// One mirrored layer, depth first. Only what decides memory and compositing cost.
    fn describe_layers(
        layer: &AnyObject,
        depth: u32,
        out: &mut Vec<Value>,
        totals: &mut LayerTotals,
    ) {
        let bounds: NSRect = unsafe { msg_send![layer, bounds] };
        let scale: f64 = unsafe { msg_send![layer, contentsScale] };
        let contents: Option<Retained<AnyObject>> = unsafe { msg_send![layer, contents] };
        let hidden: bool = unsafe { msg_send![layer, isHidden] };
        let opacity: f32 = unsafe { msg_send![layer, opacity] };
        let clips: bool = unsafe { msg_send![layer, masksToBounds] };
        let radius: f64 = unsafe { msg_send![layer, cornerRadius] };
        let mask: Option<Retained<AnyObject>> = unsafe { msg_send![layer, mask] };
        let name: Option<Retained<AnyObject>> = unsafe { msg_send![layer, name] };
        let name = name
            .map(|name| {
                let text: *const std::ffi::c_char = unsafe { msg_send![&*name, UTF8String] };
                if text.is_null() {
                    String::new()
                } else {
                    unsafe { std::ffi::CStr::from_ptr(text) }
                        .to_string_lossy()
                        .into_owned()
                }
            })
            .unwrap_or_default();
        let class = layer.class().name().to_string_lossy().into_owned();
        let pixels = if contents.is_some() && !hidden {
            bounds.size.width * bounds.size.height * scale * scale
        } else {
            0.0
        };
        totals.count += 1;
        if contents.is_some() {
            totals.with_contents += 1;
            totals.backing_pixels += pixels;
        }
        if mask.is_some() {
            totals.masks += 1;
        }
        if clips {
            totals.clips += 1;
        }
        if hidden {
            totals.hidden += 1;
        }
        // Backing stores are 4 bytes a pixel (BGRA, or 8 for wide colour).
        if out.len() < 600 {
            out.push(json!({
                "depth": depth,
                "class": class,
                "name": name,
                "size": [bounds.size.width.round(), bounds.size.height.round()],
                "scale": scale,
                "contents": contents.is_some(),
                "hidden": hidden,
                "opacity": opacity,
                "clips": clips,
                "radius": radius,
                "mask": mask.is_some(),
                "backingMiB": (pixels * 4.0 / 1_048_576.0 * 1000.0).round() / 1000.0,
            }));
        }
        let subs: Option<Retained<AnyObject>> = unsafe { msg_send![layer, sublayers] };
        if let Some(subs) = subs {
            let count: usize = unsafe { msg_send![&*subs, count] };
            for index in 0..count {
                let child: Retained<AnyObject> = unsafe { msg_send![&*subs, objectAtIndex: index] };
                describe_layers(&child, depth + 1, out, totals);
            }
        }
    }

    #[derive(Default)]
    struct LayerTotals {
        count: u32,
        with_contents: u32,
        masks: u32,
        clips: u32,
        hidden: u32,
        backing_pixels: f64,
    }

    async fn layers(window: &WebviewWindow) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |platform| {
                let web = unsafe { &*platform.inner().cast::<AnyObject>() };
                let root: Option<Retained<AnyObject>> = unsafe { msg_send![web, layer] };
                let mut list = Vec::new();
                let mut totals = LayerTotals::default();
                if let Some(root) = root {
                    describe_layers(&root, 0, &mut list, &mut totals);
                }
                let _ = tx.send(json!({
                    "count": totals.count,
                    "withContents": totals.with_contents,
                    "masks": totals.masks,
                    "clips": totals.clips,
                    "hidden": totals.hidden,
                    "backingMiB": (totals.backing_pixels * 4.0 / 1_048_576.0 * 10.0).round() / 10.0,
                    "layers": list,
                }));
            })
            .map_err(|error| format!("with_webview: {error}"))?;
        rx.await.map_err(|error| format!("layers: {error}"))
    }

    async fn gc(window: &WebviewWindow) -> Result<Value, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .with_webview(move |platform| {
                let web = unsafe { &*platform.inner().cast::<AnyObject>() };
                let configuration: Retained<AnyObject> = unsafe { msg_send![web, configuration] };
                let pool: Retained<AnyObject> = unsafe { msg_send![&*configuration, processPool] };
                let responds: bool = unsafe {
                    msg_send![&*pool, respondsToSelector: objc2::sel!(_garbageCollectJavaScriptObjectsForTesting)]
                };
                if responds {
                    send_plain!(&*pool, _garbageCollectJavaScriptObjectsForTesting);
                }
                let _ = tx.send(json!({"ok": responds}));
            })
            .map_err(|error| format!("with_webview: {error}"))?;
        rx.await.map_err(|error| format!("gc: {error}"))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    //! WebKitGTK has no public API for the web/network/GPU process ids and no occlusion state,
    //! so the ids come from a `/proc` scan of this process's descendants and visibility is the
    //! window's own state. Focus cannot be forced on Wayland: activation is advisory there.
    //! Input, live resize, layers and GC stay macOS-only (ticket 32).

    use super::*;
    use std::time::{Duration, Instant};

    pub async fn run(
        _app: AppHandle,
        window: WebviewWindow,
        action: WindowAction,
    ) -> Result<Value, String> {
        match action {
            WindowAction::Snapshot => Ok(snapshot(&window)),
            WindowAction::SetSize { width, height } => {
                window
                    .set_size(tauri::LogicalSize::new(width, height))
                    .map_err(|error| format!("set_size: {error}"))?;
                tokio::time::sleep(Duration::from_millis(120)).await;
                Ok(snapshot(&window))
            }
            WindowAction::Activate => {
                let started = Instant::now();
                window.show().map_err(|error| format!("show: {error}"))?;
                // A Wayland compositor decides where focus goes; this is only a request.
                let _ = window.set_focus();
                tokio::time::sleep(Duration::from_millis(120)).await;
                let state = snapshot(&window);
                Ok(json!({
                    "ok": state["windowVisible"],
                    "ms": started.elapsed().as_secs_f64() * 1000.0,
                    "focused": state["key"],
                    "focus": "advisory",
                }))
            }
            WindowAction::Sleep { ms } => {
                tokio::time::sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0)).await;
                Ok(json!({"ok": true}))
            }
            WindowAction::Hide { mode } => {
                window.hide().map_err(|error| format!("hide: {error}"))?;
                tokio::time::sleep(Duration::from_millis(200)).await;
                let state = snapshot(&window);
                Ok(json!({"ok": !state["windowVisible"].as_bool().unwrap_or(true), "mode": mode, "state": state}))
            }
            WindowAction::Show { mode } => {
                window.show().map_err(|error| format!("show: {error}"))?;
                let _ = window.set_focus();
                tokio::time::sleep(Duration::from_millis(200)).await;
                let state = snapshot(&window);
                Ok(json!({"ok": state["windowVisible"], "mode": mode, "state": state}))
            }
            WindowAction::ResizeSteps { .. } => Err(
                "stepped/live resize is macOS-only for now (ticket 32); window sizing is setSize"
                    .to_string(),
            ),
            WindowAction::Gc => {
                Err("a forced full GC is not available on WebKitGTK (ticket 32)".to_string())
            }
            WindowAction::Layers => {
                Err("the composited layer tree is macOS-only for now (ticket 32)".to_string())
            }
            WindowAction::Memory => Ok(memory_report(std::process::id())),
            WindowAction::Key { .. } | WindowAction::Text { .. } => Err(
                "native key/input-method events are macOS-only for now (ticket 32)".to_string(),
            ),
        }
    }

    fn snapshot(window: &WebviewWindow) -> Value {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        let scale = window.scale_factor().unwrap_or(1.0);
        let inner = window.inner_size().map(|size| (size.width, size.height)).unwrap_or((0, 0));
        let position = window
            .outer_position()
            .map(|position| (position.x, position.y))
            .unwrap_or((0, 0));
        let host = std::process::id();
        let processes = scan_processes();
        let pids = resolve_webkit_pids(&processes, host);
        let roles: Vec<Value> = role_table(&processes, host)
            .into_iter()
            .map(|(pid, role)| json!({"pid": pid, "role": role}))
            .collect();
        json!({
            "hostPid": host,
            // Wall-clock process start (btime + starttime): lets the orchestrator split startup
            // into process-exec -> navigation and navigation -> boot without trusting its own
            // spawn timestamp.
            "startedUnixMs": process_started_unix_ms(host),
            "processRoles": roles,
            "webContentPid": pids.web_content,
            "gpuPid": pids.gpu,
            "networkingPid": pids.networking,
            "webContentPrewarmedPids": pids.prewarmed,
            "windowVisible": visible,
            // WebKitGTK hands the application no occlusion signal; visibility is what exists.
            "occlusionVisible": visible,
            "key": focused,
            // Wayland does not tell an application that it is the active one either.
            "appActive": focused,
            "miniaturized": window.is_minimized().unwrap_or(false),
            "scale": scale,
            "frame": [position.0, position.1, inner.0, inner.1],
            "platform": "linux",
        })
    }

    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    pub(super) struct WebKitPids {
        pub(super) web_content: u32,
        pub(super) gpu: u32,
        pub(super) networking: u32,
        /// Extra web processes the pool started ahead of time (WebKitGTK prewarms one).
        pub(super) prewarmed: Vec<u32>,
    }

    struct ProcInfo {
        pid: u32,
        ppid: u32,
        command: String,
    }

    /// `/proc/<pid>/stat`: `pid (comm) state ppid ...`; `comm` may itself contain spaces and
    /// parentheses, so the field after the *last* `)` is the state and the next one the ppid.
    fn parse_ppid(stat: &str) -> Option<u32> {
        let rest = &stat[stat.rfind(')')? + 1..];
        rest.split_whitespace().nth(1)?.parse().ok()
    }

    /// Basename of the first `argv[0]`-shaped entry of a NUL-separated cmdline.
    fn command_of(cmdline: &[u8]) -> String {
        cmdline
            .split(|byte| *byte == 0)
            .find(|part| !part.is_empty())
            .map(|part| {
                let text = String::from_utf8_lossy(part);
                let name = text.rsplit('/').next().unwrap_or(&text);
                name.to_string()
            })
            .unwrap_or_default()
    }

    /// WebKitGTK's helper names. `/proc/<pid>/comm` truncates to 15 bytes
    /// ("WebKitWebProces", "WebKitNetworkPr"), so this compares a prefix that both the full
    /// cmdline name and the truncated comm satisfy.
    fn role_name(command: &str) -> Option<&'static str> {
        if command.starts_with("WebKitWebProces") {
            Some("web_content")
        } else if command.starts_with("WebKitNetworkPr") {
            Some("networking")
        } else if command.starts_with("WebKitGPUProces") {
            Some("gpu")
        } else {
            None
        }
    }

    /// Attribute the helpers to this app by ancestry: a sandbox wrapper (bwrap) may sit between
    /// the host and the web process, so the walk follows every descendant, not direct children.
    fn resolve_webkit_pids(processes: &[ProcInfo], host: u32) -> WebKitPids {
        let mut children: std::collections::HashMap<u32, Vec<u32>> = Default::default();
        for process in processes {
            children.entry(process.ppid).or_default().push(process.pid);
        }
        let mut found = WebKitPids::default();
        let mut stack = vec![host];
        while let Some(pid) = stack.pop() {
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids);
            }
            let Some(process) = processes.iter().find(|process| process.pid == pid) else {
                continue;
            };
            match role_name(&process.command) {
                Some("web_content") if found.web_content == 0 => found.web_content = pid,
                Some("web_content") => found.prewarmed.push(pid),
                Some("gpu") if found.gpu == 0 => found.gpu = pid,
                Some("networking") if found.networking == 0 => found.networking = pid,
                _ => {}
            }
        }
        found.prewarmed.sort_unstable();
        found
    }

    /// One pass over `/proc`: pid, parent and the helper's name (cmdline, `comm` as fallback).
    fn scan_processes() -> Vec<ProcInfo> {
        let mut processes = Vec::new();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return processes;
        };
        for entry in entries.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse().ok()) else {
                continue;
            };
            let base = entry.path();
            let Ok(stat) = std::fs::read_to_string(base.join("stat")) else {
                continue;
            };
            let Some(ppid) = parse_ppid(&stat) else {
                continue;
            };
            let cmdline = std::fs::read(base.join("cmdline")).unwrap_or_default();
            let mut command = command_of(&cmdline);
            if command.is_empty() {
                command = std::fs::read_to_string(base.join("comm"))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
            }
            processes.push(ProcInfo { pid, ppid, command });
        }
        processes
    }

    /// CPU clock ticks per second (usually 100): `utime`/`stime` are in these units.
    fn clock_ticks() -> u64 {
        let value = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if value > 0 {
            value as u64
        } else {
            100
        }
    }

    /// One `/proc/<pid>/smaps_rollup` in bytes.
    ///
    /// `Pss` is the proportional set size: a shared page is divided among its sharers, so summing
    /// Pss over the app's processes counts every shared page exactly once. `rss` is kept because
    /// it is what the user sees, but a sum of Rss double counts shared pages; `rss_overcount` is
    /// the difference and is reported instead of silently choosing one.
    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    struct ProcMemory {
        pss: u64,
        rss: u64,
        private: u64,
        shared: u64,
        swap: u64,
        anon: u64,
    }

    /// The `kB` value of one exact `smaps_rollup` key. `Pss` must not match `Pss_Anon`, so the
    /// key is compared up to the colon rather than by prefix.
    fn smaps_kb(text: &str, key: &str) -> Option<u64> {
        text.lines().find_map(|line| {
            let (name, rest) = line.trim().split_once(':')?;
            if name != key {
                return None;
            }
            let value = rest.trim().strip_suffix("kB")?.trim();
            value.parse().ok()
        })
    }

    fn parse_smaps_rollup(text: &str) -> ProcMemory {
        let private = smaps_kb(text, "Private_Clean").unwrap_or(0)
            + smaps_kb(text, "Private_Dirty").unwrap_or(0)
            + smaps_kb(text, "Private_Hugetlb").unwrap_or(0);
        let shared = smaps_kb(text, "Shared_Clean").unwrap_or(0)
            + smaps_kb(text, "Shared_Dirty").unwrap_or(0)
            + smaps_kb(text, "Shared_Hugetlb").unwrap_or(0);
        ProcMemory {
            pss: smaps_kb(text, "Pss").unwrap_or(0).saturating_mul(1024),
            rss: smaps_kb(text, "Rss").unwrap_or(0).saturating_mul(1024),
            private: private.saturating_mul(1024),
            shared: shared.saturating_mul(1024),
            swap: smaps_kb(text, "Swap").unwrap_or(0).saturating_mul(1024),
            anon: smaps_kb(text, "Anonymous").unwrap_or(0).saturating_mul(1024),
        }
    }

    #[derive(Debug, Default, Clone, PartialEq, Eq)]
    struct StatFields {
        ppid: u32,
        utime: u64,
        stime: u64,
        threads: u32,
        starttime: u64,
    }

    /// `pid (comm) state ppid ... utime stime ... num_threads ... starttime ...`
    fn parse_stat_fields(stat: &str) -> Option<StatFields> {
        let rest: Vec<&str> = stat[stat.rfind(')')? + 1..].split_whitespace().collect();
        if rest.len() < 22 {
            return None;
        }
        Some(StatFields {
            ppid: rest[1].parse().ok()?,
            utime: rest[11].parse().ok()?,
            stime: rest[12].parse().ok()?,
            threads: rest[17].parse().ok()?,
            starttime: rest[19].parse().ok()?,
        })
    }

    /// Reads `/proc/<pid>/smaps_rollup` (memory) and `/proc/<pid>/stat` (CPU, threads).
    fn read_memory(pid: u32) -> Option<(ProcMemory, StatFields)> {
        let base = format!("/proc/{pid}");
        let memory = parse_smaps_rollup(&std::fs::read_to_string(format!("{base}/smaps_rollup")).ok()?);
        let stat = parse_stat_fields(&std::fs::read_to_string(format!("{base}/stat")).ok()?)?;
        Some((memory, stat))
    }

    /// Role of one process in the whole-application table, independent of pid discovery.
    fn role_for(command: &str, pid: u32, host: u32, web_content_seen: bool) -> &'static str {
        if pid == host {
            return "host";
        }
        match role_name(command) {
            Some("web_content") if web_content_seen => "web_content_prewarmed",
            Some(role) => role,
            None if command == "bwrap" => "sandbox",
            None => "workload",
        }
    }

    /// The app's own subtree as `(pid, role)` pairs: host, WebKit helpers, sandbox wrappers and
    /// every other descendant (PTY shells, synthetic agents) as workload.
    fn role_table(processes: &[ProcInfo], host: u32) -> Vec<(u32, &'static str)> {
        let mut children: std::collections::HashMap<u32, Vec<u32>> = Default::default();
        for process in processes {
            children.entry(process.ppid).or_default().push(process.pid);
        }
        let mut table = Vec::new();
        let mut web_content_seen = false;
        let mut stack = vec![host];
        while let Some(pid) = stack.pop() {
            if let Some(kids) = children.get(&pid) {
                stack.extend(kids);
            }
            let Some(process) = processes.iter().find(|process| process.pid == pid) else {
                continue;
            };
            let role = role_for(&process.command, pid, host, web_content_seen);
            if role == "web_content" {
                web_content_seen = true;
            }
            table.push((pid, role));
        }
        table.sort_unstable();
        table
    }

    fn add_role(totals: &mut serde_json::Map<String, Value>, role: &str, key: &str, value: u64) {
        let entry = totals
            .entry(role.to_string())
            .or_insert_with(|| json!({"pss": 0, "rss": 0, "private": 0, "shared": 0, "swap": 0, "rssOvercount": 0, "cpuSeconds": 0.0, "threads": 0, "processes": 0}));
        let current = entry[key].as_u64().unwrap_or(0);
        entry[key] = json!(current + value);
    }

    /// Whole-application memory and counters as one JSON document (the `memory` action).
    ///
    /// Every process is a descendant of this host process, so nothing external can enter the
    /// total. `workload` is reported separately: PTY shells and the synthetic agent are external
    /// programs the benchmark runs, not the application's own memory.
    fn memory_report(host: u32) -> Value {
        let processes = scan_processes();
        let table = role_table(&processes, host);
        let ticks = clock_ticks();
        let mut rows = Vec::new();
        let mut by_role: serde_json::Map<String, Value> = Default::default();
        let mut totals = [0u64; 7]; // pss, rss, private, shared, swap, threads, fds
        let mut workload = [0u64; 7];
        let mut app = [0u64; 7];        for (pid, role) in &table {
            let Some((memory, stat)) = read_memory(*pid) else {
                continue;
            };
            let command = processes
                .iter()
                .find(|process| process.pid == *pid)
                .map(|process| process.command.clone())
                .unwrap_or_default();
            let fds = std::fs::read_dir(format!("/proc/{pid}/fd"))
                .map(|entries| entries.count() as u64)
                .unwrap_or(0);
            let cpu_seconds = (stat.utime + stat.stime) as f64 / ticks as f64;
            rows.push(json!({
                "pid": pid,
                "role": role,
                "command": command,
                "pssBytes": memory.pss,
                "rssBytes": memory.rss,
                "privateBytes": memory.private,
                "sharedBytes": memory.shared,
                "swapBytes": memory.swap,
                "rssOvercountBytes": memory.rss.saturating_sub(memory.pss),
                "cpuSeconds": (cpu_seconds * 1000.0).round() / 1000.0,
                "threads": stat.threads,
                "fds": fds,
            }));
            let values = [memory.pss, memory.rss, memory.private, memory.shared, memory.swap, u64::from(stat.threads), fds];
            for (index, value) in values.iter().enumerate() {
                totals[index] += value;
                if matches!(*role, "workload") {
                    workload[index] += value;
                } else {
                    app[index] += value;
                }
            }
            add_role(&mut by_role, role, "pss", memory.pss);
            add_role(&mut by_role, role, "rss", memory.rss);
            add_role(&mut by_role, role, "private", memory.private);
            add_role(&mut by_role, role, "shared", memory.shared);
            add_role(&mut by_role, role, "swap", memory.swap);
            add_role(&mut by_role, role, "rssOvercount", memory.rss.saturating_sub(memory.pss));
            add_role(&mut by_role, role, "threads", u64::from(stat.threads));
            add_role(&mut by_role, role, "processes", 1);
            let entry = by_role.get_mut(*role).expect("role was just inserted");
            let cpu = entry["cpuSeconds"].as_f64().unwrap_or(0.0) + cpu_seconds;
            entry["cpuSeconds"] = json!((cpu * 1000.0).round() / 1000.0);
        }
        let process_count = rows.len();
        let summary = |values: &[u64; 7]| {
            json!({
                "pss": values[0], "rss": values[1], "private": values[2], "shared": values[3],
                "swap": values[4], "threads": values[5], "fds": values[6],
                "rssOvercount": values[1].saturating_sub(values[0]),
                "processes": process_count,
            })
        };
        json!({
            "hostPid": host,
            "platform": "linux",
            "source": "/proc/<pid>/smaps_rollup",
            "processes": rows,
            "byRole": by_role,
            "total": summary(&totals),
            "app": summary(&app),
            "workload": summary(&workload),
        })
    }

    /// Wall-clock start of one process, from `btime` plus its start ticks (0 when unavailable).
    fn process_started_unix_ms(pid: u32) -> u64 {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return 0;
        };
        let Some(fields) = parse_stat_fields(&stat) else {
            return 0;
        };
        let Ok(sysinfo) = std::fs::read_to_string("/proc/stat") else {
            return 0;
        };
        let btime = sysinfo
            .lines()
            .find_map(|line| line.strip_prefix("btime ")?.trim().parse::<u64>().ok())
            .unwrap_or(0);
        if btime == 0 {
            return 0;
        }
        btime * 1000 + fields.starttime * 1000 / clock_ticks()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn proc(pid: u32, ppid: u32, command: &str) -> ProcInfo {
            ProcInfo {
                pid,
                ppid,
                command: command.to_string(),
            }
        }

        #[test]
        fn ppid_survives_spaces_and_parentheses_in_comm() {
            assert_eq!(
                parse_ppid("42 (WebKitWebProc (x)) S 7 42 42 0 -1"),
                Some(7)
            );
            assert_eq!(parse_ppid("42 (bash) R 1 42 42 0 -1"), Some(1));
            assert_eq!(parse_ppid("garbage"), None);
        }

        #[test]
        fn helper_roles_match_truncated_comm_and_full_cmdline_names() {
            assert_eq!(role_name("WebKitWebProcess"), Some("web_content"));
            assert_eq!(role_name("WebKitWebProces"), Some("web_content"));
            assert_eq!(role_name("WebKitNetworkProcess"), Some("networking"));
            assert_eq!(role_name("WebKitNetworkPr"), Some("networking"));
            assert_eq!(role_name("WebKitGPUProcess"), Some("gpu"));
            assert_eq!(role_name("WebKitGPUProces"), Some("gpu"));
            assert_eq!(role_name("terax"), None);
            assert_eq!(role_name("WebKitWebProcessWrapper"), Some("web_content"));
            assert_eq!(command_of(b"/usr/libexec/webkit2gtk-4.1/WebKitWebProcess\0-x\0"), "WebKitWebProcess");
            assert_eq!(command_of(b""), "");
        }

        #[test]
        fn helpers_are_attributed_through_sandbox_wrappers() {
            let table = [
                proc(100, 1, "terax"),
                // bwrap -> web process: the helper is a grandchild of the host.
                proc(101, 100, "bwrap"),
                proc(102, 101, "WebKitWebProcess"),
                proc(103, 102, "WebKitWebProcess"), // prewarmed
                proc(104, 100, "WebKitNetworkProcess"),
                proc(105, 100, "WebKitGPUProcess"),
                // Another app's helpers must not be attributed.
                proc(200, 1, "other-app"),
                proc(201, 200, "WebKitWebProcess"),
            ];
            let pids = resolve_webkit_pids(&table, 100);
            assert_eq!(
                pids,
                WebKitPids {
                    web_content: 102,
                    gpu: 105,
                    networking: 104,
                    prewarmed: vec![103],
                }
            );
        }

        #[test]
        fn no_helpers_is_not_an_error() {
            let table = [proc(100, 1, "terax")];
            assert_eq!(resolve_webkit_pids(&table, 100), WebKitPids::default());
        }

        #[test]
        fn smaps_rollup_parses_kb_and_keeps_pss_breakdown_apart() {
            let text = "\
Rss:               1200 kB
Pss:                900 kB
Pss_Anon:           400 kB
Pss_File:           500 kB
Shared_Clean:       600 kB
Shared_Dirty:       100 kB
Private_Clean:      300 kB
Private_Dirty:      200 kB
Anonymous:          400 kB
Swap:                50 kB
THPeligible:          0
ProtectionKey:        0
VmFlags: rd ex mr mw me
";
            let memory = parse_smaps_rollup(text);
            assert_eq!(memory.pss, 900 * 1024);
            assert_eq!(memory.rss, 1200 * 1024);
            assert_eq!(memory.private, 500 * 1024);
            assert_eq!(memory.shared, 700 * 1024);
            assert_eq!(memory.swap, 50 * 1024);
            assert_eq!(memory.anon, 400 * 1024);
            assert_eq!(memory.rss.saturating_sub(memory.pss), 300 * 1024);
        }

        #[test]
        fn a_torn_smaps_read_is_all_zeros() {
            assert_eq!(parse_smaps_rollup(""), ProcMemory::default());
            assert_eq!(parse_smaps_rollup("not a smaps file"), ProcMemory::default());
        }

        #[test]
        fn stat_fields_survive_spaces_and_parentheses() {
            // pid (comm) state ppid ... utime stime ... num_threads ... starttime ...
            let stat = "42 (WebKitWebProc (x)) S 7 42 42 0 -1 4194560 12 0 0 0 3 4 0 0 20 0 9 0 98765 100 200";
            let fields = parse_stat_fields(stat).expect("parsed");
            assert_eq!(fields.ppid, 7);
            assert_eq!(fields.utime, 3);
            assert_eq!(fields.stime, 4);
            assert_eq!(fields.threads, 9);
            assert_eq!(fields.starttime, 98765);
            assert_eq!(parse_stat_fields("garbage"), None);
            assert_eq!(parse_stat_fields("1 (x) S 2"), None);
        }

        #[test]
        fn role_table_separates_the_app_from_external_workload() {
            let table = [
                proc(100, 1, "terax"),
                proc(101, 100, "bwrap"),
                proc(102, 101, "WebKitWebProcess"),
                proc(103, 102, "WebKitWebProcess"),
                proc(104, 100, "WebKitNetworkProcess"),
                proc(105, 100, "WebKitGPUProcess"),
                proc(106, 100, "bash"),
                proc(107, 106, "node"),
                // Another app's helper is not a descendant of the host and cannot appear.
                proc(200, 1, "other-app"),
            ];
            let roles = role_table(&table, 100);
            assert_eq!(
                roles,
                vec![
                    (100, "host"),
                    (101, "sandbox"),
                    (102, "web_content"),
                    (103, "web_content_prewarmed"),
                    (104, "networking"),
                    (105, "gpu"),
                    (106, "workload"),
                    (107, "workload"),
                ]
            );
        }

        #[test]
        fn role_for_names_a_single_role_per_process() {
            assert_eq!(role_for("terax", 100, 100, false), "host");
            assert_eq!(role_for("WebKitWebProces", 102, 100, false), "web_content");
            assert_eq!(role_for("WebKitWebProces", 103, 100, true), "web_content_prewarmed");
            assert_eq!(role_for("bwrap", 101, 100, false), "sandbox");
            assert_eq!(role_for("bash", 106, 100, false), "workload");
        }

        #[test]
        fn the_live_memory_report_is_internally_consistent() {
            let report = memory_report(std::process::id());
            assert_eq!(report["platform"], "linux");
            assert_eq!(report["hostPid"], std::process::id());
            let total = &report["total"];
            let app = &report["app"];
            let workload = &report["workload"];
            assert_eq!(
                total["pss"].as_u64().unwrap(),
                app["pss"].as_u64().unwrap() + workload["pss"].as_u64().unwrap()
            );
            // The test process itself is the host; it must be present with its own Pss.
            let host = report["byRole"]["host"]["pss"].as_u64().unwrap_or(0);
            assert!(host > 0, "host Pss is zero: {report}");
            assert!(total["rss"].as_u64().unwrap() >= total["pss"].as_u64().unwrap());
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    use super::*;

    pub async fn run(
        _app: AppHandle,
        _window: WebviewWindow,
        _action: WindowAction,
    ) -> Result<Value, String> {
        Err("bench window control is implemented for macOS only".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_identifier_is_refused() {
        assert!(guard_environment(product_identifier(), Some("1")).is_err());
        assert!(guard_environment("dev.terax-lab-abc123", Some("1")).is_ok());
    }

    #[test]
    fn an_upstream_identifier_is_refused_too() {
        assert!(guard_environment("app.crynta.terax", Some("1")).is_err());
        assert!(guard_environment("app.crynta.terax.app-lab", Some("1")).is_err());
    }

    #[test]
    fn isolation_must_be_declared() {
        assert!(guard_environment("dev.terax-lab-abc123", None).is_err());
        assert!(guard_environment("dev.terax-lab-abc123", Some("0")).is_err());
    }

    #[test]
    fn scenario_parsing() {
        assert_eq!(parse_scenario(None), Ok(None));
        assert_eq!(parse_scenario(Some("  ")), Ok(None));
        assert_eq!(
            parse_scenario(Some(r#"{"name":"tabs"}"#)),
            Ok(Some(json!({"name": "tabs"})))
        );
        assert!(parse_scenario(Some("{nope")).is_err());
    }

    #[test]
    fn window_actions_deserialize_with_defaults() {
        let action: WindowAction = serde_json::from_value(
            json!({"cmd": "resizeSteps", "dw": 3.0, "dh": 0.0, "count": 10, "intervalMs": 16.0}),
        )
        .unwrap();
        assert_eq!(
            action,
            WindowAction::ResizeSteps {
                dw: 3.0,
                dh: 0.0,
                count: 10,
                interval_ms: 16.0,
                live: true,
                layers_mid: false
            }
        );
        let hide: WindowAction = serde_json::from_value(json!({"cmd": "hide"})).unwrap();
        assert_eq!(
            hide,
            WindowAction::Hide {
                mode: "orderout".into()
            }
        );
        assert!(serde_json::from_value::<WindowAction>(json!({"cmd": "format-disk"})).is_err());
    }
}

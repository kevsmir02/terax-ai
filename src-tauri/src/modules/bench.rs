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
                if !matches!(mode.as_str(), "orderout" | "miniaturize") {
                    return Ok(json!({"ok": false, "error": format!("unknown mode {mode}")}));
                }
                if mode == "miniaturize" {
                    window
                        .minimize()
                        .map_err(|error| format!("minimize: {error}"))?;
                } else {
                    window.hide().map_err(|error| format!("hide: {error}"))?;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                let state = snapshot(&window);
                // Hiding unmaps the window, which the application can always see. Wayland
                // compositors do not report iconification back to the client, so a requested
                // minimize may stay unreported: say what was observed instead of assuming it.
                let visible = state["windowVisible"].as_bool().unwrap_or(true);
                let miniaturized = state["miniaturized"].as_bool().unwrap_or(false);
                let ok = if mode == "miniaturize" {
                    miniaturized || !visible
                } else {
                    !visible
                };
                Ok(json!({"ok": ok, "mode": mode, "state": state}))
            }
            WindowAction::Show { mode } => {
                if !matches!(mode.as_str(), "orderout" | "miniaturize") {
                    return Ok(json!({"ok": false, "error": format!("unknown mode {mode}")}));
                }
                if mode == "miniaturize" {
                    window
                        .unminimize()
                        .map_err(|error| format!("unminimize: {error}"))?;
                }
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
        let pids = resolve_webkit_pids(&scan_processes(), std::process::id());
        json!({
            "hostPid": std::process::id(),
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

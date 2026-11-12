/**
 * When a web preview's frame stays mounted.
 *
 * A preview is untrusted remote content rendered by WebKit in an iframe. A page that is not on
 * screen must not keep working — a dev-server page can burn CPU and hold hundreds of MB — so the
 * frame is torn down the moment it is not being looked at. "Not being looked at" has exactly
 * three supported causes here:
 *
 * - the owning Space is not the active Space,
 * - the owning tab is not the active tab of its Space,
 * - a window-visibility signal reports the window hidden or minimized.
 *
 * Window focus is deliberately NOT a cause: losing focus while the window stays visible means
 * the user is working elsewhere with the preview still on screen. Tearing the frame down there
 * would be a visible reload the user never asked for. It is part of the inputs only so the
 * invariant is stated and tested where the decision is made.
 */
export type PreviewFrameInputs = {
  /** The tab that owns the frame is the active tab of its Space. */
  tabActive: boolean;
  /** The tab's Space is the active Space. */
  spaceActive: boolean;
  /** A supported signal (page visibility, native occlusion) says the window is visible. */
  windowVisible: boolean;
  /**
   * The window has OS focus. Recorded for callers, never consulted: a visible window that
   * lost focus still shows the preview.
   */
  windowFocused?: boolean;
};

export type PreviewFrameUnloadReason =
  | "tab-inactive"
  | "space-inactive"
  | "window-hidden";

export type PreviewFrameLifecycle =
  | { mounted: true; reason: null }
  | { mounted: false; reason: PreviewFrameUnloadReason };

/** The containing Space first, then the tab, then the window: the closest cause to the action. */
export function previewFrameLifecycle(
  input: PreviewFrameInputs,
): PreviewFrameLifecycle {
  if (!input.spaceActive) return { mounted: false, reason: "space-inactive" };
  if (!input.tabActive) return { mounted: false, reason: "tab-inactive" };
  if (!input.windowVisible) return { mounted: false, reason: "window-hidden" };
  return { mounted: true, reason: null };
}

const CAUSE: Record<PreviewFrameUnloadReason, string> = {
  "tab-inactive": "You switched to another tab.",
  "space-inactive": "You switched to another Space.",
  "window-hidden": "The window was hidden or minimized.",
};

export type PreviewReloadNotice = {
  title: string;
  detail: string;
  /** What this application can and cannot see on Linux, so nobody expects full occlusion support. */
  limitation: string;
};

/**
 * What the pane shows where the frame re-mounts: the page was unloaded, so it reloads from the
 * server and anything held only in the old document is gone. The dev server itself is a separate
 * process and keeps running.
 */
export function previewReloadNotice(
  reason: PreviewFrameUnloadReason,
): PreviewReloadNotice {
  return {
    title: "Preview reloaded",
    detail: `${CAUSE[reason]} The frame was unloaded to stop hidden page work, so the page reloaded from its server: scroll position, form input and any other page state are lost. The dev server keeps running.`,
    limitation:
      "Unloading follows only the visibility signals the platform reports: on Linux, a window covered by another window, and minimize under Wayland, may keep running.",
  };
}

/**
 * The disclosure that belongs on screen after a frame was unloaded.
 *
 * The cause is recorded when the frame goes away and survives the re-mount so the notice can
 * explain the reload where it happens. It is deliberately not rewritten while the frame stays
 * gone: returning to a Space re-renders before the app has restored that Space's active tab, and
 * those intermediate renders report a tab switch that never happened.
 */
export function reloadNoticeAfter(
  previous: PreviewFrameLifecycle,
  next: PreviewFrameLifecycle,
  notice: PreviewFrameUnloadReason | null,
): PreviewFrameUnloadReason | null {
  if (next.mounted) return notice;
  // Already gone: keep (or keep quiet about) the cause recorded on the way out.
  if (!previous.mounted) return notice;
  return next.reason;
}

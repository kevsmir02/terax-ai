import {
  Alert02Icon,
  Cancel01Icon,
  Globe02Icon,
  InformationCircleIcon,
  LinkSquare02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  PreviewAddressBar,
  type PreviewAddressBarHandle,
} from "./PreviewAddressBar";
import {
  previewFrameLifecycle,
  previewReloadNotice,
  reloadNoticeAfter,
  type PreviewFrameUnloadReason,
} from "./lib/frameLifecycle";
import { isAllowedPreviewUrl, loopbackPreviewOrigin } from "./lib/previewUrl";

export type PreviewPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  url: string;
  /** The tab that owns this frame is the active tab of its Space. */
  tabActive: boolean;
  /** The tab's Space is the active Space. */
  spaceActive: boolean;
  /** A supported window-visibility signal says the window is visible (focus is not one). */
  windowVisible: boolean;
  onUrlChange: (url: string) => void;
};

export const PreviewPane = forwardRef<PreviewPaneHandle, Props>(
  function PreviewPane(
    { url, tabActive, spaceActive, windowVisible, onUrlChange },
    ref,
  ) {
    // `nonce` is part of the iframe `key`. Bumping it remounts the iframe,
    // which is the only reliable cross-origin reload (calling
    // contentWindow.location.reload() throws on cross-origin frames).
    const [nonce, setNonce] = useState(0);
    const [dismissedCookieOrigin, setDismissedCookieOrigin] = useState<
      string | null
    >(null);
    const addressRef = useRef<PreviewAddressBarHandle>(null);

    // The frame exists only while it is on screen: inactive tab/Space or a
    // hidden window tears it down in this render, not after a grace period.
    const lifecycle = previewFrameLifecycle({
      tabActive,
      spaceActive,
      windowVisible,
    });
    // Remembers why the frame went away so the reload (and the state it lost)
    // can be explained where it re-mounts.
    const [reloadNotice, setReloadNotice] =
      useState<PreviewFrameUnloadReason | null>(null);
    const previousLifecycle = useRef(lifecycle);
    useEffect(() => {
      const next = reloadNoticeAfter(
        previousLifecycle.current,
        lifecycle,
        reloadNotice,
      );
      previousLifecycle.current = lifecycle;
      if (next !== reloadNotice) setReloadNotice(next);
    }, [lifecycle, reloadNotice]);

    const reload = () => setNonce((n) => n + 1);
    const submit = (next: string) => {
      setReloadNotice(null);
      onUrlChange(next);
    };

    useImperativeHandle(
      ref,
      () => ({
        reload: () => {
          setNonce((n) => n + 1);
        },
        focusAddressBar: () => addressRef.current?.focus(),
        getUrl: () => url,
      }),
      [url],
    );

    const allowed = isAllowedPreviewUrl(url);
    const onScreen = tabActive && spaceActive;
    const cookieOrigin = loopbackPreviewOrigin(url);
    const showXfoHint = url ? cookieOrigin === null : false;
    const showCookieHint =
      cookieOrigin !== null && cookieOrigin !== dismissedCookieOrigin;

    return (
      <div
        className="flex h-full w-full flex-col overflow-hidden bg-background"
        style={{
          visibility: onScreen ? "visible" : "hidden",
          pointerEvents: onScreen ? "auto" : "none",
        }}
      >
        <PreviewAddressBar
          ref={addressRef}
          url={url}
          onSubmit={submit}
          onReload={reload}
        />
        {showXfoHint ? (
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-amber-500/8 px-3 text-[11px] text-amber-600 dark:text-amber-400">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <span className="truncate">
              Many public sites refuse to embed (X-Frame-Options). If the page
              is blank, open it externally.
            </span>
          </div>
        ) : null}
        {showCookieHint ? (
          <div
            role="note"
            className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-sky-500/8 px-3 text-[11px] text-sky-700 dark:text-sky-300"
          >
            <HugeiconsIcon
              icon={InformationCircleIcon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <span
              className="min-w-0 flex-1 truncate"
              title="Cookie-based sign-in may not work in the sandboxed preview."
            >
              Cookie-based sign-in may not work in preview.
            </span>
            <button
              type="button"
              onClick={() => void openUrl(url).catch(console.error)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-sky-500/15"
            >
              <HugeiconsIcon
                icon={LinkSquare02Icon}
                size={10}
                strokeWidth={1.75}
              />
              Open in browser
            </button>
            <button
              type="button"
              aria-label="Dismiss cookie sign-in notice"
              title="Dismiss"
              onClick={() => setDismissedCookieOrigin(cookieOrigin)}
              className="flex size-5 shrink-0 items-center justify-center rounded text-sky-700/70 hover:bg-sky-500/15 hover:text-sky-800 dark:text-sky-300/70 dark:hover:text-sky-200"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </div>
        ) : null}
        {lifecycle.mounted && reloadNotice ? (
          <PreviewReloadNotice
            reason={reloadNotice}
            onDismiss={() => setReloadNotice(null)}
          />
        ) : null}
        <div
          className={
            url
              ? "relative min-h-0 flex-1 bg-white"
              : "relative min-h-0 flex-1 bg-background"
          }
        >
          {url && !allowed ? (
            <p className="p-4 text-sm text-destructive">
              This URL cannot be loaded in preview.
            </p>
          ) : url ? (
            lifecycle.mounted ? (
              <iframe
                key={`${url}#${nonce}`}
                src={url}
                title="Preview"
                className="h-full w-full border-0"
                // sandbox grants the bare minimum for a dev preview: scripts,
                // same-origin (cookies/storage for the previewed app), forms,
                // popups for "open in new tab". Critically OMITS
                // `allow-top-navigation*` — without it the iframe cannot
                // navigate the parent Tauri webview to an attacker origin,
                // which would otherwise expose `window.__TAURI__` IPC.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
            ) : (
              <UnloadedState reason={lifecycle.reason} />
            )
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    );
  },
);

/**
 * Shown where the frame re-mounts: the page reloads from its own server and anything held only
 * in the old document is gone. Dismissible because it describes a past event, not a current
 * problem.
 */
export function PreviewReloadNotice({
  reason,
  onDismiss,
}: {
  reason: PreviewFrameUnloadReason;
  onDismiss: () => void;
}) {
  const notice = previewReloadNotice(reason);
  return (
    <div
      role="status"
      data-preview-reloaded={reason}
      className="flex shrink-0 items-start gap-1.5 border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground"
    >
      <HugeiconsIcon
        icon={InformationCircleIcon}
        size={12}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-foreground">{notice.title}</p>
        <p className="leading-relaxed">{notice.detail}</p>
        <p className="leading-relaxed opacity-75">{notice.limitation}</p>
      </div>
      <button
        type="button"
        aria-label="Dismiss preview reload notice"
        title="Dismiss"
        onClick={onDismiss}
        className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent/60 hover:text-foreground"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * The frame's placeholder while it is unloaded. The pane itself is hidden in every unloaded
 * state (inactive tab, inactive Space, hidden window), so this is only ever on screen for the
 * render in which the frame returns — the real explanation of the lost state is the notice
 * above the fresh frame.
 */
function UnloadedState({ reason }: { reason: PreviewFrameUnloadReason }) {
  const cause =
    reason === "space-inactive"
      ? "this Space is inactive"
      : reason === "window-hidden"
        ? "the window is hidden"
        : "another tab is active";
  return (
    <div
      data-preview-unloaded={reason}
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={18} strokeWidth={1.5} />
      </div>
      <div className="space-y-1">
        <p className="text-[12.5px] font-medium text-foreground">
          Preview unloaded
        </p>
        <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
          Unloaded while {cause}. It reloads automatically when you return.
        </p>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground">
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-foreground">
          Nothing to preview yet
        </p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
          Type a URL above, or open the{" "}
          <span className="rounded bg-muted px-1 py-0.5 font-mono text-[10.5px]">
            Ports
          </span>{" "}
          dropdown to jump straight to your running dev server. Public sites
          often block embedding. Open them in your browser via the link icon if
          you see a blank page.
        </p>
      </div>
    </div>
  );
}

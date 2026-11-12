import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { playingSession, useMediaPlaybackStore } from "./lib/mediaPlayback";
import { mediaFormatForPath } from "./lib/mediaFormats";
import {
  type MediaElementStatus,
  type MediaPlaybackBlock,
  mediaViewerState,
} from "./lib/mediaViewer";
import { useMediaProbe } from "./lib/useMediaProbe";
import { type MediaElementEvent, MediaPreviewView } from "./MediaPreviewView";

type Props = {
  path: string;
  tabId: number;
  /** Bearer token of the tab-owned grant; media is served over loopback from it. */
  token: string | undefined;
  /** The tab is on screen. Window visibility is folded into this by the stack. */
  visible: boolean;
  onOpenExternally: () => void;
};

/**
 * The bounded audio/video surface.
 *
 * The order is the contract: the extension routes the file, the native header
 * probe reports the real container, and only a measured container mounts an
 * element over the granted `asset:` URL. The element's own events are the
 * authority on codecs. Hiding the tab pauses playback and releases the
 * application-wide slot without unmounting the element (the position stays);
 * returning never calls `play()`. Closing or replacing the tab unmounts the
 * element and the asset grant, so no handle or token outlives the tab.
 */
export function MediaPreview({
  path,
  tabId,
  token,
  visible,
  onOpenExternally,
}: Props) {
  const format = mediaFormatForPath(path);
  const [attempt, setAttempt] = useState(0);
  const [element, setElement] = useState<MediaElementStatus>({ phase: "idle" });
  const [blocked, setBlocked] = useState<MediaPlaybackBlock | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | undefined>();
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [urlAttempt, setUrlAttempt] = useState(0);
  const probeState = useMediaProbe(path, visible);
  const id = `media:${tabId}:${path}`;
  const name = path.split("/").pop() ?? path;
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((element: HTMLMediaElement | null) => {
    mediaRef.current = element;
  }, []);

  const session = useMediaPlaybackStore((state) =>
    playingSession(state.sessions, id),
  );
  const start = useMediaPlaybackStore((state) => state.start);
  const stop = useMediaPlaybackStore((state) => state.stop);
  const stopAll = useMediaPlaybackStore((state) => state.stopAll);

  // Media elements cannot load the custom `asset:` scheme on WebKitGTK
  // (WebKit bug 146351): the same grant is served over a loopback URL that
  // applies the identical token, range and delivery bounds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: urlAttempt forces a fresh resolve after Retry
  useEffect(() => {
    setMediaUrl(undefined);
    setSourceError(null);
    if (!token) return;
    let disposed = false;
    void invoke<string>("asset_media_url", { token })
      .then((url) => {
        if (!disposed) setMediaUrl(url);
      })
      .catch((error: unknown) => {
        if (!disposed) setSourceError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [token, urlAttempt]);

  // A tab that is no longer presented must not keep playing: pause, release
  // its application-wide slot, and drop a policy notice from the old view.
  useEffect(() => {
    if (visible) return;
    const media = mediaRef.current;
    if (media && !media.paused) media.pause();
    stop(id);
    setBlocked(null);
  }, [visible, id, stop]);

  // The playback table is the only authority on "playing". If another element
  // in the same tab started (or the person stopped every element), this one
  // pauses; nothing here ever resumes it.
  useEffect(() => {
    const media = mediaRef.current;
    if (!session && media && !media.paused) media.pause();
  }, [session]);

  // Closing or replacing the tab releases its playback slot. The element and
  // the `asset:` grant are released by unmounting (the EditorPane owns the
  // grant scope and revokes it on tab close).
  useEffect(() => {
    return () => stop(id);
  }, [id, stop]);

  const retry = useCallback(() => {
    setElement({ phase: "idle" });
    setBlocked(null);
    setAttempt((value) => value + 1);
    setUrlAttempt((value) => value + 1);
    probeState.retry();
  }, [probeState]);

  const onElementEvent = (event: MediaElementEvent) => {
    switch (event.type) {
      case "loadedmetadata":
        setElement({
          phase: "loaded",
          durationSeconds: event.duration,
          codecs: [],
        });
        setBlocked(null);
        break;
      case "error":
        setElement({
          phase: "error",
          code: event.code,
          message: event.message,
        });
        stop(id);
        break;
      case "play": {
        const media = mediaRef.current;
        if (!visible) {
          media?.pause();
          break;
        }
        const outcome = start({ id, tabId: String(tabId), label: name });
        if (outcome.kind === "refuse") {
          setBlocked({
            reason: outcome.reason,
            blocking: outcome.blocking,
          });
          media?.pause();
        } else {
          setBlocked(null);
        }
        break;
      }
      case "pause":
      case "ended":
        stop(id);
        break;
    }
  };

  const state = mediaViewerState({
    format,
    probe: probeState.probe,
    visible,
    element,
    blocked,
    sourceReady: Boolean(mediaUrl),
    sourceError,
  });

  return (
    <MediaPreviewView
      // A retry remounts the element even for the same source.
      key={`${path}:${attempt}`}
      state={state}
      path={path}
      url={mediaUrl}
      visible={visible}
      onMediaRef={attachMedia}
      onOpenExternally={onOpenExternally}
      onRetry={retry}
      onStopOtherPlayback={() => {
        stopAll();
        setBlocked(null);
      }}
      onElementEvent={onElementEvent}
    />
  );
}

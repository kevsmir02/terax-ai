// The bounded Markdown inline image.
//
// A rendered document used to mount every `<img>` at its intrinsic size: no
// header probe, no decoded ceiling and no admission. This container gives an
// inline image the same contract as the dedicated image surface:
//
//   native header probe (visible images only) -> 64 MiB decoded ceiling ->
//   decoded-viewer admission -> `<img>`
//
// A remote or `data:` reference has no file path to probe, so its element
// mounts once to report its intrinsic size and the same ceiling and admission
// table decide whether it stays. Off-screen images do neither: the native probe
// runs only after the image intersects the viewport (and its tab is shown), and
// admission is released when the image unmounts with its document.

import {
  type ComponentProps,
  createContext,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useDecodedViewer } from "@/modules/preview/lib/useDecodedViewer";
import { useImageProbe } from "@/modules/preview/lib/useImageProbe";
import { MarkdownImageView } from "./MarkdownImageView";
import {
  type MarkdownImageSource,
  markdownImageProbePath,
  markdownImageRequest,
  markdownImageSource,
  markdownImageState,
  markdownImageViewerId,
} from "../lib/inlineImage";
import { useFileBytes } from "../lib/useFileBytes";

type HastImageProps = {
  readonly node?: {
    readonly properties?: Record<string, unknown>;
  };
};

/**
 * Whether the document on screen is visible. Streamdown memoizes the whole
 * rendered tree and ignores its `components` prop, so a plain prop would not
 * reach an already-rendered image when a tab is hidden; context does, and the
 * image releases its decoded-viewer slot without remounting the document.
 */
export const MarkdownImageVisibility = createContext(true);

export type MarkdownImageProps = ComponentProps<"img"> &
  HastImageProps & {
    /** The tab that owns the decoded-viewer slot. */
    tabId: number;
    /** The document being rendered; part of the admission id. */
    documentPath: string;
  };

/** Watches one element and latches the first intersection. */
function useNearViewport(): [RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || inView) return;
    // A webview without IntersectionObserver still shows the image; it simply
    // loses the lazy gate rather than becoming permanently blank.
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setInView(true);
      },
      { rootMargin: "0px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView]);

  return [ref, inView];
}

/**
 * Reads the source the rehype policy tagged. An `<img>` without a tag was not
 * produced by the managed policy, so it is not drawn: the document must not be
 * able to smuggle in an unbudgeted element.
 */
export function MarkdownImage({
  node,
  tabId,
  documentPath,
  src,
  alt,
  title,
}: MarkdownImageProps) {
  const documentVisible = useContext(MarkdownImageVisibility);
  const properties = node?.properties ?? {};
  const key = properties["data-terax-image-key"];
  const source = markdownImageSource({
    kind: properties["data-terax-image"],
    path: properties["data-terax-image-path"],
    guard: properties["data-terax-image-guard"],
    src,
  });
  if (!source || typeof src !== "string" || typeof key !== "string") {
    return null;
  }
  if (key.length === 0) return null;
  return (
    <BoundedMarkdownImage
      source={source}
      imageKey={key}
      tabId={tabId}
      documentPath={documentPath}
      documentVisible={documentVisible}
      src={src}
      alt={alt}
      title={title}
    />
  );
}

type BoundedProps = {
  source: MarkdownImageSource;
  imageKey: string;
  tabId: number;
  documentPath: string;
  documentVisible: boolean;
  src: string;
  alt?: string;
  title?: string;
};

function BoundedMarkdownImage({
  source,
  imageKey,
  tabId,
  documentPath,
  documentVisible,
  src,
  alt,
  title,
}: BoundedProps) {
  const [containerRef, inView] = useNearViewport();
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [loaded, setLoaded] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const visible = documentVisible && inView;

  // Only a failed load needs the file's size: a local file above the
  // delivery ceiling is refused by the native handler, and the element only
  // reports a load error (its 413 body is unreadable from here).
  const fileBytes = useFileBytes(
    source.kind === "file" ? source.path : "",
    decodeFailed && source.kind === "file",
  );

  const base = {
    source,
    visible,
    loaded,
    admission: null,
    evicted: false,
    decodeFailed,
    fileBytes,
  };
  // The probe is requested only for a visible file image, before the ceiling
  // decision can exist. A deferred image yields no path, so the hook stays off.
  const beforeProbe = markdownImageState({ ...base, probe: null });
  const probePath = source.kind === "file" ? source.path : "";
  const shouldProbe = markdownImageProbePath(source, beforeProbe) !== null;
  const probe = useImageProbe(
    probePath,
    shouldProbe,
    source.kind === "file" ? (source.guard ?? undefined) : undefined,
  );

  const candidate = markdownImageState({ ...base, probe: probe.probe });
  const request = markdownImageRequest(candidate);
  const id = markdownImageViewerId({ documentPath, tabId, key: imageKey });
  const viewer = useDecodedViewer({
    id,
    tabId: String(tabId),
    decodedBytes: request?.decodedBytes ?? 0,
    visible,
    enabled: Boolean(request),
  });
  const state = markdownImageState({
    ...base,
    probe: probe.probe,
    admission: viewer.admission,
    evicted: viewer.evicted,
  });

  const retry = () => {
    setDecodeFailed(false);
    setLoaded(null);
    setAttempt((value) => value + 1);
    probe.retry();
  };

  return (
    <span ref={containerRef} className="block max-w-full">
      <MarkdownImageView
        key={attempt}
        state={state}
        source={source}
        src={src}
        alt={alt}
        title={title}
        onLoaded={setLoaded}
        onDecodeFailed={() => setDecodeFailed(true)}
        onRetry={retry}
      />
    </span>
  );
}

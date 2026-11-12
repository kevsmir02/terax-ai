/**
 * The window-visibility signal a preview frame's lifetime is allowed to follow.
 *
 * Two supported inputs, both about whether the window is on screen — never about focus:
 * - `document.visibilityState`, which WebKitGTK reports when the toplevel is unmapped (the
 *   window is hidden, or the compositor reports a minimize);
 * - the shared native presentation feed, which carries macOS occlusion and machine sleep. On
 *   Linux it reports nothing today, so a minimized-on-Wayland or covered window is not seen.
 */
export type VisibilityDocument = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type PresentationSubscription = (
  listener: (state: { readonly visible: boolean }) => void,
) => () => void;

export type WindowVisibleTracker = {
  visible: () => boolean;
  /** Calls back on changes, starting immediately with the current value. */
  subscribe: (listener: (visible: boolean) => void) => () => void;
};

type Sources = {
  doc: VisibilityDocument;
  subscribePresentation?: PresentationSubscription;
};

export function createWindowVisibleTracker(
  sources: Sources,
): WindowVisibleTracker {
  const { doc } = sources;
  const listeners = new Set<(visible: boolean) => void>();
  let presentationVisible = true;
  // The document listener is installed while there is at least one subscriber.
  let detachDocument: (() => void) | null = null;
  let detachPresentation: (() => void) | null = null;

  const read = () => doc.visibilityState === "visible" && presentationVisible;

  const publish = (visible: boolean) => {
    for (const listener of [...listeners]) listener(visible);
  };

  const sync = () => publish(read());

  return {
    visible: read,
    subscribe(listener) {
      listeners.add(listener);
      listener(read());
      if (!detachDocument) {
        doc.addEventListener("visibilitychange", sync);
        detachDocument = () =>
          doc.removeEventListener("visibilitychange", sync);
        detachPresentation =
          sources.subscribePresentation?.((state) => {
            presentationVisible = state.visible;
            sync();
          }) ?? null;
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size > 0) return;
        detachDocument?.();
        detachPresentation?.();
        detachDocument = null;
        detachPresentation = null;
        presentationVisible = true;
      };
    },
  };
}

export function documentVisibility(
  doc: VisibilityDocument | undefined = typeof document === "undefined"
    ? undefined
    : document,
): boolean {
  return doc ? doc.visibilityState === "visible" : true;
}

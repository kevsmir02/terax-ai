import { useEffect, useState } from "react";
import {
  createWindowVisibleTracker,
  type PresentationSubscription,
} from "./windowVisibility";

/**
 * True while a supported signal says the window is on screen.
 *
 * Deliberately no focus source: a visible window that lost focus still shows the preview, so a
 * preview frame must not be unloaded for it.
 */
export function useWindowVisible(
  subscribePresentation?: PresentationSubscription,
): boolean {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const tracker = createWindowVisibleTracker({
      doc: document,
      subscribePresentation,
    });
    return tracker.subscribe(setVisible);
  }, [subscribePresentation]);
  return visible;
}

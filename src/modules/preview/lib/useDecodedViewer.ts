import { useEffect, useState } from "react";
import type { DecodedViewer, ViewerAdmission } from "./limits";
import { useViewerAdmissionStore } from "./viewerAdmission";

export type DecodedViewerRequest = {
  /** Stable per decoded surface (viewer + tab + path). */
  readonly id: string;
  readonly tabId: string;
  /** Decoded bytes this surface holds right now. */
  readonly decodedBytes: number;
  /** False only while the tab is not on screen; hidden viewers are evictable. */
  readonly visible: boolean;
  /** False until the surface really holds a decoded raster. */
  readonly enabled?: boolean;
};

/**
 * Registers a decoded surface with the application-wide admission table.
 *
 * The caller renders according to the returned decision: `admit` means show the
 * raster, `refuse` means show the reason and alternatives, `evicted` means this
 * surface was released to make room for another one. A refused or disabled
 * surface never claims decoded bytes.
 */
export function useDecodedViewer({
  id,
  tabId,
  decodedBytes,
  visible,
  enabled = true,
}: DecodedViewerRequest): {
  admission: ViewerAdmission | null;
  evicted: boolean;
} {
  const [admission, setAdmission] = useState<ViewerAdmission | null>(null);
  const evicted = useViewerAdmissionStore((state) =>
    state.viewers.some((viewer) => viewer.id === id && viewer.evicted),
  );
  useEffect(() => {
    if (!enabled) {
      setAdmission(null);
      return;
    }
    const request: Omit<DecodedViewer, "lastUsed"> = {
      id,
      tabId,
      decodedBytes,
      visible,
    };
    setAdmission(useViewerAdmissionStore.getState().admit(request));
    return () => useViewerAdmissionStore.getState().release(id);
  }, [id, tabId, decodedBytes, visible, enabled]);
  return { admission, evicted };
}

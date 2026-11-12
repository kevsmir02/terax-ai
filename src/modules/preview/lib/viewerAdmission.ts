import { create } from "zustand";
import {
  type DecodedViewer,
  decideViewerAdmission,
  type ViewerAdmission,
} from "./limits";

/**
 * The decoded-viewer admission table.
 *
 * `decideViewerAdmission` is the policy (issue #4): at most four decoded
 * viewers and at most 192 MiB decoded application-wide, hidden viewers may be
 * released least-recently-used first, and a *visible* viewer is never evicted.
 * This module applies that policy to a live table and marks the evicted entries
 * so their components release their raster; the decision itself stays pure and
 * is tested in `limits.test.ts`.
 */

export type ViewerEntry = DecodedViewer & {
  /**
   * True after another viewer's admission had to release this one. The entry
   * stays until its component releases it, so the component can tell why its
   * raster went away instead of silently vanishing.
   */
  readonly evicted: boolean;
};

export type AdmissionOutcome = {
  readonly viewers: readonly ViewerEntry[];
  readonly admission: ViewerAdmission;
};

/** Applies one admission decision to the table. */
export function admitDecodedViewer(
  viewers: readonly ViewerEntry[],
  request: DecodedViewer,
): AdmissionOutcome {
  // An evicted viewer no longer holds decoded bytes, even if its component has
  // not acknowledged the release yet.
  const holding = viewers.filter((viewer) => !viewer.evicted);
  const admission = decideViewerAdmission(holding, request);
  if (admission.kind === "refuse") {
    return { viewers, admission };
  }
  const evict = new Set(admission.evict);
  const next: ViewerEntry[] = viewers.map((viewer) =>
    evict.has(viewer.id) ? { ...viewer, evicted: true } : viewer,
  );
  const entry: ViewerEntry = { ...request, evicted: false };
  const existing = next.findIndex((viewer) => viewer.id === request.id);
  if (existing >= 0) next[existing] = entry;
  else next.push(entry);
  return { viewers: next, admission };
}

/** Drops a viewer; its component released the decoded raster. */
export function releaseDecodedViewer(
  viewers: readonly ViewerEntry[],
  id: string,
): readonly ViewerEntry[] {
  return viewers.filter((viewer) => viewer.id !== id);
}

/** Decoded bytes currently held, excluding entries already released by policy. */
export function heldDecodedBytes(viewers: readonly ViewerEntry[]): number {
  return viewers
    .filter((viewer) => !viewer.evicted)
    .reduce((sum, viewer) => sum + viewer.decodedBytes, 0);
}

type ViewerState = {
  readonly viewers: readonly ViewerEntry[];
  /** Monotonic use counter, so eviction is least-recently-used. */
  readonly clock: number;
  /** Admits (or re-admits) a viewer and returns the decision the caller shows. */
  admit: (request: Omit<DecodedViewer, "lastUsed">) => ViewerAdmission;
  /** Releases one viewer's raster and its slot. */
  release: (id: string) => void;
  /** Releases everything; used when a tab closes or the window unloads. */
  releaseAll: () => void;
};

export const useViewerAdmissionStore = create<ViewerState>((set, get) => ({
  viewers: [],
  clock: 0,
  admit: (request) => {
    const clock = get().clock + 1;
    const outcome = admitDecodedViewer(get().viewers, {
      ...request,
      lastUsed: clock,
    });
    set({ viewers: outcome.viewers, clock });
    return outcome.admission;
  },
  release: (id) =>
    set((state) => ({
      viewers: releaseDecodedViewer(state.viewers, id),
    })),
  releaseAll: () => set({ viewers: [] }),
}));

import { create } from "zustand";
import {
  decideMediaPlayback,
  type LimitAlternative,
  type MediaPlaybackSession,
} from "./limits";

/**
 * The live playback table for the approved "1 playing element per tab, 3
 * application-wide" contract.
 *
 * `decideMediaPlayback` in `limits.ts` is the policy; this module applies it to
 * the elements that are actually playing and names the blockers. The table is
 * deliberately *not* a player: it never calls `play()`. Hiding a tab, closing
 * it, or stopping another element only releases slots, so returning to a tab
 * can never auto-resume playback the person paused.
 */

export type MediaSessionEntry = MediaPlaybackSession & {
  /** A readable name for a refusal, e.g. the file name. */
  readonly label: string;
};

export type MediaPlaybackStart =
  | {
      kind: "play";
      /** Sibling elements the surface must pause to honour one-per-tab. */
      pause: readonly string[];
    }
  | {
      kind: "refuse";
      reason: string;
      alternatives: readonly LimitAlternative[];
      blocking: readonly string[];
      /** The same blockers with names the interface can show. */
      blockers: readonly { id: string; label: string }[];
    };

export type MediaPlaybackRequest = {
  readonly id: string;
  readonly tabId: string;
  readonly label?: string;
};

type MediaPlaybackState = {
  readonly sessions: readonly MediaSessionEntry[];
  /** Monotonic start counter, so a session order is observable. */
  readonly clock: number;
  start: (request: MediaPlaybackRequest) => MediaPlaybackStart;
  stop: (id: string) => void;
  /** Releases a tab's slot; used when the tab hides, closes or unmounts. */
  stopTab: (tabId: string) => void;
  /** Releases every slot; used by the "stop other playback" action. */
  stopAll: () => void;
};

export const useMediaPlaybackStore = create<MediaPlaybackState>((set, get) => ({
  sessions: [],
  clock: 0,
  start: (request) => {
    const clock = get().clock + 1;
    const sessions = get().sessions;
    const decision = decideMediaPlayback(sessions, {
      id: request.id,
      tabId: request.tabId,
      startedAt: clock,
    });
    if (decision.kind === "refuse") {
      const blockers = decision.blocking.map((id) => ({
        id,
        label: sessions.find((session) => session.id === id)?.label ?? id,
      }));
      return { ...decision, blockers };
    }
    const paused = new Set(decision.pause);
    const next = sessions.filter((session) => !paused.has(session.id));
    const entry: MediaSessionEntry = {
      id: request.id,
      tabId: request.tabId,
      startedAt: clock,
      label: request.label ?? request.id,
    };
    set({ sessions: [...next, entry], clock });
    return decision;
  },
  stop: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
    })),
  stopTab: (tabId) =>
    set((state) => ({
      sessions: state.sessions.filter((session) => session.tabId !== tabId),
    })),
  stopAll: () => set({ sessions: [] }),
}));

/** The playing entry for a surface id, or undefined. */
export function playingSession(
  sessions: readonly MediaSessionEntry[],
  id: string,
): MediaSessionEntry | undefined {
  return sessions.find((session) => session.id === id);
}

import { create } from "zustand";
import type {
  AgentNotification,
  AgentSession,
  AgentStatus,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;

let notifSeq = 0;

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  notifications: AgentNotification[];
  start: (leafId: number, tabId: number, agent: string) => void;
  setStatus: (leafId: number, status: AgentStatus) => void;
  finish: (leafId: number) => void;
  pushNotification: (
    n: Omit<AgentNotification, "id" | "at" | "read">,
  ) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  notifications: [],

  start: (leafId, tabId, agent) =>
    set((s) => {
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            leafId,
            tabId,
            agent,
            status: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
          },
        },
      };
    }),

  setStatus: (leafId, status) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev || prev.status === status) return s;
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === "waiting" ? now : null,
          },
        },
      };
    }),

  finish: (leafId) =>
    set((s) => {
      if (!s.sessions[leafId]) return s;
      const next = { ...s.sessions };
      delete next[leafId];
      return { sessions: next };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return { notifications: s.notifications.map((n) => ({ ...n, read: true })) };
    }),

  clearNotifications: () => set({ notifications: [] }),
}));

/** The tab/leaf of the agent that most recently entered the waiting state, for
 *  the keyboard jump-to-attention shortcut. Null when none is waiting. */
export function nextAttentionTarget(): { tabId: number; leafId: number } | null {
  const waiting = Object.values(useAgentStore.getState().sessions)
    .filter((s) => s.status === "waiting")
    .sort((a, b) => (b.attentionSince ?? 0) - (a.attentionSince ?? 0));
  const t = waiting[0];
  return t ? { tabId: t.tabId, leafId: t.leafId } : null;
}

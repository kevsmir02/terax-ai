import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextAttentionTarget, useAgentStore } from "./agentStore";
import type { AgentNotification } from "../lib/types";

describe("agent session store", () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessions: {},
      localAgent: null,
      notifications: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a session as running, without claiming progress", () => {
    useAgentStore.getState().start(7, 3, "claude");
    const s = useAgentStore.getState().sessions[7];

    expect(s).toMatchObject({
      leafId: 7,
      tabId: 3,
      agent: "claude",
      status: "running",
    });
    expect(s.attentionSince).toBeNull();
  });

  it("ignores status updates for unknown leaves and identical statuses", () => {
    expect(useAgentStore.getState().setStatus(42, "attention")).toBeUndefined();
    useAgentStore.getState().start(7, 3, "codex");
    const before = useAgentStore.getState().sessions[7];

    useAgentStore.getState().setStatus(7, "running");

    expect(useAgentStore.getState().sessions[7]).toBe(before);
  });

  it("stamps attentionSince when entering attention and clears it on running", () => {
    useAgentStore.getState().start(7, 3, "claude");
    useAgentStore.getState().setStatus(7, "attention");
    const attention = useAgentStore.getState().sessions[7];
    expect(attention.status).toBe("attention");
    expect(attention.attentionSince).not.toBeNull();

    useAgentStore.getState().setStatus(7, "running");
    expect(useAgentStore.getState().sessions[7].attentionSince).toBeNull();
  });

  it("removes the session on finish", () => {
    useAgentStore.getState().start(7, 3, "claude");
    useAgentStore.getState().finish(7);
    expect(useAgentStore.getState().sessions[7]).toBeUndefined();
  });

  it("dedupes local agent state when neither status nor agent changed", () => {
    useAgentStore.getState().setLocalAgent({ agent: "pi", status: "running" });
    const before = useAgentStore.getState().localAgent;

    useAgentStore.getState().setLocalAgent({ agent: "pi", status: "running" });

    expect(useAgentStore.getState().localAgent).toBe(before);

    useAgentStore
      .getState()
      .setLocalAgent({ agent: "pi", status: "attention" });
    expect(useAgentStore.getState().localAgent).toEqual({
      agent: "pi",
      status: "attention",
    });
  });

  it("keeps the fifty most recent notifications, newest first", () => {
    for (let i = 0; i < 55; i++) {
      push({ leafId: i, tabId: i });
    }
    const notifications = useAgentStore.getState().notifications;

    expect(notifications).toHaveLength(50);
    expect(notifications[0].leafId).toBe(54);
    expect(notifications[49].leafId).toBe(5);
    expect(notifications.every((n) => n.read === false)).toBe(true);
    expect(notifications[0].id).not.toBe(notifications[1].id);
  });

  it("markAllRead skips the write when everything is already read", () => {
    push({ leafId: 1, tabId: 1 });
    useAgentStore.getState().markAllRead();
    const afterFirst = useAgentStore.getState().notifications;

    useAgentStore.getState().markAllRead();

    expect(useAgentStore.getState().notifications).toBe(afterFirst);
    expect(useAgentStore.getState().notifications.every((n) => n.read)).toBe(
      true,
    );
  });

  it("nextAttentionTarget returns the most recent agent needing attention", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    useAgentStore.getState().start(1, 10, "claude");
    useAgentStore.getState().setStatus(1, "attention");
    vi.setSystemTime(2_000);
    useAgentStore.getState().start(2, 20, "codex");
    useAgentStore.getState().setStatus(2, "attention");

    expect(nextAttentionTarget()).toEqual({ tabId: 20, leafId: 2 });

    vi.setSystemTime(3_000);
    useAgentStore.getState().setStatus(1, "running");
    useAgentStore.getState().setStatus(1, "attention");

    expect(nextAttentionTarget()).toEqual({ tabId: 10, leafId: 1 });
  });
});

function push(partial: { leafId: number; tabId: number }): void {
  const n: Omit<AgentNotification, "id" | "at" | "read"> = {
    source: "terminal",
    agent: "claude",
    kind: "turn-finished",
    ...partial,
  };
  useAgentStore.getState().pushNotification(n);
}

import type { Tab } from "@/modules/tabs";
import type { PaneNode } from "@/modules/terminal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { traceEager } from "../../../../scripts/eager-graph.mjs";
import { useAgentStore } from "../store/agentStore";
import { useManagedAgentsStore } from "../store/managedAgentsStore";
import type { AgentSignal } from "../lib/types";

const seams = vi.hoisted(() => ({
  osNotify: vi.fn(async () => "requested" as const),
  playSound: vi.fn(),
  showToast: vi.fn(),
  chat: vi.fn(),
}));

// The bridge reaches the terminal module only for the pty->leaf mapping and the
// tab lookup, so the fake keeps pty ids equal to leaf ids and walks the tree.
vi.mock("@/modules/terminal", () => {
  const ids = (node: {
    kind: string;
    id: number;
    children?: unknown[];
  }): number[] =>
    node.kind === "leaf"
      ? [node.id]
      : ((node.children ?? []) as (typeof node)[]).flatMap(ids);
  return {
    hasLeaf: (tree: { kind: string; id: number }, id: number) =>
      ids(tree).includes(id),
    leafIdForPty: (ptyId: number) => ptyId,
    subscribeAgentSignals: () => () => {},
  };
});
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      agentNotifications: true,
      agentNotificationSound: false,
    }),
  },
}));
vi.mock("../lib/notify", () => ({ osNotify: seams.osNotify }));
vi.mock("../lib/sound", () => ({
  playAgentNotificationSound: seams.playSound,
}));
vi.mock("../components/AgentToast", () => ({
  showAgentToast: seams.showToast,
}));
vi.mock("@/modules/ai/store/chatRuntime", () => ({
  getOrCreateChat: seams.chat,
}));

const { handleAgentSignal } = await import("./AgentNotificationsBridge");

const TAB_ID = 3;
const LEAF_ID = 7;
const SPACE_ID = "sp-api";

function tab(leafId = LEAF_ID): Tab {
  return {
    id: leafId + 100,
    kind: "terminal",
    // A terminal title can echo the cwd or a prompt; notifications must not.
    title: "/home/me/work/api · claude · ship the release",
    spaceId: SPACE_ID,
    paneTree: { kind: "leaf", id: leafId } as PaneNode,
  } as Tab;
}

const ctx = {
  tabs: [tab()],
  activeId: TAB_ID,
  focused: false,
  onActivate: vi.fn(),
  spaceNames: { [SPACE_ID]: "api workspace" },
};

/** A separate pane so the delivery gate's cooldown does not hide the payload. */
function ctxFor(
  leafId: number,
  spaceNames: Record<string, string> = ctx.spaceNames,
) {
  const own = tab(leafId);
  return {
    tabs: [own],
    activeId: own.id,
    focused: false,
    onActivate: vi.fn(),
    spaceNames,
  };
}

function signal(kind: AgentSignal["kind"], id = LEAF_ID): AgentSignal {
  return { id, kind, agent: "claude" };
}

function supervised(leafId = LEAF_ID) {
  useManagedAgentsStore.getState().register({
    leafId,
    tabId: TAB_ID,
    sessionId: "session-1",
    task: "ship the release",
    cwd: null,
  });
  return useManagedAgentsStore.getState().agents[leafId];
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({ sessions: {}, localAgent: null, notifications: [] });
  useManagedAgentsStore.setState({ agents: {} });
});

describe("agent signal notifications", () => {
  it("routes a finished turn to the bell and the OS without a managed review", () => {
    const before = supervised();
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("finished"), ctx);

    // The process is still attached to the pane after the turn ends.
    expect(useAgentStore.getState().sessions[LEAF_ID]).toMatchObject({
      tabId: LEAF_ID + 100,
      agent: "claude",
      status: "running",
    });
    expect(useAgentStore.getState().notifications).toMatchObject([
      {
        source: "terminal",
        agent: "claude",
        kind: "turn-finished",
        tabId: LEAF_ID + 100,
      },
    ]);
    expect(seams.osNotify).toHaveBeenCalledOnce();

    // No supervision: the review bookkeeping of the managed agent is untouched
    // and no chat turn is queued for it.
    expect(useManagedAgentsStore.getState().agents[LEAF_ID]).toEqual(before);
    expect(seams.chat).not.toHaveBeenCalled();
  });

  it("routes attention to the bell and the OS", () => {
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("attention"), ctx);

    expect(useAgentStore.getState().sessions[LEAF_ID]?.status).toBe(
      "attention",
    );
    expect(useAgentStore.getState().notifications).toMatchObject([
      { source: "terminal", agent: "claude", kind: "attention" },
    ]);
    expect(seams.osNotify).toHaveBeenCalledOnce();
  });

  it("drops the session on exit and leaves the managed agent alone", () => {
    const before = supervised();
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("exited"), ctx);

    expect(useAgentStore.getState().sessions[LEAF_ID]).toBeUndefined();
    expect(useManagedAgentsStore.getState().agents[LEAF_ID]).toEqual(before);
  });

  it("never reports a completed turn for a process that just exited", () => {
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("exited"), ctx);

    expect(useAgentStore.getState().notifications).toEqual([]);
    expect(seams.osNotify).not.toHaveBeenCalled();
  });

  it("ignores signals for panes that are no longer terminal leaves", () => {
    handleAgentSignal(signal("finished", 99), ctx);

    expect(useAgentStore.getState().sessions).toEqual({});
    expect(useAgentStore.getState().notifications).toEqual([]);
    expect(seams.osNotify).not.toHaveBeenCalled();
  });
});

describe("notification payload", () => {
  it("carries the agent, the Space name and the event type only", async () => {
    const own = ctxFor(8);
    handleAgentSignal(signal("started", 8), own);
    handleAgentSignal(signal("attention", 8), own);

    await vi.waitFor(() => expect(seams.osNotify).toHaveBeenCalledOnce());

    expect(seams.osNotify).toHaveBeenCalledWith(
      "Claude Code needs attention",
      "Space: api workspace",
    );
    const payload = JSON.stringify(seams.osNotify.mock.calls[0]);
    for (const leak of ["/home/me/work/api", "ship the release", "claude ·"]) {
      expect(payload).not.toContain(leak);
    }
  });

  it("falls back to a generic Workspace body when the Space is unknown", async () => {
    const own = ctxFor(9, {});
    handleAgentSignal(signal("started", 9), own);
    handleAgentSignal(signal("finished", 9), own);

    await vi.waitFor(() => expect(seams.osNotify).toHaveBeenCalledOnce());

    expect(seams.osNotify).toHaveBeenCalledWith(
      "Claude Code turn finished",
      "Workspace",
    );
  });
});

describe("notification bridge dependencies", () => {
  it("keeps the retained bridge out of the built-in AI supervision stack", () => {
    const { files } = traceEager(
      "src/modules/agents/components/AgentNotificationsBridge.tsx",
    );

    // Chat stores/runtime, the AI tools, the local notification bridge and the
    // managed-review bookkeeping are supervision. `modules/ai/config` stays
    // reachable on purpose: it is the provider catalog the settings store shares.
    const supervision = [
      /[/\\]modules[/\\]ai[/\\](?:store|components|hooks|tools)[/\\]/,
      /[/\\]modules[/\\]agents[/\\]lib[/\\]review\.ts$/,
      /[/\\]modules[/\\]agents[/\\]store[/\\]managedAgentsStore\.ts$/,
    ];
    expect(
      [...files].filter((file) => supervision.some((re) => re.test(file))),
    ).toEqual([]);
  });
});

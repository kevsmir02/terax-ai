import type { Tab } from "@/modules/tabs";
import type { PaneNode } from "@/modules/terminal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { traceEager } from "../../../../scripts/eager-graph.mjs";
import { useAgentStore } from "../store/agentStore";
import type { AgentSignal } from "../lib/types";

const seams = vi.hoisted(() => ({
  osNotify: vi.fn(async () => "requested" as const),
  playSound: vi.fn(),
  showToast: vi.fn(),
}));

// The bridge reaches the terminal module only for the pty->leaf mapping and the
// tab lookup, so the fake keeps pty ids equal to leaf ids and walks the tree.
vi.mock("@/modules/terminal", () => {
  const ids = (node: { kind: string; id: number; children?: unknown[] }): number[] =>
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

const { handleAgentSignal } = await import("./AgentNotificationsBridge");

const TAB_ID = 3;
const LEAF_ID = 7;

function tab(leafId = LEAF_ID): Tab {
  return {
    id: TAB_ID,
    kind: "terminal",
    title: "claude · ship the release",
    spaceId: "default",
    paneTree: { kind: "leaf", id: leafId } as PaneNode,
  } as Tab;
}

const ctx = {
  tabs: [tab()],
  activeId: TAB_ID,
  focused: false,
  onActivate: vi.fn(),
};

function signal(kind: AgentSignal["kind"], id = LEAF_ID): AgentSignal {
  return { id, kind, agent: "claude" };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAgentStore.setState({ sessions: {}, notifications: [] });
});

describe("agent signal notifications", () => {
  it("routes a finished agent to the bell and the OS", () => {
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("finished"), ctx);

    expect(useAgentStore.getState().sessions[LEAF_ID]).toMatchObject({
      tabId: TAB_ID,
      agent: "claude",
      status: "waiting",
    });
    expect(useAgentStore.getState().notifications).toMatchObject([
      { source: "terminal", agent: "claude", kind: "finished", tabId: TAB_ID },
    ]);
    expect(seams.osNotify).toHaveBeenCalledOnce();
  });

  it("routes attention to the bell and the OS", () => {
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("attention"), ctx);

    expect(useAgentStore.getState().sessions[LEAF_ID]?.status).toBe("waiting");
    expect(useAgentStore.getState().notifications).toMatchObject([
      { source: "terminal", agent: "claude", kind: "attention" },
    ]);
    expect(seams.osNotify).toHaveBeenCalledOnce();
  });

  it("drops the session on exit", () => {
    handleAgentSignal(signal("started"), ctx);
    handleAgentSignal(signal("exited"), ctx);

    expect(useAgentStore.getState().sessions[LEAF_ID]).toBeUndefined();
  });

  it("ignores signals for panes that are no longer terminal leaves", () => {
    handleAgentSignal(signal("finished", 99), ctx);

    expect(useAgentStore.getState().sessions).toEqual({});
    expect(useAgentStore.getState().notifications).toEqual([]);
    expect(seams.osNotify).not.toHaveBeenCalled();
  });
});

describe("notification bridge dependencies", () => {
  it("keeps the retained bridge out of the built-in AI supervision stack", () => {
    const { files } = traceEager(
      "src/modules/agents/components/AgentNotificationsBridge.tsx",
    );

    // The bridge carries external-agent signals only. The built-in chat
    // runtime, tools and supervision bookkeeping were removed (ticket #12).
    const supervision = [
      /[/\\]modules[/\\]ai[/\\]/,
      /[/\\]modules[/\\]agents[/\\]lib[/\\]review\.ts$/,
      /[/\\]modules[/\\]agents[/\\]store[/\\]managedAgentsStore\.ts$/,
    ];
    expect(
      [...files].filter((file) => supervision.some((re) => re.test(file))),
    ).toEqual([]);
  });
});

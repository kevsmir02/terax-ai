import type { Tab } from "@/modules/tabs";
import { describe, expect, it } from "vitest";
import { planSpaceRestore } from "./restore";
import type { SerializedTab } from "./serialize";
import type { SpaceMeta, SpaceState } from "./store";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function space(id: string, name: string, root: string | null): SpaceMeta {
  return {
    id,
    name,
    root,
    env: { kind: "local" },
    accountIsolation: "default",
    createdAt: 0,
    updatedAt: 0,
  };
}

function state(tabs: SerializedTab[], activeTabIndex = 0): SpaceState {
  return { tabs, activeTabIndex };
}

const spaces = [
  space("a", "Terax", "/work/terax"),
  space("b", "Terax review", "/work/terax"),
];

const states = new Map<string, SpaceState>([
  [
    "a",
    state(
      [
        {
          kind: "terminal",
          tree: {
            kind: "split",
            dir: "row",
            children: [
              { kind: "leaf", cwd: "/work/terax" },
              { kind: "leaf", cwd: "/work/terax/docs", active: true },
            ],
          },
        },
        { kind: "editor", path: "/work/terax/changed.ts" },
      ],
      1,
    ),
  ],
  ["b", state([{ kind: "markdown", path: "/work/terax/removed.md" }])],
]);

function plan(activeId: string | null = "a") {
  const restored = planSpaceRestore({
    spaces,
    states,
    activeId,
    env: { kind: "local" },
    restoredHome: "/home/lab",
    launchCwd: "/work/terax",
    home: "/home/lab",
    allocId: counter(),
  });
  if (!restored) throw new Error("the saved organization did not restore");
  return restored;
}

const kinds = (tabs: Tab[]) => tabs.map((tab) => `${tab.spaceId}:${tab.kind}`);

describe("space restoration", () => {
  it("restores each Space's own tabs, layout and cwd", () => {
    const restored = plan();
    expect(restored).not.toBeNull();
    expect(kinds(restored.tabs)).toEqual([
      "a:terminal",
      "a:editor",
      "b:markdown",
    ]);
    expect(restored.activeSpaceId).toBe("a");

    const terminal = restored.tabs[0];
    expect(terminal.kind).toBe("terminal");
    if (terminal.kind !== "terminal") return;
    expect(terminal.cold).toBe(true);
    expect(terminal.cwd).toBe("/work/terax/docs");
    expect(terminal.paneTree.kind).toBe("split");
  });

  it("restores the saved active tab index inside the active Space", () => {
    const restored = plan();
    const inActive = restored.tabs.filter((tab) => tab.spaceId === "a");
    expect(restored.activeTabId).toBe(inActive[1].id);
  });

  it("keeps restored file tabs at their saved locations even if files changed or vanished", () => {
    const restored = plan();
    const editor = restored.tabs.find((tab) => tab.kind === "editor");
    const markdown = restored.tabs.find((tab) => tab.kind === "markdown");
    expect(editor).toMatchObject({
      path: "/work/terax/changed.ts",
      cold: true,
    });
    expect(markdown).toMatchObject({
      path: "/work/terax/removed.md",
      cold: true,
    });
  });

  it("restores without a command, process or agent run to repeat", () => {
    const restored = plan();
    const serialized = JSON.stringify(restored.tabs);
    expect(serialized).not.toMatch(/command|agentCommand|ptyId|pid/);

    for (const tab of restored.tabs) {
      expect(tab.cold).toBe(true);
      if (tab.kind === "terminal") {
        expect(tab).not.toHaveProperty("command");
        expect(tab).not.toHaveProperty("pid");
      }
    }
  });

  it("gives an empty active Space one cold terminal at its own directory", () => {
    const restored = plan("b");
    expect(restored.activeSpaceId).toBe("b");
    // "b" had a saved markdown tab, so only the markdown is there.
    expect(restored.tabs.filter((tab) => tab.spaceId === "b")).toHaveLength(1);

    const empty = planSpaceRestore({
      spaces: [spaces[1], space("c", "Empty", "/work/other")],
      states,
      activeId: "c",
      env: { kind: "local" },
      restoredHome: null,
      launchCwd: "/work/terax",
      home: "/home/lab",
      allocId: counter(300),
    });
    if (!empty) throw new Error("the fallback Space did not restore");
    const inC = empty.tabs.filter((tab) => tab.spaceId === "c");
    expect(inC).toHaveLength(1);
    expect(inC[0].kind).toBe("terminal");
    expect(inC[0].cold).toBe(true);
    if (inC[0].kind === "terminal") {
      expect(inC[0].cwd).toBe("/work/terax");
    }
  });

  it("keeps two Spaces on one checkout separate and restorable", () => {
    const restored = plan();
    expect(new Set(restored.tabs.map((tab) => tab.spaceId))).toEqual(
      new Set(["a", "b"]),
    );
    expect(restored.initialActiveIndex).toEqual({ a: 1, b: 0 });
  });

  it("falls back to the first Space when the saved active one is gone", () => {
    const restored = plan("deleted-space");
    expect(restored.activeSpaceId).toBe("a");
  });
});

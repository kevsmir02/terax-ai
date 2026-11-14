import { describe, expect, it } from "vitest";
import type { PaneNode } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { hydrateTabs, serializeTabs, type SerializedTab } from "./serialize";
import { sharedRoots } from "./sharedRoots";
import type { SpaceMeta } from "./store";

function counter(start = 100): () => number {
  let n = start;
  return () => n++;
}

function leafIdsOf(node: PaneNode): number[] {
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIdsOf);
}

function term(over: Partial<Extract<Tab, { kind: "terminal" }>>): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "s1",
    title: "shell",
    paneTree: { kind: "leaf", id: 2, cwd: "/a" },
    activeLeafId: 2,
    ...over,
  } as Tab;
}

describe("serializeTabs", () => {
  it("drops transient kinds", () => {
    const tabs: Tab[] = [
      term({ id: 1 }),
      {
        id: 5,
        kind: "git-diff",
        spaceId: "s1",
        title: "d",
        path: "/a/x",
        repoRoot: "/a",
        mode: "+",
        originalPath: null,
        preview: true,
      },
      {
        id: 7,
        kind: "editor",
        spaceId: "s1",
        title: "x",
        path: "/a/x.ts",
        dirty: false,
        preview: false,
      },
    ];
    const out = serializeTabs(tabs);
    expect(out.map((t) => t.kind)).toEqual(["terminal", "editor"]);
  });

  it("marks the active leaf in a split tree", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const [s] = serializeTabs([term({ paneTree: tree, activeLeafId: 12 })]);
    const node = s as Extract<SerializedTab, { kind: "terminal" }>;
    expect(node.tree.kind).toBe("split");
    if (node.tree.kind === "split") {
      expect(node.tree.children[1]).toMatchObject({ cwd: "/b", active: true });
      expect(node.tree.children[0]).not.toHaveProperty("active");
    }
  });
});

describe("hydrateTabs", () => {
  it("round-trips structure, cwd, blocks and active leaf", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "col",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const tabs: Tab[] = [
      term({
        paneTree: tree,
        activeLeafId: 12,
        blocks: true,
        customTitle: "x",
      }),
    ];
    const serialized = serializeTabs(tabs);
    const [restored] = hydrateTabs(serialized, "s2", counter());
    expect(restored.kind).toBe("terminal");
    if (restored.kind !== "terminal") return;

    expect(restored.spaceId).toBe("s2");
    expect(restored.cold).toBe(true);
    expect(restored.blocks).toBe(true);
    expect(restored.customTitle).toBe("x");
    expect(restored.paneTree.kind).toBe("split");

    const leaves = leafIdsOf(restored.paneTree);
    expect(new Set(leaves).size).toBe(2);
    expect(leaves).toContain(restored.activeLeafId);
    // active leaf was the second one, which carried /b
    expect(restored.cwd).toBe("/b");
  });

  it("allocates fresh, unique, monotonic ids across all tabs and leaves", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/a" },
        { kind: "leaf", id: 12, cwd: "/b" },
      ],
    };
    const serialized = serializeTabs([
      term({ id: 1, paneTree: tree, activeLeafId: 11 }),
      term({ id: 2 }),
    ]);
    const restored = hydrateTabs(serialized, "s1", counter(100));

    const ids: number[] = [];
    for (const t of restored) {
      ids.push(t.id);
      if (t.kind === "terminal") ids.push(...leafIdsOf(t.paneTree));
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(100);
  });

  it("returns empty for corrupted input without throwing", () => {
    expect(hydrateTabs([] as SerializedTab[], "s1", counter())).toEqual([]);
    expect(
      hydrateTabs(null as unknown as SerializedTab[], "s1", counter()),
    ).toEqual([]);
  });

  it("hydrates editor/preview/markdown as cold with derived titles", () => {
    const serialized: SerializedTab[] = [
      { kind: "editor", path: "/a/foo.ts" },
      { kind: "preview", url: "http://localhost:5173/x" },
      { kind: "markdown", path: "/a/README.md" },
    ];
    const out = hydrateTabs(serialized, "s1", counter());
    expect(out.every((t) => t.cold === true)).toBe(true);
    expect(out.map((t) => t.title)).toEqual([
      "foo.ts",
      "localhost:5173",
      "README.md",
    ]);
  });
});

describe("restart restoration", () => {
  it("restores layout and cwd without any agent command to rerun", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, cwd: "/work/terax" },
        { kind: "leaf", id: 12, cwd: "/work/terax/docs" },
      ],
    };
    const saved = serializeTabs([
      term({ id: 1, paneTree: tree, activeLeafId: 12, customTitle: "agent" }),
    ]);

    // What a terminal tab remembers is a directory, never the command a user
    // or an agent typed there.
    expect(JSON.stringify(saved)).not.toMatch(/command|agentCommand|pty|pid/);

    const [restored] = hydrateTabs(saved, "space-a", counter());
    expect(restored.kind).toBe("terminal");
    expect(restored.cold).toBe(true);
    if (restored.kind !== "terminal") return;
    expect(restored.cwd).toBe("/work/terax/docs");
    expect(restored.paneTree).toEqual({
      kind: "split",
      id: expect.any(Number),
      dir: "row",
      children: [
        { kind: "leaf", id: expect.any(Number), cwd: "/work/terax" },
        { kind: "leaf", id: expect.any(Number), cwd: "/work/terax/docs" },
      ],
    });
  });

  it("restores file locations whether or not the files still exist", () => {
    const saved: SerializedTab[] = [
      { kind: "editor", path: "/work/terax/changed.ts" },
      { kind: "markdown", path: "/work/terax/removed.md" },
    ];

    const restored = hydrateTabs(saved, "space-a", counter());
    expect(restored.map((tab) => tab.kind)).toEqual(["editor", "markdown"]);
    expect(restored.every((tab) => tab.cold === true)).toBe(true);
    expect(
      restored.map((tab) =>
        tab.kind === "editor" || tab.kind === "markdown" ? tab.path : null,
      ),
    ).toEqual(["/work/terax/changed.ts", "/work/terax/removed.md"]);
  });

  it("keeps two Spaces on one checkout restoring as separate saved layouts", () => {
    const spaces: SpaceMeta[] = [
      {
        id: "a",
        name: "Terax",
        root: "/work/terax",
        env: { kind: "local" },
        accountIsolation: "default",
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "b",
        name: "Terax review",
        root: "/work/terax",
        env: { kind: "local" },
        accountIsolation: "default",
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const savedBySpace = new Map([
      ["a", serializeTabs([term({ id: 1, spaceId: "a" })])],
      [
        "b",
        serializeTabs([
          {
            kind: "editor",
            spaceId: "b",
            id: 3,
            title: "notes.md",
            path: "/work/terax/notes.md",
            dirty: false,
            preview: false,
          } as Tab,
        ]),
      ],
    ]);

    const restored = [...savedBySpace].flatMap(([spaceId, saved]) =>
      hydrateTabs(saved, spaceId, counter()),
    );
    expect(restored.map((tab) => [tab.spaceId, tab.kind])).toEqual([
      ["a", "terminal"],
      ["b", "editor"],
    ]);
    expect(sharedRoots(spaces)[0].spaceIds).toEqual(["a", "b"]);
  });
});

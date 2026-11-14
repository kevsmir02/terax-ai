import type { WorkspaceEnv } from "@/modules/workspace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyCrossSpaceTabMove,
  duplicateSpaceMeta,
  duplicateSpaceOrganization,
  evaluateIsolationToggleGuard,
  normalizeAccountIsolation,
  normalizeSpaceMeta,
} from "./isolation";
import { loadAll, type SpaceMeta, saveSpacesList } from "./store";

const { mockEntries, mockSet, mockDelete } = vi.hoisted(() => ({
  mockEntries: vi.fn<() => Promise<[string, unknown][]>>(),
  mockSet: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  mockDelete: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = mockEntries;
    set = mockSet;
    delete = mockDelete;
  },
}));

const ENV: WorkspaceEnv = { kind: "local" };

describe("Space Account isolation metadata & duplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEntries.mockResolvedValue([]);
    mockSet.mockResolvedValue();
    mockDelete.mockResolvedValue();
  });

  it("defaults missing or invalid accountIsolation values to 'default'", () => {
    expect(normalizeAccountIsolation(undefined)).toBe("default");
    expect(normalizeAccountIsolation(null)).toBe("default");
    expect(normalizeAccountIsolation("")).toBe("default");
    expect(normalizeAccountIsolation("shared")).toBe("default");
    expect(normalizeAccountIsolation("default")).toBe("default");
    expect(normalizeAccountIsolation("isolated")).toBe("isolated");
  });

  it("normalizes SpaceMeta and strips non-schema, runtime, or secret properties", () => {
    const raw = {
      id: "sp-1",
      name: "Work",
      root: "/tmp/work",
      env: ENV,
      color: 2,
      createdAt: 100,
      updatedAt: 200,
      hasRetainedProfiles: true,
      cleanupError: "stale",
      token: "sk-secret",
      credentials: { claude: "secret" },
      isolatedProfileDir: "/secret/dir",
    };

    const normalized = normalizeSpaceMeta(raw);

    expect(normalized).toEqual({
      id: "sp-1",
      name: "Work",
      root: "/tmp/work",
      env: ENV,
      color: 2,
      createdAt: 100,
      updatedAt: 200,
      accountIsolation: "default",
    });
    expect("token" in normalized).toBe(false);
    expect("credentials" in normalized).toBe(false);
    expect("hasRetainedProfiles" in normalized).toBe(false);
    expect("cleanupError" in normalized).toBe(false);
    expect("isolatedProfileDir" in normalized).toBe(false);
  });

  it("migrates legacy stored spaces lacking accountIsolation on loadAll and strips extra fields on save", async () => {
    mockEntries.mockResolvedValueOnce([
      [
        "spaces",
        [
          {
            id: "sp-legacy",
            name: "Legacy",
            root: "/tmp/legacy",
            env: ENV,
            createdAt: 1,
            updatedAt: 2,
            apiKey: "should-not-survive",
          },
          {
            id: "sp-iso",
            name: "Isolated",
            root: "/tmp/iso",
            env: ENV,
            createdAt: 3,
            updatedAt: 4,
            accountIsolation: "isolated",
          },
        ],
      ],
      ["activeId", "sp-iso"],
    ]);

    const loaded = await loadAll();

    expect(loaded.spaces).toEqual([
      {
        id: "sp-legacy",
        name: "Legacy",
        root: "/tmp/legacy",
        env: ENV,
        createdAt: 1,
        updatedAt: 2,
        accountIsolation: "default",
      },
      {
        id: "sp-iso",
        name: "Isolated",
        root: "/tmp/iso",
        env: ENV,
        createdAt: 3,
        updatedAt: 4,
        accountIsolation: "isolated",
      },
    ]);

    const polluted = {
      ...loaded.spaces[1],
      hasRetainedProfiles: true,
      oauthToken: "secret-token",
    } as SpaceMeta;
    await saveSpacesList([polluted]);

    expect(mockSet).toHaveBeenCalledWith("spaces", [
      {
        id: "sp-iso",
        name: "Isolated",
        root: "/tmp/iso",
        env: ENV,
        createdAt: 3,
        updatedAt: 4,
        accountIsolation: "isolated",
      },
    ]);
  });

  it("duplicates organizational metadata and layout only, forcing default isolation and stripping bindings", () => {
    const source: SpaceMeta & Record<string, unknown> = {
      id: "sp-origin",
      name: "Client A",
      root: "/tmp/client-a",
      env: ENV,
      color: 4,
      accountIsolation: "isolated",
      createdAt: 1000,
      updatedAt: 2000,
      isolatedProfileDir:
        "/home/user/.local/share/codr/space-profiles/sp-origin",
      agentCredentials: { claude: "secret" },
    };

    const duplicatedMeta = duplicateSpaceMeta(source, {
      id: "sp-copy",
      name: "Client A Copy",
      now: 5000,
    });

    expect(duplicatedMeta).toEqual({
      id: "sp-copy",
      name: "Client A Copy",
      root: "/tmp/client-a",
      env: ENV,
      color: 4,
      accountIsolation: "default",
      createdAt: 5000,
      updatedAt: 5000,
    });
    expect("isolatedProfileDir" in duplicatedMeta).toBe(false);
    expect("agentCredentials" in duplicatedMeta).toBe(false);

    const orgCopy = duplicateSpaceOrganization(
      source,
      {
        activeTabIndex: 1,
        tabs: [
          {
            kind: "terminal",
            blocks: true,
            customTitle: "Server",
            tree: {
              kind: "split",
              dir: "row",
              children: [
                { kind: "leaf", cwd: "/tmp/client-a/api", active: true },
                { kind: "leaf", cwd: "/tmp/client-a/web" },
              ],
            },
          },
          { kind: "editor", path: "/tmp/client-a/README.md" },
        ],
      },
      { id: "sp-copy-2", now: 6000 },
    );

    expect(orgCopy.meta.id).toBe("sp-copy-2");
    expect(orgCopy.meta.name).toBe("Client A");
    expect(orgCopy.meta.accountIsolation).toBe("default");
    expect(orgCopy.state).toEqual({
      activeTabIndex: 1,
      tabs: [
        {
          kind: "terminal",
          blocks: true,
          customTitle: "Server",
          tree: {
            kind: "split",
            dir: "row",
            children: [
              { kind: "leaf", cwd: "/tmp/client-a/api", active: true },
              { kind: "leaf", cwd: "/tmp/client-a/web" },
            ],
          },
        },
        { kind: "editor", path: "/tmp/client-a/README.md" },
      ],
    });
  });

  it("reports whether toggling isolation requires confirmation for active terminals or dirty files", () => {
    const warm = evaluateIsolationToggleGuard(
      "sp-a",
      [
        {
          id: 10,
          spaceId: "sp-a",
          kind: "terminal",
          cold: false,
          leafIds: [1, 2],
        },
        {
          id: 11,
          spaceId: "sp-b",
          kind: "terminal",
          cold: false,
          leafIds: [3],
        },
      ],
      () => false,
    );
    expect(warm).toEqual({
      allowed: true,
      requiresConfirmation: true,
      activeTerminalTabIds: [10],
      activeLeafIds: [1, 2],
      dirtyTabIds: [],
    });

    const liveCold = evaluateIsolationToggleGuard(
      "sp-a",
      [{ id: 12, spaceId: "sp-a", kind: "terminal", cold: true, leafIds: [4] }],
      (leafId) => leafId === 4,
    );
    expect(liveCold).toEqual({
      allowed: true,
      requiresConfirmation: true,
      activeTerminalTabIds: [12],
      activeLeafIds: [4],
      dirtyTabIds: [],
    });

    const dirtyOnly = evaluateIsolationToggleGuard(
      "sp-a",
      [
        { id: 13, spaceId: "sp-a", kind: "editor", leafIds: [] },
        { id: 14, spaceId: "sp-a", kind: "git-diff", leafIds: [] },
      ],
      () => false,
      (tabId) => tabId === 13,
    );
    expect(dirtyOnly).toEqual({
      allowed: true,
      requiresConfirmation: true,
      activeTerminalTabIds: [],
      activeLeafIds: [],
      dirtyTabIds: [13],
    });

    const noConfirm = evaluateIsolationToggleGuard(
      "sp-a",
      [
        { id: 15, spaceId: "sp-a", kind: "editor", leafIds: [] },
        { id: 16, spaceId: "sp-a", kind: "terminal", cold: true, leafIds: [5] },
        {
          id: 17,
          spaceId: "sp-b",
          kind: "terminal",
          cold: false,
          leafIds: [6],
        },
      ],
      (leafId) => leafId === 6,
    );
    expect(noConfirm).toEqual({
      allowed: true,
      requiresConfirmation: false,
      activeTerminalTabIds: [],
      activeLeafIds: [],
      dirtyTabIds: [],
    });
  });

  it("classifies cross-Space tab moves between live transfers and close-and-recreate prompts", () => {
    for (const kind of [
      "editor",
      "markdown",
      "preview",
      "git-diff",
      "git-history",
      "git-commit-file",
    ]) {
      expect(classifyCrossSpaceTabMove(kind, "default", "isolated")).toEqual({
        kind: "live",
      });
      expect(classifyCrossSpaceTabMove(kind, "isolated", "default")).toEqual({
        kind: "live",
      });
      expect(classifyCrossSpaceTabMove(kind, "isolated", "isolated")).toEqual({
        kind: "live",
      });
      expect(classifyCrossSpaceTabMove(kind, "default", "default")).toEqual({
        kind: "live",
      });
    }

    expect(classifyCrossSpaceTabMove("terminal", "default", "default")).toEqual(
      {
        kind: "live",
      },
    );
    expect(classifyCrossSpaceTabMove("terminal", undefined, "default")).toEqual(
      {
        kind: "live",
      },
    );

    expect(
      classifyCrossSpaceTabMove("terminal", "default", "isolated"),
    ).toEqual({
      kind: "confirm-recreate",
      sourceIsolation: "default",
      targetIsolation: "isolated",
    });
    expect(
      classifyCrossSpaceTabMove("terminal", "isolated", "default"),
    ).toEqual({
      kind: "confirm-recreate",
      sourceIsolation: "isolated",
      targetIsolation: "default",
    });
    expect(
      classifyCrossSpaceTabMove("terminal", "isolated", "isolated"),
    ).toEqual({
      kind: "confirm-recreate",
      sourceIsolation: "isolated",
      targetIsolation: "isolated",
    });
  });
});

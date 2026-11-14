// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPACE_ID, type Tab } from "@/modules/tabs/lib/useTabs";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
import {
  resetIsolationSyncForTests,
  waitForSpaceIsolationSync,
} from "./isolationSync";
import type { LoadedSpaces, SpaceMeta } from "./store";
import { useSpaces } from "./useSpaces";
import { useSpacesBoot } from "./useSpacesBoot";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const {
  mockInvoke,
  mockLoadAll,
  mockSaveSpacesList,
  mockSaveActiveId,
  mockDeleteSpaceData,
  mockPrefsInit,
  mockWorkspaceAuthorize,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  mockLoadAll: vi.fn<() => Promise<LoadedSpaces>>(),
  mockSaveSpacesList: vi.fn<(spaces: SpaceMeta[]) => Promise<void>>(),
  mockSaveActiveId: vi.fn<(id: string | null) => Promise<void>>(),
  mockDeleteSpaceData: vi.fn<(id: string) => Promise<void>>(),
  mockPrefsInit: vi.fn<() => Promise<void>>(),
  mockWorkspaceAuthorize: vi.fn<(path: string) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/modules/workspace/native", () => ({
  native: {
    workspaceAuthorize: mockWorkspaceAuthorize,
  },
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      defaultWorkspaceEnv: "local",
      init: mockPrefsInit,
    }),
  },
}));

vi.mock("./store", async () => {
  const iso = await import("./isolation");
  return {
    newSpaceId: iso.newSpaceId,
    loadAll: mockLoadAll,
    saveSpacesList: mockSaveSpacesList,
    saveActiveId: mockSaveActiveId,
    deleteSpaceData: mockDeleteSpaceData,
  };
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function BootHarness({
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
}: {
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  setActiveSpaceForNewTabs: (id: string) => void;
}) {
  useSpacesBoot({
    ready: true,
    launchCwd: "/work/app",
    home: "/home/dev",
    allocId: (() => {
      let n = 10;
      return () => n++;
    })(),
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv: async () => "/home/dev",
  });
  return null;
}

describe("Space isolation IPC sync & boot ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetIsolationSyncForTests();
    useSpaces.setState({
      spaces: [],
      activeId: null,
      hydrated: false,
      initialActiveIndex: {},
      runtimeById: {},
    });
    mockPrefsInit.mockResolvedValue();
    mockSaveSpacesList.mockResolvedValue();
    mockSaveActiveId.mockResolvedValue();
    mockDeleteSpaceData.mockResolvedValue();
    mockWorkspaceAuthorize.mockResolvedValue();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  it("synchronizes first-boot Default Space with Rust before markBooted", async () => {
    mockLoadAll.mockResolvedValueOnce({
      spaces: [],
      activeId: null,
      states: new Map(),
    });
    const order: string[] = [];
    mockInvoke.mockImplementation(async (cmd) => {
      order.push(`invoke:${cmd}`);
      if (cmd === "space_isolation_sync") {
        return [
          {
            id: DEFAULT_SPACE_ID,
            accountIsolation: "default",
            hasRetainedProfiles: false,
          },
        ];
      }
      return undefined;
    });

    const replaceTabs = vi.fn(() => order.push("replaceTabs"));
    const markBooted = vi.fn(() => order.push("markBooted"));
    const setActiveSpaceForNewTabs = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <BootHarness
          replaceTabs={replaceTabs}
          markBooted={markBooted}
          setActiveSpaceForNewTabs={setActiveSpaceForNewTabs}
        />,
      );
      await flushPromises();
      await flushPromises();
    });

    expect(order).toEqual(["invoke:space_isolation_sync", "markBooted"]);
    expect(mockInvoke).toHaveBeenCalledWith("space_isolation_sync", {
      spaces: [{ id: DEFAULT_SPACE_ID, accountIsolation: "default" }],
    });
    expect(useSpaces.getState().spaces[0]?.accountIsolation).toBe("default");
    expect(useSpaces.getState().runtimeById[DEFAULT_SPACE_ID]).toEqual({
      hasRetainedProfiles: false,
    });
  });

  it("synchronizes restored spaces before replaceTabs and reconciles authoritative Rust isolation + runtime flags", async () => {
    const staleSpaces: SpaceMeta[] = [
      {
        id: "sp-a",
        name: "Work",
        root: "/work/a",
        env: LOCAL_WORKSPACE,
        accountIsolation: "default",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "sp-b",
        name: "Personal",
        root: "/work/b",
        env: LOCAL_WORKSPACE,
        accountIsolation: "default",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    mockLoadAll.mockResolvedValueOnce({
      spaces: staleSpaces,
      activeId: "sp-a",
      states: new Map(),
    });

    const order: string[] = [];
    mockInvoke.mockImplementation(async (cmd) => {
      order.push(`invoke:${cmd}`);
      if (cmd === "space_isolation_sync") {
        return [
          {
            id: "sp-a",
            accountIsolation: "isolated",
            hasRetainedProfiles: true,
          },
          {
            id: "sp-b",
            accountIsolation: "default",
            hasRetainedProfiles: false,
            cleanupError: "pending sweep",
          },
        ];
      }
      return undefined;
    });

    const replaceTabs = vi.fn(() => order.push("replaceTabs"));
    const markBooted = vi.fn(() => order.push("markBooted"));

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <BootHarness
          replaceTabs={replaceTabs}
          markBooted={markBooted}
          setActiveSpaceForNewTabs={vi.fn()}
        />,
      );
      await flushPromises();
      await flushPromises();
    });

    expect(order).toEqual([
      "invoke:space_isolation_sync",
      "replaceTabs",
      "markBooted",
    ]);
    const state = useSpaces.getState();
    expect(state.spaces.find((s) => s.id === "sp-a")?.accountIsolation).toBe(
      "isolated",
    );
    expect(state.runtimeById).toEqual({
      "sp-a": { hasRetainedProfiles: true },
      "sp-b": { hasRetainedProfiles: false, cleanupError: "pending sweep" },
    });
    expect(mockSaveSpacesList).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "sp-a", accountIsolation: "isolated" }),
      ]),
    );
  });

  it("serializes register, mode toggle, and remove IPC mutations and lets openPty await in-flight sync", async () => {
    let resolveRegister: ((v: unknown) => void) | undefined;
    mockInvoke.mockImplementation((cmd) => {
      if (cmd === "space_isolation_register") {
        return new Promise((resolve) => {
          resolveRegister = resolve;
        });
      }
      if (cmd === "space_isolation_set_mode") {
        return Promise.resolve({
          id: "sp-new",
          accountIsolation: "isolated",
          hasRetainedProfiles: true,
        });
      }
      return Promise.resolve(undefined);
    });

    const created = useSpaces.getState().create({
      id: "sp-new",
      name: "New",
      root: "/work/new",
      env: LOCAL_WORKSPACE,
    });
    expect(created.accountIsolation).toBe("default");

    let waiterResolved = false;
    const waiter = waitForSpaceIsolationSync("sp-new").then(() => {
      waiterResolved = true;
    });
    await flushPromises();
    expect(waiterResolved).toBe(false);

    resolveRegister?.({
      id: "sp-new",
      accountIsolation: "default",
      hasRetainedProfiles: false,
    });
    await waiter;
    expect(waiterResolved).toBe(true);

    await useSpaces.getState().setAccountIsolation("sp-new", "isolated");
    expect(mockInvoke).toHaveBeenCalledWith("space_isolation_set_mode", {
      spaceId: "sp-new",
      accountIsolation: "isolated",
    });
    expect(
      useSpaces.getState().spaces.find((s) => s.id === "sp-new")
        ?.accountIsolation,
    ).toBe("isolated");
    expect(useSpaces.getState().runtimeById["sp-new"]).toEqual({
      hasRetainedProfiles: true,
    });
    const saveCalls = mockSaveSpacesList.mock.calls;
    const lastSaved = saveCalls[saveCalls.length - 1]?.[0] ?? [];
    expect("hasRetainedProfiles" in (lastSaved[0] ?? {})).toBe(false);

    useSpaces.getState().remove("sp-new");
    await waitForSpaceIsolationSync("sp-new");
    expect(mockInvoke).toHaveBeenCalledWith("space_isolation_remove", {
      spaceId: "sp-new",
    });
  });

  it("keeps Spaces with identical name and root bound strictly by id and surfaces sync failures without deadlocking boot", async () => {
    const spaces: SpaceMeta[] = [
      {
        id: "sp-one",
        name: "Same Name",
        root: "/work/shared",
        env: LOCAL_WORKSPACE,
        accountIsolation: "default",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "sp-two",
        name: "Same Name",
        root: "/work/shared",
        env: LOCAL_WORKSPACE,
        accountIsolation: "default",
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    mockLoadAll.mockResolvedValueOnce({
      spaces,
      activeId: "sp-one",
      states: new Map(),
    });
    mockInvoke.mockRejectedValueOnce(new Error("manifest corrupt"));

    const replaceTabs = vi.fn();
    const markBooted = vi.fn();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await act(async () => {
        root?.render(
          <BootHarness
            replaceTabs={replaceTabs}
            markBooted={markBooted}
            setActiveSpaceForNewTabs={vi.fn()}
          />,
        );
        await flushPromises();
        await flushPromises();
      });
    } finally {
      errSpy.mockRestore();
    }

    expect(markBooted).toHaveBeenCalledTimes(1);
    expect(useSpaces.getState().runtimeById).toEqual({
      "sp-one": {
        hasRetainedProfiles: false,
        cleanupError: "manifest corrupt",
      },
      "sp-two": {
        hasRetainedProfiles: false,
        cleanupError: "manifest corrupt",
      },
    });

    const { reconcileSpacesWithIsolation } = await import("./isolationSync");
    const reconciled = reconcileSpacesWithIsolation(spaces, [
      { id: "sp-one", accountIsolation: "default", hasRetainedProfiles: false },
      { id: "sp-two", accountIsolation: "isolated", hasRetainedProfiles: true },
    ]);
    expect(reconciled.spaces.map((s) => [s.id, s.accountIsolation])).toEqual([
      ["sp-one", "default"],
      ["sp-two", "isolated"],
    ]);
    expect(reconciled.runtimeById).toEqual({
      "sp-one": { hasRetainedProfiles: false },
      "sp-two": { hasRetainedProfiles: true },
    });
  });
});

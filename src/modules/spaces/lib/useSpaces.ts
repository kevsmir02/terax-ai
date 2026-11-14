import { create } from "zustand";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import {
  registerSpaceIsolation,
  removeSpaceIsolation,
  setSpaceIsolationMode,
  toRuntimeStatus,
} from "./isolationSync";
import {
  type AccountIsolationMode,
  deleteSpaceData,
  newSpaceId,
  type SpaceMeta,
  type SpaceRuntimeStatus,
  saveActiveId,
  saveSpacesList,
} from "./store";

type CreateInput = {
  id?: string;
  name: string;
  root: string | null;
  env?: WorkspaceEnv;
};

type State = {
  spaces: SpaceMeta[];
  activeId: string | null;
  hydrated: boolean;
  // Per-space active tab index loaded from disk, so persistence preserves it
  // for spaces the user never visits this session.
  initialActiveIndex: Record<string, number>;
  // Derived non-secret runtime isolation status synchronized from Rust.
  runtimeById: Record<string, SpaceRuntimeStatus>;
  hydrate: (
    spaces: SpaceMeta[],
    activeId: string | null,
    initialActiveIndex?: Record<string, number>,
    runtimeById?: Record<string, SpaceRuntimeStatus>,
  ) => void;
  create: (input: CreateInput) => SpaceMeta;
  rename: (id: string, name: string) => void;
  setEnv: (id: string, env: WorkspaceEnv) => void;
  setColor: (id: string, color: number | undefined) => void;
  setAccountIsolation: (id: string, mode: AccountIsolationMode) => Promise<void>;
  setRuntimeStatus: (
    id: string,
    status: SpaceRuntimeStatus | undefined,
  ) => void;
  reorder: (orderedIds: string[]) => void;
  remove: (id: string) => string | null;
  setActive: (id: string) => void;
};

export const useSpaces = create<State>((set, get) => ({
  spaces: [],
  activeId: null,
  hydrated: false,
  initialActiveIndex: {},
  runtimeById: {},

  hydrate: (
    spaces,
    activeId,
    initialActiveIndex = {},
    runtimeById = {},
  ) => {
    set({
      spaces,
      activeId,
      initialActiveIndex,
      runtimeById,
      hydrated: true,
    });
  },

  create: (input) => {
    const now = Date.now();
    const meta: SpaceMeta = {
      id: input.id ?? newSpaceId(),
      name: input.name,
      root: input.root,
      env:
        input.env ??
        parseWorkspaceScopeKey(
          usePreferencesStore.getState().defaultWorkspaceEnv,
        ),
      accountIsolation: "default",
      createdAt: now,
      updatedAt: now,
    };
    const spaces = [...get().spaces, meta];
    const runtimeById = {
      ...get().runtimeById,
      [meta.id]: { hasRetainedProfiles: false },
    };
    set({ spaces, runtimeById });
    void saveSpacesList(spaces);
    void registerSpaceIsolation(meta.id, meta.accountIsolation)
      .then((status) => {
        get().setRuntimeStatus(meta.id, toRuntimeStatus(status));
      })
      .catch((error) => {
        get().setRuntimeStatus(meta.id, {
          hasRetainedProfiles: false,
          cleanupError: error instanceof Error ? error.message : String(error),
        });
      });
    return meta;
  },

  rename: (id, name) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, name, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    void saveSpacesList(spaces);
  },

  setEnv: (id, env) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, env, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    void saveSpacesList(spaces);
  },

  setColor: (id, color) => {
    const spaces = get().spaces.map((s) =>
      s.id === id ? { ...s, color, updatedAt: Date.now() } : s,
    );
    set({ spaces });
    void saveSpacesList(spaces);
  },

  setAccountIsolation: async (id, mode) => {
    const status = await setSpaceIsolationMode(id, mode);
    const spaces = get().spaces.map((s) =>
      s.id === id
        ? { ...s, accountIsolation: status.accountIsolation, updatedAt: Date.now() }
        : s,
    );
    const runtimeById = {
      ...get().runtimeById,
      [id]: toRuntimeStatus(status),
    };
    set({ spaces, runtimeById });
    await saveSpacesList(spaces);
  },

  setRuntimeStatus: (id, status) => {
    const next = { ...get().runtimeById };
    if (status === undefined) {
      delete next[id];
    } else {
      next[id] = status;
    }
    set({ runtimeById: next });
  },

  reorder: (orderedIds) => {
    const byId = new Map(get().spaces.map((s) => [s.id, s]));
    const next: SpaceMeta[] = [];
    for (const id of orderedIds) {
      const s = byId.get(id);
      if (s) next.push(s);
    }
    for (const s of get().spaces) {
      if (!next.includes(s)) next.push(s);
    }
    if (next.length !== get().spaces.length) return;
    set({ spaces: next });
    void saveSpacesList(next);
  },

  remove: (id) => {
    const prev = get();
    const spaces = prev.spaces.filter((s) => s.id !== id);
    const runtimeById = { ...prev.runtimeById };
    delete runtimeById[id];
    let activeId = prev.activeId;
    if (activeId === id) activeId = spaces[0]?.id ?? null;
    set({ spaces, activeId, runtimeById });
    void saveSpacesList(spaces);
    void deleteSpaceData(id);
    if (activeId !== prev.activeId) void saveActiveId(activeId);
    void removeSpaceIsolation(id).catch(() => {});
    return activeId;
  },

  setActive: (id) => {
    if (get().activeId === id) return;
    set({ activeId: id });
    void saveActiveId(id);
  },
}));

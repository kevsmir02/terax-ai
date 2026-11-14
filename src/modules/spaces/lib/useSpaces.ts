import { usePreferencesStore } from "@/modules/settings/preferences";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { create } from "zustand";
import {
  clearSpacePrivateProfiles,
  registerSpaceIsolation,
  removeSpaceIsolation,
  retrySpaceIsolationCleanup,
  type SpaceIsolationSyncResult,
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
  accountIsolation?: AccountIsolationMode;
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
  orphanedCleanups: Record<string, SpaceRuntimeStatus>;
  hydrate: (
    spaces: SpaceMeta[],
    activeId: string | null,
    initialActiveIndex?: Record<string, number>,
    runtimeById?: Record<string, SpaceRuntimeStatus>,
    orphanedCleanups?: Record<string, SpaceRuntimeStatus>,
  ) => void;
  create: (input: CreateInput) => SpaceMeta;
  rename: (id: string, name: string) => void;
  setEnv: (id: string, env: WorkspaceEnv) => void;
  setColor: (id: string, color: number | undefined) => void;
  setAccountIsolation: (
    id: string,
    mode: AccountIsolationMode,
  ) => Promise<void>;
  clearPrivateAccounts: (
    id: string,
    paneIds?: number[],
  ) => Promise<SpaceIsolationSyncResult>;
  retryCleanup: (id: string) => Promise<SpaceIsolationSyncResult>;
  setRuntimeStatus: (
    id: string,
    status: SpaceRuntimeStatus | undefined,
  ) => void;
  reorder: (orderedIds: string[]) => void;
  remove: (id: string, paneIds?: number[]) => string | null;
  setActive: (id: string) => void;
};

export const useSpaces = create<State>((set, get) => ({
  spaces: [],
  activeId: null,
  hydrated: false,
  initialActiveIndex: {},
  runtimeById: {},
  orphanedCleanups: {},

  hydrate: (
    spaces,
    activeId,
    initialActiveIndex = {},
    runtimeById = {},
    orphanedCleanups = {},
  ) => {
    set({
      spaces,
      activeId,
      initialActiveIndex,
      runtimeById,
      orphanedCleanups,
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
      accountIsolation: input.accountIsolation ?? "default",
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
        ? {
            ...s,
            accountIsolation: status.accountIsolation,
            updatedAt: Date.now(),
          }
        : s,
    );
    const runtimeById = {
      ...get().runtimeById,
      [id]: toRuntimeStatus(status),
    };
    set({ spaces, runtimeById });
    await saveSpacesList(spaces);
  },

  clearPrivateAccounts: async (id, paneIds = []) => {
    const status = await clearSpacePrivateProfiles(id, paneIds);
    const spaces = get().spaces.map((s) =>
      s.id === id && s.accountIsolation !== status.accountIsolation
        ? {
            ...s,
            accountIsolation: status.accountIsolation,
            updatedAt: Date.now(),
          }
        : s,
    );
    const runtimeById = {
      ...get().runtimeById,
      [id]: toRuntimeStatus(status),
    };
    set({ spaces, runtimeById });
    return status;
  },

  retryCleanup: async (id) => {
    const status = await retrySpaceIsolationCleanup(id);
    const nextStatus = toRuntimeStatus(status);
    const cur = get();
    const isKnownSpace = cur.spaces.some((s) => s.id === id);
    const runtimeById = isKnownSpace
      ? { ...cur.runtimeById, [id]: nextStatus }
      : cur.runtimeById;
    const orphanedCleanups = { ...cur.orphanedCleanups };
    if (
      !isKnownSpace &&
      (nextStatus.cleanupError !== undefined || nextStatus.hasRetainedProfiles)
    ) {
      orphanedCleanups[id] = nextStatus;
    } else {
      delete orphanedCleanups[id];
    }
    set({ runtimeById, orphanedCleanups });
    return status;
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

  remove: (id, paneIds) => {
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
    void removeSpaceIsolation(id, paneIds)
      .then((status) => {
        if (
          status &&
          (status.cleanupError !== undefined || status.hasRetainedProfiles)
        ) {
          set((cur) => ({
            orphanedCleanups: {
              ...cur.orphanedCleanups,
              [id]: toRuntimeStatus(status),
            },
          }));
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        set((cur) => ({
          orphanedCleanups: {
            ...cur.orphanedCleanups,
            [id]: {
              hasRetainedProfiles: true,
              cleanupError: message,
            },
          },
        }));
      });
    return activeId;
  },

  setActive: (id) => {
    if (get().activeId === id) return;
    set({ activeId: id });
    void saveActiveId(id);
  },
}));

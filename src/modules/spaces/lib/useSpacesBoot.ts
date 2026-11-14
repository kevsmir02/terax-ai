import { native } from "@/modules/workspace/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import { isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { useEffect, useRef } from "react";
import { activeSpaceEnv } from "./activeSpace";
import {
  reconcileSpacesWithIsolation,
  syncSpaceIsolation,
} from "./isolationSync";
import { planSpaceRestore } from "./restore";
import {
  loadAll,
  type SpaceMeta,
  type SpaceRuntimeStatus,
  saveActiveId,
  saveSpacesList,
} from "./store";
import { useSpaces } from "./useSpaces";

type Params = {
  ready: boolean;
  launchCwd: string | null;
  home: string | null;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  setActiveSpaceForNewTabs: (id: string) => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
};

function uniqueCwds(tabs: Tab[]): string[] {
  const set = new Set<string>();
  const walk = (n: PaneNode) => {
    if (isLeaf(n)) {
      if (n.cwd) set.add(n.cwd);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const t of tabs) if (t.kind === "terminal") walk(t.paneTree);
  return [...set];
}

async function syncSpacesFailSafe(spaces: SpaceMeta[]): Promise<{
  spaces: SpaceMeta[];
  changed: boolean;
  runtimeById: Record<string, SpaceRuntimeStatus>;
}> {
  try {
    const records = await syncSpaceIsolation(spaces);
    return reconcileSpacesWithIsolation(spaces, records);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[terax] space isolation sync failed:", error);
    const runtimeById: Record<string, SpaceRuntimeStatus> = {};
    for (const space of spaces) {
      runtimeById[space.id] = {
        hasRetainedProfiles: false,
        cleanupError: message,
      };
    }
    return { spaces, changed: false, runtimeById };
  }
}

export function useSpacesBoot({
  ready,
  launchCwd,
  home,
  allocId,
  replaceTabs,
  markBooted,
  setActiveSpaceForNewTabs,
  adoptWorkspaceEnv,
}: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        const { spaces, activeId, states } = await loadAll();

        if (spaces.length === 0) {
          const root = launchCwd ?? home ?? null;
          // Hydrate prefs before reading the saved workspace env.
          await usePreferencesStore
            .getState()
            .init()
            .catch(() => {});
          const meta: SpaceMeta = {
            id: DEFAULT_SPACE_ID,
            name: "Default",
            root,
            env: parseWorkspaceScopeKey(
              usePreferencesStore.getState().defaultWorkspaceEnv,
            ),
            accountIsolation: "default",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          const {
            spaces: syncedSpaces,
            runtimeById,
          } = await syncSpacesFailSafe([meta]);
          await saveSpacesList(syncedSpaces);
          await saveActiveId(DEFAULT_SPACE_ID);
          setActiveSpaceForNewTabs(DEFAULT_SPACE_ID);
          useSpaces
            .getState()
            .hydrate(syncedSpaces, DEFAULT_SPACE_ID, undefined, runtimeById);
          return;
        }

        const {
          spaces: syncedSpaces,
          changed,
          runtimeById,
        } = await syncSpacesFailSafe(spaces);
        if (changed) {
          await saveSpacesList(syncedSpaces);
        }

        const active =
          activeId && syncedSpaces.some((s) => s.id === activeId)
            ? activeId
            : syncedSpaces[0].id;
        setActiveSpaceForNewTabs(active);

        // Apply the space's env+home before the fresh-tab fallback and spawns
        // below; env is set synchronously so cwd resolution picks WSL vs local.
        const env = activeSpaceEnv(syncedSpaces, active);
        const restoredHome = await adoptWorkspaceEnv(env);

        const plan = planSpaceRestore({
          spaces: syncedSpaces,
          states,
          activeId: active,
          env,
          restoredHome,
          launchCwd,
          home,
          allocId,
        });
        if (!plan) return;

        await Promise.allSettled(
          uniqueCwds(plan.tabs).map((cwd) => native.workspaceAuthorize(cwd)),
        );

        useSpaces
          .getState()
          .hydrate(
            syncedSpaces,
            plan.activeSpaceId,
            plan.initialActiveIndex,
            runtimeById,
          );
        replaceTabs(plan.tabs, plan.activeTabId);
      } catch (e) {
        console.error("[terax] spaces boot failed:", e);
      } finally {
        markBooted();
      }
    })();
  }, [
    ready,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  ]);
}

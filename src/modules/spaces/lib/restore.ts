import type { Tab } from "@/modules/tabs";
import type { WorkspaceEnv } from "@/modules/workspace";
import { freshTabCwd } from "./activeSpace";
import { freshTerminalTab, hydrateTabs } from "./serialize";
import type { SpaceMeta, SpaceState } from "./store";

export type RestoreInput = {
  spaces: readonly SpaceMeta[];
  states: ReadonlyMap<string, SpaceState>;
  activeId: string | null;
  /** Environment of the active Space, resolved by the caller (local/WSL home). */
  env: WorkspaceEnv;
  restoredHome: string | null;
  launchCwd: string | null;
  home: string | null;
  allocId: () => number;
};

export type RestorePlan = {
  tabs: Tab[];
  activeSpaceId: string;
  activeTabId: number;
  initialActiveIndex: Record<string, number>;
};

/**
 * Rebuilds saved organization: every Space's tabs from its own saved state,
 * with terminal and file tabs cold until the user opens them. Nothing here
 * spawns a shell or reads a file, so a restart cannot rerun an old command and
 * a file that changed or disappeared is simply opened at its saved location.
 */
export function planSpaceRestore(input: RestoreInput): RestorePlan | null {
  const { spaces, states, activeId, env, restoredHome, launchCwd, home } =
    input;
  if (spaces.length === 0) return null;

  const restored: Tab[] = [];
  for (const space of spaces) {
    const state = states.get(space.id);
    if (!state) continue;
    restored.push(...hydrateTabs(state.tabs, space.id, input.allocId));
  }

  const activeSpaceId =
    activeId && spaces.some((space) => space.id === activeId)
      ? activeId
      : spaces[0].id;

  if (!restored.some((tab) => tab.spaceId === activeSpaceId)) {
    restored.push(
      freshTerminalTab(
        activeSpaceId,
        freshTabCwd(env, restoredHome, launchCwd, home),
        input.allocId,
      ),
    );
  }

  const initialActiveIndex: Record<string, number> = {};
  for (const [id, state] of states) {
    initialActiveIndex[id] = state.activeTabIndex;
  }

  const inActive = restored.filter((tab) => tab.spaceId === activeSpaceId);
  const index = states.get(activeSpaceId)?.activeTabIndex ?? 0;
  const activeTab = inActive[index] ?? inActive[0] ?? restored[0];

  return {
    tabs: restored,
    activeSpaceId,
    activeTabId: activeTab.id,
    initialActiveIndex,
  };
}

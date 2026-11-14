import type { WorkspaceEnv } from "@/modules/workspace";
import type { SerializedTab } from "./serialize";
import type { SpaceMeta, SpaceState } from "./store";

export type AccountIsolationMode = "default" | "isolated";

export type SpaceRuntimeStatus = {
  hasRetainedProfiles: boolean;
  cleanupError?: string;
};

export type RawSpaceMeta = Omit<SpaceMeta, "accountIsolation"> & {
  accountIsolation?: unknown;
  [extra: string]: unknown;
};

export type DuplicateSpaceOptions = {
  id?: string;
  name?: string;
  now?: number;
};

type SerializedNode = Extract<SerializedTab, { kind: "terminal" }>["tree"];

export function newSpaceId(): string {
  return `sp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeAccountIsolation(
  value: unknown,
): AccountIsolationMode {
  return value === "isolated" ? "isolated" : "default";
}

function cloneWorkspaceEnv(env: WorkspaceEnv): WorkspaceEnv {
  return env.kind === "wsl"
    ? { kind: "wsl", distro: env.distro }
    : { kind: "local" };
}

export function normalizeSpaceMeta(raw: RawSpaceMeta): SpaceMeta {
  return {
    id: raw.id,
    name: raw.name,
    root: raw.root,
    env: cloneWorkspaceEnv(raw.env),
    ...(raw.color !== undefined && { color: raw.color }),
    accountIsolation: normalizeAccountIsolation(raw.accountIsolation),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function cloneSerializedNode(node: SerializedNode): SerializedNode {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      ...(node.cwd !== undefined && { cwd: node.cwd }),
      ...(node.active !== undefined && { active: node.active }),
    };
  }
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map(cloneSerializedNode),
  };
}

function cloneSerializedTab(tab: SerializedTab): SerializedTab {
  switch (tab.kind) {
    case "terminal":
      return {
        kind: "terminal",
        tree: cloneSerializedNode(tab.tree),
        ...(tab.blocks !== undefined && { blocks: tab.blocks }),
        ...(tab.customTitle !== undefined && { customTitle: tab.customTitle }),
      };
    case "editor":
      return { kind: "editor", path: tab.path };
    case "preview":
      return { kind: "preview", url: tab.url };
    case "markdown":
      return { kind: "markdown", path: tab.path };
  }
}

export function duplicateSpaceMeta(
  source: SpaceMeta,
  options: DuplicateSpaceOptions = {},
): SpaceMeta {
  const now = options.now ?? Date.now();
  return normalizeSpaceMeta({
    id: options.id ?? newSpaceId(),
    name: options.name ?? source.name,
    root: source.root,
    env: source.env,
    ...(source.color !== undefined && { color: source.color }),
    // Duplicating organizational layout must never copy isolated account bindings.
    accountIsolation: "default",
    createdAt: now,
    updatedAt: now,
  });
}

export function duplicateSpaceState(state: SpaceState): SpaceState {
  return {
    tabs: state.tabs.map(cloneSerializedTab),
    activeTabIndex: state.activeTabIndex,
  };
}

export function duplicateSpaceOrganization(
  source: SpaceMeta,
  state?: SpaceState,
  options: DuplicateSpaceOptions = {},
): { meta: SpaceMeta; state?: SpaceState } {
  return {
    meta: duplicateSpaceMeta(source, options),
    ...(state !== undefined && { state: duplicateSpaceState(state) }),
  };
}

export type IsolationToggleEvaluation = {
  allowed: true;
  requiresConfirmation: boolean;
  activeTerminalTabIds: number[];
  activeLeafIds: number[];
  dirtyTabIds: number[];
};

export type IsolationToggleGuard =
  | {
      allowed: true;
      requiresConfirmation?: boolean;
      activeTerminalTabIds?: number[];
      activeLeafIds?: number[];
      dirtyTabIds?: number[];
    }
  | { allowed: false; reason: string };

export type ToggleTerminalCandidate = {
  id?: number;
  spaceId: string;
  kind: string;
  cold?: boolean;
  dirty?: boolean;
  leafIds: number[];
};

export function evaluateIsolationToggleGuard(
  spaceId: string,
  tabs: readonly ToggleTerminalCandidate[],
  hasLivePty: (leafId: number) => boolean,
  isDirty: (tabId: number) => boolean = () => false,
): IsolationToggleEvaluation {
  const activeTerminalTabIds: number[] = [];
  const activeLeafIds: number[] = [];
  const dirtyTabIds: number[] = [];

  for (const tab of tabs) {
    if (tab.spaceId !== spaceId) continue;
    const dirty =
      tab.kind === "editor" &&
      (tab.dirty === true || (tab.id !== undefined && isDirty(tab.id)));
    if (dirty && tab.id !== undefined) {
      dirtyTabIds.push(tab.id);
    }
    if (tab.kind !== "terminal") continue;
    const isWarm = !tab.cold || tab.leafIds.some((id) => hasLivePty(id));
    if (!isWarm) continue;
    if (tab.id !== undefined) {
      activeTerminalTabIds.push(tab.id);
    }
    for (const leafId of tab.leafIds) {
      activeLeafIds.push(leafId);
    }
  }

  return {
    allowed: true,
    requiresConfirmation:
      activeTerminalTabIds.length > 0 ||
      activeLeafIds.length > 0 ||
      dirtyTabIds.length > 0,
    activeTerminalTabIds,
    activeLeafIds,
    dirtyTabIds,
  };
}

export type CrossSpaceTabMoveDecision =
  | { kind: "live" }
  | {
      kind: "confirm-recreate";
      sourceIsolation: AccountIsolationMode;
      targetIsolation: AccountIsolationMode;
    };

export function classifyCrossSpaceTabMove(
  tabKind: string,
  sourceIsolation: AccountIsolationMode | undefined,
  targetIsolation: AccountIsolationMode | undefined,
): CrossSpaceTabMoveDecision {
  const from = normalizeAccountIsolation(sourceIsolation);
  const to = normalizeAccountIsolation(targetIsolation);
  if (tabKind !== "terminal" || (from === "default" && to === "default")) {
    return { kind: "live" };
  }
  return {
    kind: "confirm-recreate",
    sourceIsolation: from,
    targetIsolation: to,
  };
}

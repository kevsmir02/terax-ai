import {
  type CloseHazardSnapshot,
  type CloseManyHazards,
  dirtyAfterSave,
  evaluateCloseHazards,
  hasNewCloseManyHazards,
} from "@/app/hooks/tabCloseGuards";
import {
  type AccountIsolationMode,
  classifyCrossSpaceTabMove,
  evaluateIsolationToggleGuard,
  type SpaceMeta,
} from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal/lib/panes";

export type SpaceIsolationToggleSnapshot = CloseHazardSnapshot & {
  activeLeafIds: number[];
};

export function spaceToggleHazardSnapshot(
  tabs: readonly Tab[],
  spaceId: string,
  hasLivePty: (leafId: number) => boolean,
  isDirty: (tabId: number) => boolean = (tabId) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    return tab?.kind === "editor" && tab.dirty;
  },
): SpaceIsolationToggleSnapshot {
  const candidates = tabs.map((tab) => ({
    id: tab.id,
    spaceId: tab.spaceId,
    kind: tab.kind,
    cold: tab.cold,
    dirty: tab.kind === "editor" && isDirty(tab.id),
    leafIds: tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
  }));
  const evaluation = evaluateIsolationToggleGuard(
    spaceId,
    candidates,
    hasLivePty,
    isDirty,
  );
  return {
    dirtyIds: evaluation.dirtyTabIds,
    leafIds: evaluation.activeLeafIds,
    activeLeafIds: evaluation.activeLeafIds,
  };
}

export type SpaceIsolationToggleTransaction = {
  spaceId: string;
  nextMode: AccountIsolationMode;
  activeLeafIds: number[];
  hazards: CloseManyHazards;
};

export type SpaceIsolationToggleResult =
  | { status: "idle" }
  | { status: "canceled" }
  | {
      status: "toggled";
      spaceId: string;
      nextMode: AccountIsolationMode;
    }
  | {
      status: "needs-confirmation";
      pending: SpaceIsolationToggleTransaction;
    }
  | {
      status: "failed";
      error: string;
      pending: SpaceIsolationToggleTransaction | null;
    };

export type SpaceIsolationToggleDeps = {
  tabs: () => readonly Tab[];
  isDirty?: (tabId: number) => boolean;
  hasLivePty: (leafId: number) => boolean;
  isBusy: (leafId: number) => Promise<boolean>;
  applyMode: (spaceId: string, nextMode: AccountIsolationMode) => Promise<void>;
  restartTerminals: (spaceId: string) => void;
};

function hasNewToggleHazards(
  acknowledged: SpaceIsolationToggleTransaction,
  current: SpaceIsolationToggleTransaction,
): boolean {
  if (hasNewCloseManyHazards(acknowledged.hazards, current.hazards)) {
    return true;
  }
  const active = new Set(acknowledged.activeLeafIds);
  return current.activeLeafIds.some((id) => !active.has(id));
}

/**
 * Transactions for toggling Account isolation on an active Space.
 * Evaluates dirty editors and running terminal processes before prompting,
 * preserves non-terminal tabs intact, applies the backend mode change first,
 * and restarts active terminal Panes only after confirmation and sync succeed.
 */
export class SpaceIsolationToggleGuard {
  private pendingTransaction: SpaceIsolationToggleTransaction | null = null;
  private generation = 0;
  private confirming: Promise<SpaceIsolationToggleResult> | null = null;

  constructor(private readonly deps: SpaceIsolationToggleDeps) {}

  current(): SpaceIsolationToggleTransaction | null {
    return this.pendingTransaction;
  }

  async request(
    spaceId: string,
    nextMode: AccountIsolationMode,
  ): Promise<SpaceIsolationToggleResult> {
    const generation = ++this.generation;
    const evaluated = await this.evaluate(spaceId, nextMode);
    if (generation !== this.generation) return { status: "canceled" };

    if (
      evaluated.hazards.dirtyIds.length === 0 &&
      evaluated.activeLeafIds.length === 0
    ) {
      this.pendingTransaction = null;
      try {
        await this.deps.applyMode(spaceId, nextMode);
        return { status: "toggled", spaceId, nextMode };
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          pending: null,
        };
      }
    }

    this.pendingTransaction = evaluated;
    return { status: "needs-confirmation", pending: evaluated };
  }

  cancel(): void {
    this.generation += 1;
    this.pendingTransaction = null;
  }

  confirm(
    options: { savedDirtyIds?: readonly number[] } = {},
  ): Promise<SpaceIsolationToggleResult> {
    if (this.pendingTransaction === null) {
      return Promise.resolve({ status: "idle" });
    }
    if (this.confirming !== null) return this.confirming;
    const generation = this.generation;
    const acknowledged = this.pendingTransaction;
    this.confirming = this.finishConfirm(
      generation,
      acknowledged,
      options.savedDirtyIds ?? [],
    ).finally(() => {
      this.confirming = null;
    });
    return this.confirming;
  }

  private async finishConfirm(
    generation: number,
    acknowledged: SpaceIsolationToggleTransaction,
    savedDirtyIds: readonly number[],
  ): Promise<SpaceIsolationToggleResult> {
    const current = await this.evaluate(
      acknowledged.spaceId,
      acknowledged.nextMode,
    );
    if (generation !== this.generation || this.pendingTransaction === null) {
      return { status: "canceled" };
    }
    if (
      dirtyAfterSave(savedDirtyIds, current.hazards) ||
      hasNewToggleHazards(acknowledged, current)
    ) {
      this.pendingTransaction = current;
      return { status: "needs-confirmation", pending: current };
    }

    try {
      await this.deps.applyMode(acknowledged.spaceId, acknowledged.nextMode);
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        pending: this.pendingTransaction,
      };
    }

    this.pendingTransaction = null;
    this.generation += 1;
    this.deps.restartTerminals(acknowledged.spaceId);
    return {
      status: "toggled",
      spaceId: acknowledged.spaceId,
      nextMode: acknowledged.nextMode,
    };
  }

  private async evaluate(
    spaceId: string,
    nextMode: AccountIsolationMode,
  ): Promise<SpaceIsolationToggleTransaction> {
    let latestSnapshot: SpaceIsolationToggleSnapshot = {
      dirtyIds: [],
      leafIds: [],
      activeLeafIds: [],
    };
    const hazards = await evaluateCloseHazards(
      () => {
        latestSnapshot = spaceToggleHazardSnapshot(
          this.deps.tabs(),
          spaceId,
          this.deps.hasLivePty,
          this.deps.isDirty,
        );
        return latestSnapshot;
      },
      this.deps.isBusy,
      true,
    );
    return {
      spaceId,
      nextMode,
      activeLeafIds: latestSnapshot.activeLeafIds,
      hazards,
    };
  }
}

function formatDirtyNotice(dirtyIds: readonly number[], tabs: readonly Tab[]) {
  if (dirtyIds.length === 0) return null;
  const titles = dirtyIds
    .map((id) => tabs.find((tab) => tab.id === id)?.title)
    .filter((title): title is string => Boolean(title));
  if (dirtyIds.length === 1) {
    return `1 file has unsaved changes${titles[0] ? ` ("${titles[0]}")` : ""}. You can save before switching, though non-terminal tabs stay open.`;
  }
  return `${dirtyIds.length} files have unsaved changes. You can save before switching, though non-terminal tabs stay open.`;
}

function formatRunningProcessNotice(
  busyLeafIds: readonly number[],
  actionVerb: string,
): string | null {
  if (busyLeafIds.length === 0) return null;
  const process =
    busyLeafIds.length === 1
      ? "1 process may still be running"
      : `${busyLeafIds.length} processes may still be running`;
  return `${process} and would be terminated on ${actionVerb}.`;
}

export function spaceIsolationToggleMessage(
  pending: SpaceIsolationToggleTransaction,
  tabs: readonly Tab[],
  spaceName = "this Space",
): string {
  const targetLabel =
    pending.nextMode === "isolated"
      ? "an isolated Account profile"
      : "the shared host Account";
  const parts: string[] = [
    `Switching "${spaceName}" to ${targetLabel} closes and restarts its active terminal Panes (${pending.activeLeafIds.length || "0"} active) under the new Account context. Non-terminal tabs (editors, diffs, previews) remain open intact.`,
  ];
  const dirty = formatDirtyNotice(pending.hazards.dirtyIds, tabs);
  if (dirty) parts.push(dirty);
  const running = formatRunningProcessNotice(
    pending.hazards.busyLeafIds,
    "restart",
  );
  if (running) parts.push(running);
  return parts.join(" ");
}

export type CrossSpaceTabMoveAction =
  | { kind: "move"; tabId: number; targetSpaceId: string }
  | {
      kind: "reorder";
      tabId: number;
      targetTabId: number;
      edge: "top" | "bottom";
    };

export type CrossSpaceTabMoveTransaction = {
  action: CrossSpaceTabMoveAction;
  sourceSpaceId: string;
  targetSpaceId: string;
  sourceIsolation: AccountIsolationMode;
  targetIsolation: AccountIsolationMode;
  hazards: CloseManyHazards & { leafIds: number[] };
};

export type CrossSpaceTabMoveResult =
  | { status: "idle" }
  | { status: "canceled" }
  | { status: "moved" }
  | {
      status: "recreated";
      action: CrossSpaceTabMoveAction;
      targetSpaceId: string;
    }
  | {
      status: "needs-confirmation";
      pending: CrossSpaceTabMoveTransaction;
    };

export type CrossSpaceTabMoveDeps = {
  tabs: () => readonly Tab[];
  spaces: () => readonly SpaceMeta[];
  hasLivePty: (leafId: number) => boolean;
  isBusy: (leafId: number) => Promise<boolean>;
  moveLive: (action: CrossSpaceTabMoveAction) => void;
  recreateInTarget: (
    action: CrossSpaceTabMoveAction,
    targetSpaceId: string,
  ) => void;
};

/**
 * Intercepts cross-Space tab moves and reorders so non-terminal tabs and
 * matching-default terminals move live, while cross-context terminal moves
 * prompt to close the source terminal and recreate a fresh one in the target Space.
 */
export class CrossSpaceTabMoveGuard {
  private pendingTransaction: CrossSpaceTabMoveTransaction | null = null;
  private generation = 0;
  private confirming: Promise<CrossSpaceTabMoveResult> | null = null;

  constructor(private readonly deps: CrossSpaceTabMoveDeps) {}

  current(): CrossSpaceTabMoveTransaction | null {
    return this.pendingTransaction;
  }

  async request(
    action: CrossSpaceTabMoveAction,
  ): Promise<CrossSpaceTabMoveResult> {
    const resolved = this.resolveAction(action);
    if (!resolved) return { status: "idle" };

    if (resolved.sameSpace) {
      if (action.kind === "reorder") {
        this.deps.moveLive(action);
        return { status: "moved" };
      }
      return { status: "idle" };
    }

    const decision = classifyCrossSpaceTabMove(
      resolved.tab.kind,
      resolved.sourceSpace?.accountIsolation,
      resolved.targetSpace?.accountIsolation,
    );
    if (decision.kind === "live") {
      this.deps.moveLive(action);
      return { status: "moved" };
    }

    const generation = ++this.generation;
    const hazards = await this.evaluateTab(action.tabId);
    if (generation !== this.generation || !hazards) {
      return { status: "canceled" };
    }

    this.pendingTransaction = {
      action,
      sourceSpaceId: resolved.tab.spaceId,
      targetSpaceId: resolved.targetSpaceId,
      sourceIsolation: decision.sourceIsolation,
      targetIsolation: decision.targetIsolation,
      hazards,
    };
    return {
      status: "needs-confirmation",
      pending: this.pendingTransaction,
    };
  }

  cancel(): void {
    this.generation += 1;
    this.pendingTransaction = null;
  }

  confirm(): Promise<CrossSpaceTabMoveResult> {
    if (this.pendingTransaction === null) {
      return Promise.resolve({ status: "idle" });
    }
    if (this.confirming !== null) return this.confirming;
    const generation = this.generation;
    const acknowledged = this.pendingTransaction;
    this.confirming = this.finishConfirm(generation, acknowledged).finally(
      () => {
        this.confirming = null;
      },
    );
    return this.confirming;
  }

  private async finishConfirm(
    generation: number,
    acknowledged: CrossSpaceTabMoveTransaction,
  ): Promise<CrossSpaceTabMoveResult> {
    const resolved = this.resolveAction(acknowledged.action);
    const hazards = await this.evaluateTab(acknowledged.action.tabId);
    if (
      generation !== this.generation ||
      this.pendingTransaction === null ||
      !resolved ||
      resolved.sameSpace ||
      !hazards
    ) {
      this.pendingTransaction = null;
      return { status: "canceled" };
    }

    const ackLeaves = new Set(acknowledged.hazards.leafIds);
    const hasNewLeaf = hazards.leafIds.some((id) => !ackLeaves.has(id));
    if (hasNewLeaf || hasNewCloseManyHazards(acknowledged.hazards, hazards)) {
      this.pendingTransaction = {
        ...acknowledged,
        hazards,
      };
      return {
        status: "needs-confirmation",
        pending: this.pendingTransaction,
      };
    }

    this.pendingTransaction = null;
    this.generation += 1;
    this.deps.recreateInTarget(acknowledged.action, acknowledged.targetSpaceId);
    return {
      status: "recreated",
      action: acknowledged.action,
      targetSpaceId: acknowledged.targetSpaceId,
    };
  }

  private resolveAction(action: CrossSpaceTabMoveAction) {
    const tabs = this.deps.tabs();
    const tab = tabs.find((candidate) => candidate.id === action.tabId);
    if (!tab) return null;

    let targetSpaceId: string;
    if (action.kind === "move") {
      targetSpaceId = action.targetSpaceId;
    } else {
      if (action.tabId === action.targetTabId) return null;
      const targetTab = tabs.find((c) => c.id === action.targetTabId);
      if (!targetTab) return null;
      targetSpaceId = targetTab.spaceId;
    }

    const spaces = this.deps.spaces();
    const sourceSpace = spaces.find((sp) => sp.id === tab.spaceId);
    const targetSpace = spaces.find((sp) => sp.id === targetSpaceId);
    return {
      tab,
      targetSpaceId,
      sameSpace: tab.spaceId === targetSpaceId,
      sourceSpace,
      targetSpace,
    };
  }

  private async evaluateTab(
    tabId: number,
  ): Promise<(CloseManyHazards & { leafIds: number[] }) | null> {
    let allLeafIds: number[] = [];
    const findProbeLeaves = (): CloseHazardSnapshot => {
      const tab = this.deps.tabs().find((candidate) => candidate.id === tabId);
      if (tab?.kind !== "terminal") {
        allLeafIds = [];
        return { dirtyIds: [], leafIds: [] };
      }
      const leaves = leafIds(tab.paneTree);
      allLeafIds = leaves;
      const warm = !tab.cold || leaves.some((id) => this.deps.hasLivePty(id));
      return {
        dirtyIds: [],
        leafIds: warm ? leaves : [],
      };
    };

    const initial = findProbeLeaves();
    if (allLeafIds.length === 0 && initial.leafIds.length === 0) {
      const exists = this.deps.tabs().some((c) => c.id === tabId);
      if (!exists) return null;
    }
    const hazards = await evaluateCloseHazards(
      findProbeLeaves,
      this.deps.isBusy,
      true,
    );
    return { ...hazards, leafIds: allLeafIds };
  }
}

export function crossSpaceTerminalMoveMessage(
  pending: CrossSpaceTabMoveTransaction,
  sourceSpaceName = "the current Space",
  targetSpaceName = "the destination Space",
): string {
  const fromLabel =
    pending.sourceIsolation === "isolated" ? "isolated" : "shared host";
  const toLabel =
    pending.targetIsolation === "isolated" ? "isolated" : "shared host";
  const parts: string[] = [
    `Live terminal sessions cannot move across Account contexts (${fromLabel} in "${sourceSpaceName}" to ${toLabel} in "${targetSpaceName}"). Confirm to close this terminal and recreate a fresh terminal in "${targetSpaceName}". Cancel to leave the tab unchanged.`,
  ];
  const running = formatRunningProcessNotice(
    pending.hazards.busyLeafIds,
    "close",
  );
  if (running) parts.push(running);
  return parts.join(" ");
}

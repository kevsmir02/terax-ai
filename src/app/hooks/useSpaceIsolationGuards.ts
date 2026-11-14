import {
  type CrossSpaceTabMoveAction,
  CrossSpaceTabMoveGuard,
  type CrossSpaceTabMoveResult,
  type CrossSpaceTabMoveTransaction,
  SpaceIsolationToggleGuard,
  type SpaceIsolationToggleResult,
  type SpaceIsolationToggleTransaction,
} from "@/app/hooks/spaceIsolationGuards";
import { dirtyAfterSave, saveAllForClose } from "@/app/hooks/tabCloseGuards";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { AccountIsolationMode, SpaceMeta } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import {
  leafHasForegroundProcess,
  ptyIdForLeaf,
} from "@/modules/terminal/lib/terminalSessionApi";
import { useCallback, useRef, useState } from "react";

type Deps = {
  tabs: readonly Tab[];
  spaces: readonly SpaceMeta[];
  isTabDirty: (tabId: number) => boolean;
  saveTab: (tabId: number) => Promise<boolean>;
  applyIsolationMode: (
    spaceId: string,
    nextMode: AccountIsolationMode,
  ) => Promise<void>;
  restartSpaceTerminals: (spaceId: string) => number[];
  moveLive: (action: CrossSpaceTabMoveAction) => void;
  recreateInTarget: (
    action: CrossSpaceTabMoveAction,
    targetSpaceId: string,
  ) => number[];
};

/**
 * Coordinates React dialog state for both guarded Space isolation toggles and
 * guarded cross-Space terminal moves using the pure transaction classes.
 */
export function useSpaceIsolationGuards({
  tabs,
  spaces,
  isTabDirty,
  saveTab,
  applyIsolationMode,
  restartSpaceTerminals,
  moveLive,
  recreateInTarget,
}: Deps) {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  const dirtyRef = useRef(isTabDirty);
  dirtyRef.current = isTabDirty;
  const saveRef = useRef(saveTab);
  saveRef.current = saveTab;
  const applyRef = useRef(applyIsolationMode);
  applyRef.current = applyIsolationMode;
  const restartRef = useRef(restartSpaceTerminals);
  restartRef.current = restartSpaceTerminals;
  const moveLiveRef = useRef(moveLive);
  moveLiveRef.current = moveLive;
  const recreateRef = useRef(recreateInTarget);
  recreateRef.current = recreateInTarget;

  const toggleGuardRef = useRef<SpaceIsolationToggleGuard | null>(null);
  if (!toggleGuardRef.current) {
    toggleGuardRef.current = new SpaceIsolationToggleGuard({
      tabs: () => tabsRef.current,
      isDirty: (tabId) => dirtyRef.current(tabId),
      hasLivePty: (leafId) => ptyIdForLeaf(leafId) !== null,
      isBusy: leafHasForegroundProcess,
      applyMode: (spaceId, nextMode) => applyRef.current(spaceId, nextMode),
      restartTerminals: (spaceId) => {
        const disposed = restartRef.current(spaceId);
        const finish = useAgentStore.getState().finish;
        for (const leafId of disposed) finish(leafId);
      },
    });
  }
  const toggleGuard = toggleGuardRef.current;

  const moveGuardRef = useRef<CrossSpaceTabMoveGuard | null>(null);
  if (!moveGuardRef.current) {
    moveGuardRef.current = new CrossSpaceTabMoveGuard({
      tabs: () => tabsRef.current,
      spaces: () => spacesRef.current,
      hasLivePty: (leafId) => ptyIdForLeaf(leafId) !== null,
      isBusy: leafHasForegroundProcess,
      moveLive: (action) => moveLiveRef.current(action),
      recreateInTarget: (action, targetSpaceId) => {
        const disposed = recreateRef.current(action, targetSpaceId);
        const finish = useAgentStore.getState().finish;
        for (const leafId of disposed) finish(leafId);
      },
    });
  }
  const moveGuard = moveGuardRef.current;

  const [pendingIsolationToggle, setPendingIsolationToggle] =
    useState<SpaceIsolationToggleTransaction | null>(null);
  const [isolationToggleBusy, setIsolationToggleBusy] = useState(false);
  const [isolationToggleError, setIsolationToggleError] = useState<
    string | null
  >(null);
  const [isolationSaveIncomplete, setIsolationSaveIncomplete] = useState(false);

  const [pendingCrossSpaceMove, setPendingCrossSpaceMove] =
    useState<CrossSpaceTabMoveTransaction | null>(null);
  const [crossSpaceMoveBusy, setCrossSpaceMoveBusy] = useState(false);

  const requestSpaceIsolationToggle = useCallback(
    async (spaceId: string, nextMode: AccountIsolationMode): Promise<void> => {
      setIsolationToggleError(null);
      setIsolationSaveIncomplete(false);
      const result = await toggleGuard.request(spaceId, nextMode);
      setPendingIsolationToggle(toggleGuard.current());
      if (result.status === "failed") {
        throw new Error(result.error);
      }
    },
    [toggleGuard],
  );

  const cancelSpaceIsolationToggle = useCallback(() => {
    toggleGuard.cancel();
    setPendingIsolationToggle(null);
    setIsolationToggleBusy(false);
    setIsolationToggleError(null);
    setIsolationSaveIncomplete(false);
  }, [toggleGuard]);

  const confirmSpaceIsolationToggle =
    useCallback(async (): Promise<SpaceIsolationToggleResult> => {
      setIsolationToggleBusy(true);
      setIsolationToggleError(null);
      setIsolationSaveIncomplete(false);
      try {
        const result = await toggleGuard.confirm();
        setPendingIsolationToggle(toggleGuard.current());
        if (result.status === "failed") {
          setIsolationToggleError(result.error);
        }
        return result;
      } finally {
        setIsolationToggleBusy(false);
      }
    }, [toggleGuard]);

  const saveAndToggleSpaceIsolation =
    useCallback(async (): Promise<SpaceIsolationToggleResult> => {
      const pending = toggleGuard.current();
      if (pending === null) return { status: "idle" };
      setIsolationToggleBusy(true);
      setIsolationToggleError(null);
      setIsolationSaveIncomplete(false);
      try {
        const complete = await saveAllForClose(
          pending.hazards.dirtyIds,
          (id) => saveRef.current(id),
          (id) => dirtyRef.current(id),
        );
        if (toggleGuard.current() === null) return { status: "canceled" };
        if (!complete) {
          await toggleGuard.request(pending.spaceId, pending.nextMode);
          setPendingIsolationToggle(toggleGuard.current());
          setIsolationSaveIncomplete(true);
          const refreshed = toggleGuard.current() ?? pending;
          return { status: "needs-confirmation", pending: refreshed };
        }
        const result = await toggleGuard.confirm({
          savedDirtyIds: pending.hazards.dirtyIds,
        });
        setPendingIsolationToggle(toggleGuard.current());
        if (result.status === "needs-confirmation") {
          setIsolationSaveIncomplete(
            dirtyAfterSave(pending.hazards.dirtyIds, result.pending.hazards),
          );
        } else if (result.status === "failed") {
          setIsolationToggleError(result.error);
        }
        return result;
      } catch (error) {
        setIsolationSaveIncomplete(true);
        setPendingIsolationToggle(toggleGuard.current());
        const current = toggleGuard.current();
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          pending: current,
        };
      } finally {
        setIsolationToggleBusy(false);
      }
    }, [toggleGuard]);

  const requestMoveTabToSpace = useCallback(
    async (tabId: number, targetSpaceId: string): Promise<void> => {
      await moveGuard.request({ kind: "move", tabId, targetSpaceId });
      setPendingCrossSpaceMove(moveGuard.current());
    },
    [moveGuard],
  );

  const requestReorderTabAcrossSpaces = useCallback(
    async (
      tabId: number,
      targetTabId: number,
      edge: "top" | "bottom",
    ): Promise<void> => {
      await moveGuard.request({
        kind: "reorder",
        tabId,
        targetTabId,
        edge,
      });
      setPendingCrossSpaceMove(moveGuard.current());
    },
    [moveGuard],
  );

  const cancelCrossSpaceMove = useCallback(() => {
    moveGuard.cancel();
    setPendingCrossSpaceMove(null);
    setCrossSpaceMoveBusy(false);
  }, [moveGuard]);

  const confirmCrossSpaceMove =
    useCallback(async (): Promise<CrossSpaceTabMoveResult> => {
      setCrossSpaceMoveBusy(true);
      try {
        const result = await moveGuard.confirm();
        setPendingCrossSpaceMove(moveGuard.current());
        return result;
      } finally {
        setCrossSpaceMoveBusy(false);
      }
    }, [moveGuard]);

  return {
    pendingIsolationToggle,
    isolationToggleBusy,
    isolationToggleError,
    isolationSaveIncomplete,
    requestSpaceIsolationToggle,
    confirmSpaceIsolationToggle,
    saveAndToggleSpaceIsolation,
    cancelSpaceIsolationToggle,
    pendingCrossSpaceMove,
    crossSpaceMoveBusy,
    requestMoveTabToSpace,
    requestReorderTabAcrossSpaces,
    confirmCrossSpaceMove,
    cancelCrossSpaceMove,
  };
}

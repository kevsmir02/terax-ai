import {
  type CloseManyHazards,
  type CloseManyKind,
  type CloseManyPending,
  deletedPathTabs,
  evaluateCloseHazards,
  hasCloseManyHazards,
  hasNewCloseManyHazards,
  saveAllForClose,
  saveThenClose,
} from "@/app/hooks/tabCloseGuards";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type CloseTabsPlan,
  nextActiveInSpace,
  planCloseOtherTabs,
  planCloseTabsToRight,
  type Tab,
} from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

function confirmRunningTerminal(): boolean {
  return usePreferencesStore.getState().confirmCloseRunningTerminal;
}

type Params = {
  tabs: Tab[];
  activeId: number;
  disposeTab: (id: number) => void;
  disposeDeletedTabs: (ids: number[]) => void;
  disposeTabs: (anchorId: number, plan: CloseTabsPlan) => void;
  /** Resolves true only when the buffer is fully persisted. */
  saveTab: (id: number) => Promise<boolean>;
  isTabDirty: (id: number) => boolean;
};

/**
 * Guards tab closing: dirty editors and terminals with a live foreground
 * process route through a confirmation dialog instead of closing immediately.
 * Owns the pending-close states the dialogs render from.
 */
export function useTabCloseGuards({
  tabs,
  activeId,
  disposeTab,
  disposeDeletedTabs,
  disposeTabs,
  saveTab,
  isTabDirty,
}: Params) {
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  }, [tabs, activeId]);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  const [pendingCloseMany, setPendingCloseMany] =
    useState<CloseManyPending | null>(null);
  const [closeManyConfirming, setCloseManyConfirming] = useState(false);
  const [closeManyIncomplete, setCloseManyIncomplete] = useState(false);
  const [closeSaveState, setCloseSaveState] = useState<
    "idle" | "saving" | "incomplete"
  >("idle");
  const closeManyRequestRef = useRef(0);
  const saveTabRef = useRef(saveTab);
  const isTabDirtyRef = useRef(isTabDirty);
  useLayoutEffect(() => {
    saveTabRef.current = saveTab;
    isTabDirtyRef.current = isTabDirty;
  }, [saveTab, isTabDirty]);

  const handleClose = useCallback(
    async (id: number) => {
      // Last tab in its space can't be closed (closeTab refuses). Skip the
      // dialog entirely so confirming it doesn't appear to silently fail.
      if (nextActiveInSpace(tabs, id) === null) return;
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setCloseSaveState("idle");
        setPendingCloseTab(id);
        return;
      }
      if (t?.kind === "terminal" && confirmRunningTerminal()) {
        const leaves = leafIds(t.paneTree);
        const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
        if (checks.some(Boolean)) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const captureCloseMany = useCallback((closeIds: number[]) => {
    const close = new Set(closeIds);
    const affected = tabsRef.current.filter((tab) => close.has(tab.id));
    return {
      dirtyIds: affected
        .filter((tab) => tab.kind === "editor" && tab.dirty)
        .map((tab) => tab.id),
      leafIds: affected
        .filter((tab) => tab.kind === "terminal")
        .flatMap((tab) => leafIds(tab.paneTree)),
    };
  }, []);

  const evaluateCloseMany = useCallback(
    (closeIds: number[]): Promise<CloseManyHazards> =>
      evaluateCloseHazards(
        () => captureCloseMany(closeIds),
        leafHasForegroundProcess,
        confirmRunningTerminal(),
      ),
    [captureCloseMany],
  );

  const planCloseMany = useCallback(
    (kind: CloseManyKind, anchorId: number) =>
      kind === "right"
        ? planCloseTabsToRight(tabsRef.current, anchorId, activeIdRef.current)
        : planCloseOtherTabs(tabsRef.current, anchorId, activeIdRef.current),
    [],
  );

  const withCurrentActive = useCallback(
    (plan: CloseTabsPlan): CloseTabsPlan => ({
      closeIds: plan.closeIds,
      nextActiveId: activeIdRef.current,
    }),
    [],
  );

  const handleCloseMany = useCallback(
    async (kind: CloseManyKind, anchorId: number) => {
      const plan = planCloseMany(kind, anchorId);
      if (plan.closeIds.length === 0) return;
      const requestId = ++closeManyRequestRef.current;
      const hazards = await evaluateCloseMany(plan.closeIds);
      if (requestId !== closeManyRequestRef.current) return;
      if (hasCloseManyHazards(hazards)) {
        setPendingCloseMany({ kind, anchorId, plan, ...hazards });
        return;
      }
      disposeTabs(anchorId, withCurrentActive(plan));
    },
    [disposeTabs, evaluateCloseMany, planCloseMany, withCurrentActive],
  );

  const handleCloseTabsToRight = useCallback(
    (anchorId: number) => {
      void handleCloseMany("right", anchorId);
    },
    [handleCloseMany],
  );

  const handleCloseOtherTabs = useCallback(
    (anchorId: number) => {
      void handleCloseMany("other", anchorId);
    },
    [handleCloseMany],
  );

  const confirmCloseMany = useCallback(async () => {
    if (pendingCloseMany === null) return;
    const requestId = ++closeManyRequestRef.current;
    setCloseManyConfirming(true);
    setCloseManyIncomplete(false);
    const hazards = await evaluateCloseMany(pendingCloseMany.plan.closeIds);
    if (requestId !== closeManyRequestRef.current) return;
    if (hasNewCloseManyHazards(pendingCloseMany, hazards)) {
      setPendingCloseMany({ ...pendingCloseMany, ...hazards });
      setCloseManyConfirming(false);
      return;
    }
    disposeTabs(
      pendingCloseMany.anchorId,
      withCurrentActive(pendingCloseMany.plan),
    );
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
  }, [pendingCloseMany, disposeTabs, evaluateCloseMany, withCurrentActive]);

  /** Saves the affected buffers first; any incomplete save keeps the dialog open. */
  const saveAndCloseMany = useCallback(async () => {
    if (pendingCloseMany === null) return;
    const requestId = ++closeManyRequestRef.current;
    setCloseManyConfirming(true);
    setCloseManyIncomplete(false);
    try {
      const complete = await saveAllForClose(
        pendingCloseMany.dirtyIds,
        (id) => saveTabRef.current(id),
        (id) => isTabDirtyRef.current(id),
      );
      if (requestId !== closeManyRequestRef.current) return;
      const hazards = await evaluateCloseMany(pendingCloseMany.plan.closeIds);
      if (requestId !== closeManyRequestRef.current) return;
      if (
        !complete ||
        hasNewCloseManyHazards(pendingCloseMany, hazards)
      ) {
        setPendingCloseMany({ ...pendingCloseMany, ...hazards });
        setCloseManyIncomplete(!complete);
        return;
      }
      disposeTabs(
        pendingCloseMany.anchorId,
        withCurrentActive(pendingCloseMany.plan),
      );
      setPendingCloseMany(null);
    } catch {
      setCloseManyIncomplete(true);
    } finally {
      if (requestId === closeManyRequestRef.current) {
        setCloseManyConfirming(false);
      }
    }
  }, [
    pendingCloseMany,
    disposeTabs,
    evaluateCloseMany,
    withCurrentActive,
  ]);

  const cancelCloseMany = useCallback(() => {
    closeManyRequestRef.current += 1;
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
    setCloseManyIncomplete(false);
  }, []);

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
    setCloseSaveState("idle");
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
    setCloseSaveState("idle");
  }, []);

  /**
   * Save then close. The tab closes only when the save covered the buffer and
   * the buffer still has nothing newer; otherwise it stays open and the dialog
   * says why. Closing is never inferred from the save's success alone.
   */
  const saveAndClose = useCallback(async (): Promise<void> => {
    const id = pendingCloseTab;
    if (id === null) return;
    setCloseSaveState("saving");
    try {
      const result = await saveThenClose(
        {
          save: (tabId) => saveTabRef.current(tabId),
          isDirty: (tabId) => isTabDirtyRef.current(tabId),
          exists: (tabId) => tabsRef.current.some((tab) => tab.id === tabId),
          close: (tabId) => disposeTab(tabId),
        },
        id,
      );
      if (result === "closed" || result === "gone") {
        setPendingCloseTab(null);
        setCloseSaveState("idle");
        return;
      }
      setCloseSaveState("incomplete");
    } catch {
      setCloseSaveState("incomplete");
    }
  }, [pendingCloseTab, disposeTab]);

  const confirmTerminalClose = useCallback(() => {
    if (pendingTerminalCloseTab !== null) disposeTab(pendingTerminalCloseTab);
    setPendingTerminalCloseTab(null);
  }, [pendingTerminalCloseTab, disposeTab]);

  const cancelTerminalClose = useCallback(() => {
    setPendingTerminalCloseTab(null);
  }, []);

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      disposeDeletedTabs(pendingDeleteTabs);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeDeletedTabs]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathsDeleted = useCallback(
    (paths: string[]) => {
      const affected = deletedPathTabs(tabsRef.current, paths);
      disposeDeletedTabs(affected.cleanIds);
      if (affected.dirtyIds.length > 0) {
        setPendingDeleteTabs((current) => [
          ...new Set([...(current ?? []), ...affected.dirtyIds]),
        ]);
      }
    },
    [disposeDeletedTabs],
  );

  return {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    closeManyIncomplete,
    closeSaveState,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    confirmClose,
    cancelClose,
    saveAndClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    saveAndCloseMany,
    cancelCloseMany,
    handlePathsDeleted,
  };
}

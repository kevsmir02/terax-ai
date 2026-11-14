import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess } from "@/modules/terminal";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  SpaceDeleteGuard,
  type SpaceDeleteResult,
  type SpaceDeleteTransaction,
} from "./spaceDeleteGuards";
import { dirtyAfterSave, saveAllForClose } from "./tabCloseGuards";

type Params = {
  tabs: Tab[];
  /** Removes the Space's metadata, tabs, and any Space-scoped private profiles. */
  deleteSpace: (spaceId: string) => void | Promise<void>;
  /** Resolves true only when the buffer is fully persisted. */
  saveTab: (tabId: number) => Promise<boolean>;
  isTabDirty: (tabId: number) => boolean;
  /** Captures a discard of this buffer's recovery draft, for after a confirmed deletion. */
  prepareDiscard: (tabId: number) => (() => void) | null;
};

/**
 * Owns the Space deletion transaction: confirm, re-check, and optionally save
 * the Space's dirty buffers first. Organization is removed only after that.
 */
export function useSpaceDeleteGuard({
  tabs,
  deleteSpace,
  saveTab,
  isTabDirty,
  prepareDiscard,
}: Params) {
  const tabsRef = useRef(tabs);
  const deleteRef = useRef(deleteSpace);
  const saveRef = useRef(saveTab);
  const dirtyRef = useRef(isTabDirty);
  const discardRef = useRef(prepareDiscard);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    deleteRef.current = deleteSpace;
    saveRef.current = saveTab;
    dirtyRef.current = isTabDirty;
    discardRef.current = prepareDiscard;
  }, [tabs, deleteSpace, saveTab, isTabDirty, prepareDiscard]);

  const guardRef = useRef<SpaceDeleteGuard | null>(null);
  if (guardRef.current === null) {
    guardRef.current = new SpaceDeleteGuard({
      tabs: () => tabsRef.current,
      isDirty: (tabId) => dirtyRef.current(tabId),
      isBusy: leafHasForegroundProcess,
      confirmRunning: () =>
        usePreferencesStore.getState().confirmCloseRunningTerminal,
      deleteOrganization: (spaceId) => deleteRef.current(spaceId),
    });
  }
  const guard = guardRef.current;

  const [pendingSpaceDelete, setPendingSpaceDelete] =
    useState<SpaceDeleteTransaction | null>(null);
  const [spaceDeleteSaving, setSpaceDeleteSaving] = useState(false);
  const [spaceDeleteIncomplete, setSpaceDeleteIncomplete] = useState(false);

  const requestSpaceDelete = useCallback(
    async (spaceId: string): Promise<void> => {
      setSpaceDeleteIncomplete(false);
      const pending = await guard.request(spaceId);
      setPendingSpaceDelete(pending);
    },
    [guard],
  );

  const cancelSpaceDelete = useCallback(() => {
    guard.cancel();
    setPendingSpaceDelete(null);
    setSpaceDeleteSaving(false);
    setSpaceDeleteIncomplete(false);
  }, [guard]);

  const confirmSpaceDelete =
    useCallback(async (): Promise<SpaceDeleteResult> => {
      const pending = guard.current();
      // Captured before the commit: disposing the tabs removes their handles.
      const discards =
        pending?.hazards.dirtyIds
          .map((id) => discardRef.current(id))
          .filter((discard): discard is () => void => discard !== null) ?? [];
      setSpaceDeleteSaving(true);
      setSpaceDeleteIncomplete(false);
      try {
        const result = await guard.confirm();
        if (result.status === "deleted") {
          for (const discard of discards) discard();
        }
        setPendingSpaceDelete(guard.current());
        return result;
      } finally {
        setSpaceDeleteSaving(false);
      }
    }, [guard]);

  /**
   * Saves every dirty buffer the Space owns before the same guarded delete.
   * A save that does not cover newer typing (or hits a conflict/failure) leaves
   * the dialog open with the current hazards; nothing is deleted or discarded.
   */
  const saveAndDeleteSpace =
    useCallback(async (): Promise<SpaceDeleteResult> => {
      const pending = guard.current();
      if (pending === null) return { status: "idle" };
      setSpaceDeleteSaving(true);
      setSpaceDeleteIncomplete(false);
      try {
        const complete = await saveAllForClose(
          pending.hazards.dirtyIds,
          (id) => saveRef.current(id),
          (id) => dirtyRef.current(id),
        );
        // The user may have canceled while the saves were in flight.
        if (guard.current() === null) return { status: "canceled" };
        if (!complete) {
          const refreshed = await guard.request(pending.spaceId);
          setPendingSpaceDelete(refreshed);
          setSpaceDeleteIncomplete(true);
          return {
            status: "needs-confirmation",
            pending: refreshed ?? pending,
          };
        }
        const result = await guard.confirm({
          savedDirtyIds: pending.hazards.dirtyIds,
        });
        setPendingSpaceDelete(guard.current());
        if (result.status === "needs-confirmation") {
          setSpaceDeleteIncomplete(
            dirtyAfterSave(pending.hazards.dirtyIds, result.pending.hazards),
          );
        }
        return result;
      } catch {
        setSpaceDeleteIncomplete(true);
        setPendingSpaceDelete(guard.current());
        return {
          status: "needs-confirmation",
          pending: guard.current() ?? pending,
        };
      } finally {
        setSpaceDeleteSaving(false);
      }
    }, [guard]);

  return {
    pendingSpaceDelete,
    spaceDeleteSaving,
    spaceDeleteIncomplete,
    requestSpaceDelete,
    confirmSpaceDelete,
    saveAndDeleteSpace,
    cancelSpaceDelete,
  };
}

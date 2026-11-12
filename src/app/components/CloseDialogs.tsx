import type { CloseManyPending } from "@/app/hooks/tabCloseGuards";
import {
  spaceDeleteMessage,
  type SpaceDeleteTransaction,
} from "@/app/hooks/spaceDeleteGuards";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { setConfirmCloseRunningTerminal } from "@/modules/settings/store";
import type { Tab } from "@/modules/tabs";
import { useId, useState } from "react";

type Props = {
  tabs: Tab[];
  pendingCloseTab: number | null;
  closeSaveState: "idle" | "saving" | "incomplete";
  onCancelClose: () => void;
  onConfirmClose: () => void;
  onSaveAndClose: () => void;
  pendingTerminalCloseTab: number | null;
  onCancelTerminalClose: () => void;
  onConfirmTerminalClose: () => void;
  pendingDeleteTabs: number[] | null;
  onCancelDeleteClose: () => void;
  onConfirmDeleteClose: () => void;
  pendingCloseMany: CloseManyPending | null;
  closeManyConfirming: boolean;
  closeManyIncomplete: boolean;
  onCancelCloseMany: () => void;
  onConfirmCloseMany: () => void;
  onSaveAndCloseMany: () => void;
  pendingSpaceDelete: SpaceDeleteTransaction | null;
  spaceName: string;
  spaceDeleteSaving: boolean;
  spaceDeleteIncomplete: boolean;
  onCancelSpaceDelete: () => void;
  onConfirmSpaceDelete: () => void;
  onSaveAndDeleteSpace: () => void;
};

function OptOutRow({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="-mt-3 flex items-center justify-center gap-2 sm:justify-start">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label
        htmlFor={id}
        className="font-normal text-[12px] text-muted-foreground"
      >
        Don't ask again about running processes
      </Label>
    </div>
  );
}

async function persistOptOut(): Promise<void> {
  try {
    await setConfirmCloseRunningTerminal(false);
  } catch (e) {
    console.error("close-confirmation opt-out failed", e);
  }
}

function closeManyMessage(pending: CloseManyPending, tabs: Tab[]): string {
  const { kind, dirtyIds, busyLeafIds } = pending;
  const dirtyCount = dirtyIds.length;
  const busyCount = busyLeafIds.length;
  if (dirtyCount === 1 && busyCount === 0) {
    const dirty = tabs.find(
      (tab) => tab.kind === "editor" && dirtyIds.includes(tab.id),
    );
    return dirty?.title
      ? `"${dirty.title}" has unsaved changes. Close it anyway?`
      : "1 tab has unsaved changes. Close it anyway?";
  }
  if (dirtyCount > 0 && busyCount > 0) {
    const dirty = `${dirtyCount} tab${dirtyCount === 1 ? " has" : "s have"} unsaved changes`;
    const busy =
      busyCount === 1
        ? "a process is running"
        : `${busyCount} processes are running`;
    return `${dirty} and ${busy}. Save them before closing, or close anyway to discard the changes and terminate the ${busyCount === 1 ? "process" : "processes"}.`;
  }
  if (dirtyCount > 0) {
    return `${dirtyCount} tabs have unsaved changes. Save them before closing, or close anyway to discard them.`;
  }
  const process =
    busyCount === 1 ? "A process is" : `${busyCount} processes are`;
  return kind === "right"
    ? `${process} running in ${busyCount === 1 ? "a tab" : "tabs"} to the right. Closing will terminate ${busyCount === 1 ? "it" : "them"}. Close anyway?`
    : `${process} running in ${busyCount === 1 ? "another tab" : "other tabs"}. Closing will terminate ${busyCount === 1 ? "it" : "them"}. Close anyway?`;
}

/** Confirmation dialogs for closing dirty editors and terminals with live processes. */
export function CloseDialogs({
  tabs,
  pendingCloseTab,
  closeSaveState,
  onCancelClose,
  onConfirmClose,
  onSaveAndClose,
  pendingTerminalCloseTab,
  onCancelTerminalClose,
  onConfirmTerminalClose,
  pendingDeleteTabs,
  onCancelDeleteClose,
  onConfirmDeleteClose,
  pendingCloseMany,
  closeManyConfirming,
  closeManyIncomplete,
  onCancelCloseMany,
  onConfirmCloseMany,
  onSaveAndCloseMany,
  pendingSpaceDelete,
  spaceName,
  spaceDeleteSaving,
  spaceDeleteIncomplete,
  onCancelSpaceDelete,
  onConfirmSpaceDelete,
  onSaveAndDeleteSpace,
}: Props) {
  const [optOutTerminalClose, setOptOutTerminalClose] = useState(false);

  const confirmTerminalClose = () => {
    if (optOutTerminalClose) void persistOptOut();
    setOptOutTerminalClose(false);
    onConfirmTerminalClose();
  };

  const cancelTerminalClose = () => {
    setOptOutTerminalClose(false);
    onCancelTerminalClose();
  };

  return (
    <>
      <AlertDialog
        open={pendingCloseTab !== null}
        onOpenChange={(open) => !open && onCancelClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              {tabs.find((t) => t.id === pendingCloseTab)?.title
                ? `"${
                    tabs.find((t) => t.id === pendingCloseTab)?.title
                  }" has unsaved changes.`
                : "This file has unsaved changes."}{" "}
              {closeSaveState === "incomplete"
                ? "The save did not cover the current text: newer edits, a file conflict or a write failure is still unsaved, so the tab stays open."
                : "Save them, or close and discard them."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                onConfirmClose();
              }}
            >
              Discard & Close
            </AlertDialogAction>
            <AlertDialogAction
              disabled={closeSaveState === "saving"}
              onClick={(event) => {
                event.preventDefault();
                onSaveAndClose();
              }}
            >
              {closeSaveState === "saving" ? "Saving..." : "Save & Close"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingTerminalCloseTab !== null}
        onOpenChange={(open) => !open && cancelTerminalClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close Terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              A process is running. Closing this tab will terminate it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <OptOutRow
            checked={optOutTerminalClose}
            onCheckedChange={setOptOutTerminalClose}
          />
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelTerminalClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmTerminalClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingDeleteTabs !== null}
        onOpenChange={(open) => !open && onCancelDeleteClose()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteTabs?.length === 1
                ? (() => {
                    const title = tabs.find(
                      (t) => t.id === pendingDeleteTabs[0],
                    )?.title;
                    return title
                      ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                      : "This file has unsaved changes. The file has been deleted. Close anyway?";
                  })()
                : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelDeleteClose}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction onClick={onConfirmDeleteClose}>
              Close Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingCloseMany !== null}
        onOpenChange={(open) => !open && onCancelCloseMany()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingCloseMany?.kind === "right"
                ? "Close Tabs to the Right"
                : "Close Other Tabs"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCloseMany ? closeManyMessage(pendingCloseMany, tabs) : ""}
              {closeManyIncomplete
                ? " Some changes were not saved (newer edits, a conflict or a write failure), so nothing was closed."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelCloseMany}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={closeManyConfirming}
              onClick={(event) => {
                event.preventDefault();
                onConfirmCloseMany();
              }}
            >
              {closeManyConfirming ? "Checking..." : "Close Anyway"}
            </AlertDialogAction>
            {pendingCloseMany !== null &&
              pendingCloseMany.dirtyIds.length > 0 && (
                <AlertDialogAction
                  disabled={closeManyConfirming}
                  onClick={(event) => {
                    event.preventDefault();
                    onSaveAndCloseMany();
                  }}
                >
                  {closeManyConfirming ? "Checking..." : "Save & Close All"}
                </AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingSpaceDelete !== null}
        onOpenChange={(open) => !open && onCancelSpaceDelete()}
      >
        <AlertDialogContent data-space-delete-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Space?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingSpaceDelete
                ? spaceDeleteMessage(pendingSpaceDelete, tabs, spaceName)
                : ""}
              {spaceDeleteIncomplete
                ? " The save did not cover the current text (newer edits, a file conflict or a write failure), so the Space and its tabs stay as they are."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelSpaceDelete}>
              Cancel
            </AlertDialogCancel>
            {pendingSpaceDelete !== null &&
              pendingSpaceDelete.hazards.dirtyIds.length > 0 && (
                <AlertDialogAction
                  disabled={spaceDeleteSaving}
                  onClick={(event) => {
                    event.preventDefault();
                    onSaveAndDeleteSpace();
                  }}
                >
                  {spaceDeleteSaving ? "Saving..." : "Save & Delete"}
                </AlertDialogAction>
              )}
            <AlertDialogAction
              variant="destructive"
              disabled={spaceDeleteSaving}
              onClick={(event) => {
                event.preventDefault();
                onConfirmSpaceDelete();
              }}
            >
              {pendingSpaceDelete !== null &&
              pendingSpaceDelete.hazards.dirtyIds.length > 0
                ? "Delete Without Saving"
                : "Delete Space"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

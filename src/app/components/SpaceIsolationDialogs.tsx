import {
  crossSpaceTerminalMoveMessage,
  type CrossSpaceTabMoveTransaction,
  spaceIsolationToggleMessage,
  type SpaceIsolationToggleTransaction,
} from "@/app/hooks/spaceIsolationGuards";
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
import type { SpaceMeta } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";

type Props = {
  tabs: readonly Tab[];
  spaces: readonly SpaceMeta[];
  pendingIsolationToggle: SpaceIsolationToggleTransaction | null;
  isolationToggleBusy: boolean;
  isolationToggleError: string | null;
  isolationSaveIncomplete: boolean;
  onConfirmIsolationToggle: () => void;
  onSaveAndToggleIsolation: () => void;
  onCancelIsolationToggle: () => void;
  pendingCrossSpaceMove: CrossSpaceTabMoveTransaction | null;
  crossSpaceMoveBusy: boolean;
  onConfirmCrossSpaceMove: () => void;
  onCancelCrossSpaceMove: () => void;
};

export function SpaceIsolationDialogs({
  tabs,
  spaces,
  pendingIsolationToggle,
  isolationToggleBusy,
  isolationToggleError,
  isolationSaveIncomplete,
  onConfirmIsolationToggle,
  onSaveAndToggleIsolation,
  onCancelIsolationToggle,
  pendingCrossSpaceMove,
  crossSpaceMoveBusy,
  onConfirmCrossSpaceMove,
  onCancelCrossSpaceMove,
}: Props) {
  const toggleSpaceName = pendingIsolationToggle
    ? (spaces.find((sp) => sp.id === pendingIsolationToggle.spaceId)?.name ??
      "this Space")
    : undefined;
  const sourceSpaceName = pendingCrossSpaceMove
    ? (spaces.find((sp) => sp.id === pendingCrossSpaceMove.sourceSpaceId)
        ?.name ?? "the current Space")
    : undefined;
  const targetSpaceName = pendingCrossSpaceMove
    ? (spaces.find((sp) => sp.id === pendingCrossSpaceMove.targetSpaceId)
        ?.name ?? "the destination Space")
    : undefined;

  return (
    <>
      <AlertDialog
        open={pendingIsolationToggle !== null}
        onOpenChange={(open) => {
          if (!open && !isolationToggleBusy) onCancelIsolationToggle();
        }}
      >
        <AlertDialogContent data-space-isolation-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch Space Account Isolation?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingIsolationToggle
                ? spaceIsolationToggleMessage(
                    pendingIsolationToggle,
                    tabs,
                    toggleSpaceName,
                  )
                : ""}
              {isolationSaveIncomplete
                ? " Some changes could not be saved, so the Space isolation mode was left unchanged."
                : ""}
              {isolationToggleError ? ` ${isolationToggleError}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isolationToggleBusy}
              onClick={onCancelIsolationToggle}
            >
              Cancel
            </AlertDialogCancel>
            {pendingIsolationToggle !== null &&
              pendingIsolationToggle.hazards.dirtyIds.length > 0 && (
                <AlertDialogAction
                  disabled={isolationToggleBusy}
                  onClick={(event) => {
                    event.preventDefault();
                    onSaveAndToggleIsolation();
                  }}
                >
                  {isolationToggleBusy ? "Switching..." : "Save & Switch"}
                </AlertDialogAction>
              )}
            <AlertDialogAction
              variant={
                pendingIsolationToggle &&
                pendingIsolationToggle.hazards.busyLeafIds.length > 0
                  ? "destructive"
                  : "default"
              }
              disabled={isolationToggleBusy}
              onClick={(event) => {
                event.preventDefault();
                onConfirmIsolationToggle();
              }}
            >
              {isolationToggleBusy
                ? "Switching..."
                : "Restart Terminals & Switch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingCrossSpaceMove !== null}
        onOpenChange={(open) => {
          if (!open && !crossSpaceMoveBusy) onCancelCrossSpaceMove();
        }}
      >
        <AlertDialogContent data-cross-space-terminal-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Move Terminal Across Account Contexts?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingCrossSpaceMove
                ? crossSpaceTerminalMoveMessage(
                    pendingCrossSpaceMove,
                    sourceSpaceName,
                    targetSpaceName,
                  )
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={crossSpaceMoveBusy}
              onClick={onCancelCrossSpaceMove}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={
                pendingCrossSpaceMove &&
                pendingCrossSpaceMove.hazards.busyLeafIds.length > 0
                  ? "destructive"
                  : "default"
              }
              disabled={crossSpaceMoveBusy}
              onClick={(event) => {
                event.preventDefault();
                onConfirmCrossSpaceMove();
              }}
            >
              {crossSpaceMoveBusy ? "Checking..." : "Close & Recreate Terminal"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The quit questions.
 *
 * Every phase the gate can be in has one dialog, and the wording states what
 * will happen rather than reassuring: a flush that failed says the newest text
 * is not saved, the survivor prompt says forcing ends the process, and the
 * summary never claims ownership of services the application cannot see.
 */

import { useId, useState } from "react";
import {
  canOptOutOfQuitPrompt,
  describeQuit,
  type QuitDraft,
  type QuitState,
} from "@/modules/shutdown";
import { setConfirmCloseRunningTerminal } from "@/modules/settings/store";
import type { Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
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

type Props = {
  quit: QuitState;
  tabs: Tab[];
  onCancel: () => void;
  onConfirm: () => void;
  onSaveAll: () => void;
  onRetryFlush: () => void;
  onLoseDrafts: () => void;
  onForce: () => void;
};

const DRAFT_REASON: Record<QuitDraft["state"], string> = {
  pending: "the newest text is still waiting to be written",
  unsettled: "the write did not finish in time",
  failed: "the write failed",
  paused: "recovery storage is full, so recovery paused",
  unavailable: "recovery storage is unavailable",
};

function draftLine(draft: QuitDraft, spaceName: string): string {
  const where = spaceName ? `${spaceName}: ` : "";
  return `${where}${draft.title} — ${DRAFT_REASON[draft.state]}`;
}

function survivorTitle(tabs: Tab[], leafId: number): string {
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    if (leafIds(tab.paneTree).includes(leafId)) return tab.title;
  }
  return `terminal ${leafId}`;
}

async function persistOptOut(): Promise<void> {
  try {
    await setConfirmCloseRunningTerminal(false);
  } catch (error) {
    console.error("close-confirmation opt-out failed", error);
  }
}

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

function noteText(note: QuitState["note"]): string {
  switch (note) {
    case "changed":
      return " New work appeared after you confirmed, so this is what is at stake now.";
    case "save-incomplete":
      return " The save did not cover the current text: newer edits, a file conflict or a write failure is still unsaved.";
    default:
      return "";
  }
}

export function QuitDialog({
  quit,
  tabs,
  onCancel,
  onConfirm,
  onSaveAll,
  onRetryFlush,
  onLoseDrafts,
  onForce,
}: Props) {
  const [optOut, setOptOut] = useState(false);
  const survey = quit.survey;
  const draftSpace = (spaceId: string) =>
    survey?.spaces.find((space) => space.id === spaceId)?.name ?? "";

  const confirm = async () => {
    const canOptOut = survey !== null && canOptOutOfQuitPrompt(survey);
    const persist = canOptOut && optOut;
    setOptOut(false);
    // The preference write has to land before the window closes.
    if (persist) await persistOptOut();
    onConfirm();
  };

  const cancel = () => {
    setOptOut(false);
    onCancel();
  };

  return (
    <AlertDialog open={quit.phase !== "idle"}>
      <AlertDialogContent data-quit-dialog>
        {quit.phase === "resolving" && survey !== null && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Quit Terax?</AlertDialogTitle>
              <AlertDialogDescription>
                {describeQuit(survey)}
                {noteText(quit.note)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {canOptOutOfQuitPrompt(survey) ? (
              <OptOutRow checked={optOut} onCheckedChange={setOptOut} />
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel onClick={cancel}>Cancel</AlertDialogCancel>
              {survey.totals.buffers > 0 && (
                <AlertDialogAction
                  onClick={(event) => {
                    event.preventDefault();
                    onSaveAll();
                  }}
                >
                  Save All &amp; Quit
                </AlertDialogAction>
              )}
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  void confirm();
                }}
              >
                {survey.totals.drafts > 0
                  ? "Quit and Lose Drafts"
                  : "Quit Anyway"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}

        {(quit.phase === "flushing" || quit.phase === "saving") && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {quit.phase === "saving"
                  ? "Saving Files"
                  : "Saving Recovery Drafts"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {quit.phase === "saving"
                  ? "Saving the unsaved files before quitting. Anything typed during the save is checked again before the window closes."
                  : "Writing unsaved text to private recovery storage before quitting. Terax stops waiting after a few seconds and asks again rather than reading a stalled write as saved."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={cancel}>Cancel</AlertDialogCancel>
            </AlertDialogFooter>
          </>
        )}

        {quit.phase === "flush-failed" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Recovery Drafts Not Saved</AlertDialogTitle>
              <AlertDialogDescription>
                {quit.flush && quit.flush.drafts.length > 0
                  ? `Quitting now would lose the newest text in these files: ${quit.flush.drafts
                      .map((draft) =>
                        draftLine(draft, draftSpace(draft.spaceId)),
                      )
                      .join("; ")}.`
                  : "The recovery flush did not finish, so the newest unsaved text is not saved."}{" "}
                The text is still in the open editors. Retry the write, cancel
                and keep working, or quit and accept the loss.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={cancel}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  onRetryFlush();
                }}
              >
                Retry
              </AlertDialogAction>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  onLoseDrafts();
                }}
              >
                Quit and Lose Drafts
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}

        {(quit.phase === "verifying" || quit.phase === "terminating") && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Closing Terax</AlertDialogTitle>
              <AlertDialogDescription>
                Asking the processes Terax started to exit. Nothing is forced
                without asking.
              </AlertDialogDescription>
            </AlertDialogHeader>
          </>
        )}

        {quit.phase === "force-prompt" && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Processes Did Not Exit</AlertDialogTitle>
              <AlertDialogDescription>
                {quit.survivors
                  .map((leafId) => survivorTitle(tabs, leafId))
                  .join(", ")}{" "}
                did not exit after being asked. Forcing ends{" "}
                {quit.survivors.length === 1 ? "it" : "them"} now; work that was
                not saved is lost. Cancel keeps the window open. Services that
                were deliberately detached from a terminal are not visible here
                and keep running either way.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={cancel}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  onForce();
                }}
              >
                Force Quit
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

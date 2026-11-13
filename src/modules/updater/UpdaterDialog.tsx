import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import { packageGuidanceFor, type PackageGuidance } from "./packageGuidance";
import type { HandoffHazard, HandoffWork } from "./handoffReadiness";
import { checkSummary, handoffRecoveryNote, trustNote } from "./updaterCopy";
import type { UpdaterState } from "./updateState";
import { useUpdater } from "./useUpdater";

type DistroKey = PackageGuidance["distro"];

/** The states this dialog can show: every one of them carries a release. */
export type UpdaterDialogState = Exclude<
  UpdaterState,
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "check-failed" }
>;

export function isUpdaterDialogState(
  state: UpdaterState,
): state is UpdaterDialogState {
  switch (state.kind) {
    case "update-available":
    case "handoff-unavailable":
    case "handoff-checking":
    case "handoff-blocked":
    case "handed-off":
      return true;
    default:
      return false;
  }
}

const DISTROS: { key: DistroKey; label: string }[] = [
  { key: "arch", label: "Arch" },
  { key: "debian", label: "Debian / Ubuntu" },
  { key: "fedora", label: "Fedora / RHEL" },
];

export type UpdaterDialogBodyProps = {
  state: UpdaterDialogState;
  distro: DistroKey;
  onSelectDistro: (distro: DistroKey) => void;
  copiedCommand: string | null;
  onCopy: (command: string) => void;
  onDismiss: () => void;
  onRequestHandoff: () => void;
  onReviewWork: () => void;
};

/** What the window supplies: live readiness evidence for the handoff check. */
export type UpdaterDeps = {
  readHandoffWork: () => Promise<HandoffWork>;
  reviewHandoffWork?: (hazards: readonly HandoffHazard[]) => void;
};

/**
 * The dialog's contents, separate from the dialog shell so the copy can be
 * asserted without a browser (the shell is a Radix portal).
 *
 * It only describes what was discovered, what the live readiness check found, and
 * where the person's package tool takes over. It never offers an in-app install,
 * a download or a restart, and it never claims an install happened.
 */
export function UpdaterDialogBody({
  state,
  distro,
  onSelectDistro,
  copiedCommand,
  onCopy,
  onDismiss,
  onRequestHandoff,
  onReviewWork,
}: UpdaterDialogBodyProps) {
  const summary = checkSummary(state);
  const showGuidance =
    state.kind === "update-available" ||
    state.kind === "handed-off" ||
    state.kind === "handoff-unavailable";
  const guidance = packageGuidanceFor(distro, state.release.version);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{summary.title}</DialogTitle>
        <DialogDescription>{summary.detail}</DialogDescription>
      </DialogHeader>

      {state.kind === "handed-off" && (
        <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
          {handoffRecoveryNote()}
        </p>
      )}

      {state.release.notes && state.kind !== "handed-off" && (
        <p className="mt-1 whitespace-pre-wrap text-[11.5px] text-muted-foreground">
          {state.release.notes}
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">
        {trustNote(state.release) ||
          `Checked against the ${state.release.channel} channel; nothing was downloaded to find it.`}
      </p>

      {showGuidance && (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-1 rounded-md bg-muted/40 p-1">
            {DISTROS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => onSelectDistro(entry.key)}
                className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                  distro === entry.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
            <p className="text-[11px] leading-snug text-muted-foreground">
              {guidance.summary}
            </p>
            <ul className="flex flex-col gap-1.5">
              {guidance.steps.map((step) => (
                <li key={step.label} className="text-[11.5px] leading-snug">
                  <span className="text-muted-foreground">{step.label}</span>
                  {step.command && (
                    <div className="mt-1 flex items-center gap-2 rounded border border-border/60 bg-background/60 px-2 py-1 font-mono text-[11.5px]">
                      <span className="flex-1 select-all">
                        $ {step.command}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10.5px]"
                        onClick={() => onCopy(step.command ?? "")}
                      >
                        {copiedCommand === step.command ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-[10.5px] text-muted-foreground">
              Run by you with {guidance.tooling.join(", ")}. Terax never runs
              these commands and never asks for privilege to replace itself.
            </p>
          </div>
        </div>
      )}

      <DialogFooter>
        {state.kind === "update-available" && (
          <>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Later
            </Button>
            <Button size="sm" onClick={onRequestHandoff}>
              Update with package tool
            </Button>
          </>
        )}
        {state.kind === "handoff-checking" && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Cancel
          </Button>
        )}
        {state.kind === "handoff-blocked" && (
          <>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Later
            </Button>
            <Button variant="outline" size="sm" onClick={onReviewWork}>
              Review the work
            </Button>
            <Button size="sm" onClick={onRequestHandoff}>
              Approve the handoff again
            </Button>
          </>
        )}
        {(state.kind === "handed-off" ||
          state.kind === "handoff-unavailable") && (
          <Button size="sm" onClick={onDismiss}>
            Close
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/**
 * The update dialog's shell: owns the updater state and the per-dialog view state,
 * and opens only for a discovered release or a handoff that is in progress.
 */
export function UpdaterDialog(props: UpdaterDeps) {
  const { state, requestHandoff, dismiss, reviewWork } = useUpdater(props);
  const [copied, setCopied] = useState<string | null>(null);
  const [distro, setDistro] = useState<DistroKey>("arch");

  if (!isUpdaterDialogState(state)) return null;
  const dialogState = state;

  const copy = async (command: string) => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // A blocked or handed-off state is an answer the person can close; a
        // running check is not dismissed by a stray click.
        if (!next && dialogState.kind !== "handoff-checking") dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[460px]">
        <UpdaterDialogBody
          state={dialogState}
          distro={distro}
          onSelectDistro={setDistro}
          copiedCommand={copied}
          onCopy={(command) => void copy(command)}
          onDismiss={dismiss}
          onRequestHandoff={() => void requestHandoff()}
          onReviewWork={() => reviewWork()}
        />
      </DialogContent>
    </Dialog>
  );
}

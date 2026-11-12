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
import { checkSummary, trustNote } from "./updaterCopy";
import { useUpdater } from "./useUpdater";

type DistroKey = PackageGuidance["distro"];

const DISTROS: { key: DistroKey; label: string }[] = [
  { key: "arch", label: "Arch" },
  { key: "debian", label: "Debian / Ubuntu" },
  { key: "fedora", label: "Fedora / RHEL" },
];

/**
 * The update dialog only describes what was discovered and where the user's package tool
 * takes over. It never offers an in-app install, download or restart: on Arch that would
 * be a separate privileged installer, and on every distribution the install transaction
 * is ticket #39's package-tool handoff.
 */
export function UpdaterDialog() {
  const { state, requestUpdate, dismiss } = useUpdater();
  const [copied, setCopied] = useState<string | null>(null);
  const [distro, setDistro] = useState<DistroKey>("arch");

  const open =
    state.kind === "update-available" || state.kind === "handoff-unavailable";
  if (!open) return null;

  const summary = checkSummary(state);
  const guidance = packageGuidanceFor(distro, state.release.version);

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
      open={open}
      onOpenChange={(next) => {
        if (!next && state.kind !== "handoff-unavailable") dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{summary.title}</DialogTitle>
          <DialogDescription>{summary.detail}</DialogDescription>
        </DialogHeader>

        {state.release.notes && (
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] text-muted-foreground">
            {state.release.notes}
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          {trustNote(state.release) ||
            `Checked against the ${state.release.channel} channel; nothing was downloaded to find it.`}
        </p>

        <div className="mt-2 flex flex-col gap-2">
          <div className="flex gap-1 rounded-md bg-muted/40 p-1">
            {DISTROS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setDistro(entry.key)}
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
                        onClick={() => void copy(step.command ?? "")}
                      >
                        {copied === step.command ? "Copied" : "Copy"}
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

        <DialogFooter>
          {state.kind === "update-available" && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void requestUpdate()}>
                Update with package tool
              </Button>
            </>
          )}
          {state.kind === "handoff-unavailable" && (
            <Button size="sm" onClick={dismiss}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

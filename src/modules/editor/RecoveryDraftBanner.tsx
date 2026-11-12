import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import type { RestorePlan } from "./lib/recovery/cleanup";
import type { RecoveryRecord } from "./lib/recovery/model";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Enough context to recognise the draft; not a full-file diff render. */
const PREVIEW_CHARS = 20_000;

function preview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  return `${text.slice(0, PREVIEW_CHARS)}\n… (truncated for review)`;
}

function siblingCopyPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${dir}${name} recovered`;
  return `${dir}${name.slice(0, dot)} recovered${name.slice(dot)}`;
}

function describe(plan: RestorePlan): string {
  if (plan.kind === "adopt") {
    return "The file is unchanged since this draft was edited. Restoring puts the text back into the editor as unsaved changes — nothing is written to the file.";
  }
  switch (plan.reason) {
    case "missing":
      return "The original file no longer exists. You can compare it with the draft and save the text to a path you choose; recovery never recreates the file.";
    case "unreadable":
      return "The original file can no longer be opened (it was moved, deleted or is unreadable). Compare the draft and save the text to a path you choose; recovery never recreates the original.";
    default:
      return "The file changed since this draft was edited. Compare the versions and save the draft to a different path if you want to keep it.";
  }
}

/**
 * A pre-crash draft offered to a reopened document.
 *
 * Nothing here writes the original file: restoring only changes the editor
 * buffer (dirty, unsaved), and keeping the text goes through Save As to a path
 * the user picks. Closing the banner leaves the draft in private storage.
 */
export function RecoveryDraftBanner({
  draft,
  plan,
  diskText,
  canRestore,
  onRestore,
  onSaveCopy,
  onDiscard,
  onDismiss,
}: {
  draft: RecoveryRecord;
  plan: RestorePlan;
  diskText: string | null;
  canRestore: boolean;
  onRestore: () => void;
  onSaveCopy: (targetPath: string) => unknown;
  onDiscard: () => unknown;
  onDismiss: () => void;
}) {
  const [comparing, setComparing] = useState(false);
  const [copyPath, setCopyPath] = useState(() => siblingCopyPath(draft.path));

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 text-[11px] text-foreground">
        <span>
          Recovered unsaved draft for {fileName(draft.path)} (
          {formatBytes(draft.bytes)})
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setComparing(true)}
          >
            Compare
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={!canRestore}
            title={
              canRestore
                ? "Put the draft text back into the editor (unsaved)"
                : "Save or discard the buffer's own edits first"
            }
            onClick={onRestore}
          >
            Restore
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => void onDiscard()}
          >
            Discard
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            aria-label="Keep the draft and hide this banner"
            onClick={onDismiss}
          >
            Later
          </Button>
        </div>
      </div>

      {comparing && (
        <Dialog open onOpenChange={(open) => (open ? undefined : setComparing(false))}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Recovered draft</DialogTitle>
              <DialogDescription>{describe(plan)}</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  On disk
                </span>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-4">
                  {diskText === null ? "Unavailable." : preview(diskText)}
                </pre>
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Recovered draft
                </span>
                <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-4">
                  {preview(draft.text)}
                </pre>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <Label
                htmlFor="recovery-copy-path"
                className="text-[11px] text-muted-foreground"
              >
                Save the draft elsewhere
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="recovery-copy-path"
                  value={copyPath}
                  spellCheck={false}
                  onChange={(event) => setCopyPath(event.target.value)}
                  className="h-8 font-mono text-[12px]"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={copyPath.trim().length === 0}
                  onClick={() => void onSaveCopy(copyPath.trim())}
                >
                  Save As
                </Button>
              </div>
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setComparing(false)}
              >
                Close
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canRestore}
                onClick={() => {
                  onRestore();
                  setComparing(false);
                }}
              >
                Restore into editor
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

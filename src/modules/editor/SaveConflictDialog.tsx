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
import { useId, useState } from "react";
import type { SaveConflict } from "./lib/diskSync";

type Props = {
  conflict: SaveConflict;
  onOverwrite: () => unknown;
  onReload: () => unknown;
  onSaveCopy: (targetPath: string) => unknown;
  onCancel: () => void;
};

/** Enough context to recognise the change; not a full-file diff render. */
const COMPARE_PREVIEW_CHARS = 20_000;

function preview(text: string): string {
  if (text.length <= COMPARE_PREVIEW_CHARS) return text;
  return `${text.slice(0, COMPARE_PREVIEW_CHARS)}\n… (truncated for review)`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function describe(conflict: SaveConflict): string {
  const name = fileName(conflict.path);
  switch (conflict.reason) {
    case "missing":
      return `${name} no longer exists on disk. Saving your version would recreate it, which is not what a save does; save a copy instead.`;
    case "unreadable":
      return `${name} can no longer be read as a text file. Save a copy rather than writing over it.`;
    case "replaced":
      return `${name} was replaced by another program after you opened it. Review the current file before overwriting it.`;
    default:
      return `${name} was changed by another program after you opened it. Your unsaved text is kept; choose what to do with it.`;
  }
}

function siblingCopyPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${dir}${name} copy`;
  return `${dir}${name.slice(0, dot)} copy${name.slice(dot)}`;
}

/**
 * The four explicit conflict outcomes from the workspace spec: compare the two
 * versions, overwrite the reviewed revision, reload/discard the buffer, or save
 * the text elsewhere. Nothing here happens implicitly — closing the dialog
 * keeps the buffer exactly as it is.
 */
export function SaveConflictDialog({
  conflict,
  onOverwrite,
  onReload,
  onSaveCopy,
  onCancel,
}: Props) {
  const copyPathId = useId();
  // A fresh conflict round remounts this dialog (the caller keys it by the
  // reviewed revision), so the destination never carries over from a round the
  // user did not see.
  const [copyPath, setCopyPath] = useState(() => siblingCopyPath(conflict.path));

  const canOverwrite = conflict.reviewedRevision !== null;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>File changed on disk</DialogTitle>
          <DialogDescription>{describe(conflict)}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              On disk (reviewed)
            </span>
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-4">
              {conflict.reviewedText === null
                ? "Unavailable — the file could not be read."
                : preview(conflict.reviewedText)}
            </pre>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              Your unsaved text
            </span>
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-4">
              {preview(conflict.bufferText)}
            </pre>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={copyPathId} className="text-[11px] text-muted-foreground">
            Save a copy elsewhere
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={copyPathId}
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
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void onReload()}
            >
              Reload from disk
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canOverwrite}
              onClick={() => void onOverwrite()}
            >
              Overwrite
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

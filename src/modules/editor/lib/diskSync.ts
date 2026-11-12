/**
 * Disk/buffer reconciliation for an open document.
 *
 * Every read returns an opaque disk **revision**; every save sends it back, and
 * the native write coordination (`src-tauri/src/modules/fs/save.rs`) refuses the
 * write when the disk no longer matches it. That single rule gives the four
 * conflict outcomes the workspace spec names — compare, Save As, reload/discard
 * and an explicit overwrite bound to the *reviewed* revision — without any of
 * them being able to take effect on a revision the user never saw.
 *
 * Limitations, deliberately not papered over:
 *  - This coordinates **app-owned** writes. An independent external program is
 *    not locked out; a change landing between the revision check and the rename
 *    is indistinguishable from one landing immediately after.
 *  - Consent is bound to the revision, not to a timer: nothing here may assume
 *    a reviewed revision is still current.
 *  - Durable unsaved-text recovery (drafts) is not part of this module.
 */

/** Why a save was refused. Mirrors `ConflictReason` in `fs/save.rs`. */
type SaveConflictReason =
  | "changed"
  | "replaced"
  | "missing"
  | "unreadable";

export type SaveConflict = {
  path: string;
  reason: SaveConflictReason;
  /** Revision this buffer was edited from; what the write expected. */
  expectedRevision: string | null;
  /** The buffer text that must survive the conflict, whatever the user picks. */
  bufferText: string;
  /** Revision found on disk when the refusal came back (null if unreadable). */
  currentRevision: string | null;
  /** Revision the user reviewed; an explicit overwrite is bound to it. */
  reviewedRevision: string | null;
  /** Disk text as reviewed, for the compare view. */
  reviewedText: string | null;
};

type DiskWriteResult = { mtime: number; revision: string };
export type DiskTextRead = { content: string; revision: string; mtime: number };

/** The native surface this module needs; `useDocument` binds it to Tauri. */
export type DiskIo = {
  /** `expectedRevision: null` is the deliberate unconditional write. */
  write(
    path: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<DiskWriteResult>;
  read(path: string): Promise<DiskTextRead>;
  exists(path: string): Promise<boolean>;
  /** Current disk revision without transferring the file contents. */
  revision(path: string): Promise<string>;
};

export type SaveResult =
  | {
      status: "saved";
      revision: string;
      mtime: number;
      /** Exactly what reached the disk (not necessarily the current buffer). */
      writtenText: string;
      /** False when newer typing arrived while the write was in flight. */
      complete: boolean;
    }
  | { status: "conflict"; conflict: SaveConflict }
  | { status: "failed"; message: string };

function conflictReason(value: unknown): SaveConflictReason | null {
  return value === "changed" ||
    value === "replaced" ||
    value === "missing" ||
    value === "unreadable"
    ? value
    : null;
}

/**
 * The native write path rejects with a structured conflict. Anything else
 * (permissions, I/O, a bug) is a plain failure the user cannot resolve by
 * choosing an outcome, so it must never silently become a conflict dialog.
 */
function asConflict(path: string, error: unknown): SaveConflict | null {
  if (typeof error !== "object" || error === null) return null;
  const raw = error as {
    kind?: unknown;
    reason?: unknown;
    current?: unknown;
  };
  if (raw.kind !== "conflict") return null;
  const reason = conflictReason(raw.reason);
  if (reason === null) return null;
  return {
    path,
    reason,
    expectedRevision: null,
    bufferText: "",
    currentRevision: typeof raw.current === "string" ? raw.current : null,
    reviewedRevision: null,
    reviewedText: null,
  };
}

function failureMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}

/**
 * Writes the current buffer, validating `expectedRevision` in native
 * coordination.
 *
 * `buffer` is read twice on purpose: once to snapshot what to write, and once
 * after the write resolves. Text typed during the write is never lost — the
 * baseline becomes exactly what reached the disk and `complete` reports that the
 * buffer has moved on.
 */
export async function commitBuffer(
  io: DiskIo,
  options: {
    path: string;
    expectedRevision: string | null;
    buffer: () => string;
  },
): Promise<SaveResult> {
  const { path, expectedRevision, buffer } = options;
  const text = buffer();
  try {
    const written = await io.write(path, text, expectedRevision);
    return {
      status: "saved",
      revision: written.revision,
      mtime: written.mtime,
      writtenText: text,
      complete: buffer() === text,
    };
  } catch (error) {
    const conflict = asConflict(path, error);
    if (conflict) {
      return {
        status: "conflict",
        conflict: {
          ...conflict,
          expectedRevision,
          bufferText: text,
        },
      };
    }
    return { status: "failed", message: failureMessage(error) };
  }
}

/**
 * Fills in what the user is about to review. Reading the disk here is what
 * binds a later overwrite consent to a concrete revision: a read failure leaves
 * `reviewedRevision` null, which makes overwriting impossible (a missing or
 * unreadable target is never recreated by a save).
 */
export async function reviewConflict(
  io: DiskIo,
  conflict: SaveConflict,
): Promise<SaveConflict> {
  try {
    const disk = await io.read(conflict.path);
    return {
      ...conflict,
      reviewedRevision: disk.revision,
      reviewedText: disk.content,
    };
  } catch {
    return {
      ...conflict,
      reason: conflict.currentRevision === null ? conflict.reason : "unreadable",
      reviewedRevision: null,
      reviewedText: null,
    };
  }
}

/**
 * Explicit overwrite. Resends the revision the user actually reviewed, so a
 * change after that review is refused and produces a fresh conflict round
 * instead of clobbering a revision nobody saw.
 */
export async function overwriteReviewed(
  io: DiskIo,
  conflict: SaveConflict,
  text: string,
): Promise<SaveResult> {
  if (conflict.reviewedRevision === null) {
    return {
      status: "failed",
      message: "There is no reviewed disk revision to overwrite.",
    };
  }
  try {
    const written = await io.write(
      conflict.path,
      text,
      conflict.reviewedRevision,
    );
    return {
      status: "saved",
      revision: written.revision,
      mtime: written.mtime,
      writtenText: text,
      complete: true,
    };
  } catch (error) {
    const next = asConflict(conflict.path, error);
    if (!next) return { status: "failed", message: failureMessage(error) };
    return {
      status: "conflict",
      conflict: {
        ...next,
        expectedRevision: conflict.expectedRevision,
        bufferText: text,
      },
    };
  }
}

/**
 * Save As. Writes the buffer to a different path, unconditionally, and never
 * touches the conflicting file. An existing destination or the conflicting path
 * itself is refused rather than overwritten: this is not a blind-write escape
 * hatch. Retargeting the buffer to the new file belongs to the recovery ticket.
 */
export async function saveCopy(
  io: DiskIo,
  options: { sourcePath: string; targetPath: string; text: string },
): Promise<SaveResult> {
  const { sourcePath, targetPath, text } = options;
  if (targetPath === sourcePath) {
    return { status: "failed", message: "Choose a different file name." };
  }
  try {
    if (await io.exists(targetPath)) {
      return {
        status: "failed",
        message: `${targetPath} already exists. Choose another name.`,
      };
    }
    const written = await io.write(targetPath, text, null);
    return {
      status: "saved",
      revision: written.revision,
      mtime: written.mtime,
      writtenText: text,
      complete: true,
    };
  } catch (error) {
    return { status: "failed", message: failureMessage(error) };
  }
}

export type ReloadPlan = "reread" | "defer" | "withhold";

/**
 * Confirms an app-owned format step may rewrite the file: it must still be the
 * revision this buffer last saved, otherwise the formatter would blindly
 * overwrite whatever changed. A failure to read the revision is a conflict, not
 * a green light.
 */
export async function checkFormatBaseline(
  io: DiskIo,
  options: { path: string; expectedRevision: string; bufferText: string },
): Promise<{ ok: true } | { ok: false; conflict: SaveConflict }> {
  const { path, expectedRevision, bufferText } = options;
  let current: string | null = null;
  try {
    current = await io.revision(path);
  } catch {
    current = null;
  }
  if (current === expectedRevision) return { ok: true };
  return {
    ok: false,
    conflict: {
      path,
      reason: current === null ? "missing" : "changed",
      expectedRevision,
      bufferText,
      currentRevision: current,
      reviewedRevision: null,
      reviewedText: null,
    },
  };
}
/**
 * What an external-change signal may do to this document.
 *
 * Dirty text is never replaced (the conflict dialog is the only route). A clean
 * hidden buffer defers the reread until it is visible again, so a background tab
 * cannot churn through reads it does not need.
 */
export function planReload(state: {
  dirty: boolean;
  visible: boolean;
  pendingReread: boolean;
}): ReloadPlan {
  if (state.dirty) return "withhold";
  if (!state.visible) return "defer";
  return "reread";
}

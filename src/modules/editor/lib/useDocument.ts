import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  checkFormatBaseline,
  commitBuffer,
  createSaveQueue,
  type DiskIo,
  type DiskTextRead,
  overwriteReviewed,
  planReload,
  reloadDiscard,
  reviewConflict,
  type SaveConflict,
  saveCopy,
  type SaveQueue,
  type SaveResult,
} from "./diskSync";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";

type ReadResult =
  | {
      kind: "text";
      content: string;
      size: number;
      mtime: number;
      revision: string;
    }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type FileStat = { size: number; mtime: number; kind: string };
type FileRevision = { revision: string; mtime: number; size: number };

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type Options = {
  path: string;
  /** Only a visible buffer rereads the disk on an external-change signal. */
  visible: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function useDocument({ path, visible, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const conflictRef = useRef<SaveConflict | null>(null);
  // Keep the ref in step synchronously: a queued save must see the conflict the
  // moment it is opened, not one render later.
  const setConflictNow = useCallback((next: SaveConflict | null) => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const eolRef = useRef<Eol>("\n");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoSaveTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Revision of the disk content this buffer is based on. Sent on every save so
  // native coordination can refuse a write that would drop someone else's.
  const diskRevisionRef = useRef<string | null>(null);

  // "Open anyway" is a per-file decision; every read of this document (including
  // the compare/reload reads of a conflict) honours it.
  const forceRef = useRef(false);

  // Explicit-user file access (tier A): no path policy, no workspace registry.
  const ioRef = useRef<DiskIo>({
    write: async (target, content, expectedRevision) =>
      invoke<{ mtime: number; revision: string }>("fs_write_file", {
        path: target,
        content: restoreEol(content, eolRef.current),
        workspace: currentWorkspaceEnv(),
        source: "editor",
        expectedRevision,
      }),
    read: async (target) => {
      const res = await invoke<ReadResult>("fs_read_file", {
        path: target,
        workspace: currentWorkspaceEnv(),
        force: forceRef.current,
      });
      if (res.kind !== "text") throw new Error("not a text file");
      return {
        content: res.content,
        revision: res.revision,
        mtime: res.mtime,
        size: res.size,
      };
    },
    exists: (target) =>
      invoke<FileStat>("fs_stat", {
        path: target,
        workspace: currentWorkspaceEnv(),
      }).then(
        () => true,
        () => false,
      ),
    revision: async (target) => {
      const res = await invoke<FileRevision>("fs_file_revision", {
        path: target,
        workspace: currentWorkspaceEnv(),
      });
      return res.revision;
    },
  });
  const io = ioRef.current;

  /** Adopts what a successful write left on disk. */
  const adoptSaved = useCallback(
    (result: Extract<SaveResult, { status: "saved" }>): boolean => {
      diskRevisionRef.current = result.revision;
      // The baseline is exactly what reached the disk; newer typing keeps the
      // buffer dirty and `save()` answers false for close guards.
      savedRef.current = result.writtenText;
      setDirty(bufferRef.current !== result.writtenText);
      return result.complete;
    },
    [],
  );

  const applySaveResult = useCallback(
    async (result: SaveResult): Promise<boolean> => {
      if (result.status === "saved") {
        setConflictNow(null);
        return adoptSaved(result);
      }
      if (result.status === "conflict") {
        setConflictNow(await reviewConflict(io, result.conflict));
        return false;
      }
      toast.error("Could not save file", { description: result.message });
      return false;
    },
    [adoptSaved, io, setConflictNow],
  );

  // One app-owned save at a time per document: the next save reads its text and
  // its expected revision only when it runs, after the previous save adopted the
  // revision it left behind. Otherwise newer typing during a slow save could
  // start a second write against the stale baseline and conflict with our own
  // commit.
  const saveQueueRef = useRef<SaveQueue | null>(null);
  if (saveQueueRef.current === null) saveQueueRef.current = createSaveQueue();
  const saveQueue = saveQueueRef.current;

  // False when the buffer was not fully persisted: a conflicting save, an I/O
  // failure, or edits typed while the write was in flight.
  const saveNow = useCallback(
    (): Promise<boolean> =>
      saveQueue.run(async () => {
        // While a conflict round is open the dialog owns the outcome; retrying
        // the write behind it would just re-detect the same conflict (autosave
        // would otherwise loop on every tick).
        if (conflictRef.current !== null) return false;
        const result = await commitBuffer(io, {
          path,
          expectedRevision: diskRevisionRef.current,
          buffer: () => bufferRef.current,
        });
        return applySaveResult(result);
      }),
    [applySaveResult, io, path, saveQueue],
  );

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Adopts a read result as the new saved baseline. `skipIfUnchanged` avoids
  // the re-render when disk already matches the buffer (self-save / duplicate
  // watcher event); initial loads must always publish a state.
  const adoptRead = useCallback((res: ReadResult, skipIfUnchanged = false) => {
    if (res.kind === "text") {
      eolRef.current = detectEol(res.content);
      diskRevisionRef.current = res.revision;
      const content = normalizeToLf(res.content);
      if (skipIfUnchanged && content === savedRef.current) return;
      savedRef.current = content;
      bufferRef.current = content;
      setDirty(false);
      setDoc({ status: "ready", content, size: res.size });
    } else if (res.kind === "binary") {
      setDoc({ status: "binary", size: res.size });
    } else if (res.kind === "toolarge") {
      setDoc({ status: "toolarge", size: res.size, limit: res.limit });
    }
  }, []);

  const readFromDisk = useCallback(
    (force: boolean) =>
      invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
        force,
      }),
    [path],
  );

  // Load on path change.
  useEffect(() => {
    let cancelled = false;
    // "Open anyway" is a per-file decision; a new path starts unforced.
    forceRef.current = false;
    setDoc({ status: "loading" });
    setDirty(false);
    setConflictNow(null);
    diskRevisionRef.current = null;

    readFromDisk(forceRef.current)
      .then((res) => {
        if (!cancelled) adoptRead(res);
      })
      .catch((e) => {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [readFromDisk, adoptRead, setConflictNow]);

  const openAnyway = useCallback(() => {
    forceRef.current = true;
    setDoc({ status: "loading" });
    readFromDisk(true)
      .then(adoptRead)
      .catch((e) => setDoc({ status: "error", message: String(e) }));
  }, [readFromDisk, adoptRead]);

  const pendingRereadRef = useRef(false);

  // Skipped while dirty: never clobber unsaved edits — that is what the conflict
  // dialog is for. A clean buffer that is not visible defers the reread instead
  // of widening it, so background tabs do not churn through reads.
  const reload = useCallback((): boolean => {
    const plan = planReload({
      dirty: dirtyRef.current,
      visible: visibleRef.current,
      pendingReread: pendingRereadRef.current,
    });
    if (plan === "withhold") return false;
    if (plan === "defer") {
      pendingRereadRef.current = true;
      return true;
    }
    pendingRereadRef.current = false;
    void readFromDisk(forceRef.current)
      .then((res) => {
        if (!dirtyRef.current) adoptRead(res, true);
      })
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      .catch((e) => console.warn("[editor] reload failed", path, e));
    return true;
  }, [readFromDisk, adoptRead, path]);

  // A deferred reread runs the moment the buffer becomes visible again.
  useEffect(() => {
    if (!visible || !pendingRereadRef.current) return;
    reload();
  }, [visible, reload]);

  const save = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer();
    if (bufferRef.current === savedRef.current) return true;
    return saveNow();
  }, [clearAutoSaveTimer, saveNow]);

  /**
   * Coordinates an app-owned format step: the file the formatter is about to
   * rewrite must still be the revision this buffer last saved. When it is not,
   * formatting would be a blind rewrite of someone else's text, so it turns into
   * the same conflict round as a save. The formatter process itself is an
   * independent writer — nothing here locks it out.
   */
  const canFormatOnDisk = useCallback(async (): Promise<boolean> => {
    const expected = diskRevisionRef.current;
    if (expected === null) return false;
    const state = await checkFormatBaseline(io, {
      path,
      expectedRevision: expected,
      bufferText: bufferRef.current,
    });
    if (state.ok) return true;
    setConflictNow(await reviewConflict(io, state.conflict));
    return false;
  }, [io, path, setConflictNow]);

  /**
   * Runs an app-owned format sequence (baseline check, external formatter,
   * read-back) exclusively with respect to saves. An autosave requested while
   * the formatter runs waits for the read-back and then writes against the
   * revision it adopted, instead of racing the formatter with a stale baseline
   * and conflicting with our own app-owned sequence.
   */
  const runFormatStep = useCallback(
    <T>(step: () => Promise<T>): Promise<T> => saveQueue.run(step),
    [saveQueue],
  );

  // Adopt externally formatted disk content as the saved baseline before the
  // matching editor dispatch lands, so the buffer never flashes dirty. The
  // formatter's own revision must become the known one, or the next save would
  // report its write as an external conflict.
  // Returns the LF-normalized text the caller should dispatch.
  const adoptDiskText = useCallback((disk: DiskTextRead): string => {
    eolRef.current = detectEol(disk.content);
    diskRevisionRef.current = disk.revision;
    const content = normalizeToLf(disk.content);
    savedRef.current = content;
    setDirty(bufferRef.current !== content);
    return content;
  }, []);

  /** Explicit overwrite of the reviewed revision. */
  const overwriteConflict = useCallback(async (): Promise<boolean> => {
    if (conflict === null) return false;
    return applySaveResult(
      await overwriteReviewed(io, conflict, () => bufferRef.current),
    );
  }, [applySaveResult, conflict, io]);

  /** Explicit reload/discard: the buffer text is thrown away by choice. */
  const reloadConflict = useCallback(async (): Promise<boolean> => {
    // Read-only: discarding never writes the abandoned buffer, and a file that
    // disappeared stays missing instead of being recreated.
    const result = await reloadDiscard(io, path);
    if (result.status === "failed") {
      toast.error("Could not reload file", { description: result.message });
      return false;
    }
    adoptRead({ kind: "text", ...result.disk });
    setConflictNow(null);
    return true;
  }, [adoptRead, io, path, setConflictNow]);

  /** Explicit Save As: the conflict is left on disk untouched. */
  const saveConflictCopy = useCallback(
    async (targetPath: string): Promise<boolean> => {
      const result = await saveCopy(io, {
        sourcePath: path,
        targetPath,
        text: bufferRef.current,
      });
      if (result.status === "saved") {
        // The buffer stays dirty against its own file: nothing was resolved
        // about the original, only a copy was made.
        setConflictNow(null);
        toast.success("Saved a copy", { description: targetPath });
        return true;
      }
      toast.error("Could not save a copy", {
        description: result.status === "failed" ? result.message : undefined,
      });
      return false;
    },
    [io, path, setConflictNow],
  );

  const dismissConflict = useCallback(
    () => setConflictNow(null),
    [setConflictNow],
  );

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      setDirty(isDirty);

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, delay);
      }
    },
    [clearAutoSaveTimer, saveNow],
  );

  useEffect(() => clearAutoSaveTimer, [path, clearAutoSaveTimer]);

  return {
    doc,
    dirty,
    onChange,
    save,
    reload,
    adoptDiskText,
    openAnyway,
    canFormatOnDisk,
    runFormatStep,
    conflict,
    overwriteConflict,
    reloadConflict,
    saveConflictCopy,
    dismissConflict,
  };
}

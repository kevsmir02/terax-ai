/**
 * The stored-drafts view behind the settings disclosure.
 *
 * `RecoveryStorageDisclosure` tells the person that a full quota pauses
 * recovery and that resolving a draft frees room. This module is the list that
 * makes that instruction actionable: every draft that actually exists in the
 * private folder, newest first, with the explicit discard that resolves exactly
 * one of them.
 *
 * It is deliberately pure, so the surface can be rendered without a DOM or a
 * timer: the component renders a state value and the controller turns storage
 * calls into those values. Nothing here predicts a write, and no path that is
 * not a stored record is ever added.
 */

import { isRecordablePath, recordBytes, type RecoveryRecord } from "./model";

/** Shown instead of a blank cell for a record with no usable path. */
export const UNKNOWN_DRAFT_PATH = "Unknown path";

export type StoredDraftRow = {
  /** The exact stored record; discard uses this identity, not the path. */
  record: RecoveryRecord;
  bufferId: string;
  /** Original file of the draft, or `null` when the record carries none. */
  path: string | null;
  /** What this record spends in the private folder (quota is byte-based). */
  bytes: number;
  updatedAt: number;
  /** Age of the stored copy when the list was built. */
  ageMs: number;
};

export type StoredDraftListState =
  | { kind: "loading" }
  | {
      kind: "ready";
      rows: StoredDraftRow[];
      count: number;
      totalBytes: number;
    }
  /** The private folder cannot be read at all (missing/unreadable volume). */
  | { kind: "unavailable"; message: string }
  /** A read failed for another reason; the list keeps a Retry. */
  | { kind: "failed"; message: string };

export type StoredDraftDiscardResult =
  | { ok: true; state: StoredDraftListState }
  | { ok: false; state: StoredDraftListState; message: string };

/** The two storage operations the list needs; the manager provides both. */
export type StoredDraftSource = {
  records(): Promise<RecoveryRecord[]>;
  discardDraft(record: RecoveryRecord): Promise<void>;
};

/**
 * What the list shows for `records`: known-sensitive paths are never offered
 * (they are not stored), an unknown path stays visible as such, and the newest
 * draft comes first so "discard one to free room" starts at the top.
 */
export function storedDraftRows(
  records: RecoveryRecord[],
  now: number,
): StoredDraftRow[] {
  const rows: StoredDraftRow[] = [];
  for (const record of records) {
    const path = record.path.trim();
    if (path !== "" && !isRecordablePath(record.path).recordable) continue;
    rows.push({
      record,
      bufferId: record.bufferId,
      path: path === "" ? null : record.path,
      bytes: recordBytes(record),
      updatedAt: record.updatedAt,
      ageMs: Math.max(0, now - record.updatedAt),
    });
  }
  return rows.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.bufferId.localeCompare(b.bufferId),
  );
}

/** Human size with binary units, matching how the quota is disclosed. */
export function formatDraftBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Whole-unit quota sizes, so the binding reads "100 MiB", not "100.0 MiB". */
export function formatDraftLimit(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

/** How old the stored copy is. Coarse on purpose: no ticking claim. */
export function formatDraftAge(ageMs: number): string {
  if (ageMs < 60_000) return "less than a minute old";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h old`;
  return `${Math.floor(hours / 24)} d old`;
}

function stateFromError(error: unknown): StoredDraftListState {
  const raw =
    typeof error === "object" && error !== null
      ? (error as { kind?: unknown; message?: unknown })
      : {};
  const message =
    typeof raw.message === "string" && raw.message !== ""
      ? raw.message
      : String(error);
  if (raw.kind === "unavailable") {
    return { kind: "unavailable", message };
  }
  return { kind: "failed", message };
}

export type StoredDraftList = {
  load(): Promise<StoredDraftListState>;
  /**
   * Discards exactly the offered record, then re-reads storage so a row only
   * disappears when the record is actually gone. A failed discard keeps the
   * row and reports why instead of pretending the space was freed.
   */
  discard(record: RecoveryRecord): Promise<StoredDraftDiscardResult>;
};

export function createStoredDraftList(input: {
  source: StoredDraftSource;
  now: () => number;
}): StoredDraftList {
  const { source, now } = input;

  const load = async (): Promise<StoredDraftListState> => {
    let records: RecoveryRecord[];
    try {
      records = await source.records();
    } catch (error) {
      return stateFromError(error);
    }
    const rows = storedDraftRows(records, now());
    return {
      kind: "ready",
      rows,
      count: rows.length,
      totalBytes: rows.reduce((total, row) => total + row.bytes, 0),
    };
  };

  return {
    load,
    async discard(record) {
      try {
        await source.discardDraft(record);
      } catch (error) {
        return {
          ok: false,
          state: await load(),
          message:
            typeof (error as { message?: unknown }).message === "string"
              ? (error as { message: string }).message
              : String(error),
        };
      }
      return { ok: true, state: await load() };
    },
  };
}

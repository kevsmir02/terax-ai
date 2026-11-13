/**
 * Durable unsaved-text recovery: the record model.
 *
 * A recovery record is the last *durably written* snapshot of one editor
 * buffer's unsaved text. It is deliberately separate from layout persistence
 * (`src/modules/spaces/lib/store.ts`) and from autosave of the original file:
 * recovery never writes a project file, it only keeps text in the app's private
 * storage until the user resolves it.
 *
 * Ownership is by **buffer identity**, never by path. Two Spaces may edit the
 * same pathname; they are two buffers with two identities and therefore two
 * independent records. The path is stored for display and for matching a
 * pre-crash orphan to a reopened document, and nothing else: cleanup, quota and
 * late-completion rules all key on `bufferId`.
 *
 * Revisions are distinguished on purpose:
 *  - `bufferRevision` is a monotonic counter of this buffer's own text. It
 *    orders snapshots and is what a late completion compares against.
 *  - `diskRevision` is ticket #15's opaque `r1:<digest>:<size>:<identity>`
 *    revision the text was edited from. It is how a recovered draft knows
 *    whether the file it came from still matches.
 *
 * Known limitation: path-based sensitivity exclusion is a *policy* check, not
 * complete secret detection. A secret in an innocuously named file is still
 * recorded if the user opts in, which is why enabling recovery is explicit and
 * the storage location is disclosed.
 */

import { checkReadable } from "@/modules/workspace/policy";
import policy from "./policy.json";

export type RecoveryLimits = {
  /** Bound on one buffer's stored record (draft text + JSON envelope). */
  perFileBytes: number;
  /** Bound on the whole recovery directory. */
  totalBytes: number;
  /** Private subdirectory of the app data directory that holds records. */
  directory: string;
};

export const RECOVERY_LIMITS: RecoveryLimits = {
  perFileBytes: policy.perFileBytes,
  totalBytes: policy.totalBytes,
  directory: policy.directory,
};

export type RecoveryRecord = {
  /** Format marker. A record from a future build is ignored, not interpreted. */
  version: 1;
  /** Stable identity of the buffer that owns this text. */
  bufferId: string;
  /** Space the owning buffer belongs to. */
  spaceId: string;
  /** Original file the buffer was opened from (display/matching only). */
  path: string;
  /** Original-file identity from the disk revision (`dev-ino`), "" if unknown. */
  fileIdentity: string;
  /** Monotonic revision of this buffer's text, starting at 1. */
  bufferRevision: number;
  /** Disk revision the text was edited from; null when never read (new file). */
  diskRevision: string | null;
  /** The unsaved text itself. */
  text: string;
  /** UTF-8 size of `text` (what the draft would cost on save, for display). */
  bytes: number;
  /** Epoch ms of the successful write that produced this record. */
  updatedAt: number;
};

const encoder = new TextEncoder();

/** UTF-8 byte length. Quota is byte-based, not character-based. */
export function textBytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * What one stored record costs. Quota limits are measured on this, because it
 * is what the private recovery directory actually spends (the native store
 * writes exactly this serialization), and it is what `recovery_usage` sums.
 */
export function recordBytes(record: RecoveryRecord): number {
  return textBytes(JSON.stringify(record));
}

/**
 * Stable identity of one buffer instance.
 *
 * `sessionId` changes every launch, so a buffer created after a crash never
 * silently inherits a pre-crash record: the old record stays orphaned and is
 * offered for restore instead. `spaceId` and `tabId` keep two Spaces (and two
 * tabs) apart even when they edit the same pathname.
 */
export function bufferIdFor(input: {
  sessionId: string;
  spaceId: string;
  tabId: number;
}): string {
  // The Space id is hashed rather than embedded: two ids that differ only in a
  // character that sanitizes the same way must not share a buffer identity.
  const hash = fnv1a(input.spaceId).toString(36);
  return `buf-${input.sessionId}-t${input.tabId}-${hash}`;
}

/** A new per-process identity. Not a security token; uniqueness only. */
export function newSessionId(): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${time}${random}`;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

const DISK_REVISION = /^r1:[0-9a-f]{64}:\d+:(.+)$/;

/**
 * File identity portion of a ticket-#15 disk revision. `null` for a revision
 * this build did not produce; recovery then treats the original as unknown
 * rather than pretending it matches.
 */
export function diskIdentityOf(diskRevision: string | null): string | null {
  if (diskRevision === null) return null;
  const match = DISK_REVISION.exec(diskRevision);
  return match ? match[1] : null;
}

export type PathVerdict =
  | { recordable: true }
  | { recordable: false; reason: string };

/**
 * Whether this buffer's text may be recorded at all.
 *
 * Reuses the workspace secret-path policy (`checkReadable`, the same data and
 * matcher the automatic file consumers use) instead of keeping a second list.
 * It is not complete secret detection: only known names/locations are refused,
 * and the disclosure says so.
 */
export function isRecordablePath(path: string): PathVerdict {
  const verdict = checkReadable(path);
  if (verdict.ok) return { recordable: true };
  return { recordable: false, reason: verdict.reason };
}

/**
 * Validates a stored record. Anything this build did not write returns `null`
 * so a corrupt or future file is ignored rather than offered as recovery.
 */
export function parseRecord(raw: string): RecoveryRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<RecoveryRecord>;
  if (record.version !== 1) return null;
  if (typeof record.bufferId !== "string" || record.bufferId.length === 0) {
    return null;
  }
  if (typeof record.spaceId !== "string") return null;
  if (typeof record.path !== "string" || record.path.length === 0) return null;
  if (typeof record.fileIdentity !== "string") return null;
  if (
    typeof record.bufferRevision !== "number" ||
    !Number.isInteger(record.bufferRevision) ||
    record.bufferRevision < 1
  ) {
    return null;
  }
  if (record.diskRevision !== null && typeof record.diskRevision !== "string") {
    return null;
  }
  if (typeof record.text !== "string") return null;
  if (
    typeof record.bytes !== "number" ||
    record.bytes !== textBytes(record.text)
  ) {
    return null;
  }
  if (typeof record.updatedAt !== "number") return null;
  return {
    version: 1,
    bufferId: record.bufferId,
    spaceId: record.spaceId,
    path: record.path,
    fileIdentity: record.fileIdentity,
    bufferRevision: record.bufferRevision,
    diskRevision: record.diskRevision,
    text: record.text,
    bytes: record.bytes,
    updatedAt: record.updatedAt,
  };
}

/** Builds a record for one buffer revision, filling derived fields. */
export function makeRecord(input: {
  bufferId: string;
  spaceId: string;
  path: string;
  diskRevision: string | null;
  bufferRevision: number;
  text: string;
  updatedAt: number;
}): RecoveryRecord {
  return {
    version: 1,
    bufferId: input.bufferId,
    spaceId: input.spaceId,
    path: input.path,
    fileIdentity: diskIdentityOf(input.diskRevision) ?? "",
    bufferRevision: input.bufferRevision,
    diskRevision: input.diskRevision,
    text: input.text,
    bytes: textBytes(input.text),
    updatedAt: input.updatedAt,
  };
}

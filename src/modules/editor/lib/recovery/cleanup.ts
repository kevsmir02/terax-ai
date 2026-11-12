/**
 * Recovery selection rules: what a cleanup may delete, what a late completion
 * may still write, and how a pre-crash draft is offered back.
 *
 * These are pure functions on purpose — they carry the invariants that are
 * easiest to get wrong and hardest to see in a UI:
 *  - cleanup resolves *one buffer revision*, never "the file's draft", so a
 *    newer revision of the same buffer and another Space's draft of the same
 *    pathname both survive;
 *  - a completion that lost the race against a save/discard is dropped, so it
 *    cannot resurrect resolved text or overwrite a newer record;
 *  - a recovered draft is only ever *offered* for the same Space and path, and
 *    its plan never includes writing the original file.
 */

import type { RecoveryRecord } from "./model";

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export type CleanupPlan = {
  remove: RecoveryRecord[];
  keep: RecoveryRecord[];
};

/**
 * The records an explicit save/discard of `resolvedRevision` resolves.
 *
 * `bufferId` is the owner: another buffer (another Space, or another tab) is
 * never touched even when it edits the same pathname. `resolvedRevision` is
 * inclusive — records *newer* than the text that was saved are kept, because
 * they are typing that happened after the saved snapshot (the save-and-close
 * case).
 */
export function planCleanup(
  records: readonly RecoveryRecord[],
  resolution: { bufferId: string; resolvedRevision: number },
): CleanupPlan {
  const remove: RecoveryRecord[] = [];
  const keep: RecoveryRecord[] = [];
  for (const record of records) {
    const resolved =
      record.bufferId === resolution.bufferId &&
      record.bufferRevision <= resolution.resolvedRevision;
    (resolved ? remove : keep).push(record);
  }
  return { remove, keep };
}

/**
 * Whether a write may still land: a write whose buffer revision was already
 * resolved (saved or discarded) must be dropped, not stored, or the resolved
 * text would reappear as a draft after the user resolved it.
 */
export function isStaleCompletion(
  record: RecoveryRecord,
  state: { bufferId: string; retireThrough: number },
): boolean {
  if (record.bufferId !== state.bufferId) return false;
  return record.bufferRevision <= state.retireThrough;
}

/**
 * Whether `incoming` may replace `stored`. Revisions are per buffer, so this is
 * only non-trivial across restarts and re-opened orphans: an older completion
 * must never overwrite a newer stored record.
 */
export function newerThan(
  incoming: RecoveryRecord,
  stored: RecoveryRecord | null,
): boolean {
  if (stored === null) return true;
  if (stored.bufferId !== incoming.bufferId) return false;
  return incoming.bufferRevision > stored.bufferRevision;
}

/**
 * Drafts a reopened document may be offered: records from the same Space that
 * name the same original path and are not owned by the live buffer.
 *
 * Space + path is a *matching* rule, not an ownership rule. Two Spaces editing
 * one pathname stay independent because the offer is scoped to the Space and
 * the record keeps its own identity; adopting one never touches the other.
 */
export function findRecoverable(
  records: readonly RecoveryRecord[],
  input: { bufferId: string; spaceId: string; path: string },
): RecoveryRecord[] {
  const path = normalizedPath(input.path);
  return records
    .filter(
      (record) =>
        record.bufferId !== input.bufferId &&
        record.spaceId === input.spaceId &&
        normalizedPath(record.path) === path,
    )
    .sort((a, b) => b.bufferRevision - a.bufferRevision);
}

export type DiskTarget =
  | { status: "present"; revision: string }
  | { status: "missing" }
  | { status: "unreadable" };

export type RestorePlan =
  | { kind: "adopt" }
  | { kind: "compare"; reason: "changed" | "missing" | "unreadable" };

/**
 * What may be done with a recovered draft.
 *
 * `adopt` puts the text back into the *editor buffer* (dirty, unsaved) when the
 * original file is still the revision the draft was edited from. Everything
 * else — changed, replaced/moved, missing, unreadable — is a comparison, and
 * the only writes offered are Save As to a chosen path. There is deliberately
 * no plan variant that writes the original file: recovery is never writeback.
 */
export function planRestore(
  record: RecoveryRecord,
  disk: DiskTarget,
): RestorePlan {
  if (disk.status === "present") {
    if (record.diskRevision !== null && disk.revision === record.diskRevision) {
      return { kind: "adopt" };
    }
    return { kind: "compare", reason: "changed" };
  }
  if (disk.status === "missing") {
    // A buffer that was never read from disk (new text) has nothing to
    // compare against; a missing original still means Save As only.
    return record.diskRevision === null
      ? { kind: "adopt" }
      : { kind: "compare", reason: "missing" };
  }
  return { kind: "compare", reason: "unreadable" };
}

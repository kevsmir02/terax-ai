/**
 * Recovery quota accounting.
 *
 * The policy is 10 MiB per file and 100 MiB total (see `policy.json`). The rule
 * that matters is what happens at the bound: recovery **pauses** and keeps the
 * older valid record. Nothing here evicts an unrecovered draft to make room for
 * a newer one, because the draft it would drop is unsaved user text.
 *
 * This module is the frontend's admission check (so the UI can explain a
 * refusal without an IPC round-trip). The native store enforces the same
 * numbers from the same JSON file, authoritatively, because two running app
 * instances share the directory.
 */

export type QuotaLimits = { perFileBytes: number; totalBytes: number };

export type QuotaRefusal = "file-limit" | "total-limit";

export type Admission = { ok: true } | { ok: false; reason: QuotaRefusal };

/**
 * Whether `incomingBytes` may replace a record that currently occupies
 * `existingBytes`, given the directory's `usedBytes`.
 *
 * `existingBytes` is subtracted because a write replaces this buffer's record;
 * at the total bound, continuing to edit one buffer must not be paused until it
 * actually grows.
 */
export function admitWrite(input: {
  existingBytes: number;
  incomingBytes: number;
  usedBytes: number;
  limits: QuotaLimits;
}): Admission {
  const { existingBytes, incomingBytes, usedBytes, limits } = input;
  if (incomingBytes > limits.perFileBytes) {
    return { ok: false, reason: "file-limit" };
  }
  const totalAfter = usedBytes - existingBytes + incomingBytes;
  if (totalAfter > limits.totalBytes) {
    return { ok: false, reason: "total-limit" };
  }
  return { ok: true };
}

/** The pause state a refusal puts the buffer (or the whole feature) in. */
export function quotaPauseReason(reason: QuotaRefusal): QuotaRefusal {
  return reason;
}

/**
 * Whether a paused recovery may resume: the pending draft has to fit in the
 * directory again, which happens when a resolved draft was deleted or the text
 * shrank. No draft is deleted to create the room.
 */
export function canResume(input: {
  pendingBytes: number;
  usedBytes: number;
  limits: QuotaLimits;
}): boolean {
  return input.usedBytes + input.pendingBytes <= input.limits.totalBytes;
}

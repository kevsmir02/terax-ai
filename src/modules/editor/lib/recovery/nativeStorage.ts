/**
 * The Tauri binding for recovery storage.
 *
 * The native store (`src-tauri/src/modules/recovery.rs`) is a durable, private,
 * quota-enforcing directory; everything that needs judgment stays in the
 * frontend domain modules. This adapter only crosses the IPC boundary and
 * validates what comes back, so a corrupt or future record is ignored instead
 * of offered as recovery.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  parseRecord,
  type RecoveryRecord,
  RECOVERY_LIMITS,
} from "./model";
import type {
  RecoveryRemoveOutcome,
  RecoveryStorage,
  RecoveryWriteOutcome,
} from "./manager";

type Usage = { totalBytes: number; records: number };
type RemovePayload = {
  removed: boolean;
  revision: number | null;
  totalBytes: number;
};

export const nativeRecoveryStorage: RecoveryStorage = {
  async list() {
    const records = await invoke<string[]>("recovery_list");
    const parsed: RecoveryRecord[] = [];
    for (const raw of records) {
      const record = parseRecord(raw);
      if (record !== null) parsed.push(record);
    }
    return parsed;
  },
  write(record: RecoveryRecord): Promise<RecoveryWriteOutcome> {
    return invoke<RecoveryWriteOutcome>("recovery_put", {
      record: JSON.stringify(record),
    });
  },
  remove(
    bufferId: string,
    upToRevision: number,
  ): Promise<RecoveryRemoveOutcome> {
    return invoke<RemovePayload>("recovery_remove", {
      bufferId,
      upToRevision,
    });
  },
  async usage() {
    const usage = await invoke<Usage>("recovery_usage");
    return usage.totalBytes;
  },
};

export type RecoveryLocation = {
  /** Private directory holding the records (disclosed in the UI). */
  root: string;
  available: boolean;
};

/** Where drafts would be stored, and whether that directory is usable. */
export function recoveryLocation(): Promise<RecoveryLocation> {
  return invoke<RecoveryLocation>("recovery_location");
}

/** The disclosed policy, for the settings text and status line. */
export function recoveryPolicy(): {
  perFileBytes: number;
  totalBytes: number;
} {
  return {
    perFileBytes: RECOVERY_LIMITS.perFileBytes,
    totalBytes: RECOVERY_LIMITS.totalBytes,
  };
}

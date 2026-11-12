/**
 * Per-buffer recovery view for the editor.
 *
 * The buffer identity is allocated once per mounted editor buffer and is what
 * owns its record: two Spaces editing one pathname get two identities. The
 * session id is per launch, so after a crash the old record is *offered* to the
 * same Space's document instead of being silently claimed by a new buffer.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RecoveryRecord } from "./model";
import { bufferIdFor, newSessionId } from "./model";
import type { RecoveryStatus } from "./manager";
import { recoveryManager } from "./service";

const SESSION_ID = newSessionId();

/**
 * The buffer identity a tab's editor buffer uses. The quit survey needs it to
 * ask the manager about the same buffer the mounted editor wrote under; without
 * it, a draft would be looked up under an id nobody used and would look saved.
 */
export function recoveryBufferIdFor(
  spaceId: string,
  tabId: number,
): string {
  return bufferIdFor({ sessionId: SESSION_ID, spaceId, tabId });
}

export type RecoveryView = {
  bufferId: string;
  status: RecoveryStatus;
  /** Drafts from a previous session for this Space and path. */
  drafts: RecoveryRecord[];
  edit(text: string, diskRevision: string | null): number;
  revisionOf(text: string): number | null;
  saved(writtenText: string, resolvedRevision?: number): void;
  discard(): void;
  retry(): void;
  retarget(path: string, diskRevision: string | null): void;
  /** The draft's text is now in this buffer: remove the orphan once durable. */
  restore(record: RecoveryRecord): void;
  dismissDraft(record: RecoveryRecord): Promise<void>;
  refreshDrafts(): Promise<void>;
};

export function useRecovery(input: {
  spaceId: string;
  tabId: number;
  path: string;
  enabled: boolean;
}): RecoveryView {
  const { spaceId, tabId, path, enabled } = input;
  const manager = useMemo(() => recoveryManager(), []);
  const bufferId = useMemo(
    () => bufferIdFor({ sessionId: SESSION_ID, spaceId, tabId }),
    [spaceId, tabId],
  );

  const handle = useMemo(
    () =>
      manager.buffer({
        bufferId,
        spaceId,
        path,
        diskRevision: null,
      }),
    [manager, bufferId, spaceId, path],
  );

  const [status, setStatus] = useState<RecoveryStatus>(() => handle.status());
  const [drafts, setDrafts] = useState<RecoveryRecord[]>([]);

  useEffect(() => {
    setStatus(handle.status());
    return handle.subscribe(() => setStatus(handle.status()));
  }, [handle]);

  // Turning the feature on/off is a live change: the manager stops scheduling
  // without touching records, and enabling re-arms pending text.
  useEffect(() => {
    manager.enabledChanged();
    setStatus(handle.status());
  }, [manager, handle, enabled]);

  const refreshDrafts = useCallback(async () => {
    if (!enabled) {
      setDrafts([]);
      return;
    }
    try {
      const found = await manager.recoverable({ bufferId, spaceId, path });
      setDrafts(found);
    } catch (error) {
      console.warn("[recovery] could not read drafts", error);
    }
  }, [manager, bufferId, spaceId, path, enabled]);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  return useMemo<RecoveryView>(
    () => ({
      bufferId,
      status,
      drafts,
      edit: (text, diskRevision) => handle.edit({ text, diskRevision }),
      revisionOf: (text) => handle.revisionOf(text),
      saved: (writtenText, resolvedRevision) => {
        void handle.saved({ writtenText, resolvedRevision });
      },
      discard: () => {
        void handle.discard();
      },
      retry: () => handle.retry(),
      retarget: (nextPath, diskRevision) =>
        handle.retarget({ path: nextPath, diskRevision }),
      restore: (record) => {
        manager.adopt({ record, bufferId });
        setDrafts((current) =>
          current.filter((draft) => draft.bufferId !== record.bufferId),
        );
      },
      dismissDraft: async (record) => {
        await manager.discardDraft(record);
        setDrafts((current) =>
          current.filter((draft) => draft.bufferId !== record.bufferId),
        );
      },
      refreshDrafts,
    }),
    [bufferId, status, drafts, handle, manager, refreshDrafts],
  );
}

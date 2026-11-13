/**
 * Stored-draft list for the recovery settings disclosure.
 *
 * This is the executable half of the quota message: recovery pauses at 100 MiB
 * and tells the person to discard a draft, so the settings disclosure has to
 * show which drafts exist and resolve exactly one of them. Discarding removes
 * the private stored copy only — the project file on disk is untouched, and no
 * unrecovered draft is ever evicted on someone else's behalf.
 */

import { Button } from "@/components/ui/button";
import {
  createStoredDraftList,
  formatDraftAge,
  formatDraftBytes,
  formatDraftLimit,
  type StoredDraftListState,
  UNKNOWN_DRAFT_PATH,
} from "@/modules/editor/lib/recovery/draftList";
import type { RecoveryRecord } from "@/modules/editor/lib/recovery/model";
import { recoveryManager } from "@/modules/editor/lib/recovery/service";
import { useCallback, useEffect, useMemo, useState } from "react";

/** The discard copy, used on the row and stated once above the list. */
const DISCARD_NOTE =
  "Discarding removes only the stored copy; your file on disk is untouched.";

export type RecoveryDraftListBodyProps = {
  state: StoredDraftListState;
  /** The disclosed total bound, so the list measures against the same number. */
  quotaBytes: number;
  /** A failed discard, reported without hiding the row that is still stored. */
  discardError: string | null;
  onDiscard: (record: RecoveryRecord) => void;
  onReload: () => void;
};

/** DOM-free rendering of one list state; the stateful wrapper is below. */
export function RecoveryDraftListBody({
  state,
  quotaBytes,
  discardError,
  onDiscard,
  onReload,
}: RecoveryDraftListBodyProps) {
  if (state.kind === "loading") {
    return (
      <p className="text-[11px] text-muted-foreground">
        Loading stored drafts…
      </p>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <p className="text-[11px] text-destructive">
        Stored drafts are unavailable right now; nothing can be listed or
        discarded ({state.message}).
      </p>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="flex flex-col gap-1 text-[11px]">
        <p className="text-destructive">
          Could not read stored drafts: {state.message}
        </p>
        <div>
          <Button type="button" variant="outline" size="xs" onClick={onReload}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]">
      {state.count === 0 ? (
        <p className="text-muted-foreground">No stored drafts.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {state.count} stored {state.count === 1 ? "draft" : "drafts"} ·{" "}
            {formatDraftBytes(state.totalBytes)} of{" "}
            {formatDraftLimit(quotaBytes)}
          </p>
          <ul className="flex flex-col gap-1">
            {state.rows.map((row) => (
              <li
                key={row.bufferId}
                className="flex items-center justify-between gap-3 rounded border border-border bg-background px-2 py-1"
              >
                <span className="min-w-0">
                  <span className="block font-mono break-all text-foreground">
                    {row.path ?? UNKNOWN_DRAFT_PATH}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDraftBytes(row.bytes)} · {formatDraftAge(row.ageMs)}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  title={DISCARD_NOTE}
                  aria-label={`Discard the stored copy of ${
                    row.path ?? UNKNOWN_DRAFT_PATH
                  }. ${DISCARD_NOTE}`}
                  onClick={() => onDiscard(row.record)}
                >
                  Discard
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">{DISCARD_NOTE}</p>
        </>
      )}
      {discardError !== null && (
        <p className="text-destructive">Could not discard: {discardError}</p>
      )}
    </div>
  );
}

/**
 * Reads the stored drafts from the one recovery manager and keeps the list in
 * step with a discard. The load is a plain async read: there is no timer and no
 * optimistic row removal, so a row disappears only after storage says it is
 * gone.
 */
export function RecoveryDraftList({ quotaBytes }: { quotaBytes: number }) {
  const manager = useMemo(() => recoveryManager(), []);
  const list = useMemo(
    () => createStoredDraftList({ source: manager, now: () => Date.now() }),
    [manager],
  );
  const [state, setState] = useState<StoredDraftListState>({ kind: "loading" });
  const [discardError, setDiscardError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void list.load().then(setState);
  }, [list]);

  useEffect(() => {
    let alive = true;
    void list.load().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [list]);

  const discard = useCallback(
    (record: RecoveryRecord) => {
      void list.discard(record).then((result) => {
        setState(result.state);
        setDiscardError(result.ok ? null : result.message);
      });
    },
    [list],
  );

  return (
    <RecoveryDraftListBody
      state={state}
      quotaBytes={quotaBytes}
      discardError={discardError}
      onDiscard={discard}
      onReload={reload}
    />
  );
}

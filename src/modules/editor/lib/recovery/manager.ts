/**
 * Recovery orchestration: one manager, one small handle per editor buffer.
 *
 * The pieces it composes are pure (`model`, `quota`, `cleanup`) or narrowly
 * scoped (`scheduler`); this module owns the mutable per-buffer state and the
 * ordering rules that make recovery safe:
 *
 *  - **Ownership.** All storage calls are keyed by `bufferId`. Two Spaces that
 *    edit the same pathname are two handles, two ids, two records.
 *  - **One operation chain per buffer.** Writes and deletes of a buffer run in
 *    the order they were decided, so a slow write cannot land after the delete
 *    that resolved it.
 *  - **Retirement watermark.** A save or discard retires the revisions it
 *    resolved *before* queueing the delete, so a completion that was already in
 *    the chain is dropped instead of resurrecting resolved text.
 *  - **Revision-aware deletes.** The storage adapter deletes only when the
 *    stored revision is at or below the resolved one, so a late delete can
 *    never remove newer typing.
 *  - **Acknowledged means durable.** Status is `pending` while a write is in
 *    flight; only a resolved storage write produces `durable`. A failure keeps
 *    the older stored record and says so.
 *  - **Quota pauses, never evicts.** A refused write leaves every existing
 *    draft untouched; the feature stops scheduling until room is freed by a
 *    resolved draft (or the text shrinks).
 */

import {
  findRecoverable,
  isStaleCompletion,
  planCleanup,
} from "./cleanup";
import {
  isRecordablePath,
  makeRecord,
  type PathVerdict,
  RECOVERY_LIMITS,
  type RecoveryLimits,
  type RecoveryRecord,
  recordBytes,
  textBytes,
} from "./model";
import { admitWrite, type QuotaRefusal } from "./quota";
import { createCoalescer, RECOVERY_COALESCE_MS } from "./scheduler";

/** Failures a storage adapter reports, discriminated so status can be precise. */
export type RecoveryStorageFailure =
  | { kind: "quota"; reason: QuotaRefusal }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

export type RecoveryWriteOutcome = { totalBytes: number };
export type RecoveryRemoveOutcome = { removed: boolean; totalBytes: number };

/**
 * The durable surface. `write` replaces this buffer's record atomically (a
 * failed write leaves the previous record intact) and throws a
 * `RecoveryStorageFailure` on refusal; `remove` deletes only when the stored
 * revision is at or below `upToRevision`.
 */
export type RecoveryStorage = {
  list(): Promise<RecoveryRecord[]>;
  write(record: RecoveryRecord): Promise<RecoveryWriteOutcome>;
  remove(bufferId: string, upToRevision: number): Promise<RecoveryRemoveOutcome>;
  usage(): Promise<number>;
};

export type RecoveryStatusKind =
  | "off"
  | "idle"
  | "excluded"
  | "pending"
  | "durable"
  | "failed"
  | "paused"
  | "unavailable";

export type RecoveryStatus = {
  kind: RecoveryStatusKind;
  bufferId: string;
  /** Revision of the newest text in the buffer, when known. */
  bufferRevision: number | null;
  /** Newest revision that actually reached private storage. */
  durableRevision: number | null;
  /** Bytes the newest draft would cost. */
  bytes: number;
  /** Total recovery bytes the last observation saw. */
  totalBytes: number;
  message?: string;
  reason?: QuotaRefusal;
};

export type RecoveryManagerDeps = {
  storage: RecoveryStorage;
  /** Live feature switch: recovery is opt-in and off by default. */
  enabled: () => boolean;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  limits?: RecoveryLimits;
  coalesceMs?: number;
  /** Injected for tests; defaults to the shared path policy. */
  isRecordable?: (path: string) => PathVerdict;
};

export type BufferRecovery = {
  readonly bufferId: string;
  status(): RecoveryStatus;
  subscribe(listener: () => void): () => void;
  /** Records one dirty edit; returns this buffer's new revision. */
  edit(input: { text: string; diskRevision: string | null }): number;
  /** Revision of a text this buffer has seen, if it is still tracked. */
  revisionOf(text: string): number | null;
  /** A successful explicit save resolved `writtenText`'s revision. */
  saved(input: {
    writtenText: string;
    resolvedRevision?: number;
  }): Promise<void>;
  /** Explicit discard: resolves the current revision and drops its write. */
  discard(): Promise<void>;
  retry(): void;
  /** Save As succeeded: the same buffer now belongs to `path`. */
  retarget(input: { path: string; diskRevision: string | null }): void;
  /** Buffer gone (tab closed). Its durable record stays. */
  dispose(): void;
};

export type RecoveryManager = {
  buffer(input: {
    bufferId: string;
    spaceId: string;
    path: string;
    diskRevision: string | null;
  }): BufferRecovery;
  bufferById(bufferId: string): BufferRecovery | null;
  enabledChanged(): void;
  records(): Promise<RecoveryRecord[]>;
  recoverable(input: {
    bufferId: string;
    spaceId: string;
    path: string;
  }): Promise<RecoveryRecord[]>;
  /** Keeps the orphan alive until `bufferId` writes its own durable record. */
  adopt(input: { record: RecoveryRecord; bufferId: string }): void;
  /** Drops a recovered draft the user explicitly discarded. */
  discardDraft(record: RecoveryRecord): Promise<void>;
  /** Bounded flush for quit: writes every pending buffer now. */
  flushAll(): Promise<Map<string, RecoveryStatus>>;
};

const HISTORY_LIMIT = 8;

function failureOf(error: unknown): RecoveryStorageFailure {
  if (typeof error === "object" && error !== null) {
    const raw = error as { kind?: unknown; reason?: unknown; message?: unknown };
    if (
      raw.kind === "quota" &&
      (raw.reason === "file-limit" || raw.reason === "total-limit")
    ) {
      return { kind: "quota", reason: raw.reason };
    }
    if (raw.kind === "unavailable") {
      return {
        kind: "unavailable",
        message:
          typeof raw.message === "string" ? raw.message : "Recovery storage is unavailable.",
      };
    }
    if (typeof raw.message === "string" && raw.message) {
      return { kind: "failed", message: raw.message };
    }
  }
  return { kind: "failed", message: String(error) };
}

type BufferState = {
  bufferId: string;
  spaceId: string;
  path: string;
  diskRevision: string | null;
  revision: number;
  history: Array<{ revision: number; text: string }>;
  pending: { revision: number; text: string } | null;
  persisted: { revision: number; text: string; bytes: number } | null;
  retireThrough: number;
  failure: RecoveryStorageFailure | null;
  paused: QuotaRefusal | null;
  totalBytes: number;
  chain: Promise<void>;
  coalescer: ReturnType<typeof createCoalescer>;
  listeners: Set<() => void>;
  adopted: RecoveryRecord[];
  disposed: boolean;
};

export function createRecoveryManager(
  deps: RecoveryManagerDeps,
): RecoveryManager {
  const {
    storage,
    enabled,
    now,
    schedule,
    cancel,
    limits = RECOVERY_LIMITS,
    coalesceMs = RECOVERY_COALESCE_MS,
    isRecordable = isRecordablePath,
  } = deps;

  const buffers = new Map<string, BufferState>();
  /** Set when the total bound was hit: no buffer schedules until room frees. */
  let quotaPaused = false;

  const notify = (state: BufferState) => {
    for (const listener of [...state.listeners]) listener();
  };

  const statusOf = (state: BufferState): RecoveryStatus => {
    const newest = state.pending ?? state.persisted;
    const base = {
      bufferId: state.bufferId,
      bufferRevision: state.pending?.revision ?? state.persisted?.revision ?? null,
      durableRevision: state.persisted?.revision ?? null,
      bytes:
        state.pending === null
          ? (state.persisted?.bytes ?? 0)
          : textBytes(state.pending.text),
      totalBytes: state.totalBytes,
    };
    if (!enabled()) {
      return { ...base, kind: "off" };
    }
    const verdict = isRecordable(state.path);
    if (!verdict.recordable) {
      return { ...base, kind: "excluded", message: verdict.reason };
    }
    if (state.failure?.kind === "unavailable") {
      return { ...base, kind: "unavailable", message: state.failure.message };
    }
    if (state.paused || quotaPaused) {
      return {
        ...base,
        kind: "paused",
        reason: quotaPaused ? "total-limit" : (state.paused ?? "total-limit"),
        message:
          quotaPaused || state.paused === "total-limit"
            ? "Recovery storage is full. Resolve or discard a draft to free room; nothing was evicted."
            : "This draft is larger than the 10 MiB per-file recovery limit.",
      };
    }
    if (state.failure && state.failure.kind !== "quota") {
      return { ...base, kind: "failed", message: state.failure.message };
    }
    if (newest === null) {
      return { ...base, kind: "idle" };
    }
    if (state.pending !== null && state.pending.revision > (state.persisted?.revision ?? 0)) {
      return { ...base, kind: "pending" };
    }
    if (state.persisted !== null) {
      return { ...base, kind: "durable" };
    }
    return { ...base, kind: "idle" };
  };

  const setStatus = (state: BufferState) => notify(state);

  const enqueue = (state: BufferState, op: () => Promise<void>): Promise<void> => {
    const run = state.chain.then(op, op);
    state.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const clearFailure = (state: BufferState) => {
    state.failure = null;
  };

  /** Re-evaluates the total-bound pause after bytes were freed. */
  const tryResume = () => {
    if (!quotaPaused) return;
    quotaPaused = false;
    for (const state of buffers.values()) {
      if (state.disposed) continue;
      if (state.pending !== null) {
        // The pause cancelled this buffer's timer, so it needs a fresh one.
        state.coalescer.cancel();
        state.coalescer = freshCoalescer(state);
        state.coalescer.touch();
      }
      notify(state);
    }
  };

  const pauseAll = () => {
    quotaPaused = true;
    for (const state of buffers.values()) {
      state.coalescer.cancel();
      notify(state);
    }
  };

  const persist = async (state: BufferState): Promise<void> => {
    if (state.disposed || !enabled()) return;
    const pending = state.pending;
    if (pending === null) return;
    if (quotaPaused) return;
    const verdict = isRecordable(state.path);
    if (!verdict.recordable) {
      setStatus(state);
      return;
    }

    const record = makeRecord({
      bufferId: state.bufferId,
      spaceId: state.spaceId,
      path: state.path,
      diskRevision: state.diskRevision,
      bufferRevision: pending.revision,
      text: pending.text,
      updatedAt: now(),
    });

    if (isStaleCompletion(record, state)) {
      state.pending = null;
      setStatus(state);
      return;
    }

    const incoming = recordBytes(record);
    await enqueue(state, async () => {
      // Re-check after the queue: a save or discard may have resolved this
      // revision while the write waited its turn.
      if (state.disposed) return;
      if (isStaleCompletion(record, state)) {
        if (state.pending?.revision === record.bufferRevision) state.pending = null;
        setStatus(state);
        return;
      }
      let used: number;
      try {
        used = await storage.usage();
      } catch (error) {
        state.failure = failureOf(error);
        setStatus(state);
        return;
      }
      const admission = admitWrite({
        existingBytes: state.persisted?.bytes ?? 0,
        incomingBytes: incoming,
        usedBytes: used,
        limits,
      });
      if (!admission.ok) {
        if (admission.reason === "total-limit") {
          pauseAll();
        } else {
          state.paused = admission.reason;
          state.coalescer.cancel();
          notify(state);
        }
        return;
      }
      try {
        const outcome = await storage.write(record);
        state.persisted = {
          revision: record.bufferRevision,
          text: record.text,
          bytes: incoming,
        };
        state.totalBytes = outcome.totalBytes;
        state.paused = null;
        clearFailure(state);
        if (state.pending?.revision === record.bufferRevision) {
          state.pending = null;
        }
        // The adopted text is now owned durably by this buffer, so the
        // pre-crash orphan may go. A crash before this point keeps it.
        if (state.adopted.length > 0) {
          const orphans = state.adopted;
          state.adopted = [];
          for (const orphan of orphans) {
            try {
              const removal = await storage.remove(
                orphan.bufferId,
                orphan.bufferRevision,
              );
              state.totalBytes = removal.totalBytes;
            } catch {
              // Keeping the orphan is the safe failure.
            }
          }
        }
        setStatus(state);
      } catch (error) {
        const failure = failureOf(error);
        if (failure.kind === "quota") {
          if (failure.reason === "total-limit") pauseAll();
          else {
            state.paused = failure.reason;
            state.coalescer.cancel();
            notify(state);
          }
          return;
        }
        state.failure = failure;
        setStatus(state);
      }
    });
  };

  const makeBuffer = (input: {
    bufferId: string;
    spaceId: string;
    path: string;
    diskRevision: string | null;
  }): BufferState => {
    const state: BufferState = {
      bufferId: input.bufferId,
      spaceId: input.spaceId,
      path: input.path,
      diskRevision: input.diskRevision,
      revision: 0,
      history: [],
      pending: null,
      persisted: null,
      retireThrough: 0,
      failure: null,
      paused: null,
      totalBytes: 0,
      chain: Promise.resolve(),
      coalescer: createCoalescer({
        delayMs: coalesceMs,
        schedule,
        cancel,
        run: () => persist(state),
        onError: (error) => {
          state.failure = failureOf(error);
          notify(state);
        },
      }),
      listeners: new Set(),
      adopted: [],
      disposed: false,
    };
    buffers.set(input.bufferId, state);
    return state;
  };

  const handleOf = (state: BufferState): BufferRecovery => ({
    bufferId: state.bufferId,
    status: () => statusOf(state),
    subscribe(listener) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    edit({ text, diskRevision }) {
      if (state.disposed) return state.revision;
      if (diskRevision !== undefined) state.diskRevision = diskRevision;
      const last = state.history[state.history.length - 1];
      if (last?.text === text) return last.revision;
      state.revision += 1;
      const revision = state.revision;
      state.history.push({ revision, text });
      if (state.history.length > HISTORY_LIMIT) state.history.shift();
      state.pending = { revision, text };
      // Text that has shrunk back inside the per-file bound resumes recovery.
      if (state.paused === "file-limit" && recordBytes(recordFor(state, revision, text)) <= limits.perFileBytes) {
        state.paused = null;
        state.coalescer.cancel();
        state.coalescer = freshCoalescer(state);
      }
      if (!enabled() || quotaPaused || state.paused !== null) {
        notify(state);
        return revision;
      }
      state.coalescer.touch();
      notify(state);
      return revision;
    },
    revisionOf(text) {
      for (let i = state.history.length - 1; i >= 0; i -= 1) {
        if (state.history[i].text === text) return state.history[i].revision;
      }
      if (state.persisted?.text === text) return state.persisted.revision;
      return null;
    },
    async saved({ writtenText, resolvedRevision }) {
      const resolved = resolvedRevision ?? resolveSavedRevision(state, writtenText);
      if (resolved === null) {
        setStatus(state);
        return;
      }
      state.retireThrough = Math.max(state.retireThrough, resolved);
      if (state.pending !== null && state.pending.revision <= resolved) {
        state.pending = null;
      }
      await enqueue(state, async () => {
        try {
          const outcome = await storage.remove(state.bufferId, resolved);
          state.totalBytes = outcome.totalBytes;
          if (outcome.removed && (state.persisted?.revision ?? 0) <= resolved) {
            state.persisted = null;
          }
        } catch (error) {
          state.failure = failureOf(error);
        }
      });
      setStatus(state);
      tryResume();
    },
    async discard() {
      if (state.revision === 0 && state.retireThrough === 0) {
        // Nothing has ever been recorded for this buffer: the document loaded
        // clean, so there is no draft to resolve and no IPC is worth doing.
        setStatus(state);
        return;
      }
      const resolved = Math.max(state.revision, state.retireThrough);
      state.retireThrough = resolved;
      state.pending = null;
      // A discarded text must not be written by a timer that is already armed.
      state.coalescer.cancel();
      state.coalescer = freshCoalescer(state);
      await enqueue(state, async () => {
        try {
          const outcome = await storage.remove(state.bufferId, resolved);
          state.totalBytes = outcome.totalBytes;
          state.persisted = null;
        } catch (error) {
          state.failure = failureOf(error);
        }
      });
      setStatus(state);
      tryResume();
    },
    retry() {
      state.failure = null;
      state.paused = null;
      state.coalescer.cancel();
      state.coalescer = freshCoalescer(state);
      if (state.pending !== null) state.coalescer.touch();
      notify(state);
    },
    retarget({ path, diskRevision }) {
      state.path = path;
      state.diskRevision = diskRevision;
      state.paused = null;
      state.coalescer.cancel();
      state.coalescer = freshCoalescer(state);
      if (state.pending !== null && enabled() && !quotaPaused) {
        state.coalescer.touch();
      }
      notify(state);
    },
    dispose() {
      state.disposed = true;
      state.coalescer.cancel();
      state.listeners.clear();
    },
  });

  const resolveSavedRevision = (
    state: BufferState,
    text: string,
  ): number | null => {
    for (let i = state.history.length - 1; i >= 0; i -= 1) {
      if (state.history[i].text === text) return state.history[i].revision;
    }
    if (state.persisted?.text === text) return state.persisted.revision;
    return null;
  };

  const recordFor = (
    state: BufferState,
    revision: number,
    text: string,
  ): RecoveryRecord =>
    makeRecord({
      bufferId: state.bufferId,
      spaceId: state.spaceId,
      path: state.path,
      diskRevision: state.diskRevision,
      bufferRevision: revision,
      text,
      updatedAt: now(),
    });

  const freshCoalescer = (state: BufferState) =>
    createCoalescer({
      delayMs: coalesceMs,
      schedule,
      cancel,
      run: () => persist(state),
      onError: (error) => {
        state.failure = failureOf(error);
        notify(state);
      },
    });

  return {
    buffer(input) {
      // A re-registration (React remount, path unchanged) must not reset the
      // disk revision, retired watermark or pending text of a live buffer.
      // Path changes go through `retarget`, which is explicit.
      const existing = buffers.get(input.bufferId);
      if (existing) return handleOf(existing);
      return handleOf(makeBuffer(input));
    },
    bufferById(bufferId) {
      const state = buffers.get(bufferId);
      return state ? handleOf(state) : null;
    },
    enabledChanged() {
      for (const state of buffers.values()) {
        if (!enabled()) {
          state.coalescer.cancel();
        } else if (state.pending !== null && !state.disposed) {
          state.coalescer.cancel();
          state.coalescer = freshCoalescer(state);
          if (!quotaPaused) state.coalescer.touch();
        }
        notify(state);
      }
    },
    records: () => storage.list(),
    async recoverable(input) {
      return findRecoverable(await storage.list(), input);
    },
    adopt({ record, bufferId }) {
      const state = buffers.get(bufferId);
      if (!state) return;
      state.adopted.push(record);
    },
    async discardDraft(record) {
      // Explicit discard of someone else's orphan: remove exactly that
      // revision, and only if the stored record is still the one offered.
      await storage.remove(record.bufferId, record.bufferRevision);
      const state = buffers.get(record.bufferId);
      if (state) notify(state);
    },
    async flushAll() {
      const statuses = new Map<string, RecoveryStatus>();
      for (const state of buffers.values()) {
        if (state.disposed) continue;
        state.coalescer.cancel();
        await persist(state);
        // Drain the operation chain so the reported status is settled.
        await state.chain;
        statuses.set(state.bufferId, statusOf(state));
      }
      return statuses;
    },
  };
}

/** Exported for the UI: what the quota/cleanup rules decided, without I/O. */
export { planCleanup };

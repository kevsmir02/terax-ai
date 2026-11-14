import { invoke } from "@tauri-apps/api/core";
import type { AccountIsolationMode, SpaceRuntimeStatus } from "./isolation";
import type { SpaceMeta } from "./store";

export type SpaceIsolationSyncResult = {
  id: string;
  accountIsolation: AccountIsolationMode;
  hasRetainedProfiles: boolean;
  cleanupError?: string;
};

let bootSyncPromise: Promise<unknown> | null = null;
const pendingBySpace = new Map<string, Promise<unknown>>();

export function toRuntimeStatus(
  record: SpaceIsolationSyncResult,
): SpaceRuntimeStatus {
  return {
    hasRetainedProfiles: record.hasRetainedProfiles,
    ...(record.cleanupError !== undefined && {
      cleanupError: record.cleanupError,
    }),
  };
}

export function reconcileSpacesWithIsolation(
  spaces: SpaceMeta[],
  records: SpaceIsolationSyncResult[],
): {
  spaces: SpaceMeta[];
  changed: boolean;
  runtimeById: Record<string, SpaceRuntimeStatus>;
} {
  const byId = new Map(records.map((r) => [r.id, r]));
  let changed = false;
  const runtimeById: Record<string, SpaceRuntimeStatus> = {};
  const reconciled = spaces.map((space) => {
    const rec = byId.get(space.id);
    if (!rec) return space;
    runtimeById[space.id] = toRuntimeStatus(rec);
    if (space.accountIsolation !== rec.accountIsolation) {
      changed = true;
      return { ...space, accountIsolation: rec.accountIsolation };
    }
    return space;
  });
  return { spaces: reconciled, changed, runtimeById };
}

function enqueueSpaceMutation<T>(
  spaceId: string,
  op: () => Promise<T>,
): Promise<T> {
  const priorBoot = bootSyncPromise?.catch(() => {}) ?? Promise.resolve();
  const priorSpace =
    pendingBySpace.get(spaceId)?.catch(() => {}) ?? Promise.resolve();
  const next = Promise.all([priorBoot, priorSpace]).then(op);
  pendingBySpace.set(spaceId, next);
  const cleanup = next.finally(() => {
    if (pendingBySpace.get(spaceId) === next) {
      pendingBySpace.delete(spaceId);
    }
  });
  // Keep cleanup chain from creating an unhandled rejection when `next` rejects.
  void cleanup.catch(() => {});
  return next;
}

export async function syncSpaceIsolation(
  spaces: Pick<SpaceMeta, "id" | "accountIsolation">[],
): Promise<SpaceIsolationSyncResult[]> {
  const payload = spaces.map(({ id, accountIsolation }) => ({
    id,
    accountIsolation,
  }));
  const pendingMutations = [...pendingBySpace.values()].map((p) =>
    p.catch(() => {}),
  );
  const previousBoot = bootSyncPromise?.catch(() => {}) ?? Promise.resolve();
  const task = Promise.all([previousBoot, ...pendingMutations]).then(() =>
    invoke<SpaceIsolationSyncResult[]>("space_isolation_sync", {
      spaces: payload,
    }),
  );
  bootSyncPromise = task;
  try {
    return await task;
  } finally {
    if (bootSyncPromise === task) {
      bootSyncPromise = null;
    }
  }
}

export function registerSpaceIsolation(
  spaceId: string,
  accountIsolation: AccountIsolationMode,
): Promise<SpaceIsolationSyncResult> {
  return enqueueSpaceMutation(spaceId, () =>
    invoke<SpaceIsolationSyncResult>("space_isolation_register", {
      spaceId,
      accountIsolation,
    }),
  );
}

export function setSpaceIsolationMode(
  spaceId: string,
  accountIsolation: AccountIsolationMode,
): Promise<SpaceIsolationSyncResult> {
  return enqueueSpaceMutation(spaceId, () =>
    invoke<SpaceIsolationSyncResult>("space_isolation_set_mode", {
      spaceId,
      accountIsolation,
    }),
  );
}

export function removeSpaceIsolation(spaceId: string): Promise<void> {
  return enqueueSpaceMutation(spaceId, () =>
    invoke<void>("space_isolation_remove", { spaceId }),
  );
}

export async function preflightAgentLaunch(
  spaceId: string,
  expectedIsolation: AccountIsolationMode,
  agentId: string,
): Promise<void> {
  await waitForSpaceIsolationSync(spaceId);
  await invoke<void>("space_isolation_preflight_agent", {
    spaceId,
    expectedIsolation,
    agentId,
  });
}

export async function waitForSpaceIsolationSync(
  spaceId?: string,
): Promise<void> {
  if (bootSyncPromise) {
    await bootSyncPromise.catch(() => {});
  }
  if (spaceId) {
    const pending = pendingBySpace.get(spaceId);
    if (pending) {
      await pending.catch(() => {});
    }
  }
}

export function resetIsolationSyncForTests(): void {
  bootSyncPromise = null;
  pendingBySpace.clear();
}

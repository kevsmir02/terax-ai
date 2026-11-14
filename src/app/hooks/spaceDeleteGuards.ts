import type { CloseManyHazards } from "@/app/hooks/tabCloseGuards";
import {
  dirtyAfterSave,
  evaluateCloseHazards,
  hasNewCloseManyHazards,
} from "@/app/hooks/tabCloseGuards";
import type { Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal/lib/panes";

export type SpaceHazardSnapshot = {
  dirtyIds: number[];
  leafIds: number[];
};

export function spaceHazardSnapshot(
  tabs: readonly Tab[],
  spaceId: string,
  isDirty: (tabId: number) => boolean = (tabId) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    return tab?.kind === "editor" && tab.dirty;
  },
): SpaceHazardSnapshot {
  const affected = tabs.filter((tab) => tab.spaceId === spaceId);
  return {
    dirtyIds: affected
      .filter((tab) => tab.kind === "editor" && isDirty(tab.id))
      .map((tab) => tab.id),
    leafIds: affected
      .filter((tab) => tab.kind === "terminal")
      .flatMap((tab) => leafIds(tab.paneTree)),
  };
}

export type SpaceDeleteTransaction = {
  spaceId: string;
  hazards: CloseManyHazards;
};

export type SpaceIsolationContext = {
  accountIsolation?: "default" | "isolated";
  hasRetainedProfiles?: boolean;
};

export type ClearPrivateAccountsTransaction = {
  spaceId: string;
  spaceName: string;
  terminalCount: number;
  busyLeafIds: number[];
};

export type SpaceDeleteResult =
  | { status: "idle" }
  | { status: "canceled" }
  | { status: "deleted"; spaceId: string }
  | { status: "needs-confirmation"; pending: SpaceDeleteTransaction };

export type SpaceDeleteDeps = {
  tabs: () => readonly Tab[];
  /** Authoritative buffer dirty state; the tab list can lag a completed save by one render. */
  isDirty?: (tabId: number) => boolean;
  isBusy: (leafId: number) => Promise<boolean>;
  confirmRunning: () => boolean;
  /** Removes saved organization and awaits any Space-scoped profile cleanup. */
  deleteOrganization: (spaceId: string) => void | Promise<void>;
};

/**
 * Transactions for deleting a Space. Deleting is always confirmed because it is
 * an organizational action with visible consequences, and the confirmation is
 * checked again before it runs: a buffer that turned dirty or a terminal that
 * started working while the dialog was open must be seen before it is lost.
 */
export class SpaceDeleteGuard {
  private pendingTransaction: SpaceDeleteTransaction | null = null;
  private generation = 0;
  private confirming: Promise<SpaceDeleteResult> | null = null;

  constructor(private readonly deps: SpaceDeleteDeps) {}

  current(): SpaceDeleteTransaction | null {
    return this.pendingTransaction;
  }

  /** Current hazards for a Space, without opening or changing a transaction. */
  inspect(spaceId: string): Promise<CloseManyHazards> {
    return this.evaluate(spaceId);
  }

  async request(spaceId: string): Promise<SpaceDeleteTransaction | null> {
    const generation = ++this.generation;
    const hazards = await this.evaluate(spaceId);
    if (generation !== this.generation) return null;
    this.pendingTransaction = { spaceId, hazards };
    return this.pendingTransaction;
  }

  cancel(): void {
    this.generation += 1;
    this.pendingTransaction = null;
  }

  confirm(
    options: { savedDirtyIds?: readonly number[] } = {},
  ): Promise<SpaceDeleteResult> {
    if (this.pendingTransaction === null) {
      return Promise.resolve({ status: "idle" });
    }
    if (this.confirming !== null) return this.confirming;
    const generation = this.generation;
    const acknowledged = this.pendingTransaction;
    this.confirming = this.finishConfirm(
      generation,
      acknowledged,
      options.savedDirtyIds ?? [],
    ).finally(() => {
      this.confirming = null;
    });
    return this.confirming;
  }

  private async finishConfirm(
    generation: number,
    acknowledged: SpaceDeleteTransaction,
    savedDirtyIds: readonly number[],
  ): Promise<SpaceDeleteResult> {
    const hazards = await this.evaluate(acknowledged.spaceId);
    if (generation !== this.generation || this.pendingTransaction === null) {
      return { status: "canceled" };
    }
    if (dirtyAfterSave(savedDirtyIds, hazards)) {
      this.pendingTransaction = {
        spaceId: acknowledged.spaceId,
        hazards,
      };
      return {
        status: "needs-confirmation",
        pending: this.pendingTransaction,
      };
    }
    if (hasNewCloseManyHazards(acknowledged.hazards, hazards)) {
      this.pendingTransaction = {
        spaceId: acknowledged.spaceId,
        hazards,
      };
      return {
        status: "needs-confirmation",
        pending: this.pendingTransaction,
      };
    }
    this.pendingTransaction = null;
    this.generation += 1;
    await this.deps.deleteOrganization(acknowledged.spaceId);
    return { status: "deleted", spaceId: acknowledged.spaceId };
  }

  private evaluate(spaceId: string): Promise<CloseManyHazards> {
    return evaluateCloseHazards(
      () => spaceHazardSnapshot(this.deps.tabs(), spaceId, this.deps.isDirty),
      this.deps.isBusy,
      this.deps.confirmRunning(),
    );
  }
}

/** Dialog copy covering organization deletion and any Space-scoped local credentials. */
export function spaceDeleteMessage(
  pending: SpaceDeleteTransaction,
  tabs: readonly Tab[],
  spaceName = "this Space",
  profileContext?: SpaceIsolationContext,
): string {
  const { dirtyIds, busyLeafIds } = pending.hazards;
  const parts: string[] = [
    `Deleting "${spaceName}" removes its saved tabs and organization only. Files and worktrees on disk are not deleted.`,
  ];
  if (
    profileContext?.accountIsolation === "isolated" ||
    profileContext?.hasRetainedProfiles
  ) {
    if (profileContext.accountIsolation === "isolated") {
      parts.push(
        "Running Space terminal processes holding in-memory tokens will be stopped first, and local credentials and private profiles for this Space will be deleted from disk.",
      );
    } else {
      parts.push(
        "Retained local credentials and private profiles for this Space on disk will be deleted.",
      );
    }
    parts.push(
      "Remote provider OAuth sessions remain active unless revoked at the provider.",
    );
  }
  if (dirtyIds.length > 0) {
    const titles = dirtyIds
      .map((id) => tabs.find((tab) => tab.id === id)?.title)
      .filter((title): title is string => Boolean(title));
    const dirty =
      dirtyIds.length === 1
        ? `1 file has unsaved changes${titles[0] ? ` ("${titles[0]}")` : ""}`
        : `${dirtyIds.length} files have unsaved changes`;
    parts.push(
      `${dirty}. Save them before deleting, or delete without saving to discard them.`,
    );
  }
  if (busyLeafIds.length > 0) {
    const process =
      busyLeafIds.length === 1
        ? "1 process may still be running"
        : `${busyLeafIds.length} processes may still be running`;
    parts.push(
      `Deleting closes their tabs; ${process} and would be terminated.`,
    );
  }
  return parts.join(" ");
}

export function clearPrivateAccountsMessage(
  tx: ClearPrivateAccountsTransaction,
): string {
  const processDetail =
    tx.terminalCount === 0
      ? "Any running Space terminal processes"
      : tx.terminalCount === 1
        ? "1 Space terminal process"
        : `${tx.terminalCount} Space terminal processes`;
  const busyDetail =
    tx.busyLeafIds.length > 0 ? ` (${tx.busyLeafIds.length} active)` : "";
  return [
    `Clearing private accounts for "${tx.spaceName}" permanently deletes local credentials and private account profiles stored for this Space.`,
    `${processDetail}${busyDetail} holding in-memory tokens will be stopped first.`,
    "Non-terminal tabs, project files, and worktrees on disk stay untouched.",
    "This removes local credentials only and does not revoke remote provider OAuth grants unless you revoke them at the provider.",
  ].join(" ");
}

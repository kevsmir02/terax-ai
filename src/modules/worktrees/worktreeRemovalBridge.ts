/**
 * The worktree removal dialog registers itself here so the real-application
 * lab drives the dialog's own preflight, cleanup and confirm path instead of a
 * second implementation. Normal builds only register; nothing in the product
 * reads the registry.
 */

import type {
  CheckpointGroups,
  WorktreeRemoveReport,
} from "@/modules/git/types";
import type { DestructivePlan } from "@/modules/git";

export type WorktreeRemovalAcknowledgement = {
  unsavedBuffers: number[];
  activeWork: number[];
  force: boolean;
};

export type WorktreeRemovalBridgeState = {
  repoRoot: string | null;
  path: string | null;
  report: WorktreeRemoveReport | null;
  groups: CheckpointGroups | null;
  plan: DestructivePlan | null;
  acknowledged: WorktreeRemovalAcknowledgement;
  removed: WorktreeRemoveReport | null;
  busy: boolean;
  cleanupBusy: boolean;
  stale: string | null;
  error: string | null;
  canConfirm: boolean;
};

export type WorktreeRemovalBridge = {
  state: () => WorktreeRemovalBridgeState;
  /** Explicit scoped cleanup of exactly the refs this worktree owns. */
  cleanup: () => Promise<void>;
  setForce: (force: boolean) => void;
  confirm: () => Promise<void>;
  close: () => void;
};

let current: WorktreeRemovalBridge | null = null;

export function registerWorktreeRemovalBridge(
  bridge: WorktreeRemovalBridge,
): () => void {
  current = bridge;
  return () => {
    if (current === bridge) current = null;
  };
}

export function worktreeRemovalBridge(): WorktreeRemovalBridge | null {
  return current;
}

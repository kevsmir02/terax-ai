/**
 * The worktree creation dialog registers itself here so the real-application
 * lab drives the dialog's own form, preflight and submit path instead of a
 * second implementation. Normal builds only register; nothing in the product
 * reads the registry.
 */

import type { WorktreeAdded, WorktreeProblem } from "@/modules/git/types";
import type { WorktreeAccess, WorktreeCreateForm } from "./lib/createWorktree";

export type WorktreeDialogResult = {
  added: WorktreeAdded;
  access: WorktreeAccess;
};

export type WorktreeBridgeState = {
  repoRoot: string | null;
  form: WorktreeCreateForm;
  local: WorktreeProblem[];
  native: WorktreeProblem[];
  plannedPath: string | null;
  collision: string | null;
  checking: boolean;
  creating: boolean;
  error: string | null;
  result: WorktreeDialogResult | null;
  canSubmit: boolean;
};

export type WorktreeBridge = {
  state: () => WorktreeBridgeState;
  /** The dialog's own field handler (same path a keystroke takes). */
  setField: (field: keyof WorktreeCreateForm, value: string) => void;
  submit: () => Promise<void>;
  /** Returns false when the app has no access to the created folder. */
  openAsSpace: () => boolean;
  close: () => void;
};

let current: WorktreeBridge | null = null;

export function registerWorktreeBridge(bridge: WorktreeBridge): () => void {
  current = bridge;
  return () => {
    if (current === bridge) current = null;
  };
}

export function worktreeBridge(): WorktreeBridge | null {
  return current;
}

/**
 * The Checkpoints panel registers its live restore guard here so the real-app
 * lab can drive the same panel, preflight and destructive guard the product
 * renders, instead of a second implementation. Normal builds only register;
 * nothing in the product reads the registry.
 */

export type CheckpointBridgePending = {
  kind: "restore";
  ref: string;
  /** The shared destructive guard's plan fingerprint. */
  fingerprint: string;
  /** The native preflight the restore is bound to. */
  previewFingerprint: string;
  stale: string | null;
  affected: string[];
  blockers: (
    | {
        kind: "unsavedBuffer";
        tabId: number;
        spaceName: string;
        path: string;
        outsideSpaceRoot: boolean;
      }
    | {
        kind: "activeTerminal";
        leafId: number;
        spaceName: string;
        busy: boolean | "uncertain";
      }
  )[];
  force: boolean;
  stagedTotal: number;
  ignoredInTheWay: number;
  headMoved: boolean;
  requiresSafetyCapture: boolean;
};

export type CheckpointBridge = {
  /** The panel is mounted with a worktree. */
  mounted: () => boolean;
  /** The dialog is open and the grouped listing is loaded. */
  ready: () => boolean;
  open: () => void;
  close: () => void;
  create: (name: string | null) => Promise<void>;
  groups: () => { manual: number; safety: number; turns: number } | null;
  requestRestore: (ref: string) => Promise<void>;
  /** Deletes exactly one named recovery ref, as the panel's row action does. */
  cleanup: (ref: string) => Promise<void>;
  pending: () => CheckpointBridgePending | null;
  confirm: (confirmation: {
    unsavedBuffers: number[];
    activeWork: number[];
    force: boolean;
  }) => Promise<void>;
  cancel: () => void;
  busy: () => boolean;
  error: () => string | null;
  message: () => string | null;
};

let current: CheckpointBridge | null = null;

export function registerCheckpointBridge(bridge: CheckpointBridge): () => void {
  current = bridge;
  return () => {
    if (current === bridge) current = null;
  };
}

export function checkpointBridge(): CheckpointBridge | null {
  return current;
}

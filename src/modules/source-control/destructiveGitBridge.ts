/**
 * The Source Control panel registers its live destructive-action guard here so
 * the real-application lab can drive the same guard the panel renders, instead
 * of a second implementation. Normal builds only register; nothing in the
 * product reads the registry.
 */

export type DestructiveGitBridgePending = {
  kind: "discard" | "checkout";
  fingerprint: string;
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
};

export type DestructiveGitBridge = {
  /** The panel's repository/status view is loaded and can answer a request. */
  ready: () => boolean;
  requestDiscard: (paths: readonly string[]) => Promise<void>;
  requestCheckout: (branch: string) => Promise<void>;
  pending: () => DestructiveGitBridgePending | null;
  confirm: (confirmation: {
    unsavedBuffers: number[];
    activeWork: number[];
    force: boolean;
  }) => Promise<void>;
  cancel: () => void;
  busy: () => boolean;
};

let current: DestructiveGitBridge | null = null;

export function registerDestructiveGitBridge(
  bridge: DestructiveGitBridge,
): () => void {
  current = bridge;
  return () => {
    if (current === bridge) current = null;
  };
}

export function destructiveGitBridge(): DestructiveGitBridge | null {
  return current;
}

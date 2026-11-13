import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { ImageProbeOutcome } from "./imageViewer";

type ProbeState = {
  key: string;
  probe: ImageProbeOutcome | null;
};

/**
 * Reads an image's intrinsic dimensions from the native header probe.
 *
 * Only a visible surface probes: a hidden tab must not do work for an image it
 * is not presenting, and it re-probes when it returns. A stale completion after
 * a path change or unmount is dropped, so an old image cannot replace the
 * current one's state.
 */
export function useImageProbe(
  path: string,
  enabled: boolean,
  /**
   * Folder a document-owned image must resolve inside (canonical check in the
   * native probe). The image surface passes nothing: the file was opened
   * deliberately, not chosen by a document.
   */
  boundary?: string,
): {
  probe: ImageProbeOutcome | null;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const key = `${path}:${attempt}`;
  const [result, setResult] = useState<ProbeState>({ key: "", probe: null });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setResult({ key, probe: null });
    void invoke<ImageProbeOutcome>("fs_image_probe", {
      path,
      workspace: currentWorkspaceEnv(),
      ...(boundary ? { boundary } : {}),
    })
      .then((probe) => {
        if (!disposed) setResult({ key, probe });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setResult({
            key,
            probe: { kind: "unreadable", reason: String(error) },
          });
        }
      });
    return () => {
      disposed = true;
    };
  }, [path, key, enabled, boundary]);

  return {
    probe: result.key === key ? result.probe : null,
    retry: () => setAttempt((value) => value + 1),
  };
}

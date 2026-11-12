import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { MediaProbeOutcome } from "./mediaViewer";

type ProbeState = {
  key: string;
  probe: MediaProbeOutcome | null;
};

/**
 * Reads the real container (and cheap codec ids) from the native header probe.
 *
 * Only a visible surface probes: a hidden tab must not do work for media it is
 * not presenting. Unlike a re-decode, the header result is kept across
 * hide/show so returning to a playing tab does not remount the element and
 * lose its position; a path change or retry gets a fresh probe. A stale
 * completion after a path change or unmount is dropped.
 */
export function useMediaProbe(
  path: string,
  enabled: boolean,
): {
  probe: MediaProbeOutcome | null;
  retry: () => void;
} {
  const [attempt, setAttempt] = useState(0);
  const key = `${path}:${attempt}`;
  const [result, setResult] = useState<ProbeState>({ key: "", probe: null });
  const resultRef = useRef(result);
  resultRef.current = result;

  useEffect(() => {
    if (!enabled) return;
    // The same file was already probed (a hide/show cycle): keep the result so
    // the element and its playback position stay mounted.
    if (resultRef.current.key === key && resultRef.current.probe) return;
    let disposed = false;
    setResult({ key, probe: null });
    void invoke<MediaProbeOutcome>("fs_media_probe", {
      path,
      workspace: currentWorkspaceEnv(),
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
  }, [path, key, enabled]);

  return {
    probe: result.key === key ? result.probe : null,
    retry: () => setAttempt((value) => value + 1),
  };
}

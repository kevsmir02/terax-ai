import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { currentWorkspaceEnv } from "@/modules/workspace";

type FileStat = { size: number; mtime: number; kind: string };

type SizeState = { path: string; bytes: number | null };

const EMPTY: SizeState = { path: "", bytes: null };

/**
 * The size of a local file, read only when `enabled` asks for it.
 *
 * A rendered document's `<img>` sees only a load error when the native asset
 * handler refuses the file (its 413 body is not readable from an element), so
 * the refusal is explained from the file's own size instead of guessing at a
 * corrupt image. A completion after a path change or unmount is dropped, and a
 * failed stat reports "unknown" (null) rather than a stale size.
 */
export function useFileBytes(path: string, enabled: boolean): number | null {
  const [result, setResult] = useState<SizeState>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setResult(EMPTY);
      return;
    }
    let disposed = false;
    void invoke<FileStat>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((stat) => {
        if (disposed) return;
        setResult({
          path,
          bytes: typeof stat?.size === "number" ? stat.size : null,
        });
      })
      .catch(() => {
        if (!disposed) setResult({ path, bytes: null });
      });
    return () => {
      disposed = true;
    };
  }, [path, enabled]);

  return enabled && result.path === path ? result.bytes : null;
}

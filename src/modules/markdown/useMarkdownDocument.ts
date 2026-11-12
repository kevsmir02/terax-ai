import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState } from "react";
import { createDocumentLoad, type LoadOutcome } from "./lib/documentLoad";
import { createCoalescer, touchesPath } from "./lib/liveReload";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type MarkdownStatus =
  | { kind: "loading" }
  | { kind: "ready"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number; forced: boolean }
  | { kind: "error"; message: string };

function toStatus(res: ReadResult, forced: boolean): MarkdownStatus {
  if (res.kind === "text") {
    return { kind: "ready", content: res.content, size: res.size };
  }
  if (res.kind === "binary") return { kind: "binary", size: res.size };
  return { kind: "toolarge", size: res.size, limit: res.limit, forced };
}

export type MarkdownDocument = {
  status: MarkdownStatus;
  /**
   * Re-reads a document above the normal 10 MiB ceiling through the approved
   * explicit override (up to 50 MiB). Nothing else raises the ceiling.
   */
  openAnyway: () => void;
};

/**
 * Reads `path` and keeps it current: an `fs:changed` for the file or an app
 * write to it re-reads after a short coalescing window. A reload never shows
 * the loading state, keeps the last good text when a read fails midway
 * through an agent's atomic rewrite, and returns the same status object when
 * nothing changed so unchanged documents do not re-render. A hidden tab does
 * not read at all: it remembers that it needs a read and catches up when shown.
 */
export function useMarkdownDocument(
  path: string,
  visible: boolean,
): MarkdownDocument {
  const [status, setStatus] = useState<MarkdownStatus>({ kind: "loading" });
  const visibleRef = useRef(visible);
  const reloadRef = useRef<(() => void) | null>(null);
  const staleRef = useRef(false);
  const forceRef = useRef(false);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible && staleRef.current) {
      staleRef.current = false;
      reloadRef.current?.();
    }
  }, [visible]);

  useEffect(() => {
    const workspace = currentWorkspaceEnv();
    // The watcher reports canonical paths; the tab may hold an alias spelling.
    let canonical: string | null = null;
    staleRef.current = false;
    forceRef.current = false;
    setStatus({ kind: "loading" });

    // A completion after unmount or after a newer request must not publish:
    // the gate owns the request generation and the document's lifetime.
    const load = createDocumentLoad(
      () =>
        invoke<ReadResult>("fs_read_file", {
          path,
          workspace,
          force: forceRef.current,
        }),
      (outcome: LoadOutcome<ReadResult>) => {
        if (outcome.ok) {
          const next = toStatus(outcome.value, forceRef.current);
          setStatus((prev) =>
            prev.kind === "ready" &&
            next.kind === "ready" &&
            prev.content === next.content
              ? prev
              : next,
          );
          return;
        }
        const message = String(outcome.error);
        setStatus((prev) =>
          prev.kind === "loading" ? { kind: "error", message } : prev,
        );
      },
    );
    const read = () => load.load();

    const coalescer = createCoalescer(read);
    const onTouched = () => {
      if (visibleRef.current) coalescer.poke();
      else staleRef.current = true;
    };
    reloadRef.current = read;

    const matches = (paths: readonly string[]) =>
      touchesPath(paths, path) ||
      (canonical !== null && touchesPath(paths, canonical));

    const dir = parentDir(path);
    watchAdd([dir], [path], workspace);
    const unlisten: Array<() => void> = [];
    const track = (pending: Promise<() => void>) =>
      void pending.then((un) => (load.live ? unlisten.push(un) : un()));
    track(
      listenFsChanged((paths) => {
        if (matches(paths)) onTouched();
      }),
    );
    track(
      getCurrentWebviewWindow().listen<{ path: string }>(
        "fs:file-written",
        (e) => {
          if (matches([e.payload.path])) onTouched();
        },
      ),
    );

    // A hidden tab is not rendered, so its read is deferred until it is shown.
    if (visibleRef.current) read();
    else staleRef.current = true;
    invoke<string>("fs_canonicalize", { path, workspace })
      .then((c) => {
        if (load.live) canonical = c;
      })
      .catch(() => {});

    return () => {
      load.close();
      coalescer.cancel();
      reloadRef.current = null;
      for (const un of unlisten) un();
      watchRemove([dir], [path], workspace);
    };
  }, [path]);

  const openAnyway = useCallback(() => {
    forceRef.current = true;
    setStatus({ kind: "loading" });
    reloadRef.current?.();
  }, []);

  return { status, openAnyway };
}

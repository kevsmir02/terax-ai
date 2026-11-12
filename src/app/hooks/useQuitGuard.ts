/**
 * The window's side of quitting: gathers the evidence, runs the effects the
 * quit gate asks for, and keeps the decision itself in `modules/shutdown`.
 *
 * Everything that can block a quit is read here, live, at the moment it is
 * asked: editor handles can be newer than a tab's published `dirty` flag, a
 * terminal's process probe can fail (which is *uncertain*, not idle), and a
 * recovery write can still be in flight. The gate never sees a cached answer.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { recoveryManager } from "@/modules/editor/lib/recovery/service";
import { recoveryBufferIdFor } from "@/modules/editor/lib/recovery/useRecovery";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type QuitEffect,
  type QuitEvent,
  type QuitState,
  initialQuitState,
  reduceQuit,
} from "@/modules/shutdown";
import { QUIT_FLUSH_TIMEOUT_MS } from "@/modules/shutdown/lib/flush";
import { flushRecovery } from "@/modules/shutdown/lib/flush";
import { quitDraftsFromStatuses } from "@/modules/shutdown/lib/flush";
import {
  type ProcessHazard,
  type QuitSurvey,
  surveyQuit,
} from "@/modules/shutdown/lib/survey";
import {
  forceCloseTerminals,
  terminateAppOwnedWork,
} from "@/modules/shutdown/native";
import { useSpaces } from "@/modules/spaces";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";

function confirmRunningTerminal(): boolean {
  return usePreferencesStore.getState().confirmCloseRunningTerminal;
}

function editorTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((tab) => tab.kind === "editor");
}

/**
 * Maps a recovery buffer id back to its tab. The identity comes from the same
 * helper the mounted editor used, so a draft can only be reported against the
 * buffer that owns it.
 */
function identifyIn(
  tabs: readonly Tab[],
): (bufferId: string) => { spaceId: string; title: string } {
  const byBuffer = new Map<string, { spaceId: string; title: string }>();
  for (const tab of editorTabs(tabs)) {
    byBuffer.set(recoveryBufferIdFor(tab.spaceId, tab.id), {
      spaceId: tab.spaceId,
      title: tab.title,
    });
  }
  return (bufferId) =>
    byBuffer.get(bufferId) ?? { spaceId: "", title: bufferId };
}

async function probeProcesses(tabs: readonly Tab[]): Promise<ProcessHazard[]> {
  const leaves = tabs
    .filter((tab) => tab.kind === "terminal")
    .flatMap((tab) =>
      leafIds(tab.paneTree).map((leafId) => ({ leafId, spaceId: tab.spaceId })),
    );
  const probed = await Promise.all(
    leaves.map(async ({ leafId, spaceId }): Promise<ProcessHazard | null> => {
      try {
        const busy = await leafHasForegroundProcess(leafId);
        return busy ? { leafId, spaceId, state: "running" } : null;
      } catch {
        // A probe that failed is not evidence the pane is idle: an uncertain
        // process still has to be resolved before quit.
        return { leafId, spaceId, state: "uncertain" };
      }
    }),
  );
  return probed.filter((hazard): hazard is ProcessHazard => hazard !== null);
}

function allLeafIds(tabs: readonly Tab[]): number[] {
  return tabs
    .filter((tab) => tab.kind === "terminal")
    .flatMap((tab) => leafIds(tab.paneTree));
}

export type QuitGuardDeps = {
  tabsRef: RefObject<Tab[]>;
  /** Live editor-handle dirty check, not the tab's last published flag. */
  isTabDirty: (tabId: number) => boolean;
  /** Resolves true only when the buffer is fully persisted. */
  saveTab: (tabId: number) => Promise<boolean>;
  /**
   * How the window actually closes. Injected by the app-lab so a scenario can
   * report what the confirmed quit resolved to before the process exits.
   */
  closeWindow?: () => Promise<void>;
};

export type QuitGuard = {
  quit: QuitState;
  /** The same entry point the window's close event uses. */
  requestQuit: () => void;
  cancel: () => void;
  confirm: () => void;
  saveAll: () => void;
  retryFlush: () => void;
  loseDrafts: () => void;
  force: () => void;
};

export function useQuitGuard(deps: QuitGuardDeps): QuitGuard {
  const [state, setState] = useState<QuitState>(initialQuitState);
  const stateRef = useRef(state);
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });

  const forceClose = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const executeRef = useRef<(effect: QuitEffect) => Promise<void>>(
    async () => undefined,
  );

  const dispatch = useCallback((event: QuitEvent) => {
    const current = stateRef.current;
    const next = reduceQuit(current, event);
    if (next.state === current) return;
    stateRef.current = next.state;
    setState(next.state);
    for (const effect of next.effects) {
      queue.current = queue.current
        .then(() => executeRef.current(effect))
        .catch((error) => {
          // A failed step must not be mistaken for a confirmed quit.
          console.error("[quit]", error);
          toast.error("Could not finish quitting", {
            description: String(error),
          });
          const fallback = reduceQuit(stateRef.current, { type: "cancel" });
          stateRef.current = fallback.state;
          setState(fallback.state);
        });
    }
  }, []);

  const takeSurvey = useCallback(async (): Promise<QuitSurvey> => {
    const { tabsRef: tabsRefNow, isTabDirty } = depsRef.current;
    const tabs = tabsRefNow.current;
    const spaces = useSpaces
      .getState()
      .spaces.map(({ id, name }) => ({ id, name }));
    const buffers = tabs
      .filter((tab) => tab.kind === "editor" && isTabDirty(tab.id))
      .map((tab) => ({
        spaceId: tab.spaceId,
        tabId: tab.id,
        title: tab.title,
      }));
    const identify = identifyIn(tabs);
    return surveyQuit({
      spaces,
      buffers,
      // The opt-out is a preference about *running processes only*; it never
      // suppresses the unsaved-text or draft parts of the survey.
      processes: confirmRunningTerminal() ? await probeProcesses(tabs) : [],
      drafts: quitDraftsFromStatuses(recoveryManager().statuses(), identify),
    });
  }, []);

  const finishClose = useCallback(async () => {
    const closeWindow = depsRef.current.closeWindow;
    forceClose.current = true;
    try {
      if (closeWindow) await closeWindow();
      else await getCurrentWindow().close();
    } catch (error) {
      forceClose.current = false;
      toast.error("Could not close the window", {
        description: String(error),
      });
    }
  }, []);

  useLayoutEffect(() => {
    executeRef.current = async (effect: QuitEffect) => {
      switch (effect.kind) {
        case "survey": {
          dispatch({ type: "surveilled", survey: await takeSurvey() });
          break;
        }
        case "flush-recovery": {
          const manager = recoveryManager();
          const report = await flushRecovery({
            flush: () => manager.flushAll(),
            statuses: () => manager.statuses(),
            timeoutMs: QUIT_FLUSH_TIMEOUT_MS,
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (handle) =>
              clearTimeout(handle as ReturnType<typeof setTimeout>),
            identify: identifyIn(depsRef.current.tabsRef.current),
          });
          dispatch({ type: "flushed", report });
          break;
        }
        case "save-all": {
          const { saveTab, isTabDirty } = depsRef.current;
          let complete = true;
          for (const id of effect.tabIds) {
            const saved = await saveTab(id);
            // The buffer is asked again after the await: text typed meanwhile
            // is newer than the snapshot the save captured.
            if (!saved || isTabDirty(id)) {
              complete = false;
              break;
            }
          }
          dispatch({ type: "saved", complete });
          break;
        }
        case "terminate": {
          const ids = allLeafIds(depsRef.current.tabsRef.current);
          if (ids.length === 0) {
            dispatch({ type: "terminated", survivors: [] });
            break;
          }
          const report = await terminateAppOwnedWork(ids, effect.graceMs);
          dispatch({ type: "terminated", survivors: report.survived });
          break;
        }
        case "force-close-terminals": {
          await forceCloseTerminals();
          break;
        }
        case "close-window": {
          await finishClose();
          break;
        }
      }
    };
  });

  useLayoutEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (forceClose.current) return;
        // Always hold the window: the gate decides whether this is an answer,
        // an interruption or a fresh question.
        event.preventDefault();
        dispatch({ type: "close-request" });
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dispatch]);

  return {
    quit: state,
    requestQuit: () => dispatch({ type: "close-request" }),
    cancel: () => dispatch({ type: "cancel" }),
    confirm: () => dispatch({ type: "confirm" }),
    saveAll: () => dispatch({ type: "save-all" }),
    retryFlush: () => dispatch({ type: "retry-flush" }),
    loseDrafts: () => dispatch({ type: "lose-drafts" }),
    force: () => dispatch({ type: "force" }),
  };
}

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { consumeLaunchFiles, getLaunchDir } from "@/lib/launchDir";
import { IS_MAC } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import { useZoom } from "@/lib/useZoom";
import { isMarkdownPath } from "@/lib/utils";
import {
  type AgentLaunchRequest,
  AgentNotificationsBridge,
  findAgentLauncher,
  nextAttentionTarget,
  resolveAgentLaunchCommand,
} from "@/modules/agents";
import {
  CommandPalette,
  createCommandItems,
  type OpenFileTarget,
  type PaletteInitialMode,
} from "@/modules/command-palette";
import { useControlBridge } from "@/modules/control";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  type RecoveryCloseIntent,
  setFileNavigator,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { setCodeBlockRunner } from "@/modules/markdown/lib/codeBlockRunner";
import type { PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setShowHidden } from "@/modules/settings/store";
import { usePreferencesBootstrap } from "@/modules/settings/usePreferencesBootstrap";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  tabDigit,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarRail,
  useSidebarPanel,
} from "@/modules/sidebar";
import {
  type DestructiveGitSupport,
  SourceControlPanel,
  useRepositoryTargeting,
  useSourceControlContext,
} from "@/modules/source-control";
import { checkpointBridge } from "@/modules/source-control/checkpointBridge";
import { destructiveGitBridge } from "@/modules/source-control/destructiveGitBridge";
import {
  type AccountIsolationMode,
  evaluateIsolationToggleGuard,
  preflightAgentLaunch,
  SpaceSwitcher,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
} from "@/modules/spaces";
import { normalizeSpaceRoot } from "@/modules/spaces/lib/sharedRoots";
import { StatusBar } from "@/modules/statusbar";
import {
  type CloseTabsPlan,
  TabSwitcherHud,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  isTerminalSurfaceTarget,
  leafHasForegroundProcess,
  leafIds,
  navigateFocusedBlocks,
  type PaneBounds,
  ptyIdForLeaf,
  type TerminalPaneHandle,
  useAgentActivityStore,
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { bindTerminalWindowFocus } from "@/modules/terminal/ghostty/renderScheduling";
import { subscribeWindowPresentation } from "@/modules/terminal/ghostty/windowPresentation";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import {
  LivePageResizeBridge,
  ThemeProvider,
  useThemeFileEditing,
  WindowActivityBridge,
  WindowVibrancyBridge,
} from "@/modules/theme";
import {
  collectHandoffWork,
  type HandoffHazard,
  UpdaterDialog,
} from "@/modules/updater";
import {
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "@/modules/workspace";
import { native } from "@/modules/workspace/native";
import { worktreeSpaceName } from "@/modules/worktrees/lib/createWorktree";
import type { WorktreeRemovalTarget } from "@/modules/worktrees/WorktreeRemoveDialog";
import { worktreeBridge } from "@/modules/worktrees/worktreeBridge";
import { worktreeRemovalBridge } from "@/modules/worktrees/worktreeRemovalBridge";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { CloseDialogs } from "./components/CloseDialogs";
import { QuitDialog } from "./components/QuitDialog";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import {
  hasOpenPathTab,
  renamedPath,
  spacesEmptiedByTabs,
} from "./hooks/tabCloseGuards";
import { useQuitGuard } from "./hooks/useQuitGuard";
import { useSpaceDeleteGuard } from "./hooks/useSpaceDeleteGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

// Real-application benchmark driver (scripts/app-lab). `__TERAX_BENCH__` is the literal `false`
// in a normal build, so this is `null` and neither the import nor its chunk is emitted.
const BenchBridge = __TERAX_BENCH__
  ? lazy(() => import("@/bench/BenchBridge"))
  : null;

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    allocId,
    booted,
    replaceTabs,
    moveTabToSpace,
    reorderTab,
    reorderTabByGap,
    newTabInSpace,
    removeTabsForSpace,
    markBooted,
    setActiveSpaceForNewTabs,
    newTab,
    newBlockTab,
    newAgentGroupTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    closeTabs,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, TerminalSearchController>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<TerminalSearchController | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());

  const clearWorkspaceState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    searchAddons.current.clear();
    terminalRefs.current.clear();
    editorRefs.current.clear();
    previewRefs.current.clear();
    setActiveSearchAddon(null);
    setActiveEditorHandle(null);
  }, []);

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  } = useWorkspaceSwitcher({
    tabsRef,
    workspaceEnv,
    setWorkspaceEnv,
    resetWorkspace,
    clearWorkspaceState,
  });

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  // Space identity by name only: agent notifications carry the Space's own
  // name, never a path, cwd or open file.
  const spaceList = useSpaces((s) => s.spaces);
  const spaceNames = useMemo(
    () => Object.fromEntries(spaceList.map((space) => [space.id, space.name])),
    [spaceList],
  );
  // Markdown previews anchor automatic local assets to the Space's configured
  // project root, not to a terminal's current directory.
  const spaceRoots = useMemo(
    () => Object.fromEntries(spaceList.map((space) => [space.id, space.root])),
    [spaceList],
  );
  const spaceIsolations = useMemo(
    () =>
      Object.fromEntries(
        spaceList.map((space) => [space.id, space.accountIsolation]),
      ),
    [spaceList],
  );
  const activeSpaceIdRef = useRef(activeSpaceId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
    activeSpaceIdRef.current = activeSpaceId;
  }, [tabs, activeId, activeSpaceId]);
  const sourceControlSpaceId = activeSpaceId ?? DEFAULT_SPACE_ID;

  const handleWorkspaceChange = useCallback(
    async (env: WorkspaceEnv) => {
      const switched = await switchWorkspace(env);
      if (switched && activeSpaceId) {
        useSpaces.getState().setEnv(activeSpaceId, env);
      }
    },
    [switchWorkspace, activeSpaceId],
  );

  useSpacesBoot({
    ready: launchCwdResolved,
    launchCwd,
    home,
    allocId,
    replaceTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    adoptWorkspaceEnv,
  });

  useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated,
  });

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    if (prev === null || prev === activeSpaceId) return;
    const meta = useSpaces
      .getState()
      .spaces.find((s) => s.id === activeSpaceId);
    if (meta) void adoptWorkspaceEnv(meta.env);
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) return;
    // Keep the active tab if it already belongs to the newly active space (a
    // cross-space jump set it explicitly); else fall to the space's last tab.
    if (inSpace.some((t) => t.id === activeId)) return;
    setActiveId(inSpace[inSpace.length - 1].id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    adoptWorkspaceEnv,
  ]);

  const [switcherOpen, setSwitcherOpen] = useState(false);

  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [tabs, activeSpaceId],
  );

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    sidebarCollapsed,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    openSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  /** The worktree whose removal dialog is open, if any. Removal is a deliberate
   * menu action: deleting a Space never sets this. */
  const [worktreeRemoveTarget, setWorktreeRemoveTarget] =
    useState<WorktreeRemovalTarget | null>(null);
  const [paletteInitialMode, setPaletteInitialMode] =
    useState<PaletteInitialMode>("commands");
  const openCommandPalette = useCallback(
    (mode: PaletteInitialMode = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );
  usePreferencesBootstrap();

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isEditorTab = activeTab?.kind === "editor";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  );

  useWindowTitle(activeTab, explorerRoot);

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: TerminalSearchController) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  /**
   * The one choke point for a tab's recovery state. Every tab-removal path
   * (single close, bulk close, file deletion, Space deletion) goes through
   * here *before* the handle is dropped, so an armed persistence timer can no
   * longer write text the person explicitly discarded.
   */
  const releaseTabRecovery = useCallback(
    (id: number, intent: RecoveryCloseIntent) => {
      editorRefs.current.get(id)?.releaseRecovery(intent);
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
    },
    [],
  );

  const disposeTab = useCallback(
    (id: number, intent: RecoveryCloseIntent) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      releaseTabRecovery(id, intent);
      closeTab(id);
    },
    [closeTab, releaseTabRecovery],
  );

  const disposeTabs = useCallback(
    (
      anchorId: number,
      plan: CloseTabsPlan,
      /**
       * Ids the confirmation resolved by discarding; every other id keeps its
       * draft. Required so a bulk path cannot silently skip the decision.
       */
      discardIds: readonly number[],
    ) => {
      const discard = new Set(discardIds);
      const closedIds = closeTabs(anchorId, plan);
      for (const id of closedIds) {
        releaseTabRecovery(id, discard.has(id) ? "discard" : "keep-draft");
      }
    },
    [closeTabs, releaseTabRecovery],
  );

  const disposeDeletedTabs = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      for (const spaceId of spacesEmptiedByTabs(tabsRef.current, ids)) {
        const root = useSpaces
          .getState()
          .spaces.find((s) => s.id === spaceId)?.root;
        newTabInSpace(spaceId, root ?? undefined);
      }
      // The file is gone, not the person's unsaved text: the draft stays for
      // the next session, exactly like closing the tab by hand.
      for (const id of ids) disposeTab(id, "keep-draft");
    },
    [disposeTab, newTabInSpace],
  );

  /** The editor's own close (`:q`): a plain close, not an explicit discard. */
  const handleEditorClose = useCallback(
    (id: number) => disposeTab(id, "keep-draft"),
    [disposeTab],
  );

  const isTabDirty = useCallback((id: number): boolean => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab?.kind !== "editor") return false;
    return editorRefs.current.get(id)?.isDirty() ?? tab.dirty;
  }, []);

  /**
   * Every buffer and terminal the destructive-Git guard may need to see, read
   * at request time. Space names and roots come from the live Spaces store so a
   * rename does not need to re-register this provider.
   */
  const destructiveSupport = useMemo<DestructiveGitSupport>(
    () => ({
      usage: () => {
        const spaces = useSpaces.getState().spaces;
        const nameOf = (id: string) =>
          spaces.find((space) => space.id === id)?.name ?? "Space";
        const rootOf = (id: string) =>
          spaces.find((space) => space.id === id)?.root ?? null;
        const current = tabsRef.current;
        return {
          buffers: current
            .filter((tab) => tab.kind === "editor")
            .map((tab) => ({
              tabId: tab.id,
              spaceId: tab.spaceId,
              spaceName: nameOf(tab.spaceId),
              spaceRoot: rootOf(tab.spaceId),
              path: tab.path,
              dirty: isTabDirty(tab.id),
            })),
          terminals: current
            .filter((tab) => tab.kind === "terminal")
            .flatMap((tab) =>
              leafIds(tab.paneTree).map((leafId) => ({
                tabId: tab.id,
                leafId,
                spaceId: tab.spaceId,
                spaceName: nameOf(tab.spaceId),
                cwd: findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? "",
              })),
            ),
          isBusy: (leafId: number) => leafHasForegroundProcess(leafId),
        };
      },
      canonicalize: (path: string) =>
        native.canonicalize(path).catch(() => null),
    }),
    [isTabDirty],
  );

  const saveTab = useCallback(async (id: number): Promise<boolean> => {
    const handle = editorRefs.current.get(id);
    if (!handle) return false;
    try {
      const complete = await handle.save();
      return complete && !handle.isDirty();
    } catch (error) {
      console.error("[terax] save before close failed:", error);
      return false;
    }
  }, []);

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    closeManyIncomplete,
    closeSaveState,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    confirmClose,
    cancelClose,
    saveAndClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    saveAndCloseMany,
    cancelCloseMany,
    handlePathsDeleted,
  } = useTabCloseGuards({
    tabs,
    activeId,
    disposeTab,
    disposeDeletedTabs,
    disposeTabs,
    saveTab,
    isTabDirty,
  });

  // The app lab records the confirmed close instead of ending the process, so
  // a scenario can report what quitting resolved to before the app exits.
  const benchQuitClosed = useRef(false);
  const benchCloseWindow = __TERAX_BENCH__
    ? async () => {
        benchQuitClosed.current = true;
      }
    : undefined;

  const {
    quit,
    requestQuit,
    cancel: cancelQuit,
    confirm: confirmQuit,
    saveAll: saveAllAndQuit,
    retryFlush: retryQuitFlush,
    loseDrafts: loseDraftsAndQuit,
    force: forceQuit,
  } = useQuitGuard({
    tabsRef,
    isTabDirty,
    saveTab,
    ...(benchCloseWindow ? { closeWindow: benchCloseWindow } : {}),
  });

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  useEffect(() => {
    const tab = tabsRef.current.find((t) => t.id === activeId);
    if (tab?.kind !== "terminal") return;
    const ptyIds = leafIds(tab.paneTree).flatMap((leafId) => {
      const ptyId = ptyIdForLeaf(leafId);
      return ptyId === null ? [] : [ptyId];
    });
    useAgentActivityStore.getState().acknowledgeAttention(ptyIds);
  }, [activeId]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const cycleSpace = useCallback((delta: 1 | -1) => {
    const { spaces, activeId: sid, setActive } = useSpaces.getState();
    if (spaces.length < 2) return;
    const idx = spaces.findIndex((s) => s.id === sid);
    const next = (idx + delta + spaces.length) % spaces.length;
    setActive(spaces[next].id);
  }, []);

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
  }, [newTab, inheritedCwdForNewTab]);

  const openNewBlockTab = useCallback(() => {
    newBlockTab(inheritedCwdForNewTab());
  }, [newBlockTab, inheritedCwdForNewTab]);

  const launchAgentGroup = useCallback(
    async (request: AgentLaunchRequest): Promise<boolean> => {
      const command = resolveAgentLaunchCommand(request.agent, request.command);
      if (!command.ok) return false;
      const spaceId = useSpaces.getState().activeId ?? DEFAULT_SPACE_ID;
      const expectedIsolation =
        useSpaces.getState().spaces.find((s) => s.id === spaceId)
          ?.accountIsolation ?? "default";
      if (expectedIsolation === "isolated") {
        try {
          await preflightAgentLaunch(spaceId, expectedIsolation, request.agent);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          toast.error("Agent launch blocked in isolated Space", {
            description: message,
          });
          throw error;
        }
      }
      const launcher = findAgentLauncher(request.agent);
      const title =
        request.instances === 1
          ? launcher.label
          : `${launcher.label} × ${request.instances}`;
      const { leafIds: agentLeafIds } = newAgentGroupTab(
        inheritedCwdForNewTab(),
        title,
        request.instances,
      );

      // Ordinary launching is hook-free: hook installation is an explicit
      // opt-in from the notifications UI, never a launch side effect. Each pane
      // only runs the configured command.
      for (const leafId of agentLeafIds) {
        void (async () => {
          await whenSessionReady(leafId);
          if (!writeToSession(leafId, `${command.command}\r`)) {
            console.error(
              `[terax] agent terminal ${leafId} closed before launch`,
            );
          }
        })();
      }
      return true;
    },
    [inheritedCwdForNewTab, newAgentGroupTab],
  );

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      void term.writeAtPrompt(`cd ${quoteShellArg(path)}\r`).then((typed) => {
        if (typed) {
          term.focus();
          return;
        }
        toast("Terminal is busy", {
          description:
            "Open a new tab to go there, or exit the running program.",
        });
      });
    },
    [activeLeafId],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (tab?.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Markdown opens in its rendered view by default; a per-tab toggle flips
      // it to the raw editor. Other files default to preview (pin=false);
      // explicit actions like context-menu "Open" pass pin=true to persist.
      if (isMarkdownPath(path)) newMarkdownTab(path);
      else openFileTab(path, pin ?? false);
    },
    [openFileTab, newMarkdownTab],
  );

  const openLaunchFiles = useCallback(
    (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    },
    [handleOpenFile],
  );

  // Warm start: the backend emits once the window already exists. Attach on
  // mount so an "Open With" that lands mid-restore isn't dropped — the backend
  // also seeds the drain-once state, so the boot drain below is the safety net.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      const off = await listen<string[]>("terax:open-file", (e) => {
        openLaunchFiles(e.payload);
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openLaunchFiles]);

  // Cold start: files arrive as CLI args (Linux/Windows) or the macOS open-files
  // event, and get_launch_files drains them once. Wait for `booted` — the spaces
  // restore ends in replaceTabs(), which overwrites the whole tab list and would
  // discard a launch tab opened before it, making the file flash open and vanish.
  // Booting first also lands the tab in the restored active space, and lets
  // openFileTab dedupe against a session that already had the file open.
  useEffect(() => {
    if (!booted) return;
    void (async () => {
      openLaunchFiles(await consumeLaunchFiles());
    })();
  }, [booted, openLaunchFiles]);

  const handleExplorerPathRenamed = useCallback(
    (from: string, to: string) => {
      for (const tab of tabsRef.current) {
        if (tab.kind !== "editor" && tab.kind !== "markdown") continue;
        const path = renamedPath(tab.path, from, to);
        if (path === null) continue;
        const i = path.lastIndexOf("/");
        updateTab(tab.id, {
          path,
          title: i === -1 ? path : path.slice(i + 1),
        });
      }
    },
    [updateTab],
  );

  const canReplaceExplorerPath = useCallback(
    (path: string) => !hasOpenPathTab(tabsRef.current, path),
    [],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  const isRepositoryContextCurrent = useCallback(
    (spaceId: string, workspaceKey: string) => {
      const currentSpaceId = useSpaces.getState().activeId ?? DEFAULT_SPACE_ID;
      const currentWorkspaceKey = workspaceScopeKey(
        useWorkspaceEnvStore.getState().env,
      );
      return spaceId === currentSpaceId && workspaceKey === currentWorkspaceKey;
    },
    [],
  );
  const openSourceControl = useCallback(() => {
    openSidebarView("source-control");
  }, [openSidebarView]);
  const toggleHiddenFiles = useCallback(() => {
    openSidebarView("explorer");
    void setShowHidden(!usePreferencesStore.getState().showHidden);
  }, [openSidebarView]);
  const {
    repositoryTarget: sourceControlRepositoryTarget,
    openInSourceControl: handleOpenRepositoryInSourceControl,
    openGitHistory: handleOpenGitHistoryForPath,
    followActiveContext: handleFollowRepositoryContext,
  } = useRepositoryTargeting({
    spaceId: sourceControlSpaceId,
    workspaceKey: workspaceScopeKey(workspaceEnv),
    isContextCurrent: isRepositoryContextCurrent,
    openSourceControl,
    openCommitHistoryTab,
  });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const { sourceControl, toggleSourceControl, openGitGraphFromContext } =
    useSourceControlContext({
      activeTab,
      tabs,
      activeTerminalLeafCwd,
      explorerRoot,
      launchCwd,
      launchCwdResolved,
      home,
      sidebarView,
      sidebarCollapsed,
      explorerGitDecorations,
      repositoryTarget: sourceControlRepositoryTarget,
      cycleSidebarView,
      openCommitHistoryTab,
    });

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  // Focus an agent's tab, switching to its space first so the header and tab
  // strip don't end up showing a different space than the focused pane.
  const activateAgentTarget = useCallback(
    (tabId: number, leafId: number) => {
      const space = tabsRef.current.find((t) => t.id === tabId)?.spaceId;
      if (space && space !== useSpaces.getState().activeId) {
        useSpaces.getState().setActive(space);
      }
      setActiveId(tabId);
      focusPane(tabId, leafId);
    },
    [setActiveId, focusPane],
  );

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.files": () => openCommandPalette("files"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      "tab.newBlock": openNewBlockTab,
      "tab.newPreview": () => openPreviewTab(""),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          (tabDigit(e, e.shiftKey) ?? 1) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "space.next": () => cycleSpace(1),
      "space.prev": () => cycleSpace(-1),
      "space.overview": () => setSwitcherOpen(true),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const editor = editorRefs.current.get(activeId);
        if (editor) editor.openSearch();
        else searchInlineRef.current?.focus();
      },
      "agent.focusAttention": () => {
        const t = nextAttentionTarget();
        if (t) activateAgentTarget(t.tabId, t.leafId);
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "explorer.toggleHidden": toggleHiddenFiles,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
      "editor.save": () => {
        void editorRefs.current.get(activeId)?.save();
      },
      "editor.codeComplete": () =>
        editorRefs.current.get(activeId)?.triggerCodeComplete(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      cycleSpace,
      handleCloseTabOrPane,
      openNewTab,
      openNewBlockTab,
      openPreviewTab,
      activeSpaceId,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleSourceControl,
      toggleSidebar,
      toggleExplorerFocus,
      toggleHiddenFiles,
      zoomIn,
      zoomOut,
      zoomReset,
      activateAgentTarget,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.save" ||
        id === "editor.codeComplete"
      ) {
        return activeTab?.kind !== "editor";
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !isTerminalSurfaceTarget(target);
      }
      if (id === "blocks.prev" || id === "blocks.next") {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = isTerminalSurfaceTarget(target);
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const pending = pendingEditorNavigation.current.get(id);
        if (pending != null) {
          pendingEditorNavigation.current.delete(id);
          if (pending.line === undefined) h.focus();
          else h.gotoLine(pending.line, { focus: pending.focus });
        }
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const onActivateAgent = activateAgentTarget;

  /**
   * The handoff's readiness evidence, read live at the moment the person approves
   * an update: the editor handles' own dirty answers, a probe per terminal leaf and
   * the agent phases the terminals reported. Nothing is cached between reads, so a
   * buffer that goes dirty (or an agent that starts) after the approval is seen by
   * the re-read that happens right before the handoff.
   */
  const readHandoffWork = useCallback(
    () =>
      collectHandoffWork({
        tabs: tabsRef.current,
        isTabDirty,
        probeProcess: (leafId: number) => leafHasForegroundProcess(leafId),
        ptyIdForLeaf,
        agentPhase: (ptyId: number) =>
          useAgentActivityStore.getState().phases[ptyId],
        agentName: (ptyId: number) =>
          useAgentActivityStore.getState().agents[ptyId],
      }),
    [isTabDirty],
  );

  /**
   * "Review the work" only focuses what the check named. It never saves, closes or
   * interrupts anything: finishing or closing the work is the person's decision.
   */
  const reviewHandoffWork = useCallback(
    (hazards: readonly HandoffHazard[]) => {
      const first = hazards[0];
      if (!first) return;
      if (first.kind === "buffer") {
        const space = tabsRef.current.find(
          (t) => t.id === first.tabId,
        )?.spaceId;
        if (space && space !== useSpaces.getState().activeId) {
          useSpaces.getState().setActive(space);
        }
        setActiveId(first.tabId);
        return;
      }
      if (first.kind === "agent") {
        activateAgentTarget(first.tabId, first.leafId);
        return;
      }
      const tab = tabsRef.current.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, first.leafId),
      );
      if (tab) activateAgentTarget(tab.id, first.leafId);
    },
    [activateAgentTarget, setActiveId],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  const handleNewSpace = useCallback(
    (accountIsolation: AccountIsolationMode = "default") => {
      const { spaces, create, setActive } = useSpaces.getState();
      const meta = create({
        name: `Space ${spaces.length + 1}`,
        root: activeCwd ?? home ?? null,
        env: workspaceEnv,
        accountIsolation,
      });
      setActiveSpaceForNewTabs(meta.id);
      newTab(activeCwd ?? undefined);
      setActive(meta.id);
      return meta.id;
    },
    [activeCwd, home, workspaceEnv, newTab, setActiveSpaceForNewTabs],
  );

  /**
   * A worktree gets a Space of its own. Existing Spaces keep their tabs and
   * every terminal keeps its working directory: only a new Space and (when it
   * has none yet) a new terminal are added.
   */
  const openWorktreeAsSpace = useCallback(
    (path: string, branch: string | null) => {
      const { spaces, create, setActive } = useSpaces.getState();
      const normalized = normalizeSpaceRoot(path);
      const existing = spaces.find(
        (space) =>
          space.root !== null && normalizeSpaceRoot(space.root) === normalized,
      );
      const meta =
        existing ??
        create({
          name: worktreeSpaceName({ path, branch }),
          root: path,
          env: workspaceEnv,
        });
      setActive(meta.id);
      const hasTerminal = tabsRef.current.some(
        (tab) => tab.spaceId === meta.id && tab.kind === "terminal",
      );
      if (!hasTerminal) newTabInSpace(meta.id, path);
    },
    [newTabInSpace, workspaceEnv],
  );

  const commitDeleteSpace = useCallback(
    (id: string) => {
      const nextSpaceId = useSpaces.getState().remove(id);
      if (!nextSpaceId) return;
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeTabsForSpace(id, nextSpaceId, root ?? undefined);
    },
    [removeTabsForSpace],
  );

  const prepareDiscard = useCallback((id: number): (() => void) | null => {
    const handle = editorRefs.current.get(id);
    return handle ? () => handle.releaseRecovery("discard") : null;
  }, []);

  const {
    pendingSpaceDelete,
    spaceDeleteSaving,
    spaceDeleteIncomplete,
    requestSpaceDelete,
    confirmSpaceDelete,
    saveAndDeleteSpace,
    cancelSpaceDelete,
  } = useSpaceDeleteGuard({
    tabs,
    deleteSpace: commitDeleteSpace,
    saveTab,
    isTabDirty,
    prepareDiscard,
  });

  const handleMoveTab = useCallback(
    (tabId: number, targetSpaceId: string) => {
      if (moveTabToSpace(tabId, targetSpaceId)) {
        useSpaces.getState().setActive(targetSpaceId);
      }
    },
    [moveTabToSpace],
  );

  const handleReorderTab = useCallback(
    (tabId: number, targetTabId: number, edge: "top" | "bottom") => {
      if (reorderTab(tabId, targetTabId, edge)) {
        const target = tabsRef.current.find((x) => x.id === targetTabId);
        if (target) useSpaces.getState().setActive(target.spaceId);
      }
    },
    [reorderTab],
  );

  const handleNewTabInSpace = useCallback(
    (spaceId: string) => {
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === spaceId)?.root;
      newTabInSpace(spaceId, root ?? undefined);
    },
    [newTabInSpace],
  );

  const jumpToTab = useCallback(
    (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      if (!t) return;
      setActiveId(tabId);
      useSpaces.getState().setActive(t.spaceId);
      setSwitcherOpen(false);
    },
    [setActiveId],
  );

  const canToggleSpaceIsolation = useCallback((spaceId: string) => {
    return evaluateIsolationToggleGuard(
      spaceId,
      tabsRef.current.map((tab) => ({
        spaceId: tab.spaceId,
        kind: tab.kind,
        cold: tab.cold,
        leafIds: tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
      })),
      (leafId) => ptyIdForLeaf(leafId) !== null,
    );
  }, []);

  const handleToggleSpaceIsolation = useCallback(
    async (spaceId: string, nextMode: AccountIsolationMode) => {
      const guard = canToggleSpaceIsolation(spaceId);
      if (!guard.allowed) {
        throw new Error(guard.reason);
      }
      await useSpaces.getState().setAccountIsolation(spaceId, nextMode);
    },
    [canToggleSpaceIsolation],
  );

  const spaceSwitcher = (
    <SpaceSwitcher
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      tabs={tabs}
      onNewSpace={() => void handleNewSpace()}
      onNewIsolatedSpace={() => void handleNewSpace("isolated")}
      canToggleSpaceIsolation={canToggleSpaceIsolation}
      onToggleSpaceIsolation={handleToggleSpaceIsolation}
      onDeleteSpace={requestSpaceDelete}
      onNewTabInSpace={handleNewTabInSpace}
      onJumpTab={jumpToTab}
      onCloseTab={handleClose}
      onMoveTabToSpace={handleMoveTab}
      onReorderTab={handleReorderTab}
      onReorderSpaces={(ids) => useSpaces.getState().reorder(ids)}
    />
  );

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchTarget,
            explorerRoot,
            home,
            openNewTab,
            openNewBlock: openNewBlockTab,
            openNewEditor: () => setNewEditorOpen(true),
            openNewPreview: () => openPreviewTab(""),
            openGitGraph: openGitGraphFromContext,
            toggleSourceControl,
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActivePaneInActiveTab("row"),
            splitPaneDown: () => splitActivePaneInActiveTab("col"),
            focusSearch: () => searchInlineRef.current?.focus(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            toggleHiddenFiles,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
            spaces: useSpaces.getState().spaces,
            activeSpaceId,
            openSpacesOverview: () => setSwitcherOpen(true),
            newSpace: () => void handleNewSpace(),
            switchSpace: (id) => useSpaces.getState().setActive(id),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      searchTarget,
      explorerRoot,
      home,
      openNewTab,
      openNewBlockTab,
      openPreviewTab,
      openGitGraphFromContext,
      toggleSourceControl,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
      toggleHiddenFiles,
      activeSpaceId,
      handleNewSpace,
    ],
  );

  const pendingEditorNavigation = useRef<
    Map<number, { line?: number; focus: boolean }>
  >(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = openFileTab(path, true);
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingEditorNavigation.current.set(id, { line, focus: true });
    },
    [openFileTab],
  );

  // `target.side` (open to the side) has no host support yet: plain open.
  const openPaletteFile = useCallback(
    (path: string, target: OpenFileTarget) => {
      if (target.line !== undefined) openContentHit(path, target.line);
      else handleOpenFile(path, true);
    },
    [openContentHit, handleOpenFile],
  );

  const openControlFile = useCallback(
    ({
      path,
      line,
      focus,
      spaceId,
    }: {
      path: string;
      line?: number;
      focus: boolean;
      spaceId: string;
    }) => {
      if (focus && useSpaces.getState().activeId !== spaceId) {
        useSpaces.getState().setActive(spaceId);
      }
      const id = openFileTab(path, true, {
        spaceId,
        activate: focus,
      });
      const editor = editorRefs.current.get(id);
      if (line !== undefined) {
        if (editor) editor.gotoLine(line, { focus });
        else pendingEditorNavigation.current.set(id, { line, focus });
      } else if (focus) {
        if (editor) editor.focus();
        else pendingEditorNavigation.current.set(id, { focus: true });
      }
      return id;
    },
    [openFileTab],
  );

  useEffect(() => {
    setFileNavigator({ openFile: openContentHit });
    return () => setFileNavigator(null);
  }, [openContentHit]);

  useControlBridge({
    ready: spacesHydrated && launchCwdResolved,
    tabsRef,
    activeTabIdRef: activeIdRef,
    activeSpaceIdRef,
    onOpen: openControlFile,
  });

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            const wrote = writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
            return wrote;
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  // Rendered Markdown owns its code-block UI; only this shell knows the active
  // terminal, so the "Run in active terminal" action is published here. The
  // returned boolean lets the button refuse instead of claiming "Sent".
  useEffect(() => {
    setCodeBlockRunner(insertHistoryCommand);
    return () => setCodeBlockRunner(null);
  }, [insertHistoryCommand]);

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        {BenchBridge && (
          <Suspense fallback={null}>
            <BenchBridge
              tabs={tabs}
              activeId={activeId}
              booted={booted}
              setActiveId={setActiveId}
              newTab={newTab}
              newBlockTab={newBlockTab}
              newAgentGroupTab={newAgentGroupTab}
              splitActivePane={splitActivePane}
              closeTab={closeTab}
              openFileTab={(path, pin = true, spaceId) =>
                openFileTab(path, pin, spaceId ? { spaceId } : undefined)
              }
              openMarkdownTab={newMarkdownTab}
              setLeafCwd={setLeafCwd}
              readBuffer={(leafId, maxLines) =>
                terminalRefs.current.get(leafId)?.getBuffer(maxLines) ?? null
              }
              spaces={useSpaces
                .getState()
                .spaces.map(({ id, name, root }) => ({ id, name, root }))}
              activeSpaceId={activeSpaceId}
              createSpace={(name, root) =>
                useSpaces.getState().create({ name, root }).id
              }
              setActiveSpace={(id) => useSpaces.getState().setActive(id)}
              newTabInSpace={(spaceId, cwd) => newTabInSpace(spaceId, cwd)}
              openPreview={(url) => openPreviewTab(url)}
              requestCloseTab={(id) => void handleClose(id)}
              cancelPendingClose={() => {
                cancelClose();
                cancelTerminalClose();
              }}
              confirmDiscardTab={() => {
                confirmClose();
                confirmTerminalClose();
              }}
              saveAndCloseTab={() => void saveAndClose()}
              requestDeleteSpace={(id) => void requestSpaceDelete(id)}
              cancelDeleteSpace={cancelSpaceDelete}
              confirmDeleteSpace={() => void confirmSpaceDelete()}
              saveAndDeleteSpace={() => void saveAndDeleteSpace()}
              pendingGuards={() => ({
                closeTabId: pendingCloseTab,
                terminalTabId: pendingTerminalCloseTab,
                spaceDeleteId: pendingSpaceDelete?.spaceId ?? null,
                closeSaveState,
                spaceDeleteIncomplete,
              })}
              editEditor={(tabId, text) =>
                editorRefs.current.get(tabId)?.insertText(text)
              }
              saveEditor={(tabId) =>
                editorRefs.current.get(tabId)?.save() ?? Promise.resolve(false)
              }
              readEditor={(tabId) =>
                editorRefs.current.get(tabId)?.readText() ?? null
              }
              requestQuit={requestQuit}
              cancelQuit={cancelQuit}
              confirmQuit={confirmQuit}
              saveAllAndQuit={saveAllAndQuit}
              retryQuitFlush={retryQuitFlush}
              loseDraftsAndQuit={loseDraftsAndQuit}
              forceQuit={forceQuit}
              quitState={() => ({
                phase: quit.phase,
                closed: benchQuitClosed.current,
                note: quit.note,
                totals: quit.survey?.totals ?? {
                  buffers: 0,
                  processes: 0,
                  uncertainProcesses: 0,
                  drafts: 0,
                },
                spaces: (quit.survey?.spaces ?? []).map((space) => ({
                  id: space.id,
                  name: space.name,
                  buffers: space.buffers.map((buffer) => ({
                    tabId: buffer.tabId,
                    title: buffer.title,
                  })),
                  processes: space.processes.map((process) => ({
                    leafId: process.leafId,
                    state: process.state,
                  })),
                  drafts: space.drafts.map((draft) => ({
                    bufferId: draft.bufferId,
                    title: draft.title,
                    state: draft.state,
                  })),
                })),
                survivors: quit.survivors,
                flush: quit.flush
                  ? {
                      outcome: quit.flush.outcome,
                      drafts: quit.flush.drafts.map((draft) => ({
                        bufferId: draft.bufferId,
                        title: draft.title,
                        state: draft.state,
                      })),
                    }
                  : null,
              })}
              openSourceControl={openSourceControl}
              openWorktreeDialog={() => {
                openSourceControl();
                setWorktreeDialogOpen(true);
              }}
              worktree={() => worktreeBridge()}
              openWorktreeRemove={(repoRoot, path) => {
                openSourceControl();
                setWorktreeRemoveTarget({ repoRoot, path });
              }}
              worktreeRemove={() => worktreeRemovalBridge()}
              destructiveGit={() => {
                const bridge = destructiveGitBridge();
                return {
                  mounted: bridge !== null,
                  ready: bridge?.ready() ?? false,
                  busy: bridge?.busy() ?? false,
                  pending: bridge?.pending() ?? null,
                  requestDiscard: (paths) =>
                    bridge?.requestDiscard(paths) ?? Promise.resolve(),
                  confirm: (confirmation) =>
                    bridge?.confirm(confirmation) ?? Promise.resolve(),
                  cancel: () => bridge?.cancel(),
                };
              }}
              checkpoints={() => {
                const bridge = checkpointBridge();
                return {
                  mounted: bridge?.mounted() ?? false,
                  ready: bridge?.ready() ?? false,
                  busy: bridge?.busy() ?? false,
                  groups: bridge?.groups() ?? null,
                  pending: bridge?.pending() ?? null,
                  error: bridge?.error() ?? null,
                  message: bridge?.message() ?? null,
                  open: () => bridge?.open(),
                  close: () => bridge?.close(),
                  create: (name) => bridge?.create(name) ?? Promise.resolve(),
                  requestRestore: (ref) =>
                    bridge?.requestRestore(ref) ?? Promise.resolve(),
                  cleanup: (ref) => bridge?.cleanup(ref) ?? Promise.resolve(),
                  confirm: (confirmation) =>
                    bridge?.confirm(confirmation) ?? Promise.resolve(),
                  cancel: () => bridge?.cancel(),
                };
              }}
            />
          </Suspense>
        )}
        <div className="relative flex h-screen flex-col overflow-hidden bg-frame text-foreground">
          {!zenMode && (
            <Header
              tabs={spaceTabs}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={openNewTab}
              onNewBlock={openNewBlockTab}
              onNewPreview={() => openPreviewTab("")}
              onNewEditor={() => setNewEditorOpen(true)}
              onNewGitGraph={openGitGraphFromContext}
              onLaunchAgents={launchAgentGroup}
              onClose={handleClose}
              onCloseTabsToRight={handleCloseTabsToRight}
              onCloseOtherTabs={handleCloseOtherTabs}
              onPin={pinTab}
              onRename={handleRenameTab}
              onReorder={reorderTabByGap}
              onToggleSidebar={toggleSidebar}
              onOpenCommandPalette={() => openCommandPalette("commands")}
              onActivateAgent={onActivateAgent}
              onOpenSettings={() => void openSettingsWindow()}
              spaceSwitcher={spaceSwitcher}
              searchTarget={searchTarget}
              searchRef={searchInlineRef}
              onOverrideLanguage={setOverrideLanguage}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
              onLayoutChanged={(_, { isUserInteraction }) => {
                const width = sidebarRef.current?.getSize().inPixels ?? 0;
                persistSidebarWidth(width, isUserInteraction);
              }}
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="flex h-full min-h-0 flex-col">
                  <div
                    key={sidebarView}
                    className="min-h-0 flex-1 terax-panel-in"
                  >
                    {sidebarView === "explorer" ? (
                      <FileExplorer
                        ref={explorerRef}
                        rootPath={explorerRoot}
                        gitStatus={
                          explorerGitDecorations ? sourceControl.status : null
                        }
                        activeFilePath={explorerActiveFilePath}
                        onOpenFile={handleOpenFile}
                        onPathRenamed={handleExplorerPathRenamed}
                        onPathsDeleted={handlePathsDeleted}
                        canReplacePath={canReplaceExplorerPath}
                        onRevealInTerminal={cdInNewTab}
                        onOpenInSourceControl={
                          handleOpenRepositoryInSourceControl
                        }
                        onOpenGitHistory={handleOpenGitHistoryForPath}
                        pathDropTarget={terminalPathDropTarget}
                        visible={!sidebarCollapsed}
                      />
                    ) : (
                      <SourceControlPanel
                        open
                        sourceControl={sourceControl}
                        onOpenDiff={openGitDiffTab}
                        onOpenGitGraph={openGitGraphFromContext}
                        onOpenFile={handleOpenFile}
                        onNavigateToPath={cdInNewTab}
                        repositoryTarget={sourceControlRepositoryTarget}
                        onFollowRepositoryContext={
                          handleFollowRepositoryContext
                        }
                        destructive={destructiveSupport}
                        worktreeDialogOpen={worktreeDialogOpen}
                        onWorktreeDialogOpenChange={setWorktreeDialogOpen}
                        onOpenWorktreeAsSpace={openWorktreeAsSpace}
                        worktreeRemoveTarget={worktreeRemoveTarget}
                        onWorktreeRemoveOpenChange={setWorktreeRemoveTarget}
                      />
                    )}
                  </div>
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    changedCount={sourceControl.changedCount}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="relative h-full min-h-0 bg-background">
                  <WorkspaceSurface
                    tabs={tabs}
                    activeId={activeId}
                    activeTab={activeTab}
                    activeSpaceId={activeSpaceId ?? DEFAULT_SPACE_ID}
                    spaceRoots={spaceRoots}
                    spaceIsolations={spaceIsolations}
                    home={home}
                    subscribeWindowPresentation={subscribeWindowPresentation}
                    registerTerminalHandle={registerTerminalHandle}
                    onSearchReady={handleSearchReady}
                    onCwd={handleTerminalCwd}
                    onExit={handleLeafExit}
                    onFocusLeaf={handleFocusLeaf}
                    onCloseLeaf={closePaneByLeaf}
                    registerEditorHandle={registerEditorHandle}
                    onEditorDirtyChange={handleEditorDirty}
                    onEditorCloseTab={handleEditorClose}
                    registerPreviewHandle={registerPreviewHandle}
                    onPreviewUrlChange={handlePreviewUrl}
                    onOpenCommitFile={openCommitFileDiffTab}
                    onGitHistorySearchHandle={setGitHistoryHandle}
                    onSetMarkdownView={setMarkdownView}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {!zenMode && (
            <StatusBar
              cwd={activeCwd}
              filePath={activeFilePath}
              home={home}
              onCd={sendCd}
              onWorkspaceChange={handleWorkspaceChange}
            />
          )}

          <WindowVibrancyBridge />
          {IS_MAC ? <LivePageResizeBridge /> : null}
          <WindowActivityBridge
            bindFocus={bindTerminalWindowFocus}
            subscribePresentation={subscribeWindowPresentation}
          />

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
            spaceNames={spaceNames}
          />
          <Toaster position="bottom-right" />

          {switcherState && (
            <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
            onOpenFile={openPaletteFile}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <UpdaterDialog
            readHandoffWork={readHandoffWork}
            reviewHandoffWork={reviewHandoffWork}
          />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            closeSaveState={closeSaveState}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            onSaveAndClose={saveAndClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingCloseMany={pendingCloseMany}
            closeManyConfirming={closeManyConfirming}
            closeManyIncomplete={closeManyIncomplete}
            onCancelCloseMany={cancelCloseMany}
            onConfirmCloseMany={confirmCloseMany}
            onSaveAndCloseMany={saveAndCloseMany}
            pendingSpaceDelete={pendingSpaceDelete}
            spaceName={
              spaceList.find((s) => s.id === pendingSpaceDelete?.spaceId)
                ?.name ?? "this Space"
            }
            spaceDeleteSaving={spaceDeleteSaving}
            spaceDeleteIncomplete={spaceDeleteIncomplete}
            onCancelSpaceDelete={cancelSpaceDelete}
            onConfirmSpaceDelete={() => void confirmSpaceDelete()}
            onSaveAndDeleteSpace={() => void saveAndDeleteSpace()}
          />

          <QuitDialog
            quit={quit}
            tabs={tabs}
            onCancel={cancelQuit}
            onConfirm={confirmQuit}
            onSaveAll={saveAllAndQuit}
            onRetryFlush={retryQuitFlush}
            onLoseDrafts={loseDraftsAndQuit}
            onForce={forceQuit}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return shell;
}

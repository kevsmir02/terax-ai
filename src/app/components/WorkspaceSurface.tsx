import { WorkspaceInputBar } from "@/app/components/WorkspaceInputBar";
import { cn } from "@/lib/utils";
import { EditorStack, GitDiffStack } from "@/modules/editor";
import { GitHistoryStack } from "@/modules/git-history";
import { MarkdownStack } from "@/modules/markdown";
import { PreviewStack } from "@/modules/preview";
import type { PresentationSubscription } from "@/modules/preview/lib/windowVisibility";
import type { Tab } from "@/modules/tabs";
import { TerminalStack } from "@/modules/terminal";
import type { ComponentProps } from "react";

type TerminalStackProps = ComponentProps<typeof TerminalStack>;
type EditorStackProps = ComponentProps<typeof EditorStack>;
type PreviewStackProps = ComponentProps<typeof PreviewStack>;
type GitHistoryStackProps = ComponentProps<typeof GitHistoryStack>;

type Props = {
  tabs: Tab[];
  activeId: number;
  activeTab: Tab | undefined;
  /** The Space on screen; previews in every other Space unload their frames. */
  activeSpaceId: string;
  /**
   * Configured Space project roots, by Space id. Markdown previews anchor
   * automatic local assets here (or their own directory outside it) instead of
   * a mutable terminal cwd.
   */
  spaceRoots: Readonly<Record<string, string | null>>;
  /** Shared native window-presentation feed (occlusion/sleep), optional. */
  subscribeWindowPresentation?: PresentationSubscription;
  registerTerminalHandle: TerminalStackProps["registerHandle"];
  onSearchReady: TerminalStackProps["onSearchReady"];
  onCwd: TerminalStackProps["onCwd"];
  onExit: TerminalStackProps["onExit"];
  onFocusLeaf: TerminalStackProps["onFocusLeaf"];
  registerEditorHandle: EditorStackProps["registerHandle"];
  onEditorDirtyChange: EditorStackProps["onDirtyChange"];
  onEditorCloseTab: EditorStackProps["onCloseTab"];
  registerPreviewHandle: PreviewStackProps["registerHandle"];
  onPreviewUrlChange: PreviewStackProps["onUrlChange"];
  onOpenCommitFile: GitHistoryStackProps["onOpenCommitFile"];
  onGitHistorySearchHandle: GitHistoryStackProps["onSearchHandle"];
  onSetMarkdownView: EditorStackProps["onSetMarkdownView"];
};

const LAYER = "absolute inset-0";

/**
 * Stacks every tab-kind surface absolutely on top of each other and toggles
 * visibility off the active tab, so panes keep their mounted state (terminal
 * buffers, editor scroll, ...) when switching tabs.
 *
 * The preview stack is the exception: its frames are untrusted web content that
 * must not keep working off screen, so {@link PreviewStack} unloads a frame
 * whenever its tab, its Space or the window is not on screen.
 *
 * Layers sit flush inside the Content stage; only the terminal layer is inset
 * inside a unified outlined Terminal card.
 */
export function WorkspaceSurface({
  tabs,
  activeId,
  activeTab,
  activeSpaceId,
  spaceRoots,
  subscribeWindowPresentation,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
  registerEditorHandle,
  onEditorDirtyChange,
  onEditorCloseTab,
  registerPreviewHandle,
  onPreviewUrlChange,
  onOpenCommitFile,
  onGitHistorySearchHandle,
  onSetMarkdownView,
}: Props) {
  const kind = activeTab?.kind;
  const activeTerminalTab = kind === "terminal" ? activeTab : null;
  const isBlockTab = activeTerminalTab?.blocks === true;
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;
  const isTerminalTab = kind === "terminal";
  const isEditorTab = kind === "editor";
  const isPreviewTab = kind === "preview";
  const isMarkdownTab = kind === "markdown";
  const isGitDiffTab = kind === "git-diff" || kind === "git-commit-file";
  const isGitHistoryTab = kind === "git-history";

  return (
    <div className="relative h-full min-h-0 bg-background">
      <div
        className={cn(
          LAYER,
          "p-3",
          !isTerminalTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        <div
          data-terminal-card=""
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-terminal-background"
        >
          <div className="relative min-h-0 flex-1">
            <TerminalStack
              tabs={tabs}
              activeId={activeId}
              registerHandle={registerTerminalHandle}
              onSearchReady={onSearchReady}
              onCwd={onCwd}
              onExit={onExit}
              onFocusLeaf={onFocusLeaf}
            />
          </div>
          <WorkspaceInputBar
            isBlockTab={isBlockTab}
            activeLeafId={activeLeafId}
          />
        </div>
      </div>
      <div
        className={cn(LAYER, !isEditorTab && "invisible pointer-events-none")}
        aria-hidden={!isEditorTab}
      >
        <EditorStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={onEditorDirtyChange}
          onCloseTab={onEditorCloseTab}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(LAYER, !isPreviewTab && "invisible pointer-events-none")}
        aria-hidden={!isPreviewTab}
      >
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          activeSpaceId={activeSpaceId}
          subscribePresentation={subscribeWindowPresentation}
          registerHandle={registerPreviewHandle}
          onUrlChange={onPreviewUrlChange}
        />
      </div>
      <div
        className={cn(LAYER, !isMarkdownTab && "invisible pointer-events-none")}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack
          tabs={tabs}
          activeId={activeId}
          spaceRoots={spaceRoots}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(LAYER, !isGitDiffTab && "invisible pointer-events-none")}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          LAYER,
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={onOpenCommitFile}
          onSearchHandle={onGitHistorySearchHandle}
        />
      </div>
    </div>
  );
}

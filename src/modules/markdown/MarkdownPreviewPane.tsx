import { useAssetGrant } from "@/lib/useAssetGrant";
import { cn } from "@/lib/utils";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { previewBoundary } from "./lib/assetPath";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownViewToggle } from "./MarkdownViewToggle";
import { useMarkdownDocument } from "./useMarkdownDocument";

type Props = {
  path: string;
  /** Images load only from beneath this folder (the document's own folder if it lies outside). */
  workspaceRoot?: string | null;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

export function MarkdownPreviewPane({
  path,
  workspaceRoot = null,
  visible,
  onSetView,
}: Props) {
  const status = useMarkdownDocument(path, visible);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const content = status.kind === "ready" ? status.content : null;
  const boundary = useMemo(
    () => previewBoundary(path, workspaceRoot),
    [path, workspaceRoot],
  );
  // No grant request until there is a document to draw (binary/oversized/
  // failed reads never touch the asset surface).
  const {
    urlFor: assetUrlFor,
    error: assetError,
    retry: retryImages,
  } = useAssetGrant(content === null ? null : boundary);

  // A retargeted preview starts at the top, not at the old document's offset.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger.
  useLayoutEffect(() => {
    scrollTopRef.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [path]);

  const onScroll = useCallback(() => {
    scrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
  }, []);

  // New text replaces blocks in place; put the view back where the reader was
  // in case the swap collapsed the document for a frame.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && content !== null && el.scrollTop !== scrollTopRef.current) {
      el.scrollTop = scrollTopRef.current;
    }
  }, [content]);

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownViewToggle mode="rendered" onChange={onSetView} />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto">
        <div className="px-8 py-6">
          {status.kind === "loading" && (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          )}
          {status.kind === "error" && (
            <p className="text-[12px] text-destructive">
              Failed to read file: {status.message}
            </p>
          )}
          {status.kind === "binary" && (
            <p className="text-[12px] text-muted-foreground">
              Binary file — cannot render as markdown.
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="text-[12px] text-muted-foreground">
              File is {status.size} bytes; limit {status.limit}.
            </p>
          )}
          {content !== null && (
            <MarkdownContent
              path={path}
              boundary={boundary}
              content={content}
              assetUrlFor={assetUrlFor}
              assetError={assetError}
              onRetryImages={retryImages}
            />
          )}
        </div>
      </div>
    </div>
  );
}

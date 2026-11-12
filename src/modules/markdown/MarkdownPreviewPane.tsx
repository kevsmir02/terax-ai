import { useAssetGrants } from "@/lib/useAssetGrant";
import { cn } from "@/lib/utils";
import {
  TEXT_SYNTAX_LIMIT_BYTES,
  textReadDecision,
} from "@/modules/preview/lib/limits";
import { checkReadable } from "@/modules/workspace/policy";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { previewBoundary } from "./lib/assetPath";
import {
  documentAssetSummary,
  EMPTY_DOCUMENT_ASSETS,
  grantDocumentAssets,
  NO_DOCUMENT_ASSET_CONSENT,
  type DocumentAssetConsent,
} from "./lib/documentAssets";
import { MarkdownAssetNotice } from "./MarkdownAssetNotice";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownViewToggle } from "./MarkdownViewToggle";
import { useMarkdownDocument } from "./useMarkdownDocument";

type Props = {
  path: string;
  /** The tab this document belongs to; image grants are tab-owned. */
  tabId: number;
  /**
   * The configured Space project root. Never a terminal cwd: reading a
   * document must not change what it may load. A document outside this root
   * is anchored to its own directory instead.
   */
  projectRoot?: string | null;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

export function MarkdownPreviewPane({
  path,
  tabId,
  projectRoot = null,
  visible,
  onSetView,
}: Props) {
  const { status, openAnyway } = useMarkdownDocument(path, visible);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);
  const content = status.kind === "ready" ? status.content : null;
  const boundary = useMemo(
    () => previewBoundary(path, projectRoot),
    [path, projectRoot],
  );
  const summary = useMemo(
    () =>
      content === null
        ? EMPTY_DOCUMENT_ASSETS
        : documentAssetSummary(content, path, {
            boundary,
            isReadable: (abs) => checkReadable(abs).ok,
          }),
    [content, path, boundary],
  );
  // Consent belongs to one document. A retargeted preview starts with no
  // outside grant and no remote loading, so consent cannot travel to another
  // file the person has not seen.
  const [consent, setConsent] = useState<{
    path: string;
    value: DocumentAssetConsent;
  }>({ path, value: NO_DOCUMENT_ASSET_CONSENT });
  const activeConsent =
    consent.path === path ? consent.value : NO_DOCUMENT_ASSET_CONSENT;
  // Keep the grant set equal to what the current text references: a refresh
  // that removes an outside reference also drops its grant.
  const grantedPaths = useMemo(
    () =>
      activeConsent.granted.filter((file) => summary.outside.includes(file)),
    [activeConsent.granted, summary.outside],
  );
  const grantedAssets = useMemo(() => new Set(grantedPaths), [grantedPaths]);

  // No grant request until there is a document to draw (binary/oversized/
  // failed reads never touch the asset surface). A document that was never
  // shown also has no content, so a hidden tab requests nothing.
  const grantPaths = useMemo(
    () => (content === null ? [] : [boundary, ...grantedPaths]),
    [content, boundary, grantedPaths],
  );
  const {
    urlFor: assetUrlFor,
    error: assetError,
    version: assetVersion,
    retry: retryImages,
  } = useAssetGrants(grantPaths, tabId);

  const allowOutside = useCallback(() => {
    setConsent((current) => ({
      path,
      value: grantDocumentAssets(
        summary,
        current.path === path ? current.value : NO_DOCUMENT_ASSET_CONSENT,
        "outside",
      ),
    }));
  }, [path, summary]);

  const loadRemote = useCallback(() => {
    setConsent((current) => ({
      path,
      value: grantDocumentAssets(
        summary,
        current.path === path ? current.value : NO_DOCUMENT_ASSET_CONSENT,
        "remote",
      ),
    }));
  }, [path, summary]);

  const tooLarge =
    status.kind === "toolarge"
      ? textReadDecision(status.size, status.forced)
      : null;
  // Above the approved syntax ceiling the document still opens, without
  // parsing fenced code for highlighting.
  const syntax =
    status.kind === "ready" && status.size <= TEXT_SYNTAX_LIMIT_BYTES;

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
          {tooLarge?.kind === "too-large" && (
            <div className="text-[12px] text-muted-foreground">
              <p>{tooLarge.reason}</p>
              {tooLarge.override && (
                <button
                  type="button"
                  onClick={openAnyway}
                  className="mt-2 rounded-md border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
                >
                  Open anyway (up to 50 MiB, syntax off)
                </button>
              )}
            </div>
          )}
          {content !== null && (
            <>
              <MarkdownAssetNotice
                summary={summary}
                consent={activeConsent}
                boundary={boundary}
                onAllowOutside={allowOutside}
                onLoadRemote={loadRemote}
              />
              <MarkdownContent
                path={path}
                boundary={boundary}
                content={content}
                grantedAssets={grantedAssets}
                allowRemote={activeConsent.remote}
                assetVersion={assetVersion}
                syntax={syntax}
                assetUrlFor={assetUrlFor}
                assetError={assetError}
                onRetryImages={retryImages}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { AssetDeliveryNotice } from "./AssetDeliveryNotice";
import { pdfScaleLabel, type PdfZoomDecision } from "./lib/pdfPage";
import type { PdfTextLayout } from "./lib/pdfText";
import type { PdfViewerState } from "./lib/pdfViewer";

export type PdfPageRendered = {
  readonly pageNumber: number;
  readonly canvas: HTMLCanvasElement | null;
  readonly spans: readonly PdfTextLayout[];
  readonly text: string;
  readonly width: number;
  readonly height: number;
};

export type PdfSearchState = {
  readonly query: string;
  readonly total: number;
  readonly index: number;
  readonly truncated: boolean;
};

type Props = {
  state: PdfViewerState;
  path: string;
  scale: number;
  page: PdfPageRendered | null;
  search: PdfSearchState;
  onOpenExternally: () => void;
  onLoadAnyway: () => void;
  onRetry: () => void;
  onApplySuggestedZoom: (decision: PdfZoomDecision) => void;
  onFit: (mode: "width" | "page") => void;
  onZoom: (direction: 1 | -1) => void;
  onPage: (delta: 1 | -1) => void;
  onGoToPage: (pageNumber: number) => void;
  onSearch: (query: string) => void;
  onSearchStep: (direction: 1 | -1) => void;
  onSetZoomPercent: (percent: number) => void;
  onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

const TOOL_BUTTON =
  "rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-accent disabled:opacity-40";

/**
 * The reader's rendered states and its app-owned toolbar.
 *
 * Presentational on purpose: every state (hidden, gated, corrupt, encrypted,
 * page-too-large, admission-refused, released, ready) can be asserted from
 * static markup, and the app-lab driver drives the same buttons a person uses.
 * The `data-pdf-*` attributes are the reader's own report of what it is
 * showing — the thing the iframe path could not provide.
 */
export function PdfReaderView({
  state,
  path,
  scale,
  page,
  search,
  onOpenExternally,
  onLoadAnyway,
  onRetry,
  onApplySuggestedZoom,
  onFit,
  onZoom,
  onPage,
  onGoToPage,
  onSearch,
  onSearchStep,
  onSetZoomPercent,
  onSearchKeyDown,
}: Props) {
  const pageNumber =
    "pageNumber" in state ? state.pageNumber : (page?.pageNumber ?? 1);
  const pageCount = "pageCount" in state ? state.pageCount : 0;
  const showToolbar =
    state.kind === "ready" ||
    state.kind === "admitting" ||
    state.kind === "page-too-large";

  return (
    <div
      data-pdf-reader=""
      data-pdf-state={state.kind}
      data-pdf-page={pageNumber}
      data-pdf-pages={pageCount}
      data-pdf-scale={scale}
      data-pdf-scale-label={pdfScaleLabel(scale)}
      className="flex h-full w-full flex-col overflow-hidden bg-background"
    >
      {showToolbar && (
        <div
          role="toolbar"
          aria-label="PDF reader"
          data-pdf-toolbar=""
          className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 px-2 py-1"
        >
          <button
            type="button"
            aria-label="Previous page"
            className={TOOL_BUTTON}
            disabled={pageNumber <= 1}
            onClick={() => onPage(-1)}
          >
            ‹
          </button>
          <input
            aria-label="Page number"
            data-pdf-page-input=""
            className="w-10 rounded-md border border-border bg-background px-1 py-0.5 text-center text-xs"
            defaultValue={pageNumber}
            key={`page-${pageNumber}`}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const next = Number(event.currentTarget.value);
              if (Number.isFinite(next)) onGoToPage(next);
            }}
          />
          <span
            className="px-1 text-xs text-muted-foreground"
            data-pdf-page-count=""
          >
            / {pageCount}
          </span>
          <button
            type="button"
            aria-label="Next page"
            className={TOOL_BUTTON}
            disabled={pageNumber >= pageCount}
            onClick={() => onPage(1)}
          >
            ›
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            type="button"
            aria-label="Zoom out"
            className={TOOL_BUTTON}
            onClick={() => onZoom(-1)}
          >
            −
          </button>
          <input
            aria-label="Zoom percent"
            data-pdf-zoom-input=""
            className="w-12 rounded-md border border-border bg-background px-1 py-0.5 text-center text-xs"
            defaultValue={Math.round(scale * 100)}
            key={`zoom-${Math.round(scale * 100)}`}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              onSetZoomPercent(Number(event.currentTarget.value));
            }}
          />
          <span
            className="min-w-10 text-center text-xs text-muted-foreground"
            data-pdf-zoom-label=""
          >
            {pdfScaleLabel(scale)}
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            className={TOOL_BUTTON}
            onClick={() => onZoom(1)}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Fit width"
            className={TOOL_BUTTON}
            onClick={() => onFit("width")}
          >
            Fit width
          </button>
          <button
            type="button"
            aria-label="Fit page"
            className={TOOL_BUTTON}
            onClick={() => onFit("page")}
          >
            Fit page
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
          <input
            aria-label="Search document"
            data-pdf-search-input=""
            className="w-32 rounded-md border border-border bg-background px-2 py-0.5 text-xs"
            placeholder="Search"
            value={search.query}
            onChange={(event) => onSearch(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
          <span
            className="min-w-14 text-xs text-muted-foreground"
            data-pdf-search-count=""
            data-pdf-search-total={search.total}
            data-pdf-search-truncated={search.truncated ? "1" : "0"}
          >
            {search.total === 0
              ? search.query.trim()
                ? "No matches"
                : ""
              : `${search.index + 1} of ${search.total}${search.truncated ? "+" : ""}`}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            className={TOOL_BUTTON}
            disabled={search.total === 0}
            onClick={() => onSearchStep(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            className={TOOL_BUTTON}
            disabled={search.total === 0}
            onClick={() => onSearchStep(1)}
          >
            ↓
          </button>
          <span className="ml-auto max-w-48 truncate text-[11px] text-muted-foreground">
            {path.split("/").pop()}
          </span>
        </div>
      )}

      {state.kind === "ready" || state.kind === "admitting" ? (
        <div
          className="relative flex min-h-0 flex-1 justify-center overflow-auto bg-muted/20 p-4"
          data-pdf-page-area=""
        >
          {state.kind === "ready" && page ? (
            <div
              data-pdf-page-box=""
              data-pdf-render-bytes={state.renderBytes}
              data-pdf-decoded-bytes={state.decodedBytes}
              className="relative shrink-0 bg-white shadow-sm"
              style={{ width: page.width, height: page.height }}
            >
              <CanvasHost
                canvas={page.canvas}
                width={page.width}
                height={page.height}
              />
              <div
                data-pdf-text-layer=""
                data-pdf-text-spans={page.spans.length}
                data-pdf-page-text={page.text}
                className="absolute inset-0 select-text"
                style={{ lineHeight: 1 }}
              >
                {page.spans.map((span) => (
                  <span
                    key={`${span.itemIndex}:${span.left}:${span.top}`}
                    data-pdf-text-item={span.itemIndex}
                    data-pdf-text-match={span.matched ? "1" : "0"}
                    data-pdf-text-current={span.current ? "1" : "0"}
                    className="absolute cursor-text whitespace-pre text-transparent"
                    style={{
                      left: `${span.left}px`,
                      top: `${span.top}px`,
                      fontSize: `${span.fontSize}px`,
                      fontFamily:
                        "Liberation Sans, Helvetica, Arial, sans-serif",
                      background: span.current
                        ? "rgba(250, 204, 21, 0.55)"
                        : span.matched
                          ? "rgba(250, 204, 21, 0.3)"
                          : undefined,
                    }}
                  >
                    {span.str}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <p className="self-center text-xs text-muted-foreground">
              Rendering page {pageNumber}…
            </p>
          )}
        </div>
      ) : state.kind === "hidden" ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-xs text-muted-foreground">
            The PDF reader is unloaded while this tab is not on screen.
          </p>
        </div>
      ) : state.kind === "loading" ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-xs text-muted-foreground">
            Reading the PDF{state.pages ? ` (${state.pages} pages)` : ""}…
          </p>
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-pdf-notice={state.kind}
        >
          <div className="min-h-0 flex-1">
            {state.kind === "gated-confirm" ? (
              <AssetDeliveryNotice
                title="Large PDF needs an explicit choice"
                reason={state.reason}
                alternatives={state.alternatives}
                onLoadAnyway={onLoadAnyway}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "gated-refused" ? (
              <AssetDeliveryNotice
                title="PDF too large to read"
                reason={state.reason}
                alternatives={state.alternatives}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "page-too-large" ? (
              <AssetDeliveryNotice
                title="Page too large to render"
                reason={state.reason}
                alternatives={state.alternatives}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "admission-refused" ? (
              <AssetDeliveryNotice
                title="No room for another decoded preview"
                reason={state.reason}
                alternatives={state.alternatives}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "evicted" ? (
              <AssetDeliveryNotice
                title="Preview released to keep memory bounded"
                reason={state.reason}
                alternatives={state.alternatives}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "corrupt" ? (
              <AssetDeliveryNotice
                title="PDF could not be read"
                reason={state.reason}
                alternatives={state.alternatives}
                onRetry={state.retryable ? onRetry : undefined}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "password" ? (
              <AssetDeliveryNotice
                title="PDF is encrypted"
                reason={state.reason}
                alternatives={state.alternatives}
                onOpenExternally={onOpenExternally}
              />
            ) : state.kind === "unsupported" ? (
              <AssetDeliveryNotice
                title="PDF is not supported"
                reason={state.reason}
                alternatives={state.alternatives}
                onOpenExternally={onOpenExternally}
              />
            ) : (
              <AssetDeliveryNotice
                title="PDF could not be opened"
                reason={
                  state.kind === "unreadable" ? state.reason : "Unknown state."
                }
                alternatives={
                  state.kind === "unreadable" ? state.alternatives : []
                }
                onRetry={
                  state.kind === "unreadable" && state.retryable
                    ? onRetry
                    : undefined
                }
                onOpenExternally={onOpenExternally}
              />
            )}
          </div>
          {state.kind === "page-too-large" &&
            state.suggestedPercent !== null && (
              <div className="flex justify-center pb-6">
                <button
                  type="button"
                  data-pdf-fit-suggested=""
                  className={TOOL_BUTTON}
                  onClick={() =>
                    onApplySuggestedZoom({
                      kind: "refuse",
                      renderBytes: state.renderBytes,
                      reason: state.reason,
                      alternatives: state.alternatives,
                      suggestedScale: state.suggestedScale,
                      suggestedPercent: state.suggestedPercent,
                      scale: state.scale,
                      outputScale: 1,
                    })
                  }
                >
                  Reduce to {state.suggestedPercent}%
                </button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

/**
 * Shows one cached canvas without letting React re-create it: the raster lives
 * in the reader's bounded cache (so returning to a page is instant) and is
 * attached to this host while the page is on screen.
 */
function CanvasHost({
  canvas,
  width,
  height,
}: {
  canvas: HTMLCanvasElement | null;
  width: number;
  height: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    if (!canvas) {
      node.replaceChildren();
      return;
    }
    canvas.style.display = "block";
    if (canvas.parentNode !== node) node.replaceChildren(canvas);
    return () => {
      if (canvas.parentNode === node) node.removeChild(canvas);
    };
  }, [canvas]);
  return (
    <div
      ref={host}
      role="img"
      aria-label="Rendered PDF page"
      data-pdf-canvas-host=""
      style={{ width, height }}
    />
  );
}

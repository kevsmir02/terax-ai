import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AssetDeliveryDecision,
  assetDeliveryDecision,
} from "./lib/assetDelivery";
import { PDF_PAGE_LIMIT_BYTES } from "./lib/limits";
import {
  clampScale,
  pdfFitScale,
  pdfScaleLabel,
  pdfSteppedScale,
  type PdfZoomDecision,
} from "./lib/pdfPage";
import {
  buildPdfPageText,
  pdfMatchForSpan,
  searchPdfDocument,
  searchStep,
  type PdfDocumentMatch,
  type PdfSearchResult,
} from "./lib/pdfSearch";
import {
  pdfTextIsRotated,
  pdfTransform,
  placePdfTextItem,
  type PdfTextLayout,
} from "./lib/pdfText";
import {
  pdfViewerRequest,
  pdfViewerState,
  type PdfViewerState,
} from "./lib/pdfViewer";
import { PdfRasterCache } from "./lib/pdfCache";
import { useDecodedViewer } from "./lib/useDecodedViewer";
import { PdfReaderView, type PdfSearchState } from "./PdfReaderView";
import { readPageTextItems } from "./pdf/loader";
import {
  type PageRaster,
  usePdfDocument,
  usePdfPage,
  usePdfPageCanvas,
} from "./pdf/usePdfDocument";

/** Pages searched in one pass; beyond this the toolbar says the result is partial. */
const SEARCH_PAGE_CAP = 500;

type Props = {
  path: string;
  tabId: number;
  bytes: number;
  /** The tab-scoped asset grant's token, or undefined while it is pending. */
  token: string | undefined;
  visible: boolean;
  onOpenExternally: () => void;
  /** Shown while a grant failure has to be explained instead of a document. */
  grantError?: string;
};

type Zoom =
  | { kind: "fit"; mode: "width" | "page" }
  | { kind: "manual"; scale: number };

/**
 * The bounded PDF reader.
 *
 * It replaces the iframe path that issue #30 rejected: the document is the
 * app's own DOM, so page count, page number, zoom, search matches, selectable
 * text and every failure are observable and bound by code we test. The order
 * the surfaces apply is `PdfReaderView`/`pdfViewerState`'s: delivery gate →
 * document → page geometry → 32 MiB per-page ceiling → decoded-viewer
 * admission → paint. A hidden tab unloads the document and releases its
 * rasters; closing the tab releases the grant through the tab scope.
 */
export default function PdfReader({
  path,
  tabId,
  bytes,
  token,
  visible,
  onOpenExternally,
  grantError,
}: Props) {
  const [override, setOverride] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoom, setZoom] = useState<Zoom>({ kind: "fit", mode: "width" });
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<PdfSearchResult | null>(
    null,
  );
  const [matchIndex, setMatchIndex] = useState(0);
  const [cacheBytes, setCacheBytes] = useState(0);
  const [cachePages, setCachePages] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ width: 0, height: 0 });

  const cacheRef = useRef<PdfRasterCache<PageRaster> | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = new PdfRasterCache<PageRaster>(
      PDF_PAGE_LIMIT_BYTES,
      (_page, raster) => {
        // Drop the backing store now instead of waiting for a GC: this is what
        // makes "release on close" a measurement, not a promise.
        raster.canvas.width = 0;
        raster.canvas.height = 0;
      },
    );
  }
  const cache = cacheRef.current;

  const gate: AssetDeliveryDecision = grantError
    ? {
        kind: "refuse",
        bytes,
        reason: `This preview could not be authorized: ${grantError}`,
        alternatives: ["open-externally"],
      }
    : assetDeliveryDecision(bytes, "pdf", { override });
  const enabled = gate.kind === "load" && visible && Boolean(token);

  const pdfDocument = usePdfDocument({
    path,
    token,
    enabled,
    allowOverride: override,
    attempt,
  });
  const pageCount = pdfDocument.pages;
  const pageNumber = Math.min(
    Math.max(1, pageIndex + 1),
    Math.max(1, pageCount),
  );
  const pageHandle = usePdfPage({
    document: pdfDocument.document,
    pageNumber,
    enabled: enabled && pdfDocument.outcome?.kind === "loaded",
  });

  // The pane's own size, for fit-width/fit-page. Measured, never assumed: the
  // reader refits when the window or the split changes.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setPane({ width: node.clientWidth, height: node.clientHeight });
    });
    observer.observe(node);
    setPane({ width: node.clientWidth, height: node.clientHeight });
    return () => observer.disconnect();
  }, []);

  const outputScale = useMemo(() => {
    const ratio =
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    // A 3× display would triple every raster for no reading benefit; the
    // ceiling is applied to what the canvas really allocates either way.
    return Math.min(Math.max(ratio, 1), 3);
  }, []);

  const paneFit = useMemo(() => {
    // The page area loses the toolbar and its padding; fitting to the whole
    // reader box would always overflow by exactly that.
    return {
      width: Math.max(0, pane.width - 32),
      height: Math.max(0, pane.height - 72),
    };
  }, [pane]);

  const scale = useMemo(() => {
    if (zoom.kind === "manual") return clampScale(zoom.scale);
    if (!pageHandle.geometry) return 1;
    return pdfFitScale(pageHandle.geometry, paneFit, zoom.mode);
  }, [zoom, pageHandle.geometry, paneFit]);

  // A new raster scale invalidates every cached raster: keeping them would mean
  // the memory bound no longer described what the reader holds.
  const rasterKey = `${scale.toFixed(4)}:${outputScale}`;
  const rasterKeyRef = useRef("");
  useEffect(() => {
    if (rasterKeyRef.current === rasterKey) return;
    rasterKeyRef.current = rasterKey;
    cache.clear();
    setCacheBytes(0);
    setCachePages(0);
  }, [cache, rasterKey]);

  const candidate = pdfViewerState({
    visible: Boolean(visible && !grantError),
    gate,
    load: pdfDocument.outcome,
    page: pageHandle.geometry,
    pageCount,
    pageIndex,
    scale,
    outputScale,
    cacheBytes,
    admission: null,
    evicted: false,
  });
  const requested = pdfViewerRequest(candidate);
  const viewer = useDecodedViewer({
    id: `pdf:${tabId}:${path}`,
    tabId: String(tabId),
    decodedBytes: requested?.decodedBytes ?? 0,
    visible,
    enabled: Boolean(requested),
  });

  const state: PdfViewerState = pdfViewerState({
    visible: Boolean(visible && !grantError),
    gate,
    load: pdfDocument.outcome,
    page: pageHandle.geometry,
    pageCount,
    pageIndex,
    scale,
    outputScale,
    cacheBytes,
    admission: viewer.admission,
    evicted: viewer.evicted,
  });

  // A released viewer must not keep its rasters: the budget it was holding is
  // exactly what another preview needed.
  useEffect(() => {
    if (!viewer.evicted) return;
    cache.clear();
    setCacheBytes(0);
    setCachePages(0);
  }, [viewer.evicted, cache]);

  const rendered = usePdfPageCanvas({
    page: pageHandle.page,
    scale,
    outputScale,
    enabled: state.kind === "ready",
    cache,
  });

  const cacheSnapshot = `${rendered.renderBytes}:${pageIndex}`;
  useEffect(() => {
    // `cacheSnapshot` is the render's completion (bytes + page), not data this
    // effect reads: the cache is mutable and has no subscription of its own.
    void cacheSnapshot;
    setCacheBytes(cache.bytes);
    setCachePages(cache.pages().length);
  }, [cache, cacheSnapshot]);

  // Search reads extracted text, never rasters: a query does not decode pages.
  useEffect(() => {
    const needle = query.trim();
    if (!needle || !pdfDocument.document) {
      setSearchResult(null);
      setMatchIndex(0);
      return;
    }
    const source = pdfDocument.document;
    let cancelled = false;
    // Typing a query is not a document read: extraction waits for a pause, and
    // a newer keystroke cancels the pass before it starts.
    const timer = setTimeout(() => {
      void (async () => {
        const limit = Math.min(pageCount, SEARCH_PAGE_CAP);
        const pages: string[] = [];
        for (let number = 1; number <= limit; number += 1) {
          const handle = await pageHandleFor(source, number);
          if (!handle) break;
          pages.push(buildPdfPageText(handle).text);
          if (cancelled) return;
        }
        if (cancelled) return;
        const result = searchPdfDocument(pages, needle);
        setSearchResult({
          ...result,
          truncated: result.truncated || pageCount > limit,
        });
        setMatchIndex(0);
        const first = result.matches[0];
        if (first) setPageIndex(first.page);
      })();
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, pdfDocument.document, pageCount]);

  const textLayout = useMemo(() => {
    if (!pageHandle.page || !pageHandle.geometry) {
      return { spans: [] as PdfTextLayout[], text: "" };
    }
    const built = buildPdfPageText(pageHandle.text);
    const viewport = pageHandle.page.getViewport({ scale });
    const matches = currentPageMatches(searchResult, pageIndex);
    const current = currentMatch(searchResult, matchIndex);
    const spans: PdfTextLayout[] = [];
    for (const span of built.spans) {
      const item = pageHandle.text[span.itemIndex];
      if (!item) continue;
      const tx = pdfTransform(viewport.transform, item.transform);
      const placed = placePdfTextItem(tx, {
        rotated: pdfTextIsRotated(tx),
      });
      spans.push({
        itemIndex: span.itemIndex,
        str: item.str,
        left: placed.left,
        top: placed.top,
        fontSize: placed.fontSize,
        matched: pdfMatchForSpan(span, matches),
        current:
          current !== null &&
          current.page === pageIndex &&
          pdfMatchForSpan(span, [current]),
      });
    }
    return { spans, text: built.text };
  }, [
    pageHandle.page,
    pageHandle.text,
    pageHandle.geometry,
    scale,
    searchResult,
    matchIndex,
    pageIndex,
  ]);

  const search: PdfSearchState = {
    query,
    total: searchResult?.matches.length ?? 0,
    index: Math.min(
      matchIndex,
      Math.max(0, (searchResult?.matches.length ?? 1) - 1),
    ),
    truncated: searchResult?.truncated ?? false,
  };

  const goToPage = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return;
      const clamped = Math.min(
        Math.max(1, Math.round(next)),
        Math.max(1, pageCount),
      );
      setPageIndex(clamped - 1);
    },
    [pageCount],
  );

  const applySuggested = useCallback((decision: PdfZoomDecision) => {
    if (decision.kind !== "refuse" || decision.suggestedScale === null) return;
    setZoom({ kind: "manual", scale: decision.suggestedScale });
  }, []);

  const onSearchChange = useCallback((next: string) => {
    setQuery(next);
  }, []);

  const onSearchStep = useCallback(
    (direction: 1 | -1) => {
      const matches = searchResult?.matches ?? [];
      const next = searchStep(matchIndex, direction, matches.length);
      if (next === null) return;
      setMatchIndex(next);
      const match = matches[next];
      if (match) setPageIndex(match.page);
    },
    [matchIndex, searchResult],
  );

  const retry = useCallback(() => {
    cache.clear();
    setCacheBytes(0);
    setAttempt((value) => value + 1);
  }, [cache]);

  // Keyboard reading works while this pane has focus: PageUp/PageDown, Home,
  // End and zoom. The listener is on the window because a canvas that was
  // clicked does not keep a focusable element; it only acts when focus is in
  // this reader (or nowhere), so another tab's keys never move this page.
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const owner = root.ownerDocument;
      const active = owner.activeElement;
      if (active && active !== owner.body && !root.contains(active)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        root
          .querySelector<HTMLInputElement>("[data-pdf-search-input]")
          ?.focus();
        return;
      }
      if (event.key === "PageDown" || event.key === "ArrowRight") {
        event.preventDefault();
        setPageIndex((value) => value + 1);
      } else if (event.key === "PageUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        setPageIndex((value) => Math.max(0, value - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setPageIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setPageIndex(Math.max(0, pageCount - 1));
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom({ kind: "manual", scale: pdfSteppedScale(scale, 1) });
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom({ kind: "manual", scale: pdfSteppedScale(scale, -1) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, pageCount, scale]);

  return (
    <div
      ref={rootRef}
      className="h-full w-full"
      data-pdf-cache-bytes={cacheBytes}
      data-pdf-cache-pages={cachePages}
      data-pdf-output-scale={outputScale}
      data-pdf-pane={`${Math.round(paneFit.width)}x${Math.round(paneFit.height)}`}
      data-pdf-render-status={rendered.status}
      data-pdf-render-fallback={rendered.renderFallback ?? undefined}
      data-pdf-render-error={rendered.failed ?? undefined}
    >
      <PdfReaderView
        state={state}
        path={path}
        scale={scale}
        page={
          state.kind === "ready" && pageHandle.page
            ? {
                pageNumber,
                canvas: rendered.canvas,
                spans: textLayout.spans,
                text: textLayout.text,
                width: Math.ceil(pageHandle.page.getViewport({ scale }).width),
                height: Math.ceil(
                  pageHandle.page.getViewport({ scale }).height,
                ),
              }
            : null
        }
        search={search}
        onOpenExternally={onOpenExternally}
        onLoadAnyway={() => setOverride(true)}
        onRetry={retry}
        onApplySuggestedZoom={applySuggested}
        onFit={(mode) => setZoom({ kind: "fit", mode })}
        onZoom={(direction) =>
          setZoom({ kind: "manual", scale: pdfSteppedScale(scale, direction) })
        }
        onPage={(delta) => goToPage(pageNumber + delta)}
        onGoToPage={goToPage}
        onSearch={onSearchChange}
        onSearchStep={onSearchStep}
        onSetZoomPercent={(percent) => {
          if (!Number.isFinite(percent) || percent <= 0) return;
          setZoom({ kind: "manual", scale: clampScale(percent / 100) });
        }}
        onSearchKeyDown={(event) => {
          if (event.key === "Enter" && query.trim()) {
            event.preventDefault();
            onSearchStep(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="sr-only" data-pdf-scale-announce="">
        {pdfScaleLabel(scale)}
      </span>
    </div>
  );
}

/** Loads one page's text items without keeping the page proxy alive. */
async function pageHandleFor(
  document: { getPage: (number: number) => Promise<unknown> },
  pageNumber: number,
) {
  const page = (await document.getPage(pageNumber)) as Parameters<
    typeof readPageTextItems
  >[0] & { cleanup: () => void };
  const items = await readPageTextItems(page);
  page.cleanup();
  return items;
}

function currentPageMatches(
  result: PdfSearchResult | null,
  pageIndex: number,
): PdfDocumentMatch[] {
  return (result?.matches ?? []).filter((match) => match.page === pageIndex);
}

function currentMatch(
  result: PdfSearchResult | null,
  index: number,
): PdfDocumentMatch | null {
  const matches = result?.matches ?? [];
  return matches[index] ?? null;
}

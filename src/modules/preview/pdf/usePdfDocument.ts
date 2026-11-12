import { useEffect, useRef, useState } from "react";
import { classifyPdfError } from "../lib/pdfLoad";
import type { PdfLoadOutcome } from "../lib/pdfViewer";
import type { PdfPageGeometry } from "../lib/pdfPage";
import {
  closePdfDocument,
  loadPdfDocument,
  loadPdfPage,
  type OpenedPdf,
  PdfReadFailure,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PdfTextItemGeometry,
  readPageTextItems,
} from "./loader";

/**
 * Document and page loading for the reader.
 *
 * Every hook here does nothing unless its tab is on screen: a hidden tab must
 * not keep a document, a worker, a page raster or a grant alive (the iframe
 * path kept all four). Teardown destroys the pdf.js document, which releases
 * the worker-side page cache and the transferred bytes in one call.
 */

type DocumentState = {
  readonly key: string;
  readonly outcome: PdfLoadOutcome | null;
  readonly document: PDFDocumentProxy | null;
  readonly pages: number;
};

export function usePdfDocument(input: {
  readonly path: string;
  readonly token: string | undefined;
  /** Only a visible tab with an allowed delivery gate loads the runtime. */
  readonly enabled: boolean;
  readonly allowOverride: boolean;
  /** Bumped by the retry action to re-read the document. */
  readonly attempt: number;
}): {
  outcome: PdfLoadOutcome | null;
  document: PDFDocumentProxy | null;
  pages: number;
} {
  const { path, token, enabled, allowOverride, attempt } = input;
  const key = `${path}:${token ?? ""}:${allowOverride ? "override" : "normal"}:${attempt}`;
  const [state, setState] = useState<DocumentState>({
    key: "",
    outcome: null,
    document: null,
    pages: 0,
  });

  useEffect(() => {
    if (!enabled || !token) return;
    let disposed = false;
    let opened: OpenedPdf | null = null;
    setState({ key, outcome: null, document: null, pages: 0 });
    loadPdfDocument({ path, token, allowOverride })
      .then(({ opened: loaded }) => {
        opened = loaded;
        if (disposed) {
          void closePdfDocument(opened);
          return;
        }
        setState({
          key,
          outcome: { kind: "loaded", pages: loaded.pages, encrypted: false },
          document: loaded.document,
          pages: loaded.pages,
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          key,
          outcome:
            error instanceof PdfReadFailure
              ? {
                  kind: "unreadable",
                  reason: error.detail.message,
                }
              : classifyPdfError(error),
          document: null,
          pages: 0,
        });
      });
    return () => {
      disposed = true;
      // Destroying the document releases the worker, every page proxy and the
      // document bytes; a late completion above destroys its own document.
      void closePdfDocument(opened);
    };
  }, [path, token, enabled, allowOverride, key]);

  return state.key === key
    ? { outcome: state.outcome, document: state.document, pages: state.pages }
    : { outcome: null, document: null, pages: 0 };
}

type PageState = {
  readonly key: string;
  readonly page: PDFPageProxy | null;
  readonly geometry: PdfPageGeometry | null;
  readonly text: PdfTextItemGeometry[];
  readonly failed: string | null;
};

export function usePdfPage(input: {
  readonly document: PDFDocumentProxy | null;
  readonly pageNumber: number;
  readonly enabled: boolean;
}): {
  page: PDFPageProxy | null;
  geometry: PdfPageGeometry | null;
  text: PdfTextItemGeometry[];
  failed: string | null;
} {
  const { document, pageNumber, enabled } = input;
  const key = document ? `${pageNumber}` : "";
  const [state, setState] = useState<PageState>({
    key: "",
    page: null,
    geometry: null,
    text: [],
    failed: null,
  });

  useEffect(() => {
    if (!document || !enabled || pageNumber < 1) return;
    let disposed = false;
    let page: PDFPageProxy | null = null;
    void loadPdfPage(document, pageNumber)
      .then(async (handle) => {
        if (disposed) {
          handle.page.cleanup();
          return;
        }
        page = handle.page;
        const viewport = handle.page.getViewport({ scale: 1 });
        const text = await readPageTextItems(handle.page);
        if (disposed) return;
        setState({
          key,
          page: handle.page,
          geometry: { widthPt: viewport.width, heightPt: viewport.height },
          text,
          failed: null,
        });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          key,
          page: null,
          geometry: null,
          text: [],
          failed: String((error as { message?: string })?.message ?? error),
        });
      });
    return () => {
      disposed = true;
      page?.cleanup();
    };
  }, [document, enabled, pageNumber, key]);

  return state.key === key
    ? {
        page: state.page,
        geometry: state.geometry,
        text: state.text,
        failed: state.failed,
      }
    : { page: null, geometry: null, text: [], failed: null };
}

/**
 * Renders one page into a canvas, reusing a cached raster for the same page and
 * scale. The raster is allocated only when `enabled` (i.e. after the per-page
 * ceiling and decoded-viewer admission passed); a cancelled render is expected
 * and is not surfaced as an error.
 */
export type PageRenderStatus =
  | "idle"
  | "rendering"
  | "painted"
  | "cached"
  | "failed";

export function usePdfPageCanvas(input: {
  readonly page: PDFPageProxy | null;
  readonly scale: number;
  readonly outputScale: number;
  readonly enabled: boolean;
  readonly cache: PageRasterCache;
}): {
  canvas: HTMLCanvasElement | null;
  renderBytes: number;
  failed: string | null;
  status: PageRenderStatus;
  /** Set only when a stalled display render was redone with the print intent. */
  renderFallback: "print" | null;
} {
  const { page, scale, outputScale, enabled, cache } = input;
  const [state, setState] = useState<{
    canvas: HTMLCanvasElement | null;
    renderBytes: number;
    failed: string | null;
    status: PageRenderStatus;
    renderFallback: "print" | null;
  }>({
    canvas: null,
    renderBytes: 0,
    failed: null,
    status: "idle",
    renderFallback: null,
  });
  const renderRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => {
    if (!page || !enabled) {
      setState({
        canvas: null,
        renderBytes: 0,
        failed: null,
        status: "idle",
        renderFallback: null,
      });
      return;
    }
    let disposed = false;
    const cached = cache.get(page.pageNumber);
    if (cached) {
      setState({
        canvas: cached.canvas,
        renderBytes: cached.bytes,
        failed: null,
        status: "cached",
        renderFallback: null,
      });
      return;
    }
    const viewport = page.getViewport({ scale });
    const width = Math.ceil(viewport.width * outputScale);
    const height = Math.ceil(viewport.height * outputScale);
    const bytes = width * height * 4;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      setState({
        canvas: null,
        renderBytes: 0,
        failed: "This webview could not allocate a canvas for the page.",
        status: "failed",
        renderFallback: null,
      });
      return;
    }
    setState({
      canvas: null,
      renderBytes: 0,
      failed: null,
      status: "rendering",
      renderFallback: null,
    });

    // PDF.js schedules a *display* render on animation frames, which WebKit
    // suspends for an occluded or hidden window. A page on screen must not stay
    // blank because of that, so a render that makes no progress for four
    // seconds is cancelled and redone with the print intent, whose scheduling
    // is microtask-based. The fallback is reported (`renderFallback`), never
    // silently substituted: for normal documents the pixels are identical, and
    // a document with optional-content layers was already showing its display
    // defaults for the four seconds before the fallback.
    let active: { cancel: () => void } | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let finished = false;
    let fallback: "print" | null = null;

    const clearWatchdog = () => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = null;
    };

    const start = (
      intent: "display" | "print",
      target: HTMLCanvasElement,
      targetContext: CanvasRenderingContext2D,
    ) => {
      const task = page.render({
        canvas: target,
        canvasContext: targetContext,
        viewport,
        intent,
        transform:
          outputScale === 1
            ? undefined
            : [outputScale, 0, 0, outputScale, 0, 0],
        background: "#ffffff",
      });
      active = task;
      renderRef.current = task;
      task.promise
        .then(() => {
          if (disposed || finished) return;
          finished = true;
          clearWatchdog();
          // Cache with the page on screen protected from its own eviction pass.
          cache.put(
            page.pageNumber,
            bytes,
            { canvas: target, bytes },
            { protect: page.pageNumber },
          );
          setState({
            canvas: target,
            renderBytes: bytes,
            failed: null,
            status: "painted",
            renderFallback: fallback,
          });
        })
        .catch((error: unknown) => {
          if (disposed || finished) return;
          const name = String((error as { name?: string })?.name ?? "");
          if (name === "RenderingCancelledException") return;
          clearWatchdog();
          setState({
            canvas: null,
            renderBytes: 0,
            failed: String((error as { message?: string })?.message ?? error),
            status: "failed",
            renderFallback: fallback,
          });
        });
      return task;
    };

    const displayTask = start("display", canvas, context);
    watchdog = setTimeout(() => {
      if (disposed || finished) return;
      try {
        displayTask.cancel();
      } catch {
        // The task already finished; the next branch sees `finished`.
      }
      if (disposed || finished) return;
      fallback = "print";
      const retryCanvas = document.createElement("canvas");
      retryCanvas.width = width;
      retryCanvas.height = height;
      retryCanvas.style.width = canvas.style.width;
      retryCanvas.style.height = canvas.style.height;
      const retryContext = retryCanvas.getContext("2d", { alpha: false });
      if (!retryContext) {
        setState({
          canvas: null,
          renderBytes: 0,
          failed: "This webview could not allocate a canvas for the page.",
          status: "failed",
          renderFallback: fallback,
        });
        return;
      }
      const printTask = start("print", retryCanvas, retryContext);
      watchdog = setTimeout(() => {
        if (disposed || finished) return;
        try {
          printTask.cancel();
        } catch {
          // Already finished.
        }
        setState({
          canvas: null,
          renderBytes: 0,
          failed:
            "The page did not finish rendering in this webview. Open the PDF externally.",
          status: "failed",
          renderFallback: fallback,
        });
      }, 15_000);
    }, 4000);

    return () => {
      disposed = true;
      clearWatchdog();
      try {
        active?.cancel();
      } catch {
        // The task already finished.
      }
      renderRef.current = null;
    };
  }, [page, scale, outputScale, enabled, cache]);

  return state;
}

export type PageRaster = { canvas: HTMLCanvasElement; bytes: number };
export type PageRasterCache = {
  get(page: number): PageRaster | undefined;
  put(
    page: number,
    bytes: number,
    value: PageRaster,
    options: { protect?: number },
  ): { evicted: number[]; stored: boolean };
  readonly bytes: number;
  pages(): number[];
  clear(): void;
};

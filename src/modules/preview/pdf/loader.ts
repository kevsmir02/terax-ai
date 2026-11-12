import { invoke } from "@tauri-apps/api/core";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";

/**
 * The lazy PDF runtime.
 *
 * This module is the only place that imports `pdfjs-dist`; it is reached
 * exclusively through the reader's dynamic `import()`, so no PDF code is in a
 * startup chunk. Everything it fetches is same-origin and shipped from
 * `node_modules/pdfjs-dist` by `scripts/vite-pdfjs-assets.mjs`: standard fonts,
 * CMaps, the wasm image decoders, the ICC profile and the worker. No document
 * can make the reader fetch a remote URL, and the document-authority surfaces
 * are off: no scripting manager, `enableXfa: false`, and no document-provided
 * base URL.
 */

const BASE = import.meta.env.BASE_URL || "/";

/** A URL under the app's own `/pdfjs/` runtime directory. */
function runtime(relative: string): string {
  return new URL(`${BASE}pdfjs/${relative}`, window.location.href).href;
}

GlobalWorkerOptions.workerSrc = runtime("pdf.worker.min.mjs");

/** One delivery refusal the native asset command reported, as structured data. */
export type PdfAssetError = {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly alternatives: readonly string[];
  readonly overrideAllowed: boolean;
  readonly size: number | null;
};

export class PdfReadFailure extends Error {
  readonly detail: PdfAssetError;
  constructor(detail: PdfAssetError) {
    super(detail.message);
    this.name = "PdfReadFailure";
    this.detail = detail;
  }
}

function assetError(error: unknown): PdfAssetError {
  if (typeof error === "object" && error !== null && "code" in error) {
    const value = error as Partial<PdfAssetError>;
    return {
      status: Number(value.status ?? 0),
      code: String(value.code ?? "unreadable"),
      message: String(value.message ?? "The document could not be read."),
      alternatives: Array.isArray(value.alternatives) ? value.alternatives : [],
      overrideAllowed: Boolean(value.overrideAllowed),
      size: typeof value.size === "number" ? value.size : null,
    };
  }
  return {
    status: 0,
    code: "unreadable",
    message: typeof error === "string" ? error : String(error),
    alternatives: ["open-externally"],
    overrideAllowed: false,
    size: null,
  };
}

/**
 * Reads a granted document's bytes through the native asset command, which runs
 * the same bounded delivery as the `asset:` protocol (grant, path checks,
 * `DeliveryLimits`). The reader never fetches the file itself.
 */
export async function readGrantedAsset(input: {
  readonly path: string;
  readonly token: string;
  readonly allowOverride: boolean;
}): Promise<Uint8Array> {
  try {
    const raw = await invoke<ArrayBuffer | Uint8Array>("asset_read_bytes", {
      path: input.path,
      token: input.token,
      allowOverride: input.allowOverride,
    });
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  } catch (error) {
    throw new PdfReadFailure(assetError(error));
  }
}

export type OpenedPdf = {
  readonly document: PDFDocumentProxy;
  readonly pages: number;
  /** The loading task owns the worker; destroying it releases everything. */
  readonly task: PDFDocumentLoadingTask;
};

/** Opens one document from bytes already bounded by the delivery gate. */
export async function openPdfDocument(data: Uint8Array): Promise<OpenedPdf> {
  const task = getDocument({
    data,
    standardFontDataUrl: runtime("standard_fonts/"),
    cMapUrl: runtime("cmaps/"),
    wasmUrl: runtime("wasm/"),
    iccUrl: runtime("iccs/"),
    // A document must not be able to contact anything or open XFA forms
    // (which need scripting). PDF.js never executes document JavaScript; the
    // reader also supplies no remote URL, so nothing in a document can fetch.
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: false,
  });
  const document = await task.promise;
  return { document, pages: document.numPages, task };
}

/** Reads the whole document through the reader's one sanctioned native path. */
export async function loadPdfDocument(input: {
  readonly path: string;
  readonly token: string;
  readonly allowOverride: boolean;
}): Promise<{ opened: OpenedPdf; bytes: number }> {
  const data = await readGrantedAsset(input);
  const opened = await openPdfDocument(data);
  return { opened, bytes: data.byteLength };
}

/** Releases every worker-side object and the transferred document bytes. */
export async function closePdfDocument(
  opened: OpenedPdf | null,
): Promise<void> {
  if (!opened) return;
  try {
    await opened.task.destroy();
  } catch {
    // A destroyed worker is already released; nothing to report.
  }
}

/** The page's native geometry at 72 DPI (scale 1), in PDF points. */
export async function readPageGeometry(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<{ widthPt: number; heightPt: number }> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  return { widthPt: viewport.width, heightPt: viewport.height };
}

export type PdfPageHandle = {
  readonly page: PDFPageProxy;
  readonly pageNumber: number;
};

export async function loadPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<PdfPageHandle> {
  const page = await document.getPage(pageNumber);
  return { page, pageNumber };
}

/** One extracted text run, with the transform the text layer needs. */
export type PdfTextItemGeometry = {
  readonly str: string;
  readonly hasEOL: boolean;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
};

/** Text items of one page, in reading order, ready for `buildPdfPageText`. */
export async function readPageTextItems(
  page: PDFPageProxy,
): Promise<PdfTextItemGeometry[]> {
  const content = await page.getTextContent();
  return content.items.flatMap((item) =>
    "str" in item
      ? [
          {
            str: item.str,
            hasEOL: Boolean(item.hasEOL),
            transform: item.transform,
            width: item.width,
            height: item.height,
          },
        ]
      : [],
  );
}

export type { PDFDocumentProxy, PDFPageProxy };

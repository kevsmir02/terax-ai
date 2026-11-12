import {
  PDF_PAGE_LIMIT_BYTES,
  type LimitAlternative,
  MIB,
  pdfPageDecision,
} from "./limits";

/**
 * Page geometry and zoom arithmetic for the PDF reader.
 *
 * The approved ceiling is about the raster the canvas allocates, not about CSS
 * size: a 4 KB page can need 80 MiB decoded at 100 %. `pdfPageDecision`
 * (issue #4) owns the 32 MiB threshold; this module computes the bytes that
 * decision is applied to and turns its ratio into the absolute zoom a person
 * can actually select.
 *
 * `scripts/app-lab/pdf_fixtures.py` computes the same raster sizes for the
 * fixtures from the same formula (`ceil(widthPt × zoom) × ceil(heightPt ×
 * zoom) × 4`), and the app-lab scenario asserts the two agree before any
 * reader behaviour is attributed to the app.
 */

/** RGBA8: the decoded-page contract in `docs/architecture/resource-limits.md`. */
export const PDF_BYTES_PER_PIXEL = 4;

/** Toolbar range. 100 % means one raster pixel per PDF point (72 DPI). */
export const PDF_MIN_SCALE = 0.1;
export const PDF_MAX_SCALE = 8;

export type PdfPageGeometry = {
  /** PDF user-space width in points. */
  readonly widthPt: number;
  /** PDF user-space height in points. */
  readonly heightPt: number;
};

/** A pane measured in CSS pixels, for fit-width/fit-page. */
export type PdfViewportSize = {
  readonly width: number;
  readonly height: number;
};

function usable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Decoded RGBA8 bytes for one page at `scale`, or null when the geometry is
 * unusable. `outputScale` is the device pixel ratio the canvas really
 * allocates at; ignoring it would under-count every HiDPI raster.
 */
export function pdfRenderBytes(
  page: PdfPageGeometry,
  scale: number,
  outputScale = 1,
): number | null {
  if (!usable(page.widthPt) || !usable(page.heightPt)) return null;
  if (!usable(scale) || !usable(outputScale)) return null;
  const width = Math.ceil(page.widthPt * scale * outputScale);
  const height = Math.ceil(page.heightPt * scale * outputScale);
  const bytes = width * height * PDF_BYTES_PER_PIXEL;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export type PdfZoomDecision =
  | {
      kind: "allow";
      renderBytes: number;
      scale: number;
      outputScale: number;
    }
  | {
      kind: "refuse";
      /** Null when the page or zoom could not be measured. */
      renderBytes: number | null;
      reason: string;
      alternatives: readonly LimitAlternative[];
      /** Largest whole-percent zoom that fits the ceiling, as a ratio. */
      suggestedScale: number | null;
      suggestedPercent: number | null;
      scale: number;
      outputScale: number;
    };

/**
 * The per-page render decision, applied *before* a canvas is allocated.
 *
 * The threshold and the base reason come from `pdfPageDecision`; this function
 * only adds what that pure byte decision cannot know — which absolute zoom, in
 * the toolbar's own percent labels, brings the same page back under the
 * ceiling. The suggested zoom is verified against the same arithmetic, so the
 * UI can never offer a "fit" that is itself refused.
 */
export function pdfZoomDecision(
  page: PdfPageGeometry,
  scale: number,
  outputScale = 1,
): PdfZoomDecision {
  const renderBytes = pdfRenderBytes(page, scale, outputScale);
  const decision = pdfPageDecision(renderBytes ?? Number.NaN);
  if (decision.kind === "allow") {
    return {
      kind: "allow",
      renderBytes: decision.renderBytes,
      scale,
      outputScale,
    };
  }
  const percent = largestFittingPercent(page, outputScale);
  const suffix =
    percent === null
      ? " No zoom of this page fits; open it externally."
      : ` The largest zoom that fits is ${percent}%.`;
  return {
    kind: "refuse",
    renderBytes,
    reason: `${decision.reason}${suffix}`,
    alternatives: decision.alternatives,
    suggestedScale: percent === null ? null : percent / 100,
    suggestedPercent: percent,
    scale,
    outputScale,
  };
}

/**
 * The largest whole percent (1-800) whose raster still fits the approved
 * ceiling. Binary search on the real arithmetic rather than rounding the
 * square-root ratio: `ceil()` on both dimensions means the ratio is not
 * guaranteed to fit once it is labelled.
 */
export function largestFittingPercent(
  page: PdfPageGeometry,
  outputScale = 1,
): number | null {
  const fits = (percent: number) => {
    const bytes = pdfRenderBytes(page, percent / 100, outputScale);
    return bytes !== null && bytes <= PDF_PAGE_LIMIT_BYTES;
  };
  const maxPercent = Math.floor(PDF_MAX_SCALE * 100);
  if (!fits(1)) return null;
  if (fits(maxPercent)) return maxPercent;
  let low = 1;
  let high = maxPercent;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The zoom that fits a page to the pane. A fallback of 1 (100 %) is returned
 * for an unmeasured pane so the reader never divides by zero; the caller still
 * applies `pdfZoomDecision` to the result, so a fit that is itself too large
 * becomes an explicit refusal rather than a painted raster.
 */
export function pdfFitScale(
  page: PdfPageGeometry,
  viewport: PdfViewportSize,
  mode: "width" | "page",
): number {
  if (
    !usable(page.widthPt) ||
    !usable(page.heightPt) ||
    !usable(viewport.width) ||
    !usable(viewport.height)
  ) {
    return 1;
  }
  const byWidth = viewport.width / page.widthPt;
  const byHeight = viewport.height / page.heightPt;
  const scale = mode === "width" ? byWidth : Math.min(byWidth, byHeight);
  return clampScale(scale);
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, scale));
}

/** One toolbar zoom step; 10 % multiplicative, clamped to the supported range. */
export function pdfSteppedScale(scale: number, direction: 1 | -1): number {
  const next = direction === 1 ? scale * 1.1 : scale / 1.1;
  return clampScale(Math.round(next * 1000) / 1000);
}

/** `100%`, `150%`, `64%` — the label the toolbar and refusals use. */
export function pdfScaleLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** Human label for a byte count in the refusal text (whole MiB, one decimal). */
export function pdfMibLabel(bytes: number): string {
  const value = bytes / MIB;
  const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  return `${rounded} MiB`;
}

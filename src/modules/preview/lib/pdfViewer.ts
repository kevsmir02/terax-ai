import type { AssetDeliveryDecision } from "./assetDelivery";
import {
  type LimitAlternative,
  PDF_PAGE_LIMIT_BYTES,
  type ViewerAdmission,
} from "./limits";
import { pdfZoomDecision, type PdfPageGeometry } from "./pdfPage";

/**
 * The PDF reader's state machine, as a pure function.
 *
 * The container only wires inputs to it. The order is the contract and is the
 * same one the image surface uses, extended with the per-page render decision:
 *
 *   hidden → whole-file gate → document load outcome → page geometry →
 *   per-page ceiling (`pdfPageDecision`) → decoded-viewer admission → ready
 *
 * Nothing here allocates a canvas, so every refusal (oversized file, corrupt
 * document, encrypted document, page above 32 MiB, no decoded slot) is testable
 * without a browser and is decided *before* painting.
 */

/** Mirrors the `getDocument` outcome the lazy loader reports. */
export type PdfLoadOutcome =
  | { kind: "loaded"; pages: number; encrypted: boolean }
  | { kind: "corrupt"; reason: string }
  | { kind: "password"; reason: string }
  | { kind: "unsupported"; reason: string }
  | { kind: "unreadable"; reason: string };

export type PdfViewerInput = {
  readonly visible: boolean;
  /** The approved whole-file delivery decision for this document. */
  readonly gate: AssetDeliveryDecision;
  /** Null until the lazy document loader reports (or while it is reading). */
  readonly load: PdfLoadOutcome | null;
  /** Current page geometry, or null until the page is loaded. */
  readonly page: PdfPageGeometry | null;
  readonly pageCount: number;
  /** 0-based. */
  readonly pageIndex: number;
  readonly scale: number;
  /** Device pixel ratio the canvas allocates at. */
  readonly outputScale: number;
  /** Rendered bytes already held in the bounded cache. */
  readonly cacheBytes: number;
  readonly admission: ViewerAdmission | null;
  readonly evicted: boolean;
};

export type PdfViewerState =
  | { kind: "hidden" }
  | {
      kind: "gated-confirm";
      reason: string;
      alternatives: readonly LimitAlternative[];
      overrideLimitBytes: number;
    }
  | {
      kind: "gated-refused";
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | { kind: "loading"; pages: number | null }
  | {
      kind: "corrupt";
      reason: string;
      alternatives: readonly LimitAlternative[];
      retryable: boolean;
    }
  | {
      kind: "password";
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "unsupported";
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "unreadable";
      reason: string;
      alternatives: readonly LimitAlternative[];
      retryable: boolean;
    }
  | {
      kind: "page-too-large";
      pageNumber: number;
      pageCount: number;
      scale: number;
      renderBytes: number | null;
      reason: string;
      suggestedScale: number | null;
      suggestedPercent: number | null;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "admitting";
      pageNumber: number;
      pageCount: number;
      scale: number;
      renderBytes: number;
      decodedBytes: number;
    }
  | {
      kind: "admission-refused";
      reason: string;
      alternatives: readonly LimitAlternative[];
      blocking: readonly string[];
    }
  | {
      kind: "evicted";
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "ready";
      pageNumber: number;
      pageCount: number;
      scale: number;
      renderBytes: number;
      /** The viewer's whole decoded footprint: cached pages plus this page. */
      decodedBytes: number;
    };

const OPEN_EXTERNALLY: readonly LimitAlternative[] = ["open-externally"];

/** The decision, in the order the ceilings are meant to be applied. */
export function pdfViewerState(input: PdfViewerInput): PdfViewerState {
  if (!input.visible) return { kind: "hidden" };

  if (input.gate.kind === "confirm") {
    return {
      kind: "gated-confirm",
      reason: input.gate.reason,
      alternatives: input.gate.alternatives,
      overrideLimitBytes: input.gate.overrideLimitBytes,
    };
  }
  if (input.gate.kind === "refuse") {
    return {
      kind: "gated-refused",
      reason: input.gate.reason,
      alternatives: input.gate.alternatives,
    };
  }

  const load = input.load;
  if (!load) return { kind: "loading", pages: null };
  if (load.kind === "corrupt") {
    return {
      kind: "corrupt",
      reason: `${load.reason} Open it externally, or retry if the file changed.`,
      alternatives: OPEN_EXTERNALLY,
      retryable: true,
    };
  }
  if (load.kind === "password") {
    return {
      kind: "password",
      reason: `${load.reason} This reader does not accept passwords; open the file externally.`,
      alternatives: OPEN_EXTERNALLY,
    };
  }
  if (load.kind === "unsupported") {
    return {
      kind: "unsupported",
      reason: `${load.reason} Open it externally instead.`,
      alternatives: OPEN_EXTERNALLY,
    };
  }
  if (load.kind === "unreadable") {
    return {
      kind: "unreadable",
      reason: `${load.reason} Open it externally if you meant to read it.`,
      alternatives: OPEN_EXTERNALLY,
      retryable: true,
    };
  }

  if (!input.page || load.pages <= 0) {
    return { kind: "loading", pages: load.pages };
  }

  const pageNumber = Math.min(Math.max(1, input.pageIndex + 1), load.pages);

  // The approved per-page ceiling runs on the raster arithmetic before any
  // canvas exists. A refusal names the ceiling and the zoom that would fit.
  const zoom = pdfZoomDecision(input.page, input.scale, input.outputScale);
  if (zoom.kind === "refuse") {
    return {
      kind: "page-too-large",
      pageNumber,
      pageCount: load.pages,
      scale: input.scale,
      renderBytes: zoom.renderBytes,
      reason: zoom.reason,
      suggestedScale: zoom.suggestedScale,
      suggestedPercent: zoom.suggestedPercent,
      alternatives: zoom.alternatives,
    };
  }

  if (input.evicted) {
    return {
      kind: "evicted",
      reason:
        "Another preview needed the decoded-asset budget, so this document's " +
        "rendered pages were released while its tab was hidden. Open it again " +
        "once another large preview is closed.",
      alternatives: ["close-another-viewer", "open-externally"],
    };
  }

  // The cache capacity is the per-page ceiling, so the footprint this viewer
  // registers never exceeds 32 MiB even when a page just filled the cache.
  const decodedBytes = Math.min(
    PDF_PAGE_LIMIT_BYTES,
    Math.max(0, input.cacheBytes) + zoom.renderBytes,
  );
  if (!input.admission) {
    return {
      kind: "admitting",
      pageNumber,
      pageCount: load.pages,
      scale: input.scale,
      renderBytes: zoom.renderBytes,
      decodedBytes,
    };
  }
  if (input.admission.kind === "refuse") {
    const blocking = input.admission.blocking.map(viewerBlockerLabel);
    return {
      kind: "admission-refused",
      reason:
        blocking.length > 0
          ? `${input.admission.reason} Open now: ${blocking.join(", ")}.`
          : input.admission.reason,
      alternatives: input.admission.alternatives,
      blocking,
    };
  }
  return {
    kind: "ready",
    pageNumber,
    pageCount: load.pages,
    scale: input.scale,
    renderBytes: zoom.renderBytes,
    decodedBytes,
  };
}

/**
 * The decoded-viewer request a state makes while waiting for a slot. Only a
 * page that already passed the per-page ceiling asks; refusals, loading and
 * hidden tabs claim nothing.
 */
export function pdfViewerRequest(
  state: PdfViewerState,
): { decodedBytes: number } | null {
  if (state.kind !== "admitting") return null;
  if (state.decodedBytes <= 0) return null;
  return { decodedBytes: state.decodedBytes };
}

/**
 * What the reader holds once it is showing a page: the bounded cache plus the
 * page on screen. Reported to the admission table so a PDF competes for the
 * same 4-viewer / 192 MiB budget as images and documents.
 */
export function pdfViewerRegistration(
  state: PdfViewerState,
): { decodedBytes: number } | null {
  if (state.kind !== "ready") return null;
  if (state.decodedBytes <= 0) return null;
  return { decodedBytes: state.decodedBytes };
}

/** A label for the refusal text: the file name, never an internal tab key. */
export function viewerBlockerLabel(id: string): string {
  const path = id.replace(/^[^:]+:[^:]*:/, "");
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return name || id;
}

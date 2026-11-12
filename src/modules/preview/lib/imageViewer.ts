import type { LimitAlternative, ViewerAdmission } from "./limits";
import { imageBudgetDecision } from "./limits";
import { imageDecodeSupport, imageFormatLabel } from "./imageFormats";

/**
 * The image surface's state machine, as a pure function.
 *
 * The container (`ImagePreview`) only wires hooks to this: a native header
 * probe supplies the intrinsic dimensions *before* any raster is allocated,
 * the approved `imageBudgetDecision` decides whether it fits, and the decoded
 * viewer table decides admission. Keeping the order here means the refusal
 * cases are testable without a browser, and it makes the important guarantee
 * explicit: an oversized image is never mounted only to be refused after the
 * webview has decoded it.
 */

/** What the native header probe learned. Mirrors `fs_image_probe`. */
export type ImageProbeOutcome =
  | { kind: "measured"; format: string; width: number; height: number }
  | { kind: "vector"; format: string }
  | { kind: "corrupt"; format: string; reason: string }
  /** The header is not a recognized supported container (routing ≠ support). */
  | { kind: "unsupported"; reason: string }
  /** The command itself failed (missing file, permission, IPC). */
  | { kind: "unreadable"; reason: string };

export type ImageViewerInput = {
  /** Format the path routes to (the extension table), or null. */
  readonly format: string | null;
  /** Null while the probe is still running. */
  readonly probe: ImageProbeOutcome | null;
  /** The tab is on screen; hidden tabs must not decode or present. */
  readonly visible: boolean;
  /** The `<img>` reported a decode error. */
  readonly decodeFailed: boolean;
  /** Decoded-viewer admission, or null until the hook has decided. */
  readonly admission: ViewerAdmission | null;
  /** The admission table released this viewer for another one. */
  readonly evicted: boolean;
};

export type ImageViewerState =
  | { kind: "hidden" }
  | { kind: "probing" }
  | {
      kind: "unsupported-format";
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "corrupt";
      reason: string;
      alternatives: readonly LimitAlternative[];
      retryable: boolean;
    }
  | {
      kind: "unreadable";
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "oversized";
      width: number;
      height: number;
      decodedBytes: number;
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | { kind: "admitting"; decodedBytes: number }
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
      kind: "decode-error";
      reason: string;
      alternatives: readonly LimitAlternative[];
      retryable: boolean;
    }
  | {
      kind: "ready";
      format: string;
      /** Null for a vector, whose raster is produced at display size. */
      width: number | null;
      height: number | null;
      decodedBytes: number;
      vector: boolean;
    };

const OPEN_EXTERNALLY: readonly LimitAlternative[] = ["open-externally"];

/** The decision, in the order the ceilings are meant to be applied. */
export function imageViewerState(input: ImageViewerInput): ImageViewerState {
  if (!input.visible) return { kind: "hidden" };

  const format = input.format;
  if (!format) {
    return {
      kind: "unsupported-format",
      reason:
        "This file is not routed to the image viewer. Open it in an external application instead.",
      alternatives: OPEN_EXTERNALLY,
    };
  }

  // Routing by extension is not decode support: a format this build never
  // measured is refused before its bytes reach the image decoder.
  if (imageDecodeSupport(format) !== "verified") {
    return unsupportedFormat(format);
  }

  if (input.decodeFailed) {
    return {
      kind: "decode-error",
      reason:
        "The webview could not render this image, so it may be corrupt or use a variant this build cannot decode. Open it externally, or retry.",
      alternatives: OPEN_EXTERNALLY,
      retryable: true,
    };
  }

  const probe = input.probe;
  if (!probe) return { kind: "probing" };

  if (probe.kind === "unreadable") {
    return {
      kind: "unreadable",
      reason: `${probe.reason} Open it externally if you meant to see it.`,
      alternatives: OPEN_EXTERNALLY,
    };
  }
  if (probe.kind === "unsupported") {
    return {
      kind: "unsupported-format",
      reason: probe.reason,
      alternatives: OPEN_EXTERNALLY,
    };
  }
  if (probe.kind === "corrupt") {
    return {
      kind: "corrupt",
      reason: `${probe.reason} Open it externally, or retry if the file changed.`,
      alternatives: OPEN_EXTERNALLY,
      retryable: true,
    };
  }

  if (probe.kind === "vector") {
    return {
      kind: "ready",
      format,
      width: null,
      height: null,
      decodedBytes: 0,
      vector: true,
    };
  }

  // The header says what the bytes are, which can disagree with the name. The
  // asset is served with the extension's MIME type, so a mismatch would reach
  // the decoder as the wrong type.
  if (probe.format !== format) {
    return {
      kind: "corrupt",
      reason:
        `The file contains ${imageFormatLabel(probe.format)} data but its ` +
        `name routes it as ${imageFormatLabel(format)}. Open it externally or ` +
        "rename it to match.",
      alternatives: OPEN_EXTERNALLY,
      retryable: false,
    };
  }

  // The approved ceiling is decided from the header dimensions, before the
  // `<img>` is mounted. No reduced-size decode exists on this path, so an
  // oversized image is an honest refusal with the external alternative.
  const budget = imageBudgetDecision(probe.width, probe.height);
  if (budget.kind === "refuse") {
    return {
      kind: "oversized",
      width: budget.width,
      height: budget.height,
      decodedBytes: budget.decodedBytes ?? 0,
      reason: budget.reason,
      alternatives: budget.alternatives,
    };
  }
  if (budget.kind === "downscale") {
    // Only reachable if a caller starts declaring a reduced decode; this
    // surface does not, so treat it as the refusal it would otherwise be.
    return {
      kind: "oversized",
      width: budget.width,
      height: budget.height,
      decodedBytes: budget.decodedBytes,
      reason: budget.reason,
      alternatives: OPEN_EXTERNALLY,
    };
  }

  if (input.evicted) {
    return {
      kind: "evicted",
      reason:
        "Another preview needed the decoded-asset budget, so this image was " +
        "released while its tab was hidden. Open it again once another large " +
        "preview is closed.",
      alternatives: ["close-another-viewer", "open-externally"],
    };
  }

  if (!input.admission) {
    return { kind: "admitting", decodedBytes: budget.decodedBytes };
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
    format,
    width: budget.width,
    height: budget.height,
    decodedBytes: budget.decodedBytes,
    vector: false,
  };
}

/**
 * The decoded-viewer request a state makes while it is waiting for admission.
 * Only an image that fits the byte ceiling asks for a slot; refusals, probing
 * and hidden tabs claim nothing.
 */
export function imageViewerRequest(
  state: ImageViewerState,
): { decodedBytes: number } | null {
  if (state.kind !== "admitting" || state.decodedBytes <= 0) return null;
  return { decodedBytes: state.decodedBytes };
}

/**
 * The decoded-viewer registration for a state: only a ready raster that is
 * actually about to be shown claims decoded bytes. Refusals, probing, vectors
 * and hidden tabs claim nothing, so they never consume the budget.
 */
export function imageViewerRegistration(
  state: ImageViewerState,
): { decodedBytes: number } | null {
  if (state.kind !== "ready" || state.vector) return null;
  if (state.decodedBytes <= 0) return null;
  return { decodedBytes: state.decodedBytes };
}

function unsupportedFormat(format: string): ImageViewerState {
  const label = imageFormatLabel(format);
  return {
    kind: "unsupported-format",
    reason:
      `The image surface routes ${label} files, but this build's WebKitGTK ` +
      `has not verified decode support for ${label}, so the file was not ` +
      "decoded. Open it in an external viewer instead.",
    alternatives: OPEN_EXTERNALLY,
  };
}

/**
 * A readable name for a viewer id in an admission refusal. The ids are stable
 * `surface:tab:path` keys; showing the internal id would not help the person
 * decide which preview to close.
 */
export function viewerBlockerLabel(id: string): string {
  const path = id.replace(/^[^:]+:[^:]*:/, "");
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return name || id;
}

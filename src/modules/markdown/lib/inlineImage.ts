// The Markdown surface's inline-image budget state machine, as a pure function.
//
// Rendered Markdown used to decode every `<img>` at its intrinsic size: no
// header probe, no decoded ceiling and no admission, so one 20 000 x 20 000
// PNG in a document could allocate ~1.5 GiB. Inline images now follow the same
// contract as the dedicated image surface (`imageViewer.ts`): a local file's
// header is probed natively *before* the element mounts, the shared 64 MiB
// decoded ceiling is applied to those dimensions, and a raster that is about
// to be shown claims a slot in the application-wide decoded-viewer table.
//
// Two source kinds cannot be header-probed natively: a consented remote image
// and a `data:` image have no file path for `fs_image_probe`. They mount lazily
// to learn their intrinsic size, then the *same* ceiling and admission table
// apply before the image is presented as admitted. That is why `measuring`
// exists; it is the only state that mounts an element without a decision.
//
// Everything here is pure data and pure functions, so the refusal-before-mount
// guarantee is testable in a plain Node test (no browser, no DOM).
//
// One failure needs the file itself: a local image above the asset-delivery
// ceiling is answered with 413 by the native handler, which an `<img>` can only
// observe as a load error. `fileBytes` (measured after the failure) lets the
// state machine name that limit instead of blaming the image's bytes.

import {
  imageFormatForEmbeddedPath,
  type ImageFormat,
} from "@/modules/preview/lib/imageFormats";
import {
  imageBudgetDecision,
  type LimitAlternative,
  mibLabel,
  type ViewerAdmission,
} from "@/modules/preview/lib/limits";
import { ASSET_DELIVERY } from "@/modules/preview/lib/assetDelivery";
import {
  type ImageProbeOutcome,
  imageViewerState,
  viewerBlockerLabel,
} from "@/modules/preview/lib/imageViewer";

/** What one `<img>` in a rendered document points at. */
export type MarkdownImageSource =
  | {
      readonly kind: "file";
      /** Absolute path the rehype policy resolved, never the raw reference. */
      readonly path: string;
      readonly format: ImageFormat | null;
      /**
       * Folder the canonical target must stay inside, or null when the person
       * explicitly granted this exact outside file (consent replaces the
       * document boundary for that file).
       */
      readonly guard: string | null;
    }
  | { readonly kind: "remote"; readonly url: string }
  | { readonly kind: "data"; readonly url: string };

export type MarkdownImageInput = {
  readonly source: MarkdownImageSource;
  /** The image is near the viewport *and* its tab is on screen. */
  readonly visible: boolean;
  /** Native header probe result for a file source; null until it lands. */
  readonly probe: ImageProbeOutcome | null;
  /** Intrinsic size reported by a remote/data element after it loaded. */
  readonly loaded: { readonly width: number; readonly height: number } | null;
  /** Decoded-viewer admission, or null until the table has decided. */
  readonly admission: ViewerAdmission | null;
  /** The table released this image to make room for another viewer. */
  readonly evicted: boolean;
  readonly decodeFailed: boolean;
  /**
   * Size of a local file when it is known, measured only after a failed load
   * (a remote or `data:` reference has none). Above the asset-delivery ceiling
   * the native handler refused the file, so the load error is a limit of ours
   * and not a defect in the image.
   */
  readonly fileBytes?: number | null;
};

export type MarkdownImageState =
  | { kind: "deferred" }
  | { kind: "probing" }
  /** A remote/data image is mounted only to read its intrinsic size. */
  | { kind: "measuring" }
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
      /** A local file above the asset-delivery ceiling: refused before decode. */
      kind: "file-too-large";
      bytes: number;
      limitBytes: number;
      reason: string;
      alternatives: readonly LimitAlternative[];
    }
  | {
      kind: "ready";
      width: number | null;
      height: number | null;
      decodedBytes: number;
      vector: boolean;
    };

/** The one decision, in the order the ceilings are meant to be applied. */
export function markdownImageState(
  input: MarkdownImageInput,
): MarkdownImageState {
  if (!input.visible) return { kind: "deferred" };
  return input.source.kind === "file"
    ? fileImageState(input)
    : measuredImageState(input);
}

/**
 * A local file delegates to the dedicated image surface's state machine, so
 * there is exactly one implementation of the format check, the header
 * mismatch, the 64 MiB ceiling and the admission wording.
 */
function fileImageState(input: MarkdownImageInput): MarkdownImageState {
  if (input.source.kind !== "file") return measuredImageState(input);
  // A file above the delivery ceiling is answered with 413 by the native asset
  // handler, and an `<img>` cannot read that body: all it reports is a load
  // error. Explaining that as a decode failure would blame the file for a
  // limit of ours, so the size decides the explanation.
  if (input.decodeFailed) {
    const refusal = deliveryRefusal(input.fileBytes);
    if (refusal !== null) return refusal;
  }
  const state = imageViewerState({
    format: input.source.format,
    probe: input.probe,
    visible: input.visible,
    decodeFailed: input.decodeFailed,
    admission: input.admission,
    evicted: input.evicted,
  });
  // `hidden` cannot occur (visible is checked first); keep the mapping total
  // instead of asserting so a future change cannot turn it into a blank pane.
  if (state.kind === "hidden") return { kind: "deferred" };
  return state;
}

/**
 * The refusal a failed load of a too-large local file deserves, or null when
 * the size is unknown or inside the ceiling (a genuine decode failure).
 *
 * The ceiling is read from `ASSET_DELIVERY`, the TypeScript mirror of the
 * native handler's limits, so the wording cannot drift from what refused the
 * file.
 */
function deliveryRefusal(
  bytes: number | null | undefined,
): MarkdownImageState | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  if (bytes <= ASSET_DELIVERY.readBytes) return null;
  return {
    kind: "file-too-large",
    bytes,
    limitBytes: ASSET_DELIVERY.readBytes,
    reason: fileTooLargeReason(bytes),
    alternatives: ["open-externally"],
  };
}

function fileTooLargeReason(bytes: number): string {
  const size = mibLabel(bytes);
  if (bytes > ASSET_DELIVERY.overrideBytes) {
    return (
      `This image file is ${size}, above the ` +
      `${mibLabel(ASSET_DELIVERY.overrideBytes)} ceiling an explicit load can ` +
      "reach, so the document did not load it. Open it externally to view it."
    );
  }
  return (
    `This image file is ${size}, above the ` +
    `${mibLabel(ASSET_DELIVERY.readBytes)} preview read limit, so the document ` +
    "could not load it. Open it externally to view it."
  );
}

/**
 * Remote and `data:` images have no path for the native header probe. The
 * element mounts once to report its intrinsic size, then the approved ceiling
 * and the decoded-viewer table decide whether it stays.
 */
function measuredImageState(input: MarkdownImageInput): MarkdownImageState {
  if (input.decodeFailed) {
    return {
      kind: "decode-error",
      reason:
        "The webview could not render this image, so it may be corrupt or " +
        "use a variant this build cannot decode. Open it externally, or retry.",
      alternatives: ["open-externally"],
      retryable: true,
    };
  }
  if (!input.loaded) return { kind: "measuring" };

  const { width, height } = input.loaded;
  const budget = imageBudgetDecision(width, height);
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
    // This surface has no reduced-size decode, so an oversized image is an
    // honest refusal rather than a silently different picture.
    return {
      kind: "oversized",
      width: budget.width,
      height: budget.height,
      decodedBytes: budget.decodedBytes,
      reason: budget.reason,
      alternatives: ["open-externally"],
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
    width,
    height,
    decodedBytes: budget.decodedBytes,
    vector: false,
  };
}

/**
 * The native probe path, or null when this image must not be probed yet.
 *
 * Off-screen images return `deferred`, so this is also the answer to "is this
 * image being probed?"; the container passes the path to `useImageProbe` only
 * when `enabled` is true.
 */
export function markdownImageProbePath(
  source: MarkdownImageSource,
  state: MarkdownImageState,
): string | null {
  if (source.kind !== "file" || state.kind !== "probing") return null;
  return source.path;
}

/**
 * The decoded bytes this state asks the admission table for. Only the
 * pre-admission state claims anything; deferred, refused and vector images
 * claim nothing.
 */
export function markdownImageRequest(
  state: MarkdownImageState,
): { decodedBytes: number } | null {
  if (state.kind !== "admitting" || state.decodedBytes <= 0) return null;
  return { decodedBytes: state.decodedBytes };
}

/**
 * The registration for a raster that is actually presented. A vector (SVG)
 * is rasterized at display size and claims no decoded bytes.
 */
export function markdownImageRegistration(
  state: MarkdownImageState,
): { decodedBytes: number } | null {
  if (state.kind !== "ready" || state.vector) return null;
  if (state.decodedBytes <= 0) return null;
  return { decodedBytes: state.decodedBytes };
}

/**
 * True when this state may put an `<img>` in the document.
 *
 * A file image mounts only when it is `ready`, i.e. after the header probe and
 * the admission table agreed. A remote/data image additionally mounts while
 * `measuring`/`admitting`, because that element is how its size becomes known.
 */
export function markdownImageMounts(
  source: MarkdownImageSource,
  state: MarkdownImageState,
): boolean {
  if (state.kind === "ready") return true;
  if (source.kind === "file") return false;
  return state.kind === "measuring" || state.kind === "admitting";
}

/**
 * Stable decoded-viewer id: surface, tab, document and the image's occurrence
 * key. A tab close, a document replacement or a reordered image therefore
 * releases or moves its own slot instead of inheriting another image's claim.
 */
export function markdownImageViewerId(input: {
  readonly documentPath: string;
  readonly tabId: number;
  readonly key: string;
}): string {
  return `markdown:${input.tabId}:${input.documentPath}:${input.key}`;
}

/** Build the source descriptor from the rehype-marked `<img>` properties. */
export function markdownImageSource(input: {
  readonly kind: unknown;
  readonly path: unknown;
  readonly guard: unknown;
  readonly src: unknown;
}): MarkdownImageSource | null {
  const { kind, path, guard, src } = input;
  if (typeof src !== "string" || src.length === 0) return null;
  if (kind === "file" && typeof path === "string" && path.length > 0) {
    return {
      kind: "file",
      path,
      format: imageFormatForEmbeddedPath(path),
      guard: typeof guard === "string" && guard.length > 0 ? guard : null,
    };
  }
  if (kind === "remote") return { kind: "remote", url: src };
  if (kind === "data" || src.startsWith("data:")) {
    return { kind: "data", url: src };
  }
  return null;
}

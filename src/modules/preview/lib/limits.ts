/**
 * Document and decoded-resource limits for the personal Linux workspace.
 *
 * These ceilings were approved by the primary user on 2026-11-12 (issue #4,
 * "Balanced" option) from the issue #3 Linux baseline. They are a *contract*:
 * optional editors and viewers read their numbers from here instead of
 * carrying their own copies, so one approved table decides what every preview
 * surface allows. The reasoning and the deliberately open questions live in
 * `docs/architecture/resource-limits.md`.
 *
 * This module is pure data and pure functions: no DOM, no React, no Tauri, no
 * I/O. Anything that needs a decoded byte count, an admission decision or a
 * refusal message imports it from here and is testable in a plain Node test.
 *
 * Ownership of the numbers that already existed elsewhere (nothing is
 * duplicated by accident):
 *
 * | Value | Enforcing owner | Notes |
 * | --- | --- | --- |
 * | 10 MiB normal read | `src-tauri/src/modules/fs/file.rs` (`MAX_READ_BYTES`) | the native reader refuses and reports `limit` |
 * | 50 MiB explicit override | `src-tauri/src/modules/fs/file.rs` (`FORCE_MAX_READ_BYTES`) | reached only through the explicit "open anyway" action |
 * | 4 MiB syntax ceiling | this module, consumed by `src/modules/editor/EditorPane.tsx` | a TypeScript-only editing behaviour |
 * | 64 MiB image decode | `src/modules/preview/lib/imageViewer.ts` via `imageBudgetDecision`, fed by the native header probe `fs_image_probe` | dimensions are read from the header before the `<img>` mounts; an oversized image is refused, not decoded and then discarded |
 * | 4 viewers / 192 MiB decoded | `src/modules/preview/lib/viewerAdmission.ts` via `decideViewerAdmission` | hidden viewers may be released, a visible one is never evicted |
 * | 10/50 MiB asset delivery, chunking, outstanding reads | `src-tauri/src/modules/fs/assets.rs` (`DeliveryLimits`), mirrored by `src/modules/preview/lib/assetDelivery.ts` | derived from the read and override ceilings; a range response is one chunk |
 *
 * The TypeScript mirror of the Rust ceilings exists because the UI has to know
 * when to offer the override; `limits.test.ts` and `assetDelivery.test.ts` read
 * the Rust source and fail if the two drift apart.
 *
 * Text ceilings, asset delivery bounds, the single-image decode ceiling, the
 * PDF per-page render ceiling, decoded-viewer admission and the media playback
 * count are enforced today (the PDF reader is issue #31). Each refusal names the
 * ceiling it applied; none of them installs a codec or widens a read.
 */

export const MIB = 1024 * 1024;

/**
 * Every approved ceiling in one table. Values are bytes, counts or pixels as
 * named; nothing here is a whole-application target (that is issue #42).
 */
export const RESOURCE_LIMITS = {
  text: {
    /** Normal file-read ceiling, enforced natively. */
    readBytes: 10 * MIB,
    /** Ceiling for a deliberate "open anyway", enforced natively. */
    overrideBytes: 50 * MIB,
    /** Above this, syntax features (highlighting/parsing) stay off. */
    syntaxBytes: 4 * MIB,
  },
  image: {
    /** Maximum decoded raster for one image, RGBA8. */
    decodedBytes: 64 * MIB,
    bytesPerPixel: 4,
  },
  pdf: {
    /** Maximum rendered bytes for one PDF page (A4 up to ~300 DPI). */
    pageBytes: 32 * MIB,
  },
  viewer: {
    /** Concurrent decoded viewers (documents, images, PDF pages). */
    concurrent: 4,
    /** Sum of decoded bytes over every admitted viewer, application-wide. */
    decodedBudgetBytes: 192 * MIB,
  },
  media: {
    /** Playing media elements per tab. */
    perTab: 1,
    /** Playing media elements application-wide. */
    appWide: 3,
  },
  /**
   * Disk-storage quota for opt-in recovery drafts, recorded here only so the
   * two kinds of ceiling are not confused. This is *storage* (issue #16 owns
   * enforcement); it is not part of `viewer.decodedBudgetBytes` and does not
   * consume decoded memory.
   */
  storage: {
    draftBytes: 10 * MIB,
    draftTotalBytes: 100 * MIB,
  },
} as const;

export const TEXT_READ_LIMIT_BYTES = RESOURCE_LIMITS.text.readBytes;
export const TEXT_OVERRIDE_LIMIT_BYTES = RESOURCE_LIMITS.text.overrideBytes;
export const TEXT_SYNTAX_LIMIT_BYTES = RESOURCE_LIMITS.text.syntaxBytes;

export const IMAGE_DECODE_LIMIT_BYTES = RESOURCE_LIMITS.image.decodedBytes;
/** 64 MiB of RGBA8 at 4 bytes per pixel: 4096 × 4096. */
export const IMAGE_DECODE_LIMIT_PIXELS =
  IMAGE_DECODE_LIMIT_BYTES / RESOURCE_LIMITS.image.bytesPerPixel;

export const PDF_PAGE_LIMIT_BYTES = RESOURCE_LIMITS.pdf.pageBytes;

export const MAX_CONCURRENT_DECODED_VIEWERS = RESOURCE_LIMITS.viewer.concurrent;
export const DECODED_ASSET_BUDGET_BYTES =
  RESOURCE_LIMITS.viewer.decodedBudgetBytes;

export const MAX_PLAYING_MEDIA_PER_TAB = RESOURCE_LIMITS.media.perTab;
export const MAX_PLAYING_MEDIA_APP_WIDE = RESOURCE_LIMITS.media.appWide;

export const RECOVERY_DRAFT_LIMIT_BYTES = RESOURCE_LIMITS.storage.draftBytes;
export const RECOVERY_DRAFT_TOTAL_BYTES =
  RESOURCE_LIMITS.storage.draftTotalBytes;

/**
 * The recorded approval. Kept as data (not only as prose) so tests and later
 * tickets can cite the same provenance.
 */
export const LIMITS_APPROVAL = {
  issue: 4,
  decision: "balanced",
  approvedBy: "primary user",
  approvedOn: "2026-11-12",
  evidence:
    "issue #3 Linux baseline (2026-11-12): ~340 MiB idle application PSS and " +
    "482-492 MiB total PSS under the two-Space/four-terminal/two-agent " +
    "workload; evidence at " +
    "personal/terax-baseline/evidence/2026-11-12/",
  storageIsDistinct:
    "Recovery drafts (10 MiB per file, 100 MiB total, issue #16) are a " +
    "disk-storage quota, not decoded memory, and are not counted in the " +
    "192 MiB decoded-asset budget.",
  notDecidedHere:
    "Whole-application startup time and memory targets are issue #42; these " +
    "viewer ceilings do not imply a startup or total-RSS budget.",
} as const;

/**
 * What the interface may offer when a limit is hit. Every refusal names one or
 * more of these; none of them downloads, installs a codec or silently
 * substitutes a blank pane.
 */
export type LimitAlternative =
  | "open-externally"
  | "downscale"
  | "reduce-zoom"
  | "close-another-viewer"
  | "stop-other-playback";

// --- text and code -------------------------------------------------------

export type TextReadDecision =
  | { kind: "read"; bytes: number; syntax: boolean }
  | {
      kind: "too-large";
      bytes: number;
      /** The ceiling this read was measured against. */
      limitBytes: number;
      reason: string;
      alternatives: readonly LimitAlternative[];
      /** Present only when the explicit override can reach this file. */
      override: {
        limitBytes: number;
        requiresExplicitUserAction: true;
      } | null;
    };

/**
 * Decides a text/code read the way the native reader does: a size equal to a
 * ceiling is allowed, one byte past it is not. `syntax` is false above the
 * 4 MiB ceiling even when the read succeeds.
 *
 * `forced` mirrors the explicit "open anyway" action. Nothing else may raise
 * the ceiling; there is no configuration path to 50 MiB.
 */
export function textReadDecision(
  bytes: number,
  forced = false,
): TextReadDecision {
  const readLimit = forced ? TEXT_OVERRIDE_LIMIT_BYTES : TEXT_READ_LIMIT_BYTES;
  if (!Number.isFinite(bytes) || bytes < 0) {
    return {
      kind: "too-large",
      bytes: 0,
      limitBytes: readLimit,
      reason: "This file's size could not be measured, so it was not read.",
      alternatives: ["open-externally"],
      override: null,
    };
  }
  if (bytes > readLimit) {
    const override =
      !forced && bytes <= TEXT_OVERRIDE_LIMIT_BYTES
        ? ({
            limitBytes: TEXT_OVERRIDE_LIMIT_BYTES,
            requiresExplicitUserAction: true,
          } as const)
        : null;
    return {
      kind: "too-large",
      bytes,
      limitBytes: readLimit,
      reason: textTooLargeReason(bytes, forced, override !== null),
      alternatives: ["open-externally"],
      override,
    };
  }
  return { kind: "read", bytes, syntax: bytes <= TEXT_SYNTAX_LIMIT_BYTES };
}

function textTooLargeReason(
  bytes: number,
  forced: boolean,
  canOverride: boolean,
): string {
  const size = mibLabel(bytes);
  const override = mibLabel(TEXT_OVERRIDE_LIMIT_BYTES);
  if (forced) {
    return `This file is ${size}, above the ${override} ceiling that an explicit open can reach.`;
  }
  if (canOverride) {
    return (
      `This file is ${size}, above the ${mibLabel(TEXT_READ_LIMIT_BYTES)} ` +
      `read limit. Opening it anyway allows up to ${override} with syntax ` +
      "features off."
    );
  }
  return (
    `This file is ${size}, above the ${override} ceiling a normal read or an ` +
    "explicit open can reach. Open it externally."
  );
}

// --- images --------------------------------------------------------------

export type ImageBudgetDecision =
  | { kind: "allow"; width: number; height: number; decodedBytes: number }
  | {
      kind: "downscale";
      width: number;
      height: number;
      decodedBytes: number;
      limitBytes: number;
      scale: number;
      targetWidth: number;
      targetHeight: number;
      reason: string;
      alternative: "open-externally";
    }
  | {
      kind: "refuse";
      width: number;
      height: number;
      /** Null when the header does not describe a usable raster. */
      decodedBytes: number | null;
      reason: string;
      alternatives: readonly LimitAlternative[];
    };

/** Decoded RGBA8 bytes for an intrinsic size, or null when it is unusable. */
export function decodedImageBytes(
  width: number,
  height: number,
): number | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return width * height * RESOURCE_LIMITS.image.bytesPerPixel;
}

/**
 * Decides whether an image of `width` × `height` fits the 64 MiB decoded
 * ceiling.
 *
 * - `allow`: decode and show it.
 * - `refuse`: unmeasurable dimensions, or the image needs more decoded bytes
 *   than the ceiling and the viewer has no reduced-size decode. The refusal
 *   always names a reason and the safe alternative (open externally) so the
 *   pane is never blank.
 * - `downscale`: the image is oversized but the caller declared
 *   `reducedDecode`, i.e. it can decode straight to the returned target size.
 *   Only pass that flag for a decode path that really can; otherwise the
 *   honest answer is a refusal, not a full raster allocation.
 */
export function imageBudgetDecision(
  width: number,
  height: number,
  options: { readonly reducedDecode?: boolean } = {},
): ImageBudgetDecision {
  const decodedBytes = decodedImageBytes(width, height);
  if (decodedBytes === null) {
    return {
      kind: "refuse",
      width,
      height,
      decodedBytes: null,
      reason:
        "This image's dimensions are unusable, so it was not decoded. " +
        "Open it in an external viewer instead.",
      alternatives: ["open-externally"],
    };
  }
  if (decodedBytes <= IMAGE_DECODE_LIMIT_BYTES) {
    return { kind: "allow", width, height, decodedBytes };
  }
  const reason =
    `This image needs ${mibLabel(decodedBytes)} decoded, above the ` +
    `${mibLabel(IMAGE_DECODE_LIMIT_BYTES)} limit.`;
  if (!options.reducedDecode) {
    return {
      kind: "refuse",
      width,
      height,
      decodedBytes,
      reason: `${reason} Open it in an external viewer, or use a viewer that can decode it at a smaller size.`,
      alternatives: ["open-externally"],
    };
  }
  const scale = Math.sqrt(IMAGE_DECODE_LIMIT_BYTES / decodedBytes);
  return {
    kind: "downscale",
    width,
    height,
    decodedBytes,
    limitBytes: IMAGE_DECODE_LIMIT_BYTES,
    scale,
    targetWidth: Math.max(1, Math.floor(width * scale)),
    targetHeight: Math.max(1, Math.floor(height * scale)),
    reason: `${reason} It is shown at ${Math.round(scale * 100)}% of its intrinsic size.`,
    alternative: "open-externally",
  };
}

// --- PDF -----------------------------------------------------------------

export type PdfPageDecision =
  | { kind: "allow"; renderBytes: number }
  | {
      kind: "refuse";
      renderBytes: number | null;
      reason: string;
      alternatives: readonly LimitAlternative[];
      /** Zoom that would bring the same page under the ceiling. */
      suggestedZoom: number | null;
    };

/**
 * Decides whether one rendered PDF page fits the 32 MiB per-page ceiling.
 * Oversized pages are refused with the zoom that would fit them and the
 * external-viewer fallback; the viewer never shows a silently blank page and
 * never installs anything.
 */
export function pdfPageDecision(renderBytes: number): PdfPageDecision {
  if (!Number.isFinite(renderBytes) || renderBytes < 0) {
    return {
      kind: "refuse",
      renderBytes: null,
      reason:
        "This page's rendered size could not be measured, so it was not " +
        "drawn. Reduce the zoom or open the PDF externally.",
      alternatives: ["reduce-zoom", "open-externally"],
      suggestedZoom: null,
    };
  }
  if (renderBytes <= PDF_PAGE_LIMIT_BYTES) {
    return { kind: "allow", renderBytes };
  }
  return {
    kind: "refuse",
    renderBytes,
    reason:
      `This page needs ${mibLabel(renderBytes)} rendered, above the ` +
      `${mibLabel(PDF_PAGE_LIMIT_BYTES)} per-page limit. Reduce the zoom or ` +
      "open the PDF externally.",
    alternatives: ["reduce-zoom", "open-externally"],
    suggestedZoom: Math.sqrt(PDF_PAGE_LIMIT_BYTES / renderBytes),
  };
}

// --- decoded viewers -----------------------------------------------------

export type DecodedViewer = {
  readonly id: string;
  readonly tabId: string;
  /** Decoded bytes this viewer currently holds. */
  readonly decodedBytes: number;
  /** False only for a viewer whose tab is not on screen. */
  readonly visible: boolean;
  /** Monotonic use counter; a larger value is more recently used. */
  readonly lastUsed: number;
};

export type ViewerAdmission =
  | {
      kind: "admit";
      decodedBytes: number;
      /** Hidden viewers to release before the new one mounts. */
      evict: readonly string[];
      totalDecodedBytes: number;
    }
  | {
      kind: "refuse";
      reason: string;
      alternatives: readonly LimitAlternative[];
      /** Admitted viewers the new one cannot replace without closing one. */
      blocking: readonly string[];
    };

/**
 * Admits a decoded viewer under the 4-viewer and 192 MiB ceilings.
 *
 * Hidden viewers may be released (least recently used first) to make room,
 * and the returned `evict` list names them so the caller releases them
 * explicitly. A *visible* viewer is never evicted: if the ceilings cannot be
 * met without doing so, the request is refused with the blocking viewers named
 * and `close-another-viewer` offered. `request` is the viewer being opened or
 * re-admitted; an existing entry with the same id is replaced, not counted
 * twice.
 */
export function decideViewerAdmission(
  viewers: readonly DecodedViewer[],
  request: DecodedViewer,
): ViewerAdmission {
  const others = viewers.filter((viewer) => viewer.id !== request.id);
  const budget = DECODED_ASSET_BUDGET_BYTES;
  if (request.decodedBytes > budget) {
    return {
      kind: "refuse",
      reason:
        `This viewer needs ${mibLabel(request.decodedBytes)} decoded, above ` +
        `the ${mibLabel(budget)} decoded-asset budget for the whole ` +
        "application.",
      alternatives: ["open-externally"],
      blocking: [],
    };
  }

  const remaining = [...others];
  const totalOf = (list: readonly DecodedViewer[]) =>
    list.reduce((sum, viewer) => sum + viewer.decodedBytes, 0) +
    request.decodedBytes;
  const overBudget = (list: readonly DecodedViewer[]) =>
    totalOf(list) > budget || list.length + 1 > MAX_CONCURRENT_DECODED_VIEWERS;

  const evictable = others
    .filter((viewer) => !viewer.visible)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  const evict: string[] = [];
  for (const candidate of evictable) {
    if (!overBudget(remaining)) break;
    const index = remaining.findIndex((viewer) => viewer.id === candidate.id);
    if (index === -1) continue;
    remaining.splice(index, 1);
    evict.push(candidate.id);
  }

  if (overBudget(remaining)) {
    return {
      kind: "refuse",
      reason:
        `At most ${MAX_CONCURRENT_DECODED_VIEWERS} decoded viewers can be ` +
        `admitted at once and they share the ${mibLabel(budget)} budget. ` +
        "Close one of the open viewers to make room.",
      alternatives: ["close-another-viewer", "open-externally"],
      blocking: remaining.map((viewer) => viewer.id),
    };
  }

  return {
    kind: "admit",
    decodedBytes: request.decodedBytes,
    evict,
    totalDecodedBytes: totalOf(remaining),
  };
}

// --- media ---------------------------------------------------------------

export type MediaPlaybackSession = {
  readonly id: string;
  readonly tabId: string;
  /** Monotonic start order; a smaller value started earlier. */
  readonly startedAt: number;
};

export type MediaPlaybackDecision =
  | { kind: "play"; pause: readonly string[] }
  | {
      kind: "refuse";
      reason: string;
      alternatives: readonly LimitAlternative[];
      /** Playing elements in other tabs that occupy the app-wide slots. */
      blocking: readonly string[];
    };

/**
 * Decides starting playback of `request` under "one playing element per tab,
 * three application-wide".
 *
 * A sibling in the same tab is paused (returned in `pause`) because a tab
 * presents one media element at a time — the same behaviour the preview
 * already has. The application-wide ceiling is a refusal, not a silent pause:
 * audio from another tab is user-visible activity, so the decision names the
 * blockers and offers `stop-other-playback`.
 */
export function decideMediaPlayback(
  sessions: readonly MediaPlaybackSession[],
  request: MediaPlaybackSession,
): MediaPlaybackDecision {
  const others = sessions.filter((session) => session.id !== request.id);
  const sameTab = others
    .filter((session) => session.tabId === request.tabId)
    .sort((a, b) => a.startedAt - b.startedAt);
  const excess = sameTab.length + 1 - MAX_PLAYING_MEDIA_PER_TAB;
  const pause = sameTab.slice(0, Math.max(0, excess)).map((s) => s.id);

  const otherTabs = others.filter((session) => session.tabId !== request.tabId);
  if (otherTabs.length + 1 > MAX_PLAYING_MEDIA_APP_WIDE) {
    return {
      kind: "refuse",
      reason:
        `${otherTabs.length} media elements are already playing in other ` +
        `tabs; at most ${MAX_PLAYING_MEDIA_APP_WIDE} can play at once. ` +
        "Stop one of them to play this one.",
      alternatives: ["stop-other-playback"],
      blocking: otherTabs.map((session) => session.id),
    };
  }
  return { kind: "play", pause };
}

// --- formatting ----------------------------------------------------------

/** Byte count as the ceiling labels are written: whole MiB, one decimal. */
function mibLabel(bytes: number): string {
  const value = bytes / MIB;
  const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  return `${rounded} MiB`;
}

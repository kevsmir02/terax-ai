import {
  type LimitAlternative,
  MAX_CONCURRENT_DECODED_VIEWERS,
  MIB,
  TEXT_OVERRIDE_LIMIT_BYTES,
  TEXT_READ_LIMIT_BYTES,
} from "./limits";

/**
 * A tenth of the normal read ceiling. Delivery granularity, not a second
 * approved byte ceiling: `assets.rs` divides the same way.
 */
export const ASSET_DELIVERY_CHUNKS_PER_READ = 10;

/**
 * How a native asset delivery is bounded.
 *
 * The asset scheme handler in `src-tauri/src/modules/fs/assets.rs` owns the
 * enforcement; this table mirrors it so the interface can explain a refusal
 * before it happens (the webview cannot read a 413 body from an `<img>`). No
 * byte ceiling is declared here: every value is the approved read contract in
 * `limits.ts`, and `assetDelivery.test.ts` reads the Rust source so the two
 * cannot drift apart.
 */
export const ASSET_DELIVERY = {
  /** Largest whole-file (non-range) response. */
  readBytes: TEXT_READ_LIMIT_BYTES,
  /** Largest response reachable through the explicit "load anyway" action. */
  overrideBytes: TEXT_OVERRIDE_LIMIT_BYTES,
  /** Bytes per range response; the client asks for the next chunk. */
  chunkBytes: TEXT_READ_LIMIT_BYTES / ASSET_DELIVERY_CHUNKS_PER_READ,
  /** Concurrent native deliveries. */
  outstandingReads: MAX_CONCURRENT_DECODED_VIEWERS,
  /** Bytes reserved by concurrent native deliveries. */
  outstandingBytes: TEXT_OVERRIDE_LIMIT_BYTES,
} as const;

/** Preview categories the delivery rules distinguish. */
export type AssetKind = "image" | "pdf" | "audio" | "video";

const STREAMING_KINDS: readonly AssetKind[] = ["audio", "video"];

export type AssetDeliveryDecision =
  | {
      kind: "load";
      /** Known size in bytes, when it could be measured. */
      bytes: number | null;
      /** True when the element fetches ranges instead of one whole file. */
      streamed: boolean;
    }
  | {
      kind: "confirm";
      bytes: number;
      reason: string;
      alternatives: readonly LimitAlternative[];
      /** Ceiling the explicit action may reach. */
      overrideLimitBytes: number;
    }
  | {
      kind: "refuse";
      bytes: number | null;
      reason: string;
      alternatives: readonly LimitAlternative[];
    };

/**
 * Decides whether a preview may load a whole asset.
 *
 * Audio and video stream through byte ranges (each response is one chunk), so
 * their size is not a whole-file allocation and is never a refusal. Images and
 * PDFs load as one resource: at or below the approved read ceiling they load;
 * above it they need the explicit "load anyway" choice (up to the approved
 * override ceiling); above that the honest answer is an external viewer.
 */
export function assetDeliveryDecision(
  bytes: number | null,
  kind: AssetKind,
  options: { readonly override?: boolean } = {},
): AssetDeliveryDecision {
  if (STREAMING_KINDS.includes(kind)) {
    return { kind: "load", bytes, streamed: true };
  }
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return {
      kind: "refuse",
      bytes: null,
      reason:
        "This asset's size could not be measured, so it was not loaded. Open it in an external viewer instead.",
      alternatives: ["open-externally"],
    };
  }
  if (bytes <= ASSET_DELIVERY.readBytes) {
    return { kind: "load", bytes, streamed: false };
  }
  if (bytes > ASSET_DELIVERY.overrideBytes) {
    return {
      kind: "refuse",
      bytes,
      reason:
        `This asset is ${mibLabel(bytes)}, above the ${mibLabel(ASSET_DELIVERY.overrideBytes)} ` +
        "ceiling an explicit load can reach. Open it in an external viewer.",
      alternatives: ["open-externally"],
    };
  }
  if (options.override) {
    return { kind: "load", bytes, streamed: false };
  }
  return {
    kind: "confirm",
    bytes,
    reason:
      `This asset is ${mibLabel(bytes)}, above the ${mibLabel(ASSET_DELIVERY.readBytes)} ` +
      `preview read limit. Loading it reads the whole file (up to ` +
      `${mibLabel(ASSET_DELIVERY.overrideBytes)}); you can also open it in an ` +
      "external viewer.",
    alternatives: ["open-externally"],
    overrideLimitBytes: ASSET_DELIVERY.overrideBytes,
  };
}

/** Adds the explicit "load anyway" choice to a grant URL the pane already has. */
export function assetUrlWithOverride(url: string, override: boolean): string {
  if (!override) return url;
  return `${url}${url.includes("?") ? "&" : "?"}override=1`;
}

export type AssetFailureNotice = {
  readonly reason: string;
  readonly alternatives: readonly LimitAlternative[];
  readonly retryable: boolean;
};

/**
 * Turns a native grant refusal into something a person can act on. The native
 * strings are the ones `fs::assets` returns; anything unrecognised still gets a
 * reason, a retry and the external fallback rather than a bare error code.
 */
export function assetFailureNotice(
  error: string | undefined,
): AssetFailureNotice | null {
  if (!error) return null;
  const message = error.toLowerCase();
  if (message.includes("too many active media grants")) {
    return {
      reason:
        "This preview could not be authorized because too many media views are open. Close another media preview and retry, or open the file externally.",
      alternatives: ["open-externally"],
      retryable: true,
    };
  }
  if (message.includes("only media files")) {
    return {
      reason:
        "This file type is not previewable here. Open it in an external application instead.",
      alternatives: ["open-externally"],
      retryable: false,
    };
  }
  if (
    message.includes("outside") ||
    message.includes("escaped") ||
    message.includes("sensitive") ||
    message.includes("protected")
  ) {
    return {
      reason:
        "This file is outside the folder the document is allowed to load from, or it is in a protected location. Open it externally if you meant to see it.",
      alternatives: ["open-externally"],
      retryable: false,
    };
  }
  if (message.includes("unloaded") || message.includes("revoked")) {
    return {
      reason:
        "This preview closed before its access was granted, so nothing was loaded. Retry to request access again.",
      alternatives: ["open-externally"],
      retryable: true,
    };
  }
  return {
    reason: `This preview could not be opened: ${error}`,
    alternatives: ["open-externally"],
    retryable: true,
  };
}

function mibLabel(bytes: number): string {
  const value = bytes / MIB;
  const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
  return `${rounded} MiB`;
}

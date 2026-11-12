import type { LimitAlternative } from "./limits";
import {
  mediaFormatLabel,
  mediaMeasured,
  mediaSupportSummary,
} from "./mediaFormats";

/**
 * The media surface's state machine, as a pure function.
 *
 * The container (`MediaPreview`) wires a native header probe, the element's
 * real lifecycle events and the playback-policy table to this. The order is
 * the contract:
 *
 * 1. route by extension (a guess, never a support claim);
 * 2. wait for the bounded native container probe;
 * 3. refuse a corrupt/unrecognized file, or bytes whose real container
 *    disagrees with the name, before mounting an element;
 * 4. refuse a container this build never measured;
 * 5. only then mount, and report what the element's own events say.
 *
 * Codec support is never inferred from the extension or `canPlayType`: a
 * mounted element that reports `MEDIA_ERR_SRC_NOT_SUPPORTED` becomes an
 * honest `load-error`, not a silent blank player.
 */

/** What the native header probe learned. Mirrors `fs_media_probe`. */
export type MediaProbeOutcome =
  | {
      kind: "container";
      format: string;
      codecs: readonly string[];
    }
  | { kind: "corrupt"; format: string; reason: string }
  | { kind: "unsupported"; reason: string }
  /** The command itself failed (missing file, permission, IPC). */
  | { kind: "unreadable"; reason: string };

/** `HTMLMediaElement.error.code`, or 0 when the element exposed no detail. */
export type MediaErrorCode = 0 | 1 | 2 | 3 | 4;

export type MediaElementStatus =
  | { phase: "idle" }
  /** The element is mounted and waiting for `loadedmetadata`. */
  | { phase: "loading" }
  | {
      phase: "loaded";
      durationSeconds: number | null;
      codecs: readonly string[];
    }
  | { phase: "error"; code: MediaErrorCode; message: string | null };

export type MediaPlaybackBlock = {
  readonly reason: string;
  /** Sessions occupying the application-wide slots, by id. */
  readonly blocking: readonly string[];
};

export type MediaViewerInput = {
  /** Container the path routes to (the extension table), or null. */
  readonly format: string | null;
  /** Null while the probe is still running. */
  readonly probe: MediaProbeOutcome | null;
  /** The tab is on screen; hidden tabs must not probe or present playback. */
  readonly visible: boolean;
  readonly element: MediaElementStatus;
  /** A `play()` attempt the approved playback policy refused. */
  readonly blocked: MediaPlaybackBlock | null;
  /** The bounded delivery URL is ready (media is not served by `asset:`). */
  readonly sourceReady: boolean;
  /** Preparing the delivery failed (server startup, revoked grant). */
  readonly sourceError: string | null;
};

export type MediaViewerState =
  | { kind: "hidden" }
  | { kind: "probing" }
  /** The container is allowed; the bounded delivery URL is being prepared. */
  | { kind: "preparing" }
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
      kind: "mismatch";
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
      kind: "loading";
      format: string;
      codecs: readonly string[];
    }
  | {
      kind: "blocked";
      format: string;
      codecs: readonly string[];
      durationSeconds: number | null;
      reason: string;
      alternatives: readonly LimitAlternative[];
      blocking: readonly string[];
    }
  | {
      kind: "ready";
      format: string;
      codecs: readonly string[];
      durationSeconds: number | null;
    }
  | {
      kind: "load-error";
      format: string;
      codecs: readonly string[];
      code: MediaErrorCode;
      reason: string;
      alternatives: readonly LimitAlternative[];
      retryable: boolean;
    };

const OPEN_EXTERNALLY: readonly LimitAlternative[] = ["open-externally"];

/** The decision, in the order the checks are meant to run. */
export function mediaViewerState(input: MediaViewerInput): MediaViewerState {
  const format = input.format;
  if (!format) {
    return {
      kind: "unsupported-format",
      reason:
        "This file is not routed to the media preview. Open it in an " +
        "external player instead.",
      alternatives: OPEN_EXTERNALLY,
    };
  }

  const started = input.element.phase !== "idle";
  if (!input.visible && !started) return { kind: "hidden" };
  if (!input.probe) return { kind: "probing" };

  const probe = input.probe;
  if (probe.kind === "unreadable") {
    return {
      kind: "unreadable",
      reason: `${probe.reason} Open it externally if you meant to play it.`,
      alternatives: OPEN_EXTERNALLY,
      retryable: true,
    };
  }
  if (probe.kind === "unsupported") {
    return {
      kind: "unsupported-format",
      reason: `${probe.reason} Open it in an external player instead.`,
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

  // The header says what the bytes are, which can disagree with the name. The
  // asset is served with the extension's MIME type, so a mislabelled file
  // would reach the demuxer as the wrong container.
  if (probe.format !== format) {
    return {
      kind: "mismatch",
      reason:
        `The file contains ${mediaFormatLabel(probe.format)} data but its ` +
        `name routes it as ${mediaFormatLabel(format)}. Open it externally or ` +
        "rename it to match.",
      alternatives: OPEN_EXTERNALLY,
    };
  }

  // Measured container support is separate from routing. An unmeasured
  // container is refused before an element is mounted (no codec is installed
  // to make it work). A measured container is mounted even when its
  // representative codec failed: the element's own error names the codec this
  // build cannot decode.
  if (!mediaMeasured(format)) {
    const label = mediaFormatLabel(format);
    return {
      kind: "unsupported-format",
      reason:
        `The media surface routes ${label} files, but this WebKitGTK build ` +
        `has not verified playback for ${label}, so no element was mounted. ` +
        "Open it in an external player instead.",
      alternatives: OPEN_EXTERNALLY,
    };
  }

  const codecs =
    probe.codecs.length > 0
      ? probe.codecs
      : input.element.phase === "loaded"
        ? input.element.codecs
        : [];

  if (input.sourceError) {
    return {
      kind: "unreadable",
      reason:
        `The bounded media delivery could not be prepared: ${input.sourceError}. ` +
        "Retry, or open it externally.",
      alternatives: OPEN_EXTERNALLY,
      retryable: true,
    };
  }
  if (!input.sourceReady) return { kind: "preparing" };

  if (input.blocked) {
    return {
      kind: "blocked",
      format,
      codecs,
      durationSeconds:
        input.element.phase === "loaded" ? input.element.durationSeconds : null,
      reason: input.blocked.reason,
      alternatives: ["stop-other-playback"],
      blocking: input.blocked.blocking,
    };
  }

  if (input.element.phase === "error") {
    return {
      kind: "load-error",
      format,
      codecs,
      code: input.element.code,
      reason: mediaErrorMessage(input.element.code, format, codecs),
      alternatives: OPEN_EXTERNALLY,
      // A source-not-supported answer will not change on retry; a corrupt or
      // interrupted stream might.
      retryable: input.element.code !== 4,
    };
  }

  if (input.element.phase === "loaded") {
    return {
      kind: "ready",
      format,
      codecs,
      durationSeconds: input.element.durationSeconds,
    };
  }

  return { kind: "loading", format, codecs };
}

/**
 * The element's own error, turned into an actionable sentence. The message
 * names the container and codecs the header reported, because the element's
 * error code alone does not say which file needed what.
 */
export function mediaErrorMessage(
  code: MediaErrorCode,
  format: string,
  codecs: readonly string[],
): string {
  const summary = mediaSupportSummary(format, codecs);
  switch (code) {
    case 1:
      return (
        "The media load was interrupted (the tab closed, the source changed, " +
        "or playback was hidden). Retry when you are ready to play it."
      );
    case 2:
      return (
        "The bounded asset delivery could not read this file: the grant may " +
        "have been revoked or the media read was refused. Retry, or open it " +
        "externally."
      );
    case 3:
      return (
        `WebKitGTK recognized ${summary} but could not decode the media; the ` +
        "file may be corrupt or use a codec variant this build does not " +
        "handle. Retry, or open it externally."
      );
    case 4:
      return (
        `${summary} is not available in this build: WebKitGTK could not find ` +
        "a codec for this container. No codec was installed automatically; " +
        "open it externally to play it."
      );
    default:
      return (
        `The media element could not play ${summary}. The file may be ` +
        "corrupt, interrupted, or use codecs this build does not provide. " +
        "Open it externally."
      );
  }
}

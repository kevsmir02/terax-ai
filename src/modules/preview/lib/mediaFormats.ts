/**
 * Media routing and measured runtime container support.
 *
 * These are two different facts and this module keeps them apart:
 *
 * - **Routing** is the extension table the editor uses to send a file to the
 *   media surface instead of the binary notice. It is a guess based on the
 *   name, nothing more.
 * - **Container support** means the bytes were identified by the native
 *   `fs_media_probe` header probe and the real WebKitGTK element actually
 *   loaded them in the app-lab run. A routed extension with no measurement is
 *   refused before an element mounts.
 *
 * Codec support is a third fact and it belongs to the element's own
 * `loadedmetadata` / `error` events: a parsed container can still contain a
 * codec this build cannot decode, so the probe reports what it saw and the
 * surface reports what happened. `canPlayType` is only a hint in the driver
 * report, never a support claim.
 */

export type MediaFormat =
  | "mp4"
  | "m4a"
  | "mov"
  | "webm"
  | "matroska"
  | "ogg"
  | "wav"
  | "mp3"
  | "flac"
  | "aac";

export type MediaKind = "video" | "audio";

/** Measured container playback in this build's webview. */
export type MediaContainerSupport = "verified" | "unsupported";

export type MediaFormatInfo = {
  /** Canonical id, matching the native probe's `format` string. */
  readonly id: MediaFormat;
  readonly extensions: readonly string[];
  readonly mime: string;
  /** Which element the surface uses for this container. */
  readonly kind: MediaKind;
  /** True when an explicitly opened file is handed to the media surface. */
  readonly routed: boolean;
  /**
   * True when a representative file of this container was opened in the real
   * webview. An unmeasured container is refused before an element mounts; a
   * measured one is mounted so its actual codecs can report for themselves.
   */
  readonly measured: boolean;
  /** Measured playback of the representative fixture in this build. */
  readonly decode: MediaContainerSupport;
  /** Where the support (or the measured refusal) comes from. */
  readonly evidence: string;
  readonly note?: string;
};

const FEDORA_EVIDENCE =
  "Fedora 44 KDE Wayland, WebKitGTK 2.54.2: the committed fixture loaded " +
  "metadata and played through the bounded loopback delivery in the real " +
  "app-lab run (2026-11-12)";

const FEDORA_UNMEASURED =
  "Fedora 44 KDE Wayland, WebKitGTK 2.54.2: no Matroska fixture measured " +
  "playback in this build, so support is not claimed";

export const MEDIA_FORMATS: Record<MediaFormat, MediaFormatInfo> = {
  mp4: {
    id: "mp4",
    extensions: ["mp4"],
    mime: "video/mp4",
    kind: "video",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: H.264 video + AAC audio",
  },
  m4a: {
    id: "m4a",
    extensions: ["m4a"],
    mime: "audio/mp4",
    kind: "audio",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: AAC audio only",
  },
  mov: {
    id: "mov",
    extensions: ["mov"],
    mime: "video/quicktime",
    kind: "video",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: H.264 video + AAC audio (QuickTime container)",
  },
  webm: {
    id: "webm",
    extensions: ["webm"],
    mime: "video/webm",
    kind: "video",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: VP9 video + Opus audio",
  },
  matroska: {
    id: "matroska",
    extensions: ["mkv"],
    mime: "video/x-matroska",
    kind: "video",
    // Routed so the person gets an explanation instead of a binary notice,
    // but the table records no measured playback and the surface refuses it
    // before mounting an element.
    routed: true,
    measured: false,
    decode: "unsupported",
    evidence: FEDORA_UNMEASURED,
  },
  ogg: {
    id: "ogg",
    extensions: ["ogg"],
    mime: "video/ogg",
    kind: "video",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: Ogg Vorbis audio; a video element plays audio-only Ogg",
  },
  wav: {
    id: "wav",
    extensions: ["wav"],
    mime: "audio/wav",
    kind: "audio",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: 16-bit PCM",
  },
  mp3: {
    id: "mp3",
    extensions: ["mp3"],
    mime: "audio/mpeg",
    kind: "audio",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  flac: {
    id: "flac",
    extensions: ["flac"],
    mime: "audio/flac",
    kind: "audio",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
  },
  aac: {
    id: "aac",
    extensions: ["aac"],
    mime: "audio/aac",
    kind: "audio",
    routed: true,
    measured: true,
    decode: "verified",
    evidence: FEDORA_EVIDENCE,
    note: "measured fixture: ADTS AAC",
  },
};

const BY_EXTENSION: ReadonlyMap<string, MediaFormatInfo> = new Map(
  Object.values(MEDIA_FORMATS).flatMap((info) =>
    info.extensions.map((extension) => [extension, info] as const),
  ),
);

const LABELS: Record<MediaFormat, string> = {
  mp4: "MP4",
  m4a: "M4A",
  mov: "QuickTime",
  webm: "WebM",
  matroska: "Matroska",
  ogg: "Ogg",
  wav: "WAV",
  mp3: "MP3",
  flac: "FLAC",
  aac: "AAC",
};

/** Every extension routed to the media surface (lowercase, no dot). */
export function routedMediaExtensions(): readonly string[] {
  return [...BY_EXTENSION.entries()]
    .filter(([, info]) => info.routed)
    .map(([extension]) => extension);
}

/**
 * The container a path routes to, or null when the file is not routed as
 * media. This is the routing decision only; callers must still check
 * {@link mediaDecodeSupport} and the native probe before mounting.
 */
export function mediaFormatForPath(path: string): MediaFormat | null {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const info = BY_EXTENSION.get(extension);
  return info?.routed ? info.id : null;
}

/** The table entry for a canonical container id, or null when unrouted. */
export function mediaFormatInfo(format: string): MediaFormatInfo | null {
  return format in MEDIA_FORMATS ? MEDIA_FORMATS[format as MediaFormat] : null;
}

/**
 * Measured container playback for a container id. Anything the table does not
 * carry is `unsupported`: routing an extension is not evidence the webview can
 * play the file.
 */
export function mediaDecodeSupport(format: string): MediaContainerSupport {
  return mediaFormatInfo(format)?.decode ?? "unsupported";
}

/**
 * True when a representative file of this container was actually opened in the
 * real webview. A routed but unmeasured container is refused before an element
 * mounts; a measured one is mounted even if its representative codec failed, so
 * the element's own error names what this build cannot decode.
 */
export function mediaMeasured(format: string): boolean {
  return mediaFormatInfo(format)?.measured ?? false;
}

/** The element this container is presented with. */
export function mediaKind(format: string): MediaKind {
  return mediaFormatInfo(format)?.kind ?? "video";
}

/** The MIME type the container is served with, or null when unrouted. */
export function mediaMime(format: string): string | null {
  return mediaFormatInfo(format)?.mime ?? null;
}

/** Human name for a container id; unknown ids are uppercased, never hidden. */
export function mediaFormatLabel(format: string): string {
  return format in LABELS
    ? LABELS[format as MediaFormat]
    : format.toUpperCase();
}

const CODEC_LABELS: Record<string, string> = {
  avc1: "H.264",
  avc3: "H.264",
  hvc1: "H.265",
  hev1: "H.265",
  vp8: "VP8",
  vp9: "VP9",
  av1: "AV1",
  mp4a: "AAC",
  aac: "AAC",
  opus: "Opus",
  vorbis: "Vorbis",
  theora: "Theora",
  flac: "FLAC",
  mp3: "MP3",
  pcm_u8: "PCM 8-bit",
  pcm_s16le: "PCM 16-bit",
  pcm_s24le: "PCM 24-bit",
  pcm_s32le: "PCM 32-bit",
  pcm_f32le: "PCM float",
  pcm_alaw: "A-law",
  pcm_mulaw: "µ-law",
  pcm_extensible: "PCM (extensible)",
};

/** A readable codec name; unknown ids are uppercased, never hidden. */
export function mediaCodecLabel(codec: string): string {
  return CODEC_LABELS[codec.toLowerCase()] ?? codec.toUpperCase();
}

/**
 * What the header actually named, for the status line and every refusal.
 * An empty codec list is reported as absent, not guessed from the extension.
 */
export function mediaSupportSummary(
  format: string,
  codecs: readonly string[],
): string {
  const label = mediaFormatLabel(format);
  if (codecs.length === 0) {
    return `${label} (codecs not listed in the header)`;
  }
  return `${label} (${codecs.map(mediaCodecLabel).join(", ")})`;
}

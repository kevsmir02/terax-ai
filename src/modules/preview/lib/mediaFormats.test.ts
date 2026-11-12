import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEDIA_FORMATS,
  mediaCodecLabel,
  mediaDecodeSupport,
  mediaFormatForPath,
  mediaFormatInfo,
  mediaFormatLabel,
  mediaKind,
  mediaMeasured,
  mediaMime,
  mediaSupportSummary,
  routedMediaExtensions,
} from "./mediaFormats";

const root = join(import.meta.dirname, "../../../..");
const rust = readFileSync(
  join(root, "src-tauri/src/modules/fs/media_probe.rs"),
  "utf8",
);

describe("media routing", () => {
  it("routes the extensions the editor sends to the media surface", () => {
    for (const extension of [
      "mp4",
      "m4a",
      "mov",
      "webm",
      "ogg",
      "wav",
      "mp3",
      "flac",
      "aac",
    ]) {
      expect(
        mediaFormatForPath(`/repo/clip.${extension.toUpperCase()}`),
      ).not.toBe(null);
    }
  });

  it("does not route documents, images or unknown files", () => {
    expect(mediaFormatForPath("/repo/notes.md")).toBeNull();
    expect(mediaFormatForPath("/repo/photo.png")).toBeNull();
    expect(mediaFormatForPath("/repo/doc.pdf")).toBeNull();
    expect(mediaFormatForPath("/repo/archive.tar.gz")).toBeNull();
    expect(mediaFormatForPath("/repo/README")).toBeNull();
  });

  it("derives the routed list from the table instead of copying it", () => {
    const routed = routedMediaExtensions();
    expect(routed).toContain("webm");
    expect(new Set(routed).size).toBe(routed.length);
    for (const extension of routed) {
      expect(mediaFormatForPath(`/repo/file.${extension}`)).not.toBeNull();
    }
  });

  it("keeps the routing kind separate from the container", () => {
    expect(mediaKind("webm")).toBe("video");
    expect(mediaKind("mp4")).toBe("video");
    expect(mediaKind("mov")).toBe("video");
    expect(mediaKind("mp3")).toBe("audio");
    expect(mediaKind("m4a")).toBe("audio");
    expect(mediaKind("aac")).toBe("audio");
    expect(mediaMime("webm")).toBe("video/webm");
    expect(mediaMime("m4a")).toBe("audio/mp4");
    expect(mediaMime("unknown")).toBeNull();
  });
});

describe("measured container support", () => {
  it("separates routing from measured runtime container support", () => {
    expect(mediaDecodeSupport("webm")).toBe("verified");
    // Matroska is routed (so the user gets an explanation instead of a binary
    // notice) but no Fedora fixture measured playback in this build.
    expect(mediaDecodeSupport("matroska")).toBe("unsupported");
    expect(mediaMeasured("matroska")).toBe(false);
    expect(mediaFormatInfo("matroska")?.routed).toBe(true);
    expect(mediaFormatInfo("flv")).toBeNull();
  });

  it("records measured container support separately from routing", () => {
    // MP4/H.264 was measured and played through the bounded loopback delivery;
    // the custom asset scheme was the transport that failed, not the codec.
    expect(mediaMeasured("mp4")).toBe(true);
    expect(mediaDecodeSupport("mp4")).toBe("verified");
    expect(MEDIA_FORMATS.mp4.evidence).toContain("loopback delivery");
  });

  it("records the real webview evidence for every routed container", () => {
    for (const format of Object.keys(MEDIA_FORMATS)) {
      const info = MEDIA_FORMATS[format as keyof typeof MEDIA_FORMATS];
      expect(info.evidence).toContain("WebKitGTK");
      expect(["verified", "unsupported"]).toContain(info.decode);
    }
  });

  it("uses the same container ids as the native probe", () => {
    // The Rust probe is the producer of the container id; restating the list in
    // a second place is exactly the drift this test exists to catch.
    const match = rust.match(
      /pub const CONTAINER_FORMATS: &\[&str\] = &\[([^\]]+)\]/,
    );
    expect(match).not.toBeNull();
    const native = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (entry) => entry[1],
    );
    expect(new Set(Object.keys(MEDIA_FORMATS))).toEqual(new Set(native));
  });
});

describe("media labels", () => {
  it("names containers and codecs for the honest status line", () => {
    expect(mediaFormatLabel("webm")).toBe("WebM");
    expect(mediaFormatLabel("m4a")).toBe("M4A");
    expect(mediaFormatLabel("matroska")).toBe("Matroska");
    expect(mediaFormatLabel("flv")).toBe("FLV");
    expect(mediaCodecLabel("avc1")).toBe("H.264");
    expect(mediaCodecLabel("mp4a")).toBe("AAC");
    expect(mediaCodecLabel("vp9")).toBe("VP9");
    expect(mediaCodecLabel("opus")).toBe("Opus");
    expect(mediaCodecLabel("zzzz")).toBe("ZZZZ");
  });

  it("summarises what the header actually said", () => {
    expect(mediaSupportSummary("webm", ["vp9", "opus"])).toBe(
      "WebM (VP9, Opus)",
    );
    expect(mediaSupportSummary("mp4", [])).toBe(
      "MP4 (codecs not listed in the header)",
    );
  });
});

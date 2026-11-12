import { describe, expect, it } from "vitest";
import {
  IMAGE_FORMATS,
  imageDecodeSupport,
  imageFormatForPath,
  imageFormatInfo,
  imageFormatLabel,
  routedImageExtensions,
} from "./imageFormats";

describe("image routing", () => {
  it("routes the extensions the editor sends to the image surface", () => {
    for (const extension of [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "ico",
      "avif",
    ]) {
      expect(imageFormatForPath(`/repo/photo.${extension.toUpperCase()}`)).not.toBe(
        null,
      );
    }
  });

  it("keeps an explicitly opened SVG an editable text tab", () => {
    // The engine decodes inline SVG (measured below), but a file tab stays
    // editable text instead of being taken over by the image surface.
    expect(imageFormatForPath("/repo/drawing.svg")).toBeNull();
    expect(imageDecodeSupport("svg")).toBe("verified");
    expect(IMAGE_FORMATS.svg.kind).toBe("vector");
  });

  it("does not route files that are not images", () => {
    expect(imageFormatForPath("/repo/notes.md")).toBeNull();
    expect(imageFormatForPath("/repo/archive.tar.gz")).toBeNull();
    expect(imageFormatForPath("/repo/README")).toBeNull();
  });

  it("keeps routing separate from measured runtime decode support", () => {
    // Routing is an extension table; decode support is evidence. A routed
    // extension with no measurement is not claimed as supported.
    expect(imageDecodeSupport("png")).toBe("verified");
    expect(imageDecodeSupport("tiff")).toBe("unsupported");
    expect(imageFormatInfo("tiff")).toBeNull();
  });

  it("records the real webview evidence for every supported format", () => {
    for (const format of Object.keys(IMAGE_FORMATS)) {
      const info = IMAGE_FORMATS[format as keyof typeof IMAGE_FORMATS];
      expect(info.decode).toBe("verified");
      expect(info.evidence).toContain("WebKitGTK");
    }
  });

  it("derives the route list from the format table instead of copying it", () => {
    const routed = routedImageExtensions();
    expect(routed).toContain("png");
    expect(routed).not.toContain("svg");
    expect(new Set(routed).size).toBe(routed.length);
  });

  it("describes a format for refusal text", () => {
    expect(imageFormatLabel("jpeg")).toBe("JPEG");
    expect(imageFormatLabel("svg")).toBe("SVG");
    expect(imageFormatLabel("tiff")).toBe("TIFF");
  });
});

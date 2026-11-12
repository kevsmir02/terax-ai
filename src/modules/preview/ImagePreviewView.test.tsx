import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImagePreviewView } from "./ImagePreviewView";
import type { ImageViewerState } from "./lib/imageViewer";

const noop = () => {};

function render(state: ImageViewerState, url = "asset://localhost/a.png?token=t") {
  return renderToStaticMarkup(
    createElement(ImagePreviewView, {
      state,
      path: "/repo/photo.png",
      url,
      onOpenExternally: noop,
      onRetry: noop,
      onDecodeFailed: noop,
    }),
  );
}

describe("ImagePreviewView", () => {
  it("renders a representative PNG only after the budget and admission", () => {
    const html = render({
      kind: "ready",
      format: "png",
      width: 64,
      height: 64,
      decodedBytes: 64 * 64 * 4,
      vector: false,
    });
    expect(html).toContain('data-image-state="ready"');
    expect(html).toContain("<img");
    expect(html).toContain("token=t");
    expect(html).toContain('data-image-width="64"');
    expect(html).toContain('data-image-format="png"');
  });

  it("renders a JPEG through the same bounded surface", () => {
    const html = render({
      kind: "ready",
      format: "jpeg",
      width: 64,
      height: 64,
      decodedBytes: 64 * 64 * 4,
      vector: false,
    });
    expect(html).toContain("<img");
    expect(html).toContain('data-image-format="jpeg"');
  });

  it("draws nothing for an oversized image and explains the external fallback", () => {
    const html = render({
      kind: "oversized",
      width: 5000,
      height: 5000,
      decodedBytes: 100_000_000,
      reason:
        "This image needs 95.4 MiB decoded, above the 64 MiB limit. Open it in an external viewer.",
      alternatives: ["open-externally"],
    });
    expect(html).toContain('data-image-state="oversized"');
    expect(html).toContain("Image too large to decode");
    expect(html).toContain("64 MiB");
    expect(html).toContain("Open externally");
    expect(html).not.toContain("<img");
  });

  it("offers retry and the external viewer for a corrupt file", () => {
    const html = render({
      kind: "corrupt",
      reason: "This PNG header is incomplete. Open it externally, or retry.",
      alternatives: ["open-externally"],
      retryable: true,
    });
    expect(html).toContain("Image could not be decoded");
    expect(html).toContain("Retry");
    expect(html).toContain("Open externally");
    expect(html).not.toContain("<img");
  });

  it("names the webview format support instead of showing a blank pane", () => {
    const html = render({
      kind: "unsupported-format",
      reason: "This build's WebKitGTK has not verified decode support for TIFF.",
      alternatives: ["open-externally"],
    });
    expect(html).toContain("Image format not supported");
    expect(html).toContain("TIFF");
    expect(html).not.toContain("<img");
  });

  it("names the blocking previews when admission is refused", () => {
    const html = render({
      kind: "admission-refused",
      reason:
        "At most 4 decoded viewers can be admitted at once. Open now: one.png, report.pdf.",
      alternatives: ["close-another-viewer", "open-externally"],
      blocking: ["one.png", "report.pdf"],
    });
    expect(html).toContain("No room for another decoded preview");
    expect(html).toContain("one.png, report.pdf");
    expect(html).toContain("Close another preview");
    expect(html).not.toContain("<img");
  });

  it("reports a released raster instead of going blank", () => {
    const html = render({
      kind: "evicted",
      reason: "Another preview needed the decoded-asset budget.",
      alternatives: ["close-another-viewer", "open-externally"],
    });
    expect(html).toContain("Preview released");
    expect(html).toContain("Close another preview");
    expect(html).not.toContain("<img");
  });

  it("reports a failed render with a retry", () => {
    const html = render({
      kind: "decode-error",
      reason: "The webview could not render this image.",
      alternatives: ["open-externally"],
      retryable: true,
    });
    expect(html).toContain("Image could not be rendered");
    expect(html).toContain("Retry");
    expect(html).not.toContain("<img");
  });

  it("stops presentation while the tab is hidden", () => {
    const html = render({ kind: "hidden" });
    expect(html).toContain('data-image-state="hidden"');
    expect(html).toContain("unloaded while this tab is not on screen");
    expect(html).not.toContain("<img");
  });

  it("does not mount the element while probing or admitting", () => {
    for (const state of [
      { kind: "probing" } as const,
      { kind: "admitting", decodedBytes: 4096 } as const,
    ]) {
      const html = render(state);
      expect(html).not.toContain("<img");
      expect(html).toContain(`data-image-state="${state.kind}"`);
    }
  });
});

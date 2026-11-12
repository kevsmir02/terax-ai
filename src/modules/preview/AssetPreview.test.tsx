import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetPreview } from "./AssetPreview";
import { TEXT_OVERRIDE_LIMIT_BYTES, TEXT_READ_LIMIT_BYTES } from "./lib/limits";

function render(overrides: Partial<Parameters<typeof AssetPreview>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(AssetPreview, {
      path: "/repo/photo.png",
      tabId: 1,
      kind: "image",
      bytes: 1024,
      url: "asset://localhost/repo/photo.png?token=t",
      token: "t",
      grantError: undefined,
      onRetryGrant: () => {},
      visible: true,
      mediaActive: true,
      ...overrides,
    }),
  );
}

describe("AssetPreview delivery gate", () => {
  it("routes a small image into the bounded image surface", () => {
    const html = render();
    // Dimensions come from the native header probe first; the element mounts
    // only after the budget and admission decide.
    expect(html).toContain('data-image-state="probing"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Load anyway");
  });

  it("asks before reading a file above the approved read ceiling", () => {
    const html = render({ bytes: TEXT_READ_LIMIT_BYTES + 1 });
    expect(html).toContain("Large file needs an explicit choice");
    expect(html).toContain("Load anyway");
    expect(html).toContain("Open externally");
    expect(html).toContain("10 MiB");
    expect(html).not.toContain("<img");
  });

  it("leaves the PDF delivery decision to the reader that owns it", () => {
    // The PDF surface owns the whole contract, including the above-override
    // refusal, so the gate's state is inside the reader rather than a second,
    // duplicate notice here (`PdfReaderView` asserts the refused state).
    const html = render({ bytes: TEXT_OVERRIDE_LIMIT_BYTES + 1, kind: "pdf" });
    expect(html).toContain('data-pdf-state="loading-reader"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
  });

  it("streams media of any size without the whole-file delivery gate", () => {
    const html = render({
      path: "/repo/film.mp4",
      kind: "video",
      bytes: 8 * 1024 * TEXT_OVERRIDE_LIMIT_BYTES,
      url: "asset://localhost/repo/film.mp4?token=t",
    });
    // Audio/video are delivered through bounded ranges, so the whole-file
    // ceiling never refuses them; the media surface still probes the real
    // container before it mounts an element (see MediaPreviewView.test).
    expect(html).toContain("data-media-viewer");
    expect(html).toContain('data-media-state="probing"');
    expect(html).not.toContain("too large");
    expect(html).not.toContain("Load anyway");
    expect(html).not.toContain("<video");
  });

  it("hands a small PDF to the app-owned reader instead of a frame", () => {
    // Issue #30 rejected the retained iframe on evidence: the frame's document
    // was cross-origin, so page count, zoom, search, selection and errors were
    // unobservable. The reader is now the app's own DOM and loads as a chunk.
    const html = render({
      path: "/repo/doc.pdf",
      kind: "pdf",
      bytes: 2048,
      token: "t",
      url: "asset://localhost/repo/doc.pdf?token=t",
    });
    expect(html).not.toContain("<iframe");
    expect(html).toContain('data-pdf-state="loading-reader"');
    expect(html).toContain("Loading the PDF reader");
  });

  it("unloads the PDF reader while its tab is not on screen", () => {
    const html = render({
      path: "/repo/doc.pdf",
      kind: "pdf",
      bytes: 2048,
      token: "t",
      url: "asset://localhost/repo/doc.pdf?token=t",
      visible: false,
    });
    expect(html).not.toContain("<iframe");
    expect(html).toContain('data-pdf-state="hidden"');
    expect(html).toContain("unloaded while this tab is not on screen");
  });

  it("explains a denied grant with a retry and the external fallback", () => {
    const html = render({
      url: undefined,
      grantError: "opened asset escaped its grant boundary",
    });
    expect(html).toContain("Preview unavailable");
    expect(html).toContain("outside the folder");
    expect(html).toContain("Open externally");
    expect(html).not.toContain("Retry");
  });

  it("offers a retry when the grant surface is merely exhausted", () => {
    const html = render({
      url: undefined,
      grantError: "too many active media grants",
    });
    expect(html).toContain("Retry");
    expect(html).toContain("too many media views");
  });

  it("does not draw anything while the grant is pending", () => {
    const html = render({ url: undefined });
    expect(html).toContain("Loading media preview");
    expect(html).not.toContain("<img");
  });
});

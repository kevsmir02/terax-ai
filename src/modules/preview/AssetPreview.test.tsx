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
      grantError: undefined,
      onRetryGrant: () => {},
      visible: true,
      mediaActive: true,
      ...overrides,
    }),
  );
}

describe("AssetPreview delivery gate", () => {
  it("loads a small image through the bounded image surface", () => {
    const html = render();
    expect(html).toContain("<img");
    expect(html).toContain("token=t");
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

  it("refuses a file above the override ceiling with an external viewer", () => {
    const html = render({ bytes: TEXT_OVERRIDE_LIMIT_BYTES + 1, kind: "pdf" });
    expect(html).toContain("File too large to preview");
    expect(html).toContain("50 MiB");
    expect(html).toContain("Open externally");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("Load anyway");
  });

  it("streams media of any size instead of refusing it", () => {
    const html = render({
      path: "/repo/film.mp4",
      kind: "video",
      bytes: 8 * 1024 * TEXT_OVERRIDE_LIMIT_BYTES,
      url: "asset://localhost/repo/film.mp4?token=t",
    });
    expect(html).toContain("<video");
    expect(html).toContain("controls");
    expect(html).not.toContain("too large");
  });

  it("opens a small PDF in the bounded frame", () => {
    const html = render({
      path: "/repo/doc.pdf",
      kind: "pdf",
      bytes: 2048,
      url: "asset://localhost/repo/doc.pdf?token=t",
    });
    expect(html).toContain("<iframe");
    expect(html).toContain("token=t");
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

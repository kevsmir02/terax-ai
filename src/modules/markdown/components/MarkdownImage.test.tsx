import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  MarkdownImageSource,
  MarkdownImageState,
} from "../lib/inlineImage";
import { MarkdownImageView } from "./MarkdownImageView";

const source: MarkdownImageSource = {
  kind: "file",
  path: "/proj/docs/photo.png",
  format: "png",
  guard: "/proj",
};

function render(state: MarkdownImageState) {
  return renderToStaticMarkup(
    createElement(MarkdownImageView, {
      state,
      source,
      src: "asset://localhost/proj/docs/photo.png?token=t",
      alt: "a photo",
    }),
  );
}

describe("MarkdownImageView", () => {
  it("draws no element until the header probe returns", () => {
    const html = render({ kind: "probing" });
    expect(html).toContain('data-markdown-image-state="probing"');
    expect(html).not.toContain("<img");
  });

  it("refuses an oversized inline image in the document with its reason", () => {
    const html = render({
      kind: "oversized",
      width: 20_000,
      height: 20_000,
      decodedBytes: 20_000 * 20_000 * 4,
      reason:
        "This image needs 1525.9 MiB decoded, above the 64 MiB limit. Open it in an external viewer.",
      alternatives: ["open-externally"],
    });
    expect(html).toContain('data-markdown-image-state="oversized"');
    expect(html).toContain("64 MiB");
    expect(html).toContain("Open it in an external viewer");
    expect(html).not.toContain("<img");
  });

  it("mounts the image only once it is admitted", () => {
    const html = render({
      kind: "ready",
      width: 512,
      height: 512,
      decodedBytes: 512 * 512 * 4,
      vector: false,
    });
    expect(html).toContain('data-markdown-image-state="ready"');
    expect(html).toContain("<img");
    expect(html).toContain("token=t");
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('data-markdown-image-bytes="1048576"');
  });

  it("mounts a remote image to measure it before admission", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownImageView, {
        state: { kind: "measuring" },
        source: { kind: "remote", url: "https://example.com/a.png" },
        src: "https://example.com/a.png",
        alt: "remote",
      }),
    );
    expect(html).toContain('data-markdown-image-state="measuring"');
    expect(html).toContain("<img");
  });

  it("explains a file refused above the delivery ceiling without blaming the file", () => {
    const html = render({
      kind: "file-too-large",
      bytes: 14 * 1024 * 1024,
      limitBytes: 10 * 1024 * 1024,
      reason:
        "This image file is 14 MiB, above the 10 MiB preview read limit, so " +
        "the document could not load it. Open it externally to view it.",
      alternatives: ["open-externally"],
    });
    expect(html).toContain('data-markdown-image-state="file-too-large"');
    expect(html).toContain("14 MiB");
    expect(html).toContain("10 MiB preview read limit");
    expect(html).toContain("Open externally");
    expect(html).not.toContain("corrupt");
    expect(html).not.toContain("<img");
  });

  it("offers the close-another-viewer alternative instead of drawing", () => {
    const html = render({
      kind: "admission-refused",
      reason: "At most 4 decoded viewers can be admitted at once.",
      alternatives: ["close-another-viewer", "open-externally"],
      blocking: ["report.pdf"],
    });
    expect(html).toContain("Close another preview");
    expect(html).not.toContain("<img");
  });
});

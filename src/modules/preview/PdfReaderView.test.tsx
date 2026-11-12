import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PdfReaderView } from "./PdfReaderView";
import type { PdfViewerState } from "./lib/pdfViewer";

const noop = () => {};

function render(
  state: PdfViewerState,
  overrides: Partial<Parameters<typeof PdfReaderView>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(PdfReaderView, {
      state,
      path: "/repo/text.pdf",
      scale: 1,
      page: null,
      search: { query: "", total: 0, index: 0, truncated: false },
      onOpenExternally: noop,
      onLoadAnyway: noop,
      onRetry: noop,
      onApplySuggestedZoom: noop,
      onFit: noop,
      onZoom: noop,
      onPage: noop,
      onGoToPage: noop,
      onSearch: noop,
      onSearchStep: noop,
      onSetZoomPercent: noop,
      onSearchKeyDown: noop,
      ...overrides,
    }),
  );
}

const ready: PdfViewerState = {
  kind: "ready",
  pageNumber: 1,
  pageCount: 6,
  scale: 1,
  renderBytes: 2_007_328,
  decodedBytes: 2_007_328,
};

describe("PdfReaderView", () => {
  it("renders the app-owned toolbar and the page's own text layer", () => {
    const html = render(ready, {
      page: {
        pageNumber: 1,
        canvas: null,
        text: "01.01 deterministic body line for page 1\n[[ page 1 of 6 ]]",
        width: 596,
        height: 842,
        spans: [
          {
            itemIndex: 0,
            str: "01.01 deterministic body line for page 1",
            left: 72,
            top: 700,
            fontSize: 12,
            matched: false,
            current: false,
          },
        ],
      },
    });
    expect(html).toContain('data-pdf-reader=""');
    expect(html).toContain('data-pdf-state="ready"');
    expect(html).toContain('data-pdf-pages="6"');
    expect(html).toContain("Fit width");
    expect(html).toContain("Fit page");
    expect(html).toContain('aria-label="Search document"');
    expect(html).toContain('data-pdf-text-layer=""');
    expect(html).toContain("01.01 deterministic body line for page 1");
    expect(html).toContain('data-pdf-render-bytes="2007328"');
    expect(html).not.toContain("data-pdf-notice");
  });

  it("shows a page-too-large refusal with the ceiling and the zoom that fits", () => {
    const html = render({
      kind: "page-too-large",
      pageNumber: 1,
      pageCount: 1,
      scale: 1,
      renderBytes: 80_621_568,
      reason:
        "This page needs 76.9 MiB rendered, above the 32 MiB per-page limit. " +
        "Reduce the zoom or open the PDF externally. The largest zoom that fits is 64%.",
      suggestedScale: 0.64,
      suggestedPercent: 64,
      alternatives: ["reduce-zoom", "open-externally"],
    });
    expect(html).toContain('data-pdf-state="page-too-large"');
    expect(html).toContain('data-pdf-notice="page-too-large"');
    expect(html).toContain("Page too large to render");
    expect(html).toContain("32 MiB");
    expect(html).toContain("Reduce to 64%");
    expect(html).toContain("Open externally");
    // The toolbar stays: reducing the zoom is the offered recovery.
    expect(html).toContain('aria-label="Zoom out"');
  });

  it("offers retry for a corrupt document and none for an encrypted one", () => {
    const corrupt = render({
      kind: "corrupt",
      reason: "This PDF could not be parsed: its structure is invalid.",
      alternatives: ["open-externally"],
      retryable: true,
    });
    expect(corrupt).toContain("PDF could not be read");
    expect(corrupt).toContain("Retry");
    expect(corrupt).toContain("Open externally");

    const encrypted = render({
      kind: "password",
      reason: "This PDF is encrypted and needs a password.",
      alternatives: ["open-externally"],
    });
    expect(encrypted).toContain("PDF is encrypted");
    expect(encrypted).not.toContain(">Retry<");
  });

  it("explains the whole-file gate instead of showing a blank pane", () => {
    const html = render({
      kind: "gated-confirm",
      reason: "This asset is 12 MiB, above the 10 MiB preview read limit.",
      alternatives: ["open-externally"],
      overrideLimitBytes: 50 * 1024 * 1024,
    });
    expect(html).toContain("Large PDF needs an explicit choice");
    expect(html).toContain("Load anyway");
    expect(html).not.toContain("data-pdf-toolbar");
  });

  it("reports an admission refusal with the blocking previews named", () => {
    const html = render({
      kind: "admission-refused",
      reason:
        "At most 4 decoded viewers can be admitted at once. Open now: a.png, b.pdf.",
      alternatives: ["close-another-viewer", "open-externally"],
      blocking: ["a.png", "b.pdf"],
    });
    expect(html).toContain("No room for another decoded preview");
    expect(html).toContain("Close another preview");
  });

  it("reports search matches honestly, including a truncated count", () => {
    const html = render(ready, {
      search: { query: "needle", total: 500, index: 3, truncated: true },
    });
    expect(html).toContain("4 of 500+");
    expect(html).toContain('data-pdf-search-truncated="1"');
  });

  it("says it is unloaded while the tab is hidden", () => {
    const html = render({ kind: "hidden" });
    expect(html).toContain('data-pdf-state="hidden"');
    expect(html).toContain("unloaded while this tab is not on screen");
    expect(html).not.toContain("data-pdf-toolbar");
  });
});

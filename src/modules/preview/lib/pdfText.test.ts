import { describe, expect, it } from "vitest";
import { buildPdfPageText } from "./pdfSearch";
import {
  pdfFontHeight,
  pdfTextIsRotated,
  pdfTransform,
  placePdfTextItem,
} from "./pdfText";

describe("pdfTransform", () => {
  it("composes a translation with an identity exactly", () => {
    expect(pdfTransform([1, 0, 0, 1, 10, 20], [1, 0, 0, 1, 3, 4])).toEqual([
      1, 0, 0, 1, 13, 24,
    ]);
  });

  it("scales the translation with the first matrix", () => {
    expect(pdfTransform([2, 0, 0, 2, 5, 5], [1, 0, 0, 1, 3, 4])).toEqual([
      2, 0, 0, 2, 11, 13,
    ]);
  });
});

describe("placePdfTextItem", () => {
  it("sits the span on the item's baseline", () => {
    // 12 pt text at scale 2: 24 px high, baseline at 100 px from the top.
    const placed = placePdfTextItem([24, 0, 0, 24, 40, 100]);
    expect(placed.fontSize).toBe(24);
    expect(placed.left).toBe(40);
    expect(placed.top).toBe(76);
  });

  it("keeps rotated text addressable instead of dropping it", () => {
    const transform = [0, 24, -24, 0, 100, 200];
    expect(pdfFontHeight(transform)).toBe(24);
    expect(pdfTextIsRotated(transform)).toBe(true);
    expect(placePdfTextItem(transform, { rotated: true })).toEqual({
      left: 100,
      top: 200,
      fontSize: 24,
    });
  });

  it("reports horizontal text as not rotated", () => {
    expect(pdfTextIsRotated([24, 0, 0, 24, 0, 0])).toBe(false);
  });
});

describe("span and item alignment", () => {
  it("keeps a 1:1 index between extracted items and text spans", () => {
    // The text layer renders one span per item, so the highlighting of a match
    // can be decided per span without re-indexing the page text.
    const items = [
      { str: "01.01 deterministic body line", hasEOL: true },
      { str: "[[ page 1 of 6 ]]", hasEOL: false },
    ];
    const page = buildPdfPageText(items);
    expect(page.spans.map((span) => span.itemIndex)).toEqual([0, 1]);
    expect(page.spans[0].end - page.spans[0].start).toBe(items[0].str.length);
  });
});

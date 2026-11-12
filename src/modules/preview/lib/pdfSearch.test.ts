import { describe, expect, it } from "vitest";
import {
  buildPdfPageText,
  findPdfMatches,
  pdfMatchForSpan,
  searchPdfDocument,
  searchStep,
} from "./pdfSearch";

// The fixture document (`scripts/app-lab/pdf_fixtures.py`) puts
// `UNIQUE-GLOBAL-NEEDLE` on page 4 only and `SEARCH-NEEDLE-NN` on page NN.
const FIXTURE_PAGES = [
  "01.01 deterministic body line for page 1\nSEARCH-NEEDLE-01\n[[ page 1 of 6 ]]",
  "02.01 deterministic body line for page 2\nSEARCH-NEEDLE-02\n[[ page 2 of 6 ]]",
  "03.01 deterministic body line for page 3\nSEARCH-NEEDLE-03\n[[ page 3 of 6 ]]",
  "04.01 deterministic body line for page 4\nSEARCH-NEEDLE-04\nUNIQUE-GLOBAL-NEEDLE\n[[ page 4 of 6 ]]",
  "05.01 deterministic body line for page 5\nSEARCH-NEEDLE-05\n[[ page 5 of 6 ]]",
  "06.01 deterministic body line for page 6\nSEARCH-NEEDLE-06\n[[ page 6 of 6 ]]",
];

describe("buildPdfPageText", () => {
  it("keeps each text item addressable so a match maps back to a span", () => {
    const items = [
      { str: "hello ", hasEOL: false },
      { str: "world", hasEOL: false },
      { str: "next line", hasEOL: true },
    ];
    const page = buildPdfPageText(items);
    expect(page.text).toBe("hello worldnext line\n");
    expect(page.spans).toEqual([
      { start: 0, end: 6, itemIndex: 0 },
      { start: 6, end: 11, itemIndex: 1 },
      { start: 11, end: 20, itemIndex: 2 },
    ]);
    // A match inside the first item is reported for that span only.
    const match = findPdfMatches(page.text, "hello")[0];
    expect(pdfMatchForSpan(page.spans[0], [match])).toBe(true);
    expect(pdfMatchForSpan(page.spans[1], [match])).toBe(false);
  });

  it("keeps an item whose glyphs are only a space", () => {
    const page = buildPdfPageText([
      { str: "a", hasEOL: false },
      { str: " ", hasEOL: false },
      { str: "b", hasEOL: false },
    ]);
    expect(page.text).toBe("a b");
    expect(page.spans).toHaveLength(3);
  });
});

describe("findPdfMatches", () => {
  it("finds the unique needle on exactly one page", () => {
    const pages = FIXTURE_PAGES.map((text) =>
      buildPdfPageText([{ str: text }]),
    );
    const matches = pages.flatMap((page, index) =>
      findPdfMatches(page.text, "UNIQUE-GLOBAL-NEEDLE").map((match) => ({
        page: index,
        ...match,
      })),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].page).toBe(3);
    expect(pages[3].text.slice(matches[0].start, matches[0].end)).toBe(
      "UNIQUE-GLOBAL-NEEDLE",
    );
  });

  it("finds a per-page needle on the page it belongs to", () => {
    const matches = findPdfMatches(FIXTURE_PAGES[2], "SEARCH-NEEDLE-03");
    expect(matches).toHaveLength(1);
    expect(FIXTURE_PAGES[2].slice(matches[0].start, matches[0].end)).toBe(
      "SEARCH-NEEDLE-03",
    );
    expect(findPdfMatches(FIXTURE_PAGES[2], "SEARCH-NEEDLE-04")).toHaveLength(
      0,
    );
  });

  it("is case-insensitive but reports the document's own offsets", () => {
    const matches = findPdfMatches(FIXTURE_PAGES[3], "unique-global-needle");
    expect(matches).toHaveLength(1);
    expect(FIXTURE_PAGES[3].slice(matches[0].start, matches[0].end)).toBe(
      "UNIQUE-GLOBAL-NEEDLE",
    );
  });

  it("finds repeated occurrences and caps an unbounded result honestly", () => {
    expect(findPdfMatches("ab ab ab", "ab")).toHaveLength(3);
    const many = findPdfMatches("x ".repeat(1000), "x", { max: 25 });
    expect(many).toHaveLength(25);
    const document = searchPdfDocument(["x ".repeat(1000)], "x", { max: 25 });
    expect(document.matches).toHaveLength(25);
    expect(document.truncated).toBe(true);
    expect(searchPdfDocument(FIXTURE_PAGES, "needle").truncated).toBe(false);
  });

  it("treats an empty or whitespace query as no search", () => {
    expect(findPdfMatches(FIXTURE_PAGES[0], "")).toEqual([]);
    expect(findPdfMatches(FIXTURE_PAGES[0], "   ")).toEqual([]);
  });

  it("does not match across an inserted line break", () => {
    expect(findPdfMatches("SEARCH-\nNEEDLE", "SEARCH-NEEDLE")).toHaveLength(0);
  });
});

describe("searchStep", () => {
  it("moves through matches and wraps at both ends", () => {
    expect(searchStep(0, 1, 3)).toBe(1);
    expect(searchStep(2, 1, 3)).toBe(0);
    expect(searchStep(0, -1, 3)).toBe(2);
  });

  it("has no position when there is nothing to step through", () => {
    expect(searchStep(0, 1, 0)).toBeNull();
    expect(searchStep(-1, 1, 0)).toBeNull();
  });
});

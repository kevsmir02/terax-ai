/**
 * Search and selectable-text layout for the PDF reader.
 *
 * The reader owns its document, so search is not a viewer feature it cannot
 * see: it is a function over extracted text. Text extraction gives one string
 * per text item (roughly a word or a run); this module concatenates them in
 * reading order, keeps each item's range, and maps a match back to the spans
 * that must be highlighted. Selection uses the same spans, so the text a
 * person copies is the document's own text.
 *
 * Pure: no pdfjs types, no DOM. The caller passes `{ str, hasEOL }` items.
 */

export type PdfTextItem = {
  readonly str: string;
  readonly hasEOL?: boolean;
};

export type PdfTextSpan = {
  /** Inclusive offset in the page's concatenated text. */
  readonly start: number;
  /** Exclusive offset. */
  readonly end: number;
  /** Index in the page's item list, for positioning the span. */
  readonly itemIndex: number;
};

export type PdfPageText = {
  readonly text: string;
  readonly spans: readonly PdfTextSpan[];
};

export type PdfMatchRange = {
  readonly start: number;
  readonly end: number;
};

export type PdfDocumentMatch = PdfMatchRange & {
  /** 0-based page index. */
  readonly page: number;
};

export type PdfSearchResult = {
  readonly matches: readonly PdfDocumentMatch[];
  /** True when `max` stopped the search before the end of the document. */
  readonly truncated: boolean;
  readonly query: string;
};

/** Default cap: enough for a real document, bounded for a pathological one. */
export const PDF_SEARCH_MAX_MATCHES = 500;

/**
 * Concatenates text items into the page's searchable text and records each
 * item's range. A line-break item ends the line with `\n`; the newline belongs
 * to no span, so a match can never silently span two lines.
 */
export function buildPdfPageText(items: readonly PdfTextItem[]): PdfPageText {
  let text = "";
  const spans: PdfTextSpan[] = [];
  items.forEach((item, itemIndex) => {
    const start = text.length;
    text += item.str;
    spans.push({ start, end: text.length, itemIndex });
    if (item.hasEOL) text += "\n";
  });
  return { text, spans };
}

/** Case-insensitive, non-overlapping occurrences of `query` in `text`. */
export function findPdfMatches(
  text: string,
  query: string,
  options: { readonly max?: number } = {},
): readonly PdfMatchRange[] {
  const needle = query.trim();
  if (!needle) return [];
  const max = options.max ?? PDF_SEARCH_MAX_MATCHES;
  if (max <= 0) return [];
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  const ranges: PdfMatchRange[] = [];
  let from = 0;
  while (ranges.length < max) {
    const index = haystack.indexOf(lower, from);
    if (index === -1) break;
    ranges.push({ start: index, end: index + needle.length });
    from = index + Math.max(1, needle.length);
  }
  return ranges;
}

/** True when any match intersects the span, so the span is highlighted. */
export function pdfMatchForSpan(
  span: PdfTextSpan,
  matches: readonly PdfMatchRange[],
): boolean {
  return matches.some(
    (match) => match.start < span.end && match.end > span.start,
  );
}

/**
 * Searches the whole document, page by page, in reading order. The cap is
 * reported as `truncated` rather than silently dropping matches: the toolbar
 * says "first N" instead of claiming a total it did not compute.
 */
export function searchPdfDocument(
  pages: readonly (string | PdfPageText)[],
  query: string,
  options: { readonly max?: number } = {},
): PdfSearchResult {
  const needle = query.trim();
  const max = options.max ?? PDF_SEARCH_MAX_MATCHES;
  if (!needle || max <= 0) {
    return { matches: [], truncated: false, query: needle };
  }
  const matches: PdfDocumentMatch[] = [];
  for (let page = 0; page < pages.length; page += 1) {
    const entry = pages[page];
    const text = typeof entry === "string" ? entry : entry.text;
    const remaining = max - matches.length;
    if (remaining <= 0) return { matches, truncated: true, query: needle };
    // Ask for one match beyond the cap: getting it is the only honest proof
    // that the result is truncated.
    const found = findPdfMatches(text, needle, { max: remaining + 1 });
    for (const range of found.slice(0, remaining)) {
      matches.push({ page, ...range });
    }
    if (found.length > remaining) {
      return { matches, truncated: true, query: needle };
    }
  }
  return { matches, truncated: false, query: needle };
}

/**
 * The index to move to in a match list, wrapping at both ends, or null when
 * there is nothing to step through.
 */
export function searchStep(
  index: number,
  direction: 1 | -1,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (index < 0) return direction === 1 ? 0 : count - 1;
  return (index + direction + count) % count;
}

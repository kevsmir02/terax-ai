/**
 * Selectable text layer geometry.
 *
 * The reader draws one absolutely positioned span per extracted text item, so
 * the browser's own selection and copy work over the document's text (the
 * contract's "text selection" function) and search can highlight the exact
 * spans a match touches. The transform maths is pdf.js's: the item's own
 * transform composed with the page viewport transform, and the font height is
 * the length of the transformed vertical basis.
 *
 * Pure so the placement can be asserted without a canvas.
 */

export type PdfTextLayout = {
  readonly itemIndex: number;
  readonly str: string;
  /** CSS pixels from the page's left edge. */
  readonly left: number;
  /** CSS pixels from the page's top edge. */
  readonly top: number;
  readonly fontSize: number;
  /** True when a search match covers any character of this span. */
  readonly matched: boolean;
  /** True when this span contains the currently selected match. */
  readonly current: boolean;
};

/** Composes two 2D affine matrices in the order pdf.js uses. */
export function pdfTransform(
  first: readonly number[],
  second: readonly number[],
): [number, number, number, number, number, number] {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

/** The font height a transformed text item occupies, in CSS pixels. */
export function pdfFontHeight(transform: readonly number[]): number {
  return Math.hypot(transform[2], transform[3]);
}

/**
 * Places one text item in the page box. Only horizontal text is positioned
 * with the simple baseline offset; rotated text falls back to its transformed
 * origin so it stays selectable (the text is still in the DOM in reading
 * order) even if its box is approximate.
 */
export function placePdfTextItem(
  transform: readonly number[],
  options: { readonly rotated?: boolean } = {},
): { left: number; top: number; fontSize: number } {
  const fontSize = pdfFontHeight(transform);
  if (options.rotated) {
    return { left: transform[4], top: transform[5], fontSize };
  }
  return { left: transform[4], top: transform[5] - fontSize, fontSize };
}

/** True when the item's text is rotated in the page. */
export function pdfTextIsRotated(transform: readonly number[]): boolean {
  const angle = Math.atan2(transform[1], transform[0]);
  return Math.abs(angle) > 0.001;
}

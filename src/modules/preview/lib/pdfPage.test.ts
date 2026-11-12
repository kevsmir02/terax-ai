import { describe, expect, it } from "vitest";
import { PDF_PAGE_LIMIT_BYTES } from "./limits";
import {
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  pdfFitScale,
  pdfRenderBytes,
  pdfScaleLabel,
  pdfSteppedScale,
  pdfZoomDecision,
} from "./pdfPage";

// The expected raster sizes come from an independent producer:
// `scripts/app-lab/pdf_fixtures.py` computes `ceil(widthPt * zoom) *
// ceil(heightPt * zoom) * 4` for the same A4 / 72×54in geometry, and those
// numbers are recorded in docs/architecture/pdf-reader.md. They are literals
// here on purpose: restating the formula would make the test tautological.
const A4_PT = { widthPt: 595.276, heightPt: 841.89 };
const LARGE_PT = { widthPt: 5184, heightPt: 3888 };

describe("pdfRenderBytes", () => {
  it("matches the fixture generator's A4 raster sizes", () => {
    expect(pdfRenderBytes(A4_PT, 1)).toBe(2_007_328);
    expect(pdfRenderBytes(A4_PT, 4)).toBe(32_090_304);
    expect(pdfRenderBytes(A4_PT, 8)).toBe(128_334_272);
  });

  it("matches the fixture generator's 72-inch page sizes", () => {
    expect(pdfRenderBytes(LARGE_PT, 0.5)).toBe(20_155_392);
    expect(pdfRenderBytes(LARGE_PT, 1)).toBe(80_621_568);
  });

  it("counts the device pixel ratio the canvas really allocates", () => {
    // 2× display at 100 %: ceil(595.276 × 2) × ceil(841.89 × 2) × 4.
    expect(pdfRenderBytes(A4_PT, 1, 2)).toBe(8_022_576);
  });

  it("refuses an unusable geometry instead of guessing", () => {
    expect(pdfRenderBytes({ widthPt: 0, heightPt: 841.89 }, 1)).toBeNull();
    expect(pdfRenderBytes({ widthPt: 595.276, heightPt: -1 }, 1)).toBeNull();
    expect(pdfRenderBytes(A4_PT, 0)).toBeNull();
    expect(pdfRenderBytes(A4_PT, Number.NaN)).toBeNull();
    expect(pdfRenderBytes(A4_PT, 1, 0)).toBeNull();
  });
});

describe("pdfZoomDecision", () => {
  it("allows a page inside the approved 32 MiB ceiling", () => {
    const decision = pdfZoomDecision(A4_PT, 4);
    expect(decision.kind).toBe("allow");
    if (decision.kind !== "allow") throw new Error("expected allow");
    expect(decision.renderBytes).toBe(32_090_304);
    expect(decision.renderBytes).toBeLessThanOrEqual(PDF_PAGE_LIMIT_BYTES);
  });

  it("refuses the zoom that crosses the ceiling and names one that fits", () => {
    const decision = pdfZoomDecision(A4_PT, 8);
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.renderBytes).toBe(128_334_272);
    // The refusal names the ceiling through the approved decision, and offers
    // the largest whole percent that really fits — not a bare ratio the caller
    // has to re-derive.
    expect(decision.reason).toContain("32 MiB");
    expect(decision.suggestedScale).not.toBeNull();
    expect(decision.suggestedPercent).toBe(409);
    expect(pdfZoomDecision(A4_PT, decision.suggestedScale ?? 0).kind).toBe(
      "allow",
    );
  });

  it("refuses a 72-inch page at 100 % and suggests the fit that passes", () => {
    const decision = pdfZoomDecision(LARGE_PT, 1);
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.suggestedPercent).toBe(64);
    expect(pdfZoomDecision(LARGE_PT, 0.5).kind).toBe("allow");
  });

  it("counts the device pixel ratio before painting", () => {
    // The same A4 page at 400 % allocates four times the raster on a 2× display:
    // 32 MiB at 1× (allowed) and 128 MiB at 2× (refused) for identical CSS size.
    expect(pdfZoomDecision(A4_PT, 4, 1).kind).toBe("allow");
    expect(pdfZoomDecision(A4_PT, 4, 2).kind).toBe("refuse");
  });

  it("refuses an unmeasurable page with the external alternative", () => {
    const decision = pdfZoomDecision({ widthPt: 0, heightPt: 0 }, 1);
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("expected refuse");
    expect(decision.renderBytes).toBeNull();
    expect(decision.suggestedScale).toBeNull();
    expect(decision.alternatives).toContain("open-externally");
  });
});

describe("pdfFitScale", () => {
  it("fits the page width to the pane", () => {
    expect(
      Math.round(
        pdfFitScale(A4_PT, { width: 900, height: 1400 }, "width") * 1000,
      ) / 1000,
    ).toBe(1.512);
  });

  it("fits the whole page into the pane", () => {
    expect(
      Math.round(
        pdfFitScale(A4_PT, { width: 500, height: 5000 }, "page") * 1000,
      ) / 1000,
    ).toBe(0.84);
    expect(
      Math.round(
        pdfFitScale(A4_PT, { width: 900, height: 600 }, "page") * 1000,
      ) / 1000,
    ).toBe(0.713);
  });

  it("falls back instead of dividing by an unmeasured pane", () => {
    expect(pdfFitScale(A4_PT, { width: 0, height: 0 }, "width")).toBe(1);
  });
});

describe("zoom stepping and labelling", () => {
  it("stays inside the supported zoom range", () => {
    expect(PDF_MIN_SCALE).toBe(0.1);
    expect(PDF_MAX_SCALE).toBe(8);
    expect(pdfSteppedScale(PDF_MAX_SCALE, 1)).toBe(PDF_MAX_SCALE);
    expect(pdfSteppedScale(PDF_MIN_SCALE, -1)).toBe(PDF_MIN_SCALE);
    expect(pdfSteppedScale(1, 1)).toBeCloseTo(1.1, 6);
  });

  it("labels a scale the way the toolbar shows it", () => {
    expect(pdfScaleLabel(1)).toBe("100%");
    expect(pdfScaleLabel(1.5)).toBe("150%");
    expect(pdfScaleLabel(0.64)).toBe("64%");
  });
});

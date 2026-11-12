import { describe, expect, it } from "vitest";
import { assetDeliveryDecision } from "./assetDelivery";
import { MIB, type ViewerAdmission } from "./limits";
import {
  pdfViewerRegistration,
  pdfViewerRequest,
  pdfViewerState,
  type PdfViewerInput,
} from "./pdfViewer";

const A4_PT = { widthPt: 595.276, heightPt: 841.89 };
const LARGE_PT = { widthPt: 5184, heightPt: 3888 };
const LOADED = { kind: "loaded" as const, pages: 6, encrypted: false };
const ADMIT: ViewerAdmission = {
  kind: "admit",
  decodedBytes: 2_007_328,
  evict: [],
  totalDecodedBytes: 2_007_328,
};

function input(overrides: Partial<PdfViewerInput> = {}): PdfViewerInput {
  return {
    visible: true,
    gate: assetDeliveryDecision(10_000, "pdf"),
    load: LOADED,
    page: A4_PT,
    pageCount: 6,
    pageIndex: 0,
    scale: 1,
    outputScale: 1,
    cacheBytes: 0,
    admission: ADMIT,
    evicted: false,
    ...overrides,
  };
}

describe("pdfViewerState order", () => {
  it("claims nothing while the tab is not on screen", () => {
    const state = pdfViewerState(input({ visible: false }));
    expect(state.kind).toBe("hidden");
    expect(pdfViewerRequest(state)).toBeNull();
    expect(pdfViewerRegistration(state)).toBeNull();
  });

  it("applies the whole-file gate before the document is read", () => {
    const confirm = pdfViewerState(
      input({ gate: assetDeliveryDecision(20 * MIB, "pdf") }),
    );
    expect(confirm.kind).toBe("gated-confirm");
    if (confirm.kind !== "gated-confirm")
      throw new Error("expected gated-confirm");
    expect(confirm.overrideLimitBytes).toBe(50 * MIB);
    expect(confirm.reason).toContain("10 MiB");

    const refused = pdfViewerState(
      input({ gate: assetDeliveryDecision(60 * MIB, "pdf") }),
    );
    expect(refused.kind).toBe("gated-refused");
    if (refused.kind !== "gated-refused")
      throw new Error("expected gated-refused");
    expect(refused.alternatives).toContain("open-externally");
  });

  it("shows the loading state until the document reports itself", () => {
    const state = pdfViewerState(input({ load: null }));
    expect(state.kind).toBe("loading");
    expect(pdfViewerRequest(state)).toBeNull();
  });

  it("turns each document failure into a reason and a safe alternative", () => {
    const cases: [string, string, boolean][] = [
      ["corrupt", "corrupt", true],
      ["password", "password", false],
      ["unsupported", "unsupported", false],
      ["unreadable", "unreadable", true],
    ];
    for (const [kind, expected, retryable] of cases) {
      const state = pdfViewerState(
        input({ load: { kind: kind as "corrupt", reason: "because" } }),
      );
      expect(state.kind).toBe(expected);
      if (state.kind === "corrupt" || state.kind === "unreadable") {
        expect(state.retryable).toBe(retryable);
        expect(state.reason).toContain("because");
      }
      if ("alternatives" in state) {
        expect(state.alternatives).toContain("open-externally");
      }
    }
  });

  it("waits for the page geometry instead of painting an unmeasured page", () => {
    const state = pdfViewerState(input({ page: null }));
    expect(state.kind).toBe("loading");
  });

  it("refuses the zoom before painting and names the zoom that fits", () => {
    const state = pdfViewerState(
      input({ page: A4_PT, scale: 8, pageIndex: 2 }),
    );
    expect(state.kind).toBe("page-too-large");
    if (state.kind !== "page-too-large") throw new Error("expected refusal");
    expect(state.renderBytes).toBe(128_334_272);
    expect(state.reason).toContain("32 MiB");
    expect(state.suggestedPercent).toBe(409);
    expect(state.alternatives).toContain("reduce-zoom");
    expect(pdfViewerRequest(state)).toBeNull();
  });

  it("refuses a 72-inch page at 100 % and offers the fit that passes", () => {
    const state = pdfViewerState(input({ page: LARGE_PT, scale: 1 }));
    expect(state.kind).toBe("page-too-large");
    if (state.kind !== "page-too-large") throw new Error("expected refusal");
    expect(state.suggestedPercent).toBe(64);
    expect(state.suggestedScale).toBeCloseTo(0.64, 6);
  });

  it("registers the rendered raster with the decoded-viewer table only when admitted", () => {
    const admitting = pdfViewerState(input({ admission: null }));
    expect(admitting.kind).toBe("admitting");
    expect(pdfViewerRequest(admitting)).toEqual({
      decodedBytes: 2_007_328,
    });
    expect(pdfViewerRegistration(admitting)).toBeNull();

    const ready = pdfViewerState(input({ pageIndex: 3, scale: 1 }));
    expect(ready.kind).toBe("ready");
    if (ready.kind !== "ready") throw new Error("expected ready");
    expect(ready.pageNumber).toBe(4);
    expect(pdfViewerRegistration(ready)).toEqual({
      decodedBytes: 2_007_328,
    });
  });

  it("counts the pages already in the raster cache in the requested budget", () => {
    const state = pdfViewerState(input({ cacheBytes: 5 * MIB }));
    expect(state.kind).toBe("ready");
    expect(pdfViewerRequest(state)).toBeNull();
    expect(pdfViewerRegistration(state)).toEqual({
      decodedBytes: 5 * MIB + 2_007_328,
    });
  });

  it("turns an admission refusal into the blockers a person can act on", () => {
    const refusal: ViewerAdmission = {
      kind: "refuse",
      reason: "At most 4 decoded viewers can be admitted at once.",
      alternatives: ["close-another-viewer", "open-externally"],
      blocking: ["image:1:/repo/a.png", "pdf:2:/repo/b.pdf"],
    };
    const state = pdfViewerState(input({ admission: refusal }));
    expect(state.kind).toBe("admission-refused");
    if (state.kind !== "admission-refused")
      throw new Error("expected admission-refused");
    expect(state.blocking).toEqual(["a.png", "b.pdf"]);
    expect(state.reason).toContain("a.png");
  });

  it("explains a released raster instead of silently blanking", () => {
    const state = pdfViewerState(input({ evicted: true }));
    expect(state.kind).toBe("evicted");
    if (state.kind !== "evicted") throw new Error("expected evicted");
    expect(state.alternatives).toContain("close-another-viewer");
  });

  it("never paints an encrypted document it cannot open", () => {
    const state = pdfViewerState(
      input({
        load: {
          kind: "password",
          reason: "This PDF is encrypted and needs a password.",
        },
      }),
    );
    expect(state.kind).toBe("password");
    expect(pdfViewerRequest(state)).toBeNull();
  });
});

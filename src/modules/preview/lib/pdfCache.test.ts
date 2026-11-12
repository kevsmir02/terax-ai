import { describe, expect, it } from "vitest";
import { PDF_PAGE_LIMIT_BYTES } from "./limits";
import { PdfRasterCache, planPdfCache } from "./pdfCache";

const MB = 1024 * 1024;

describe("planPdfCache", () => {
  const cached = [
    { page: 0, bytes: 10, lastUsed: 1 },
    { page: 1, bytes: 10, lastUsed: 2 },
    { page: 2, bytes: 10, lastUsed: 3 },
  ];

  it("admits a page that fits by releasing the least recently used one", () => {
    const plan = planPdfCache({
      cached,
      capacityBytes: 30,
      incoming: { page: 3, bytes: 10 },
    });
    expect(plan.admitted).toBe(true);
    expect(plan.evict).toEqual([0]);
    expect(plan.keepBytes).toBe(30);
  });

  it("never releases the page that is on screen", () => {
    const plan = planPdfCache({
      cached,
      capacityBytes: 30,
      incoming: { page: 3, bytes: 10 },
      protect: 0,
    });
    expect(plan.admitted).toBe(true);
    expect(plan.evict).not.toContain(0);
    expect(plan.evict).toEqual([1]);
  });

  it("admits the same page again without releasing anything", () => {
    const plan = planPdfCache({
      cached,
      capacityBytes: 30,
      incoming: { page: 2, bytes: 10 },
    });
    expect(plan.admitted).toBe(true);
    expect(plan.evict).toEqual([]);
    expect(plan.keepBytes).toBe(30);
  });

  it("refuses a page larger than the whole cache instead of dropping every other page", () => {
    const plan = planPdfCache({
      cached,
      capacityBytes: 20,
      incoming: { page: 9, bytes: 30 },
    });
    expect(plan.admitted).toBe(false);
    expect(plan.evict).toEqual([]);
    expect(plan.reason).toContain("cache");
  });

  it("reports honestly when protected pages leave no room", () => {
    const plan = planPdfCache({
      cached: [
        { page: 0, bytes: 20, lastUsed: 1 },
        { page: 1, bytes: 5, lastUsed: 2 },
      ],
      capacityBytes: 30,
      incoming: { page: 2, bytes: 20 },
      protect: 0,
    });
    expect(plan.admitted).toBe(false);
    expect(plan.evict).toEqual([1]);
  });
});

describe("PdfRasterCache", () => {
  it("evicts least-recently-used rasters and frees them through the release hook", () => {
    const released: number[] = [];
    const cache = new PdfRasterCache(30, (page) => released.push(page));
    cache.put(0, 10, "raster-0");
    cache.put(1, 10, "raster-1");
    cache.put(2, 10, "raster-2");
    expect(cache.bytes).toBe(30);
    expect(cache.get(1)).toBe("raster-1");

    const outcome = cache.put(3, 10, "raster-3");
    expect(outcome.stored).toBe(true);
    expect(outcome.evicted).toEqual([0]);
    expect(released).toEqual([0]);
    expect(cache.get(0)).toBeUndefined();
    expect(cache.bytes).toBe(30);
    expect(cache.pages().sort()).toEqual([1, 2, 3]);
  });

  it("keeps a page at exactly the approved ceiling", () => {
    const cache = new PdfRasterCache(PDF_PAGE_LIMIT_BYTES);
    expect(cache.put(0, PDF_PAGE_LIMIT_BYTES, "page").stored).toBe(true);
    expect(cache.bytes).toBe(PDF_PAGE_LIMIT_BYTES);
    expect(cache.put(1, 1, "next").stored).toBe(true);
    expect(cache.bytes).toBe(1);
  });

  it("never stores a raster that cannot fit its own capacity", () => {
    const cache = new PdfRasterCache(10);
    const outcome = cache.put(0, 11, "too-big");
    expect(outcome.stored).toBe(false);
    expect(outcome.evicted).toEqual([]);
    expect(cache.bytes).toBe(0);
  });

  it("releases every raster when the document closes", () => {
    const released: number[] = [];
    const cache = new PdfRasterCache(4 * MB, (page) => released.push(page));
    cache.put(0, MB, "a");
    cache.put(1, MB, "b");
    cache.clear();
    expect(released.sort()).toEqual([0, 1]);
    expect(cache.bytes).toBe(0);
    expect(cache.pages()).toEqual([]);
  });
});

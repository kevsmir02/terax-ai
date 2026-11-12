import { PDF_PAGE_LIMIT_BYTES } from "./limits";

/**
 * The reader's bounded rendered-page cache.
 *
 * At the approved 32 MiB ceiling only about six rendered pages fit the
 * 192 MiB decoded budget, so the reader must not accumulate rasters while a
 * person scrolls or zooms: it keeps a cache whose byte capacity is the
 * per-page ceiling, re-renders what it released, and registers the bytes it
 * really holds with `decideViewerAdmission`. Four viewers can therefore hold at
 * most 4 × 32 MiB = 128 MiB, inside the approved budget.
 *
 * `planPdfCache` is the pure policy; `PdfRasterCache` is the small stateful
 * holder the reader uses. Both are testable without a canvas.
 */

/** One rendered page the cache holds (or is about to). */
export type PdfCachedPage = {
  readonly page: number;
  readonly bytes: number;
  /** Monotonic use counter; a larger value is more recently used. */
  readonly lastUsed: number;
};

export type PdfCachePlan = {
  /** Pages to release, least recently used first. */
  readonly evict: readonly number[];
  /** Bytes retained once `evict` is applied and `incoming` is stored. */
  readonly keepBytes: number;
  readonly admitted: boolean;
  /** Present when `admitted` is false. */
  readonly reason?: string;
};

/**
 * Decides which cached pages to release to make room for `incoming`.
 *
 * ``protect`` (the page on screen) is never released. A page larger than the
 * whole cache is refused instead of emptying the cache for it; the caller
 * still paints that page once (it passed the 32 MiB ceiling) but does not
 * cache it, and the refusal reason says so rather than pretending.
 */
export function planPdfCache(input: {
  readonly cached: readonly PdfCachedPage[];
  readonly capacityBytes: number;
  readonly incoming: { readonly page: number; readonly bytes: number };
  readonly protect?: number;
}): PdfCachePlan {
  const { cached, capacityBytes, incoming } = input;
  if (!Number.isFinite(incoming.bytes) || incoming.bytes < 0) {
    return {
      evict: [],
      keepBytes: 0,
      admitted: false,
      reason: "This page's raster could not be measured, so it was not cached.",
    };
  }
  if (incoming.bytes > capacityBytes) {
    return {
      evict: [],
      keepBytes: 0,
      admitted: false,
      reason:
        "This page's raster is larger than the whole rendered-page cache, so " +
        "it is shown without being kept.",
    };
  }
  const existing = cached.filter((entry) => entry.page !== incoming.page);
  const used =
    existing.reduce((sum, entry) => sum + entry.bytes, 0) + incoming.bytes;
  if (used <= capacityBytes) {
    return { evict: [], keepBytes: used, admitted: true };
  }
  const evictable = existing
    .filter((entry) => entry.page !== input.protect)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  const evict: number[] = [];
  let keep = used;
  for (const entry of evictable) {
    if (keep <= capacityBytes) break;
    evict.push(entry.page);
    keep -= entry.bytes;
  }
  if (keep > capacityBytes) {
    return {
      evict,
      keepBytes: keep,
      admitted: false,
      reason:
        "The rendered-page cache cannot make room without releasing the page " +
        "on screen.",
    };
  }
  return { evict, keepBytes: keep, admitted: true };
}

type CacheEntry<T> = {
  bytes: number;
  lastUsed: number;
  value: T;
};

/**
 * Holds rendered pages up to `capacityBytes`, releasing the least recently used
 * one through `release` (which zeroes the canvas so the backing store is freed
 * now, not at the next GC). `clear` releases everything: the reader calls it on
 * close, on replacement and when its tab is hidden.
 */
export class PdfRasterCache<T = unknown> {
  readonly capacityBytes: number;
  private readonly entries = new Map<number, CacheEntry<T>>();
  private readonly release: (page: number, value: T) => void;
  private clock = 0;

  constructor(
    capacityBytes: number = PDF_PAGE_LIMIT_BYTES,
    release: (page: number, value: T) => void = () => {},
  ) {
    this.capacityBytes = capacityBytes;
    this.release = release;
  }

  get bytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  pages(): number[] {
    return [...this.entries.keys()];
  }

  /** Marks a page as just used, so eviction is least-recently-used. */
  touch(page: number): void {
    const entry = this.entries.get(page);
    if (!entry) return;
    this.clock += 1;
    entry.lastUsed = this.clock;
  }

  get(page: number): T | undefined {
    const entry = this.entries.get(page);
    if (!entry) return undefined;
    this.touch(page);
    return entry.value;
  }

  /**
   * Stores a rendered page. Returns the pages it had to release and whether the
   * raster was kept. A raster that cannot fit the capacity is not stored (the
   * caller still shows it), because dropping every other page for one
   * oversized raster would make navigation worse without freeing anything.
   */
  put(
    page: number,
    bytes: number,
    value: T,
    options: { readonly protect?: number } = {},
  ): { evicted: number[]; stored: boolean } {
    const plan = planPdfCache({
      cached: [...this.entries].map(([number, entry]) => ({
        page: number,
        bytes: entry.bytes,
        lastUsed: entry.lastUsed,
      })),
      capacityBytes: this.capacityBytes,
      incoming: { page, bytes },
      protect: options.protect,
    });
    for (const victim of plan.evict) {
      const entry = this.entries.get(victim);
      if (!entry) continue;
      this.entries.delete(victim);
      this.release(victim, entry.value);
    }
    if (!plan.admitted) {
      return { evicted: [...plan.evict], stored: false };
    }
    this.clock += 1;
    this.entries.set(page, { bytes, lastUsed: this.clock, value });
    return { evicted: [...plan.evict], stored: true };
  }

  delete(page: number): void {
    const entry = this.entries.get(page);
    if (!entry) return;
    this.entries.delete(page);
    this.release(page, entry.value);
  }

  clear(): void {
    for (const [page, entry] of this.entries) this.release(page, entry.value);
    this.entries.clear();
  }
}

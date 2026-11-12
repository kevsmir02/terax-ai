import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECODED_ASSET_BUDGET_BYTES,
  type DecodedViewer,
  decideMediaPlayback,
  decideViewerAdmission,
  decodedImageBytes,
  IMAGE_DECODE_LIMIT_BYTES,
  IMAGE_DECODE_LIMIT_PIXELS,
  imageBudgetDecision,
  LIMITS_APPROVAL,
  MAX_CONCURRENT_DECODED_VIEWERS,
  MAX_PLAYING_MEDIA_APP_WIDE,
  MAX_PLAYING_MEDIA_PER_TAB,
  type MediaPlaybackSession,
  PDF_PAGE_LIMIT_BYTES,
  pdfPageDecision,
  RECOVERY_DRAFT_LIMIT_BYTES,
  RECOVERY_DRAFT_TOTAL_BYTES,
  RESOURCE_LIMITS,
  TEXT_OVERRIDE_LIMIT_BYTES,
  TEXT_READ_LIMIT_BYTES,
  TEXT_SYNTAX_LIMIT_BYTES,
  textReadDecision,
} from "./limits";

const MiB = 1024 * 1024;

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("approved limits", () => {
  // The numbers come from the primary user's 2026-11-12 approval of issue #4,
  // not from this module: an accidental edit here must fail a test.
  it("are the approved values", () => {
    expect(TEXT_READ_LIMIT_BYTES).toBe(10 * MiB);
    expect(TEXT_OVERRIDE_LIMIT_BYTES).toBe(50 * MiB);
    expect(TEXT_SYNTAX_LIMIT_BYTES).toBe(4 * MiB);
    expect(IMAGE_DECODE_LIMIT_BYTES).toBe(64 * MiB);
    expect(IMAGE_DECODE_LIMIT_PIXELS).toBe(4096 * 4096);
    expect(PDF_PAGE_LIMIT_BYTES).toBe(32 * MiB);
    expect(MAX_CONCURRENT_DECODED_VIEWERS).toBe(4);
    expect(DECODED_ASSET_BUDGET_BYTES).toBe(192 * MiB);
    expect(MAX_PLAYING_MEDIA_PER_TAB).toBe(1);
    expect(MAX_PLAYING_MEDIA_APP_WIDE).toBe(3);
    expect(RECOVERY_DRAFT_LIMIT_BYTES).toBe(10 * MiB);
    expect(RECOVERY_DRAFT_TOTAL_BYTES).toBe(100 * MiB);
  });

  it("is one table, not one literal per module", () => {
    expect(RESOURCE_LIMITS.text.readBytes).toBe(TEXT_READ_LIMIT_BYTES);
    expect(RESOURCE_LIMITS.image.decodedBytes).toBe(IMAGE_DECODE_LIMIT_BYTES);
    expect(RESOURCE_LIMITS.pdf.pageBytes).toBe(PDF_PAGE_LIMIT_BYTES);
    expect(RESOURCE_LIMITS.viewer.concurrent).toBe(
      MAX_CONCURRENT_DECODED_VIEWERS,
    );
    expect(RESOURCE_LIMITS.viewer.decodedBudgetBytes).toBe(
      DECODED_ASSET_BUDGET_BYTES,
    );
    expect(RESOURCE_LIMITS.media.perTab).toBe(MAX_PLAYING_MEDIA_PER_TAB);
    expect(RESOURCE_LIMITS.media.appWide).toBe(MAX_PLAYING_MEDIA_APP_WIDE);
    expect(RESOURCE_LIMITS.storage.draftBytes).toBe(RECOVERY_DRAFT_LIMIT_BYTES);
    expect(RESOURCE_LIMITS.storage.draftTotalBytes).toBe(
      RECOVERY_DRAFT_TOTAL_BYTES,
    );
  });

  it("records who approved them, when and against what evidence", () => {
    expect(LIMITS_APPROVAL.issue).toBe(4);
    expect(LIMITS_APPROVAL.decision).toBe("balanced");
    expect(LIMITS_APPROVAL.approvedBy).toBe("primary user");
    expect(LIMITS_APPROVAL.approvedOn).toBe("2026-11-12");
    expect(LIMITS_APPROVAL.evidence).toContain("2026-11-12");
    expect(LIMITS_APPROVAL.evidence).toContain("340");
    expect(LIMITS_APPROVAL.evidence).toContain("482");
    expect(LIMITS_APPROVAL.notDecidedHere).toContain("#42");
  });

  it("keeps storage quotas out of the runtime decoded budget", () => {
    // Recovery drafts are disk, not decoded memory: adding the draft total to
    // the decoded budget would double-count two unrelated ceilings.
    expect(RESOURCE_LIMITS.storage).not.toHaveProperty("decodedBytes");
    expect(DECODED_ASSET_BUDGET_BYTES).not.toBe(
      RECOVERY_DRAFT_TOTAL_BYTES + IMAGE_DECODE_LIMIT_BYTES,
    );
    expect(LIMITS_APPROVAL.storageIsDistinct).toContain("#16");
  });
});

describe("the native reader owns the text read ceiling", () => {
  // The enforcing owner is the Rust command; the TypeScript value only drives
  // the "open anyway" affordance. This test drags the Rust literals into the
  // contract's check so the two can't drift apart silently.
  function rustConstMiB(source: string, name: string): number | null {
    const match = new RegExp(
      `const ${name}: u64 = (\\d+) \\* 1024 \\* 1024;`,
    ).exec(source);
    return match ? Number(match[1]) : null;
  }

  it("matches modules::fs MAX_READ_BYTES and FORCE_MAX_READ_BYTES", () => {
    const rust = read("src-tauri/src/modules/fs/file.rs");
    expect(rustConstMiB(rust, "MAX_READ_BYTES")).toBe(
      TEXT_READ_LIMIT_BYTES / MiB,
    );
    expect(rustConstMiB(rust, "FORCE_MAX_READ_BYTES")).toBe(
      TEXT_OVERRIDE_LIMIT_BYTES / MiB,
    );
  });

  it("leaves no editor-side copy of the override or syntax literals", () => {
    const useDocument = read("src/modules/editor/lib/useDocument.ts");
    const editorPane = read("src/modules/editor/EditorPane.tsx");
    expect(useDocument).not.toMatch(/50 \* 1024 \* 1024/);
    expect(editorPane).not.toMatch(/4 \* 1024 \* 1024/);
    expect(editorPane).toContain("@/modules/preview/lib/limits");
    expect(editorPane).toContain("TEXT_SYNTAX_LIMIT_BYTES");
    expect(editorPane).toContain("TEXT_OVERRIDE_LIMIT_BYTES");
    expect(useDocument).not.toContain("FORCE_READ_LIMIT");
  });
});

describe("textReadDecision", () => {
  it("reads a file just under the syntax ceiling with syntax on", () => {
    expect(textReadDecision(TEXT_SYNTAX_LIMIT_BYTES - 1)).toEqual({
      kind: "read",
      bytes: TEXT_SYNTAX_LIMIT_BYTES - 1,
      syntax: true,
    });
  });

  it("keeps syntax at exactly the 4 MiB syntax ceiling", () => {
    expect(textReadDecision(TEXT_SYNTAX_LIMIT_BYTES)).toEqual({
      kind: "read",
      bytes: TEXT_SYNTAX_LIMIT_BYTES,
      syntax: true,
    });
  });

  it("reads one byte past the syntax ceiling without syntax", () => {
    expect(textReadDecision(TEXT_SYNTAX_LIMIT_BYTES + 1)).toEqual({
      kind: "read",
      bytes: TEXT_SYNTAX_LIMIT_BYTES + 1,
      syntax: false,
    });
  });

  it("reads exactly the 10 MiB normal ceiling", () => {
    expect(textReadDecision(TEXT_READ_LIMIT_BYTES)).toEqual({
      kind: "read",
      bytes: TEXT_READ_LIMIT_BYTES,
      syntax: false,
    });
  });

  it("offers the explicit override one byte past the normal ceiling", () => {
    const decision = textReadDecision(TEXT_READ_LIMIT_BYTES + 1);
    expect(decision.kind).toBe("too-large");
    if (decision.kind !== "too-large") return;
    expect(decision.limitBytes).toBe(TEXT_READ_LIMIT_BYTES);
    expect(decision.override).toEqual({
      limitBytes: TEXT_OVERRIDE_LIMIT_BYTES,
      requiresExplicitUserAction: true,
    });
    expect(decision.alternatives).toContain("open-externally");
  });

  it("honours the override at exactly 50 MiB and refuses past it", () => {
    expect(textReadDecision(TEXT_OVERRIDE_LIMIT_BYTES, true)).toEqual({
      kind: "read",
      bytes: TEXT_OVERRIDE_LIMIT_BYTES,
      syntax: false,
    });
    const past = textReadDecision(TEXT_OVERRIDE_LIMIT_BYTES + 1, true);
    expect(past.kind).toBe("too-large");
    if (past.kind !== "too-large") return;
    expect(past.override).toBeNull();
    expect(past.limitBytes).toBe(TEXT_OVERRIDE_LIMIT_BYTES);
    expect(past.reason).toMatch(/50 MiB/);
  });

  it("refuses past 50 MiB even without the override, naming that ceiling", () => {
    const past = textReadDecision(TEXT_OVERRIDE_LIMIT_BYTES + 1);
    expect(past.kind).toBe("too-large");
    if (past.kind !== "too-large") return;
    expect(past.override).toBeNull();
    expect(past.limitBytes).toBe(TEXT_READ_LIMIT_BYTES);
    expect(past.reason).toMatch(/50 MiB/);
    expect(past.alternatives).toEqual(["open-externally"]);
  });

  it("never reads an unknown size on trust", () => {
    const decision = textReadDecision(Number.NaN);
    expect(decision.kind).toBe("too-large");
    if (decision.kind !== "too-large") return;
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.alternatives.length).toBeGreaterThan(0);
  });
});

describe("imageBudgetDecision", () => {
  it("decodes RGBA8 bytes from the intrinsic dimensions", () => {
    expect(decodedImageBytes(4096, 4096)).toBe(64 * MiB);
    expect(decodedImageBytes(0, 10)).toBeNull();
  });

  it("allows a 4096x4096 image at exactly 64 MiB decoded", () => {
    expect(imageBudgetDecision(4096, 4096)).toEqual({
      kind: "allow",
      width: 4096,
      height: 4096,
      decodedBytes: IMAGE_DECODE_LIMIT_BYTES,
    });
  });

  it("allows one pixel row under the ceiling", () => {
    const decision = imageBudgetDecision(4095, 4096);
    expect(decision.kind).toBe("allow");
  });

  it("refuses an oversized image with a reason and a safe alternative", () => {
    const decision = imageBudgetDecision(4096, 4097);
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.alternatives).toContain("open-externally");
    expect(decision.reason).toContain("64 MiB");
    expect(decision.decodedBytes).toBe(4096 * 4097 * 4);
  });

  it("downscales instead when the viewer can decode at reduced size", () => {
    const decision = imageBudgetDecision(8192, 8192, { reducedDecode: true });
    expect(decision.kind).toBe("downscale");
    if (decision.kind !== "downscale") return;
    expect(
      decision.targetWidth * decision.targetHeight * 4,
    ).toBeLessThanOrEqual(IMAGE_DECODE_LIMIT_BYTES);
    expect(decision.scale).toBeCloseTo(0.5);
    expect(decision.alternative).toBe("open-externally");
    expect(decision.reason).toContain("64 MiB");
  });

  it("never promises a downscale it cannot decode", () => {
    // Same dimensions as the reduced-decode case: without that capability the
    // only honest answer is refusal, not a silent blank pane.
    expect(imageBudgetDecision(8192, 8192).kind).toBe("refuse");
  });

  it("refuses unusable dimensions without inventing a size", () => {
    for (const [w, h] of [
      [0, 100],
      [100, -1],
      [Number.NaN, 100],
      [1.5, 100],
    ]) {
      const decision = imageBudgetDecision(w, h);
      expect(decision.kind).toBe("refuse");
      if (decision.kind !== "refuse") continue;
      expect(decision.decodedBytes).toBeNull();
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.alternatives).toContain("open-externally");
    }
  });
});

describe("pdfPageDecision", () => {
  it("allows a page rendered at exactly 32 MiB", () => {
    expect(pdfPageDecision(PDF_PAGE_LIMIT_BYTES)).toEqual({
      kind: "allow",
      renderBytes: PDF_PAGE_LIMIT_BYTES,
    });
  });

  it("allows one byte under and refuses one byte over", () => {
    expect(pdfPageDecision(PDF_PAGE_LIMIT_BYTES - 1).kind).toBe("allow");
    const over = pdfPageDecision(PDF_PAGE_LIMIT_BYTES + 1);
    expect(over.kind).toBe("refuse");
    if (over.kind !== "refuse") return;
    expect(over.alternatives).toContain("reduce-zoom");
    expect(over.alternatives).toContain("open-externally");
    expect(over.reason).toContain("32 MiB");
    expect(over.suggestedZoom).toBeCloseTo(1);
    expect(over.suggestedZoom).toBeLessThan(1);
  });

  it("suggests the zoom that would fit a page twice the ceiling", () => {
    const over = pdfPageDecision(2 * PDF_PAGE_LIMIT_BYTES);
    expect(over.kind).toBe("refuse");
    if (over.kind !== "refuse") return;
    expect(over.suggestedZoom).toBeCloseTo(Math.SQRT1_2);
  });

  it("refuses an unmeasurable render instead of showing a blank page", () => {
    const over = pdfPageDecision(Number.POSITIVE_INFINITY);
    expect(over.kind).toBe("refuse");
    if (over.kind !== "refuse") return;
    expect(over.reason.length).toBeGreaterThan(0);
    expect(over.alternatives.length).toBeGreaterThan(0);
  });
});

function viewer(
  id: string,
  decodedBytes: number,
  extra: Partial<DecodedViewer> = {},
): DecodedViewer {
  return {
    id,
    tabId: extra.tabId ?? `tab-${id}`,
    decodedBytes,
    visible: extra.visible ?? true,
    lastUsed: extra.lastUsed ?? 0,
  };
}

describe("decideViewerAdmission", () => {
  it("admits viewers up to four without evicting anything", () => {
    const admitted = [
      viewer("a", 8 * MiB, { lastUsed: 1 }),
      viewer("b", 8 * MiB, { lastUsed: 2 }),
      viewer("c", 8 * MiB, { lastUsed: 3 }),
    ];
    const decision = decideViewerAdmission(
      admitted,
      viewer("d", 8 * MiB, {
        lastUsed: 4,
      }),
    );
    expect(decision.kind).toBe("admit");
    if (decision.kind !== "admit") return;
    expect(decision.evict).toEqual([]);
    expect(decision.totalDecodedBytes).toBe(32 * MiB);
  });

  it("admits the fourth viewer and refuses the fifth", () => {
    const four = ["a", "b", "c", "d"].map((id, index) =>
      viewer(id, 8 * MiB, { lastUsed: index }),
    );
    const decision = decideViewerAdmission(
      four,
      viewer("e", 8 * MiB, {
        lastUsed: 9,
      }),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.alternatives).toContain("close-another-viewer");
    expect(decision.reason).toContain("4");
    expect(decision.blocking).toEqual(["a", "b", "c", "d"]);
  });

  it("admits by evicting the least recently used hidden viewer", () => {
    const four = [
      viewer("hidden-old", 8 * MiB, { visible: false, lastUsed: 1 }),
      viewer("hidden-new", 8 * MiB, { visible: false, lastUsed: 5 }),
      viewer("shown-a", 8 * MiB, { lastUsed: 6 }),
      viewer("shown-b", 8 * MiB, { lastUsed: 7 }),
    ];
    const decision = decideViewerAdmission(
      four,
      viewer("new", 8 * MiB, {
        lastUsed: 8,
      }),
    );
    expect(decision.kind).toBe("admit");
    if (decision.kind !== "admit") return;
    expect(decision.evict).toEqual(["hidden-old"]);
    expect(decision.totalDecodedBytes).toBe(4 * 8 * MiB);
  });

  it("never evicts a visible viewer to make room", () => {
    // 192 MiB of visible viewers: the new viewer must be refused, and the
    // refusal names the blockers so the UI can ask which one to close.
    const visible = [
      viewer("a", 64 * MiB, { lastUsed: 1 }),
      viewer("b", 64 * MiB, { lastUsed: 2 }),
      viewer("c", 64 * MiB, { lastUsed: 3 }),
    ];
    const decision = decideViewerAdmission(
      visible,
      viewer("d", 1, {
        lastUsed: 4,
      }),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.blocking).toEqual(["a", "b", "c"]);
    expect(decision.reason).toContain("192 MiB");
    expect(decision.alternatives).toContain("close-another-viewer");
  });

  it("evicts only as many hidden viewers as the 192 MiB budget needs", () => {
    const viewers = [
      viewer("h1", 64 * MiB, { visible: false, lastUsed: 1 }),
      viewer("h2", 64 * MiB, { visible: false, lastUsed: 2 }),
      viewer("shown", 64 * MiB, { lastUsed: 3 }),
    ];
    const decision = decideViewerAdmission(
      viewers,
      viewer("new", 64 * MiB, {
        lastUsed: 4,
      }),
    );
    expect(decision.kind).toBe("admit");
    if (decision.kind !== "admit") return;
    expect(decision.evict).toEqual(["h1"]);
    expect(decision.totalDecodedBytes).toBe(192 * MiB);
  });

  it("refuses a viewer larger than the whole decoded budget", () => {
    const decision = decideViewerAdmission(
      [viewer("a", 1, { visible: false })],
      viewer("huge", DECODED_ASSET_BUDGET_BYTES + 1),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.reason).toContain("192 MiB");
    expect(decision.alternatives).toContain("open-externally");
  });

  it("re-admits an existing viewer by id without double counting", () => {
    const decision = decideViewerAdmission(
      [viewer("a", 8 * MiB), viewer("b", 8 * MiB)],
      viewer("a", 16 * MiB),
    );
    expect(decision.kind).toBe("admit");
    if (decision.kind !== "admit") return;
    expect(decision.evict).toEqual([]);
    expect(decision.totalDecodedBytes).toBe(24 * MiB);
  });
});

function playing(
  id: string,
  tabId: string,
  startedAt: number,
): MediaPlaybackSession {
  return { id, tabId, startedAt };
}

describe("decideMediaPlayback", () => {
  it("pauses the other playing element in the same tab", () => {
    const decision = decideMediaPlayback(
      [playing("a1", "tab-a", 1), playing("b1", "tab-b", 2)],
      playing("a2", "tab-a", 3),
    );
    expect(decision).toEqual({ kind: "play", pause: ["a1"] });
  });

  it("plays alone in an idle tab", () => {
    expect(decideMediaPlayback([], playing("a1", "tab-a", 1))).toEqual({
      kind: "play",
      pause: [],
    });
  });

  it("allows exactly three playing elements application-wide", () => {
    const three = [
      playing("a1", "tab-a", 1),
      playing("b1", "tab-b", 2),
      playing("c1", "tab-c", 3),
    ];
    expect(decideMediaPlayback(three, playing("d1", "tab-d", 4))).toEqual({
      kind: "refuse",
      reason: expect.stringContaining("3"),
      alternatives: ["stop-other-playback"],
      blocking: ["a1", "b1", "c1"],
    });
  });

  it("allows playback in the third tab of an idle application", () => {
    const decision = decideMediaPlayback(
      [playing("a1", "tab-a", 1), playing("b1", "tab-b", 2)],
      playing("c1", "tab-c", 3),
    );
    expect(decision).toEqual({ kind: "play", pause: [] });
  });

  it("counts a same-tab replacement as one slot", () => {
    // Three tabs are playing; starting a second element in tab A pauses the
    // first, so the application-wide count stays at three.
    const decision = decideMediaPlayback(
      [
        playing("a1", "tab-a", 1),
        playing("b1", "tab-b", 2),
        playing("c1", "tab-c", 3),
      ],
      playing("a2", "tab-a", 4),
    );
    expect(decision).toEqual({ kind: "play", pause: ["a1"] });
  });

  it("reports every blocker so nothing stops silently", () => {
    const decision = decideMediaPlayback(
      [
        playing("a1", "tab-a", 1),
        playing("b1", "tab-b", 2),
        playing("c1", "tab-c", 3),
      ],
      playing("d1", "tab-d", 4),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.blocking.length).toBe(3);
  });
});

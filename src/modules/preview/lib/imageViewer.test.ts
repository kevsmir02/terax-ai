import { describe, expect, it } from "vitest";
import type { ViewerAdmission } from "./limits";
import {
  type ImageProbeOutcome,
  imageViewerRegistration,
  imageViewerRequest,
  imageViewerState,
  viewerBlockerLabel,
} from "./imageViewer";

const measured = (width: number, height: number): ImageProbeOutcome => ({
  kind: "measured",
  format: "png",
  width,
  height,
});

const admit: ViewerAdmission = {
  kind: "admit",
  decodedBytes: 1024,
  evict: [],
  totalDecodedBytes: 1024,
};

const base = {
  format: "png",
  probe: measured(64, 64),
  visible: true,
  admission: admit,
  evicted: false,
  decodeFailed: false,
};

describe("image viewer decisions", () => {
  it("keeps a measured image that fits the ceiling ready to show", () => {
    const state = imageViewerState(base);
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.width).toBe(64);
    expect(state.height).toBe(64);
    expect(state.decodedBytes).toBe(64 * 64 * 4);
  });

  it("allows exactly 4096x4096 RGBA8 (the approved 64 MiB boundary)", () => {
    const state = imageViewerState({ ...base, probe: measured(4096, 4096) });
    expect(state.kind).toBe("ready");
    expect(imageViewerRegistration(state)).toEqual({
      decodedBytes: 64 * 1024 * 1024,
    });
  });

  it("refuses an image above the decoded ceiling before it can be shown", () => {
    const state = imageViewerState({ ...base, probe: measured(5000, 5000) });
    expect(state.kind).toBe("oversized");
    if (state.kind !== "oversized") return;
    expect(state.decodedBytes).toBe(5000 * 5000 * 4);
    expect(state.reason).toContain("64 MiB");
    expect(state.reason).toContain("external viewer");
    expect(state.alternatives).toContain("open-externally");
    // Nothing is admitted, so no raster can be allocated behind the refusal.
    expect(imageViewerRegistration(state)).toBeNull();
  });

  it("does not show an image while its dimensions are being measured", () => {
    const state = imageViewerState({ ...base, probe: null });
    expect(state.kind).toBe("probing");
    expect(imageViewerRegistration(state)).toBeNull();
  });

  it("reports a corrupt header with a retry and the external fallback", () => {
    const state = imageViewerState({
      ...base,
      probe: {
        kind: "corrupt",
        format: "png",
        reason: "This PNG header is incomplete.",
      },
    });
    expect(state.kind).toBe("corrupt");
    if (state.kind !== "corrupt") return;
    expect(state.reason).toContain("incomplete");
    expect(state.retryable).toBe(true);
    expect(state.alternatives).toEqual(["open-externally"]);
  });

  it("reports an unsupported container instead of a blank image", () => {
    const state = imageViewerState({
      ...base,
      probe: { kind: "unsupported", reason: "No supported image header." },
    });
    expect(state.kind).toBe("unsupported-format");
    if (state.kind !== "unsupported-format") return;
    expect(state.reason).toContain("No supported image header");
    expect(state.alternatives).toEqual(["open-externally"]);
  });

  it("refuses a format the webview was never measured to decode", () => {
    const state = imageViewerState({
      ...base,
      format: "tiff",
      probe: { kind: "measured", format: "tiff", width: 64, height: 64 },
    });
    expect(state.kind).toBe("unsupported-format");
    if (state.kind !== "unsupported-format") return;
    expect(state.reason).toContain("TIFF");
    expect(state.reason).toContain("not verified");
  });

  it("does not spend a decoded-viewer slot on a vector image", () => {
    const state = imageViewerState({
      ...base,
      format: "svg",
      probe: { kind: "vector", format: "svg" },
      admission: null,
    });
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.vector).toBe(true);
    expect(state.decodedBytes).toBe(0);
    expect(imageViewerRegistration(state)).toBeNull();
  });

  it("reports an admission refusal with the blocking previews named", () => {
    const state = imageViewerState({
      ...base,
      admission: {
        kind: "refuse",
        reason: "At most 4 decoded viewers can be admitted at once.",
        alternatives: ["close-another-viewer", "open-externally"],
        blocking: ["image:3:/repo/one.png", "pdf:4:/repo/two.pdf"],
      },
    });
    expect(state.kind).toBe("admission-refused");
    if (state.kind !== "admission-refused") return;
    expect(state.reason).toContain("At most 4 decoded viewers");
    expect(state.blocking).toEqual(["one.png", "two.pdf"]);
    expect(state.alternatives).toContain("close-another-viewer");
  });

  it("does not mount the image before admission is decided", () => {
    const state = imageViewerState({ ...base, admission: null });
    expect(state.kind).toBe("admitting");
    expect(imageViewerRegistration(state)).toBeNull();
    if (state.kind !== "admitting") return;
    // The slot is requested with exactly the bytes the budget approved.
    expect(state.decodedBytes).toBe(64 * 64 * 4);
  });

  it("reports a released raster instead of silently going blank", () => {
    const state = imageViewerState({ ...base, evicted: true });
    expect(state.kind).toBe("evicted");
    if (state.kind !== "evicted") return;
    expect(state.alternatives).toContain("open-externally");
  });

  it("reports a decode error for a header the webview cannot render", () => {
    const state = imageViewerState({ ...base, decodeFailed: true });
    expect(state.kind).toBe("decode-error");
    if (state.kind !== "decode-error") return;
    expect(state.retryable).toBe(true);
  });

  it("stops presentation and admission while the tab is hidden", () => {
    const hidden = imageViewerState({ ...base, visible: false });
    expect(hidden.kind).toBe("hidden");
    expect(imageViewerRegistration(hidden)).toBeNull();
    // Hidden wins over every other state: nothing decodes off screen.
    const hiddenCorrupt = imageViewerState({
      ...base,
      visible: false,
      probe: { kind: "corrupt", format: "png", reason: "broken" },
    });
    expect(hiddenCorrupt.kind).toBe("hidden");
  });

  it("does not register decoded bytes for a refusal", () => {
    const state = imageViewerState({
      ...base,
      admission: {
        kind: "refuse",
        reason: "no room",
        alternatives: ["close-another-viewer"],
        blocking: [],
      },
    });
    expect(imageViewerRegistration(state)).toBeNull();
  });

  it("reports an unreadable file instead of a blank image", () => {
    const state = imageViewerState({
      ...base,
      probe: { kind: "unreadable", reason: "Permission denied." },
    });
    expect(state.kind).toBe("unreadable");
    if (state.kind !== "unreadable") return;
    expect(state.reason).toContain("Permission denied");
    expect(state.alternatives).toEqual(["open-externally"]);
  });

  it("only requests a decoded slot for an image that fits the ceiling", () => {
    const fitting = imageViewerState({ ...base, admission: null });
    expect(imageViewerRequest(fitting)).toEqual({ decodedBytes: 64 * 64 * 4 });
    const oversized = imageViewerState({
      ...base,
      probe: measured(5000, 5000),
      admission: null,
    });
    expect(imageViewerRequest(oversized)).toBeNull();
    expect(imageViewerRequest({ kind: "hidden" })).toBeNull();
  });

  it("names a blocking viewer by its file, not its internal id", () => {
    expect(viewerBlockerLabel("image:7:/home/me/photos/holiday.png")).toBe(
      "holiday.png",
    );
    expect(viewerBlockerLabel("pdf:2:/docs/report.pdf")).toBe("report.pdf");
    expect(viewerBlockerLabel("opaque-id")).toBe("opaque-id");
  });
});

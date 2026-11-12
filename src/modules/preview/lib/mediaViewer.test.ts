import { describe, expect, it } from "vitest";
import type { MediaElementStatus, MediaProbeOutcome } from "./mediaViewer";
import { mediaErrorMessage, mediaViewerState } from "./mediaViewer";

const probe: MediaProbeOutcome = {
  kind: "container",
  format: "webm",
  codecs: ["vp9", "opus"],
};

const loading: MediaElementStatus = { phase: "loading" };
const loaded: MediaElementStatus = {
  phase: "loaded",
  durationSeconds: 1,
  codecs: ["vp9", "opus"],
};

function state(input: Partial<Parameters<typeof mediaViewerState>[0]> = {}) {
  return mediaViewerState({
    format: "webm",
    probe,
    visible: true,
    element: loading,
    blocked: null,
    sourceReady: true,
    sourceError: null,
    ...input,
  });
}

describe("media viewer state", () => {
  it("does no probing or mounting while the tab is not on screen", () => {
    expect(
      state({ visible: false, probe: null, element: { phase: "idle" } }).kind,
    ).toBe("hidden");
  });

  it("waits for the native container probe before mounting an element", () => {
    expect(state({ probe: null })).toEqual({ kind: "probing" });
  });

  it("refuses a file whose extension is not routed to the media surface", () => {
    const result = state({ format: null });
    expect(result.kind).toBe("unsupported-format");
    if (result.kind !== "unsupported-format") return;
    expect(result.reason).toContain("not routed");
    expect(result.alternatives).toContain("open-externally");
  });

  it("reports an unreadable file with a retry", () => {
    const result = state({
      probe: { kind: "unreadable", reason: "permission denied" },
    });
    expect(result.kind).toBe("unreadable");
    if (result.kind !== "unreadable") return;
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("permission denied");
  });

  it("reports a corrupt container instead of mounting a broken element", () => {
    const result = state({
      probe: {
        kind: "corrupt",
        format: "webm",
        reason: "This WebM header is incomplete.",
      },
    });
    expect(result.kind).toBe("corrupt");
    if (result.kind !== "corrupt") return;
    expect(result.reason).toContain("incomplete");
    expect(result.retryable).toBe(true);
  });

  it("refuses bytes the probe cannot identify as a media container", () => {
    const result = state({
      probe: {
        kind: "unsupported",
        reason: "No media signature in the header.",
      },
    });
    expect(result.kind).toBe("unsupported-format");
    if (result.kind !== "unsupported-format") return;
    expect(result.reason).toContain("No media signature");
  });

  it("refuses bytes whose real container disagrees with the extension", () => {
    const result = state({ format: "mp4", probe });
    expect(result.kind).toBe("mismatch");
    if (result.kind !== "mismatch") return;
    expect(result.reason).toContain("WebM");
    expect(result.reason).toContain("MP4");
    expect(result.alternatives).toContain("open-externally");
  });

  it("refuses a routed container this build has not measured", () => {
    // Matroska (.mkv) is routed so the refusal is informative, but the table
    // records no measured playback; routing an extension is not evidence.
    const result = state({
      format: "matroska",
      probe: { kind: "container", format: "matroska", codecs: ["vp9"] },
    });
    expect(result.kind).toBe("unsupported-format");
    if (result.kind !== "unsupported-format") return;
    expect(result.reason).toContain("Matroska");
    expect(result.reason).toContain("not verified");
  });

  it("mounts and reports loading for an allowed container", () => {
    expect(state()).toEqual({
      kind: "loading",
      format: "webm",
      codecs: ["vp9", "opus"],
    });
  });

  it("waits for the bounded delivery URL before mounting", () => {
    expect(state({ sourceReady: false })).toEqual({ kind: "preparing" });
  });

  it("explains a delivery that could not be prepared", () => {
    const result = state({
      sourceReady: false,
      sourceError: "loopback bind failed",
    });
    expect(result.kind).toBe("unreadable");
    if (result.kind !== "unreadable") return;
    expect(result.reason).toContain("loopback bind failed");
    expect(result.retryable).toBe(true);
  });

  it("reports the real container and duration once metadata loaded", () => {
    expect(state({ element: loaded })).toEqual({
      kind: "ready",
      format: "webm",
      codecs: ["vp9", "opus"],
      durationSeconds: 1,
    });
  });

  it("keeps a loaded element ready (and paused by the view) while hidden", () => {
    const result = state({ visible: false, element: loaded });
    expect(result.kind).toBe("ready");
  });

  it("reports a policy refusal without pretending playback started", () => {
    const result = state({
      element: loaded,
      blocked: {
        reason: "3 media elements are already playing in other tabs.",
        blocking: ["other-1"],
      },
    });
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reason).toContain("already playing");
    expect(result.alternatives).toContain("stop-other-playback");
    expect(result.blocking).toEqual(["other-1"]);
    expect(result.durationSeconds).toBe(1);
  });

  it("mounts a measured container so its real codec error can be reported", () => {
    // MP4 is measured in this build even though its H.264/AAC fixture did not
    // play; the element must be mounted to report which codec is missing.
    const result = state({
      format: "mp4",
      probe: { kind: "container", format: "mp4", codecs: ["avc1", "mp4a"] },
      element: { phase: "error", code: 4, message: null },
    });
    expect(result.kind).toBe("load-error");
    if (result.kind !== "load-error") return;
    expect(result.reason).toContain("MP4");
    expect(result.reason).toContain("H.264");
    expect(result.reason).toContain("AAC");
  });

  it("reports an unsupported codec from the element's own error", () => {
    const result = state({
      element: {
        phase: "error",
        code: 4,
        message: "no supported source",
      },
    });
    expect(result.kind).toBe("load-error");
    if (result.kind !== "load-error") return;
    expect(result.code).toBe(4);
    expect(result.reason).toContain("WebM");
    expect(result.reason).toContain("VP9");
    expect(result.reason).toContain("codec");
    expect(result.alternatives).toContain("open-externally");
    expect(result.retryable).toBe(false);
  });

  it("treats a decode failure as retryable and a source failure as not", () => {
    expect(
      state({ element: { phase: "error", code: 3, message: null } }),
    ).toMatchObject({ kind: "load-error", retryable: true });
    expect(
      state({ element: { phase: "error", code: 4, message: null } }),
    ).toMatchObject({ kind: "load-error", retryable: false });
  });
});

describe("media element errors", () => {
  it("maps every element error code to an honest, actionable message", () => {
    const aborted = mediaErrorMessage(1, "webm", ["vp9"]);
    const network = mediaErrorMessage(2, "webm", ["vp9"]);
    const decode = mediaErrorMessage(3, "webm", ["vp9"]);
    const unsupported = mediaErrorMessage(4, "webm", ["vp9"]);

    expect(aborted).toContain("interrupted");
    expect(network).toContain("could not read");
    expect(network).toContain("bounded");
    expect(decode).toContain("VP9");
    expect(decode).toContain("decode");
    expect(unsupported).toContain("WebM");
    expect(unsupported).toContain("codec");
    expect(new Set([aborted, network, decode, unsupported]).size).toBe(4);
  });

  it("never mentions the file extension as proof of support", () => {
    const message = mediaErrorMessage(4, "mp4", []);
    expect(message).toContain("MP4");
    expect(message).toContain("not available in this build");
    expect(message).not.toContain("supported by extension");
  });
});

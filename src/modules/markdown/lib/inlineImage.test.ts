import { beforeEach, describe, expect, it } from "vitest";
import { MIB } from "@/modules/preview/lib/limits";
import type { ImageProbeOutcome } from "@/modules/preview/lib/imageViewer";
import {
  heldDecodedBytes,
  useViewerAdmissionStore,
} from "@/modules/preview/lib/viewerAdmission";
import {
  type MarkdownImageSource,
  markdownImageMounts,
  markdownImageProbePath,
  markdownImageRegistration,
  markdownImageRequest,
  markdownImageSource,
  markdownImageState,
  markdownImageViewerId,
} from "./inlineImage";

const file = (path = "/proj/docs/photo.png"): MarkdownImageSource => ({
  kind: "file",
  path,
  format: "png",
  guard: "/proj",
});

const remote = (): MarkdownImageSource => ({
  kind: "remote",
  url: "https://example.com/photo.png",
});

const measured = (width: number, height: number): ImageProbeOutcome => ({
  kind: "measured",
  format: "png",
  width,
  height,
});

const base = {
  source: file(),
  visible: true,
  probe: null as ImageProbeOutcome | null,
  loaded: null as { width: number; height: number } | null,
  admission: null,
  evicted: false,
  decodeFailed: false,
};

const admit = {
  kind: "admit" as const,
  decodedBytes: 64 * 64 * 4,
  evict: [] as string[],
  totalDecodedBytes: 64 * 64 * 4,
};

describe("markdown inline image decisions", () => {
  beforeEach(() => {
    useViewerAdmissionStore.setState({ viewers: [], clock: 0 });
  });

  it("refuses an over-ceiling inline image before any <img> can mount", () => {
    const input = { ...base, probe: measured(20_000, 20_000) };
    const state = markdownImageState(input);

    expect(state.kind).toBe("oversized");
    if (state.kind !== "oversized") return;
    expect(state.decodedBytes).toBe(20_000 * 20_000 * 4);
    expect(state.reason).toContain("64 MiB");
    expect(state.alternatives).toContain("open-externally");
    // The ceiling is decided from the header, so nothing mounts and nothing
    // claims decoded bytes: the refusal is not an after-the-fact unmount.
    expect(markdownImageMounts(input.source, state)).toBe(false);
    expect(markdownImageRequest(state)).toBeNull();
    expect(markdownImageRegistration(state)).toBeNull();
  });

  it("admits an inline image that fits the ceiling and registers its bytes", () => {
    const input = {
      ...base,
      probe: measured(512, 512),
      admission: { ...admit, decodedBytes: 512 * 512 * 4 },
    };
    const state = markdownImageState(input);

    expect(state.kind).toBe("ready");
    expect(markdownImageMounts(input.source, state)).toBe(true);
    expect(markdownImageRegistration(state)).toEqual({
      decodedBytes: 512 * 512 * 4,
    });
  });

  it("does no work for an image that is off screen", () => {
    const input = { ...base, visible: false, probe: measured(64, 64) };
    const state = markdownImageState(input);

    expect(state.kind).toBe("deferred");
    // Never probed: the native header probe only runs once the image is near
    // the viewport (or its tab is shown).
    expect(markdownImageProbePath(input.source, state)).toBeNull();
    expect(markdownImageRequest(state)).toBeNull();
    expect(markdownImageRegistration(state)).toBeNull();
    expect(markdownImageMounts(input.source, state)).toBe(false);
  });

  it("probes a visible file image and waits for admission before mounting", () => {
    const probing = markdownImageState(base);
    expect(probing.kind).toBe("probing");
    expect(markdownImageProbePath(base.source, probing)).toBe(
      "/proj/docs/photo.png",
    );
    expect(markdownImageMounts(base.source, probing)).toBe(false);
    expect(markdownImageRequest(probing)).toBeNull();

    const admitting = markdownImageState({
      ...base,
      probe: measured(64, 64),
    });
    expect(admitting.kind).toBe("admitting");
    expect(markdownImageRequest(admitting)).toEqual({
      decodedBytes: 64 * 64 * 4,
    });
    // The image surface's contract: no <img> until the table says yes.
    expect(markdownImageMounts(base.source, admitting)).toBe(false);
  });

  it("reports an admission refusal instead of drawing the raster", () => {
    const input = {
      ...base,
      probe: measured(64, 64),
      admission: {
        kind: "refuse" as const,
        reason: "At most 4 decoded viewers can be admitted at once.",
        alternatives: ["close-another-viewer", "open-externally"] as const,
        blocking: ["markdown:3:/proj/docs/report.pdf:1"],
      },
    };
    const state = markdownImageState(input);
    expect(state.kind).toBe("admission-refused");
    if (state.kind !== "admission-refused") return;
    expect(state.reason).toContain("report.pdf");
    expect(markdownImageMounts(input.source, state)).toBe(false);
    expect(markdownImageRegistration(state)).toBeNull();
  });

  it("measures a remote image after it loads, then admits its decoded bytes", () => {
    const input = { ...base, source: remote() };
    const measuring = markdownImageState(input);
    expect(measuring.kind).toBe("measuring");
    // A remote image has no native header probe; the element mounts to learn
    // its intrinsic size, and the same ceiling is applied as soon as it does.
    expect(markdownImageProbePath(input.source, measuring)).toBeNull();
    expect(markdownImageMounts(input.source, measuring)).toBe(true);

    const admitting = markdownImageState({
      ...input,
      loaded: { width: 64, height: 64 },
    });
    expect(admitting.kind).toBe("admitting");
    expect(markdownImageRequest(admitting)).toEqual({
      decodedBytes: 64 * 64 * 4,
    });

    const oversized = markdownImageState({
      ...input,
      loaded: { width: 20_000, height: 20_000 },
    });
    expect(oversized.kind).toBe("oversized");
    expect(markdownImageMounts(input.source, oversized)).toBe(false);
  });

  it("releases an inline viewer's slot when the document goes away", () => {
    const id = markdownImageViewerId({
      documentPath: "/proj/docs/readme.md",
      tabId: 3,
      key: "photo.png",
    });
    const bytes = 512 * 512 * 4;
    const store = useViewerAdmissionStore.getState();
    expect(
      store.admit({
        id,
        tabId: "3",
        decodedBytes: bytes,
        visible: true,
      }).kind,
    ).toBe("admit");
    expect(heldDecodedBytes(useViewerAdmissionStore.getState().viewers)).toBe(
      bytes,
    );

    useViewerAdmissionStore.getState().release(id);
    expect(heldDecodedBytes(useViewerAdmissionStore.getState().viewers)).toBe(
      0,
    );
  });

  it("gives every document and every image its own viewer slot", () => {
    const one = markdownImageViewerId({
      documentPath: "/proj/docs/readme.md",
      tabId: 3,
      key: "a.png:1",
    });
    const secondImage = markdownImageViewerId({
      documentPath: "/proj/docs/readme.md",
      tabId: 3,
      key: "a.png:2",
    });
    const secondDocument = markdownImageViewerId({
      documentPath: "/proj/docs/other.md",
      tabId: 3,
      key: "a.png:1",
    });
    expect(new Set([one, secondImage, secondDocument]).size).toBe(3);
  });

  it("refuses a raster whose header cannot be measured", () => {
    const state = markdownImageState({
      ...base,
      probe: { kind: "corrupt", format: "png", reason: "truncated header" },
    });
    expect(state.kind).toBe("corrupt");
    expect(markdownImageMounts(base.source, state)).toBe(false);
    expect(markdownImageRegistration(state)).toBeNull();
  });

  it("names the file size when a local image was refused above the delivery ceiling", () => {
    // The native asset handler answers 413 for a file above the preview read
    // ceiling, so the <img> only sees a load error. Reporting that as "may be
    // corrupt" blames the file for a limit of ours.
    const input = {
      ...base,
      probe: measured(64, 64),
      admission: { ...admit, decodedBytes: 64 * 64 * 4 },
      decodeFailed: true,
      fileBytes: 14 * MIB,
    };
    const state = markdownImageState(input);

    expect(state.kind).toBe("file-too-large");
    if (state.kind !== "file-too-large") return;
    expect(state.bytes).toBe(14 * MIB);
    expect(state.limitBytes).toBe(10 * MIB);
    expect(state.reason).toContain("14 MiB");
    expect(state.reason).toContain("10 MiB preview read limit");
    expect(state.alternatives).toContain("open-externally");
    expect(markdownImageMounts(input.source, state)).toBe(false);
    expect(markdownImageRegistration(state)).toBeNull();
  });

  it("still reports a real decode failure for a file inside the delivery ceiling", () => {
    const state = markdownImageState({
      ...base,
      probe: measured(64, 64),
      admission: { ...admit, decodedBytes: 64 * 64 * 4 },
      decodeFailed: true,
      fileBytes: 2 * MIB,
    });
    expect(state.kind).toBe("decode-error");
    if (state.kind !== "decode-error") return;
    expect(state.reason).toContain("corrupt");
  });

  it("keeps the measured-at-load decode error for a remote image", () => {
    // A remote reference has no size to measure here; its load failure keeps
    // the honest "could not render" answer.
    const state = markdownImageState({
      ...base,
      source: remote(),
      decodeFailed: true,
    });
    expect(state.kind).toBe("decode-error");
  });

  it("treats an svg inline image as a vector that claims no decoded bytes", () => {
    const source: MarkdownImageSource = {
      kind: "file",
      path: "/proj/docs/diagram.svg",
      format: "svg",
      guard: "/proj",
    };
    const state = markdownImageState({
      ...base,
      source,
      probe: { kind: "vector", format: "svg" },
    });
    expect(state.kind).toBe("ready");
    expect(markdownImageRegistration(state)).toBeNull();
    expect(markdownImageMounts(source, state)).toBe(true);
  });

  it("carries the document boundary only for an automatic local image", () => {
    const local = markdownImageSource({
      kind: "file",
      path: "/proj/docs/photo.png",
      guard: "/proj",
      src: "asset://localhost/proj/docs/photo.png?token=t",
    });
    expect(local).toEqual({
      kind: "file",
      path: "/proj/docs/photo.png",
      format: "png",
      guard: "/proj",
    });

    // An outside file the person granted is probed under that consent, not the
    // document boundary.
    const granted = markdownImageSource({
      kind: "file",
      path: "/elsewhere/pic.png",
      guard: undefined,
      src: "asset://localhost/elsewhere/pic.png?token=t",
    });
    expect(granted).toMatchObject({ kind: "file", guard: null });

    expect(
      markdownImageSource({
        kind: "remote",
        path: undefined,
        guard: undefined,
        src: "https://example.com/a.png",
      }),
    ).toEqual({ kind: "remote", url: "https://example.com/a.png" });
  });

  it("keeps the approved ceiling defined only by the shared limits module", () => {
    const state = markdownImageState({
      ...base,
      probe: measured(4096, 4096),
      admission: { ...admit, decodedBytes: 64 * MIB },
    });
    expect(state.kind).toBe("ready");
    expect(markdownImageRegistration(state)).toEqual({
      decodedBytes: 64 * MIB,
    });
  });
});

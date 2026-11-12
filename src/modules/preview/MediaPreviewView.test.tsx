import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MediaPreviewView } from "./MediaPreviewView";
import type { MediaViewerState } from "./lib/mediaViewer";

function render(
  state: MediaViewerState,
  overrides: Partial<Parameters<typeof MediaPreviewView>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(MediaPreviewView, {
      state,
      path: "/repo/clip.webm",
      url: "asset://localhost/clip.webm?token=t",
      visible: true,
      onMediaRef: () => {},
      onOpenExternally: () => {},
      onRetry: () => {},
      onStopOtherPlayback: () => {},
      onElementEvent: () => {},
      ...overrides,
    }),
  );
}

const ready: MediaViewerState = {
  kind: "ready",
  format: "webm",
  codecs: ["vp9", "opus"],
  durationSeconds: 1,
};

describe("media preview view", () => {
  it("renders native controls over the granted asset URL", () => {
    const html = render(ready);
    expect(html).toContain("<video");
    expect(html).toContain('controls=""');
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('src="asset://localhost/clip.webm?token=t"');
    expect(html).not.toContain("autoplay");
    expect(html).toContain('data-media-format="webm"');
    expect(html).toContain('data-media-codecs="vp9,opus"');
    expect(html).toContain('data-media-duration="1"');
  });

  it("reports the container and codecs the header actually named", () => {
    const html = render(ready);
    expect(html).toContain("WebM (VP9, Opus)");
    expect(html).toContain("WebKitGTK");
  });

  it("renders an audio container as an audio element", () => {
    const html = render({
      kind: "ready",
      format: "mp3",
      codecs: ["mp3"],
      durationSeconds: 1,
    });
    expect(html).toContain("<audio");
    expect(html).not.toContain("<video");
  });

  it("keeps a loaded element mounted but hidden without resuming it", () => {
    const html = render(ready, { visible: false });
    expect(html).toContain("<video");
    expect(html).toContain("Paused while this tab is not on screen");
    expect(html).not.toContain("autoplay");
    expect(html).toContain("data-media-paused-by-visibility");
  });

  it("does not mount an element before the header probe returns", () => {
    const html = render({ kind: "probing" });
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<audio");
    expect(html).toContain("Reading the media header");
    expect(html).toContain('data-media-state="probing"');
  });

  it("explains an unsupported container and offers the external fallback", () => {
    const html = render({
      kind: "unsupported-format",
      reason: "This build has not verified Matroska playback.",
      alternatives: ["open-externally"],
    });
    expect(html).not.toContain("<video");
    expect(html).toContain("Media format not supported");
    expect(html).toContain("Open externally");
  });

  it("explains corrupt and mismatched containers instead of a blank payer", () => {
    const corrupt = render({
      kind: "corrupt",
      reason: "This WebM header is incomplete.",
      alternatives: ["open-externally"],
      retryable: true,
    });
    expect(corrupt).toContain("Media could not be read");
    expect(corrupt).toContain("Retry");

    const mismatch = render({
      kind: "mismatch",
      reason: "The file contains WebM data but its name routes it as MP4.",
      alternatives: ["open-externally"],
    });
    expect(mismatch).toContain("Container does not match its name");
    expect(mismatch).toContain("Open externally");
  });

  it("shows the element's real decode error with the measured container", () => {
    const html = render({
      kind: "load-error",
      format: "mp4",
      codecs: ["zzzz", "mp4a"],
      code: 4,
      reason: "MP4 (ZZZZ, AAC) is not available in this build.",
      alternatives: ["open-externally"],
      retryable: false,
    });
    expect(html).toContain("Media codec not supported");
    expect(html).toContain("MP4 (ZZZZ, AAC)");
    expect(html).not.toContain("<video");
  });

  it("lets the person stop other playback when the policy refuses", () => {
    const html = render({
      kind: "blocked",
      format: "webm",
      codecs: ["vp9"],
      durationSeconds: 1,
      reason: "3 media elements are already playing in other tabs.",
      alternatives: ["stop-other-playback"],
      blocking: ["a1", "b1", "c1"],
    });
    expect(html).toContain("Playback limit reached");
    expect(html).toContain("Stop other playback");
    expect(html).toContain("already playing");
  });
});

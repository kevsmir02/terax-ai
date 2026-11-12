import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PreviewPane, PreviewReloadNotice } from "./PreviewPane";

const url = "http://127.0.0.1:5173/";

function render(
  props: Partial<Parameters<typeof PreviewPane>[0]> & {
    visible?: boolean;
  } = {},
) {
  const { visible = true, ...rest } = props;
  return renderToString(
    createElement(PreviewPane, {
      url,
      visible,
      spaceActive: true,
      windowVisible: true,
      onUrlChange: () => {},
      ...rest,
    }),
  );
}

const frame = (html: string) => html.includes("<iframe");

describe("PreviewPane frame lifecycle", () => {
  it("keeps the deliberately entered preview loaded while it is on screen", () => {
    expect(frame(render())).toBe(true);
  });

  it("unloads the frame in the same render when its tab is no longer active", () => {
    expect(frame(render({ visible: false }))).toBe(false);
  });

  it("unloads the frame in the same render when its Space is no longer active", () => {
    expect(frame(render({ spaceActive: false }))).toBe(false);
  });

  it("unloads the frame in the same render when a supported signal says the window is hidden", () => {
    expect(frame(render({ windowVisible: false }))).toBe(false);
  });

  it("keeps a still-visible window's frame loaded through focus loss", () => {
    // No focus input exists here on purpose: a visible window showing the preview must not
    // reload just because another window has the keyboard.
    expect(frame(render({ windowVisible: true }))).toBe(true);
  });

  it("keeps the URL restrictions before and after unload", () => {
    const html = render({
      url: "tauri://localhost/index.html",
      visible: false,
    });
    expect(frame(html)).toBe(false);
    expect(html).toContain("This URL cannot be loaded in preview.");
  });
});

describe("PreviewReloadNotice", () => {
  it("explains the reload and the lost page state where the frame re-mounts", () => {
    const html = renderToString(
      createElement(PreviewReloadNotice, {
        reason: "tab-inactive",
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain("Preview reloaded");
    expect(html).toContain("another tab");
    expect(html.toLowerCase()).toContain("state are lost");
    expect(html).toContain("dev server keeps running");
  });

  it("records the Linux limit instead of promising occlusion detection", () => {
    const html = renderToString(
      createElement(PreviewReloadNotice, {
        reason: "window-hidden",
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain("Linux");
    expect(html).toContain("may keep running");
  });

  it("can be dismissed", () => {
    const html = renderToString(
      createElement(PreviewReloadNotice, {
        reason: "space-inactive",
        onDismiss: vi.fn(),
      }),
    );
    expect(html).toContain('aria-label="Dismiss preview reload notice"');
  });
});

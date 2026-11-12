import type { PreviewTab } from "@/modules/tabs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreviewStack } from "./PreviewStack";

function tab(
  id: number,
  spaceId: string,
  url = `http://127.0.0.1:5173/${id}`,
): PreviewTab {
  return { id, kind: "preview", title: `preview ${id}`, url, spaceId };
}

function render(tabs: PreviewTab[], activeId: number, activeSpaceId: string) {
  return renderToString(
    createElement(PreviewStack, {
      tabs,
      activeId,
      activeSpaceId,
      onUrlChange: () => {},
      registerHandle: () => {},
    }),
  );
}

const frames = (html: string) => html.split("<iframe").length - 1;

describe("PreviewStack Space and tab lifetimes", () => {
  it("mounts only the frame of the active tab in the active Space", () => {
    const html = render([tab(1, "a"), tab(2, "a"), tab(3, "b")], 1, "a");
    expect(frames(html)).toBe(1);
    // Tab 2 is in the active Space but inactive; tab 3's Space is gone.
    expect(html).toContain('data-preview-unloaded="tab-inactive"');
    expect(html).toContain('data-preview-unloaded="space-inactive"');
  });

  it("unloads every frame of a Space that is no longer active", () => {
    const html = render([tab(1, "a"), tab(2, "b")], 1, "b");
    expect(frames(html)).toBe(0);
    expect(html).toContain('data-preview-unloaded="space-inactive"');
  });

  it("keeps frames of every Space that has no preview out of the DOM entirely", () => {
    expect(render([tab(1, "a")], 1, "a")).not.toContain(
      "data-preview-unloaded",
    );
  });
});

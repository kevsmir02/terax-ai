import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "@/modules/tabs";
import { MarkdownStack } from "./MarkdownStack";

const seen = vi.hoisted(() => ({
  roots: [] as Array<{ path: string; projectRoot: string | null }>,
}));

vi.mock("./MarkdownPreviewPane", () => ({
  MarkdownPreviewPane: (props: {
    path: string;
    projectRoot: string | null;
  }) => {
    seen.roots.push({ path: props.path, projectRoot: props.projectRoot });
    return createElement("div", { "data-preview": props.path });
  },
}));

function terminal(id: number, cwd: string, spaceId: string): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    cwd,
    paneTree: { kind: "leaf", leafId: id + 100 },
    activeLeafId: id + 100,
  } as unknown as Tab;
}

function markdown(id: number, path: string, spaceId: string): Tab {
  return { id, kind: "markdown", spaceId, title: "readme", path };
}

function render(
  tabs: Tab[],
  activeId: number,
  spaceRoots: Record<string, string | null>,
) {
  seen.roots.length = 0;
  renderToStaticMarkup(
    createElement(MarkdownStack, {
      tabs,
      activeId,
      spaceRoots,
      onSetMarkdownView: () => {},
    }),
  );
  return seen.roots;
}

describe("MarkdownStack asset boundary", () => {
  it("uses the configured Space root, not the terminal cwd", () => {
    const roots = render(
      [
        terminal(1, "/tmp/moved-elsewhere", "s1"),
        markdown(2, "/proj/docs/readme.md", "s1"),
      ],
      1,
      { s1: "/proj" },
    );
    expect(roots).toEqual([
      { path: "/proj/docs/readme.md", projectRoot: "/proj" },
    ]);
  });

  it("does not change access when the terminal cwd changes", () => {
    const tabs = () => [
      terminal(1, "/tmp/one", "s1"),
      markdown(2, "/proj/docs/readme.md", "s1"),
    ];
    expect(render(tabs(), 1, { s1: "/proj" })[0]?.projectRoot).toBe("/proj");
    const moved = [
      terminal(1, "/var/another/place", "s1"),
      markdown(2, "/proj/docs/readme.md", "s1"),
    ];
    expect(render(moved, 1, { s1: "/proj" })[0]?.projectRoot).toBe("/proj");
  });

  it("resolves each document against its own Space root", () => {
    const roots = render(
      [
        terminal(1, "/shared", "s1"),
        markdown(2, "/a/docs/a.md", "s1"),
        markdown(3, "/b/docs/b.md", "s2"),
      ],
      2,
      { s1: "/a", s2: "/b" },
    );
    expect(roots).toEqual([
      { path: "/a/docs/a.md", projectRoot: "/a" },
      { path: "/b/docs/b.md", projectRoot: "/b" },
    ]);
  });

  it("leaves an unconfigured Space to anchor on the document itself", () => {
    const roots = render([markdown(2, "/outside/docs/readme.md", "s3")], 2, {
      s3: null,
    });
    expect(roots).toEqual([
      { path: "/outside/docs/readme.md", projectRoot: null },
    ]);
  });

  it("does not mount a cold restored markdown tab", () => {
    const roots = render(
      [{ ...markdown(2, "/proj/a.md", "s1"), cold: true } as Tab],
      2,
      { s1: "/proj" },
    );
    expect(roots).toEqual([]);
  });
});

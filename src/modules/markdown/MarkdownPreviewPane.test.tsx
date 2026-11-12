import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: { kind: "loading" } as Record<string, unknown>,
  openAnyway: () => {},
  grantPaths: [] as Array<Array<string | null>>,
}));

vi.mock("@/modules/markdown/useMarkdownDocument", () => ({
  useMarkdownDocument: () => ({
    status: state.status,
    openAnyway: state.openAnyway,
  }),
}));

vi.mock("@/lib/useAssetGrant", () => ({
  useAssetGrants: (paths: Array<string | null>) => {
    state.grantPaths.push(paths);
    return { urlFor: () => undefined, error: undefined, retry: () => {} };
  },
}));

const { MarkdownPreviewPane } = await import("./MarkdownPreviewPane");

function renderPane(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(MarkdownPreviewPane, {
      path: "/proj/docs/readme.md",
      tabId: 3,
      projectRoot: "/proj",
      visible: true,
      onSetView: () => {},
      ...overrides,
    }),
  );
}

beforeEach(() => {
  state.grantPaths.length = 0;
  state.status = { kind: "loading" };
});

describe("MarkdownPreviewPane", () => {
  it("renders the document once it is read", () => {
    state.status = {
      kind: "ready",
      content: "# Title\n\nBody text.",
      size: 20,
    };
    const html = renderPane();
    expect(html).toContain("Title");
    expect(html).toContain("Body text.");
    expect(html).not.toContain("Loading");
  });

  it("shows a loading state before the first read lands", () => {
    expect(renderPane()).toContain("Loading");
  });

  it("explains a failed read instead of rendering stale text", () => {
    state.status = { kind: "error", message: "permission denied" };
    expect(renderPane()).toContain("Failed to read file: permission denied");
  });

  it("explains binary and oversized documents", () => {
    state.status = { kind: "binary", size: 4 };
    expect(renderPane()).toContain("Binary file");

    state.status = {
      kind: "toolarge",
      size: 20_000_000,
      limit: 10_485_760,
      forced: false,
    };
    const html = renderPane();
    expect(html).toContain("19.1 MiB");
    expect(html).toContain("Open anyway");
  });

  it("does not offer an override above the approved 50 MiB ceiling", () => {
    state.status = {
      kind: "toolarge",
      size: 60_000_000,
      limit: 10_485_760,
      forced: false,
    };
    const html = renderPane();
    expect(html).toContain("Open it externally");
    expect(html).not.toContain("Open anyway");
  });

  it("asks for the asset grant only when there is a document to draw", () => {
    state.status = { kind: "binary", size: 4 };
    renderPane();
    expect(state.grantPaths).toEqual([[]]);

    state.grantPaths.length = 0;
    state.status = { kind: "ready", content: "![a](./a.png)", size: 20 };
    renderPane();
    expect(state.grantPaths).toEqual([["/proj"]]);
  });

  it("anchors an outside document to its own folder", () => {
    state.status = { kind: "ready", content: "![a](./a.png)", size: 20 };
    renderPane({ path: "/elsewhere/notes/readme.md", projectRoot: "/proj" });
    expect(state.grantPaths).toEqual([["/elsewhere/notes"]]);
  });

  it("never includes a terminal cwd in the document boundary", () => {
    state.status = { kind: "ready", content: "![a](./a.png)", size: 20 };
    renderPane({
      path: "/space/project/docs/readme.md",
      projectRoot: "/space/project",
    });
    expect(state.grantPaths[0]).toEqual(["/space/project"]);
  });

  it("asks for consent before loading remote or outside assets", () => {
    state.status = {
      kind: "ready",
      content:
        "![remote](https://tracker.example/pixel.png)\n![outside](../../../elsewhere/pic.png)",
      size: 200,
    };
    const html = renderPane();
    expect(html).toContain("Load 1 remote image");
    expect(html).toContain("Allow 1 image");
    // Only the boundary is granted before the person chooses.
    expect(state.grantPaths[0]).toEqual(["/proj"]);
    // Nothing remote is embedded.
    expect(html).not.toContain("https://tracker.example");
  });

  it("disables code syntax above the approved 4 MiB ceiling", () => {
    const code = "```ts\nconst answer = 1;\n```";
    state.status = { kind: "ready", content: code, size: 3 * 1024 * 1024 };
    expect(renderPane()).toContain('data-syntax="on"');

    state.status = { kind: "ready", content: code, size: 4 * 1024 * 1024 + 1 };
    expect(renderPane()).toContain('data-syntax="off"');
  });

  it("does not keep loading a hidden document's assets", () => {
    state.status = { kind: "loading" };
    renderPane({ visible: false });
    expect(state.grantPaths).toEqual([[]]);
  });
});

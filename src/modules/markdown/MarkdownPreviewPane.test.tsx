import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: { kind: "loading" } as Record<string, unknown>,
  grantPaths: [] as Array<string | null>,
}));

vi.mock("@/modules/markdown/useMarkdownDocument", () => ({
  useMarkdownDocument: () => state.status,
}));

vi.mock("@/lib/useAssetGrant", () => ({
  useAssetGrant: (path: string | null) => {
    state.grantPaths.push(path);
    return { urlFor: () => undefined, error: undefined, retry: () => {} };
  },
}));

const { MarkdownPreviewPane } = await import("./MarkdownPreviewPane");

function renderPane() {
  return renderToStaticMarkup(
    createElement(MarkdownPreviewPane, {
      path: "/proj/docs/readme.md",
      tabId: 3,
      workspaceRoot: "/proj",
      visible: true,
      onSetView: () => {},
    }),
  );
}

beforeEach(() => {
  state.grantPaths.length = 0;
});

describe("MarkdownPreviewPane", () => {
  it("renders the document once it is read", () => {
    state.status = { kind: "ready", content: "# Title\n\nBody text." };
    const html = renderPane();
    expect(html).toContain("Title");
    expect(html).toContain("Body text.");
    expect(html).not.toContain("Loading");
  });

  it("shows a loading state before the first read lands", () => {
    state.status = { kind: "loading" };
    expect(renderPane()).toContain("Loading");
  });

  it("explains a failed read instead of rendering stale text", () => {
    state.status = { kind: "error", message: "permission denied" };
    expect(renderPane()).toContain("Failed to read file: permission denied");
  });

  it("explains binary and oversized documents", () => {
    state.status = { kind: "binary" };
    expect(renderPane()).toContain("Binary file");

    state.status = { kind: "toolarge", size: 20_000_000, limit: 10_485_760 };
    expect(renderPane()).toContain("20000000 bytes");
    expect(renderPane()).toContain("10485760");
  });

  it("asks for the asset grant only when there is a document to draw", () => {
    state.status = { kind: "binary" };
    renderPane();
    expect(state.grantPaths).toEqual([null]);

    state.grantPaths.length = 0;
    state.status = { kind: "ready", content: "![a](./a.png)" };
    renderPane();
    expect(state.grantPaths).toEqual(["/proj"]);
  });
});

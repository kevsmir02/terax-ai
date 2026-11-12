import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

const ASSET_PREFIX = "asset://localhost";

function render(
  markdown: string,
  overrides: Partial<Parameters<typeof MarkdownContent>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(MarkdownContent, {
      path: "/proj/docs/readme.md",
      boundary: "/proj",
      content: markdown,
      assetUrlFor: (absolutePath) => `${ASSET_PREFIX}${absolutePath}?token=t`,
      ...overrides,
    }),
  );
}

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1] ?? "");
}

describe("MarkdownContent", () => {
  it("does not run streaming markdown repair on a complete document", () => {
    const html = render("**unterminated");
    expect(html).toContain("**unterminated");
    expect(html).not.toContain("<strong>");
  });

  it("keeps document content unable to execute or run script", () => {
    const html = render(
      [
        "<script>window.pwned = 1</script>",
        "",
        '<img src="x" onerror="alert(1)">',
        "",
        "[click](javascript:alert(1))",
        "",
        '<a href="https://example.com" onclick="alert(1)">ok</a>',
      ].join("\n"),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
  });

  it("loads only images the asset policy allows", () => {
    const html = render(
      [
        "![allowed](./diagram.png)",
        "![outside](../../outside.png)",
        "![secret](./credentials.png)",
        "![protected](./.ssh/logo.png)",
        "![not-an-image](./notes.txt)",
      ].join("\n\n"),
    );

    const sources = imageSources(html);
    expect(sources).toHaveLength(5);
    expect(sources[0]).toBe(`${ASSET_PREFIX}/proj/docs/diagram.png?token=t`);
    expect(
      sources.slice(1).filter((src) => src.startsWith(ASSET_PREFIX)),
    ).toEqual([]);
  });

  it("drops an asset URL written into the document", () => {
    const html = render("![injected](asset://localhost/etc/passwd.png)");
    expect(html).not.toContain(`${ASSET_PREFIX}`);
    expect(imageSources(html)).toEqual([]);
  });

  it("renders fenced code through the retained code block", () => {
    const html = render("```ts\nconst answer = 1;\n```");
    expect(html).toContain("const answer = 1;");
    expect(html).toContain(">ts<");
    expect(html).toContain('aria-label="Copy code"');
  });

  it("offers a shell block the run-in-terminal action", () => {
    const html = render("```bash\npnpm test\n```");
    expect(html).toContain("pnpm test");
    expect(html).toContain('aria-label="Run in active terminal"');
  });

  it("reports a failed image grant instead of hiding it", () => {
    const html = render("![allowed](./diagram.png)", {
      assetUrlFor: () => undefined,
      assetError: "grant refused",
      onRetryImages: () => {},
    });
    expect(html).toContain("Local images unavailable: grant refused");
    expect(html).toContain("Retry images");
  });
});

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

// A rendered image is managed by the bounded inline-image surface: the
// source is bound, but no <img> exists until the header probe and the decoded
// viewer admission have both said yes.
function imageSources(html: string): string[] {
  return [...html.matchAll(/data-markdown-image-src="([^"]*)"/g)].map(
    (m) => m[1] ?? "",
  );
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
    expect(sources.filter((src) => src.startsWith(ASSET_PREFIX))).toEqual([
      `${ASSET_PREFIX}/proj/docs/diagram.png?token=t`,
    ]);
    expect(html).toContain("outside the project folder blocked");
    expect(html).toContain("protected image blocked");
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

  it("does not fetch a remote image until the person consents", () => {
    const blocked = render("![remote](https://tracker.example/pixel.png)");
    expect(imageSources(blocked)).toEqual([]);
    expect(blocked).toContain("remote image blocked");

    const allowed = render("![remote](https://tracker.example/pixel.png)", {
      allowRemote: true,
    });
    expect(imageSources(allowed)).toEqual([
      "https://tracker.example/pixel.png",
    ]);
  });

  it("loads an outside image only with an explicit grant", () => {
    const blocked = render("![outside](../../elsewhere/pic.png)");
    expect(imageSources(blocked)).toEqual([]);
    expect(blocked).toContain("outside the project folder blocked");

    const allowed = render("![outside](../../elsewhere/pic.png)", {
      grantedAssets: new Set(["/elsewhere/pic.png"]),
    });
    expect(imageSources(allowed)).toEqual([
      `${ASSET_PREFIX}/elsewhere/pic.png?token=t`,
    ]);
  });

  it("keeps protected images blocked even when a grant is offered", () => {
    const html = render("![secret](./.env.png)", {
      grantedAssets: new Set(["/proj/docs/.env.png"]),
    });
    expect(imageSources(html)).toEqual([]);
    expect(html).toContain("protected image blocked");
  });

  it("turns code highlighting off above the approved syntax ceiling", () => {
    expect(render("```ts\nconst a = 1;\n```")).toContain('data-syntax="on"');
    expect(render("```ts\nconst a = 1;\n```", { syntax: false })).toContain(
      'data-syntax="off"',
    );
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

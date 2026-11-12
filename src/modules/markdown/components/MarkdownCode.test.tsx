import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownCode, markdownCodeText } from "./MarkdownCode";

describe("markdownCodeText", () => {
  it("preserves text nested inside React children for HTML-wrapped code blocks", async () => {
    const React = await import("react");

    const text = markdownCodeText([
      "\n",
      React.createElement(
        "span",
        { key: "a" },
        'const client = createClient("");',
      ),
      "\n",
      React.createElement(
        "span",
        { key: "b" },
        'await client.send({ id: "example" });',
      ),
      "\n",
    ]);

    expect(text).toBe(
      '\nconst client = createClient("");\nawait client.send({ id: "example" });\n',
    );
  });
});

describe("MarkdownCode", () => {
  it("keeps inline code a plain pill", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownCode, null, "pnpm test"),
    );
    expect(html).toContain("<code");
    expect(html).toContain("pnpm test");
    expect(html).not.toContain('aria-label="Copy code"');
  });

  it("sends a fenced block to the shared code block without a trailing newline", () => {
    const html = renderToStaticMarkup(
      createElement(
        MarkdownCode,
        { className: "language-ts" },
        "const answer = 1;\n",
      ),
    );
    expect(html).toContain("const answer = 1;");
    expect(html).toContain(">ts<");
    expect(html).toContain('aria-label="Copy code"');
  });
});

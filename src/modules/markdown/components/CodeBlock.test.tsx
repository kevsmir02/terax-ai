import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock, CodeStreamingProvider } from "./CodeBlock";

function renderBlock(code: string, lang: string | null, streaming = false) {
  const block = createElement(CodeBlock, { code, lang });
  return renderToStaticMarkup(
    streaming
      ? createElement(CodeStreamingProvider, { value: true }, block)
      : block,
  );
}

describe("CodeBlock", () => {
  it("renders a fenced snippet with its language label and a copy action", () => {
    const html = renderBlock("const answer = 1;", "ts");
    expect(html).toContain("const answer = 1;");
    expect(html).toContain(">ts<");
    expect(html).toContain('aria-label="Copy code"');
  });

  it("keeps code plain while the snippet is still streaming", () => {
    const html = renderBlock("const answer = 1;", "ts", true);
    expect(html).toContain("Generating ts…");
    expect(html).not.toContain("const answer = 1;");
    expect(html).not.toContain('aria-label="Copy code"');
  });

  it("offers shell snippets a run action under the shell prompt", () => {
    const html = renderBlock("pnpm test\npnpm lint", "bash");
    expect(html).toContain(">bash<");
    expect(html).toContain('aria-label="Run in active terminal"');
    expect(html).toContain("pnpm test");
    expect(html).toContain("pnpm lint");
  });

  it.each(["sh", "zsh", "console"])("treats %s as a shell snippet", (lang) => {
    expect(renderBlock("ls", lang)).toContain(
      'aria-label="Run in active terminal"',
    );
  });

  it("falls back to plain text for a language without a parser", () => {
    const html = renderBlock("no highlighting here", "text");
    expect(html).toContain("no highlighting here");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).not.toContain('aria-label="Run in active terminal"');
  });
});

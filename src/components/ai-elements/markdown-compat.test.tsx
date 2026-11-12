import { TextShimmer } from "@/components/text-shimmer";
import {
  CodeBlock,
  CodeStreamingProvider,
} from "@/modules/markdown/components/CodeBlock";
import { MarkdownCode as NeutralMarkdownCode } from "@/modules/markdown/components/MarkdownCode";
import { highlight as neutralHighlight } from "@/modules/markdown/lib/codeHighlight";
import { describe, expect, it } from "vitest";
import { highlight } from "./chat-code-lezer";
import { ChatCodeBlock, ChatStreamingProvider } from "./chat-code";
import { MarkdownCode } from "./markdown-code";
import { Shimmer } from "./shimmer";

// The Markdown renderer moved out of the AI-owned elements; these entry points
// stay as aliases so unmigrated agent components render exactly the same
// components until they are deleted with the AI feature.
describe("legacy AI element entry points", () => {
  it("aliases the shared code block and its streaming context", () => {
    expect(ChatCodeBlock).toBe(CodeBlock);
    expect(ChatStreamingProvider).toBe(CodeStreamingProvider);
  });

  it("aliases the shared markdown code renderer", () => {
    expect(MarkdownCode).toBe(NeutralMarkdownCode);
  });

  it("aliases the shared highlighter", () => {
    expect(highlight).toBe(neutralHighlight);
  });

  it("aliases the shared text shimmer", () => {
    expect(Shimmer).toBe(TextShimmer);
  });
});

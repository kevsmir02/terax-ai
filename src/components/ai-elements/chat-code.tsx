/**
 * Legacy AI-owned entry point for fenced-code rendering.
 *
 * The renderer now lives in the retained Markdown module
 * (`@/modules/markdown/components/CodeBlock`) because the Markdown preview
 * needs it whether or not the built-in AI feature exists. These aliases keep
 * unmigrated AI components compiling.
 *
 * Remaining importers:
 *  - `components/ai-elements/message.tsx` (`ChatStreamingProvider`)
 * `ChatCodeBlock`/`ChatCodeBlockProps` have no in-tree importer left (assistant
 * text reaches the shared block through `MarkdownCode`) but stay exported so
 * an out-of-tree agent surface does not break. Removing the AI feature may
 * delete this file once `message.tsx` stops importing it; the neutral module
 * stays.
 */

export {
  CodeBlock as ChatCodeBlock,
  type CodeBlockProps as ChatCodeBlockProps,
  CodeStreamingProvider as ChatStreamingProvider,
} from "@/modules/markdown/components/CodeBlock";

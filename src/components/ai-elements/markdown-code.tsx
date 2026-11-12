/**
 * Legacy AI-owned entry point for the Markdown `code` component override.
 *
 * The renderer now lives in the retained Markdown module
 * (`@/modules/markdown/components/MarkdownCode`). This re-export keeps
 * unmigrated AI components compiling.
 *
 * Remaining importers:
 *  - `modules/ai/components/AiChat.tsx` (`MarkdownCode`)
 *  - `components/ai-elements/message.tsx` (`MarkdownCode`, assistant text)
 * `modules/markdown/MarkdownContent.tsx` imports the neutral module directly.
 */

export {
  MarkdownCode,
  markdownCodeText,
} from "@/modules/markdown/components/MarkdownCode";

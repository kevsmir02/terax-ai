/**
 * Legacy AI-owned entry point for fenced-code highlighting.
 *
 * The highlighter now lives in the retained Markdown module
 * (`@/modules/markdown/lib/codeHighlight`), which is the only owner of the
 * `classHighlighter` pipeline that rendered Markdown and code blocks need.
 *
 * Remaining importers: none. Keep this re-export until the AI components are
 * gone so an unmigrated import path does not break; the neutral module is the
 * one that must survive.
 */

export {
  highlight,
  type HighlightedNode,
  isHighlightable,
} from "@/modules/markdown/lib/codeHighlight";

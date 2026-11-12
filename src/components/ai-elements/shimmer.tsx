/**
 * Legacy AI-owned entry point for the text shimmer.
 *
 * The component now lives in `@/components/text-shimmer` because rendered
 * Markdown uses it for a still-streaming fenced block.
 *
 * Remaining importers: `components/ai-elements/reasoning.tsx` (`Shimmer`).
 * AI-owned; the neutral component is the one that must survive.
 */

export {
  TextShimmer as Shimmer,
  type TextShimmerProps as TextShimmerProps,
} from "@/components/text-shimmer";

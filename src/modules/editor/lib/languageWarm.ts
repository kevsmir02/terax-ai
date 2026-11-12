/**
 * Whether the editor may warm a language chunk for a document.
 *
 * Resolving a language is not free: `resolveLanguage` dynamically imports that
 * language's CodeMirror chunk. The approved text ceilings in
 * `@/modules/preview/lib/limits` say syntax features stay off above the 4 MiB
 * syntax ceiling, and a document the native reader refused has no text to
 * parse — in both cases importing a chunk would spend the resources the
 * ceiling exists to protect, and then throw the result away.
 *
 * The decision lives here rather than inside `EditorPane`'s effect so it is
 * testable without mounting CodeMirror, and so the ceiling keeps exactly one
 * owner (`limits.ts`).
 */
import { TEXT_SYNTAX_LIMIT_BYTES } from "@/modules/preview/lib/limits";
import type { LanguageResult } from "./languageResolver";
import type { DocumentState } from "./useDocument";

export type LanguageWarmInput = {
  /** The file the buffer shows; used as-is for an explicit override. */
  path: string;
  overrideLanguage?: string | null;
  doc: DocumentState;
};

export type LanguageWarmDecision =
  | { warm: true; path: string }
  | {
      warm: false;
      reason: "still-reading" | "refused" | "over-syntax-limit";
    };

/** What to warm for this document, without importing anything. */
export function planLanguageWarm(
  input: LanguageWarmInput,
): LanguageWarmDecision {
  const { doc } = input;
  if (doc.status === "loading") {
    // The size is not known yet: a file past the read ceiling may turn out to
    // be exactly the one whose chunk must never be imported.
    return { warm: false, reason: "still-reading" };
  }
  if (doc.status !== "ready") {
    // binary, too-large and failed reads all leave no text to parse.
    return { warm: false, reason: "refused" };
  }
  if (doc.size > TEXT_SYNTAX_LIMIT_BYTES) {
    return { warm: false, reason: "over-syntax-limit" };
  }
  return {
    warm: true,
    path: input.overrideLanguage
      ? `dummy.${input.overrideLanguage}`
      : input.path,
  };
}

/**
 * Warms the language chunk for a document that may have one.
 *
 * Returns `null` when the document must not import a chunk, so the caller has
 * nothing to await. A failed import resolves to `null` too: warming is an
 * optimisation and never an error the user has to see.
 */
export function warmLanguage(
  resolve: (filename: string) => Promise<LanguageResult | null>,
  input: LanguageWarmInput,
): Promise<LanguageResult | null> | null {
  const decision = planLanguageWarm(input);
  if (!decision.warm) return null;
  return resolve(decision.path).catch(() => null);
}

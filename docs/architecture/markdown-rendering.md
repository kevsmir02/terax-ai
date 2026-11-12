# Rendered Markdown ownership

Rendered Markdown, fenced-code rendering and the local-image access helpers are
retained workspace features. The built-in AI feature used to own part of them
because chat messages also render Markdown; this guide records where each piece
lives now, which compatibility entry points remain, and what may be removed
when the AI feature is deleted.

`TERAX.md` is the source of truth for the surrounding architecture.

## Retained owners

| path | owns |
| --- | --- |
| `src/modules/markdown/MarkdownStack.tsx` (`MarkdownStackLazy`) | the `markdown` tab kind: one preview per tab, lazy-loaded |
| `src/modules/markdown/MarkdownPreviewPane.tsx` | document read/watch loop (`useMarkdownDocument`), scroll restoration, loading/error/binary/oversized states, the rendered/raw toggle, the asset grant |
| `src/modules/markdown/MarkdownContent.tsx` | the rendered surface: Streamdown in `mode="static"` with `parseIncompleteMarkdown={false}`, `raw` + `sanitize` + local-image rewrite + `harden` rehype plugins |
| `src/modules/markdown/components/MarkdownCode.tsx` | Streamdown `components.code` override: inline pill vs fenced block |
| `src/modules/markdown/components/CodeBlock.tsx` | fenced code: language label, highlighting, copy, run-in-terminal, still-streaming placeholder |
| `src/modules/markdown/lib/codeHighlight.ts` | Lezer tokenization of fenced code (`classHighlighter`, `tok-*` classes) |
| `src/modules/markdown/lib/assetPath.ts` | relative image resolution, preview boundary, per-image policy decision, rehype rewrite |
| `src/modules/markdown/lib/liveReload.ts` | `fs:changed` coalescing for the open document |
| `src/components/text-shimmer.tsx` | the shimmer used by a fenced block that is still streaming |
| `src/modules/workspace/policy.ts` | the secret/protected path policy the image boundary calls |

Attribution seam: `streamdown` stays a dependency. Rendered Markdown needs the
parser, the sanitiser/harden plugins and the static mode; nothing about the
renderer is AI-specific.

## Run in active terminal

`CodeBlock` renders a run action for shell snippets. The renderer does not know
which tab is active, so `src/modules/markdown/lib/codeBlockRunner.ts` holds the
published action and `App.tsx` registers it (the same write-to-active-PTY path
the terminal history panel uses). With no terminal tab active, the action
refuses and the button stays idle.

## Local image access

An image is loaded only when all of these hold (`isAllowedLocalImage`):

1. the extension is an image type,
2. the resolved absolute path stays inside `previewBoundary` (the workspace root
   when the document is inside it, else the document's own folder),
3. `checkReadable` accepts the path (secret basenames and protected directories).

An allowed image is rewritten to an `asset://` URL carrying the grant token
(`useAssetGrant`). A refused one keeps a non-loadable path, and an `asset://`
URL written into the document is dropped. Symlink resolution and canonical
containment happen natively in `src-tauri/src/modules/fs/assets.rs`.

Known follow-ups owned by other tickets, do not fix them here:

- the boundary root is the mutable terminal cwd, not the Space project root
  (spec: Preview access boundaries),
- preview consent/lifecycle policy and unload/close behaviour (preview tickets).

## Compatibility entry points (AI-owned, aliases only)

These files no longer own anything; they re-export the retained owners so
unmigrated agent components compile. Delete them only after the listed
consumers are gone.

| file | re-exports | remaining consumers |
| --- | --- | --- |
| `src/components/ai-elements/markdown-code.tsx` | `MarkdownCode`, `markdownCodeText` | `modules/ai/components/AiChat.tsx`, `components/ai-elements/message.tsx` |
| `src/components/ai-elements/chat-code.tsx` | `CodeBlock as ChatCodeBlock`, `CodeStreamingProvider as ChatStreamingProvider` | `components/ai-elements/message.tsx` (`ChatStreamingProvider`; the `ChatCodeBlock` alias has no in-tree importer) |
| `src/components/ai-elements/chat-code-lezer.ts` | `highlight`, `isHighlightable`, `HighlightedNode` | none (kept for unmigrated imports) |
| `src/components/ai-elements/shimmer.tsx` | `TextShimmer as Shimmer` | `components/ai-elements/reasoning.tsx` |

`src/components/ai-elements/markdown-compat.test.tsx` locks those aliases to the
retained components, and `src/modules/markdown/ownership.test.ts` fails if the
retained Markdown module ever imports the AI feature again or if a consumer
appears that is not listed above.

## What must not be deleted with the AI feature

`streamdown`, `src/modules/markdown/**`, `src/components/text-shimmer.tsx`,
`src/modules/workspace/policy.ts` and the native asset pipeline
(`fs/assets.rs`, `fs/access_policy.rs`) all serve the Markdown preview. Their
AI-sounding names or their history in `components/ai-elements/` are not
ownership.

## Checks

- `src/modules/markdown/MarkdownContent.test.tsx` - sanitisation, static mode,
  local-image allow/deny, fenced-code rendering through the retained block.
- `src/modules/markdown/MarkdownPreviewPane.test.tsx` - document states and that
  no asset grant is requested without a document to draw.
- `src/modules/markdown/components/*.test.tsx` - inline vs fenced code, shell
  blocks, streaming placeholder.
- `src/modules/markdown/lib/codeHighlight.test.ts` - token classes, text
  preservation, and that every emitted `tok-*` class is painted by
  `src/styles/code-highlight.css`.
- `src/modules/markdown/lib/assetPath.test.ts` - boundary/policy outcomes.
- `src/modules/markdown/lib/codeBlockRunner.test.ts` - the run-in-terminal seam
  reports refusal instead of success when no terminal is published.
- `src/modules/markdown/ownership.test.ts` - the retained renderer never imports
  the AI feature, every consumer of an old entry point is accounted for, the
  markdown tab kind stays behind its dynamic import, and Streamdown is still
  reachable from rendered Markdown.
- `src/app/eager-budget.test.ts` and `src/app/dist-budget.test.ts` - rendered
  Markdown, `streamdown` and the language packs stay out of both windows'
  startup graphs, and one `@lezer/highlight` instance serves parsers and editor
  themes.

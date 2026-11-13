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
| `src/modules/markdown/components/MarkdownImage.tsx` | Streamdown `components.img` override: lazy header probe, the 64 MiB decoded decision and decoded-viewer admission for one inline image |
| `src/modules/markdown/lib/inlineImage.ts` | pure inline-image decision: deferred/probing/measuring/refused/admitting/ready, viewer id and what claims decoded bytes |
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

An image is loaded automatically only when all of these hold
(`classifyImageReference` → `rehypeLocalImages`):

1. the reference is a relative image,
2. the resolved absolute path stays inside `previewBoundary`: the configured
   **Space project root** when the document is inside it, otherwise the
   document's own folder (`MarkdownStack` receives `spaceRoots` from
   `App`/`WorkspaceSurface`). The mutable terminal cwd is not an input, so a
   `cd` cannot widen or narrow what a document may load,
3. `checkReadable` accepts the path (secret basenames and protected
   directories).

`previewBoundary` normalizes `.`/`..` before deciding where the document lives,
and `resolveRelativeAsset` does the same for the reference. An allowed image is
rewritten to an `asset://` URL carrying the grant token (`useAssetGrants`).
`MarkdownContent` keys the Streamdown surface on that policy (document,
boundary, consent, grant version) because Streamdown memoises on the Markdown
text alone; without the key a grant or consent choice would render once and then
stay blocked.
Symlink resolution and canonical containment remain native in
`src-tauri/src/modules/fs/assets.rs`; a symlink inside the root that points out
of it is refused at delivery.

A refused image is replaced by a visible `[reason: reference]` notice, never a
blank pane or broken icon. The document itself cannot turn that into a load:

- **Outside the boundary:** a notice names the count and the boundary, with an
  explicit "Allow N images outside" action. Pressing it grants exactly those
  files through the same tab scope; a protected (secret) path is never offered
  and cannot be granted.
- **Remote:** rendering fetches nothing. A "Load N remote images" action is the
  only path to a remote `src`; `tauri.conf.json`'s `img-src` includes `https:`
  and the counted acceptance fixture proves zero requests before the choice.
- **Inline `data:` images** are kept because they fetch nothing, and an
  `asset://` URL written into the document is dropped outright.

## Inline image budget

Bounding the transferred asset response does not bound the decoded pixels, so an
inline image obeys the same contract as the dedicated image surface:

1. a local image is probed with the existing native `fs_image_probe` once it
   intersects the viewport (and its tab is on screen),
2. `imageBudgetDecision` applies the approved 64 MiB decoded ceiling from the
   header dimensions *before* an `<img>` is mounted,
3. an admitted raster registers with `viewerAdmission`, so inline images count
   toward the four-viewer/192 MiB application-wide budget, and its slot is
   released when the document closes or is replaced.

A refused image renders its reason in the document and claims nothing. A remote
reference the person consented to load and an inline `data:` image have no path
for the header probe, so their element mounts lazily only to report its
intrinsic size; the same ceiling and admission then decide whether it stays.

A local image above the 10 MiB asset-delivery ceiling is refused by the native
handler with a 413 before any byte reaches the decoder, and an `<img>` cannot
read that response body: all the document sees is a load error. That is a limit
of ours, not a defect in the file, so a failed load of a local image measures
the file (`fs_stat`) and, above the delivery ceiling, renders a
`file-too-large` notice that names the file's size and the 10 MiB preview read
limit with the external-viewer alternative. Only a failure inside the ceiling
is reported as "may be corrupt or undecodable"; a remote or `data:` element
keeps its measured-at-load decode error because there is no size to measure.

The asset policy above is unchanged: the probe adds no grant and the admission
table grants no access, so an unprobed, remote or outside-root image still needs
the explicit choice. The probe canonicalizes an automatic local image against
the document boundary before reading its header, so a symlink that leaves the
root is refused without the outside target being read; an outside file the
person explicitly granted is probed under that consent instead.

## Links

`MarkdownLink` prevents the default for every href, so document content can
never navigate the application webview or run an application command. Only a
deliberate click on an `http(s)`/`mailto`/`tel` target goes to the native
opener. A relative, `file:` or custom-scheme link is inert
(`lib/linkAction.ts`).

## Limits, hidden work and close

- The native read keeps the approved 10 MiB ceiling. A larger document explains
  its size and offers the explicit "Open anyway" override up to 50 MiB; above
  4 MiB the document opens with fenced-code highlighting off
  (`textReadDecision`, `data-syntax="off"`).
- A hidden tab does not read and does not request an asset grant until it is
  first shown; while hidden it only marks itself stale. On show it reads once.
- Inline images below the viewport, on a hidden tab or in a closed document are
  not probed, not decoded and hold no admission slot. Closing or replacing the
  document releases the image slots and the tab-owned asset grant.
- `createDocumentLoad` discards a completion whose document closed or whose
  request is no longer the newest, so a slow read cannot resurrect content.
- Grants belong to the tab scope: closing the tab (or its Space) revokes them in
  `assetScopes` and natively, and an in-flight grant for a closed scope is
  revoked instead of installed.

Remaining follow-up owned by other tickets: PDF/image/media viewers (#28/#29/#31)
and the web-preview frame policy.

## Removed AI-owned entry points

The aliases under `src/components/ai-elements/` were deleted with the built-in
chat feature (ticket #12). `src/modules/markdown/ownership.test.ts` fails if the
retained Markdown module imports the removed AI feature again, or if any source
still imports one of the deleted alias paths.

## What must not be deleted with the AI feature

`streamdown`, `src/modules/markdown/**`, `src/components/text-shimmer.tsx`,
`src/modules/workspace/policy.ts` and the native asset pipeline
(`fs/assets.rs`, `fs/access_policy.rs`) all serve the Markdown preview. Their
AI-sounding names or their history in `components/ai-elements/` are not
ownership.

## Checks

- `src/modules/markdown/MarkdownContent.test.tsx` - sanitisation, static mode,
  local-image allow/deny, remote consent, explicit outside grants, syntax-off
  and fenced-code rendering through the retained block.
- `src/modules/markdown/MarkdownPreviewPane.test.tsx` - document states, the
  10/50 MiB override offer, boundary selection and that no asset grant is
  requested without a document to draw.
- `src/modules/markdown/MarkdownStack.test.tsx` - the boundary comes from the
  Space root (never a terminal cwd) and follows the document's own Space.
- `src/modules/markdown/lib/{assetPath,documentAssets,linkAction,documentLoad}.test.ts`
  - reference classification, remote/outside consent, inert links and stale
    load completions; `assetPath.test.ts` also pins the source tags the bounded
    inline-image surface needs.
- `src/modules/markdown/lib/inlineImage.test.ts` - an over-ceiling inline image
  is refused before mount and claims no decoded bytes, admission is registered
  and released, an off-screen image is never probed, and a remote/`data:` image
  is measured before the same decision.
- `src/modules/markdown/components/MarkdownImage.test.tsx` - the drawn states:
  no `<img>` while probing/refused/admission-blocked, the element only once
  admitted.
- `src/modules/markdown/useMarkdownDocument.test.ts` - a hidden tab does not
  read, a change while hidden reads once on show, stale/older completions are
  discarded, and only the explicit action forces the 50 MiB read.
- `src/modules/markdown/components/*.test.tsx` - inline vs fenced code, shell
  blocks, streaming placeholder.
- `src/modules/markdown/lib/codeHighlight.test.ts` - token classes, text
  preservation, and that every emitted `tok-*` class is painted by
  `src/styles/code-highlight.css`.
- `src/modules/markdown/lib/assetPath.test.ts` - boundary/policy outcomes.
- `src/modules/markdown/lib/codeBlockRunner.test.ts` - the run-in-terminal seam
  reports refusal instead of success when no terminal is published.
- `scripts/app-lab/run.py --scenario markdown` - the real WebKitGTK seam: the
  Space-root image, the refused symlink escape, cwd independence, an outside
  document's own folder, the explicit outside grant, a counted remote pixel that
  stays at zero requests until the "Load remote images" action, an inert relative
  link, a hostile document that executes nothing, the syntax ceiling, grant
  revocation on close and a read that lands after its document closed. Steps and
  counters are in the report's `markdown` / `markdownServer` blocks; the
  scenario is documented in `docs/architecture/app-lab.md`. That run is a
  bench-build observation in a disposable profile on this host, not a
  packaged-install validation.
- `src/modules/markdown/ownership.test.ts` - the retained renderer never imports
  the AI feature, every consumer of an old entry point is accounted for, the
  markdown tab kind stays behind its dynamic import, and Streamdown is still
  reachable from rendered Markdown.
- `src/app/eager-budget.test.ts` and `src/app/dist-budget.test.ts` - rendered
  Markdown, `streamdown` and the language packs stay out of both windows'
  startup graphs, and one `@lezer/highlight` instance serves parsers and editor
  themes.

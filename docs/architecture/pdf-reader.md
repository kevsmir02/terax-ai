# PDF reader path

**Status: decision recorded (issue #30), implementation not shipped.** This record answers one
question with evidence: can the app's current embedded/iframe PDF path satisfy the accepted PDF
contract on Fedora, or is a dedicated on-demand reader required? Ticket **#31** implements the
reader; nothing here claims any PDF reader function is shipped or validated as a product feature.

Approved ceilings referenced below live in `docs/architecture/resource-limits.md` and
`src/modules/preview/lib/limits.ts` (**32 MiB per rendered PDF page**, 4 concurrent decoded
viewers, 192 MiB decoded budget), approved by the primary user on 2026-11-12 in issue #4.

## The contract this decides

From `docs/specs/personal-linux-workspace.md`:

- **Document previews.** "PDF must support navigation, zoom, search and selection in the actual
  Fedora application. Retain iframe rendering only if it satisfies reliability, reader-function
  and resource requirements; otherwise use a dedicated on-demand viewer."
- **Preview access boundaries.** Document content does not execute application commands or
  automatically fetch remote resources; automatic local resources are anchored to the Space root
  or the document's directory; explicit single-file selection stays distinct from automatic
  directory embedding.
- **Resource contracts.** "Optional editors/viewers load on demand. Bound native reads,
  outstanding operations and decoded/rendering resources, with explicit failure/override
  behavior within hard ceilings. … Do not retain whole-file non-range allocation as an unexamined
  path around resource limits."
- **User story 66.** "I want PDF navigation, zoom, search and text selection to work reliably on
  Fedora, so that PDF support is more than an embedded URL."
- **Testing decisions → Preview scenarios.** PDF reader functions, bounded no-range/range reads,
  hard-limit behaviour and decoded-resource stress must be exercised "in the actual Linux
  webview", and "source/JSX inspection alone cannot establish runtime behavior".

## What the current path actually is

1. Opening a file classifies it (`src/modules/editor/lib/useDocument.ts`). A PDF is not UTF-8
   text, so the document becomes `{ status: "binary" }`.
2. `EditorPane` sees a media kind of `pdf` and renders
   `<iframe src={assetGrant.urlFor(path)} title="<file name>">`
   (`src/modules/editor/EditorPane.tsx`). The URL is the app's `asset:` scheme plus a grant
   token (`src/lib/useAssetGrant.ts`, `src-tauri/src/modules/fs/assets.rs`).
3. The native handler serves `application/pdf` for `.pdf`, with `Accept-Ranges: bytes`,
   `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
   `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`. With no
   `Range` header it reads the **entire file into one `Vec`** and returns it as a single body;
   with one it returns 206 and at most 1 MiB.
4. WebKitGTK 2.54.2 (Fedora 44) ships WebKit's own PDF.js viewer
   (`webkit-pdfjs-viewer://pdfjs/web/viewer.html?file=…`, visible in the library's strings) and
   takes over a main-resource PDF load. The result is a **separate document at a different
   origin**, not part of the application page.

So the current PDF surface is exactly the "embedded URL" the user story rejects as sufficient,
unless it satisfies reliability, reader functions and the resource contract.

## Evidence produced by this ticket

Fixtures are generated and independently verified by `scripts/app-lab/pdf_fixtures.py`
(checked in). `--verify` reads them back with poppler: `pdfinfo` page count, `pdftotext` tokens
(including the one needle that appears on exactly one page), and a 100 DPI `pdftoppm` raster whose
pixel dimensions are checked against the manifest's render arithmetic. Rebuilds are byte-identical
(hash-compared in `scripts/tests/test_pdf_fixtures.py`), and the manifest's ceiling is *parsed from*
`src/modules/preview/lib/limits.ts` so the two cannot drift.

| fixture | shape | why it exists |
| --- | --- | --- |
| `text.pdf` | 6 A4 pages, per-page `SEARCH-NEEDLE-NN`, one `UNIQUE-GLOBAL-NEEDLE` on page 4, footers `[[ page N of 6 ]]` | page count, search and selection targets for the manual checks |
| `zoomed-a4.pdf` | 1 A4 page, sparse 6×8 grid | 4× zoom ≈ 32.0 MB (allowed), 8× ≈ 128.3 MB (above the 32 MiB ceiling) |
| `large-page.pdf` | 1 page, 72 × 54 in | fit-to-window small; 100 % ≈ 80.6 MB (above the ceiling), 50 % ≈ 20.2 MB (allowed) |
| `corrupt.pdf` | header plus a truncated object graph, no xref, lying `/Length` | the error path (poppler refuses to parse it) |
| `not-a-pdf.pdf` | HTML bytes with a `.pdf` name | content sniffing: served as `application/pdf`, unparseable as a document |

The real-app evidence is `scripts/app-lab/run.py --scenario preview` on Fedora 44 / KDE Plasma /
Wayland with the isolated disposable profile, driving the shipped React shell with the app's own
tab actions. The PDF phase reports per-step PASS/FAIL in `page.log` and in the report's
`workflow.steps`; the report also carries the native asset request log, the app's own memory
readings and the fixture manifest.

<!-- EVIDENCE: filled from the run; see "Results" below. -->

## Results

<!-- RESULTS -->

## What the harness cannot automate (named manual checks)

WebKitGTK gives this repository no native input injection (ticket 32), no screenshot/readback
seam, and the PDF document lives in a separate origin, so the app page cannot read its DOM, scale
or page state. Rather than fake a pass, the reader functions are **manual checks**. Each takes
under two minutes and needs only the app and the generated fixtures
(`python3 scripts/app-lab/pdf_fixtures.py --output /tmp/pdf-fixtures`).

**M1 — multi-page navigation.** Open `text.pdf` in the app (file explorer, or the CLI/control
file-open path). Confirm the viewer reports a 6-page document and shows page 1 with the footer
`[[ page 1 of 6 ]]`. Press `PageDown`/`End`, then `Home`.
*Pass:* the last page shows `[[ page 6 of 6 ]]`, returning shows page 1, no blank page, no crash.

**M2 — zoom.** With `text.pdf` open, use the viewer's zoom controls and keyboard zoom (`Ctrl` +/-
or the viewer's `+`/`-`) from 50 % to 200 %.
*Pass:* text stays crisp (vector re-render, not a stretched bitmap), the page does not go blank,
and horizontal scrolling appears instead of clipping. Under the #31 reader, additionally: zooming
`large-page.pdf` to 100 % produces a **refusal naming the 32 MiB page ceiling and the zoom that
would fit**, not a freeze.

**M3 — search.** `Ctrl+F`, type `UNIQUE-GLOBAL-NEEDLE`.
*Pass:* exactly one match, on page 4. Then search `SEARCH-NEEDLE-03`: one match on page 3. The
match is highlighted and the viewer navigates to it.

**M4 — text selection.** Drag across a body line on page 2, copy, and paste into a terminal or the
editor.
*Pass:* the pasted text is the page's body line (for example
`02.01 deterministic body line for page 2`), not an image or an empty clipboard.

**M5 — corrupt and unsupported documents.** Open `corrupt.pdf`, then `not-a-pdf.pdf`.
*Pass:* each shows a visible, explanatory error inside the pane (with an external-viewer
alternative under the #31 reader), the rest of the app keeps working, and no file is downloaded or
written into the isolated profile.

**M6 — integration with the app's lifecycle.** With `text.pdf` open, switch to another Space and
back, then hide/restore the window, then close the tab.
*Pass:* the PDF is still readable after returning (a reload is acceptable and, like the web
preview, must be disclosed), closing the tab leaves no background work, and the app does not
crash or grow unboundedly.

**M7 — no remote or app-authority access from the document.** With `text.pdf` open, check the app
log for network requests while the document is on screen, and confirm the pane offers no action
that runs a command.
*Pass:* no requests leave the machine, and nothing in the PDF can execute an application command.

These are the checks that turn "the iframe loads something" into "the PDF contract holds". They
are **not** satisfied by the automated phase below and must be re-run after #31 implements the
reader.

## Decision

<!-- DECISION -->

## What the ticket-#31 implementation must do (if the dedicated reader is required)

<!-- IMPLEMENTATION -->

## What would change this decision

<!-- CHANGE-MY-MIND -->

## Deliberately not decided here

- **Annotation, authoring, form filling or PDF editing.** Out of scope in the parent spec.
- **Codec/format support for images and media.** Issues #28/#29.
- **Whole-application budgets.** Issue #42; this record only uses the approved per-page and
  decoded-viewer ceilings.
- **Shipping status.** No PDF reader function is claimed as shipped by this record.

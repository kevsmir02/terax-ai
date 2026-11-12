# PDF reader path

**Status: decision recorded (issue #30), implementation not shipped.** This record answers one
question with evidence: can the app's current embedded/iframe PDF path satisfy the accepted PDF
contract on Fedora, or is a dedicated on-demand reader required? Ticket **#31** implements the
reader; nothing here claims any PDF reader function is shipped or validated as a product feature.

Approved ceilings referenced below live in `docs/architecture/resource-limits.md` and
`src/modules/preview/lib/limits.ts` (**32 MiB per rendered PDF page**, 4 concurrent decoded
viewers, 192 MiB decoded budget), approved by the primary user on 2026-11-12 in issue #4.

**Validated in the real application by this ticket:** the app's own delivery gate and its explicit
override, the bytes/content type/ranges the asset server served, the cross-origin document
boundary, the error and misnamed-file paths, hidden-tab behaviour, tab-close grant release, memory
observations, and profile isolation/coexistence.

**Not validated (planned implementation, issue #31):** every PDF reader function (navigation, zoom,
search, text selection), the 32 MiB per-page refusal, decoded-viewer admission for PDFs, and the
dedicated reader itself.

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

1. Opening a file classifies it by *content* (`src/modules/editor/lib/useDocument.ts`). A PDF is
   not UTF-8 text, so the document becomes `{ status: "binary" }` (or `toolarge`, with the size the
   native reader refused at).
2. `EditorPane` hands a PDF to `AssetPreview` (`src/modules/preview/AssetPreview.tsx`), which
   applies the approved whole-file delivery gate *before* any element loads
   (`assetDeliveryDecision`, `src/modules/preview/lib/assetDelivery.ts`):
   ≤ 10 MiB loads; 10-50 MiB needs the explicit "Load anyway" choice; above 50 MiB is refused with
   an external viewer. Only then does it render
   `<iframe src={assetGrant.urlFor(path)} title="<file name>">`.
3. The URL is the app's `asset:` scheme plus a tab-scoped grant token
   (`src/lib/useAssetGrant.ts`, `src-tauri/src/modules/fs/assets.rs`), so the native handler serves
   the file only while that tab scope is live. It answers `application/pdf` with
   `Accept-Ranges: bytes`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
   `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`.
4. **WebKitGTK 2.54.2 substitutes a document of its own** for the PDF resource — WebKit's
   built-in, PDF.js-based viewer (the scheme string `webkit-pdfjs-viewer://` is present in
   `libwebkit2gtk-4.1.so.0.24.5`, but the app cannot observe the actual URL). Measured from the app
   page: the frame commits a document whose `contentDocument` is `null` and whose
   `contentWindow.location` throws `SecurityError: Sandbox access violation: Blocked a frame at
   "tauri://localhost"`.

## Evidence produced by this ticket

Fixtures are generated deterministically and independently verified by
`scripts/app-lab/pdf_fixtures.py` (checked in, no binaries): a PDF writer with no timestamp or
randomness, so a rebuild is byte-identical (`scripts/tests/test_pdf_fixtures.py` compares hashes).
`--verify` reads the files back with poppler — `pdfinfo` page count, `pdftotext` tokens including
the needle that appears on exactly one page, and a 100 DPI `pdftoppm` raster whose pixel
dimensions are checked against the manifest's render arithmetic. The manifest's ceiling is
*parsed from* `src/modules/preview/lib/limits.ts`, so the two cannot drift.

| fixture | shape | why it exists |
| --- | --- | --- |
| `text.pdf` | 6 A4 pages, per-page `SEARCH-NEEDLE-NN`, one `UNIQUE-GLOBAL-NEEDLE` on page 4, footers `[[ page N of 6 ]]` | page count, search and selection targets |
| `zoomed-a4.pdf` | 1 A4 page, sparse 6×8 grid | 4× zoom 32,090,304 B (allowed), 8× 128,334,272 B (above the 32 MiB ceiling) |
| `large-page.pdf` | 1 page, 72 × 54 in | fit-to-window small; 100 % 80,621,568 B (above the ceiling), 50 % 20,155,392 B (allowed) |
| `oversized.pdf` | 1 A4 page plus metadata padding, 12,585,343 B | above the 10 MiB whole-file read ceiling, below the 50 MiB override |
| `corrupt.pdf` | header plus a truncated object graph, no xref, lying `/Length` | the parse-error path (poppler refuses it) |
| `not-a-pdf.pdf` | HTML bytes with a `.pdf` name | content classification: a misnamed file |

The real-app evidence is the app-lab preview scenario on Fedora 44 / KDE Plasma / Wayland with an
isolated disposable profile, driving the shipped React shell through the app's own tab actions:

```sh
python3 scripts/app-lab/run.py --scenario preview --profile debug \
    --target-dir /home/loba/.cache/terax-target-30 --output /tmp/terax30-evidence
```

The PDF phase reports per-step PASS/FAIL in `page.log` and in the report's `workflow.steps`. The
native side of every request is recorded by a bench-only probe around the asset handler
(`src-tauri/src/modules/fs/bench_probe.rs`, `bench_asset_log`), because the app page cannot read
what it is showing: method, content type, status, bytes, the client's `Range` header, whether
`Accept-Ranges` was advertised, whether the request carried the explicit `override=1` choice, and
the number of live grants. The probe records file *basenames* only — never a grant token or an
absolute path.

Host stack recorded by the report: Fedora Linux 44 (KDE Plasma), kernel 7.3.3-200.fc44,
WebKitGTK 2.54.2-1.fc44, GTK 3.24.52, session `wayland`, display `wayland-1`, device pixel ratio 1.
**No display workaround was used**: `WEBKIT_DISABLE_DMABUF_RENDERER` was not set and the app
rendered and stayed responsive in every phase.

### What was observed, per reader function

Navigation, zoom, search and text selection all happen **inside WebKit's own viewer document**.
This harness cannot drive them (WebKitGTK exposes no native input injection; that is ticket 32) and
the app page cannot read them. What *can* be asserted from the real app is the boundary:

| function | what the app can observe | what was measured |
| --- | --- | --- |
| page count / current page | nothing — no API, no DOM access, no event | the frame's document is cross-origin and its `location` read is refused |
| navigation | nothing | same; the app knows only that a tab exists |
| zoom | nothing — no scale, no re-render hook | same; the approved per-page ceiling never runs (see below) |
| search | nothing — no match count, no navigation to a match | same |
| text selection | nothing — selection lives in the viewer's document; the app cannot read or bridge it | same |

The four functions are therefore **named manual checks** below, not automated passes. This is the
finding the decision turns on: a reader the application cannot observe is a reader the application
cannot make reliable, bound or recover.

### Reliability and failure states

- **One document, no signal.** The frame is already a cross-origin document by the time the driver
  can look at it, and the application has no event, API or DOM access that reports whether it
  rendered, which page it shows or whether it failed. (The iframe element's `load` event is not a
  usable signal for the app either: a load that fires while the pane is mounting cannot be
  distinguished from one that never fires.) The app cannot tell a rendered document from a blank or
  failed one.
- **Corrupt document.** `corrupt.pdf` (315 B) is served as `application/pdf`, the frame commits a
  separate document, and the app keeps working (tab stays open, window responsive). The viewer's
  own error message is inside that separate document and cannot be read, so the app cannot offer
  the approved "explain the failure and offer an external viewer" surface; the pane is whatever
  WebKit drew.
- **Misnamed document.** `not-a-pdf.pdf` (HTML bytes) opens in the text editor, because
  classification is by content. No PDF surface is involved, and nothing is downloaded or written.
- **Hidden tab.** With the PDF tab hidden behind a terminal tab for 3 s, the frame **stayed
  mounted**, the asset server saw **no new request**, and returning to the tab found the **same
  document** still loaded. A web preview, by contrast, unloads its frame the moment its tab is
  hidden. Nothing pauses or releases a hidden PDF.
- **One request, and the viewer never asked for the file.** The viewer's URL template takes
  `file=`, so a running viewer normally fetches the document itself; the asset handler saw exactly
  one request per document — the one the app's iframe navigation made. Either WebKit hands the
  already-read bytes to the viewer, or the sandboxed viewer never ran its load path. The app cannot
  tell, and neither outcome is under its control; manual check M1 resolves which one it is, and
  issue #31 replaces the question with a reader that reports its own state.

### Resource observations

From `/tmp/terax30-evidence/report.json` (this host was also running another agent's build, so the
absolute figures are directional and vary between runs; the deltas are the observation).
Whole-application PSS is from `/proc/<pid>/smaps_rollup`, WebContent is the `web_content` role:

| phase | total PSS | WebContent | note |
| --- | --- | --- | --- |
| PDF baseline | 415.5 MiB | 245.8 MiB | after the web-preview phases |
| `text.pdf` open (10,708 B, 6 pages) | 420.6 MiB | 252.3 MiB | +5.1 MiB for a 10 KB document |
| tab hidden (3 s) | 425.9 MiB | 255.6 MiB | frame still mounted, nothing released |
| `text.pdf` closed | 427.2 MiB | 259.3 MiB | not returned to the baseline |
| `oversized.pdf` open (12,585,343 B) | 442.0 MiB | 270.3 MiB | +21.4 MiB over the reference document |

Delivery, observed natively (whole-file responses are `200` with no `Range` header; range responses
would be a clamped `206`):

| document | bytes | requests | read path |
| --- | --- | --- | --- |
| `text.pdf` | 10,708 | 1 | one whole-file `200`; `Accept-Ranges: bytes` advertised and never used |
| `large-page.pdf` | 4,214 | 1 | one whole-file `200` |
| `oversized.pdf` | 12,585,343 | 1 | delivery gate first (no frame, no request), then one `200` with `override=1` |
| `corrupt.pdf` | 315 | 1 | one whole-file `200`; the viewer never asked for a range |

The approved per-page ceiling (32 MiB) is **never consulted** on this path: `pdfPageDecision` is a
reader contract with no owner here. `large-page.pdf` is 4 KB on disk and its 100 % render is
80,621,568 B by the approved arithmetic — above the ceiling — yet nothing in the app can refuse
that zoom, name the zoom that would fit, or even know it happened. The delivery gate that does run
bounds *file bytes*, not decoded page rasters.

Tab close released the grant: live grants were 0 before the phase and 0 after all five documents
closed, and no frame outlived its tab.

### Access boundaries

- The document cannot call application commands: it is a web document in a separate origin with no
  `__TAURI__`/`__TAURI_INTERNALS__`; the app page's own web-preview fixture asserts the same
  boundary for served documents, and the PDF gets the same `sandbox` CSP.
- The app page cannot read the asset URL it handed over: a scripted `fetch` of the granted URL from
  the app page failed (`TypeError: Load failed`, no `asset:` in `connect-src`). Every transport
  observation above therefore comes from the native handler, not from the page.
- No remote resource is fetched: only the one `asset:` request per document reached anything, and
  the fixture documents contain no remote references.
- Grants stay tab-scoped: a closed tab revokes its grant, and a late grant is revoked rather than
  installed (`src/lib/assetScopes.ts`, issue #26).

## Reproducing the run

```sh
pnpm install --frozen-lockfile
python3 scripts/app-lab/run.py --scenario preview --profile debug \
    --target-dir /home/loba/.cache/terax-target-30 --output /tmp/terax30-evidence
python3 -m unittest discover -s scripts/tests          # fixtures and their contract
```

Observed on 2026-11-12 on branch `ticket/30-pdf` (the report records the revision it ran): `preview PASS: 29/29 steps`
on two consecutive runs (one of them with `--pdf-hold-ms`, which held `text.pdf` on screen for four
minutes), `coexistence PASS: 17 upstream files unchanged`, `pdf fixtures: 6 documents … (6 pages,
ceiling 32 MiB/page)`. The report is written outside the repository
(`/tmp/terax30-evidence/report.json`) with `workflow.steps`, `preview.pdf` (fixture decisions, read
paths, per-document served entries, frames, memory) and the generated manifest with its poppler
verification.

## Named manual checks (not automated here)

WebKitGTK gives this repository no screenshot or input seam (ticket 32), and the validation host's
desktop was in use by another application for the whole run: the Wayland compositor declines the
benchmark window's focus request (the report records `appActive=false` in most phases), so
injecting input would have landed in that other application. Anyone re-running these checks should
own the display. The four reader functions are therefore stated as manual checks a person runs at
the display, with the exact fixtures. Each takes under two minutes
(`python3 scripts/app-lab/pdf_fixtures.py --output /tmp/pdf-fixtures`,
`--pdf-hold-ms 180000` keeps `text.pdf` open in the run).

**M1 — multi-page navigation.** `text.pdf`: confirm 6 pages, page 1 shows the footer
`[[ page 1 of 6 ]]`; press `PageDown`/`End`, then `Home`.
*Pass:* last page shows `[[ page 6 of 6 ]]`, returning shows page 1, no blank page, no crash.

**M2 — zoom.** `text.pdf` at 50 % to 200 % through the viewer's controls and keyboard zoom.
*Pass:* text stays crisp (vector re-render), the page does not go blank, horizontal scrolling
appears instead of clipping. Under the #31 reader, additionally: `large-page.pdf` at 100 % produces
a **refusal naming the 32 MiB page ceiling and the zoom that would fit**.

**M3 — search.** `Ctrl+F`, `UNIQUE-GLOBAL-NEEDLE`.
*Pass:* exactly one match, on page 4; then `SEARCH-NEEDLE-03` matches on page 3, highlighted, and
the viewer navigates to it.

**M4 — text selection.** Drag across a body line on page 2, copy, paste into a terminal or editor.
*Pass:* the pasted text is the body line (for example `02.01 deterministic body line for page 2`),
not an image or an empty clipboard.

**M5 — corrupt and unsupported documents.** Open `corrupt.pdf`, then `not-a-pdf.pdf`.
*Pass:* each shows a visible, explanatory state (an error inside the pane with an external-viewer
alternative under the #31 reader), the rest of the app keeps working, nothing is downloaded or
written. *Automated part:* the app survives and the misnamed file opens as text; the viewer's own
error text cannot be read from the app page.

**M6 — lifecycle.** With `text.pdf` open, switch to another Space and back, hide/restore the
window, then close the tab.
*Pass:* the document is still readable after returning (a reload is acceptable and, like the web
preview, must be disclosed), closing the tab leaves no background work, and the app does not crash.
*Automated part:* tab close releases the frame and the grant; a hidden tab keeps the document (see
"Hidden tab" above).

**M7 — no remote or app-authority access.** With `text.pdf` open, check the app log for network
requests and confirm the pane offers no action that runs a command.
*Pass:* no requests leave the machine; nothing in the PDF can execute an application command.
*Automated part:* one `asset:` request per document, a scripted read from the app page refused, and
the document runs without app IPC.

M1-M4 **have not been run**; M5-M7 are automated to the extent stated. None of them changes the
decision below, which rests on what the application can observe, bound and recover.

## Decision

**The current iframe path cannot satisfy the contract. A dedicated, on-demand reader is
required.** The reasons, each from the evidence above:

1. **Reader functions are outside the application.** The document is a separate, sandboxed,
   cross-origin origin. The app has no page count, page index, scale, search state or selection, and
   no event when the document loads or fails. Reliability cannot be built on a surface that cannot
   report that it is working, which also means no approved refusal or recovery UI can be shown.
2. **The approved per-page ceiling has no owner.** The 32 MiB per-page contract, its refusal and
   its "zoom that would fit" cannot be evaluated by a document the app cannot inspect. The delivery
   gate correctly bounds *file bytes* (and does so in the real app, including the explicit
   override), but a page decode is the resource the ceiling is about.
3. **Decoded viewers are unaccounted.** The 4-viewer / 192 MiB admission table
   (`viewerAdmission.ts`) never sees a PDF; each PDF is whatever WebKit's viewer decides, and a
   hidden tab keeps it (measured: frame mounted, no new request, memory not returned).
4. **Delivery is whole-file.** The viewer asks for the document once, whole, even with
   `Accept-Ranges` advertised and a `206` clamp available; and the file is held in the document as
   well as in the viewer. That is compatible with the approved 10/50 MiB whole-file rule, but it is
   not a document path that can bound a large scanned PDF's decode.
5. **Failure states are invisible and unrecoverable.** A corrupt document produces no app-visible
   error, no retry, no external-viewer offer, and no way to distinguish "blank because it failed"
   from "blank because the page is white".

Retaining the iframe would leave the contract's reader functions, resource ceilings and failure
states unowned, so the accepted scope's alternative applies.

## What the ticket-#31 implementation must do

The reader is our document, in our pane, with the approved policy applied by code we test:

- **On demand, in the existing preview surface.** The PDF renderer is a lazy chunk loaded when a
  PDF tab becomes visible, admitted through the existing `viewerAdmission` table (4 viewers /
  192 MiB, hidden viewers evictable, never a visible one). No new ceiling and no new budget.
- **Bytes through the existing grant.** Read the document through the tab-scoped `asset:` grant and
  `DeliveryLimits` (≤ 10 MiB whole file; explicit override to 50 MiB; above that, external viewer),
  or through the native read of the document within the same limits. No new read path, no remote
  fetch, no bundled copy of the file.
- **A per-page render decision before painting.** Compute the page raster in decoded bytes and pass
  it through `pdfPageDecision` (`src/modules/preview/lib/limits.ts`); a page above 32 MiB refuses
  with the zoom that would fit and the external-viewer alternative, instead of painting.
- **Rendered pages count against the decoded budget.** At the 32 MiB ceiling only about six
  rendered pages fit the 192 MiB application budget, so the reader keeps a bounded cache of
  rendered pages (and hands its size to `decideViewerAdmission`) instead of rendering the whole
  document; a scroll or zoom therefore re-renders rather than accumulating rasters.
- **One lazy chunk, inside the existing budget.** The renderer is loaded only for a visible PDF tab
  and must keep the existing dist-budget test green; no PDF dependency reaches startup.
- **App-owned navigation, zoom, search and selection.** Page number/count, previous/next, fit-width
  and fit-page, zoom with a genuine vector re-render, search over extracted text with match count
  and navigation, and a text layer that supports selection and copy. Because the reader is app DOM,
  these become assertable in the app-lab scenario — the thing this ticket could not do.
- **Explicit failure states.** Corrupt, encrypted, unsupported-image and page-too-large each render
  the existing `AssetDeliveryNotice` pattern with a reason and a safe alternative; never a blank
  pane, never a silent retry, never a download.
- **Lifecycle.** Unmount and release on a hidden tab (unlike today's frame) and on close; grant
  revocation stays with the tab scope.
- **Document content stays inert.** No scripting from the document, no remote resources, no
  application command surface; keep the existing CSP and the native path checks.

## What would change this decision

A supported WebKitGTK PDF integration that (a) reports load, page count/current page, scale, search
matches and errors to the embedding application, and (b) lets the application bound a page render
before it is decoded, would make the retained iframe path viable. Extension recognition, a
standalone browser probe, or "the viewer has a toolbar" are not that evidence.

## Deliberately not decided here

- **Annotation, authoring, form filling or PDF editing.** Out of scope in the parent spec.
- **Codec/format support for images and media.** Issues #28/#29.
- **Whole-application budgets.** Issue #42; this record only uses the approved per-page and
  decoded-viewer ceilings.
- **The reader's internal architecture** (which rendering library, chunk layout, toolbar details).
  Issue #31 implements and verifies it against this policy.
- **Shipping status.** No PDF reader function is claimed as shipped by this record.

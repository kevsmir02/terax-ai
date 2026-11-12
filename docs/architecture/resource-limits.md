# Document and decoded-resource limits

This guide records the runtime ceilings for document previews and optional
viewers, the behaviour required when a ceiling is reached, and where each
number is enforced. `TERAX.md` remains the source of truth for the surrounding
architecture; the personal Linux workspace spec (`docs/specs/` in the planning
track) states the intent, this record states the approved values.

**Status: approved.** The primary user approved these values on **2026-11-12**
when choosing the "Balanced" option in issue **#4** (workspace ticket 03,
"Approve initial document and decoded-resource limits"). The numbers are data in
`src/modules/preview/lib/limits.ts`; this document explains them. Neither
replaces an issue #42 decision about whole-application budgets.

## Evidence

The ceilings were set against the issue #3 Linux baseline measured on the same
day in the real Fedora application, not against an invented workload:

- idle application PSS ~**340 MiB**;
- **482-492 MiB** total PSS under the accepted two-Space / four-terminal /
  two-agent workload (plus a separately described stress workload).

Evidence lives with the benchmark artifacts at
`personal/terax-baseline/evidence/2026-11-12/` (outside this repository;
`key-metrics.json` holds the aggregated figures). Document and decoded-resource
ceilings are a fraction of that observed envelope, so ordinary reading does not
approach them; they exist to bound a pathological document, not to describe
normal use.

## Approved values

| Surface | Ceiling | Meaning |
| --- | --- | --- |
| Text/code read | **10 MiB** | normal file-read limit |
| Text/code explicit override | **50 MiB** | reachable only through the deliberate "open anyway" action |
| Syntax features | **4 MiB** | above this the file still opens, without highlighting/parsing |
| Image decode | **64 MiB** decoded (RGBA8, ≈ 4096 × 4096) | maximum single-image raster |
| PDF page render | **32 MiB** per page | A4 up to roughly 300 DPI |
| Concurrent decoded viewers | **4** | documents, images and PDF pages together |
| Decoded-asset budget | **192 MiB** application-wide | sum over all admitted viewers |
| Playing media | **1 per tab, 3 application-wide** | audio/video elements actually playing |

The image limit is expressed in decoded bytes, not file bytes: a compressed
4096 × 4096 PNG is a few MiB on disk and 64 MiB in the raster.

### Enforcing owner per value

Values that already existed are not duplicated: the module mirrors them and a
test fails when the copies diverge.

| Value | Owner | Notes |
| --- | --- | --- |
| 10 MiB read, 50 MiB override | `src-tauri/src/modules/fs/file.rs` (`MAX_READ_BYTES`, `FORCE_MAX_READ_BYTES`) | the native reader refuses and returns the limit it applied; the UI never re-reads a file to re-decide |
| 4 MiB syntax ceiling | `src/modules/preview/lib/limits.ts`, consumed by `src/modules/editor/EditorPane.tsx` | a renderer behaviour, not a read limit |
| Asset delivery (read/override, chunk, outstanding reads) | `src-tauri/src/modules/fs/assets.rs` (`DeliveryLimits`) | derived from the two read ceilings; no separate asset ceiling exists |
| 64 MiB image decode | `src/modules/preview/lib/imageViewer.ts` via `imageBudgetDecision`, fed by `src-tauri/src/modules/fs/image_probe.rs` (`fs_image_probe`) | dimensions come from the container header before the `<img>` mounts; a larger raster is never allocated |
| 4 viewers / 192 MiB decoded | `src/modules/preview/lib/viewerAdmission.ts` via `decideViewerAdmission` | hidden viewers are evictable, a visible viewer never is |
| PDF page and media playback | `src/modules/preview/lib/limits.ts` | still contract only; issues #30/#31 and #29 implement the readers |

### Enforcement today

The text ceilings are enforced by `modules::fs`: a read above 10 MiB is refused
with the limit it applied, the explicit override reaches 50 MiB, and the editor
disables syntax features above 4 MiB.

Asset delivery is bounded by the same two read ceilings (issue #25). The asset
scheme handler never allocates a whole large file by default:

- a range request is answered with at most one chunk (a tenth of the normal
  read ceiling), with a 206 and a shortened `Content-Range`; `bytes=0-` from a
  media element is therefore one chunk, not the file;
- a non-range request at or below 10 MiB is served whole; above it the response
  is a 413 that names the size, offers the explicit `override=1` choice up to
  50 MiB, and keeps `Accept-Ranges` available;
- above 50 MiB the only alternative is an external viewer;
- outstanding deliveries are bounded by the approved concurrent-viewer count
  and by one override read's worth of bytes, with a short bounded wait and an
  explicit 503 + `Retry-After` instead of an unbounded queue;
- every request re-canonicalizes the requested path, re-applies the secret
  policy and re-checks the *opened descriptor* against the grant, so a symlink
  or replaced target cannot step outside it;
- a grant is revoked with its tab scope (and on page load or window close), and
  a delivery checks the scope again after it has been reserved: a revoke during
  the read aborts the response instead of serving a token the tab no longer
  owns.

Images are bounded before the decoder sees the file (issue #28). The editor
routes a file to the image surface by extension, which is a *routing* guess only;
the native `fs_image_probe` command then reads at most 256 KiB of the container
header and reports the intrinsic dimensions without decoding pixels. The
approved `imageBudgetDecision` runs on those dimensions, so a raster above
64 MiB decoded is refused before an `<img>` is mounted. The surface offers
`open-externally`; it does **not** claim a reduced-size decode, because the
WebKitGTK `<img>` path decodes at intrinsic size and a CSS-scaled element would
not reduce the allocation. A future viewer that genuinely decodes to a smaller
target may return `downscale` from the same decision. SVG is a vector format and
does not consume the raster budget. Only formats actually measured in this
build's webview are claimed as supported:

| Format | Routing extensions | Measured decode (2026-11-12) |
| --- | --- | --- |
| PNG | `.png` | Fedora 44, WebKitGTK 2.54.2: renders 64×64 fixture |
| JPEG | `.jpg`, `.jpeg` | same run: renders 64×64 fixture |
| GIF | `.gif` | same run: renders 64×64 fixture |
| WebP | `.webp` | same run: renders 64×64 fixture (lossless bitstream) |
| BMP | `.bmp` | same run: renders 64×64 fixture |
| ICO | `.ico` | same run: renders the largest directory entry (64×64) |
| AVIF | `.avif` | same run: renders 64×64 fixture |
| SVG | (not routed to the file viewer) | same run: inline/embedded SVG renders; an explicitly opened `.svg` stays an editable text tab, so the user can still edit it |

The evidence is the `--scenario images` run of `scripts/app-lab` against the real
application (the driver asserts the rendered element's `naturalWidth`, the
oversized/corrupt states, hidden-tab release and open/close cleanup), not the
extension list. SVG is measured as an inline/embedded vector, but an explicitly
opened `.svg` stays in the editor because it is editable text; that is a routing
decision, not a decode-support claim. Any other extension stays with the binary
notice, and a routed extension whose header does not parse is reported as
corrupt/unsupported rather than shown as a blank image.

Images and decoded viewers are enforced by the preview surfaces:
`viewerAdmission.ts` admits decoded viewers against the four-viewer and 192 MiB
ceiling, releasing hidden viewers least-recently-used first and never evicting a
visible one. Hidden image tabs drop the rendered element and release their
decoded slot; closing or replacing the tab releases the raster, the slot and the
tab-owned asset grant. PDF opens in the bounded frame, so the file read is
bounded, but the 32 MiB per-page render ceiling is still contract only until
issue #31, and a hidden media element still only pauses its own pane until issue
#29. Markdown inline images go through the same asset delivery bounds but are
not separate decoded viewers until issue #27.

This is **planned implementation, not validated support** for anything that
needs a real WebKitGTK session: no measurement claims these ceilings are
observed at runtime on the packaged application yet.

`limits.test.ts` parses the Rust constants and rejects an editor-side copy of
the override or syntax literal; `assetDelivery.test.ts` parses
`modules/fs/assets.rs` the same way, so "single source" is a checked property.

## Behaviour when a ceiling is reached

Every outcome is explicit and offers a safe alternative. None of them silently
shows a blank pane, downloads the file, installs a codec or changes a codec
setting.

| Situation | Outcome |
| --- | --- |
| Text file above 10 MiB, at most 50 MiB | refusal that explains the size and offers the explicit override; the override opens the file with syntax off |
| Text file above 50 MiB | refusal naming the 50 MiB ceiling; open externally |
| File above 4 MiB but within the read ceiling | opens normally, syntax features disabled |
| Image above 64 MiB decoded | refusal explaining the decoded size and offering `open-externally`; the image is refused from its header, so no raster is allocated. A viewer that genuinely decodes at reduced size may instead return the `downscale` decision |
| Image with an unusable header or unknown format | corrupt/unsupported notice with a retry where the file may change, and an external viewer; never a blank pane |
| Image routed by extension but not measured in this build | refusal naming the format as unverified; external viewer (routing is not decode support) |
| PDF page above 32 MiB rendered | refusal with the zoom that would fit the page and the external fallback |
| Fifth concurrent viewer | refusal naming the blocking viewers; the user closes one, or opens the file externally. Hidden viewers may be released, visible ones never are |
| Viewer larger than the whole 192 MiB budget | refusal; external viewer |
| Fourth playing media element | refusal naming the playing elements in other tabs; the user stops one. A second element in the same tab pauses its sibling, as the pane only shows one at a time |

Two rules follow from this table and are covered by tests in
`src/modules/preview/lib/limits.test.ts`:

1. A refusal always carries a reason and at least one safe alternative.
2. Admission never evicts a viewer the user is looking at. Eviction is limited
   to hidden viewers, is returned as an explicit list, and is least-recently-
   used first.

## Storage quotas are not runtime budgets

The recovery-draft policy (10 MiB per file, 100 MiB total, issue #16) is a
**disk-storage** quota. It is recorded in the same table so the two are read
together, but it is not part of the 192 MiB decoded-asset budget and does not
consume decoded memory: drafts on disk and rasters in memory are different
resources with different failure modes (a full disk versus exhausted memory).
Do not add one to the other, and do not derive one from the other.

## Deliberately not decided here

- **Whole-application startup time and memory targets.** Issue #42 accepts
  those from measured final evidence. These viewer ceilings are not a startup
  budget, not a total-RSS target and not evidence that a lightweight release
  gate is met.
- **Package size.** Unrelated to runtime ceilings; issue #42 and the release
  tickets own it.
- **Codec and format support.** Which image/media formats actually decode is
  measured in issues #28 and #29, not implied by an extension list or by these
  numbers. Issue #28 measured PNG, JPEG, GIF, WebP, BMP, ICO, AVIF and SVG in the
  Fedora WebKitGTK build recorded above; a different engine build needs its own
  run.
- **The PDF reader path.** Issue #30 decides whether the current iframe can
  meet the PDF contract and issue #31 implements the reader; these limits apply
  either way.

## Using the contract

Later preview tickets import from `@/modules/preview/lib/limits`:

| Export | Use |
| --- | --- |
| `RESOURCE_LIMITS`, `TEXT_*`, `IMAGE_*`, `PDF_*`, `MAX_*`, `DECODED_ASSET_BUDGET_BYTES` | the approved numbers; never re-declare them |
| `LIMITS_APPROVAL` | provenance (issue, decision, approver, date, evidence, open questions) |
| `textReadDecision(bytes, forced)` | read / read-without-syntax / too-large with override offered |
| `decodedImageBytes(width, height)`, `imageBudgetDecision(width, height, { reducedDecode })` | allow / downscale / refuse |
| `fs_image_probe` (native), `imageFormatForPath`, `imageDecodeSupport` | header dimensions before decode, and routing kept separate from measured format support |
| `imageViewerState`, `imageViewerRequest`, `imageViewerRegistration` | the image surface's order: probe → budget → admission → mount, with honest refusal states |
| `pdfPageDecision(renderBytes)` | allow / refuse with a suggested zoom |
| `decideViewerAdmission(viewers, request)` | admit (with explicit evictions) / refuse with blockers |
| `decideMediaPlayback(sessions, request)` | play (with sibling pauses) / refuse with blockers |
| `ASSET_DELIVERY`, `assetDeliveryDecision(bytes, kind, { override })` | the native delivery bounds and the whole-file / explicit-choice / refuse decision |
| `assetFailureNotice(error)`, `assetUrlWithOverride(url, override)` | a readable refusal with alternatives, and the explicit-choice URL |
| `admitDecodedViewer`, `useViewerAdmissionStore` | the applied 4-viewer / 192 MiB table with eviction bookkeeping |

The module imports nothing: decisions are pure functions over plain data, so
viewer components stay thin and the policy is testable without a DOM.

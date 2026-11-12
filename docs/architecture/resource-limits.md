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
| Image, PDF, viewer and media ceilings | `src/modules/preview/lib/limits.ts` | enforced by the viewers built in issues #25, #28, #29 and #30/#31 (see "Enforcement today") |

### Enforcement today

Only the text ceilings are enforced today: `modules::fs` refuses a read above
10 MiB and reports the limit it applied, the explicit override reaches 50 MiB,
and the editor disables syntax features above 4 MiB.

The image, PDF, viewer and media ceilings are an approved contract without an
enforcement path yet. The current image pane decodes at intrinsic size, PDF
opens in an iframe with no per-page budget, a media element only pauses its own
hidden pane, and no admission layer counts viewers. Issues #25, #28, #29 and
#30/#31 implement and verify those paths. Until they do, this record is
**planned implementation, not validated support**: no measurement claims those
ceilings are observed at runtime.

`limits.test.ts` parses the Rust constants and rejects an editor-side copy of
the override or syntax literal, so "single source" is a checked property.

## Behaviour when a ceiling is reached

Every outcome is explicit and offers a safe alternative. None of them silently
shows a blank pane, downloads the file, installs a codec or changes a codec
setting.

| Situation | Outcome |
| --- | --- |
| Text file above 10 MiB, at most 50 MiB | refusal that explains the size and offers the explicit override; the override opens the file with syntax off |
| Text file above 50 MiB | refusal naming the 50 MiB ceiling; open externally |
| File above 4 MiB but within the read ceiling | opens normally, syntax features disabled |
| Image above 64 MiB decoded | refusal explaining the decoded size and offering an external viewer; a viewer that can genuinely decode at reduced size may instead downscale to the returned target size |
| Image with unusable dimensions | refusal; external viewer |
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
  numbers.
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
| `pdfPageDecision(renderBytes)` | allow / refuse with a suggested zoom |
| `decideViewerAdmission(viewers, request)` | admit (with explicit evictions) / refuse with blockers |
| `decideMediaPlayback(sessions, request)` | play (with sibling pauses) / refuse with blockers |

The module imports nothing: decisions are pure functions over plain data, so
viewer components stay thin and the policy is testable without a DOM.

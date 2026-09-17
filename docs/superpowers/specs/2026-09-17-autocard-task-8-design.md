# AutoCard Task 8 Design

**Date:** 2026-09-17
**Status:** Approved for implementation

## Goal

Harden the AutoCard editor around authenticated media, pending changes,
out-of-order requests, paginated history, explicit content overflow, and
responsive preview sizing without changing the existing static architecture or
the authenticated media contract.

## Decisions

- PNG export preserves the rendered card aspect ratio and scales the rendered
  width to `1080px`; it is not forced to `1080 × 1080`.
- A replacement image remains visible until the replacement has uploaded and its
  authenticated blob URL has loaded. The editor exposes the pending state and
  blocks export while media is not ready.
- AutoCard card IDs remain the uniqueness boundary. Duplication keeps the
  existing length-safe `117 + " v2"` display-name policy; no unbounded suffix
  scheme is introduced.
- The vacancy preview continues to show at most four requirements and four
  benefits, but excess items are reported with an accessible warning and remain
  in the saved values. Export is blocked while any known visual overflow exists.

## Scope

### Editor state and async requests

Keep state in `public/autocard/app.js`. Add a saved draft snapshot, a document
generation token, and an edit revision. Every document-changing operation
increments the generation. Field, icon, illustration, crop, mode, size, and
media changes update the revision and dirty state.

Navigation from the editor is guarded for dirty changes or pending media/save
operations. The guard covers the back button, template selection, tab changes,
same-origin shell links, logout, and `beforeunload`. Confirmed navigation
invalidates the current generation before changing the document.

Save, history-card loading, media loading/upload, and export capture their
generation and relevant revision. A response may update state only when its
captured values still match. A save response from the same document but an
older revision may update the saved-card identity while leaving the current
draft dirty; a response from a replaced document is ignored.

### Media

Replace the label-only upload trigger with a keyboard-focusable button that
opens the existing hidden file input. Reset the input before and after a
selection so choosing the same file again works. Expose a status region with
`idle`, `uploading`, `loading`, `ready`, and `error` states.

Keep authenticated `blob:` URLs and the current crop state. Validate the local
image before upload, retain the current image during replacement, and restore
it if the replacement fails. Do not apply a late upload or media response to a
different document. Map invalid normalized image bytes to the existing `400`
validation response, matching the Cards Pós route.

### History and duplication

Use `fetchAPIPage()` and the existing `renderPagination()` helper. Add a saved
history pagination region, send a fixed page size with `limit`/`offset`, reset
to the first page after search/filter changes, preserve visible results while a
new page loads, and ignore stale responses. If a non-first page becomes empty,
reload the last valid page. Order the API list by `updated_at DESC, id DESC`.

Validate the manual display name before saving against the same 120-character
contract used by the API. Preserve the existing duplicate SQL expression and
add behavioral coverage for names at the 119- and 120-character boundaries.

### Overflow and preview

Keep full field values available for save. Report requirement/benefit items
past the four-item visual limit in an `aria-live` editor status and in the
preview metadata without silently losing them. Detect the known list overflow
and measurable text clipping in the rendered card; show the responsible area
and refuse PNG capture until it is corrected.

Constrain the preview frame and canvas to their available container with
`min-width: 0`, bounded width, preserved aspect ratio, and safe overflow
handling. Reapply container-dependent birthday sizing on resize. Do not rely on
global page `overflow-x: hidden` as proof that the card fits. Abort export when
the rendered bounds are not positive.

## Error handling

- Failed media validation or loading leaves a safe placeholder or the previous
  confirmed image and an actionable status message.
- Pending media, zero-sized preview bounds, detected overflow, and stale export
  generations never produce a downloaded PNG.
- Save failures restore controls and keep the dirty draft visible.
- Stale history/search/filter/edit responses are discarded without replacing
  newer content or opening an obsolete card.
- Existing authenticated, audited API boundaries and advisory locks remain
  unchanged.

## Verification

Extend `tests/unit/autocard-invariants.test.mjs` with the smallest behavioral
harness additions needed for:

- keyboard upload, same-file retry, media states, replacement failure, and
  pending-media export rejection;
- dirty navigation and `beforeunload` protection;
- stale save, history, media, and export responses after document changes;
- history query parameters, stable ordering, pagination controls, stale pages,
  and empty-page recovery;
- duplicate-name boundaries and manual name validation;
- explicit vacancy overflow and export blocking;
- preview bounds and birthday/container resize behavior at desktop and mobile
  contract sizes.

Run the focused AutoCard test, `npm test`, `npm run verify`, and
`git diff --check`. No browser, PostgreSQL, Nginx, SMTP, or external service
validation is claimed by these local checks.

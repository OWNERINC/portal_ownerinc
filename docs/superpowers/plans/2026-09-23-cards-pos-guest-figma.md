# Cards Pós Guest Figma Implementation Plan

**Goal:** Match the approved Convidado Frame 1 while retaining the existing editor and PDF workflow.

**Architecture:** Adjust the existing Guest renderer and scoped CSS. Reuse local
photo, logo and font assets; scale from the 1448 × 2347 reference. Use existing
JSON default merging for salutation compatibility and a fixed Guest export size.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, html2canvas 1.4.1, jsPDF 2.5.1, Node tests.

## Constraints

- Preserve the current page lifecycle and safe rich-text pipeline.
- Keep the Owner composition and the 108 × 175.1 mm Guest PDF size.
- Preserve saved values and uploaded-photo precedence.
- No new application dependencies, database changes or deployment changes.

## Task 1 — Guest renderer and editor

Files: `public/cards-pos/app.js`, `public/cards-pos.html`, local font assets.

- [x] Add `salutation: 'Olá, Nome Sobrenome.'` to Guest defaults and a single-line
  `data-field="salutation"` editor, using the existing `loadValues` merge.
- [x] Point the default Guest cover to the existing Club House photo. Render the
  official `owntime-logo-white.webp` in a cropped wordmark container, replacing
  the Guest signature text editor. Keep the JSON `heroBrand` for old saved names.
- [x] Render salutation before greeting; use `<em>on demand</em>` in new defaults.
- [x] Keep `current.mediaUrl || GUEST_COVER_ASSET`, sanitization and footer phone
  editing. Use fixed Guest export bounds `{ width: 1448, height: 2347 }` and scale
  1 for that export; preserve existing Owner export bounds and scale.

## Task 2 — Reference composition

File: `public/cards-pos/styles.css`.

- [x] Scope changes to `.guest-card`. Set Raleway and card-relative lengths;
  `32 / 1448 * 100` gives `2.20994cqw` for body text.
- [x] Match photo crop, overlay, two-line title, wordmark and separator.
- [x] Set the broad benefits block independently from inner text margins.
  Match salutation, stay line spacing, justified copy, bold address and footer.
- [x] Use local Raleway regular/bold italic faces and check all fonts load.
- [x] Ensure the default composition fits without the overflow scale shrinking
  it. Retain existing overflow handling for longer custom content.

## Task 3 — Verification

Files: `tests/unit/pos-cards-frontend.test.mjs`, this plan and the matching spec.

- [x] Update affected field/layout contracts and add a runnable check for Guest
  defaults, safe salutation rendering, logo/photo selection and saved values.
- [x] Run `node --test tests/unit/pos-cards-frontend.test.mjs`.
- [x] Inspect the real local page at desktop and mobile sizes; capture the card
  and exported PDF, check dimensions and compare their visual composition.
- [x] Check edited salutation, contact, saved invitations and Owner rendering.
- [x] Run `npm run verify` and `git diff --check`; record actual results.

Execution: inline in the current session, as requested by the user's approval.

## Verification evidence

- Focused Node checks: 18 passed; full `npm run verify`: 508 passed.
- Chromium smoke used actual HTML, module, lifecycle, assets and PDF libraries
  served at localhost:8080, with an isolated in-memory API for history/save checks.
  It exercised 1440 px desktop and 390/320 px mobile viewports, editable salutation
  and phone, old saved values, default merging, save naming and Owner rendering.
- Real Guest PDF downloads contain one 108 × 175.1 mm page. Their 1448 × 2347 PNG
  content was byte-identical across the three viewports. Default copy required
  no fit/shrink transform at any tested width.
- The authenticated OpenChamber browser also loaded the updated Guest editor.
- Visual inspection caught html2canvas ignoring `object-fit`; Guest now paints a
  CSS background with cover sizing, retaining an invisible img for load/decode
  validation. The footer mask no longer covers the phone/email separator.
- Independent read-only review found no blocking issues and reran all 18 focused
  checks successfully.

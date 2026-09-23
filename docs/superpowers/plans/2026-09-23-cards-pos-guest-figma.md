# Cards Pós Guest Figma Implementation Plan

**Goal:** Match the approved Convidado Frame 1 while retaining the existing editor and PDF workflow.

**Architecture:** Adjust the existing Guest renderer and scoped CSS. Reuse local
photo, logo and font assets; scale from the 1448 × 2347 reference. Use existing
JSON default merging for salutation compatibility and a fixed Guest export size.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, html2canvas 1.4.1, jsPDF 2.5.1, Node tests.

## Constraints

- Preserve existing authentication, safe rich text, saved values and uploaded photos.
- Keep the Owner composition and the 108 × 175.1 mm Guest PDF size.
- No new application dependencies, database changes or deployment changes.

## Implementation

- [x] In `public/cards-pos/app.js`, add the Guest salutation default, official
  wordmark, Club House photo, italic `on demand` and fixed Guest export resolution.
- [x] In `public/cards-pos.html`, expose salutation editing and remove the Guest
  signature text control. Retain legacy JSON `heroBrand` for saved-card naming.
- [x] In `public/cards-pos/styles.css`, scope the reference composition to Guest:
  Raleway 32 proportional to the frame, title, photo crop, wide beige benefits,
  address, logo and footer. Add the two local italic font faces.
- [x] Paint the Guest photo using background cover, supported by html2canvas,
  while retaining an invisible img for load/decode validation.
- [x] Update matching documentation and runnable tests for salutation,
  sanitization, saved values, uploaded-photo precedence and PDF size/resolution.
- [x] Validate this isolated branch with `npm run verify`, `git diff --check`,
  and actual browser/PDF checks at desktop and mobile sizes.

## PR isolation

The user requested a PR for this feature. This branch starts from `origin/main`
at `f29aaaf` and carries only Guest changes. It uses the existing standalone
`requirePosCards()` entrypoint, not the unrelated navigation/router work in the
original checkout. The clean branch baseline passed all 439 Node tests.

## Verification evidence

- `npm run verify`: 441 tests passed, including 18 focused Cards Pós checks;
  syntax, security and Compose checks passed. `git diff --check` is clean.
- Chromium loaded the exact worktree HTML, standalone module, CSS and local
  assets via request interception, with authentication and history/save API
  responses stubbed in memory. No production data was written.
- Desktop (1440 px) and mobile (390/320 px): the default composition required
  no content-shrink transform. Edited salutation and phone, reloaded a legacy
  card and saved it while retaining its name and existing rich text.
- Real html2canvas/jsPDF downloads contained one 108 × 175.1 mm page and a
  1448 × 2347 PNG; that PNG was byte-identical across all three viewport sizes.
  Guest and Owner screenshots were captured for visual inspection.

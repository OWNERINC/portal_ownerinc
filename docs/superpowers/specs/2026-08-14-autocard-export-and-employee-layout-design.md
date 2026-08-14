# AutoCard Export and Employee Layout Design

**Date:** 2026-08-14
**Status:** Awaiting user review

## Goal

Make AutoCard PNG exports preserve the preview geometry and readable quality,
while redesigning the `novo_funcionario` card so its content stays inside the
card and leaves more room for the collaborator description.

## Scope

This change covers:

- the browser PNG export path in `public/autocard/app.js`;
- the `novo_funcionario` card markup and styles;
- the AutoCard footer copy and logo asset;
- focused regression checks for export geometry and employee layout contracts.

The AutoCard remains a square `1080 × 1080 px` export. Other templates keep
their current visual composition unless they use the shared export behavior.

## Employee Card Layout

The `novo_funcionario` template changes from a side-by-side composition to an
internal stacked composition:

1. The photo occupies an upper band of approximately 38–40% of the card height.
2. The content panel occupies the remaining space and uses the full card width.
3. The name is smaller than the current fixed `30px` treatment and can wrap
   across multiple lines without escaping its content box.
4. The kicker, name, role, start date, and description use reduced type sizes
   and safe wrapping rules.
5. The description receives the available flexible space and is clipped only
   inside its own content area when the configured field is too long.
6. The footer is a separate flex region anchored after the description, so it
   cannot overlap or push text outside the card.

The card must remain stable at desktop and mobile preview widths. The preview
and exported PNG must render the same layout because export captures the
already-laid-out DOM rather than rebuilding the card with different geometry.

## Copy and Brand Asset

The employee footer copy changes from `Bem-vindo(a) à Ownerinc` to exactly
`Bem-vindo(a)`.

The footer logo changes from the complete logo to the wordmark-only assets:

- source: `C:\Ownerinc\global assets\Logos\logo simples preto.webp`;
- source: `C:\Ownerinc\global assets\Logos\logo simples  branco.webp`;
- project targets: `public/assets/ownerinc-wordmark-black.webp` and
  `public/assets/ownerinc-wordmark-white.webp`.

The wordmark keeps its intrinsic aspect ratio with `width`/`height` constraints
that prevent stretching. The complete logo remains available for unrelated
Portal surfaces and is not replaced globally.

## Export Contract

`exportCard()` must derive both capture dimensions from the rendered card
rectangle instead of forcing `height` to equal `width`.

- Wait for `document.fonts.ready` when available.
- Wait for the card image to decode before capture.
- Read both rendered width and height from `getBoundingClientRect()`.
- Use a target width of `1080px` and derive target height from the rendered
  aspect ratio.
- Pass the rendered CSS width and height to `html2canvas`.
- Set the capture scale from the target width divided by rendered CSS width.
- Keep PNG output lossless and preserve the original image crop and aspect
  ratio.

The export path must not use CSS stretching as a quality workaround. A source
image smaller than the pixels needed for its crop cannot be made sharper by
the browser; the change must preserve all available source detail and avoid
introducing additional distortion or unnecessary downsampling.

## Error Handling

- If fonts are unavailable, use the existing browser fallback and continue.
- If the card image has not loaded or cannot be decoded, keep the existing safe
  toast and do not download a partial PNG.
- If capture fails, restore the export button state and show the existing safe
  error toast.
- Long names and descriptions remain contained within the employee card; they
  must never create horizontal page overflow or overlap the footer.

## Verification

Add focused checks for:

- export options using both rendered width and rendered height;
- target scale based on the rendered width;
- font readiness and image decode sequencing;
- employee card stacked layout and full-width content panel;
- safe wrapping for long collaborator names;
- description containment and footer separation;
- exact `Bem-vindo(a)` copy;
- wordmark-only light/dark asset paths;
- no stretching rules on the employee image or footer logo.

Run `npm test`, `npm run verify`, the focused AutoCard tests, and
`git diff --check` before publication.

# Cards Pós — Convidado / Frame 1

Status: approved by the user on 2026-09-23.

## Reference

- Figma: https://www.figma.com/design/pVf2pWFXaScDvhlUxSYOaw/?node-id=2-2
- User-supplied `Frame 1 (3).png` supersedes `Frame 1 (2).png` as the visual acceptance reference.
- Raleway 32 for body text in the 1448 × 2347 design coordinate system.
- Keep the existing 108 × 175.1 mm PDF format.

## Composition

Use the accommodation photo already stored at
`public/cards-pos/assets/guest/guest-cover.jpg`, aligned to the top with the dark
overlay. Use the official white Owntime wordmark from the existing local WebP;
crop the separate Home Club Gramado tagline out of the visible logo. Keep the
title and bold italic subtitle editable, with the official logo fixed.

Add an editable salutation, defaulting to `Olá, Nome Sobrenome.`. Match the
reference body margins, justified introduction, spacious stay information, wide
rounded beige benefits block, and black contact footer. Only the address label
`Como chegar:` is bold; the address itself is regular. Use genuine local Raleway
italic for the subtitle.

The revised copy is `Um convite` / `a viver o seu tempo`, the introduction reads
`Você é nosso convidado para viver uma experiência no` before the bold Owntime
name, and the last benefits paragraph reads `Alimentação, bebidas e serviços sob
demanda serão cobrados à parte.` in regular type. The revised frame increases
the gap before stay information, uses a 50 px stay line-height in design units,
and widens the benefits text area with 112 px horizontal padding.

Scale the composition with the card rather than the browser viewport. Render
Guest PDF exports at a stable design resolution, with loaded images and fonts,
so desktop and mobile downloads have the same composition and quality.

## Compatibility and scope

Changes belong to the Guest template, its editor fields, local assets and checks.
Retain stored rich text, uploaded photos, saved names and historical JSON keys.
Missing salutation fields receive the new default; stored values are not
rewritten. The legacy Guest `heroBrand` remains readable for naming saved cards,
but the visible brand becomes the official image. Use the existing safe rich-text
and media pipeline. No API or database migration is needed.

## Acceptance

Compare the card with the supplied image at matching dimensions. Check desktop
and mobile proportions, complete content, real font loading, editable salutation,
old saved invitations, uploaded-image precedence, phone changes, and actual PDF
page size and appearance. Recheck the Owner template. Run the focused Cards Pós
tests, `npm run verify`, and `git diff --check`.

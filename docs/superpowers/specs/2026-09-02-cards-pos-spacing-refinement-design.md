# Cards Pos Spacing Refinement

Date: 2026-09-02

## Goal

Refine the vertical rhythm of the Guest and Owner Cards Pos so related blocks do
not appear visually glued together. The immediate issue is the missing space
between `Consumos da hospedagem` and `O que não está incluso` in the Guest card.

## Scope

- Keep the Guest card at `108 x 175.1 mm`.
- Keep the Owner card at `108 x 290.6 mm`.
- Preserve all existing copy, editable fields, images, proportions, and PDF
  export behavior.
- Adjust CSS spacing only, reusing the existing card structure and tokens where
  they already express the intended rhythm.
- Add explicit bottom spacing to the Guest `.inline-copy` block.
- Review the surrounding Guest block margins and Owner section spacing for the
  same visual problem, changing only the smallest necessary values.

## Non-goals

- No JavaScript changes.
- No API, database, authentication, history, or save-flow changes.
- No typography, card dimensions, content, or asset changes.
- No new dependency or layout abstraction.

## Implementation

The change will be localized to `public/cards-pos/styles.css`. The spacing rule
for the Guest consumption line will be explicit instead of relying on the
existing `.rich-copy` margins, because `.inline-copy` is a regular `div`.
Nearby Guest and Owner margins will be adjusted only if inspection shows an
adjacent block with the same missing rhythm. The existing `fitCardBody()`
overflow guard remains the final safety net and is not changed.

## Validation

- Run `node --test tests/unit/pos-cards-frontend.test.mjs`.
- Run `npm run verify`.
- Run `git diff --check`.
- Confirm the static contracts for both card dimensions and the direct PDF
  exporter remain unchanged.
- Review the diff to ensure only the intended CSS and matching test/document
  updates are included.

## Success Criteria

- The Guest card has visible separation between the consumption copy and the
  following heading.
- The Owner card keeps a balanced vertical rhythm without introducing clipping.
- Existing editor, history, and export behavior remain unchanged.

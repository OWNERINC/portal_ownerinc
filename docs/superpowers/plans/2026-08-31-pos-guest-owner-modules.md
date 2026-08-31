# Cards Pos Guest and Owner Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second editable Owner card based on Figma frame 2, with a visible switch between the existing Guest card and the new Owner card, while preserving all existing Guest cards.

**Architecture:** Keep one authenticated `Cards Pos` page and one API namespace. Represent the two modules as two persisted template values: the existing `convite_owntime` for guests and a new `convite_owner` for Owners. Reuse authentication, image upload, history, CRUD, duplication, and PDF export; isolate only the Owner field schema and renderer.

**Tech Stack:** Static HTML, browser ES modules, CSS, Express, PostgreSQL migrations, Node test runner, existing `fetchAPI`/`fetchAPIPage` helpers, browser `window.print()` export.

## Global Constraints

- Keep `public/cards-pos.html` as the only page for both modules.
- Preserve the existing `convite_owntime` payload, rendering, stored records, and export behavior.
- Use `convite_owner` as the persisted template identifier for the Owner module.
- Keep all Owner text blocks editable through labeled `<input>` or `<textarea>` controls.
- Keep image uploads authenticated, normalized to WebP, and stored in `pos_card_media`.
- Keep the existing `admin` access bypass and `/api/pos-cards/*` authorization boundary.
- Do not add a frontend framework or a new dependency.
- Keep Node 18 compatibility and preserve the `api/`, `public/`, `cron/`, and `nginx/` boundaries.
- Run `npm run verify` and `git diff --check` before publication.

## File Map

Modify these existing files:

- `public/cards-pos.html`: module switch and Owner editor controls.
- `public/cards-pos/app.js`: module state, field loading, Owner rendering, save/edit/history behavior.
- `public/cards-pos/styles.css`: Owner frame-2 layout, responsive behavior, print sizing, and switch styling.
- `api/routes/pos-cards.js`: accept and return both template identifiers; preserve media and CRUD behavior.
- `api/db/schema.sql`: allow `convite_owner` in the fresh-install template constraint.
- `api/db/verify-migrations.js`: register and verify the new migration/template constraint.
- `tests/unit/pos-cards-api-invariants.test.mjs`: API/template/validation invariants.
- `tests/unit/pos-cards-frontend.test.mjs`: switch, editable fields, renderer, history, and export invariants.
- `tests/unit/schema-invariants.test.mjs`: fresh schema and migration checks.
- `docs/product/feature-inventory.md`: document the two modules and Owner status.
- `CHANGELOG.md`: record the new Guest/Owner module switch.

Create this migration:

- `api/db/migrations/023_pos_owner_cards.sql`: expand the existing `pos_cards.template` constraint from one value to two values without changing stored Guest rows.

## Task 1: Lock the data contract

**Files:**
- Create: `api/db/migrations/023_pos_owner_cards.sql`
- Modify: `api/db/schema.sql:99-108`
- Modify: `api/db/verify-migrations.js:10-110`
- Test: `tests/unit/schema-invariants.test.mjs`

**Interfaces:**
- Existing template: `convite_owntime`.
- New template: `convite_owner`.
- Existing cards must remain valid without data migration.

- [ ] **Step 1: Add the failing schema assertions**

Add assertions that the fresh schema and migration ledger contain `023_pos_owner_cards`, and that the `pos_cards.template` constraint accepts both `convite_owntime` and `convite_owner`.

- [ ] **Step 2: Run the focused schema test**

Run: `node --test tests/unit/schema-invariants.test.mjs`

Expected: FAIL because the migration and fresh schema still allow only `convite_owntime`.

- [ ] **Step 3: Add the migration**

Implement `023_pos_owner_cards.sql` by replacing the existing `pos_cards_template_check` constraint with a constraint that accepts exactly:

```sql
('convite_owntime', 'convite_owner')
```

Do not update or copy any existing card rows.

- [ ] **Step 4: Update the fresh schema and migration verifier**

Update `api/db/schema.sql` with the same two-value constraint. Add `023_pos_owner_cards` to the expected migration ledger and verify that the live constraint includes both values.

- [ ] **Step 5: Run the focused schema test again**

Run: `node --test tests/unit/schema-invariants.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the contract change**

```sh
git add api/db/migrations/023_pos_owner_cards.sql api/db/schema.sql api/db/verify-migrations.js tests/unit/schema-invariants.test.mjs
git commit -m "feat: add owner cards template"
```

## Task 2: Expand API validation and CRUD

**Files:**
- Modify: `api/routes/pos-cards.js:1-245`
- Test: `tests/unit/pos-cards-api-invariants.test.mjs`

**Interfaces:**
- `POST /api/pos-cards/cards` accepts `template: 'convite_owntime' | 'convite_owner'`.
- `PUT /api/pos-cards/cards/:id` accepts the same union.
- List, read, and duplicate responses preserve the stored template.
- Media endpoints remain unchanged.

- [ ] **Step 1: Add failing API invariants**

Cover these exact cases:

```js
assert.match(source, /convite_owntime/);
assert.match(source, /convite_owner/);
assert.match(source, /template/);
assert.doesNotMatch(source, /template === 'convite_owntime'/);
```

Also assert that duplicate SQL selects and returns the original template instead of hardcoding a Guest template.

- [ ] **Step 2: Run the focused API test**

Run: `node --test tests/unit/pos-cards-api-invariants.test.mjs`

Expected: FAIL because the route currently accepts and duplicates only `convite_owntime`.

- [ ] **Step 3: Update the route allowlist**

Change the route template set to contain exactly `convite_owntime` and `convite_owner`. Keep the existing name, JSON-size, UUID, and media validation unchanged.

- [ ] **Step 4: Preserve template during duplication**

Change the duplicate insert to select `template` from the source row. Keep the existing name truncation, creator assignment, lock, audit action, and media reference behavior.

- [ ] **Step 5: Run the focused API test again**

Run: `node --test tests/unit/pos-cards-api-invariants.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the API contract**

```sh
git add api/routes/pos-cards.js tests/unit/pos-cards-api-invariants.test.mjs
git commit -m "feat: support owner cards in pos api"
```

## Task 3: Add the module switch and editable Owner form

**Files:**
- Modify: `public/cards-pos.html:55-117`
- Modify: `public/cards-pos/app.js:4-70,245-279`
- Modify: `public/cards-pos/styles.css`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- Module buttons use `data-module="guest"` and `data-module="owner"`.
- Frontend state uses `current.template` with values `convite_owntime` or `convite_owner`.
- `switchModule(template)` changes the active form and renderer without navigating or losing unsaved values for the other module.

- [ ] **Step 1: Define the Owner field contract in the failing test**

Require these editable Owner fields, each with a matching `data-field`:

```text
heroTitle
heroEmphasis
heroBrand
recipientName
greeting
stayInfo
experienceTitle
experienceBody
notIncludedTitle
notIncludedBody
consumptionTitle
gasInfo
waterInfo
energyInfo
accommodationTitle
accommodationBody
servicesTitle
servicesBody
conditions
contact
```

Require the switch labels `Convidado` and `Owner`, and require the existing Guest field names to remain present.

- [ ] **Step 2: Run the focused frontend test**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: FAIL because the page has one form and no Owner fields or module switch.

- [ ] **Step 3: Add the accessible module switch**

Add a two-button control to the Cards Pos toolbar. Each button must be a real button, expose `aria-pressed`, and visibly identify the active module. Keep the current Guest module active by default so existing users see the current behavior first.

- [ ] **Step 4: Add the Owner form fields**

Add a dedicated Owner fieldset group using the exact `data-field` names above. Use labels in Portuguese that describe each visible block, use textareas for multi-line content, and keep the fields hidden when Guest is active. Keep the current Guest form markup and field names unchanged.

- [ ] **Step 5: Add isolated module state**

Store both value objects in frontend state:

```js
current = {
  template: 'convite_owntime',
  values: { ...guestDefaults },
  ownerValues: { ...ownerDefaults },
  mediaId: null,
  mediaUrl: '',
  editingId: null,
  name: '',
};
```

When switching modules, preserve the inactive module's unsaved values, update the active form controls, and re-render only the selected card. Do not upload or delete media during a module switch.

- [ ] **Step 6: Wire input events and active state**

Update initialization so inputs write into the active value object, module buttons update `aria-pressed`, the correct fieldsets are shown, and the status text remains available to screen readers.

- [ ] **Step 7: Run the focused frontend test again**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: PASS for the module switch and editable-field contract.

- [ ] **Step 8: Commit the editor contract**

```sh
git add public/cards-pos.html public/cards-pos/app.js public/cards-pos/styles.css tests/unit/pos-cards-frontend.test.mjs
git commit -m "feat: add guest and owner card switch"
```

## Task 4: Implement the Owner frame-2 renderer

**Files:**
- Modify: `public/cards-pos/app.js:36-61`
- Modify: `public/cards-pos/styles.css`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- `render()` selects the renderer from `current.template`.
- Guest rendering remains the current `hero`, `card-body`, and footer structure.
- Owner rendering produces one vertical card matching Figma frame 2: image/header, editorial body sections, dense information blocks, and dark footer with Owntime, Ownerinc, and Casa marks where assets exist.

- [ ] **Step 1: Add failing renderer invariants**

Require the source to contain an Owner branch and all Owner field references. Require the Owner renderer to escape every value with `esc()` and to render the fixed brand assets separately from editable text.

- [ ] **Step 2: Run the focused frontend test**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: FAIL because `render()` currently renders only the Guest composition.

- [ ] **Step 3: Add the Owner render branch**

Render the Owner card from the Owner values with this order:

1. Header image and cover copy using `heroTitle`, `heroEmphasis`, and `heroBrand`.
2. Greeting and recipient using `recipientName` and `greeting`.
3. Stay information using `stayInfo`.
4. Experience section using `experienceTitle` and `experienceBody`.
5. Exclusions section using `notIncludedTitle` and `notIncludedBody`.
6. Consumption section with labeled `gasInfo`, `waterInfo`, and `energyInfo` columns.
7. Accommodation and included services using the corresponding title/body fields.
8. Conditions and contact.
9. Fixed footer logos and the same dark footer treatment from frame 2.

Use `esc()` for every editable value and preserve line breaks with CSS `white-space: pre-line`.

- [ ] **Step 4: Add responsive and print layout rules**

Keep the Owner card at the existing `108mm × 192mm` print geometry. Use CSS grid/flex for the information columns, allow long text to wrap inside its own section, and prevent horizontal overflow. On narrow screens, stack the consumption columns while keeping the printed card unchanged.

- [ ] **Step 5: Add visual regression contracts**

Assert that Owner rendering contains the Owner sections, uses the frame-2 footer assets, keeps the Guest renderer intact, and retains the existing print preparation path.

- [ ] **Step 6: Run the focused frontend test again**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the Owner renderer**

```sh
git add public/cards-pos/app.js public/cards-pos/styles.css tests/unit/pos-cards-frontend.test.mjs
git commit -m "feat: render editable owner card"
```

## Task 5: Connect save, edit, duplicate, and history to both modules

**Files:**
- Modify: `public/cards-pos/app.js:63-243`
- Modify: `public/cards-pos.html:119-126`
- Modify: `public/cards-pos/styles.css`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- Save payload is `{ name, template, values, mediaId }`.
- Existing Guest records load into the Guest module.
- Owner records load into the Owner module.
- History items display whether they are `Convidado` or `Owner`.

- [ ] **Step 1: Add failing persistence assertions**

Cover these cases:

```js
assert.match(source, /template: current\.template/);
assert.match(source, /convite_owner/);
assert.match(source, /card\.template/);
assert.match(source, /Owner/);
```

Require that the edit flow chooses the module from the stored template and that history does not hardcode the Guest label.

- [ ] **Step 2: Run the focused frontend test**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: FAIL because save hardcodes `convite_owntime` and edit/load assumes Guest values.

- [ ] **Step 3: Make save template-aware**

Send `current.template` and the active module's values. Preserve the existing prompt, loading state, error status, media lock, POST/PUT selection, and saved name behavior.

- [ ] **Step 4: Make edit template-aware**

After fetching a card, set `current.template` from the stored template, load values into the correct fieldset, load the existing media, render the selected module, and show the editor. Reject an unknown template with the existing error status instead of rendering an empty card.

- [ ] **Step 5: Label history entries**

Show `Convidado` for `convite_owntime` and `Owner` for `convite_owner`. Keep search, pagination, duplicate, and delete behavior unchanged.

- [ ] **Step 6: Preserve duplicate behavior**

The API preserves the source template; after refresh, the duplicated item must appear with the same module label and open in the correct editor.

- [ ] **Step 7: Run the focused frontend test again**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit persistence integration**

```sh
git add public/cards-pos.html public/cards-pos/app.js public/cards-pos/styles.css tests/unit/pos-cards-frontend.test.mjs
git commit -m "feat: persist both pos card modules"
```

## Task 6: Verify media, PDF export, accessibility, and security boundaries

**Files:**
- Modify: `tests/unit/pos-cards-api-invariants.test.mjs`
- Modify: `tests/unit/pos-cards-frontend.test.mjs`
- Modify: `tests/unit/api-security.test.mjs`
- Modify: `tests/unit/cron.test.mjs`
- Modify: `public/cards-pos.html`
- Modify: `public/cards-pos/app.js`

**Interfaces:**
- Both templates use `/api/pos-cards/media` and `/api/pos-cards/media/:id`.
- Both templates use the existing print export path.
- Both templates remain behind `authMiddleware` and `requirePosCards`.

- [ ] **Step 1: Add security and lifecycle assertions**

Require that no new public upload path is introduced, both template values remain under `/api/pos-cards`, media remains escaped/authenticated, and cron cleanup still targets `pos_card_media` without a new storage namespace.

- [ ] **Step 2: Add export and accessibility assertions**

Require the Owner module switch to use `aria-pressed`, Owner inputs to have labels, `status` to remain `aria-live`, `window.print()` to remain the export mechanism, and print preparation to run before printing.

- [ ] **Step 3: Run focused security and lifecycle tests**

Run: `node --test tests/unit/api-security.test.mjs tests/unit/cron.test.mjs tests/unit/pos-cards-api-invariants.test.mjs tests/unit/pos-cards-frontend.test.mjs`

Expected: PASS.

- [ ] **Step 4: Run the full verification suite**

Run: `npm run verify`

Expected: PASS with no migration, syntax, shell, or secret checks failing.

- [ ] **Step 5: Check the diff**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Commit verification updates**

```sh
git add tests/unit/api-security.test.mjs tests/unit/cron.test.mjs tests/unit/pos-cards-api-invariants.test.mjs tests/unit/pos-cards-frontend.test.mjs public/cards-pos.html public/cards-pos/app.js
git commit -m "test: verify guest and owner card modules"
```

## Task 7: Update product documentation and perform visual acceptance

**Files:**
- Modify: `docs/product/feature-inventory.md:52-61`
- Modify: `CHANGELOG.md:10-35`

- [ ] **Step 1: Document the two modules**

Update the Cards Pos inventory to state that the page contains two modules: the existing editable Guest invitation and the editable Owner card based on Figma frame 2. Document that both share history, media handling, CRUD, and PDF export while using separate template identifiers.

- [ ] **Step 2: Document compatibility**

State that existing `convite_owntime` rows remain unchanged and that `convite_owner` is introduced by migration `023_pos_owner_cards`.

- [ ] **Step 3: Add the changelog entry**

Record the new Guest/Owner switch, editable Owner fields, shared history, and preserved Guest behavior.

- [ ] **Step 4: Run a browser acceptance pass**

With the local stack available, verify at desktop and mobile widths:

1. Guest is selected by default and matches the current card.
2. Switching to Owner changes the form and preview without navigation.
3. Every Owner text field updates the preview immediately.
4. Uploading an image updates the correct header image.
5. Saving and reopening an Owner card restores its module and values.
6. Duplicating an Owner card keeps it as Owner.
7. Guest cards still open as Guest.
8. PDF export does not overflow horizontally or overlap the footer.

- [ ] **Step 5: Run final checks**

Run:

```sh
npm run verify
```

Expected: both commands pass.

## Acceptance Criteria

- The Cards Pos page exposes exactly two modules: `Convidado` and `Owner`.
- `Convidado` remains the default and existing saved Guest cards render unchanged.
- `Owner` renders the Figma frame-2 composition inside the existing preview and print flow.
- Every Owner text block visible in the design has an editable labeled field.
- Owner values update the preview without a page reload.
- Owner cards save as `convite_owner`; Guest cards remain `convite_owntime`.
- History identifies each card's module and reopens it in the correct editor.
- Duplicate preserves the source module and media reference.
- Media remains private through the authenticated Cards Pos route.
- Existing authorization, audit, cleanup, pagination, and export behavior remain intact.
- `npm run verify` and `git diff --check` pass.

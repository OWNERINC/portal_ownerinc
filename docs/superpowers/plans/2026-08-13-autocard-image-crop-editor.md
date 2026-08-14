# AutoCard Image Crop Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated AutoCard image crop editor with drag, zoom, reset, cancel/apply, and persisted framing for the `Aniversariante` and `Novo funcionário` templates.

**Architecture:** Keep the original private media unchanged and store a normalized `{ x, y, zoom }` crop on each card. A small browser crop utility owns normalization and drag math; the existing AutoCard app owns modal state and applies CSS variables to every rendered image, so history, variants, and PNG export reuse the same loaded `blob:` image and crop.

**Tech Stack:** Vanilla HTML/CSS/JavaScript modules, Firebase-authenticated `fetchAPI`, Express, PostgreSQL JSONB migration, Node built-in test runner, existing `npm run verify` checks.

## Global Constraints

- Keep AutoCard media private and require authentication for `/api/autocard/media/:id`.
- Do not add a frontend framework, router, storage service, or dependency.
- Keep AutoCard API routes, authorization rules, schema, editor controls, and public behavior unchanged except for the crop data and controls required by this feature.
- Revoke replaced/stale blob URLs and release the current URL on page hide.
- Preserve upload, save, history, edit, duplicate, delete, filters, variants, responsive rendering, and PNG export.
- Cover only `aniversariante` and `novo_funcionario` in this first implementation.
- Store normalized `x` and `y` in the range `0..1`; store `zoom` in the range `1..3`.
- Treat missing or null crop data as centered `{ x: 0.5, y: 0.5, zoom: 1 }` for old cards; reject malformed or out-of-range API crop payloads.
- Persist `media_crop` as non-null with the centered default through migration `012_autocard_media_crop` and the fresh-install schema.
- Grant `portal_cron` only `SELECT` on `autocard_cards`, `SELECT, DELETE` on `autocard_media`, and `SELECT, INSERT, UPDATE, DELETE` on `audit_log` for retention.
- Serialize AutoCard card mutations and orphan cleanup with shared advisory lock `7193003`.
- Enable the production `notifications` Compose profile in every deployment command, including one-shot and rollback paths.
- Do not publish, push, or deploy as part of implementation.

## File Map

- Create `api/db/migrations/012_autocard_media_crop.sql` for the forward database change.
- Modify `api/db/schema.sql` so fresh installs match the migration.
- Modify `api/routes/autocard.js` to validate, persist, return, and duplicate `mediaCrop`.
- Modify `api/db/verify-migrations.js`, `scripts/test-migrations.mjs`, and `tests/unit/schema-invariants.test.mjs` for the new migration ledger entry.
- Create `public/autocard/crop.js` for pure crop normalization, bounds, style, and drag math.
- Modify `public/autocard.html` with the crop button and native dialog markup.
- Modify `public/autocard/styles.css` with modal, frame, image, drag, focus, and reduced-motion rules.
- Modify `public/autocard/app.js` with crop state, modal lifecycle, upload opening, rendering, save payload, and crop controls.
- Modify `public/autocard/vacancy-enhancements.js` so the employee variant copies the loaded crop style along with the blob URL.
- Modify `tests/unit/autocard-invariants.test.mjs` for API, crop utility, modal lifecycle, and variant invariants.
- Modify `CHANGELOG.md` with the unreleased crop-editor entry.

---

### Task 1: Persist and validate card crop data

**Files:**
- Create: `api/db/migrations/012_autocard_media_crop.sql`
- Modify: `api/db/schema.sql:53-70`
- Modify: `api/routes/autocard.js:11-63,92-195`
- Modify: `api/db/verify-migrations.js:3-15`
- Modify: `scripts/test-migrations.mjs:15-41`
- Modify: `tests/unit/schema-invariants.test.mjs:5-14`
- Test: `tests/unit/autocard-invariants.test.mjs:197-220`

**Interfaces:**
- Consumes: Existing `autocard_cards` rows and the existing `parseCard()` API boundary.
- Produces: Every card response contains `mediaCrop: { x: number, y: number, zoom: number }`; create/update accept the same object; duplicate copies it.

- [ ] **Step 1: Add failing contract assertions**

Extend the AutoCard invariants and migration invariants to require the new
version, column, validator, and SQL projection:

```js
assert.match(route, /mediaCrop/);
assert.match(route, /media_crop AS "mediaCrop"/);
assert.match(route, /body\.mediaCrop/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS media_crop/);
assert.match(schema, /media_crop JSONB/);
```

Update the expected migration arrays to include
`012_autocard_media_crop.sql` and `012_autocard_media_crop`.

- [ ] **Step 2: Run the focused checks and confirm they fail**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/schema-invariants.test.mjs
```

Expected: FAIL because the migration, schema column, route payload, and
expected ledger entries do not exist yet.

- [ ] **Step 3: Add the forward migration**

Create `api/db/migrations/012_autocard_media_crop.sql` with a centered default,
backfill, non-null column, and object-shape constraint:

```sql
ALTER TABLE autocard_cards
  ADD COLUMN IF NOT EXISTS media_crop JSONB;

UPDATE autocard_cards
SET media_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb
WHERE media_crop IS NULL;

ALTER TABLE autocard_cards
  ALTER COLUMN media_crop SET DEFAULT '{"x":0.5,"y":0.5,"zoom":1}'::jsonb,
  ALTER COLUMN media_crop SET NOT NULL;

ALTER TABLE autocard_cards
  ADD CONSTRAINT autocard_cards_media_crop_check CHECK (
    jsonb_typeof(media_crop) = 'object'
    AND jsonb_typeof(media_crop->'x') = 'number'
    AND jsonb_typeof(media_crop->'y') = 'number'
    AND jsonb_typeof(media_crop->'zoom') = 'number'
  );
```

The migration must remain transactional through the existing migration runner.

- [ ] **Step 4: Match the fresh-install schema**

Add the same `media_crop` column and object-shape constraint to
`api/db/schema.sql` immediately after `media_id`, using the centered default.

- [ ] **Step 5: Add strict route normalization**

In `api/routes/autocard.js`, add constants and a local parser near the existing
template/mode sets:

```js
const defaultMediaCrop = { x: 0.5, y: 0.5, zoom: 1 };
const maxMediaCropZoom = 3;

function parseMediaCrop(value) {
  if (value == null) return { ...defaultMediaCrop };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { x, y, zoom } = value;
  if (![x, y, zoom].every(Number.isFinite)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1 || zoom < 1 || zoom > maxMediaCropZoom) return null;
  return { x, y, zoom };
}
```

Extend `parseCard()` to reject invalid crop data and return `mediaCrop` for
valid or omitted payloads. Include `media_crop AS "mediaCrop"` in list/get and
returning clauses. Add `media_crop` to create/update values and to the
duplicate `SELECT` so crop settings follow the card.

- [ ] **Step 6: Update migration ledgers and tests**

Add `012_autocard_media_crop` to:

- `api/db/verify-migrations.js` `expectedVersions`;
- `scripts/test-migrations.mjs` expected rows;
- `tests/unit/schema-invariants.test.mjs` expected filenames.

Add assertions for the default, backfill, `NOT NULL`, and route persistence
contract. Do not add a second database abstraction.

- [ ] **Step 7: Run the focused checks and migration test**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/schema-invariants.test.mjs
npm run test:migrations
```

Expected: focused tests pass. The migration integration test passes when the
repository's configured PostgreSQL test database is available; if it is not
configured, record that environment limitation rather than changing migration
code.

- [ ] **Step 8: Commit the persistence contract**

```sh
git add api/db/migrations/012_autocard_media_crop.sql api/db/schema.sql api/routes/autocard.js api/db/verify-migrations.js scripts/test-migrations.mjs tests/unit/schema-invariants.test.mjs tests/unit/autocard-invariants.test.mjs
git commit -m "feat: persist AutoCard image crop settings"
```

### Task 2: Add tested crop math and normalization

**Files:**
- Create: `public/autocard/crop.js`
- Modify: `tests/unit/autocard-invariants.test.mjs:12-185`

**Interfaces:**
- Consumes: A crop object and rendered frame/image dimensions.
- Produces: `DEFAULT_MEDIA_CROP`, `normalizeMediaCrop(value)`, `cropStyle(value)`, and `dragMediaCrop(crop, metrics)` for the AutoCard app.

- [ ] **Step 1: Add the pure utility test harness**

Load `public/autocard/crop.js` into the existing VM harness after removing its
ES module export keywords. Assert that the utility exposes the four named
interfaces and add tests for:

```js
assert.deepEqual(normalizeMediaCrop(), { x: 0.5, y: 0.5, zoom: 1 });
assert.deepEqual(normalizeMediaCrop({ x: 2, y: -1, zoom: 8 }), { x: 1, y: 0, zoom: 3 });
assert.deepEqual(normalizeMediaCrop({ x: 'bad' }), { x: 0.5, y: 0.5, zoom: 1 });
```

Test drag direction and no-overflow behavior with deterministic metrics:

```js
const moved = dragMediaCrop({ x: 0.5, y: 0.5, zoom: 2 }, {
  dx: 100,
  dy: 0,
  frameWidth: 200,
  frameHeight: 200,
  imageWidth: 1000,
  imageHeight: 500,
});
assert.ok(moved.x < 0.5);
assert.equal(moved.y, 0.5);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: FAIL because `public/autocard/crop.js` does not exist.

- [ ] **Step 3: Implement the pure crop utility**

Create `public/autocard/crop.js` with no DOM dependencies:

```js
export const DEFAULT_MEDIA_CROP = Object.freeze({ x: 0.5, y: 0.5, zoom: 1 });
export const MEDIA_CROP_ZOOM_MIN = 1;
export const MEDIA_CROP_ZOOM_MAX = 3;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeMediaCrop(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_MEDIA_CROP };
  const x = Number(value.x);
  const y = Number(value.y);
  const zoom = Number(value.zoom);
  if (![x, y, zoom].every(Number.isFinite)) return { ...DEFAULT_MEDIA_CROP };
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    zoom: clamp(zoom, MEDIA_CROP_ZOOM_MIN, MEDIA_CROP_ZOOM_MAX),
  };
}

export function cropStyle(value) {
  const crop = normalizeMediaCrop(value);
  return `--crop-x:${crop.x * 100}%;--crop-y:${crop.y * 100}%;--crop-zoom:${crop.zoom}`;
}

export function dragMediaCrop(value, metrics) {
  const crop = normalizeMediaCrop(value);
  const imageRatio = metrics.imageWidth / metrics.imageHeight;
  const fittedWidth = Math.max(metrics.frameWidth, metrics.frameHeight * imageRatio) * crop.zoom;
  const fittedHeight = Math.max(metrics.frameHeight, metrics.frameWidth / imageRatio) * crop.zoom;
  const overflowX = Math.max(0, fittedWidth - metrics.frameWidth);
  const overflowY = Math.max(0, fittedHeight - metrics.frameHeight);
  return {
    ...crop,
    x: overflowX ? clamp(crop.x - metrics.dx / overflowX, 0, 1) : crop.x,
    y: overflowY ? clamp(crop.y - metrics.dy / overflowY, 0, 1) : crop.y,
  };
}
```

Keep the utility intentionally small; the app supplies pixels and the utility
returns normalized state.

- [ ] **Step 4: Run the crop utility tests**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: PASS for default normalization, clamping, style output, drag
direction, and no-overflow behavior.

- [ ] **Step 5: Commit the pure crop math**

```sh
git add public/autocard/crop.js tests/unit/autocard-invariants.test.mjs
git commit -m "feat: add AutoCard crop math"
```

### Task 3: Add the crop dialog and accessible visual frame

**Files:**
- Modify: `public/autocard.html:72-82,91-92`
- Modify: `public/autocard/styles.css` append crop-editor rules
- Modify: `tests/unit/autocard-invariants.test.mjs:222-284`

**Interfaces:**
- Consumes: The existing editor action area and native `dialog` support.
- Produces: `#cropButton`, `#cropDialog`, `#cropFrame`, `#cropImage`, `#cropZoom`, `#cropReset`, `#cropCancel`, and `#cropApply` DOM contracts for `app.js`.

- [ ] **Step 1: Add failing DOM and CSS assertions**

Require the HTML to contain the crop controls and dialog labels:

```js
assert.match(html, /id="cropButton"/);
assert.match(html, /id="cropDialog"/);
assert.match(html, /id="cropFrame"/);
assert.match(html, /id="cropImage"/);
assert.match(html, /id="cropZoom"/);
assert.match(html, /Ajustar enquadramento/);
assert.match(html, /Aplicar enquadramento/);
```

Require styles for pointer dragging, clipping, focus, and reduced motion:

```js
assert.match(styles, /crop-frame/);
assert.match(styles, /touch-action:none/);
assert.match(styles, /prefers-reduced-motion/);
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Expected: FAIL because the crop DOM and CSS contracts are absent.

- [ ] **Step 3: Add the native dialog markup**

Add an `Ajustar enquadramento` button beside `Adicionar imagem`, initially
hidden. Add a native dialog with the following structure:

```html
<dialog id="cropDialog" aria-labelledby="cropTitle">
  <form method="dialog" class="crop-dialog-form">
    <div class="dialog-heading">
      <h2 id="cropTitle">Ajustar enquadramento</h2>
      <button id="cropClose" type="button" class="close-button" aria-label="Fechar editor de enquadramento">×</button>
    </div>
    <p id="cropHelp">Arraste a imagem para escolher o enquadramento.</p>
    <div id="cropFrame" class="crop-frame" tabindex="0" role="img" aria-label="Prévia do enquadramento">
      <img id="cropImage" class="crop-image" alt="Prévia da imagem">
    </div>
    <label class="crop-zoom" for="cropZoom">Zoom
      <input id="cropZoom" type="range" min="1" max="3" step="0.01" value="1">
    </label>
    <div class="crop-actions">
      <button id="cropReset" type="button" class="secondary-button">Centralizar</button>
      <button id="cropCancel" type="button" class="secondary-button">Cancelar</button>
      <button id="cropApply" type="button" class="primary-button">Aplicar enquadramento</button>
    </div>
  </form>
</dialog>
```

The close button and Escape must use the same cancel path and never submit a
card or alter persisted data.

- [ ] **Step 4: Add responsive and reduced-motion styles**

Append CSS that:

- centers the dialog and keeps it within the viewport;
- clips the crop frame with `overflow:hidden`;
- sets the frame ratio from a CSS custom property;
- makes `.crop-image` fill the frame with `object-fit:cover`;
- applies `object-position:var(--crop-x,50%) var(--crop-y,50%)` and
  `transform:scale(var(--crop-zoom,1))`;
- uses `touch-action:none` and grab/grabbing cursors on the frame;
- preserves visible `:focus-visible` outlines;
- collapses actions and keeps the slider usable below 500 px;
- disables transition/animation under `prefers-reduced-motion: reduce`.

- [ ] **Step 5: Run focused frontend checks**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Expected: PASS for the new DOM/CSS contract; application behavior is completed
in Task 4.

- [ ] **Step 6: Commit the dialog shell**

```sh
git add public/autocard.html public/autocard/styles.css tests/unit/autocard-invariants.test.mjs
git commit -m "feat: add AutoCard crop editor dialog"
```

### Task 4: Integrate upload, drag, zoom, persistence, and variants

**Files:**
- Modify: `public/autocard/app.js:1-45`
- Modify: `public/autocard/vacancy-enhancements.js:40-65`
- Modify: `tests/unit/autocard-invariants.test.mjs:41-185`

**Interfaces:**
- Consumes: `normalizeMediaCrop`, `cropStyle`, `dragMediaCrop` from `./crop.js`; the crop dialog DOM from Task 3; `fetchAPIAsset` from `auth.js`.
- Produces: A confirmed `current.mediaCrop` state used by upload, history, edit, save, duplicate, variants, and export.

- [ ] **Step 1: Extend the VM harness with crop DOM and pointer primitives**

Add deterministic fake elements for the crop dialog, image, frame, range input,
and opener focus. Provide `showModal`, `close`, `open`, `clientWidth`,
`clientHeight`, `naturalWidth`, `naturalHeight`, `setPointerCapture`, and
listener registration. The harness must expose actions for:

```js
harness.selectTemplate('aniversariante', { mediaId: 'photo', mediaCrop: { x: 0.2, y: 0.8, zoom: 2 } });
assert.equal(harness.state().mediaCrop.x, 0.2);
harness.openCrop();
harness.dragCrop(40, 0);
harness.setZoom(2.5);
harness.applyCrop();
assert.equal(harness.state().mediaCrop.zoom, 2.5);
```

Also assert that Cancel leaves the previously confirmed crop unchanged and
Reset returns to `{ x: 0.5, y: 0.5, zoom: 1 }`.

- [ ] **Step 2: Run the lifecycle test and confirm it fails**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: FAIL because `current.mediaCrop`, the modal handlers, and the crop
styles are not integrated.

- [ ] **Step 3: Add crop state and rendering helpers to `app.js`**

Import the crop utility and add the state with centered defaults:

```js
import { DEFAULT_MEDIA_CROP, cropStyle, dragMediaCrop, normalizeMediaCrop } from './crop.js';

let current = {
  template: null,
  values: {},
  icon: null,
  illustration: null,
  mode: 'light',
  mediaSize: 'medium',
  mediaId: null,
  mediaUrl: null,
  mediaCrop: { ...DEFAULT_MEDIA_CROP },
  editingId: null,
  fromHistory: false,
};
```

`selectTemplate()` must normalize `card?.mediaCrop` and keep centered defaults
for old cards. Uploading a new file must reset only `current.mediaCrop` to the
centered default after the media upload succeeds.

Update image markup to include `style="${cropStyle(current.mediaCrop)}"` on the
main media image and birthday image. Do not put `mediaId` or a protected API
URL into an image source.

- [ ] **Step 4: Make media loading open the modal only for a new upload**

Change `loadMedia(mediaId, version)` to accept an `openCrop` boolean defaulting
to `false`. After a successful authenticated load:

1. set `current.mediaUrl`;
2. render the card;
3. reveal `#cropButton`;
4. call `openCropEditor()` only when `openCrop === true`.

Existing cards loaded from history pass `false`; new uploads pass `true`. A
failed load keeps the placeholder, hides the crop button, and never opens the
dialog.

- [ ] **Step 5: Implement the modal draft lifecycle**

Add `cropDraft`, `cropOpener`, and `cropDrag` variables plus these exact
behaviors:

- `openCropEditor()` copies `current.mediaCrop`, sets the frame ratio to `1 / 1`
  for `aniversariante` or `9 / 16` for `novo_funcionario`, assigns the loaded
  blob URL, updates the slider and CSS variables, stores the focused opener, and
  calls `showModal()`.
- Pointer down captures the pointer and stores the starting position and draft.
- Pointer move calls `dragMediaCrop()` using the frame client dimensions and
  crop image natural dimensions, then updates the modal CSS variables.
- Pointer up/lost capture clears the drag state.
- Arrow keys on `#cropFrame` move the image by 8 pixels, or 24 pixels with
  Shift, through the same `dragMediaCrop()` function.
- `#cropZoom` updates only `cropDraft.zoom` until Apply.
- Reset assigns a fresh centered default and updates the preview.
- Apply copies the normalized draft to `current.mediaCrop`, renders the card,
  closes the dialog, and restores focus to the opener.
- Cancel, close, and Escape discard the draft, close the dialog, and restore
  focus without changing `current.mediaCrop`.

- [ ] **Step 6: Persist crop data in save and duplicate flows**

Add `mediaCrop: current.mediaCrop` to the existing save payload. Do not create a
new endpoint. Existing duplicate behavior remains a single `POST` to the
duplicate endpoint; the server copies `mediaCrop` from Task 1.

- [ ] **Step 7: Preserve crop styles in the employee variant**

In `vacancy-enhancements.js`, copy the loaded `.card-media` element rather than
only its source:

```js
const photoElement = cardCanvas.querySelector('.card-media');
const photo = photoElement?.src;
const photoStyle = photoElement?.getAttribute('style') || '';
```

Render the employee image with the generated `photoStyle` only when `photo`
exists. Keep the existing placeholder/icon path when it does not.

- [ ] **Step 8: Run focused tests and inspect the diff**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
git diff --check
```

Expected: all focused tests pass, with no protected API URL in image markup and
no `undefined` media source.

- [ ] **Step 9: Commit the integrated crop editor**

```sh
git add public/autocard/app.js public/autocard/vacancy-enhancements.js tests/unit/autocard-invariants.test.mjs
git commit -m "feat: enable AutoCard image framing"
```

### Task 5: Documentation, full verification, and review

**Files:**
- Modify: `CHANGELOG.md:9-25`
- Modify: `tests/unit/autocard-invariants.test.mjs` if a final invariant is missing

**Interfaces:**
- Consumes: All completed persistence, crop utility, dialog, and app integration tasks.
- Produces: A verified local implementation ready for a separately authorized push/deploy decision.

- [ ] **Step 1: Add the unreleased changelog entry**

Add a concise entry explaining that AutoCard photos now support drag, zoom,
reset, and persisted framing for birthday and new-employee cards while the
original private media remains unchanged.

- [ ] **Step 2: Run the full verification**

Run:

```sh
npm run verify
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
git diff --check
```

Expected:

- `npm run verify` exits with `verify: ok`;
- all focused AutoCard/frontend tests pass;
- `git diff --check` produces no output.

- [ ] **Step 3: Review the complete local diff**

Run:

```sh
git status --short --branch
git log --oneline -8
git diff --stat origin/main..HEAD
git diff --name-status origin/main..HEAD
```

Confirm only the approved crop feature, migration, tests, documentation, and
the earlier unpushed AutoCard commits are present. Confirm no secrets, upload
files, or unrelated product changes are included.

- [ ] **Step 4: Commit the changelog and final verification changes**

```sh
git add CHANGELOG.md tests/unit/autocard-invariants.test.mjs
git commit -m "docs: record AutoCard image framing"
```

- [ ] **Step 5: Stop before publication**

Do not run `git push`, CI actions, production deploys, or live validation in
this plan. Report the local verification result and ask separately before
publishing the feature.

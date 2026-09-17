# AutoCard Task 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden AutoCard media, editor navigation, asynchronous responses, history pagination, overflow reporting, and responsive preview behavior.

**Architecture:** Keep the existing static AutoCard modules and PostgreSQL routes. Reuse `fetchAPIPage`, `renderPagination`, the CMS request-token patterns, and the existing authenticated `blob:` media flow; keep the smallest state helpers in `public/autocard/app.js` instead of introducing a new state module.

**Tech Stack:** Browser JavaScript modules, Express, PostgreSQL, native `dialog`/file APIs, CSS container queries, `html2canvas` 1.4.1, and Node's built-in `node:test` runner.

## Global Constraints

- PNG export preserves the rendered card aspect ratio and scales the rendered width to `1080px`; it is not forced to `1080 × 1080`.
- A replacement image remains visible until the replacement has uploaded and its authenticated blob URL has loaded.
- AutoCard card IDs remain the uniqueness boundary; duplication keeps the length-safe `117 + " v2"` display-name policy.
- Full field values remain saveable, but known visual overflow blocks PNG export.
- Preserve authenticated `blob:` media URLs, the existing crop contract, audit events, and advisory lock `7193003`.
- Keep the complete Portal logo assets unchanged for unrelated surfaces.
- Do not add a frontend framework, queue, service, or dependency.
- Preserve Node 18 compatibility for project code and scripts.
- Preserve the `api/`, `cron/`, `public/`, and `nginx/` boundaries.
- Run `node --test tests/unit/autocard-invariants.test.mjs`, `npm test`, `npm run verify`, and `git diff --check` before publication.

---

## File Map

- `api/routes/autocard.js`: authenticated AutoCard list ordering and invalid image response.
- `public/autocard.html`: upload control, media status, overflow status, and history pagination markup.
- `public/autocard/app.js`: editor snapshot/generation state, media lifecycle, guarded navigation, stale-response checks, history loading, overflow gate, and export gate.
- `public/autocard/vacancy-enhancements.js`: explicit vacancy list overflow metadata without discarding saved values.
- `public/autocard/variant-enhancements.js`: container-resize reapplication for birthday media sizing.
- `public/autocard/styles.css`: bounded preview container, upload/status/pagination/overflow presentation, and mobile rules.
- `tests/unit/autocard-invariants.test.mjs`: focused VM, source, API, race, pagination, overflow, and responsive contracts.
- `CHANGELOG.md`: one concise user-visible AutoCard entry.
- `.superpowers/sdd/2026-09-17-autocard-task-8/task-5-report.md`: tracked verification report for the completed plan task.
- `.superpowers/sdd/2026-09-17-autocard-task-8/progress.md`: local task ledger; keep it out of the production commit unless already tracked by the repository.
- `.superpowers/sdd/2026-09-17-autocard-task-8/task-1-brief.md` through `task-5-brief.md`: generated task-specific acceptance checklists.

### Task 1: Close AutoCard API Boundary Gaps

**Files:**
- Modify: `api/routes/autocard.js:128-150,240-264`
- Modify: `tests/unit/autocard-invariants.test.mjs:792-858`

**Interfaces:**
- `GET /api/autocard/cards` continues to return an array and `X-Total-Count`, but orders equal timestamps by `id DESC` after `updated_at DESC`.
- `POST /api/autocard/media` continues to accept JPEG/PNG/WebP and returns `400` for bytes rejected by `normalizeImage`, deleting any written file on later failure.
- Duplicate names continue to use the existing maximum-length SQL expression and card IDs remain database-generated UUIDs.

- [ ] **Step 1: Add failing API contract assertions**

Extend the existing AutoCard API source test with these exact checks:

```js
assert.match(route, /ORDER BY updated_at DESC, id DESC/);
assert.match(route, /let normalized;[\s\S]*try \{[\s\S]*normalizeImage\(content\)[\s\S]*\} catch \{[\s\S]*return invalid\(req, res\);/);
assert.match(route, /LEFT\(COALESCE\(NULLIF\(BTRIM\(name\), ''\), 'Card'\), 117\) \|\| ' v2'/);
assert.equal(('x'.repeat(119).slice(0, 117) + ' v2').length, 120);
assert.equal(('x'.repeat(120).slice(0, 117) + ' v2').length, 120);
```

Add a fake-pool route test using the existing `api-routes.test.mjs` module pattern. Mount `api/routes/autocard.js`, provide an authorized `x-test-autocard` identity with `job_title_access.autocard: true`, and assert that a malformed image body gets status `400` without a database query. Keep the fake pool isolated to this test file if the existing shared pool cannot represent AutoCard rows.

- [ ] **Step 2: Run the focused test and observe the missing contracts**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/api-routes.test.mjs
```

Expected: the new ordering/normalization assertion fails against the current route, while unrelated tests remain green.

- [ ] **Step 3: Apply the smallest route changes**

Change the card list query to:

```sql
ORDER BY updated_at DESC, id DESC
```

Wrap only `normalizeImage(content)` in a `try/catch` that returns `invalid(req, res)` on malformed bytes, matching `api/routes/pos-cards.js`. Leave content-type `415`, size handling, file cleanup, audit, storage keys, and lock behavior unchanged.

- [ ] **Step 4: Re-run the API contracts**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs tests/unit/api-routes.test.mjs
```

Expected: all focused API and existing AutoCard tests pass, including 119- and 120-character duplicate boundary arithmetic and the malformed-image `400` response.

- [ ] **Step 5: Commit the API boundary change**

```sh
git add api/routes/autocard.js tests/unit/autocard-invariants.test.mjs tests/unit/api-routes.test.mjs
git commit -m "fix: harden AutoCard API contracts"
```

### Task 2: Add Media State and Editor Race Guards

**Files:**
- Modify: `public/autocard.html:75-85,89`
- Modify: `public/autocard/app.js:1-73`
- Modify: `tests/unit/autocard-invariants.test.mjs:163-398,731-754,860-977`

**Interfaces:**
- The upload control is a focusable `button` plus the existing hidden `#imageInput`.
- `#mediaStatus` is a live status region whose text reflects `idle`, `uploading`, `loading`, `ready`, or `error`.
- Editor actions use a document generation token and edit revision; stale results do not mutate the current document.
- `exportCard()` returns without downloading when its captured generation/revision is stale, media is not ready, bounds are non-positive, or overflow is present.

- [ ] **Step 1: Extend the VM harness with deferred API and file controls**

Add to `createAutoCardLifecycleHarness()` a deferred `fetchAPI` queue, an input element with a `files` property and `click()` counter, `window.confirm`, `window.beforeunload` dispatch support, and a `prompt` stub. Expose helpers named `resolveAPI(index, value)`, `rejectAPI(index, error)`, `resolveAsset(index)`, `chooseFile(file)`, `clickUpload()`, `fileInputClicks()`, `fileInputValue()`, `mediaStatus()`, `savedList()`, `setPrompt(value)`, `saveCard()`, `loadSaved(offset)`, `dispatchClick(anchor)`, `confirmNavigation(answer)`, `beforeUnloadBlocked()`, and `flushAsync()`.

The helper must record API paths/options exactly so tests can verify that a late response is ignored after `selectTemplate()` changes the document.

- [ ] **Step 2: Add failing media and stale-response tests**

Add behavioral tests covering:

```js
test('AutoCard upload trigger is keyboard reachable and accepts the same file twice', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante');
  harness.clickUpload();
  harness.clickUpload();
  assert.equal(harness.fileInputClicks(), 2);
  await harness.chooseFile({ name: 'photo.png', type: 'image/png', size: 1024 });
  assert.equal(harness.fileInputValue(), '');
});
test('AutoCard keeps previous media visible while replacement is pending', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'old-media' });
  await harness.resolveAsset(0);
  await harness.chooseFile({ name: 'new.png', type: 'image/png', size: 1024 });
  assert.equal(harness.mediaStatus(), 'uploading');
  assert.match(harness.cardCanvas.innerHTML, /src="[^"]+"/);
});
test('AutoCard blocks export until media loading finishes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('aniversariante', { mediaId: 'pending-media' });
  await harness.exportCard();
  assert.equal(harness.captures.length, 0);
  assert.equal(harness.downloadClicks(), 0);
});
test('AutoCard ignores a save response after the editor document changes', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');
  harness.setField('titulo', 'Comunicado antigo');
  harness.setPrompt('Card antigo');
  const save = harness.saveCard();
  harness.selectTemplate('vaga');
  await harness.resolveAPI(0, { id: 'old-card', template: 'comunicado', values: {} });
  await save;
  assert.equal(harness.state().editingId, null);
});
test('AutoCard ignores stale history and export responses', async () => {
  const harness = await createAutoCardLifecycleHarness();
  const oldHistory = harness.loadSaved(0);
  const newHistory = harness.loadSaved(20);
  await harness.resolveAPI(1, { data: [{ id: 'new-card', name: 'Novo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await harness.resolveAPI(0, { data: [{ id: 'old-card', name: 'Antigo', template: 'comunicado', updatedAt: '2026-09-17' }], total: 21 });
  await Promise.all([oldHistory, newHistory]);
  assert.match(harness.savedList().innerHTML, /Novo/);
});
test('AutoCard protects dirty editor navigation and beforeunload', async () => {
  const harness = await createAutoCardLifecycleHarness();
  harness.selectTemplate('comunicado');
  harness.setField('titulo', 'Alterado');
  assert.equal(harness.confirmNavigation(false), false);
  assert.equal(harness.confirmNavigation(true), true);
  assert.equal(harness.beforeUnloadBlocked(), false);
});
```

Use concrete assertions for `mediaStatus`, `mediaStatus` text, `downloadClicks()`, `captures.length`, `state().editingId`, and the `beforeunload` event's `returnValue`.

- [ ] **Step 3: Implement explicit media state**

Add `mediaStatus` to `current` and a `setMediaStatus(status, message)` helper that updates `#mediaStatus` with `aria-live="polite"` and `data-state`. Set states as follows:

- `idle`: no template media selected;
- `uploading`: local file passed dimension/size checks and the POST is pending;
- `loading`: the media row exists and `fetchAPIAsset()` is pending;
- `ready`: the authenticated blob URL is loaded;
- `error`: validation or load failed, with the existing safe placeholder/toast.

Make `#imageButton` call `#imageInput.click()` and clear `input.value` before opening. Clear it in a `finally` after `change`. Keep the previous `mediaId`, `mediaUrl`, and crop visible during replacement; commit the new media only after its blob URL is ready, otherwise restore the previous confirmed media state. Keep every blob URL revocation through `revokeMediaUrl()`.

- [ ] **Step 4: Implement generation, revision, and dirty navigation guards**

Add:

```js
let documentGeneration = 0;
let editRevision = 0;
let savedSnapshot = null;
```

Use a stable JSON payload helper for `template`, `values`, `icon`, `illustration`, `mode`, `variant`, `mediaSize`, `mediaId`, and `mediaCrop`. Capture `savedSnapshot` when a card is loaded or a save response is accepted. Increment `editRevision` from all field, asset, crop, mode, size, and media mutations. Use `isDirty()` to compare the current payload with `savedSnapshot` and include pending media/save operations.

Before back, template selection, tab changes, same-origin anchors, logout, or unload, call one guard that confirms with:

```text
Há alterações do AutoCard que ainda não foram salvas. Sair mesmo assim?
```

On confirmation, increment `documentGeneration` before changing the document. Preserve modified fields when a save response is older than the current revision; only clear dirty state when the accepted response revision still matches.

- [ ] **Step 5: Gate every awaited response**

Capture `documentGeneration` and the relevant `editRevision` at the beginning of `upload`, `loadMedia`, `saveCard`, history-card GET, and `exportCard`. After each `await`, return without applying state when the captured generation is no longer current. A save response from the same generation may set `editingId`, but must not replace newer values or clear dirty state when revisions differ.

Keep the existing `finally` restoration for save/export buttons and the existing media URL revocation behavior.

- [ ] **Step 6: Run focused tests and commit**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: media lifecycle, crop, export, and all new state/race tests pass.

```sh
git add public/autocard.html public/autocard/app.js tests/unit/autocard-invariants.test.mjs
git commit -m "fix: guard AutoCard media and editor state"
```

### Task 3: Paginate History and Validate Names

**Files:**
- Modify: `public/autocard.html:89`
- Modify: `public/autocard/app.js:1,68-71`
- Modify: `public/autocard/styles.css`
- Modify: `tests/unit/autocard-invariants.test.mjs`

**Interfaces:**
- `loadSaved(offset = savedOffset)` calls `fetchAPIPage` with `/api/autocard/cards?search=${encodeURIComponent(search)}&template=${encodeURIComponent(filter)}&limit=20&offset=${offset}` and renders `#savedPagination` with `renderPagination`.
- Search/filter changes reset `savedOffset` to `0`; page changes keep the active query/filter key.
- History responses apply only when their request token and query key are current.

- [ ] **Step 1: Add failing history contract tests**

Add tests that assert:

```js
assert.match(html, /id="savedPagination"/);
assert.match(app, /fetchAPIPage/);
assert.match(app, /limit=20/);
assert.match(app, /renderPagination/);
assert.match(route, /ORDER BY updated_at DESC, id DESC/);
```

Extend the deferred harness so history responses expose `{ data, total }`. Test first-page loading, next-page query offset, reset after search/filter, stale response ordering, and fallback from an empty non-first page to the last valid page.

- [ ] **Step 2: Implement paginated history with stale protection**

Import `fetchAPIPage` and `renderPagination`. Add `savedOffset`, `savedRequestToken`, `SAVED_PAGE_SIZE = 20`, and the last query key. Send:

```js
const path = `/api/autocard/cards?search=${encodeURIComponent(search)}&template=${encodeURIComponent(filter)}&limit=20&offset=${offset}`;
```

Keep the existing list while loading. On a current response, render cards, toggle the empty state, and call `renderPagination(savedPagination, total, savedOffset, SAVED_PAGE_SIZE, nextOffset => loadSaved(nextOffset))`. If a non-first response has no rows while `total > 0`, compute the last page offset and load it once. Disable only pagination controls while that request is pending through `setPaginationBusy` or the existing button state pattern.

- [ ] **Step 3: Bound manual card names**

In `saveCard()`, treat `prompt()` cancellation separately from an empty name. Trim the name, reject empty or longer-than-120 values with a visible toast, and do not issue a request for rejected input. Keep the API's existing duplicate expression; do not add a counter or change the UUID identity boundary.

- [ ] **Step 4: Run focused history tests and commit**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
```

Expected: all history pagination, stale-response, duplicate-boundary, and existing crop/media tests pass.

```sh
git add public/autocard.html public/autocard/app.js public/autocard/styles.css tests/unit/autocard-invariants.test.mjs
git commit -m "fix: paginate AutoCard history"
```

### Task 4: Make Overflow and Preview Behavior Explicit

**Files:**
- Modify: `public/autocard/app.js:56-73`
- Modify: `public/autocard/vacancy-enhancements.js:7-38`
- Modify: `public/autocard/variant-enhancements.js:22-65,84-91`
- Modify: `public/autocard/styles.css`
- Modify: `public/autocard.html:74-85`
- Modify: `tests/unit/autocard-invariants.test.mjs`

**Interfaces:**
- `syncOverflow()` updates `#contentOverflow`, `aria-live`, `data-overflow`, and the export gate without changing saved values.
- Vacancy rendering shows the first four items plus a visible count for extra requirements/benefits.
- The preview remains contained by its available `.canvas-frame`; birthday sizing is reapplied when `#cardCanvas` changes width.

- [ ] **Step 1: Add failing overflow and responsive assertions**

Add tests that verify:

```js
assert.match(html, /id="contentOverflow"/);
assert.match(vacancy, /slice\(0, 4\)/);
assert.match(vacancy, /além do limite|além do limite visual/);
assert.match(styles, /\.canvas-frame[^}]*min-width:\s*0/);
assert.match(styles, /#cardCanvas[^}]*max-width:\s*100%/);
assert.match(variant, /ResizeObserver/);
```

In the VM test, load a vacancy with six requirements and five benefits; assert the full newline values remain in the current payload, the status identifies both excess counts, and `exportCard()` performs no capture. Add positive-bound checks for rendered card rectangles at 1440, 768, 500, and 320 synthetic widths.

- [ ] **Step 2: Report list overflow instead of silently losing it**

Keep the full textarea values in `current.values`. In `vacancy-enhancements.js`, derive trimmed non-empty lines, render only the first four inside the compact card, and add a safe escaped message such as `+2 requisitos além do limite visual` for extras. Expose the same counts to `syncOverflow()` rather than using the preview as the only warning.

- [ ] **Step 3: Gate export on known overflow and layout bounds**

Implement `syncOverflow()` in `app.js` with these checks:

- requirements and benefits have no more than four non-empty lines;
- rendered vacancy/employee text nodes do not have positive `scrollHeight > clientHeight` or `scrollWidth > clientWidth` when both measurements are available;
- the measured canvas width and height are both greater than zero.

Write an actionable warning to `#contentOverflow`, set `exportButton.disabled` while the warning is active, and re-check immediately before and after each awaited export step. Keep save enabled so users can preserve their complete draft.

- [ ] **Step 4: Constrain the preview to its container**

Append localized AutoCard rules that make `.preview-area`, `.canvas-frame`, and `#cardCanvas` `min-width: 0`, keep the canvas at `width: min(100%, 420px)`, apply `max-width: 100%`, preserve its aspect ratio, and use `overflow: auto` only inside the frame if a browser cannot fit the minimum card width. Keep mobile padding within the 320px viewport and do not rely on global `overflow-x: hidden`.

In `variant-enhancements.js`, observe `#cardCanvas` with `ResizeObserver` when available and call `applyVariant()` after width changes. Calculate birthday dimensions from the rendered container width, retaining the existing small/medium/large choices and no fixed viewport-only size.

- [ ] **Step 5: Run focused tests and commit**

Run:

```sh
node --test tests/unit/autocard-invariants.test.mjs
git diff --check
```

Expected: all overflow, responsive, crop, employee, and export tests pass with no horizontal preview overflow contract failures.

```sh
git add public/autocard.html public/autocard/app.js public/autocard/vacancy-enhancements.js public/autocard/variant-enhancements.js public/autocard/styles.css tests/unit/autocard-invariants.test.mjs
git commit -m "fix: make AutoCard overflow explicit"
```

### Task 5: Record and Verify the Task

**Files:**
- Modify: `CHANGELOG.md`
- Create: `.superpowers/sdd/2026-09-17-autocard-task-8/task-5-report.md`
- Modify: `.superpowers/sdd/2026-09-17-autocard-task-8/progress.md`
- Verify: `docs/superpowers/specs/2026-09-17-autocard-task-8-design.md`

**Interfaces:**
- Changelog records only the user-visible behavior; reports distinguish local verification from live acceptance.
- The task ledger marks Task 5 complete only after the focused reviewer and full verification pass.

- [ ] **Step 1: Add the concise changelog entry**

Under `## Unreleased`, add:

```markdown
- AutoCard agora protege alterações pendentes, pagina o histórico, explicita excesso de conteúdo e mantém preview/exportação responsivos.
```

- [ ] **Step 2: Run all local checks after the final checkpoint**

Run in this order:

```sh
node --test tests/unit/autocard-invariants.test.mjs
npm test
npm run verify
git diff --check
```

Expected: all commands pass, with the full suite retaining or exceeding the `404` baseline and no service/external validation claimed.

- [ ] **Step 3: Inspect the final diff**

Run:

```sh
git status --short
git diff 4fa504f..HEAD --stat
git diff 4fa504f..HEAD -- api/routes/autocard.js public/autocard.html public/autocard/app.js public/autocard/vacancy-enhancements.js public/autocard/variant-enhancements.js public/autocard/styles.css tests/unit/autocard-invariants.test.mjs CHANGELOG.md
```

Confirm that only the approved AutoCard API/UI/test/changelog behavior is present and that local SDD notes are not accidentally included in the production commit.

- [ ] **Step 4: Mark the ledger and brief complete**

Create `.superpowers/sdd/2026-09-17-autocard-task-8/task-5-report.md` with the implementation checkpoint, focused count, full `npm run verify` count, `git diff --check`, reviewer result, and remaining browser/PostgreSQL/live acceptance limitations. Update the local progress and brief checkboxes only after the reviewer returns `PASS`.

- [ ] **Step 5: Commit the documentation record**

```sh
git add CHANGELOG.md .superpowers/sdd/2026-09-17-autocard-task-8/task-5-report.md
git commit -m "docs: record AutoCard Task 8 verification"
```

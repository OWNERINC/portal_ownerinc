# Cards Pos Rich Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe visual text formatting controls to every Guest and Owner text field while preserving existing plain-text cards and PDF export.

**Architecture:** Keep the existing JSON `values` payload and upgrade the current inputs and textareas to browser-native `contenteditable` editors at runtime. Store only a small allowlist of HTML tags, convert legacy newline text into safe HTML at render time, and pass sanitized rich values through the existing escaped renderer using an explicit rich-value marker.

**Tech Stack:** Static HTML, browser ES modules, native Selection/Range and `document.execCommand`, a shared attribute-free HTML tokenizer, existing Node test runner, existing PostgreSQL JSONB card storage, browser `window.print()` export.

## Global Constraints

- Do not add a frontend framework or a new dependency.
- Preserve both `convite_owntime` and `convite_owner` payloads and existing saved plain-text cards.
- Allow only `strong`, `b`, `em`, `i`, `u`, `s`, `strike`, `br`, `ul`, `ol`, and `li` in persisted/rendered rich text.
- Strip every attribute and every non-allowlisted element before rendering or saving edited content.
- Keep inline formatting available in every Guest and Owner field; expose list formatting only in multiline fields so titles and compact labels remain single-line.
- Preserve current field IDs, `data-field`, `data-owner-field`, length limits, history, CRUD, and PDF export.
- Keep the exported `Ativo 5 2.svg` footer unchanged and outside the rich-text renderer.
- Run `npm run verify` and `git diff --check` before publication.

---

### Task 1: Lock the rich-text and security contract

**Files:**
- Modify: `tests/unit/pos-cards-frontend.test.mjs`
- Modify: `tests/unit/frontend-invariants.test.mjs` only if the new Cards Pos implementation is included in its script set

**Interfaces:**
- `sanitizeRichHtml(value)` returns a string containing only the allowed tags and text.
- `toRichHtml(value)` converts legacy plain text with newlines to safe editor/render HTML.
- `FOOTER_ASSET` and the shared footer behavior remain unchanged.

- [ ] **Step 1: Add failing static assertions**

Require the Cards Pos source and stylesheet to contain the native editor, sanitizer, toolbar commands, and safe tag allowlist:

```js
assert.match(app, /function sanitizeRichHtml/);
assert.match(app, /const RICH_TAG_PATTERN/);
for (const command of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'removeFormat']) {
  assert.match(app, new RegExp(command));
}
assert.match(app, /contentEditable/);
assert.match(css, /\.rich-toolbar \{/);
assert.match(css, /\.rich-editor \{/);
```

Also require the existing `maxlength` values to be copied into the runtime editors and reject unsafe tags in the source contract:

```js
assert.match(app, /dataset\.maxlength/);
assert.doesNotMatch(app, /<\/?(?:script|iframe)\b/i);
```

- [ ] **Step 2: Run the focused frontend test**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: FAIL because the rich editor and sanitizer do not exist yet.

---

### Task 2: Implement safe rich-text normalization and rendering

**Files:**
- Modify: `public/cards-pos/app.js`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- `sanitizeRichHtml(value)` tokenizes the editor/browser HTML, keeps text and the allowed tags, removes all attributes, normalizes block boundaries, and unwraps disallowed elements without preserving their markup.
- `toRichHtml(value)` always returns the same canonical sanitized representation, including `<br>` for legacy newlines.
- `RICH_VALUE` marks values used by the existing `esc()` renderer so attributes and history names remain plain escaped strings.

- [ ] **Step 1: Add the sanitizer before the existing `esc` helper**

Normalize markup before inserting it into the live document:

Use one tokenization/escaping rule for the browser and API: preserve only the allowlisted tags, drop attributes and comments, unwrap unknown tags, convert `DIV`/`P` boundaries to `<br>`, escape text, and preserve already-valid entities so repeated sanitization is idempotent. Apply newline replacement outside the character replacement callback so each legacy line break becomes a `<br>`.

- [ ] **Step 2: Teach `esc` and rendering to distinguish rich values**

Keep normal strings escaped exactly as today. When `esc` receives `{ [RICH_VALUE]: true, value }`, return `sanitizeRichHtml(value)` instead of escaping the HTML. In `render()`, wrap only the selected card value object:

```js
function richValues(values) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { [RICH_VALUE]: true, value }]));
}
```

Call `renderGuest(richValues(values))` or `renderOwner(richValues(values))`. Media URLs, history names, IDs, and asset paths must continue through the normal plain-string branch.

- [ ] **Step 3: Run the focused test**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: PASS for the sanitizer and rich rendering source contract.

---

### Task 3: Add the shared toolbar and upgrade all fields

**Files:**
- Modify: `public/cards-pos/app.js`
- Modify: `public/cards-pos/styles.css`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- `upgradeRichFields()` replaces each existing `[data-field], [data-owner-field]` input or textarea with a contenteditable `div` retaining its ID and data attribute.
- `setRichFieldValue(field, value)` loads bounded plain or sanitized rich values.
- `normalizeRichField(field, value)` returns canonical sanitized HTML and preserves compact single-line fields.
- `createRichToolbar()` inserts one accessible toolbar before the first form field and applies commands to the focused editor.

- [ ] **Step 1: Add the toolbar and editor CSS**

Add compact controls with visible focus and responsive wrapping:

```css
.rich-toolbar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: var(--space-4); padding: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.rich-toolbar button { min-width: 44px; min-height: 44px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; }
.rich-toolbar button:hover { background: var(--surface-2); }
.rich-editor { width: 100%; min-height: 44px; padding: 10px var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font: inherit; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; outline: 0; }
.rich-editor.is-multiline { min-height: 88px; white-space: pre-wrap; }
.rich-editor:focus-visible { border-color: var(--focus); outline: 3px solid color-mix(in srgb, var(--focus) 28%, transparent); outline-offset: 1px; }
.rich-editor ul, .rich-editor ol { margin: 0 0 0 1.25em; padding: 0; }
```

- [ ] **Step 2: Upgrade the existing controls without changing their field contract**

Copy `maxlength` to `data-maxlength`, retain the existing ID and `data-*` attribute, set `contentEditable = 'true'`, `role="textbox"`, and `aria-multiline` according to the original element tag. Give the editor an accessible `aria-label` from its containing label and keep label clicks focused on the editor.

Prevent Enter in former single-line inputs and trim `textContent` to `data-maxlength` if a paste or command exceeds the original limit. Trimming may remove formatting only for the overflowing edit; valid content keeps its formatting.

- [ ] **Step 3: Add the toolbar commands**

Create buttons with `type="button"`, `data-command`, visible labels, and `aria-label` values for:

```text
bold, italic, underline, strikeThrough, insertUnorderedList, insertOrderedList, removeFormat
```

Track the focused editor. On `mousedown`, prevent the toolbar button from stealing the selection. On `click`, focus the editor, run `document.execCommand(command, false, null)`, sanitize the result, update the active value, and render the card.

- [ ] **Step 4: Reuse rich values in load and input flows**

Update `loadValues()` to call `setRichFieldValue()` and write the normalized value back into the active state. Update the existing input listener to normalize the editor HTML instead of reading `.value`. Upgrade fields before the initial `loadValues()` call so initial values and history edits populate the contenteditable editors correctly.

- [ ] **Step 5: Run the focused test**

Run: `node --test tests/unit/pos-cards-frontend.test.mjs`

Expected: PASS for toolbar commands, contenteditable fields, field metadata, and safe rendering contracts.

---

### Task 4: Document and verify the complete change

**Files:**
- Modify: `docs/product/feature-inventory.md`
- Modify: `CHANGELOG.md`
- Test: all existing checks through `npm run verify`

**Interfaces:**
- Saved cards continue using the existing `/api/pos-cards/cards` API and JSONB values.
- Existing plain strings remain valid and render with their original line breaks.
- Edited rich strings remain bounded by the existing 50,000-byte request validation.
- API create, update, list, get, and duplicate flows normalize rich strings with the same allowlist before persistence or response.

- [ ] **Step 1: Document formatting support**

Record that Guest and Owner fields support safe rich text formatting and that legacy plain-text cards remain compatible. Do not claim that the fixed exported footer is editable.

- [ ] **Step 2: Run the full verification**

Run: `npm run verify`

Expected: syntax, all tests, security checks, compose checks, and migration checks pass.

- [ ] **Step 3: Review the final diff**

Run: `git diff --check` and `git status --short`.

Confirm only the planned frontend, tests, documentation, and no-dependency files changed.

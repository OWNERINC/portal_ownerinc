# Cards Pos Owner Frame 02 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Owner Cards Pos template from the approved Frame 02 print without changing Guest behavior or shared persistence flows.

**Architecture:** Keep the existing `convite_owner` template and JSON payload. Expand only the Owner defaults and editor fields, replace the Owner renderer and scoped CSS, and retain the existing upload, history, sanitization, overflow fitting, and PDF exporter.

**Tech Stack:** Static HTML, browser ES modules, CSS, Node 18 test runner, html2canvas, jsPDF.

## Global Constraints

- Keep the Guest card unchanged.
- Export Owner at exactly `108 x 248.6 mm`.
- Keep all visible Owner text except the logo editable.
- Add no dependency and no API or database change.

---

### Task 1: Lock the Frame 02 contract

**Files:**
- Modify: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- Produces: assertions for Owner fields, icons, white body, two-column services, custom footer, and `108 x 248.6 mm` export.

- [ ] Add assertions for the approved Owner field names and Frame 02 structure.
- [ ] Remove assertions that require the simplified black Owner body.
- [ ] Run `node --test tests/unit/pos-cards-frontend.test.mjs` and confirm the new assertions fail.

### Task 2: Implement the Owner editor and renderer

**Files:**
- Modify: `public/cards-pos.html`
- Modify: `public/cards-pos/app.js`
- Modify: `public/cards-pos/styles.css`
- Test: `tests/unit/pos-cards-frontend.test.mjs`

**Interfaces:**
- Consumes: existing `data-owner-field`, `richValues()`, `richCopy()`, `loadValues()`, and `fitCardBody()` contracts.
- Produces: a Frame 02 Owner card using `convite_owner` and the current save payload.

- [ ] Add labeled Owner fields for every visible Frame 02 text block.
- [ ] Replace `ownerDefaults` with the approved print copy while retaining the six current persisted keys.
- [ ] Render the white editorial body, local icons, service grid, host note, and editable Owner footer.
- [ ] Scope the Frame 02 proportions and typography to `.owner-card` and set the PDF size to `108 x 248.6 mm`.
- [ ] Run `node --test tests/unit/pos-cards-frontend.test.mjs` and confirm it passes.

### Task 3: Document and verify

**Files:**
- Modify: `docs/product/feature-inventory.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: product documentation matching the shipped Owner composition.

- [ ] Update the Owner Frame 02 size and editable-content description.
- [ ] Record the Owner visual refresh in the changelog.
- [ ] Run `npm run verify`.
- [ ] Run `git diff --check`.
- [ ] Inspect the final diff for changes outside the approved scope.

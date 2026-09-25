# Navigation CSS No-Flash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the currently rendered Portal page styled until the destination page's styles have finished loading, eliminating the unstyled white/purple/blue frame during tab changes.

**Architecture:** Preserve the existing cached stylesheet promises and preload destination links with `media="not all"`. Change activation so the old stylesheet set is not disabled until the destination set is ready, then switch the media states in one synchronous activation step before mounting the destination. Add router-harness regression coverage for delayed stylesheet loading and stylesheet failure.

**Tech Stack:** Vanilla ES modules, DOM `link.media` switching, Node test runner, existing `tests/helpers/router-harness.mjs`.

## Global Constraints

- Keep Portal navigation, navbar/sidebar markup, authorization, APIs, and module content unchanged.
- Preserve the current page when destination preparation fails.
- Keep Node 18 compatibility for application code and use the repository's Node 24 verification command.
- Do not add a framework or production dependency.
- Run `npm run verify` and `git diff --check` before sharing the change.

---

### Task 1: Make stylesheet activation atomic

**Files:**
- Modify: `public/js/router.js:138-159`

**Interfaces:**
- Consumes: `prepareStyles(doc, url)` returning a resolved array of destination stylesheet nodes whose `media` is `not all`.
- Produces: `activateStyles(selected, doc)` that leaves currently active styles untouched until all destination styles are ready, then switches old and new media states synchronously.

- [ ] **Step 1: Confirm the current failure mechanism**

Read `activateStyles()` and verify that the current first operation sets every existing stylesheet to `media="not all"` before destination links are activated. Do not change module markup or CSS files.

- [ ] **Step 2: Write the minimal atomic activation change**

Keep destination links inactive during `prepareStyles()`. In `activateStyles()`, first append/mark destination styles as active, then deactivate only stylesheet nodes that are not part of the selected destination set. Preserve removal and cloning of page-scoped `<style data-page-style>` nodes after the destination set is ready.

The implementation must follow this shape:

```js
function activateStyles(selected, doc) {
  const next = new Set(selected);
  selected.forEach(node => { node.media = 'all'; document.head.append(node); });
  document.querySelectorAll('link[rel="stylesheet"]').forEach(node => {
    if (!next.has(node)) node.media = 'not all';
  });
  document.querySelectorAll('style[data-page-style]').forEach(node => node.remove());
  doc.querySelectorAll('head style').forEach(style => {
    const node = style.cloneNode(true);
    node.dataset.pageStyle = '';
    document.head.append(node);
  });
}
```

If appending an already-present selected node would duplicate it in the browser, retain the existing node and only set its media to `all`; the final implementation must leave exactly one active node per selected stylesheet URL.

- [ ] **Step 3: Verify the focused router tests**

Run:

```bash
node --test tests/unit/navigation-review-regressions.test.mjs
```

Expected: existing navigation regressions pass.

- [ ] **Step 4: Commit the router change**

```bash
git add public/js/router.js
git commit -m "fix: switch navigation styles without flash"
```

### Task 2: Add delayed-load and failure regressions

**Files:**
- Modify: `tests/unit/navigation-review-regressions.test.mjs`
- Modify: `tests/helpers/router-harness.mjs` only if the existing resource controls cannot observe stylesheet media transitions

**Interfaces:**
- Consumes: `createRouterHarness({ resourcePause })`, `h.page(path, { styles })`, `h.doc.querySelectorAll('link[rel="stylesheet"]')`.
- Produces: tests proving old styles stay active while destination styles are pending and remain active when destination stylesheet loading fails.

- [ ] **Step 1: Add a regression for pending destination CSS**

Create a harness with an initial mounted page, register a destination page with a distinct stylesheet URL, pause resource completion with `deferred()`, start navigation, and assert before resolving the pause that the existing active stylesheet is still `media !== 'not all'` and the destination stylesheet is inactive. Resolve the resource and assert that the destination stylesheet becomes active only after preparation completes.

Use a test name such as:

```js
test('navigation keeps the current stylesheet active while destination CSS is loading', async () => {
  // arrange current and destination styles, pause destination resource
  // assert old media before resolving the deferred resource
  // resolve, await navigation, assert destination media is all
});
```

- [ ] **Step 2: Add a regression for stylesheet failure**

Use `resourceFailure = true` with a destination stylesheet and assert that navigation returns `false`, the current page remains mounted/active, and its stylesheet is not disabled. The failed destination stylesheet must not remain in the router's stylesheet cache so a later retry can attempt loading again.

- [ ] **Step 3: Run the focused test file**

```bash
node --test tests/unit/navigation-review-regressions.test.mjs
```

Expected: all existing tests plus the two new regressions pass.

- [ ] **Step 4: Commit the regression tests**

```bash
git add tests/unit/navigation-review-regressions.test.mjs tests/helpers/router-harness.mjs
git commit -m "test: cover flash-free stylesheet navigation"
```

### Task 3: Run the full verification and review the diff

**Files:**
- Review: `public/js/router.js`
- Review: `tests/unit/navigation-review-regressions.test.mjs`
- Review: `docs/superpowers/specs/2026-09-24-navigation-css-no-flash-design.md`

**Interfaces:**
- Consumes: the atomic stylesheet activation and its regressions from Tasks 1–2.
- Produces: a verified, localized change ready for the normal PR/deploy workflow.

- [ ] **Step 1: Run the complete verification**

```bash
npm run verify
git diff --check
```

Expected: verification succeeds, all tests pass, and the diff has no whitespace errors.

- [ ] **Step 2: Check the final scope**

Confirm that only the router style lifecycle, its tests, and the already-approved specification/plan are changed. Confirm no navbar/sidebar HTML, route authorization, API contract, or module CSS was modified.

- [ ] **Step 3: Commit any test-only adjustment**

If the full verification requires a small test-harness adjustment, commit only that adjustment with:

```bash
git add tests/unit/navigation-review-regressions.test.mjs tests/helpers/router-harness.mjs
git commit -m "test: stabilize stylesheet transition coverage"
```

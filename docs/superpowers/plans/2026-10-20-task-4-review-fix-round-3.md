# Task 4 Review-Fix Round 3 Implementation Plan

> **For agentic workers:** Execute inline as approved. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the original editor before post-controls upload-position validation and select only the direct PDF preview link.

**Architecture:** Keep editor restoration in browser orchestration, using a `try/finally` navigation and a readiness barrier for the editor save control plus all four exact upload wrappers. Keep the history test's PDF locator in a shared local helper with a direct-child CSS selector. Verify behavior offline using fake-page call ordering and a source/locator regression.

**Tech Stack:** Node.js `node:test`, TypeScript via `tsx`, existing Playwright page API and CMS MJS integration helpers.

## Global Constraints

- Preserve browser case order and synthetic bridge revocation semantics.
- Browser and real database acceptance remain `NOT_EXECUTED`; do not start either fixture in this task.
- Restoration failure or an invalid position snapshot must never invoke uploads or yield acceptance `PASS`.
- Use `npm run test:unit` from `cms/`, CMS typecheck, browser/helper syntax checks, focused Task 4 tests, and `git diff --check`.

---

### Task 1: Restore the editor before the post-controls position snapshot

**Files:**
- Modify: `cms/tests/integration/portal-page-editorial-browser-orchestration.mjs`
- Modify: `cms/tests/unit/portal-page-editorial-browser-harness.test.ts`
- Modify: `cms/tests/integration/portal-page-editorial-browser-orchestration.d.mts` only if a public interface changes

**Interface:**
- `runEditorialControlAndUploadSuites` continues to accept the original `page`, `structuralPage`, and the two suite callbacks.
- Add internal `restoreOriginalEditor(page, originalURL)` which navigates with `domcontentloaded`, waits for the exact native **Salvar versão** button, then waits for each expected upload wrapper selector to be visible.

- [x] Extend the fake editor Page with URL/view state and event recording. Make controls navigate it away; assert the original URL is restored, native editor and exact wrappers become ready, a second position snapshot occurs only afterward, and uploads run only after that snapshot.
- [x] Run the focused browser harness test and confirm the new behavioral regression fails before the implementation.
- [x] Capture the initial editor URL before controls and restore in `finally` before reading post-controls positions.
- [x] Preserve the existing invariant result and upload `NOT_EXECUTED` behavior when positions change or cannot be read; propagated control/restore errors must not invoke uploads.
- [x] Re-run the focused browser harness test.

### Task 2: Use a direct-child PDF link in the historical-preview case

**Files:**
- Modify: `cms/tests/integration/portal-page-editorial-browser.mjs`
- Modify: `cms/tests/unit/portal-page-editorial-browser-harness.test.ts`

- [x] Add a source/locator regression requiring the direct-child selector and both pre-reload/post-reload checkpoints, while rejecting the broad descendant selector.
- [x] Add a helper selecting `.portal-page-preview__pdf > a`; use it for both PDF URL reads.
- [x] Run the focused browser harness test; leave acceptance case names/order and revocation sequence unchanged.

### Task 3: Evidence, verification, and focused commit

**Files:**
- Modify: `docs/reviews/2026-10-19-portal-pages-editorial-acceptance.md`
- Modify: `docs/operations/portal-pages-editorial.md`
- Modify: `.superpowers/sdd/2026-10-19-portal-pages-editorial-experience/task-4-report.md` (ignored local evidence)
- Include: this plan and `docs/superpowers/specs/2026-10-20-task-4-review-fix-round-3-design.md`

- [x] Append actual round-3 test results and explicitly keep browser/database acceptance `NOT_EXECUTED`.
- [x] Run all Task 4 unit tests, CMS typecheck, MJS syntax checks, full CMS unit suite, repository `npm run verify`, and `git diff --check`.
- [x] Review and commit only round-3 Task 4 source, regression tests, plan/design, and matching evidence/docs.

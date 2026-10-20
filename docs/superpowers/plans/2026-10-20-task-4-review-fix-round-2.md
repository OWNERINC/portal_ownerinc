# Task 4 Review-Fix Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or execute the steps inline. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close browser assertion, fixture-isolation, historical-preview, and real disposable-session-revocation gaps.

**Architecture:** Use exported pure browser assertions and a testable orchestration boundary. Keep structural edits on a separate native Page, verify the original upload destination snapshot before calling the upload suite, then run historical-preview and stateful bridge-revocation cases at the end of browser execution.

**Tech Stack:** Node.js `node:test`, TypeScript via `tsx`, Playwright's existing runtime module convention, CMS MJS test helpers.

## Global Constraints

- Keep the CMS runtime application and production auth behavior unchanged; synthetic revocation is confined to the disposable integration bridge.
- Do not claim synthetic/local bridge evidence as live Portal-service acceptance.
- Missing or unavailable required cases must remain `NOT_EXECUTED`; they must never aggregate to `PASS`.
- Run the focused tests, all Task 4 unit tests, CMS typecheck, MJS syntax checks, CMS unit suite, and `git diff --check`.

---

### Task 1: Executable browser assertion helpers

**Files:**
- Modify: `cms/tests/integration/portal-page-editorial-controls.mjs`
- Create: `cms/tests/unit/portal-page-editorial-browser-harness.test.ts`
- Create: `cms/tests/integration/portal-page-editorial-controls.d.mts`

**Interfaces:**
- Export `assertEqual(actual, expected, detail)`, `assertNotEqual(actual, expected, detail)`, and `assertMatch(value, pattern, detail)` from the controls helper.
- All control-case assertions use the existing boolean `assert` helper through these functions.

- [x] Add tests that exercise each helper's success and throw paths.
- [x] Replace every unbound `assert.equal`, `assert.notEqual`, and `assert.match` call in the controls module.
- [x] Run the focused helper test and MJS syntax check.

### Task 2: Separate structural document and upload-position orchestration

**Files:**
- Modify: `cms/tests/integration/portal-page-editorial-native.ts`
- Modify: `cms/tests/integration/portal-page-editorial-cases.mjs`
- Modify: `cms/tests/integration/portal-page-editorial-cases.d.mts`
- Modify: `cms/tests/integration/portal-page-editorial-browser.mjs`
- Modify: `cms/tests/integration/portal-page-editorial-controls.mjs`
- Modify: `cms/tests/integration/portal-page-editorial-upload.mjs`
- Create: `cms/tests/integration/portal-page-editorial-browser-orchestration.mjs`
- Create: `cms/tests/integration/portal-page-editorial-browser-orchestration.d.mts`
- Modify: `cms/tests/unit/portal-page-editorial-browser-harness.test.ts`

**Interfaces:**
- The private handoff carries a validated UUID `structuralPageID`.
- `runEditorialControlCases(page, structuralPage)` uses `structuralPage` only for block insertion/reordering.
- The orchestration helper snapshots the original media destinations, runs controls on their assigned pages, verifies the original positions, and passes the verified map to `runEditorialUploadCases(page, positions)`.

- [x] Add a native acceptance case creating a distinct structural-edit Page and verify the original media Version still has image/gallery/video/PDF at indexes 0/1/2/3.
- [x] Validate `structuralPageID` in the browser handoff and open a separate Playwright page for structural edits.
- [x] Add an orchestration test with fake page/runner dependencies asserting call order, distinct structural page identity, exact original position map, and upload-runner receipt of that map.
- [x] Make the real upload suite validate the passed positions before running its fixed destinations.
- [x] Ensure snapshot failure emits a failed invariant and named upload `NOT_EXECUTED` results.

### Task 3: Historical preview and stateful disposable session revocation

**Files:**
- Modify: `cms/tests/integration/portal-page-editorial-browser.mjs`
- Create: `cms/tests/integration/portal-page-editorial-test-actor.mjs`
- Create: `cms/tests/integration/portal-page-editorial-test-actor.d.mts`
- Modify: `cms/tests/integration/portal-page-editorial-cases.mjs`
- Modify: `cms/tests/integration/portal-page-editorial-cases.d.mts`
- Modify: `cms/tests/unit/portal-page-editorial-browser-harness.test.ts`

**Interfaces:**
- The local actor transport exposes `/api/internal/editorial/session/revoke`, records the exact revoked synthetic cookie, and rejects subsequent `/admin/session/resolve` calls for it.
- The last browser case receives the active Page, exact old asset URL, bridge URL, and disposable service secret; it revokes through the bridge HTTP contract and issues a same-origin browser Range request with the retained cookie.

- [x] Rename the required historical-preview case and run it after controls, upload, and News smoke.
- [x] Save an old exact preview URL, save and publish a newer version, reload the old URL, and assert the old Version ID, summary, PDF asset URL, and Range response remain unchanged.
- [x] Add a stateful synthetic bridge test that resolves the fixture cookie before revocation, revokes by HTTP request, then rejects that cookie while leaving other fixture state unchanged.
- [x] Add the final browser session-revocation case; assert a pre-revoke Range succeeds and the fresh post-revoke same-origin Range returns 401/403 with no media bytes.
- [x] Ensure unavailable fixture/setup paths report every new required case as `NOT_EXECUTED` and cannot aggregate to `PASS`.

### Task 4: Evidence, validation, and focused commit

**Files:**
- Modify: `docs/reviews/2026-10-19-portal-pages-editorial-acceptance.md`
- Modify: `docs/operations/portal-pages-editorial.md`
- Modify: `.superpowers/sdd/2026-10-19-portal-pages-editorial-experience/task-4-report.md` (local ignored evidence only)
- Modify: this plan
- Include: `docs/superpowers/specs/2026-10-20-task-4-review-fix-round-2-design.md`

- [x] Record RED/GREEN results, named browser cases, and explicit real-service/browser acceptance status.
- [x] Run focused browser helper/orchestration/registry tests and all Task 4 unit tests.
- [x] Run `npm run typecheck` from `cms/`, browser/helper `node --check`, `npm run test:unit` from `cms/`, and `git diff --check`.
- [x] Review and commit only Task 4 round-2 source, tests, and matching evidence/docs.

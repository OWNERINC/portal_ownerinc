# Task 4 Fix Round 1 Implementation Plan

> **For agentic workers:** This plan is being executed inline in the current session at the user's direction; no subagents or service startup are authorized.

**Goal:** Fix the Task 4 DTO optional-field rejection, API asset-stream cleanup/error mapping, CMS descriptor handoff, and the specified behavioral coverage.

**Architecture:** Keep the existing API DTO, `createPortalPagesClient`, CMS `portalPageReadEndpoints`, and read/transaction functions as the boundaries. Use exact contract round trips and actual endpoint/client/router paths in tests; retain stream ownership explicitly until handoff and keep cleanup idempotent.

**Tech Stack:** Node.js 24, CommonJS API modules, TypeScript Payload CMS, Node test runner, Express/Supertest, Payload test harness.

## Global Constraints

- Preserve Owner News contracts and authorization.
- Do not change publish mutations or frontend code.
- Do not weaken preview-path safety checks.
- Do not run Docker or start services.
- Keep the Task 4 report ignored/uncommitted.
- Run focused API/News tests, CMS typecheck/syntax, full CMS suite, and root verification.

---

### Task 1: Reproduce and close the Task 1 DTO optional-key gap

**Files:**
- Modify: `api/portal-pages/payload-dto.js`
- Test: `cms/tests/unit/portal-pages-reader.test.ts` or a focused new CMS contract test alongside it

**Interfaces:**
- `projectPortalPageContent(nativeBlocks)` produces the normalized CMS block DTO.
- `readPortalPageResult('detail', dto, { slug })` is the production API validator.

- [x] Reproduce the current failure for `image.caption` and `callout.title` against `a14bff6`.
- [x] Add a round-trip matrix for ten block types × five layouts and include present and omitted cases for the three optional content fields: image caption, gallery-image caption, and callout title.
- [x] Add unknown-key negatives for block, nested gallery image, cover, and category objects.
- [x] Fix `fields()` so its exact-key set includes the branch's optional keys before running their existing validators.
- [x] Run the CMS suite and typecheck; confirm positive round trips pass and unknown keys fail closed.

### Task 2: Make the API asset stream cleanup single-owner and idempotent

**Files:**
- Modify: `api/portal-pages/payload-client.js`
- Test: `tests/unit/portal-pages-payload-client.test.mjs`

**Interfaces:**
- `client.asset({pageId,revisionId,assetId,preview,range}, actor, options)` returns `{status, headers, body}` or a sanitized error.

- [x] Add observable stream fixtures for exact EOF, overrun, underrun, reader rejection, idle timeout, bad headers, downstream cancel, and request abort.
- [x] Track downstream terminal state separately from a memoized cleanup promise; cleanup cancels the reader/body, aborts fetch when needed, clears timers/listeners, and resolves once.
- [x] Make EOF verify exact length and close once without treating cleanup as already complete.
- [x] Make all error, cancel, and abort paths converge on cleanup without skipping it after downstream error.
- [x] Run focused API client tests and assert cleanup/listener behavior on every path.

### Task 3: Map bounded CMS asset JSON errors safely

**Files:**
- Modify: `api/portal-pages/payload-client.js`
- Test: `tests/unit/portal-pages-payload-client.test.mjs`

- [x] Return CMS asset errors before success-header validation only for bounded exact JSON `{error:"forbidden"}` at 403 and `{error:"not_found"}` at 404.
- [x] Sanitize all other/invalid statuses and bodies to 503; consume/cancel bodies under a fixed small byte cap and never expose CMS response detail.
- [x] Add tests for correct 403/404, mismatched code/status, wrong content type, malformed JSON, oversized body, and an unrelated status.
- [x] Run focused API client and bridge tests.

### Task 4: Retain CMS descriptor ownership until successful handoff

**Files:**
- Modify: `cms/src/endpoints/portal-pages.ts`
- Test: `cms/tests/unit/portal-page-media-reader.test.ts` and/or a focused endpoint test

- [x] Exercise the real `portalPageReadEndpoints` asset handler with a Payload transaction fixture whose commit fails after `openPortalPageMedia()` returns.
- [x] Keep the opened response outside the transaction callback and set a handoff flag only after `new Response(...)` succeeds.
- [x] In `finally`, cancel the retained body if handoff did not complete; rely on the body owner's idempotent close for exact descriptor release.
- [x] Assert commit-failure, normal handoff/EOF, and request-abort close exactly once.
- [x] Assert unreferenced IDs and wrong-role MIME return safe errors before descriptor open under the actual endpoint transaction/open boundary.
- [x] Run CMS unit tests and typecheck.

### Task 5: Exercise revisions and the real client → CMS endpoint → Express path

**Files:**
- Modify: `cms/tests/unit/portal-pages-reader.test.ts`
- Modify or add: `tests/unit/portal-pages-bridge.test.mjs` and `tests/unit/portal-pages-payload-client.test.mjs`

- [x] Make the versions fixture intentionally unsorted; assert `findVersions` receives `sort: ['-updatedAt', '-id']` and the newest published Version is selected.
- [x] Drive published revision A to a newer published revision B in the CMS fixture; assert A's asset URL is denied and B's is accepted.
- [x] Route real CMS endpoint-handler JSON errors through `createPortalPagesClient` and `createContentsRouter` using Express/Supertest; assert only sanitized API error codes/statuses reach the browser.
- [x] Run relevant Owner News/API regressions with the bridge tests.

### Task 6: Verify with an unchanged temp safety guard and deliver

**Files:**
- Append evidence: `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-4-report.md` (ignored)
- Commit: all focused source/test changes; do not stage the report

- [x] Validate `C:\Windows\Temp` with `validateExternalRoot(candidate, process.cwd())` and `fs.access(candidate, W_OK)`; no ancestor contains `.git`.
- [x] Run `npm run typecheck:cms`, focused API/News tests, `npm run test:cms`, and root `npm run verify` with Docker absent from `PATH` and only `PAYLOAD_TEST_EXTERNAL_PARENT` set.
- [x] Run `git diff --check`, review the exact staged file list, and append exact test results/evidence limits to the ignored report.
- [x] Create one focused fix commit and confirm the working tree is clean while the report remains ignored.

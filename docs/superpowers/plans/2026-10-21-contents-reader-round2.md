# Contents Reader Round 2 Implementation Plan

> **For agentic workers:** Execute inline in this session. Keep each CMS transaction bounded and preserve the exact published Version/reference checks.

**Goal:** Make every Contents-reader SQL operation deadline-aware and calculate catalog totals only from eligible published pages in one stable exported snapshot.

**Architecture:** Use the installed Payload 3.90.2 / `@payloadcms/drizzle` 3.90.2 / Drizzle ORM 0.45.2 transaction session as the instrumentation boundary: wrap prepared-query `execute`/`all`, refresh transaction-local timeouts for each driver operation, and restore the session method when the transaction ends. A repeatable-read snapshot-holder transaction exports one snapshot without taking `CMS_REFERENCE_LOCK`; its 4 s deadline is cooperative admission/remaining budget, not a hard lifetime cap, and rollback follows settlement of in-flight driver/server work. Each cursor batch imports it in its own transaction, then locks references only for that batch. Catalog, availability, and categories share exact eligibility validation; catalog counts eligible pages and retains only the requested slice.

**Tech Stack:** Node 24, TypeScript, Payload CMS 3.90.2, `@payloadcms/db-postgres` 3.90.2, Drizzle ORM 0.45.2, PostgreSQL.

## Global Constraints

- Preserve exact published Version/current-field/reference validation and fail-closed DTO behavior.
- Each batch owns and releases its own `CMS_REFERENCE_LOCK`; the snapshot holder owns no application/advisory lock.
- API JSON deadline remains 4.2 s; the CMS's 4 s value is a cooperative admission/remaining-budget deadline, not a cap on connection or transaction lifetime.
- Abort cannot synchronously stop JavaScript or cancel in-flight pool/driver/server calls. Once guards observe expiry, no later reader data operation starts; transaction-local PostgreSQL timeouts decrease after setup but do not guarantee cancellation or connection release at the cooperative deadline.
- Never return partial list, count, category, or availability data after a scan failure/budget cap.
- Do not start Docker, services, browser, or a real database in this work round; document guarded `pg_sleep` evidence as not executed.
- Do not rerun root `npm run verify`.

---

### Task 1: Transaction operation budget and exported snapshots

**Files:**
- Modify: `cms/src/publication/transaction.ts`
- Test: `cms/tests/unit/portal-pages-reader.test.ts` (fake transaction driver sequence assertions)

**Interfaces:**
- Produces a transaction-local read-budget installer that wraps the pinned Drizzle session’s prepared `execute`/`all` calls, serializes same-connection operations, refreshes `lock_timeout` and `statement_timeout`, and asserts budget both before and after each operation.
- Produces `withCmsReadSnapshot(payload, req, options, work)`; the holder exports one repeatable-read snapshot and takes no CMS reference lock. Its deadline is cooperative; cleanup attempts rollback after awaited operations settle, and a never-settling operation can retain the connection/snapshot.
- `CmsTransactionOptions` carries an internal optional imported snapshot ID for a batch; import occurs before any query in that transaction.

- [x] Add fake prepared-query tests proving decreasing timeout values before nested operations, no upward refresh, abort/deadline blocking later operations, and cleanup after the pending fake operation settles.
- [x] Implement prepared-query wrapping using the installed `session.prepareQuery` → prepared `execute`/`all` → `client.query` path; keep control-setting SQL non-recursive and transaction-local.
- [x] Implement holder export/import sequencing (`BEGIN`, transaction mode/snapshot commands, then reads) and strict validation of the server-returned snapshot token.
- [x] Run `node --import tsx --test tests/unit/portal-pages-reader.test.ts` from `cms/` and `npm run typecheck` from `cms/`.

### Task 2: Eligible catalog scan and nested reference operations

**Files:**
- Modify: `cms/src/portal-pages/reader.ts`
- Modify: `cms/src/portal-pages/persistence.ts`
- Test: `cms/tests/unit/portal-pages-reader.test.ts`

**Interfaces:**
- Reference helpers accept optional read transaction options; calls without them preserve existing publication/upload semantics.
- Published list scan orders by `(published_at DESC, id DESC)` with an exact UTC microsecond cursor, imports the same snapshot for each maximum-ten-candidate transaction, validates page + exact saved Version + categories/media, and returns only eligible count and requested rows.
- Availability stops at the first eligible DTO; categories aggregate only eligible pages; all three retain the 100,000-candidate and deadline caps.

- [x] Add tests for invalid/drifted/missing-reference exclusion, eligible offset pagination across invalid candidates, raw-count inflation rejection, snapshot reuse/mutation isolation, one locked batch at a time, and no partial result after budget/abort.
- [x] Replace catalog `count(*)` and OFFSET candidate selection with the shared keyset eligibility scan; keep only `offset + limit` eligible DTOs and count eligible pages.
- [x] Treat malformed projection, missing exact publication Version, drift, and broken references as ineligible; keep database/timeout failures fatal and sanitized 503.
- [x] Thread read options through category/media reference helpers and ensure all payload API operations receive pre/post budget assertions; eliminate concurrent same-transaction reference reads.
- [x] Run reader/service focused tests and CMS typecheck.

### Task 3: API/reader contract documentation, guarded PostgreSQL case, and report

**Files:**
- Modify: `docs/architecture/portal-pages-content.md`
- Modify: `docs/operations/portal-contents-reader.md`
- Modify: `docs/reviews/2026-10-20-portal-contents-reader-acceptance.md`
- Modify: `.superpowers/sdd/2026-10-20-portal-contents-reader/final-fix-report.md` (local, excluded/untracked)

- [x] Document stable exported-snapshot count semantics, per-batch advisory lock lifetime, cooperative 4 s snapshot-holder budget (not a hard release cap), ineligible rows, abort/statement-timeout behavior, and PostgreSQL MVCC/vacuum horizon.
- [x] Document a guarded disposable-local PostgreSQL `pg_sleep` case that records SQLSTATE/elapsed time and verifies a timed-out operation prevents the next query; mark it `NOT_EXECUTED` absent explicit live-stack authorization.
- [x] Append exact round-2 commands/results and real-adapter limitations to the local final-fix report.

### Task 4: Final focused verification and commit

- [x] Run CMS reader/transaction/API-bridge tests, CMS typecheck, public DTO/route focused tests, secret scan, and `git diff --check`; run full CMS unit suite once if it completes within the available test budget.
- [x] Do not rerun root `npm run verify`.
- [x] Commit tracked code/tests/docs in one focused commit; keep the local report untracked.

# Contents Reader Round 3 Implementation Plan

> **For agentic workers:** Execute inline in the current session. Keep changes within the reader transaction boundary, run each listed test before committing, and do not claim server-side cancellation of `BEGIN`.

**Goal:** Make pure published/editorial DTO reads snapshot-consistent and lock-free, and bound the caller's wait when a budget expires during Payload transaction startup while cleaning up any late transaction after the adapter settles.

**Architecture:** Preserve `withCmsTransaction` as the existing advisory-lock default. Add an explicit imported-snapshot read transaction with finite setup timeouts before snapshot import, and race transaction startup against the remaining deadline/abort signal; late successful starts are rolled back without running reader work. Retain the snapshot holder's read-only/no-lock/rollback contract and retain locks on asset and mutation paths.

**Tech Stack:** Node 24, TypeScript, Payload CMS 3.90.2, `@payloadcms/db-postgres` 3.90.2, Drizzle ORM 0.45.2, node-postgres, PostgreSQL.

## Global Constraints

- Public catalog, published detail, availability, categories, and editorial preview JSON must use a stable exported repeatable-read snapshot and must not acquire `CMS_REFERENCE_LOCK`.
- Asset authorization/open and publication/media mutation retain existing reference-lock behavior.
- `beginTransaction()` cannot be interrupted server-side by this adapter; deadline/abort ends the caller's wait promptly and late success is rolled back once without follow-on work after the adapter returns it.
- Set finite transaction-local statement/lock timeouts before snapshot import and data reads; do not run a query/DML before `SET TRANSACTION SNAPSHOT`.
- Preserve eligible-only counts, exact saved-Version/current-field/reference checks, bounded keyset scans, no partial results, and microsecond cursor precision.
- Holder remains read-only and takes no advisory lock; its cooperative deadline is not a hard lifetime cap, and rollback follows settlement of in-flight work. Real PostgreSQL `pg_sleep` remains `NOT_EXECUTED`.
- Do not rerun root `npm run verify`; update and preserve the local ignored final-fix report.

---

### Task 1: Transaction startup race and explicit read-only imported-snapshot helper

**Files:**
- Modify: `cms/src/publication/transaction.ts`
- Modify: `cms/src/portal-pages/persistence.ts`
- Test: `cms/tests/unit/portal-pages-reader.test.ts`

**Interfaces:**
- Keep `withCmsTransaction(payload, incoming, work, options?)` as the lock-taking default.
- Add `withCmsReadTransaction<T>(payload, incoming, options: CmsTransactionOptions & { snapshotID: string }, work)`; it owns a read-only imported-snapshot transaction and never calls `lockCmsReferences`.
- Category/media reference helpers omit `FOR SHARE` only when `readOptions.snapshotID` is present; snapshot-backed readers rely on their imported MVCC snapshot, while asset/mutation paths retain row locks.
- Add one private budget-aware begin helper used by snapshot holders and owned transactions with a deadline/signal. If the race is lost, late success calls `rollbackTransaction(id)` once; late rejection and cleanup rejection are consumed.

- [x] Add delayed-begin fixture control and failing deadline/abort tests. Assert the caller gets 503 before releasing the begin gate, then assert one rollback, no session query, and no unhandled rejection after late success or rejection.
- [x] Add command recording to the fake transaction. Assert `BEGIN`, `SET LOCAL statement_timeout`, `SET LOCAL lock_timeout`, `SET TRANSACTION ... REPEATABLE READ, READ ONLY`, optional `SET TRANSACTION SNAPSHOT`, then data reads; fail if data query precedes snapshot import.
- [x] Implement the begin race with a cleared deadline timer/listener, post-resolution budget assertion, and attached late settlement cleanup; do not claim it cancels the adapter's active `BEGIN`.
- [x] Implement `withCmsReadTransaction` with owned transaction cleanup, timeout setup before import, `READ ONLY`, no advisory lock, prepared-query instrumentation, and transaction commit/rollback; preserve `withCmsTransaction` lock behavior.
- [x] Make category/media reference helpers skip `FOR SHARE` only for imported-snapshot reads; test that normal asset/mutation paths retain their row locks.
- [x] Reorder holder setup to install finite local timeouts before `SET TRANSACTION ... READ ONLY` and snapshot export; ensure rollback runs even if instrumentation cleanup fails.
- [x] Run the deadline, abort, setup-order, reader, and transaction-related focused tests, then CMS typecheck.

### Task 2: Move all pure JSON projection reads to lock-free snapshots

**Files:**
- Modify: `cms/src/portal-pages/reader.ts`
- Modify: `cms/src/portal-pages/editorial-preview.ts`
- Modify: `cms/tests/unit/portal-pages-reader.test.ts`
- Test: `cms/tests/unit/portal-pages-endpoint-lifecycle.test.ts`
- Test: `cms/tests/unit/portal-page-editorial-preview.test.ts`
- Test fixture: `cms/tests/fixtures/portal-page-editorial.ts`

**Interfaces:**
- `withReadBatch` receives the exported `snapshotID` and uses `withCmsReadTransaction` for each ten-candidate batch.
- Published detail and editorial preview JSON use `withCmsReadSnapshot` plus one imported read transaction. The editorial response's saved timestamp is read inside that same snapshot as its DTO.
- `resolvePublishedPortalPageForAsset` and `resolvePreviewPortalPageForAsset` remain called inside the existing lock-owning asset transaction.

- [x] Change reader fake assertions so list, detail, availability, categories, and preview JSON observe zero `CMS_REFERENCE_LOCK` calls; preserve batch-size and snapshot-import assertions.
- [x] Move the editor endpoint's DTO and `updatedAt` projection into the same lock-free snapshot; retain the existing locked asset endpoint.
- [x] Add/retain an asset route test asserting the asset path still acquires the lock before authorization and file open; assert existing publication and media mutation tests continue to observe their locks.
- [x] Rewire projection call paths to `withCmsReadTransaction`; do not add a generic caller-controlled lock bypass to `withCmsTransaction`.
- [x] Run all reader, endpoint lifecycle, preview asset, publication, media mutation, and transaction-focused CMS tests; run CMS typecheck.

### Task 3: Lock, deadline, and acceptance documentation

**Files:**
- Modify: `docs/architecture/portal-pages-content.md`
- Modify: `docs/operations/portal-contents-reader.md`
- Modify: `docs/reviews/2026-10-20-portal-contents-reader-acceptance.md`
- Modify: `.superpowers/sdd/2026-10-20-portal-contents-reader/final-fix-report.md` (ignored local report)
- Add: `docs/superpowers/specs/2026-10-21-contents-reader-round3-design.md`
- Add: `docs/superpowers/plans/2026-10-21-contents-reader-round3.md`

- [x] Document zero-lock DTO/snapshot semantics, asset 404 after publication churn, retained asset/mutation locks, finite setup order, and the lack of active `BEGIN` server cancellation.
- [x] Document that late begin cleanup is eventual when the adapter settles; if `BEGIN` never settles, a pool connection may remain held because this driver exposes no cancellation handle.
- [x] Keep guarded PostgreSQL `pg_sleep` acceptance marked `NOT_EXECUTED`; distinguish source/manual semantics from live database evidence.
- [x] Append round-3 checks and residual risks to the ignored report without staging it.

### Task 4: Final verification and commit

- [x] Run focused transaction/reader/asset/publication/API tests and public API/DTO/route tests.
- [x] Run CMS unit suite if it completes within the existing test budget; run CMS typecheck, secret scan, dependency security audit, generated-shell check if relevant, and `git diff --check`.
- [x] Do not run root `npm run verify`.
- [x] Review staged files, ensure the ignored local report remains untracked, and commit the round-3 tracked code/tests/docs/spec/plan in one focused commit.

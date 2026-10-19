# Portal Page Upload Recovery Round 2 Implementation Plan

> **For agentic workers:** Execute inline task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining Task 3 upload-recovery findings with per-upload transaction ownership, exact-path validation, and deterministic regressions through the actual Payload transaction boundary.

**Architecture:** Preserve the shared CMS reference lock, then acquire a namespace-derived per-upload PostgreSQL transaction advisory lock, then acquire the filesystem ownership lock. Init keeps filesystem ownership after the database transaction commits until the initial manifest is atomically published. Cleanup treats a live filesystem owner as deferred work. Completion checks only the manifest-declared chunk paths. A deterministic test adapter models independent Payload sessions and transaction lifecycle at `withCmsTransaction`'s real session interface.

**Tech Stack:** Node 24, TypeScript, Payload 3.90.2, `@payloadcms/db-postgres`, Drizzle `PgDialect`, PostgreSQL advisory locks/savepoints, Node test runner, real temporary filesystem fixtures.

## Global Constraints

- Do not query, modify, or otherwise touch Owner News domain tables or data.
- Keep cleanup page-upload-only, bounded to 32 distinct upload IDs per pass, with the filesystem manifest authoritative for byte state.
- Keep the lock order exactly `CMS_REFERENCE_LOCK` → UUID-derived upload advisory lock → filesystem ownership lock.
- Do not interpolate untrusted SQL; validate UUIDs and bind both signed int32 advisory-key parts as parameters.
- Keep init's filesystem ownership from before its metadata/queue commit through atomic manifest publication or safe compensation.
- Do not follow symlinks or trust/delete unknown incoming-directory entries.
- Do not start Docker/services, apply migrations, or change production deployment scripts.
- Append exact RED/GREEN evidence and final command summaries to the ignored local Task 3 report; do not stage that report.

---

## File Structure

### Create

- `cms/tests/fixtures/portal-page-upload-transaction-adapter.ts` — independent transactional snapshots, session-bound `execute`, advisory-lock serialization, savepoints, commit/rollback, and lost-receipt modeling for upload lifecycle tests.
- `docs/superpowers/plans/2026-10-19-portal-page-upload-recovery-round-2.md` — this implementation checklist.

### Modify

- `cms/src/portal-pages/persistence.ts` — stable namespaced UUID-to-two-int32 mapping and production upload advisory-lock helper.
- `cms/src/portal-pages/upload-service.ts` — consistent upload lock ordering, init ownership across commit/publication, cleanup deferral, cancellation phase ordering, and exact manifest-derived chunk validation.
- `cms/tests/unit/service/portal-page-uploads-lifecycle.test.ts` — deterministic regressions for the init/cleanup window, stale-lock reclaim races, concurrent init/complete, rollback/lost receipt, and >1,024 unrelated incoming entries.
- `docs/architecture/portal-pages-content.md` — document advisory namespace/order, init ownership handoff, cleanup deferral, and exact-path scan behavior.
- `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-3-report.md` — append round-two RED/GREEN evidence, exact test commands, verification summaries, and fidelity limits; leave ignored/unstaged.

---

### Task 1: Production per-upload advisory-lock helper

**Interface:** `portalPageUploadAdvisoryKey(rawID: string): readonly [number, number]` validates/canonicalizes the UUID and maps SHA-256 of the fixed domain string `ownerinc.portal-page-upload.advisory.v1\0` plus UUID bytes to two signed big-endian int32 values. `lockPortalPageUpload(payload, req, rawID): Promise<void>` executes a parameterized `pg_advisory_xact_lock($1, $2)` on the active Payload transaction and rechecks that session ownership remains live.

- [x] Add helper tests for canonical UUID equivalence, stable keys, distinct sample UUIDs, signed int32 bounds, invalid UUID rejection, and the exact two-argument advisory statement/parameters recorded by the transaction adapter.
- [x] Run the helper test and confirm it fails because the production helper is absent.
- [x] Implement the helper in `cms/src/portal-pages/persistence.ts`, with the fixed namespace adjacent to the mapping and no dynamic SQL text.
- [x] Run helper and existing page-persistence tests; assert the fixture observes the actual upload lock SQL so deleting that call makes the test fail.

### Task 2: Faithful session-bound transaction test adapter

**Interface:** `createPortalPageUploadTransactionAdapter(initialRows?)` returns a Payload-compatible adapter plus committed `rows`, committed cleanup `queue`, and an execution trace. Each `beginTransaction()` allocates an independent session snapshot. Every request's Payload Local API read/write uses its own session snapshot. `commitTransaction()` applies the snapshot and releases locks; `rollbackTransaction()` discards it and releases locks. A post-commit lost receipt applies changes and removes the session before throwing. Savepoints clone/restore the session snapshot. `execute()` compiles real Drizzle SQL with `PgDialect`, models CMS/upload advisory locks, and rejects unexpected transaction-control SQL.

- [x] Add adapter contract tests for independent uncommitted visibility, transaction ownership, lock blocking/release, savepoint rollback, ordinary rollback, committed lost-receipt behavior, and parameterized upload-lock observation.
- [x] Run the adapter contract tests against the completed fixture; the initial test-first RED was not recorded for this adapter.
- [x] Implement the adapter in the fixture module at the same `Payload.db.sessions[id].db.execute` boundary used by `requireCmsTransaction`, including `createLocalReq`-compatible request fields.
- [x] Verify `withCmsTransaction` creates/commits/rolls back sessions through the fixture without method-level admission gates, and verify the exact production advisory helper statement is required.

### Task 3: Lock ordering and init ownership handoff

**Interface:** Every upload filesystem critical section follows `CMS_REFERENCE_LOCK` → `lockPortalPageUpload(...)` → filesystem ownership acquisition. Init acquires the filesystem lock after creating its UUID row and upload advisory lock but before enqueue/transaction commit; it retains that lock until manifest publication and any compensation have completed. Cleanup uses a non-waiting ownership attempt; a live lock raises the existing bounded busy error, which the queue converts to retry/defer.

- [x] Add actual-init barrier regression: pause after the transaction adapter records a successful commit and before `writeManifest`, run actual cleanup through an independent session, and assert row/queue/chunks remain untouched and cleanup defers while the init filesystem lock is live.
- [x] Add two-context stale-lock reclaimer regression: pause one request while it owns the upload advisory and filesystem lock, start a second actual operation, then prove the second cannot unlink the newly established live lock or overlap the protected operation; assert both session traces contain the same production upload advisory key in the declared order.
- [x] Run the new regressions and verify the final traces, ownership deferral, and no-overlap assertions against the completed implementation.
- [x] Wrap chunk ingress in a real `withCmsTransaction` session; acquire the upload advisory lock before the filesystem lock, then re-read manifest and row under ownership.
- [x] Add the per-upload advisory lock before filesystem acquisition in complete and cleanup reconciliation; retain the transaction-scoped lock across each operation's critical file work.
- [x] Implement init's retained filesystem ownership across commit and atomic manifest publication, releasing only after publication/compensation; guarantee release on transaction/commit failure.
- [x] Run all lifecycle and focused lock tests; assert cleanup never deletes the paused init's row or paths and later reconciliation remains possible.

### Task 4: Cancellation lock-order preservation

**Interface:** Cancellation's database phases each acquire CMS advisory → upload advisory → filesystem ownership. No transaction acquires an upload advisory lock while already holding the filesystem lock. Post-commit byte cleanup occurs under the current file owner; the owner is then released before the final transaction reacquires locks in the canonical order to remove row/queue. Pending queue state remains recoverable if either phase crashes.

- [x] Add an independent-session interleaving regression that pauses cancellation after its first commit, starts cleanup/another cancellation, and proves the declared lock order has no deadlock or overlapping unlink.
- [x] Run the interleaving regression and verify canonical lock order, deferral, and session release against the completed implementation.
- [x] Refactor cancellation into the two lock-ordered transactions with idempotent handling when cleanup wins between phases; retain the queue until verified byte cleanup succeeds.
- [x] Run cancellation, promoted-file validation, expired cleanup, and ambiguous cancellation regressions.

### Task 5: Exact expected-chunk path validation

**Interface:** `inspectChunkSet(paths, manifest)` iterates only indices `0..manifest.chunkCount-1`, derives each canonical chunk and partial path from the validated UUID/index, `lstat`s those exact paths, rejects symlinks/non-regular files/incorrect sizes, and removes only exact expected `.part` files. It never scans `.incoming`, follows a symlink, or trusts/deletes unknown files.

- [x] Add a >1,024 unrelated-entry completion regression with all expected chunks present; assert completion succeeds and all unrelated names/content remain unchanged.
- [x] Add/retain exact expected-path symlink and malformed/missing expected chunk checks; unknown upload-prefixed and traversal-like entries are untouched and cannot satisfy completion.
- [x] Run the >1,024 regression against exact-path validation and verify the unknown entries remain byte-for-byte unchanged.
- [x] Replace `opendir` enumeration and the global entry-count cap with bounded exact-path checks derived from `manifest.chunkCount`.
- [x] Run focused upload and lifecycle tests; inspect that no unknown directory entry is read as trusted state or deleted.

### Task 6: Real-operation transaction regressions

**Interface:** The lifecycle transaction tests use separate adapter-created sessions and call actual `init`, `putChunk`, `complete`, `cancel`, and `cleanupExpired` service APIs. They do not replace the production lock helper, inject an admission gate, or manually seed the post-promotion state for the targeted transaction cases.

- [x] Replace the artificial independent-admission gate with two concurrent `init` calls using separate `withCmsTransaction` sessions; prove quota admission serializes and exactly one request succeeds at the boundary.
- [x] Replace the shared-session completion test with concurrent `complete` calls in independent sessions; assert identical immutable result, one final byte object, per-upload advisory execution in both sessions, and no live sessions afterward.
- [x] Add known rollback-after-promotion by failing the transactional queue schedule SQL after real filesystem promotion; assert real rollback leaves the row uploading, manifest retryable, and promoted/partial bytes compensated.
- [x] Add post-commit lost-receipt completion by applying the actual commit then throwing from the adapter; run actual cleanup reconciliation and assert complete row/hash/final bytes remain valid and the queue is rescheduled.
- [x] Run targeted tests with the adapter's session/advisory trace assertions; remove any test seam that bypasses `withCmsTransaction` or the production helper.

### Task 7: Documentation, evidence, verification, and commit

- [x] Update `docs/architecture/portal-pages-content.md` with the namespaced two-int32 advisory key mapping, lock ordering, init commit-to-manifest ownership, cleanup deferral, exact-path chunk inspection, and transaction-lock release semantics.
- [x] Append round-two RED/GREEN outcomes and transaction-adapter fidelity limits to the ignored Task 3 report. State that the fixture models Payload's session/transaction interface deterministically but does not execute PostgreSQL's actual lock manager; do not claim full server fidelity.
- [x] Run focused upload/service, lifecycle, queue, page-persistence, migration, News-media, and related CMS config tests; record exact total/pass/fail/skip counts.
- [x] Run `npm run typecheck:cms`, then the complete `npm run test:cms` suite.
- [x] Run `$env:PAYLOAD_TEST_EXTERNAL_PARENT='C:\Windows\Temp'; npm run verify`, followed by `git diff --check`.
- [x] Review `git diff` and the staged path list; stage the implementation, fixture, tests, plan, and architecture documentation only. Keep the ignored report unstaged.
- [x] Commit the focused round-two changes and confirm the final worktree status and commit hash.

## Fidelity Limits to Report

The adapter executes the real production SQL helper through the Payload session `.execute` boundary, binds/records its compiled PostgreSQL parameters, and deterministically serializes modeled advisory keys across independently owned transactions. It models transaction snapshots, lock ownership/release, savepoints, rollback, commit, and post-commit receipt loss. It does not run PostgreSQL, prove server scheduling/fairness, test cross-process kernel locks on Linux, or replace an online PostgreSQL integration test. No offline PGlite package is installed in this worktree.

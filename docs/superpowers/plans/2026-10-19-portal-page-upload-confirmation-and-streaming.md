# Portal Page Upload Commit Confirmation and Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for inline task-by-task execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make upload success depend on fresh committed media/queue state, and keep slow chunk bodies outside database transactions and the global CMS lock.

**Architecture:** Add one fresh-session state confirmation reader that clears stale request transaction IDs, acquires the canonical CMS-reference/upload advisory locks, and reads page-media plus cleanup-queue state. Init, completion, cancellation, and chunk promotion keep their filesystem owner until fresh confirmation. Chunk ingress uses a short acquire/auth transaction, an exclusive deterministic `.part` streaming phase without DB locks, and a short revalidate/promote transaction. Cancellation retains its filesystem owner across final delete and confirmation; competing DB operations fail fast at filesystem acquisition rather than waiting.

**Tech Stack:** Node 24, TypeScript, Payload 3.90.2, `@payloadcms/db-postgres`, Drizzle PostgreSQL SQL, installed `@payloadcms/drizzle` transaction semantics, Node test runner, temporary filesystem fixtures.

## Global Constraints

- Do not patch `node_modules`, override installed transaction behavior in production, change dependencies, or depend on `commitTransaction` throwing.
- Installed `beginTransaction` routes late Drizzle completion failures through a catch handler that rejects its already-settled readiness promise and resolves normally; installed `commitTransaction` removes the session before calling `resolve`. Tests must model the combined behavior accurately.
- The filesystem manifest remains byte-state authority; `portal_page_upload_cleanup` remains a scheduling/reconciliation index, with at most 32 distinct IDs per pass.
- Do not touch Owner News tables/data, News global media handling, migrations, deploy scripts, or running services.
- New database locks are acquired `CMS_REFERENCE_LOCK` → per-upload advisory lock. Never wait for filesystem ownership while holding either DB lock.
- A slow raw chunk body holds no database session, CMS reference lock, or upload advisory transaction lock; its exclusive canonical `.part` path is protected by the live filesystem owner.
- Fresh confirmation always uses a new short Payload session, reads through its active session, and fails closed on missing/mismatched rows or queue records.
- Preserve exact-path cleanup and do not enumerate, follow, or delete unknown `.incoming` entries.
- Run local checks only; Docker/services and live migrations are out of scope.
- Append precise round-three RED/GREEN and verification evidence to the ignored Task 3 report; never stage that report.

---

## File Structure

### Create

- `cms/src/portal-pages/upload-commit-confirmation.ts` — fresh-session media/cleanup snapshot reader with canonical advisory locks.
- `cms/tests/unit/service/portal-page-upload-commit-confirmation.test.ts` — exact query/session-boundary contracts for the shared confirmation reader.
- `docs/superpowers/specs/2026-10-19-portal-page-upload-confirmation-and-streaming-design.md` — approved design (already committed as `f544217`).
- `docs/superpowers/plans/2026-10-19-portal-page-upload-confirmation-and-streaming.md` — this execution plan.

### Modify

- `cms/tests/fixtures/portal-page-upload-transaction-adapter.ts` — accurately wrap installed swallowed-commit behavior; expose fail-before-apply and apply-then-lost-receipt modes; add cleanup-row reads.
- `cms/tests/unit/service/portal-page-upload-transaction-adapter.test.ts` — prove resolver failures are swallowed while rollback/commit outcomes remain visible to a later session.
- `cms/src/portal-pages/upload-service.ts` — fresh confirmation for lifecycle outcomes; split `putChunk`; exclusive-part ownership; immediate deferral for competing file owners.
- `cms/tests/unit/service/portal-page-uploads-lifecycle.test.ts` — actual operation regressions for init/complete/cancel confirmation, paused raw bodies, duplicate/conflict, and owned-part cleanup.
- `docs/architecture/portal-pages-content.md` — document commit confirmation and lock-free raw body phase.
- `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-3-report.md` — append round-three evidence and test counts (ignored/local only).

---

### Task 1: Model the installed swallowed-commit wrapper

**Interface:** The fixture models installed `beginTransaction` by settling its ready gate before client commit, then wrapping Drizzle's transaction completion promise in a catch that calls the already-settled readiness reject handler and resolves normally. Its `commitTransaction(id)` deletes the session before awaiting `session.resolve()` and uses the installed catch→`session.reject()` fallback only if the resolver itself rejects. Add controlled outcomes: `rollback-swallowed` rejects the Drizzle completion before applying the snapshot; `commit-swallowed` applies the snapshot then rejects; normal completion applies and succeeds. Every outcome leaves no session registered and releases modeled locks.

- [x] Add a test named `installed begin/commit semantics swallow late transaction completion failures` that proves `withCmsTransaction` returns after both swallowed outcomes, and a separately started transaction sees either no staged mutation or the applied mutation according to the injected outcome.
- [x] Run that adapter test and confirm it fails under the round-two fixture's throwing `commitTransaction` behavior.
- [x] Implement the wrapper around the exact installed `beginTransaction` completion-promise and `commitTransaction` session-registry semantics documented in the approved spec; do not edit installed files.
- [x] Run adapter tests and assert there are no remaining sessions/locks after success, rollback-swallowed, and commit-swallowed paths.

### Task 2: Fresh committed-state reader

**Interface:** Export `readFreshPortalPageUploadState(payload: Payload, incoming: PayloadRequest, id: string): Promise<{ media: Record<string, unknown> | null; cleanup: PortalPageUploadCleanupState | null }>` from `cms/src/portal-pages/upload-commit-confirmation.ts`. It must clone the request with `transactionID: undefined`, start a new `withCmsTransaction`, call `lockPortalPageUpload` after the shared CMS lock, read the media row using Payload Local API with that transaction request, and read `status`, `attempt_count`, `next_attempt_at`, and `last_error_code` using `requireCmsTransaction(...).execute(...)`.

- [x] Add unit tests asserting the reader starts a session distinct from an incoming live transaction, observes committed row/queue state only, and emits the parameterized upload advisory query after the shared lock.
- [x] Run the reader tests before implementation and record the initial missing-reader module-resolution failure.
- [x] Implement the reader and add the exact queue SELECT to the deterministic adapter. Normalize DB dates into a millisecond number and preserve `null` queue fields.
- [x] Run reader and transaction adapter tests; reject unexpected SQL rather than silently answering from committed maps.

### Task 3: Confirm init before publishing a manifest/token

**Interface:** After init's media+queue mutation helper returns, keep the same filesystem owner and call the fresh-state reader. Require exact `id`, actor, original name, storage key, MIME, filesize, `state: uploading`, null `sha256`/`completedAt`, and a pending queue row. Normally it has count zero, no error, and the exact enqueue timestamp. If concurrent cleanup observed the committed-init/pre-manifest bridge, also allow its valid bounded deferral: positive count, a later retry timestamp, and sanitized `cleanup_failed` code. Only then atomically write the manifest and return the token. On mismatch or confirmation failure, return bounded `upload_unavailable`; do not publish a manifest or token and leave unproven state for bounded cleanup.

- [x] Add actual-`init` regressions for swallowed rollback (no token/manifest and no false committed row) and committed-but-lost-receipt (fresh row/queue confirmation permits manifest publication and token return).
- [x] Run the actual operation regressions against both swallowed outcomes and verify the fresh-state gate rejects rollback and accepts applied state.
- [x] Capture the initial timestamp once, implement exact row/queue comparison using the shared reader while filesystem ownership remains held, and preserve safe manifest-failure compensation.
- [x] Run init admission, commit-window, lost-receipt, queue repair, and cleanup regressions.

### Task 4: Confirm completion and cancellation outcomes

**Interface:** Completion records the exact `completedAt` and queue schedule timestamp used by its transaction. After promotion and mutation-helper return, keep filesystem ownership and require a fresh snapshot matching complete state, owner, storage key, MIME, size, SHA-256, exact completion time, and expected pending queue record. On mismatch/confirmation failure, return `upload_unavailable` and preserve the renamed manifest/final bytes. Cancellation keeps its file owner through final delete transaction return and fresh confirmation that media and queue rows are absent and only the upload's derived owned paths are gone. Competing complete/cancel requests must fail fast with bounded busy while another owner is live; they must not poll under the global lock.

- [x] Add actual `complete` and `cancel` tests for swallowed rollback (no success) and commit-swallowed (fresh committed state is accepted). Assert ambiguous completion keeps final bytes plus renamed manifest; ambiguous cancellation remains reconcilable.
- [x] Run the actual operation regressions against both swallowed outcomes; an additional fresh-queue mismatch test proves the queue snapshot is exact.
- [x] Implement exact completion row/queue comparison and cancellation absence/path confirmation; retain filesystem ownership through the final cancel transaction and fresh confirmation.
- [x] Change complete/cancel filesystem lock acquisition to fail fast rather than wait under DB locks, and update concurrent completion assertions to retry after the owner releases.
- [x] Run completion retry, cancellation/cleanup interleaving, promoted-file validation, rollback, and commit-confirmation regressions.

### Task 5: Split chunk ingress around the raw body

**Interface:** `putChunk` has three phases. Phase A uses a short transaction to acquire CMS → upload locks, authenticate/re-read manifest and row, validate index and declared byte length, then acquire filesystem ownership. Phase B streams into the exact `chunkPartPath(id,index)` with exclusive `wx`, exact bytes, digest, write-all, private mode, and abort cleanup while holding no DB session/transaction lock. Phase C, still holding filesystem ownership, opens a second short transaction, takes CMS → upload locks, revalidates token/manifest/row, then hashes an existing destination for duplicate/conflict or atomically renames the owned part and syncs. A final fresh snapshot verifies the active upload identity and exact chunk destination size/hash before success. A flag set only after exclusive-open success determines whether failure cleanup may remove the partial.

- [x] Add a barrier-controlled paused-body test: while `putChunk` is paused in body consumption, run an unrelated `withCmsTransaction` reference-lock request to completion and assert the chunk has no live DB session.
- [x] While the body remains paused, call actual same-upload cleanup, complete, and cancel; assert each defers/fails fast and leaves the owner and partial untouched.
- [x] Add abort/short/oversized body tests proving only a successfully opened request-owned `.part` path is removed; verify exclusive-open failure preserves a pre-existing path and process-identity-proven stale-owner recovery removes only the exact deterministic partial; retain identical duplicate success and conflicting duplicate 409 checks.
- [x] Run the barrier and ownership tests and confirm an unrelated CMS reference-lock transaction completes while the raw body is paused.
- [x] Refactor `putChunk` into acquire/auth, body, and revalidate/promote phases. Reuse existing streaming/write-all helpers and keep the filesystem lock live across all phases.
- [x] Run upload/lifecycle tests, including 500 MiB streaming proof and round-two exact-path/chunk-cleanup regressions.

### Task 6: Documentation, verification, report, and commit

- [x] Update the Portal page architecture doc with fresh commit confirmation, swallowed adapter semantics, body streaming without DB locks, file-owner deferral, and deterministic `.part` crash recovery.
- [x] Append round-three RED/GREEN evidence to the ignored Task 3 report, including exact installed wrapper behavior and adapter fidelity limits.
- [x] Run focused upload/commit-confirmation/transaction-adapter/persistence/migration/News-media/config tests; record exact test/pass/fail/skip counts.
- [x] Run `npm run typecheck:cms` and `npm run test:cms`.
- [x] Run `$env:PAYLOAD_TEST_EXTERNAL_PARENT='C:\Windows\Temp'; npm run verify` and `git diff --check`.
- [x] Review staged paths. Commit implementation, tests, plan, and architecture doc separately from the already-committed design. Keep the ignored report unstaged.
- [x] Confirm clean tracked status and report both commit hashes.

## Required Residual-Risk Statement

The test adapter reproduces the installed `@payloadcms/drizzle` session-registry/resolve/reject swallowing behavior and drives the real `withCmsTransaction`/confirmation code. It does not execute PostgreSQL's actual transaction manager, prove server lock scheduling, or replace an online database integration test. No live migration or service is run.

## Verification Commands

Run the focused suite from `cms/`:

```powershell
node --import tsx --test tests/unit/service/portal-page-uploads.test.ts tests/unit/service/portal-page-uploads-lifecycle.test.ts tests/unit/service/portal-page-upload-transaction-adapter.test.ts tests/unit/service/portal-page-upload-commit-confirmation.test.ts tests/unit/service/portal-page-upload-queue.test.ts tests/unit/portal-page-migration.test.ts tests/unit/portal-page-persistence.test.ts tests/unit/service/config.test.ts tests/unit/portal-page-uploads-nginx.test.ts tests/unit/news-media.test.ts tests/unit/news-media-import.test.ts
```

Run repository checks from the repository root:

```powershell
npm run typecheck:cms
npm run test:cms
$env:PAYLOAD_TEST_EXTERNAL_PARENT='C:\Windows\Temp'; npm run verify
git diff --check
```

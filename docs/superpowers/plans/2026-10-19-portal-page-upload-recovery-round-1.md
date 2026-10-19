# Portal Page Upload Recovery Round 1 Implementation Plan

> **For agentic workers:** Execute inline task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the Task 3 upload-review findings with bounded, recoverable cleanup, crash-safe locks, exact byte validation, transaction-safe cancellation, and behavioral regression coverage.

**Architecture:** Keep the filesystem manifest authoritative for upload bytes and lifecycle. Add a private PostgreSQL queue index with idempotent enqueue, deterministic batches of no more than 32 IDs per init, item savepoints, retry/backoff, and reconciliation against media rows/manifests. Keep queue operations in the same database transactions as init/completion metadata where possible; preserve queue rows until cancellation cleanup is confirmed.

**Tech Stack:** Node 24, TypeScript, Payload 3.90.2, `@payloadcms/db-postgres`, PostgreSQL migrations, Node test runner, real temporary filesystem fixtures.

## Global Constraints

- Do not read or alter Owner News domain tables or data.
- Preserve Payload News's global `useTempFiles: false` and 50 MiB buffered upload parser.
- Keep video/PDF streaming bounded; never allocate a 500 MiB whole-file buffer.
- Never delete a promoted final file without validating server-owned path, exact size, and manifest SHA-256.
- Queue infrastructure is page-upload internal; backlog work is bounded to 32 distinct IDs per init and does not gate safe admission.
- A failed required enqueue rolls back media init; queue pass and poison-item failures are isolated and retried.
- Keep `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-3-report.md` untracked/ignored and append exact RED/GREEN and command evidence.
- Do not start Docker/services or apply migrations to a live database.

---

## File Structure

### Create

- `cms/src/migrations/20261019_160000_portal_page_upload_cleanup.ts` — additive internal cleanup queue and explicit safe down precondition.
- `cms/src/migrations/20261019_160000_portal_page_upload_cleanup.json` — full post-migration schema snapshot including only the new page-upload table.
- `cms/tests/unit/service/portal-page-upload-queue.test.ts` — queue ordering, budget, retries, poison isolation, idempotent enqueue/repair, and independent-transaction behavior.
- `docs/superpowers/plans/2026-10-19-portal-page-upload-recovery-round-1.md` — this execution plan.

### Modify

- `cms/src/portal-pages/upload-service.ts` — write-all sink, exact signatures, process-aware atomic locks, durable queue, cancellation/reconciliation, bounded streaming hooks.
- `cms/src/migrations/20261019_150233_portal_page_media_upload_lifecycle.ts` — guard down migration with an actionable active-upload precondition.
- `cms/src/migrations/index.ts` — register the additive cleanup migration.
- `cms/tests/unit/service/portal-page-uploads-lifecycle.test.ts` — filesystem recovery, locks, rollback/ambiguous commit, cancellation, endpoint adapter, generated multi-chunk streams.
- `cms/tests/unit/service/portal-page-uploads.test.ts` — injected short/zero writes, byte-exact signatures, and maximum producer lead.
- `cms/tests/unit/portal-page-migration.test.ts` — cleanup table isolation and queue/lifecycle down guards.
- `cms/tests/unit/portal-page-persistence.test.ts` — preserve complete-only media selection across cancellation changes.
- `docs/architecture/portal-pages-content.md` — document queue consistency, batch budget, backoff, and recovery.
- `.superpowers/sdd/2026-10-19-portal-conteudos-modulares-mvp-4-dias/task-3-report.md` — append this round's precise RED/GREEN and verification results; do not stage it.

---

### Task 1: Byte-safe writes and signatures

**Interfaces:** `createPortalPageUploadService` receives test seams for file-handle writes and identity functions; production defaults use Node file handles and Linux process identity. `createFileHandleSink` and manifest/lock writes call a shared `writeAll(handle, buffer)` helper.

- [x] Add tests that inject writes returning short positive counts and zero; expect complete retry on short writes, bounded storage cleanup plus a retryable upload state on zero progress.
- [x] Add high-bit corruption cases for PDF header, MP4 `ftyp`/brand, EBML ID/DocType, and WebP `RIFF`/`WEBP`; expect `invalid_media_file`.
- [x] Instrument the 500 MiB synthetic stream to record the maximum `produced - consumed` lead during each push/write, not only its final value.
- [x] Run the focused upload test files with `npm --prefix cms run test:unit` only after confirming the focused selector mechanism in `cms/scripts/test.mjs`; otherwise invoke Node with `--import tsx --test` and explicit test file paths.
- [x] Implement `writeAll`, route every raw `FileHandle.write` through it, and compare fixed signatures as byte buffers.
- [x] Re-run the focused files; require zero progress to fail closed and max lead to remain bounded.

### Task 2: Process-instance locks and atomic publication

**Interfaces:** Persist `{version,pid,processInstanceNonce,processStartIdentity,createdAt,nonce}` in lock content. Inject `readProcessIdentity(pid)` and `writeFileHandle` in tests.

- [x] Add tests for same PID/different process instance, PID reuse with changed process-start identity, current live instance beyond the old retention interval, and empty/partial canonical locks.
- [x] Verify a lock can only appear at its canonical path with complete JSON: create a uniquely named temp file with exclusive mode, write-all/sync it, publish by atomic hard link, unlink the temp, then sync the directory.
- [x] Implement Linux identity as boot ID plus `/proc/<pid>/stat` start ticks; treat unavailable foreign-process identity as busy, not stale. Treat exact current instance as live regardless of age.
- [x] Recover malformed legacy lock files only after the stale grace and no-follow regular-file checks; never follow or remove symlinks.
- [x] Run lock/lifecycle tests and confirm independent upload IDs still progress when one old lock is corrupt.

### Task 3: Durable bounded queue and migration

**Interfaces:** Queue rows use unique `upload_id`, `pending|done`, `next_attempt_at`, `attempt_count`, sanitized `last_error_code`, and timestamps. `enqueuePortalPageUploadCleanup(db, id, dueAt)` is an idempotent upsert. `processPortalPageUploadCleanup(context, transactionReq, budget)` handles at most 32 distinct IDs.

- [x] Add migration tests first: queue SQL touches only `portal_page_upload_cleanup` and `portal_page_media`; down rejects pending queue entries or uploading rows with a clear message; repeated enqueue is idempotent.
- [x] Add queue tests with >32 expired completed manifests, repeated calls that progress to the end, one poison entry with backoff, duplicate enqueue, missing-row repair, and concurrent independent request contexts.
- [x] Add an additive migration creating the private queue table with unique upload ID, status check, retry metadata, deterministic due index, and no Owner News relation/FK.
- [x] Add the queue migration down guard; update the existing lifecycle migration down guard before restoring `sha256 NOT NULL`.
- [x] Register the migration and derive the new schema snapshot from the prior generated snapshot plus the one page-upload queue table.
- [x] Implement a pass-level savepoint, per-entry savepoint, due ordering `(next_attempt_at, upload_id)`, a shared total budget of 32 including missing-record repair, `SKIP LOCKED`, retry/backoff, and sanitized finite failure codes.
- [x] Enqueue in the init metadata transaction; update completion scheduling with the same complete-metadata transaction. Keep queue rows pending until cancel/expiry filesystem cleanup is confirmed; keep done tombstones for completed media.
- [x] Re-run queue and migration tests, then CMS typecheck.

### Task 4: Cancellation, commit reconciliation, and transaction behavior

**Interfaces:** Manifest cancellation preserves optional `finalSha256`; queue row remains pending until cleanup has completed. Tests use independent `PayloadRequest` transaction IDs and fixture transaction callbacks that model rollback and ambiguous commit receipts.

- [x] Add tests for cancel after rename while the DB row is still uploading; assert final bytes are deleted only after hash/path verification and the final hash remains in the cancelling manifest until cleanup.
- [x] Add known update/commit failure tests: no complete row is left, final/temporary bytes are compensated when rollback is known, and queue/manifest state remains retryable when compensation cannot be proven.
- [x] Add unknown commit tests with both outcomes: DB complete reconciles against renamed bytes/hash; DB uploading remains resumable/cancellable with its manifest and bytes intact.
- [x] Add concurrent quota admission across independent transaction contexts (never exceed actor/global limits) and concurrent completion across independent contexts (one immutable final result).
- [x] Implement queue reconciliation for receiving, assembling, ready-to-rename, renamed, and cancelling; catch per-item failures behind savepoints, advance retry metadata, and continue unrelated IDs.
- [x] Ensure init does not fail because a queue batch is incomplete or a poison item is deferred; required queue insertion remains atomic with metadata creation.
- [x] Re-run lifecycle and queue suites.

### Task 5: Endpoint and multi-chunk behavioral proofs

- [x] Call the exported Payload chunk endpoint with an exact 5 MiB raw body through a minimal `Request`/`PayloadRequest` adapter; inspect the installed Payload router package first and use direct router dispatch if it is available without services.
- [x] Add generated 2+ chunk PDF data streams into the real temporary filesystem, assert final exact byte count and SHA-256, and prove no whole-file source buffer is created.
- [x] Implement any needed endpoint body adapter only at the actual exported handler boundary; document the reason if direct installed-router dispatch requires a live service/database.
- [x] Run focused endpoint, multi-chunk, and Nginx isolation tests.

### Task 6: Final verification, report, and commit

- [x] Append precise RED/GREEN evidence for each newly added behavior to the existing ignored Task 3 report.
- [x] Run focused upload/queue tests, page persistence and News-media regressions, `npm run typecheck:cms`, and the full CMS suite.
- [x] Run root `npm run verify` with `$env:PAYLOAD_TEST_EXTERNAL_PARENT='C:\Windows\Temp'`; run `git diff --check`.
- [x] Inspect the staged file list; stage implementation, tests, migration/snapshot, architecture docs, and this plan only. Leave the Task 3 report unstaged.
- [x] Commit focused implementation/test/migration changes and verify final status/commit IDs.

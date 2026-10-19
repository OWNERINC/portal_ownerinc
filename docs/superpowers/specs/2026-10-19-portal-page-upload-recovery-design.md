# Portal page upload recovery hardening — design

## Goal and boundaries

Harden Task 3's private Portal page upload lifecycle against cleanup backlogs, process crashes, ambiguous database commits, short writes, and signature-byte ambiguity. The cleanup index is strictly page-upload internal. No Owner News domain table or data is read or changed, and the global Payload News upload parser remains untouched.

## Cleanup queue and consistency model

Add one private `portal_page_upload_cleanup` table. It is a durable work index, not the source of byte truth. The filesystem manifest remains authoritative for upload byte state, state transitions, final hash, and storage key. Every queue item is reconciled against the Payload media row and validated manifest before any filesystem deletion or completion transition.

The queue has one row per upload ID, with a uniqueness constraint, `pending`/`done` scheduling state, `next_attempt_at`, bounded attempt count, an allowlisted last-error code, and timestamps. Enqueue is an idempotent upsert. The `done` row for completed media is a tombstone that prevents routine repair from endlessly re-enqueueing an already-cleaned manifest. Cancelled media's queue row is removed only after both its byte paths and manifest are safely removed.

Init creates the media row and queue row in the same Payload transaction. It writes the initial manifest only after that transaction is confirmed; if manifest creation fails, it compensates the row and queue in a new scoped transaction. Thus an uncertain init commit leaves either a queueable metadata row with no client-visible token or no committed row; it does not return a token before both records exist. Completion updates media metadata and its queue due time in the same transaction. Cancellation and expiry retain a pending queue row until filesystem cleanup is confirmed, so a lost commit receipt can be reconciled by a later pass.

Each init spends a single budget of at most 32 distinct upload IDs across both queue processing and missing-row repair, ordered by `next_attempt_at, upload_id` for due work and by media ID for repair; locked queue rows are skipped. Each item runs behind a database savepoint. A failed item rolls back only its own database work, preserves its manifest for retry, and receives exponential backoff with a capped delay and sanitized error code. A missing queue row is repaired from a bounded, deterministic anti-join over page-media rows; an idempotent upsert and unique upload ID tolerate repeated repair and duplicate enqueue attempts. Rows already marked done remain indexed. Queue reads/repair run behind a pass-level savepoint and are best-effort for this request; queue failure does not itself reject an otherwise safe init. The media row plus its atomic queue enqueue are required for accepting an upload, so failure there rolls back init and returns a bounded error. Existing active-count and disk-reservation checks remain fail-closed.

## Lock and filesystem behavior

Each process has a random instance nonce and a process-start identity. Locks record PID, process instance nonce, process-start identity, lock nonce, and creation time. Production Linux identity uses boot ID plus `/proc/<pid>/stat` start ticks, distinguishing a reused PID or a replacement container's PID 1. The current instance's live lock is never stolen, irrespective of age. If another process's identity cannot be established, the lock is treated as busy rather than guessed stale.

Lock content is written completely to an exclusive temporary file, synced, then published with an atomic no-overwrite link; the canonical lock path is never visible empty or partially written by the normal writer. A malformed/empty legacy lock can be recovered only after a conservative age check and safe regular-file verification. Lock/temp cleanup never follows symlinks. Process identity and filesystem primitives are injectable in unit fixtures so PID reuse, live-lock, crash-artifact, and atomic-publication paths can be tested deterministically.

All writes through `FileHandle` use one write-all helper that loops over short writes, advances the offset, and rejects zero progress. A failed chunk/manifest/assembly write removes its owned partial path when safe and leaves the manifest in a retryable state. Streaming remains backpressured and bounded.

## Cancellation and reconciliation states

The manifest gains a `cancelling` state that preserves `finalSha256` whenever it was already computed. Owner cancellation of an uploading database row first validates the row/manifest identity, then records cancellation, verifies any promoted target against its server-owned storage key, declared size, and retained hash, and only then removes bytes. The row and queue item survive until cleanup is confirmed. A completed media row remains non-cancellable.

The queue reconciler handles receiving, assembling, ready-to-rename, renamed, and cancelling manifests. It can resume a valid promotion, reconcile a complete database row to a renamed manifest, finish a cancelled/expired upload, or defer an unresolved/corrupt item without stopping unrelated queue entries. A metadata row with no manifest is treated as an interrupted init: only exact server-derived temporary/chunk paths may be removed after regular-file checks; a promoted final file without manifest hash identity is preserved and the entry is deferred. Cleanup never guesses that such bytes belong to the upload.

## Signature validation and bounded tests

PDF, MP4, WebM, and WebP fixed markers are compared as exact byte buffers. Existing length, brand allowlist, EBML structure, decoded-image/pixel-cap, and bounded head/tail checks remain. Tests corrupt high bits at each fixed marker to prove that ASCII decoding cannot normalize invalid bytes into accepted signatures.

Behavioral tests cover more than 32 retained/expired uploads across repeated bounded passes, poison-entry isolation/backoff, queue repair and idempotence, PID reuse and partial locks, promoted-file cancellation and ambiguous commit reconciliation, short/zero writes, rollback compensation, concurrent admission/completion across independent contexts, a 5 MiB chunk through the exported Payload endpoint adapter, and generated multi-chunk real-filesystem assembly without a 500 MiB allocation. The streaming proof records maximum producer lead during consumption.

The endpoint test uses the installed Payload router/dispatcher directly if it can be exercised without starting services. If that requires a live database or server, the dependency-free test calls the actual exported Payload endpoint handler through a minimal `Request`/response adapter and documents why the installed router cannot be booted in the offline suite.

## Migration safety

The queue table is additive and upload-specific. Its down migration refuses to drop the table while pending queue entries or uploading media rows remain, using a bounded, actionable error; completed tombstones may be dropped. The media lifecycle down migration checks for `uploading` rows before restoring `sha256 NOT NULL` and raises an explicit precondition message if any remain. Rollback does not delete uploaded bytes or silently discard active uploads. Migration tests assert queue-table isolation from News tables and exercise both rollback preconditions without applying a live migration.

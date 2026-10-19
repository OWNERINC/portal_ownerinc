# Portal page upload commit confirmation and streaming — design

**Status:** Approved for implementation on 2026-10-19. The round-three request authorizes implementation without a second spec-review pause.

## Goal and boundaries

Close two remaining Task 3 findings without changing installed packages: confirm database state from a fresh Payload transaction after lifecycle mutations, and prevent a slow raw chunk request body from retaining the global CMS reference lock or any database transaction. Keep this work inside the private Portal page upload service and its tests. Do not change Owner News tables, the global News upload parser, migrations, deployment scripts, or runtime services.

The filesystem manifest remains authoritative for upload byte state, final hash, and storage key. `portal_page_upload_cleanup` remains a bounded scheduler/reconciliation index, not byte-state authority. Unknown `.incoming` entries remain untrusted and untouched.

## Installed transaction behavior

The installed `@payloadcms/drizzle` `beginTransaction` lifts Drizzle's transaction completion promise into session `resolve`/`reject` methods. Its `done.catch(...)` handles late transaction errors by calling the reject function for the already-resolved transaction-ready promise; that handler returns normally, so a late COMMIT failure can leave `done` fulfilled. The installed `commitTransaction` removes the session from its registry before calling `session.resolve()` and only attempts `session.reject()` if that resolver itself rejects. Consequently the installed begin/commit pair can report a successful return after a late COMMIT failure. Production code will not patch `node_modules` or depend on `commitTransaction` throwing.

The deterministic adapter will accurately wrap the installed begin/commit behavior: it settles transaction-ready before commit, routes late Drizzle completion failure into the already-settled readiness reject handler (which is a no-op), removes the session before resolving, and swallows the late error. It will inject both (a) failure before the staged transaction is applied and (b) apply-then-lost-receipt. Tests must prove a service cannot report success for (a), and can recognize committed fresh state for (b).

## Fresh committed-state confirmation

Add a reusable page-upload state reader that clones the incoming request with `transactionID` cleared, opens a new short `withCmsTransaction` session, takes `CMS_REFERENCE_LOCK` then the UUID-derived upload advisory lock, and reads both the Payload media row and its cleanup row through that live session. It must not use a request/session that could be stale or fall back to a pool connection. The caller retains filesystem ownership while the fresh read and any associated filesystem check are performed.

Confirm the complete expected row/queue identity before any client-visible success:

- **Init:** exact server-created UUID, actor, original name, storage key, MIME type, byte size, `uploading` state, null hash/completion time, and a pending queue record must be visible before writing the initial manifest or returning the token. The queue must match the exact initial enqueue timestamp/count, except that cleanup may have observed this committed-init/pre-manifest window and validly deferred the live filesystem owner; that case must remain a pending row with a later bounded retry, positive attempt count, and sanitized `cleanup_failed` code. If confirmation fails, never return a token. Leave ambiguous work for bounded cleanup rather than deleting state that cannot be proven to belong to this init.
- **Complete:** after promotion and the metadata/queue transaction returns, require the exact row to be `complete` with the same storage key, size, hash, and completion time written by this operation, plus the exact queue snapshot written by that transaction (pending at `completedAt + retention`, preserving its attempt count and clearing its last error). If fresh state does not match, return a bounded non-success and preserve the renamed manifest and final bytes for reconciliation.
- **Cancel:** keep the filesystem owner through its delete transaction and a fresh check that the media row and queue row are absent and the upload's owned manifest/final/chunk paths are removed. If confirmation fails, do not claim cancellation success; pending reconciliation remains responsible for ambiguous deletion.
- **Chunk:** after final promotion/idempotent comparison, verify from a fresh session that the same actor's upload is still valid and the exact expected chunk destination has the received size/hash before returning success. A failed confirmation returns bounded non-success and leaves only the manifest-derived chunk path for retry/reconciliation.

The confirmation helper itself performs no lifecycle mutation. It reads under the canonical database lock order while the caller's already-established filesystem owner prevents same-upload cleanup or mutation. Confirmation transaction failure is treated as unconfirmed state, never as success.

## Chunk ingress phases

`putChunk` will use three phases with explicit resource ownership:

1. **Authenticate and own:** a short transaction takes CMS reference then upload advisory locks, validates the token, manifest, media row, index, and declared size, and acquires the upload filesystem owner. Return from/commit this transaction while keeping the filesystem owner.
2. **Consume body without DB locks:** stream the request with backpressure to the exact per-upload/per-index `.part` path. Open it with exclusive-create (`wx`) while holding the filesystem owner. Enforce exact declared byte count, SHA-256, write-all/zero-progress checks, private mode, and abort cleanup. This phase holds no database transaction and no CMS/upload advisory transaction lock.
3. **Revalidate and promote:** while retaining the filesystem owner, open a second short transaction and reacquire CMS reference then upload advisory locks. Re-read token, manifest, and row; if the destination exists, hash it and compare with the owned partial, otherwise atomically rename the partial to the exact expected chunk path and sync the directory. Commit/release the database locks, perform fresh-state/chunk confirmation, then release filesystem ownership.

### Why the canonical partial is request-owned and crash-safe

The canonical `<upload-id>-<index>.part` name is deterministic and derived only from the validated UUID and bounded chunk index. The per-upload filesystem owner prevents any concurrent operation from using it, and exclusive-create ensures this request never overwrites bytes it did not create. The request tracks whether it successfully created the path and removes only that path on body, abort, revalidation, or promotion failure. If the process crashes, the lock record is reclaimed only after process identity proves it stale; the next owner may `lstat` and remove only that exact expected regular `.part` path before opening it with `wx`. No directory enumeration, symlink following, unrelated-entry deletion, or arbitrary partial discovery is introduced.

Operations that encounter a live filesystem owner—cleanup, complete, cancel, and another chunk request—must defer/fail quickly rather than wait while holding the global CMS lock. Queue cleanup records a bounded retry (using the existing sanitized error code); direct operations return the existing bounded busy error. Existing completion retry semantics remain available after the competing operation releases ownership. Cancellation may retain its filesystem owner while it starts the final delete transaction and fresh confirmation: competitors that hold the CMS lock always fail fast at filesystem acquisition, so they cannot deadlock with this DB-lock reacquisition.

## Locking and error behavior

The canonical acquisition order remains `CMS_REFERENCE_LOCK` → upload advisory lock → filesystem owner whenever all are newly acquired. A phase that already owns the filesystem lock may reacquire the two database locks in that order; other operations must never wait for the filesystem owner while holding those database locks. This prevents a paused chunk body from blocking unrelated CMS reference operations and avoids lock-order cycles.

No token or success response is emitted before exact fresh-state confirmation. A mismatch or inability to confirm uses a bounded upload error, preserves only state that the cleanup reconciler can validate, and never removes a promoted final file or manifest whose transaction outcome is ambiguous.

## Verification

Regression coverage must include:

- Installed swallowed-commit semantics with failure-before-apply: init, complete, and cancel cannot report success without fresh committed-state confirmation.
- Apply-then-lost-receipt: fresh state recognizes a successful commit and permits the correct success response.
- Exact media/queue identity checks, including unexpected/missing queue state.
- A barrier-paused raw body: an unrelated CMS reference-lock transaction completes while the body is paused; no DB session remains held by chunk ingress; same-upload cleanup/complete/cancel defer; releasing the body completes normally.
- Duplicate chunk bytes return duplicate success after revalidation; conflicting bytes still return conflict; aborted/short/oversized bodies remove only the request-owned `.part` path.
- Exclusive-create failures never delete a pre-existing partial; after process identity proves the canonical owner stale, crash recovery may remove only the exact UUID/index `.part` path before reopening it with `wx`, preserving unrelated `.incoming` entries.
- Existing round-one/round-two upload, cleanup, persistence, and News-media regressions remain green.

The session adapter is deterministic and models the installed session boundary, not PostgreSQL's server lock scheduler. No package files, live database, service, Docker runtime, or Owner News data/schema are changed by this design.

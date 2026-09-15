# Task 4 Report

## Implemented

- Standardized pending-registration row and Firebase identity lock order for
  approval, rejection, recovery, retention, and cleanup.
- Kept retention cleanup in the existing transaction when the row and identity
  locks are already held; rejected rows are excluded from their own reference
  check, while rejection cleanup now runs after its local decision commits.
- Moved Firebase cleanup lookup behind the transaction and identity lock, with
  users, pending registrations, and cleanup queue references rechecked first.
- Made import identity reconciliation acquire its identity lock before local or
  Firebase inspection, revalidate pending rows, and recheck the identity under
  the lock immediately before claiming.
- Classified a local user without the import row's exact persisted UID as a
  duplicate instead of an invited identity.
- Restored an import row's previous `attempt_count` when a post-claim identity
  state remains pending, and kept ambiguous reconciliation commits in
  `processing` while discarding the client connection.
- Prevented pending, cleanup-pending, and indeterminate import states from
  incrementing `attempt_count` or becoming `failed`; those rows remain
  `processing` with `last_error` until they are resolved.
- Fixed the `lockFirebaseIdentity` import in `api/routes/user-imports.js` and
  added a guarded Firebase account-status reconciliation for ambiguous
  disable/reactivate commits.
- Bounded the registration-password Firebase/SMTP operation with
  `withRegistrationOperation`, returning controlled busy responses while
  preserving the generic 202 anti-enumeration response for identity outcomes.
- Mapped invitation identity conflicts to actionable 409/503 responses and
  exposed rejected-registration `state` as `rejected` or `cleanup_pending` in
  the admin UI.
- Reconciled non-duplicate Firebase `createUser` errors by email under the
  existing identity lock, marking discovered or unresolved outcomes as
  `FIREBASE_IDENTITY_INDETERMINATE` without inventing or deleting a UID.
- Preserved only the allowlisted `firebase_identity_indeterminate` reason in
  sanitized 503 responses so the admin UI can show the actionable state without
  exposing internal error data.
- Checked local users by normalized email under the shared identity lock before
  pending registration, recovery, or administrative invitation can create a
  Firebase identity; public registration keeps its generic 202 response.
- Made Firebase compensation reference local users and pending registrations by
  the exact known UID instead of treating another account with the same email
  as a reference.
- Cleared `firebase_enable_pending` together with `accountDisabled` on successful
  reactivation and centralized authenticated 401/403 state redirects while
  leaving ordinary permission-denied 403 responses intact.
- Made `reconcilePendingFirebaseEnables` discard its pool client when `BEGIN`,
  `COMMIT`, or `ROLLBACK` is ambiguous; known-good transactions still release
  normally.
- Committed registration rejection and its cleanup marker before external
  Firebase cleanup. An ambiguous rejection commit is reconciled on a new
  connection with a durable cleanup queue, without deleting the referenced
  Firebase identity.
- Routed profile-photo uploads through the shared `authenticatedFetch` with `FormData`, preserving
  the shared 401/403 contract and the existing upload feedback flow.
- Preserved PJ/CLT normalization, ownership/expiration checks, and strict
  registration HTTP 202 behavior.

## Verification

- `node --test tests/unit/*.test.mjs`: 282 passed.
- `npm run verify`: passed (`syntax`, `tests`, `security`, and `compose`).
- `node scripts/verify.mjs syntax`: passed.
- `git diff --check`: passed.

## Not Run

- No Docker containers/services, PostgreSQL instance, or Firebase requests were
  started, per task constraints; `npm run verify` only ran Compose config
  validation.
- A real PostgreSQL/Firebase integration test remains required to prove
  concurrent `FOR UPDATE`/advisory-lock behavior and external commit ambiguity
  under production timing; unit tests use deterministic mocks for those paths.

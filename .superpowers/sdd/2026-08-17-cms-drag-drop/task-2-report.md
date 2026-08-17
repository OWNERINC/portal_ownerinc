# Task 2 Report: CMS Publication API

## Status

Implemented Task 2 on branch `feature/cms-drag-drop`.

## Implemented

- Added authenticated CMS document routes under `/api/cms`.
- Added authorized private asset upload and streaming routes under `/api/cms/assets`.
- Registered both route modules in `api/index.js`.
- Kept CMS asset files in a private subdirectory of the existing upload volume.
- Added an explicit public `/uploads/cms-private` deny boundary so private CMS files are not served by the profile-image static route.
- Added document listing with strict `type`, `status`, `source_id`, pagination, and permission scoping.
- Added document creation with content-type permission checks, source-record validation, and initial draft revision creation.
- Added document detail responses containing metadata, draft, published, and schedule state.
- Added immutable draft revision creation with strict Task 1 block validation and monotonically increasing versions.
- Added atomic publish behavior that archives the previous publication, publishes the selected/current draft, updates pointers and timestamps, clears scheduled state, and audits the mutation.
- Added future ISO timestamp scheduling without exposing a scheduled revision as published.
- Added unpublish behavior that archives the published revision without deleting the document or source record.
- Added draft-only revision deletion scoped to manageable CMS areas.
- Added image, PDF, and video signature/MIME/size validation for uploads.
- Added authorized private asset streaming with UUID storage keys and no storage paths in JSON responses.
- Used `withAudit` for all document, revision, and asset mutations.

## Tests

- Added `tests/unit/cms-routes.test.mjs` for route registration, authentication, permission mapping, endpoint contracts, transaction/audit usage, revision immutability, scheduling validation, draft-only deletion, asset protection, and storage-path response checks.
- Extended `tests/unit/api-routes.test.mjs` for CMS route registration and the absence of a public CMS static mount.
- Extended `tests/unit/api-security.test.mjs` for CMS area permission mapping.

## Verification

- `node --test tests/unit/cms-routes.test.mjs tests/unit/api-routes.test.mjs tests/unit/api-security.test.mjs`: passed, 24 tests.
- `npm run verify`: passed, 112 tests; syntax, security, and compose checks passed.
- `git diff --check`: passed.

## Initial Concerns and Resolution

- The initial 100 KB Nginx body-limit concern was resolved in the review follow-up with a narrowly scoped 50 MB CMS asset proxy location.
- Focused tests are source-contract tests and do not run PostgreSQL transactions or real multipart uploads, as required by the brief. PostgreSQL migration and end-to-end upload validation remain deployment/integration work.
- Scheduled revision promotion and published-content consumption remain Task 3 responsibilities.

## Review Follow-up

- Added a narrowly scoped `location ^~ /api/cms/assets` before generic `/api/` in `nginx/nginx.conf` with a 50 MB body limit, upload rate limiting, same-origin protection, and the existing API proxy/authentication boundary. No public CMS asset location was added.
- Changed asset reads to require a matching CMS revision block. Published assets follow authenticated area visibility: knowledge and announcements are authenticated-user visible, academy and benefits require active source records, and reminders require active audience matching. Draft and scheduled assets require the matching CMS management permission. The uploader alone no longer grants access.
- Added draft-transaction asset validation for referenced UUIDs, usable storage keys/byte sizes, and image/PDF/video MIME compatibility.
- Corrected `X-Total-Count` to use a separate count query over all matching documents.
- Added `DELETE /api/cms/documents/:id/schedule`, which archives the scheduled state back to a draft, clears scheduling pointers, and audits `cms.document.unschedule`.
- Added focused contracts for asset visibility, block/MIME validation, list totals, schedule cancellation, and Nginx ordering/body limits.

## Review Follow-up Verification

- `node --test tests/unit/cms-routes.test.mjs tests/unit/api-routes.test.mjs tests/unit/api-security.test.mjs`: passed, 25 tests.
- `npm run verify`: passed, 113 tests; syntax, security, compose, and Nginx invariant checks passed.
- `git diff --check`: passed.

## Remaining Concerns

- Focused tests remain source-contract tests and do not run PostgreSQL transactions or real multipart uploads. End-to-end visibility, audience, and storage-file checks remain integration/deployment work.
- Scheduled revision promotion and published-content consumption remain Task 3 responsibilities.

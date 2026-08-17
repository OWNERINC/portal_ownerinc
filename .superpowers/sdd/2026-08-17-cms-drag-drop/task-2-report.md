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

## Concerns

- The current Nginx configuration has a 100 KB global client body limit. It will prevent production uploads larger than 100 KB even though the CMS API and schema allow assets up to 50 MB. A later deployment/configuration task should add a narrowly scoped authenticated CMS upload limit without creating a public asset path.
- Focused tests are source-contract tests and do not run PostgreSQL transactions or real multipart uploads, as required by the brief. PostgreSQL migration and end-to-end upload validation remain deployment/integration work.
- Scheduled revision promotion and published-content consumption remain Task 3 responsibilities.

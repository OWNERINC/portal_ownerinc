# Task 5 Report: final verification, documentation, and release readiness

## Status

CONDITIONAL / BLOCKED for release readiness.

The implementation audit passed for the local static and unit-contract checks.
The PostgreSQL migration verification could not run because
`MIGRATION_DATABASE_URL` is not configured. Deployment and live validation were
not run, as required by the task.

## Scope and history

- Worktree: `C:\PROJETOS\_ownerinc_portal\.worktrees\cms-drag-drop`
- Branch: `feature/cms-drag-drop`
- Audited range: `ba9c34f..HEAD`
- HEAD at audit: `fa4b1e4 fix: close cms navigation and media lifecycle gaps`
- Range contains the CMS storage, API, published-content integration, editor,
  follow-up fixes, tests, and prior Task 2-4 reports.
- Worktree was clean before the documentation changes; final changes are
  limited to the release checklist, changelog, and this report.

## Audit results

### Scope and safety

- The changed-file list contains the expected CMS API, migration, cron,
  frontend, navigation, Nginx asset boundary, tests, and task reports.
- No package manifest or lockfile changed, so no dependency was introduced.
- No deployment script or CI deployment behavior changed.
- No production credential, private key, API key, or secret pattern was added
  in the audited diff.
- The migration only creates CMS tables, constraints, indexes, and grants. No
  legacy table or legacy content is dropped, truncated, or deleted. The only
  revision deletion is the explicitly authorized draft-only API operation.

### CMS areas and permissions

- Knowledge maps to `manageKnowledge`.
- Academy maps to `manageAcademy`.
- Benefits maps to `manageBenefits`.
- Announcements map to `manageKnowledge`.
- Reminders map to `manageReminders`.
- API document discovery and mutations are scoped to the authenticated user's
  manageable types. The editor filters the same areas client-side, while the
  API remains authoritative.

### Publication and fallback behavior

- Draft, published, scheduled, and archived revision states are represented in
  the migration and API.
- Published revisions are not edited in place; later edits create a new draft
  version.
- Public readers return only a published revision and preserve the existing
  legacy fields when no valid published CMS blocks exist.
- Due scheduled revisions are promoted transactionally, the prior publication
  is archived, and promotion is audited.
- A future scheduled revision is not returned before its UTC timestamp.
- Reminder recurrence, audience, channel, claim, retry, and notification-log
  behavior remains in the existing flow; only the published reminder text is
  overridden through `blocksToText`, with `description` as fallback.

### Protected assets

- Image, PDF, and video uploads use signature and MIME validation, a 50 MB
  limit, UUID storage keys, and the existing private upload volume.
- `/api/cms/assets` requires authentication and checks that the asset is
  referenced by an authorized CMS revision with the correct visibility rules.
- The Nginx upload proxy has a scoped large-body limit and no public
  `/uploads/cms-private` location. The API also denies that static path.
- Filesystem paths and storage keys are not returned as public asset paths.

### Editor and renderer

- All nine approved block types are available: heading, paragraph, list,
  callout, image, divider, link, PDF, and video.
- Server and client validators reject unknown fields/types, unsafe markup,
  unsafe URLs, malformed asset IDs, and invalid block content.
- The renderer uses DOM APIs and text properties rather than raw HTML sinks.
- Native drag-and-drop, keyboard movement, selection semantics, autosave
  coalescing, dirty-navigation protection, and private object-URL cleanup are
  covered by tests.
- The editor has responsive layouts at the desktop, intermediate, and mobile
  breakpoints, including a mobile horizontal area rail and stacked inspector.

### Resend migration

- The audited CMS range does not modify the Resend SMTP transport or its
  shared API/cron configuration.
- The complete verification suite still passes the Resend transport,
  password-reset, invitation, retry, and no-SendGrid invariants.

## Static scans

- Added-diff secret scan: no private-key, cloud-key, Resend-key, or PostgreSQL
  credential pattern found. Test fixtures and the existing CI-only integration
  database fixture were not changed by this range.
- CMS source raw-HTML scan: no `innerHTML`, `outerHTML`,
  `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, or `srcdoc`
  usage found in the CMS renderer/editor/dashboard integration files.
- Destructive-operation scan: no legacy data destructive operation found.

## Required commands

### `npm run verify`

PASS. All 134 tests passed; syntax, security, and Compose checks passed.

### `npm run test:migrations`

BLOCKED as required by the brief. Exact result:

```text
Error: MIGRATION_DATABASE_URL is required
```

No production credential was fabricated or changed.

### `git diff --check`

PASS. No whitespace errors were reported.

## Manual and live acceptance

The authenticated PostgreSQL acceptance flow could not be completed without a
migration database URL. Deployment, live HTTP checks, browser-authenticated
CMS flows, and protected PDF validation were intentionally not run.

## Documentation changes

- Added CMS evidence and pending gates to
  `docs/operations/v1-release-checklist.md`.
- Added the CMS release note and pending migration/live evidence to
  `CHANGELOG.md`.
- This report is the complete Task 5 audit record.

## Blockers

1. `MIGRATION_DATABASE_URL` is missing, so migration execution, second-run
   idempotency, grants, and PostgreSQL-backed CMS acceptance are unverified.
2. Authenticated manual acceptance and live smoke validation remain pending.
3. Deployment remains intentionally not executed.

## Follow-up: CI and CMS transport blocker fixes

The remaining release blockers were fixed in this worktree without deployment or
runtime Docker/PostgreSQL execution.

### Implemented fixes

- The CI cron image now uses the repository root as its Docker build context and
  explicitly selects `cron/Dockerfile`:
  `docker build --tag ownerinc-portal-cron:${GITHUB_SHA} --file cron/Dockerfile .`.
  This matches Compose and allows the Dockerfile's `cron/` and `api/cms/` COPY
  paths to resolve. The commit tag and publish behavior remain unchanged.
- The normal API JSON parser remains capped at 100 KiB. CMS JSON requests use a
  scoped 6 MiB Express parser and matching Nginx `/api/cms/` body limit. The
  longer `/api/cms/assets` prefix remains independently capped at 50 MiB for
  multipart asset uploads.
- CMS block content has a documented 5 MiB maximum measured from the normalized
  UTF-8 block array, leaving transport overhead inside the 6 MiB JSON limit.
  Structural block validation runs before this aggregate check. The browser
  validator mirrors the same 5 MiB normalized payload bound before autosave.
- The cron fallback now has explicit coverage for image-only published blocks;
  visual-only content preserves the legacy reminder description when it renders
  no delivery text.
- CI context, Dockerfile path, image tag, CMS parser/proxy limits, aggregate
  validation order, and the 50 MiB asset exception are covered by static
  invariants.

### Verification evidence

- Focused CMS, frontend, reader, cron, and operations tests: PASS, 48 tests.
- `npm run verify`: PASS, all 139 tests passed; JavaScript syntax, security,
  static invariants, and Docker Compose configuration checks passed.
- `git diff --check`: PASS. No whitespace errors were reported.
- Runtime Docker image builds and PostgreSQL migration tests: NOT RUN. Runtime
  Docker/PostgreSQL validation remains unavailable for this task.
- Deployment, live HTTP checks, and browser-authenticated acceptance: NOT RUN by
  request.

### Remaining concerns

1. `MIGRATION_DATABASE_URL` is still unavailable, so PostgreSQL migration
   execution, second-run idempotency, grants, and database-backed CMS acceptance
   remain unverified.
2. Runtime image builds and live asset/body-limit behavior remain pending in the
   operational environment.
3. Deployment remains intentionally not executed.

## Release checklist

- [x] Audit `ba9c34f..HEAD` against the CMS design, plan, product brief, and
  repository instructions.
- [x] Verify all five content areas and permission mappings statically.
- [x] Verify publication, fallback, scheduling, protected assets, responsive
  editor, safe rendering, and Resend invariants locally.
- [x] Run `npm run verify` successfully.
- [x] Run `git diff --check` successfully.
- [ ] Set `MIGRATION_DATABASE_URL` and rerun `npm run test:migrations`.
- [ ] Execute authenticated acceptance for all five areas, including a
  protected PDF and a future scheduled revision.
- [ ] Deploy and perform live smoke checks after this audit, outside Task 5.

## Commit

Documentation and this report require commit:

`chore: finalize cms release checks`

## Follow-up: final release blocker fixes

The follow-up fixes were made in the requested worktree without deployment or
secret changes.

### Implemented fixes

- Changed the cron build context to the repository root and explicitly copied
  `api/cms/` into `/api/cms/`. The existing `/app/checkReminders.js` import
  `../api/cms/reader` therefore resolves in the built image, and the focused
  cron invariant verifies the compose context, Dockerfile copy, reader, and
  validator files.
- Added `UPDATE` to the existing `SELECT` grant for `portal_cron` on
  `cms_documents` and `cms_revisions`. `audit_log` retains its existing
  `SELECT, INSERT, UPDATE, DELETE` grant because AutoCard retention updates its
  audit row; migration verification now asserts the CMS `SELECT,UPDATE`
  privileges explicitly.
- Added `media-src 'self' blob: https:` to the Nginx CSP. Script, style, and
  connect policies were not broadened. The operations invariant rejects data
  and plain-HTTP media sources.
- Added `reminderForDelivery`; a published block rendering that is empty or
  whitespace now leaves the legacy `description` unchanged. Audience, channel,
  claim, retry, and delivery paths were not changed.
- Kept the normal JSON API limit at 100 KiB and added a scoped 6 MiB JSON parser
  and Nginx body limit for `/api/cms`. `validateBlocks` also rejects CMS block
  arrays whose normalized UTF-8 payload exceeds 5 MiB. This bounded aggregate
  contract accommodates large approved documents without claiming every
  theoretical combination of per-block maxima, and does not widen unrelated API
  request bodies. The scoped limit and aggregate guard are covered by CMS
  invariants.
- Added `GET /api/announcements/:id`, requiring authentication, a UUID, the
  `announcement` content type, and a `published` revision. Missing, draft-only,
  and future unpublished records return no detail. The announcements page now
  links published list entries to the authenticated detail request.

### Follow-up verification evidence

- Focused CMS, cron, security, migration-invariant, and frontend tests: PASS,
  58 tests.
- `npm run verify`: PASS, all 139 tests passed; syntax, security, and Compose
  checks passed.
- `git diff --check`: PASS on the final worktree before commit.
- `npm run test:migrations`: BLOCKED because `MIGRATION_DATABASE_URL` is not
  configured; no credential was fabricated or changed.
- Docker build/deploy and live HTTP/browser acceptance: intentionally not run.

### Remaining blockers

1. `MIGRATION_DATABASE_URL` is still missing, so PostgreSQL migration execution,
   second-run idempotency, grants, and database-backed CMS acceptance remain
   unverified.
2. Authenticated manual acceptance, protected asset validation, and live smoke
   checks remain pending in the operational environment.
3. Deployment remains intentionally not executed.

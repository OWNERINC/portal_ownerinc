# Task 5 Report

## Implemented

- Made the CMS document the body authority whenever a source has a document;
  legacy source editing now preserves CMS paragraphs/blocks and only changes
  source metadata, legacy storage and the requested PDF.
- Legacy Knowledge PDF edits now preserve all non-PDF blocks, replace/remove
  only one unambiguous PDF block, and reject multiple PDFs with CMS editor
  guidance.
- Added explicit stale-draft resolution for publish/schedule, returning `409`
  before state changes when the selected revision is no longer the current
  draft.
- Standardized the CMS asset advisory lock before document/source row locks in
  draft, publish, schedule, unpublish, unschedule, asset validation, scheduled
  promotion and source deletion. Retention holds the shared session lock
  through reservation, file removal and database confirmation.
- Scheduled promotion validates normalized blocks and referenced assets under
  the shared lock; invalid scheduled revisions are archived, detached and
  audited without replacing the current publication or looping.
- Made unschedule preserve a newer draft and archive the old scheduled
  revision. Made unpublish archive published and scheduled revisions so a
  removed document cannot silently reappear.
- Removed CMS documents and cascaded revisions when knowledge, Academy,
  benefits or reminder sources are deleted; unreferenced assets remain for
  retention instead of being deleted during the source transaction.
- Updated public reading, summaries, search, categories/pagination handling,
  Academy, reminders, dashboard-compatible body mapping and authenticated
  asset access to use validated published blocks without a legacy fallback for
  managed documents.
- Knowledge search now filters candidates after the reader's validated
  `blocksToText` projection, preserving total counts and pagination without a
  divergent SQL body formatter.
- CMS document navigation has total-aware pagination with token/offset guards.
- Multer upload errors return `400` for unexpected/multiple files and `413` for
  size limits. Authorized asset streams acquire the shared lock and open their
  file descriptor before releasing the transaction.
- Optional pagination containers are null-safe, including announcement detail.
- Public reminder list and upcoming queries promote due scheduled revisions
  before filtering out managed documents without a publication.
- Updated CMS badges, explicit revision payloads, predictable conflict errors,
  upload preview state and unschedule UI state without discarding drafts on
  focus changes.
- Added executable mock/behavioral coverage for legacy/CMS precedence, stale
  mutations, unschedule/unpublish state transitions, published search/read
  mapping, source deletion, asset retention and lock order.

## Verification

- Targeted CMS/cron/governance tests: `69` passed, `0` failed.
- `node --test tests/unit/*.test.mjs`: `297` passed, `0` failed.
- `npm run verify`: passed, including syntax, tests, security and compose checks.
- `node scripts/verify.mjs syntax`: passed.
- `git diff --check`: passed.

## Not Run

- No Docker containers, PostgreSQL/Firebase services or external requests were
  started, per the task constraints. Compose validation, when included by
  `npm run verify`, is configuration-only.
- Real PostgreSQL concurrency remains a deployment prerequisite for proving
  lock waits and transaction timing beyond the deterministic mocks.

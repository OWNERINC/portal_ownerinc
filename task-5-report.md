# Task 5 Report

## Current Status

CONDITIONAL / NOT APPROVED.

The focused review findings were remediated in this worktree, but Task 5 is not
marked as approved. Real PostgreSQL concurrency, live Nginx behavior, and
authenticated browser acceptance remain outside this check.

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
- Added a final source/document/published-revision recheck under
  `CMS_ASSET_RETENTION_LOCK` and `FOR UPDATE` after public validation. A source
  removed between snapshots is marked missing; a legacy-to-CMS transition or
  changed document/revision is hidden instead of returning stale fallback data.
- Cron reminder email delivery now rechecks the authoritative occurrence inputs
  (`active`, `trigger_day`/scheduled date, `target_users` and `channel`) plus the
  published CMS revision immediately before `sendEmail`, under the shared CMS
  lock and row locks. An unpublish, source removal or audience/channel/date
  change that wins that ordering is recorded as skipped and is not sent;
  transient email retries reacquire the gate. A successful claim carries the
  stable `notifications_log.id` into sending/finalization; if the reminder is
  deleted afterward and the foreign key becomes NULL, the log can still be
  finalized. A `23503` before claim returns no occurrence/log and skips only
  that stale candidate.
- Announcement list and detail reads now perform a final document/published
  revision identity recheck under the shared lock with `FOR UPDATE OF d, r`, so
  an announcement unpublished or revised after validation is omitted.
- Knowledge search now filters candidates after the reader's validated
  `blocksToText` projection, preserving total counts and pagination without a
  divergent SQL body formatter.
- Knowledge detail always fetches `GET /api/knowledge/:id` before rendering,
  preserving loading, retry/error, 404 navigation, and heading focus states.
- Knowledge and Reminders recover empty non-first pages to a valid page
  (Knowledge resets to the first page; Reminders clamps from the reported
  total), and Reminders captures each request's token, page and path so an
  out-of-order response cannot update the list, total or pagination; category
  filters in Knowledge, Academy, and Benefits compare `btrim(category)` so
  persisted surrounding whitespace does not hide matches.
- CMS document navigation has total-aware pagination with list-only
  `documentsRequestToken`/offset guards, so changing pages does not invalidate
  the selected editor. New-document POST/refresh uses its own
  `creationRequestToken` and preserves the current editor identity on failure.
- Multer upload errors return `400` for unexpected/multiple files and `413` for
  size limits. Upload authorization runs before invoking Multer's
  `memoryStorage`; supported field name/size, field count and part count
  limits, including `parts: 2` for Busboy's single file part, reject extra
  multipart input. Authorized asset streams acquire the
  shared lock and open their file descriptor before releasing the transaction.
- Asset uploads propagate pending state from the block editor, block document
  navigation and actions until completion. Success releases that state before
  the block change callback; failure does not mark the editor dirty, and stale
  editor/document/block callbacks cannot update a replacement editor.
- A failed or stale/early-return upload explicitly rearms the existing
  identity-checked autosave timer only when the current editor remains dirty and
  no action/save is blocking; a newer timer is never replaced. Successful
  uploads release busy state before `onChange` and do not create a duplicate
  timer. Upload responses cross the identity check before mutating their block,
  so stale uploads remain retention candidates without changing UI.
- The first editor `onSelect` is accepted before the editor handle assignment;
  editor generation, document selection and block-selection tokens still reject
  callbacks from older editor instances.
- Each upload increments `assetUploadVersion`. `loadDocument()`,
  `unscheduleDocument()` and `renderEditor()` capture and compare that epoch, so
  an older response cannot replace the editor after the upload has finished.
- Async document loads and unschedule responses discard results received after an
  upload starts; `renderEditor()` also refuses to replace the editor while an
  upload is pending.
- Optional pagination containers are null-safe, including announcement detail.
- Public reminder list and upcoming queries promote due scheduled revisions
  before filtering out managed documents without a publication.
- Updated CMS badges, explicit revision payloads, predictable conflict errors,
  upload preview state and unschedule UI state without discarding drafts on
  focus changes.
- CMS publish/schedule are disabled and guarded while `saving`/`saveInFlight`
  are active. With only a pending autosave timer, they use
  `saveBeforeAction()` to cancel it and save; internal queued saves retain real
  edits and the action uses the latest returned revision. Failed document creation restores the prior list,
  total and pagination; empty Academy/Benefits pages with any nonzero offset
  normalize back to offset zero. List loading blocks creation/type changes,
  failed refresh after confirmed creation restores the snapshot with an
  explicit error, and unpublish/unschedule remain disabled during autosave or
  document-list loading. Creation rejects dirty, queued or in-flight editor
  saves, clears a safe autosave timer before POST and suppresses new autosave
  timers until the creation result is settled; the editor is inert and marked
  busy during creation, actions and relevant loading, and a clean new-document
  form closes when another document is opened. Unpublish/unschedule handlers use the same
  pending-save guard and unschedule does not render over pending editor edits.
  Manual saves clear their current timer, stale timer callbacks cannot clear a
  newer timer, and document loading returns success/failure so creation only
  shows its success toast after a successful detail GET; failures leave an
  explicit retry state.
- Added deterministic source/invariant coverage for legacy/CMS precedence, stale
  mutations, unschedule/unpublish state transitions, published search/read
  mapping, source deletion, legacy-to-CMS transitions, asset retention and lock
  order, inactive-source rechecks, announcement final rechecks, cron delivery
  gating for active/date/audience/channel changes, category filters,
  stale-page recovery including the last valid page after an empty non-initial
  offset, authoritative Knowledge detail loading and out-of-order Reminders
  reloads, plus deterministic cron claim identity/FK handling and two deferred
  `node:vm` behavioral tests executing the current `assetUpload` and
  `loadReminders` functions.

## Verification

- The report committed at baseline `1085bbe` documents `69` targeted tests and
  `297` tests for `node --test tests/unit/*.test.mjs`, with `npm run verify`
  reported as passing. This is the verifiable historical baseline record.
- No repository evidence is available for a later full-suite execution beyond
  that baseline, so no additional full-suite count is claimed here.
- Current follow-up focused CMS/cron/API tests: `151` passed, `0` failed.
- `node scripts/verify.mjs syntax`: passed.
- `git diff --check`: passed.

## Not Run

- No Docker containers, PostgreSQL/Firebase services or external requests were
  started, per the task constraints.
- The complete test suite was not rerun in this follow-up, per the requested
  focused verification workflow.
- Real PostgreSQL concurrency remains a deployment prerequisite for proving
  lock waits and transaction timing beyond the deterministic mocks.

## Focused Review Follow-up

- CMS public reads now promote due schedules in a short transaction under
  `CMS_ASSET_RETENTION_LOCK`, read and validate the source/document snapshot
  without that lock, then recheck source IDs, the CMS document identity and the
  published revision identity in a final short transaction under the same lock
  and `FOR UPDATE`. Legacy sources, managed documents without a published
  revision, and disappeared sources are distinct states. A legacy-to-CMS or
  document/revision transition is hidden; disappeared sources are discarded
  and detail routes return `404`.
- Published and scheduled block/asset validation is batched per read or
  promotion. Missing, incompatible, deleting, oversized, and malformed
  revisions do not enter circulation or replace a valid publication.
- Revision ID comparisons are type-safe and case-insensitive. A missing
  Knowledge update returns `404` through a null `withAudit` callback and does
  not write a success audit row.
- Announcement detail returns normalized `validation.blocks`, not the raw
  revision payload.
- Announcement list/detail validation is followed by a shared-lock query that
  joins the currently published revision and locks both document and revision
  rows; matching document and revision IDs are required before response data is
  returned.
- Cron claims remain idempotent, but each email attempt opens a transaction,
  acquires `CMS_ASSET_RETENTION_LOCK`, locks the reminder source, confirms
  `active`, trigger-day applicability, `target_users`, `channel` and the current
  published revision, then holds that gate through the external mailer. A stale
  initial CMS snapshot cannot authorize delivery; this deliberately trades
  longer lock duration for the requested ordering guarantee.
  `notifications_log` materializes the claimed user/date/channel key but not a
  target-audience snapshot, so the gate resolves the current `target_users`
  against that claimed user. Claim returns the stable log row ID and all
  subsequent sending/finalization updates use it, allowing `skipped` to be
  written after `reminder_id` is nulled by `ON DELETE SET NULL`. A claim
  `23503` means the source disappeared before an occurrence row could be
  created: it returns no persisted claim and is isolated from later candidates.
- Knowledge detail no longer trusts the paginated `articles` cache for content;
  each open uses the authoritative endpoint, with loading/error/retry states,
  404 cleanup and focus/navigation guards preserved. Empty Knowledge pages with
  a nonzero offset retry from the first valid page; Reminders clamps an empty
  page using the reported total and ignores deferred responses from older
  request tokens, including their list, total and pagination updates.
- Knowledge, Academy and Benefits SQL category predicates use `btrim` while
  retaining the existing parameterized filters and category metadata behavior.
- The active-source check is limited to schemas that expose `active` (`academy`,
  `benefits` and `reminders`). Knowledge has no active column, and announcements
  have no separate active source table, so their public circulation remains
  governed by source existence/publication only; delivery audience is not
  invented as a public-circulation rule.
- Both `/api/cms/assets` and `/api/cms/assets/` use the 51 MiB upload limit and
  `uploads` zone; `/api/cms/assets/:id` remains on the `media_reads` limit.
  Authorization runs before Multer buffering; `fieldNameSize`, `fieldSize`,
  `fields: 0` and `parts: 2` reject unsupported multipart input while allowing
  Busboy's single file part. Multipart size errors return `413`; malformed,
  unknown, and multiple-file requests return predictable `400` responses.
- Publish and schedule are disabled and guarded during `saving`/`saveInFlight`.
  When only a timer is pending, they use `saveBeforeAction()` to cancel it and
  save; internal queued saves retain real edits and actions use the latest
  returned `revision.id`. Creation keeps the
  previous list state until POST succeeds and restores it on POST or refresh
  failure, with an explicit confirmed-creation/refresh error. `documentsLoading`
  blocks creation/type navigation while list requests are pending; pagination
  is cleared or disabled while loading. Creation blocks dirty/queued/in-flight
  saves, clears a safe timer before POST, and suppresses future autosave during
  the operation. The editor and publication controls are inert/aria-busy while
  `actionBusy`, detail loading or document-list loading is active. Unpublish
  and unschedule remain disabled while autosave or document-list loading is
  active, and their handlers also reject dirty,
  queued, in-flight or timer-pending editor saves; clean new-document forms
  close on selection.
- Academy/Benefits normalize any empty page with `offset > 0`, including
  `total=0`, and clear pagination when the normalized empty page is at offset
  zero.
- Focused mocks execute source removal and legacy-to-CMS creation between the
  initial read and final locked recheck, and frontend invariants cover initial
  list loading, POST failure, confirmed creation with refresh failure and
  restored cache state, editor inertness, action guards and asset-upload busy
  propagation, list-only pagination identity, creation failure identity,
  save-in-flight action guards, upload-failure autosave retry, upload epochs,
  render guards and pre-mutation stale checks. Two deferred `node:vm` tests
  execute `assetUpload` and `loadReminders` behaviorally for success, failure,
  stale and out-of-order responses; cron tests also cover log-ID finalization
  after FK nulling and an isolated pre-claim `23503`; they still do not provide
  browser, DB, Nginx or real multipart HTTP acceptance. Reader mocks distinguish source absence, real
  legacy rows, draft or invalid-status documents, and asset/promotion failure
  states.

## Focused Verification

- `node --test tests/unit/cms-blocks.test.mjs tests/unit/cms-reader.test.mjs tests/unit/cms-routes.test.mjs tests/unit/cms-contracts.test.mjs tests/unit/cms-frontend.test.mjs tests/unit/frontend-invariants.test.mjs tests/unit/operations-invariants.test.mjs tests/unit/cron.test.mjs tests/unit/api-routes.test.mjs tests/unit/governance-routes.test.mjs`: `151` passed, `0` failed after the cron occurrence gate, inactive-source recheck, announcement recheck, authoritative Knowledge read, pagination, category-filter, Reminders request-identity and notification-log identity changes.
- `node scripts/verify.mjs syntax`: PASS after the final implementation, test and report changes.
- `git diff --check`: PASS after the final implementation, test and report changes.

## Remaining Limitations

- The requested focused suite is green, but no deployment-environment acceptance was run.
- No Docker container, API/cron service, PostgreSQL/Firebase service, migration,
  live Nginx request, or authenticated browser flow was started.
- Real PostgreSQL transaction timing and concurrent source deletion still need
  deployment-environment acceptance.

## Task 6 Boundary

Task 5 altered the publication/reminder delivery gate to prevent sends after
unpublication. Durable retry after restart, idempotency after SMTP acceptance,
and a `loadDeliveryManager` request token remain Task 6 pending work. No outbox,
SMTP idempotency protocol, durable retry mechanism or complete delivery-history
token was implemented here.

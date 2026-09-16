# Task 5 Report

## Status

CONDITIONAL / NOT APPROVED.

The focused findings-remediation work is present in branch
`fix/cms-checkpoint-gates`, based on checkpoint `1085bbe`. Task 5 remains
conditional and is intentionally not marked approved.

## Findings Remediated

- Public CMS reads promote due schedules in a short transaction under
  `CMS_ASSET_RETENTION_LOCK`, then read and validate in a separate snapshot
  without holding that lock. A final source/document/published-revision identity
  recheck runs under the same lock and `FOR UPDATE`, so removal between
  snapshots is discarded and legacy-to-CMS or revision changes are hidden.
  Legacy sources and CMS documents without a valid publication remain distinct
  states; detail reads return `404` when hidden.
- Block and asset validation is batched for public lists and scheduled
  promotion. Missing, incompatible, deleting, oversized, invalid-status, and
  malformed content cannot enter public circulation or replace a valid
  publication.
- Revision ID matching is type-safe and case-insensitive. An absent Knowledge
  update returns `404` through a null `withAudit` result and writes no success
  audit row.
- Nginx has independent upload locations for `/api/cms/assets` and
  `/api/cms/assets/`, both using 51 MiB and `uploads`; `/api/cms/assets/:id`
  remains on `media_reads`. Multer size errors return `413`, while malformed,
  unknown-field, and multiple-file multipart requests return `400`. Upload
  authorization runs before Multer buffering, with supported field name/size,
  field-count and `parts: 2` part-count limits rejecting extra multipart input
  while allowing Busboy's single file part.
- Asset uploads propagate pending state through the block editor into CMS
  navigation and action guards. Success releases busy state before the block
  change callback; failures do not mark dirty, and stale editor/document/block
  callbacks cannot update a replacement editor.
- Failed or stale/early-return uploads explicitly rearm the existing
  identity-checked autosave timer only for a current dirty editor without an
  action/save blocker; a newer timer is never replaced. Successful uploads
  release busy state before the block change callback and do not create a
  duplicate timer. Upload identity is checked before block mutation, so stale
  uploads can remain for retention without changing current UI.
- The first editor `onSelect` is accepted before the editor handle assignment;
  editor generation, document selection and block-selection tokens still reject
  callbacks from older editor instances.
- Each upload increments `assetUploadVersion`. `loadDocument()`,
  `unscheduleDocument()` and `renderEditor()` capture and compare that epoch, so
  an older response cannot replace the editor after the upload has finished.
- Document pagination invalidates only list requests through
  `documentsRequestToken`; creation uses a separate `creationRequestToken`, so
  a failed POST or refresh does not invalidate the current editor identity.
- Async document loads and unschedule responses discard results received after an
  upload starts; `renderEditor()` also refuses to replace the editor while an
  upload is pending.
- Cron reminder sends recheck the authoritative occurrence inputs (`active`,
  `trigger_day`/scheduled date, `target_users` and `channel`) plus the published
  CMS revision immediately before `sendEmail`, under the shared CMS advisory
  lock and row locks, holding that gate through the external mailer.
  Unpublished, deleted, or no-longer-eligible occurrences are skipped instead
  of using the stale initial query result; transient retries reacquire the gate.
  Successful claims return the stable `notifications_log.id`, which is used for
  sending/finalization even after `ON DELETE SET NULL` clears `reminder_id`.
  A pre-claim `23503` returns no persisted occurrence and skips only that stale
  candidate without aborting later candidates. The occurrence key stores
  user/date/channel but no audience snapshot, so the gate resolves the current
  `target_users` against the claimed user.
- Announcement list and detail reads perform a final document/published-revision
  identity recheck under the shared lock with `FOR UPDATE OF d, r` after block
  validation.
- Knowledge detail always reads `GET /api/knowledge/:id` before rendering,
  retaining loading, retry/error, 404 navigation and heading focus behavior.
  Knowledge and Reminders recover empty non-first pages (Knowledge to the first
  page, Reminders using the reported total), and Knowledge, Academy and Benefits
  use `btrim(category)` in SQL filters. Reminders captures each request's token,
  page and path so out-of-order responses cannot update the list, total or
  pagination.
- Active-source visibility is checked only for Academy, Benefits and Reminders,
  whose schemas expose `active`. Knowledge has no active source column and
  announcements have no separate active source table; their public circulation
  remains governed by source existence/publication, without inventing audience
  rules for public reads.
- Publish and schedule are disabled and guarded while `saving`/`saveInFlight`
  are active. When only a timer is pending, they use `saveBeforeAction()` to
  cancel it and save; internal queued saves retain real edits and actions use
  the latest returned `revision.id`. Failed creation restores the previous
  list state; successful creation invalidates the list and pagination is
  cleared or disabled during loading. Academy and Benefits reset any empty
  page with `offset > 0`, including `total=0`, and clear pagination at offset
  zero. List loading blocks creation/type navigation, confirmed creation with
  refresh failure restores the cache with an explicit error, and unpublish and
  unschedule remain disabled while autosave or document-list loading is active.
  Creation rejects dirty, queued or in-flight editor saves, clears a safe timer
  before POST, suppresses future autosave during the operation, and closes a
  clean new-document form when another document is opened. The editor is inert
  and marked busy during creation, actions and relevant loading;
  unpublish/unschedule use the same pending-
  save guard and unschedule does not render over pending editor edits. Manual
  saves clear their current timer, stale callbacks cannot clear a newer timer,
  and document loading returns success/failure so creation only shows its
  success toast after a successful detail GET, with an explicit retry state on
  failure.

## Tests

- The report committed at baseline `1085bbe` documents `69` targeted tests and
  `297` tests for `node --test tests/unit/*.test.mjs`, with `npm run verify`
  reported as passing. This is the verifiable historical baseline record.
- After checkpoint `8e46f34`, `npm run verify` passed, including the complete
  unit suite: `325` passed, `0` failed, plus syntax, security and compose checks.
- Focused deterministic source/invariant checks cover source absence versus legacy presence, CMS draft and
  invalid publication status, missing/incompatible/deleting/oversized assets,
  invalid scheduled promotion, source removal before the final locked recheck,
  case-insensitive IDs, normalized announcement detail, null audit updates,
  inactive-source and announcement final rechecks, cron publication gating for
  active/date/audience/channel changes, claim log-ID finalization after FK
  nulling, isolated pre-claim `23503`, authoritative Knowledge detail reads,
  stale-page recovery including the last valid page after an empty non-initial
  offset and whitespace-tolerant category filters,
  editor inertness, action guards, list-only pagination identity, creation
  failure identity, save-in-flight action guards, render guards, upload epochs
  and asset-upload busy propagation. Two deferred `node:vm` tests execute
  `assetUpload` and `loadReminders` behaviorally for success, failure, stale and
  out-of-order responses; the remaining checks are deterministic
  source/invariant checks, not browser, DB, Nginx or real multipart HTTP
  acceptance.
- `node scripts/verify.mjs syntax`: PASS.
- `git diff --check`: PASS after the implementation, tests and report changes.
- The requested focused `node --test` command, expanded for the cron/API
  findings: `151` passed, `0` failed after the deferred Reminders request-order
  behavior test, notification-log identity handling and the five follow-up fixes.

## Limitations

- The requested focused suite is green, but deployment-environment acceptance remains.
- Docker, API/cron services, PostgreSQL/Firebase, migrations, live Nginx
  requests, and authenticated browser acceptance were not started.
- Real PostgreSQL concurrency and lock timing remain deployment-environment
  gates.

## Task 6 Boundary

Task 5 altered the publication/reminder delivery gate to prevent sends after
unpublication. Durable retry after restart, idempotency after SMTP acceptance,
and a `loadDeliveryManager` request token remain Task 6 pending work. No outbox,
SMTP idempotency protocol, durable retry mechanism or complete delivery-history
token was implemented here.

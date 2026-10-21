# Contents Reader Round 3 Design

## Goal and scope

Close the remaining reader deadline/lock gap without claiming that the pinned
database driver can cancel an active PostgreSQL `BEGIN`. Public published DTO,
catalog, availability, and category reads, plus editorial preview JSON, use an
exported repeatable-read snapshot and never take `CMS_REFERENCE_LOCK`. Exact asset
authorization/open paths and publication/media mutations retain their existing
reference-lock serialization.

The snapshot is the committed-state boundary for each projection request. It does
not pin authorization for a later asset request: publication or reference churn
between DTO delivery and asset authorization may correctly make the later asset
request return 404. No bytes are opened by a projection transaction.

## Transaction boundaries

- Keep `withCmsTransaction`'s reference lock as the default for existing mutation,
  publication, and asset workflows.
- Add an explicit imported-snapshot read transaction helper. It owns a short
  read-only transaction, imports the caller's held snapshot, installs the
  per-operation budget instrumentation, runs only projection reads, and commits
  or rolls back without acquiring an advisory reference lock. Snapshot-backed
  category/media validation omits its existing `FOR SHARE` row-lock queries;
  MVCC supplies the stable reference view. Non-snapshot mutation and asset paths
  retain those row locks.
- Keep the exported-snapshot holder read-only and lock-free; cleanup rolls it back
  after awaited operations settle, but the cooperative deadline does not guarantee
  release time for an in-flight adapter/server call.
  Both holder and imported batch transactions use a caller-facing race around
  `beginTransaction()` using remaining budget and `AbortSignal`.
- If the budget wins before the adapter returns a transaction ID, return sanitized
  503 immediately and attach both fulfillment and rejection handlers to the still
  pending begin promise. A late successful begin is rolled back exactly once before
  any import/data/lock operation. A late begin rejection is handled. This does not
  cancel the server-side `BEGIN`; a begin that never settles may retain its pool
  connection until the driver settles it.

## Setup ordering and consistency

Installed Payload 3.90.2 / Drizzle 0.45.2 source shows Payload's adapter awaits the
Drizzle transaction callback, and Drizzle sends `BEGIN` before exposing its live
transaction object. The installed node-postgres client queues `client.query` calls;
its `query_timeout` rejects the caller but does not send PostgreSQL cancellation
for an active query. Therefore no strict server-side interruption is claimed.

PostgreSQL `SET TRANSACTION` documentation requires isolation and imported-snapshot
commands before the transaction's first query or data-modification command. The
setup order is therefore:

1. adapter-owned `BEGIN`;
2. `SET LOCAL statement_timeout` and `SET LOCAL lock_timeout` with finite remaining
   budget values;
3. `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
4. for imported read batches, `SET TRANSACTION SNAPSHOT '<exported-id>'`;
5. only then export the holder snapshot or issue data reads.

The two `SET LOCAL` utility commands precede any query/DML and do not take a
transaction snapshot; an offline command-order test protects this prerequisite.
The 4 s CMS value is a cooperative admission/remaining-budget deadline, not a hard
cap on connection/transaction/snapshot lifetime. It prevents later guarded data
operations after expiry is observed and supplies decreasing PostgreSQL timeouts
after setup, but it cannot cancel in-flight pool acquisition, `BEGIN`, initial
`SET LOCAL`, snapshot import, or timeout-refresh SQL. Such work may retain its
connection and (after export/import) snapshot until driver/server settlement;
cleanup/rollback then follows. The API caller separately has a response/header
abort, which does not establish server-side cancellation. Projection scans hold no
global reference lock during this wait. Live PostgreSQL acceptance remains
outstanding and must measure settlement/rollback behavior and determine appropriate
infrastructure/database safeguards from evidence, without assuming configuration
values in advance.

## Lock ownership

- **No `CMS_REFERENCE_LOCK`:** published catalog/list DTOs, slug detail DTOs,
  availability, categories, and editorial preview JSON. These read and validate
  projection state only, with snapshot consistency; they do not open bytes or
  mutate references. The editor preview's exact saved-Version timestamp is read in
  the same imported transaction as its DTO.
- **Retain `CMS_REFERENCE_LOCK`:** exact published/preview asset authorization and
  file open in the asset endpoint, and the existing publication/media/reference
  mutation transactions. The asset route completes its locked transaction before
  response-body handoff. The lock helper installs its finite lock wait timeout
  before requesting the advisory lock; no budget-refresh/setup SQL is performed
  under that lock by these non-budgeted asset calls.

## Failure and cleanup behavior

Deadline or abort before a transaction ID is available produces sanitized 503 to
the caller; when a late ID arrives, its transaction is scheduled for one rollback
without starting reader work, once the adapter supplies the ID. After a successful
begin, all setup and data stages check the cooperative caller budget. Imported
readers start no later data operation after budget failure is observed, restore
prepared-query instrumentation, drain pending operations, and attempt transaction
cleanup after in-flight calls settle. A call that never settles may retain a
connection/snapshot; no hard release time is promised. No partial counts or DTOs
escape.

## Verification boundary

Fake-driver tests cover no advisory locks on projections, lock retention on asset
and mutation paths, both late-begin deadline and abort cleanup, no post-deadline
queries, and the legal timeout/isolation/snapshot/data command order. Existing
eligibility, snapshot stability, cursor precision, API, and asset tests remain in
scope. CMS unit tests, typecheck, focused API tests, security checks, and diff
checks are run; the root `npm run verify` is not rerun. The guarded real PostgreSQL
`pg_sleep` scenario remains `NOT_EXECUTED`; neither adapter source inspection nor
fake-driver tests establish runtime cancellation or live snapshot behavior.

# Owner News Protocol V2 Bootstrap Implementation Plan

> **For agentic workers:** Follow the primary-approved single-implementer Sol Advisor Hybrid workflow; do not delegate implementation tasks. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an atomic, controller-only database bootstrap RPC and advance the installed Owner News protocol from V1 to V2 without changing Payload's six applied migrations, activating coverage, or adding a Portal/Payload caller.

**Architecture:** Identify protocol versions from the exact catalog inventory of canonical function signatures and their ACL/ownership contracts, not from `coverage_version` and not from a new version column or table. V2 is exactly the current V1 inventory plus `public.owner_news_bootstrap_run(uuid,text,text,text,integer)`; the existing admin finalizer installs that function on cold start and upgrades an exact V1 install transactionally. The RPC creates a run only when invoked by the controller, serializes on lock `7194030`, and relies on the existing run trigger to create the one mutation event.

**Tech Stack:** PostgreSQL 16, Payload native PostgreSQL migrations (read-only input to this slice), TypeScript/Node 24 CMS scripts, Node `node:test` unit tests, and the existing one-shot lease-gated PostgreSQL 16 integration harness.

## Global Constraints

- Do not change the six applied Payload migrations or their generated native schema snapshot.
- Do not preseed `news_migration_runs` on cold start or add a direct application/runtime or finalizer `INSERT` into that table; the controller-only SECURITY DEFINER RPC is the sole authorized insert path in this slice.
- V1 is exactly the four current canonical protocol functions; V2 is exactly those four plus `public.owner_news_bootstrap_run(uuid,text,text,text,integer)`. Reject partial, overloaded, extra, or mixed inventories rather than repairing them.
- Do not overload `coverage_version`, add a protocol-version column/table, or use coverage as a protocol-version signal. Preserve coverage and all current `ready=false`/admission-disabled behavior.
- The RPC must be `RETURNS TABLE(id uuid)`, owned by `cms_control`, `SECURITY DEFINER`, and pinned to `search_path = pg_catalog, public`; grant `EXECUTE` only to `cms_controller` among caller roles. Do not grant table `INSERT` to `cms_controller` or `cms_runtime`.
- Take transaction advisory lock `7194030` before any row lock, and lock/read the head before touching a run row. Both new creation and retries require exactly one valid head with `write_barrier='open'`.
- An exact retry means equality of the run UUID, manifest SHA-256, source instance, source fingerprint, and authority epoch. Return that row's ID with zero DML; any UUID or manifest collision with a different immutable identity is a conflict.
- New runs have fixed initial values `progress_state='preparing'`, `admission_state='open'`, `commit_outcome='acknowledged'`, and `unresolved_exceptions='[]'::jsonb`; leave nullable reconciliation/seal/activation fields unset and preserve the native defaults for timestamps.
- The existing `owner_news_mutation_capture_row` trigger is the only event writer for the RPC's run insert. Do not manually append an event or advance the head.
- Do not implement the future Portal/Payload caller helper. Preserve `source_instance` as the bundle's source identity. Independently bind the controller connection to the verified target PostgreSQL system identifier and database OID; never substitute the target identity for the source identity. Commit the controller RPC before Payload acquires lock `7194030`; then use a separate Payload transaction with fresh Portal authority evidence.
- Require `session_user = 'cms_controller'` inside the RPC, before locking or writing. Function ownership and effective-role membership alone do not authorize invocation.
- Updating an installed V1 requires an explicit upgrade operation. Ordinary finalizer invocation must not silently upgrade V1; reject with a stable upgrade-required diagnostic without DDL. The upgrade operation must verify exact V1 before making changes, and verify exact V2 on an idempotent retry.
- Do not run Docker, start services, or access a real/remote database in the implementation of this plan unless the primary session separately authorizes a fresh PostgreSQL 16 acceptance run. Never reuse the observer fixture or any prior lease.
- Preserve `api/`, `cron/`, `public/`, `nginx/`, and deployment boundaries. Update the Owner News operational docs and run `npm run verify` for the eventual implementation.

---

## Starting State and Protocol Contract

Repository evidence at plan creation: HEAD is `2abd324`, the worktree is clean, and the target plan file does not yet exist. The current finalizer recognizes the four V1 function signatures below and treats partial installs as manual-recovery cases. `coverage_version` is a separate 0/1 coverage field. `owner_news_mutation_guard_stmt` and all relevant content/job writers serialize on `7194030`; inserting into `news_migration_runs` invokes the existing row-capture trigger.

### Exact version inventory

V1 consists of exactly:

```text
public.owner_news_mutation_guard_stmt()
public.owner_news_mutation_capture_row()
public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)
public.owner_news_migration_item_binding_guard()
```

V2 consists of exactly the four V1 signatures plus:

```text
public.owner_news_bootstrap_run(uuid,text,text,text,integer)
```

Catalog classification must establish signature/OID identity, function count, owner, `SECURITY DEFINER` mode, pinned search path, canonical source body, and role-specific effective ACLs. A same-name overload, unexpected protocol function, partial V1/V2 mixture, or mismatch is not V1 or V2. Version must be derived from this catalog contract; the observer may independently report `coverage_version` as observed data but must not use it to infer protocol version.

### RPC input and state contract

Use the argument meaning/order `run_id uuid, manifest_sha256 text, source_instance text, source_fingerprint text, authority_epoch integer`. Validate lowercase 64-character hashes, non-empty bounded `source_instance` (1–128 characters), and an epoch in the native accepted range (integer, at least 1 and less than 2147483647). The UUID is the caller-selected stable run ID. Return one row containing that UUID as `id`.

After taking the advisory lock, lock and validate the singleton head row. Require an open barrier even for retries. Then inspect both immutable unique identities: the requested UUID and the requested manifest. If neither exists, insert exactly one run with the fixed initial state above. If both resolve to the same row and every immutable input matches, return the existing UUID without any `INSERT`, `UPDATE`, timestamp touch, or other DML. If either identity resolves to another row, or any immutable value differs, raise a stable conflict and perform no DML. The native unique manifest index remains a last-line integrity constraint, not a substitute for the explicit collision checks.

For a newly inserted run, the trigger produces exactly one `news_migration_runs` event and advances the head once in that same transaction. The RPC must not synthesize an event. A barrier change between creation and retry means retry is rejected; do not let idempotency bypass the barrier.

### Planned file map

- Create `cms/src/publication/bootstrap-run.ts`: canonical SQL builder for the controller-only bootstrap RPC; it is SQL contract code and does not expose a Payload/runtime insert helper.
- Modify `cms/scripts/finalize-news-protocol.ts`: exact V1/V2 catalog classification, atomic cold install and V1-to-V2 upgrade, version-aware verification, and version reporting for read-only audit.
- Modify `cms/scripts/provision-db.ts`: exact signature/role ACL verification for the new function while preserving the current no-table-insert contracts.
- Modify `cms/scripts/news-protocol-observer-contract.ts`: V2 function identity/execute restrictions while continuing to accept the exact V1 inventory.
- Modify `cms/tests/unit/news-protocol-finalizer.test.ts`: offline SQL, inventory, finalizer, ACL, and observer regressions.
- Modify `cms/tests/integration/protocol-finalizer.mjs`: fresh-fixture acceptance for V2 cold install and V1 upgrade, plus RPC event/retry/barrier/role/lock behavior; remove its cold-start synthetic run insert.
- Modify `docs/operations/owner-news-payload-migration.md` and `docs/operations/payload-owner-news.md`: V1/V2, bootstrap, safe invocation boundaries, and evidence limitations.
- Do not modify `cms/src/migrations/20261002_181423_owner_news_initial.ts`, `cms/src/migrations/20261005_133515_owner_news_media.ts`, `cms/src/migrations/20261005_151541_owner_news_publication.ts`, `cms/src/migrations/20261005_220916_owner_news_legacy_history.ts`, `cms/src/migrations/20261006_181325_a_owner_news_suspend_enum.ts`, `cms/src/migrations/20261006_181424_z_owner_news_native.ts`, or `cms/src/migrations/20261006_181424_z_owner_news_native.json`.

## Implementation Tasks

### Task 1: Define the bootstrap RPC SQL contract

**Files:** Create `cms/src/publication/bootstrap-run.ts`; test in `cms/tests/unit/news-protocol-finalizer.test.ts`.

**Produces:** `buildNewsMigrationBootstrapRunDDL(): string`, containing the single canonical declaration for `public.owner_news_bootstrap_run(uuid,text,text,text,integer)`.

- [x] Add the canonical function declaration with typed input parameters and `RETURNS TABLE(id uuid)`, `LANGUAGE plpgsql`, `SECURITY DEFINER`, and `SET search_path = pg_catalog, public`.
- [x] Reject any session identity other than `cms_controller` before acquiring locks. Grant `cms_control` INSERT only on the run columns explicitly named by the RPC; retain the SELECT needed for collision checks and RETURNING. Update exact ACL verification to reject other INSERT grants.
- [x] In the body, acquire `pg_catalog.pg_advisory_xact_lock(7194030)` first; lock the singleton mutation head with `FOR UPDATE`; require one row and `write_barrier='open'` before looking up or inserting a run.
- [x] Validate all text/hash/epoch inputs against the native constraints before any write. For existing state, query by both `id` and `manifest_sha256` and compare all five immutable values exactly. Return the existing ID on exact retry without DML. Reject crossed UUID/manifest matches and any identity drift without rewriting the existing row.
- [x] On a genuinely new identity, insert only into `public.news_migration_runs`, explicitly set `id`, immutable identity fields, the four fixed initial state fields, and `unresolved_exceptions='[]'::jsonb`; do not insert into the ledger event/head tables. Return the inserted UUID.
- [x] Revoke function execution from `PUBLIC` and `cms_runtime`, grant it to `cms_controller`, and transfer ownership to `cms_control`. Preserve the existing least-privilege table contract: controller gets no table INSERT/UPDATE/DELETE and runtime gets no RPC execution.
- [x] Add offline assertions that the generated SQL declares the exact signature/return type/security/search path and that SQL statement ordering places advisory lock before head/run row locks and any INSERT. Assert there is exactly one run-table INSERT and no head/event INSERT or UPDATE in the RPC body.
- [x] Add boundary assertions for each immutable input and both collision directions, and state assertions for the fixed new-row defaults. Unit tests are text/contract tests only; the PostgreSQL trigger/event behavior is tested in Task 4.
- [x] Run `npm --prefix cms run test:unit`; expected result: all CMS unit tests pass, including the new SQL-contract cases.

### Task 2: Make finalization install V2 and upgrade exact V1 atomically

**Files:** Modify `cms/scripts/finalize-news-protocol.ts` and `cms/scripts/provision-db.ts`; tests in `cms/tests/unit/news-protocol-finalizer.test.ts`.

**Consumes:** `buildNewsMigrationBootstrapRunDDL()` from Task 1.

**Produces:** Internal installed states `empty | v1 | v2 | partial`; successful first installation and V1 upgrade both finish at V2, while an already-V2 finalizer call verifies without DDL.

- [x] Replace function-name-only inventory classification with an exact catalog inventory that rejects overloads, unexpected signatures, extra functions/triggers, and partial/mixed states. Keep the trigger inventory and six-migration/native-schema checks exact and unchanged.
- [x] Treat an empty protocol as the cold-install state. In the existing `BEGIN` transaction under lock `7194030`, install the ledger, current trigger/binding definitions and grants, then install the V2 bootstrap RPC and verify the exact V2 contract before `COMMIT`.
- [x] Treat an exact installed V1 as a valid upgrade source only after deep V1 verification and explicit selection of the upgrade operation. Ordinary finalization must return an upgrade-required diagnostic without DDL. Under the same upgrade transaction and advisory lock, create only the V2 function and its narrow ACL/ownership and column INSERT grants; do not recreate the ledger, replace V1 functions/triggers, seed runs, or change head/coverage. Verify V2 before commit so any failure rolls back the added function and grants with the original V1 unchanged.
- [x] Treat exact V2 as idempotent verification only. Any partial, mixed, overload, owner/body/search-path/ACL mismatch remains a fixed manual-recovery error and must not trigger automatic repair.
- [x] Keep `coverage_version=0` required by the mutating finalizer, keep the returned `coverageVersion: 0`/`ready: false` contract, and prove there is no write to the head or run table in finalizer code.
- [x] Extend canonical function-body, approved-signature, `SECURITY DEFINER`, owner, `proconfig`, runtime, controller, observer, `PUBLIC`, and all-public-function checks to include the RPC only in V2. Assert controller has function `EXECUTE`, runtime and observer do not, `PUBLIC` does not, and neither controller nor runtime gains table INSERT. The `cms_control` function owner is the only non-caller execution authority in addition to the explicit controller grant.
- [x] Add unit cases for: empty-to-V2 install; exact V1-to-V2 DDL-only upgrade; exact V2 no-DDL verification; V1/V2 classification independent of coverage; duplicate overload/extra/mixed function inventories; wrong RPC owner/body/search path/return identity; wrong controller/runtime/PUBLIC ACL; and injected upgrade failure causing `ROLLBACK` without a `COMMIT` or native DDL changes.
- [ ] Confirm against fresh PostgreSQL fixtures that existing coverage, barrier, head and event rows remain byte-for-byte unchanged by the finalizer paths; this database-backed evidence remains in separately authorized Task 4.
- [x] Run `npm --prefix cms run test:unit` and `npm run typecheck:cms`; both must pass.

### Task 3: Keep the read-only observer compatible with both exact versions

**Files:** Modify `cms/scripts/finalize-news-protocol.ts` and `cms/scripts/news-protocol-observer-contract.ts`; tests in `cms/tests/unit/news-protocol-finalizer.test.ts`.

**Produces:** The observer accepts catalog-verified V1 and V2, reports `observedProtocolVersion: 1 | 2`, and independently reports observed coverage without certifying it.

- [x] Make the shared installed-state verifier take the expected exact version explicitly. The observer may verify either V1 or V2; the finalizer upgrade path explicitly verifies V1 before adding the new RPC and V2 afterward.
- [x] For V1 observer verification, require precisely the four V1 functions and reject presence of any bootstrap overload. For V2, require precisely the five V2 functions and exact bootstrap ACL/ownership. Keep the current read-only repeatable-read transaction, identity checks, `pg_shdepend` checks, application-table allowlist, and timeout unchanged.
- [x] Add the RPC to observer definer-function deny checks and protocol ACL inventory only as an optional V2 member; the observer must never need or receive `EXECUTE` on it. Keep `cms_observer` reads limited to the current approved tables/catalogs and do not broaden its grants.
- [x] Add `observedProtocolVersion: 1 | 2` to the observer report. Preserve `observedCoverageVersion: 0 | 1` as a separate field and keep `ready`, admission, release, coverage-certification and drain fields false for both versions.
- [x] Extend the fake read-only client to represent exact V1, exact V2, overload, and mixed states. Test successful V1 and V2 reports; prove `coverage_version` changes do not change protocol classification; prove a missing/extra/overloaded RPC or unexpected observer execute ACL rolls back the read-only snapshot. Assert no DDL, DML, advisory lock, `SET ROLE`, or fallback to an admin identity is introduced.
- [x] Run `npm --prefix cms run test:unit`; expected result: both version paths pass and unsafe catalog states fail closed.

### Task 4: Extend the lease-gated PostgreSQL 16 acceptance harness

**Files:** Modify `cms/tests/integration/protocol-finalizer.mjs`; do not add this runner to `npm test`, `npm run verify`, or automated CI execution.

**Authorization gate:** Execution requires separate primary-session authorization and two new, independent one-shot leases/fixtures: one fresh fixture for cold install and one fresh fixture for V1 upgrade. Never use the observer fixture, an old lease, an existing target DB, a cached report as acceptance evidence, or an existing service. The implementation worker does not execute these commands without that authorization.

- [ ] Remove `insertCommittedNativeFixture()` and its call before finalization. The native migration ledger should be the only setup state: no cold-start run row is inserted by the harness. Adjust rollback checks to compare the run table's schema/data snapshot even when its starting row count is zero.
- [ ] Keep each acceptance attempt lease-gated and one-shot. Continue requiring a cached PostgreSQL 16 image, new UUID names/volume/container, loopback-only port publication, separate random secrets, physical system-identifier verification before application DDL, private evidence, and preserved fixtures on success or failure.
- [ ] Cold-install fixture: apply only the six existing migrations, provision/verify control roles, prove `news_migration_runs` is empty before finalization, run the finalizer, and verify exact V2 plus a pristine head (`coverage_version=0`, barrier open, sequence zero, zero events). Re-enter finalizer and prove no DDL-visible or ledger/head/event change.
- [ ] V1-upgrade fixture: apply only the six existing migrations and bootstrap roles, install the exact canonical V1 ledger/functions/triggers/grants in the disposable fixture without the RPC, verify the four-signature V1 catalog, capture native schema/data and migration-ledger snapshots, execute finalizer, then prove exact V2 and an otherwise unchanged V1 protocol/head/native snapshot. Re-entry must be verification-only.
- [ ] Using a real `cms_controller` connection on the V2 fixture, call the RPC with a fresh UUID/manifest/source identity/epoch. Assert exactly one row is returned, exactly one run row is created with fixed initial states, exactly one trigger-generated `news_migration_runs` event is recorded, and head sequence advances exactly once. Assert no manual duplicate event or direct head write occurs.
- [ ] Repeat the exact same input and assert the same ID is returned with no run-row change, no event, and no head sequence/hash change. Test a closed barrier using an exact retry and assert rejection with zero DML; restore the fixture only by rolling back the test transaction or use an isolated fresh fixture state, never by weakening the barrier check.
- [ ] Test requested UUID reused with a different manifest/immutable values and requested manifest reused with a different UUID. Both must conflict without row/event/head changes. Verify `cms_runtime`, `cms_observer`, and an unrelated ordinary role are denied RPC execution; verify `cms_controller` cannot directly INSERT into `news_migration_runs` and cannot write ledger tables.
- [ ] Verify lock ordering with three test connections: hold advisory lock `7194030` inside a transaction on A, start the RPC on B, wait until `pg_stat_activity` shows B waiting on a lock, then have C acquire the head row with `FOR UPDATE NOWAIT`. C must succeed before A releases the advisory lock; then release A and confirm B completes. This proves B did not take the head/run row lock first.
- [ ] Preserve the existing atomic-install rollback check and add V1-upgrade rollback evidence in the V1 fixture: create a disposable `ddl_command_end` event trigger that recognizes the exact bootstrap function's `ALTER FUNCTION ... OWNER` command after its CREATE/REVOKE/GRANT statements, advances a non-transactional sequence marker, and raises a fixed exception. Run the finalizer expecting failure; prove the marker advanced while the bootstrap function/ACL changes rolled back, the exact V1 catalog remains, and native schema/data plus applied migration history are unchanged. Drop this fixture-only event trigger, then run the successful V1 upgrade. Do not add production SQL failpoints.
- [ ] Sanitize reports to fixed stage/reason codes, booleans, counts, and hashes; never persist connection strings, passwords, raw SQL errors, source content or article data. Preserve fixture/container/volume and report without automatic cleanup.
- [ ] Only when explicitly authorized, use the harness's actual prepare/execute interface for **two new independent leases** (one per fixture):

  ```sh
  node cms/tests/integration/protocol-finalizer.mjs --prepare-lease
  node cms/tests/integration/protocol-finalizer.mjs --execute --lease "<new cold-install lease path>"
  node cms/tests/integration/protocol-finalizer.mjs --prepare-lease
  node cms/tests/integration/protocol-finalizer.mjs --execute --lease "<new V1-upgrade lease path>"
  ```

  Expected result is fresh PostgreSQL 16 acceptance evidence for cold install and V1 upgrade. A lease prepare is not acceptance, and a previous observer audit PASS is not evidence for this work.

### Task 5: Update the operational contract and run offline verification

**Files:** Modify `docs/operations/owner-news-payload-migration.md` and `docs/operations/payload-owner-news.md`.

- [x] Document the exact V1 and V2 function inventories, catalog-derived version distinction, finalizer cold-install/upgrade/idempotent behavior, and manual-recovery behavior for partial/mixed states.
- [x] Document RPC arguments, return type, allowed controller-only invocation, validation/collision semantics, fixed initial run states, exact retry behavior, open-barrier retry requirement, trigger-generated single event, and the fact that it does not certify readiness, source reconciliation, coverage, drain or cutover.
- [x] State explicitly that no run is preseeded; the finalizer does not insert a run; the RPC call alone creates one. Keep the six native migration names/schema unchanged and describe the Portal/Payload caller only as a future dependency with physical identity binding, controller commit before Payload transaction/lock, and fresh Portal authority evidence.
- [x] Update the observer section to describe `observedProtocolVersion` separately from `observedCoverageVersion`; preserve observer read-only limits and note protocol V2 does not imply activation or readiness.
- [x] Record the fresh-PG16 lease procedure and separate authorization boundary. State that cold-install and V1-upgrade acceptance require new fixtures/leases and must not reuse the observer fixture, prior leases, remote databases, or service environments.
- [x] Review the complete diff for protected migration files, absence of Portal/Payload caller implementation, no controller/runtime table INSERT grants, no finalizer/runtime run preseed, and no secret-bearing integration report fields.
- [ ] Run from repository root:

```sh
npm --prefix cms run test:unit
npm run typecheck:cms
npm run verify
git diff --check
```

Expected result: all four commands exit 0. `npm run verify` is the repeatable offline check and must not be replaced with Docker/DB integration. Report the separately authorized PostgreSQL 16 acceptance as pending unless both new fixtures actually execute after explicit authorization.

## Completion Criteria

- Empty finalizer state installs exact V2; exact V1 upgrades to exact V2 atomically; exact V2 is a no-DML verification; unexpected state fails closed.
- The new RPC is the sole new run-creation path in this slice, returns `TABLE(id uuid)`, enforces exact immutable identity and open-barrier retry, and grants no table INSERT to caller/runtime roles.
- The actual RPC creates one run and exactly one trigger-generated event; an exact retry has zero DML; UUID/manifest collisions and unauthorized roles fail without data changes.
- The observer can report exact V1 or V2 and independently observe coverage while continuing to certify nothing.
- All six applied Payload migrations and native snapshot files remain unchanged; the Portal/Payload helper remains unimplemented.
- Offline unit, typecheck, repository verification and diff-whitespace checks pass. Any PostgreSQL 16 evidence is a distinct, separately authorized run against new one-shot fixtures.

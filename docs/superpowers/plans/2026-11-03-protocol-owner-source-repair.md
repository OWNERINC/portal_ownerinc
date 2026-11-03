# Protocol owner-scoped source repair Implementation Plan

## Steps
- [x] Extract explicit owner-scoped SQL fragments while preserving canonical and historical aggregate bytes.
- [x] Repair cold installation, V1 upgrade, authorized head reads and fail-closed migrator grants replay.
- [x] Update finite diagnostics and run owner-aware regression, type and compatibility checks.
- [ ] Complete fresh source review and primary acceptance of an exact isolated source package.

> **For agentic workers:** use the existing Sol Advisor implementation lane, one bounded implementer followed by a fresh read-only reviewer. Primary owns verification, extraction, index, commits and CI. The user already selected delegated Astra xhigh execution and delegated technical decisions; no additional execution-choice interview is needed.

**Goal:** remove the observed `ownership-transfer / 42501` failure using the existing role contract and preserve coverage 0, canonical function bodies, trigger definitions and final privileges.

**Architecture:** migrator creates data objects and triggers; control creates functions directly under its final ownership. Admin orchestrates existing SET-only memberships in one transaction. Pure-migrator grants replay normalizes only migrator-owned objects and verifies the applicability and exact function ACL contract through public catalogs.

**Tech Stack:** TypeScript, existing `pg` client, PostgreSQL 16, Node 24 CMS tooling; no new dependencies.

## Global Constraints

- Source implementation and disposable CI are authorized by the ongoing task and the completed independent analysis plus one cross-critique round. This plan grants no production execution or incident-recovery authority.
- Native PostgreSQL, Docker/container and application qualification run exclusively in CI. No Docker Desktop or local stack.
- Published diagnostic base: `1310efcf9efbc47ce7a159c89e336f89a5122b0f`. CI run `41559359225` identifies the ownership-transfer batch, not an individual ALTER or the browser failure.
- Preserve existing SET-only memberships, role attributes, schema CREATE privileges, API/cron Node 18 compatibility, publication manual and worker hold.
- No new memberships, INHERIT, superuser, admin head grants, persistent migrator function EXECUTE, control table-TRIGGER grants or default-ACL changes.
- Keep advisory lock `7194030`, one transaction and the existing preconditions. No application DML or intermediate COMMIT during installation.
- Preserve canonical function-body bytes, signatures, SECURITY DEFINER properties, search paths, exact 80 trigger definitions, final schema/ACL/fingerprints, historical fixtures and historical diagnostic acceptance.
- Cold install returns coverage 0 and ready false. Canonical V2 reentry is verification-only; partial/wrong-owner/drifted states refuse.
- V1 upgrade adds only bootstrap and its exact nine INSERT-column rights; old function/trigger OIDs and definitions and ledger/data remain unchanged.
- No SQL splitting or expanded regex surgery. Extract literal fragments at source boundaries and retain aggregate exports for compatibility/comparison.
- Keep unrelated lifecycle/catalog/CAS/runner/B0/browser work intact. Never `git add -A`; workers do not modify any index or commit.
- Required primary gate: `npm run verify` against the exact extracted package, followed by separate PG16 CI qualification. Offline PASS is not native qualification.

## Accepted technical policy

Cold install creates the functions as control and promptly revokes PUBLIC EXECUTE. Only the following three newly created trigger functions receive temporary non-grantable EXECUTE for migrator, in the same transaction:

```sql
GRANT EXECUTE ON FUNCTION
  public.owner_news_mutation_guard_stmt(),
  public.owner_news_mutation_capture_row(),
  public.owner_news_migration_item_binding_guard()
TO cms_migrator;
```

After migrator installs and enables the triggers, control removes that authority before final verification and COMMIT:

```sql
REVOKE EXECUTE ON FUNCTION
  public.owner_news_mutation_guard_stmt(),
  public.owner_news_mutation_capture_row(),
  public.owner_news_migration_item_binding_guard()
FROM cms_migrator;
```

There is no grant on seal/bootstrap, no temporary grant on V1 upgrade/reentry and no PUBLIC fallback. A failed query rolls the temporary ACLs and installation back together. Final exact ACL verification rejects any residual migrator EXECUTE or unexpected grantee/grant option. This explicitly replaces the previously unapproved implicit-PUBLIC proposal.

## Files and responsibility

Published-base production core:

- `cms/scripts/finalize-news-protocol.ts`: owner sequence, bounded runtime head read, identity restoration, V1/reentry and truthful finite diagnostics; binding fragments remain local in this base.
- `cms/scripts/provision-db.ts`: fixed function descriptor contract, bounded grants-applicability verification, relation-only normalization, locked replay and rollback.
- `cms/src/publication/mutation-triggers.ts`: mutation/seal function creation, function ACL, relation grant and trigger fragments.
- `cms/src/publication/bootstrap-run.ts`: bootstrap function creation/ACL versus nine-column relation grant fragments.

Current integration has already moved binding DDL to `cms/src/database/runtime-catalog.ts`. Port only its binding-fragment adjustment when integrating. Do not publish that entire WIP extraction to obtain a constant. If sharing genuinely needs a separate file, one pure `cms/src/database/protocol-function-contract.ts` may contain the fixed descriptors/query/checker; it must not import operational scripts or create connections.

Matching regressions and consumers:

- `cms/tests/unit/news-protocol-finalizer.test.ts`
- `cms/tests/unit/payload-infrastructure.test.ts`
- Existing mutation/bootstrap/catalog unit tests that consume the affected builders.
- `scripts/integration/payload-manual-diagnostics.mjs` and its CMS unit test.
- Finite diagnostic parsers in `cms/tests/integration/protocol-finalizer.mjs` and `news-protocol-observer-audit.mjs` only if the operation vocabulary changes; this does not qualify their old Desktop execution paths.
- `docs/reviews/2026-11-02-finalizer-authority.md` and the matching operations runbook.

## Task 1 — explicit fragments and compatibility

**Interfaces:** preserve `buildNewsMutationTriggersDDL()`, `buildNewsMigrationBootstrapRunDDL()` and `NEWS_MIGRATION_ITEM_BINDING_DDL` aggregate bytes. Add these fixed fragment interfaces at the same source literal boundaries:

```ts
export type ProtocolOwnerFragments = Readonly<{
  functionCreate: string
  functionACL: string
  relationGrants: string
  triggers: string
}>
```

Mutation fragments contain mutation guard, capture and seal; binding fragments contain its one function and two triggers; bootstrap fragments contain bootstrap and its INSERT-column grant, with empty trigger SQL. Empty SQL fragments are never dispatched. Legacy aggregate composition can retain its original ownership-transfer statements for byte compatibility, but the repaired operational path never executes the aggregates or any ALTER FUNCTION OWNER statement.

1. Capture the aggregate outputs and canonical bodies from published base before refactoring. Record independent hashes in the regression evidence, not hashes calculated only from the newly refactored implementation.
2. Add regression assertions on the emitted SQL, for example:

```ts
assert.equal(actualAggregate, publishedAggregate)
assert.deepEqual(actualFunctionBodies, publishedFunctionBodies)
assert.deepEqual(actualTriggerDefinitions, publishedTriggerDefinitions)
assert.doesNotMatch(ownerFragments.functionCreate, /ALTER FUNCTION|GRANT|REVOKE/u)
assert.doesNotMatch(ownerFragments.triggers, /CREATE OR REPLACE FUNCTION|OWNER TO/u)
```

The compared variables are the observed builder outputs/body maps/trigger definitions loaded by the existing unit harness, with the published snapshots captured in step 1. Function bodies containing grant-like words in comments are compared as bytes rather than parsed with that fragment assertion.
3. Move literal sections without rewriting their canonical function bodies or trigger definitions. Schema/database grants stay in the existing provisioning path; owner fragments consume those preverified rights.
4. Run the affected builder/finalizer/infrastructure unit files, then inspect the source diff for changes to historical bodies and aggregate whitespace.

## Task 2 — owner sequence, head and replay

### Cold and upgrade sequence

Use the existing client and query calls, with explicit switches rather than a generic command executor:

```sql
SET LOCAL ROLE cms_migrator;
RESET ROLE;
SET LOCAL ROLE cms_control;
RESET ROLE;
SET LOCAL ROLE cms_migrator;
RESET ROLE;
SET LOCAL ROLE cms_control;
RESET ROLE;
```

Between these switches, respectively: create ledger and apply migrator-owned relation grants; create canonical functions and establish ACLs plus the three temporary grants; install/enable canonical triggers; revoke temporary EXECUTE and establish exact final function ACLs. Verify observer privileges and the installed contract before COMMIT. Preserve original failure through failed RESET/ROLLBACK and never commit after uncertain restoration.

V1 upgrade first verifies canonical V1, then creates only bootstrap under control and its exact INSERT columns under migrator:

```text
id, manifest_sha256, source_instance, source_fingerprint, authority_epoch,
progress_state, admission_state, commit_outcome, unresolved_exceptions
```

Move the non-observer head SELECT into the existing runtime verification scope. Verify `current_user=cms_runtime` and `current_database()=ownerinc_cms` before reading; restore and verify non-superuser admin on normal completion. Observer mode performs its direct authorized SELECT and no SET/RESET.

### Fixed function ACL applicability

The descriptor set is exactly:

| Signature | Versions | Controller EXECUTE | Temporary trigger target |
| --- | --- | --- | --- |
| `public.owner_news_mutation_guard_stmt()` | 1, 2 | no | yes |
| `public.owner_news_mutation_capture_row()` | 1, 2 | no | yes |
| `public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)` | 1, 2 | yes | no |
| `public.owner_news_migration_item_binding_guard()` | 1, 2 | no | yes |
| `public.owner_news_bootstrap_run(uuid,text,text,text,integer)` | 2 | yes | no |

The reader accepts only `absent`, `v1` or `v2`, otherwise throws a fixed bounded refusal. Inspect the entire public `owner_news_` function namespace, signatures, control ownership and ACLs via public catalogs. NULL ACL means PostgreSQL defaults, not an empty ACL. Owner EXECUTE is required and owner-inherent authority is distinguished from delegated grant options.

Absent requires both ledger relations, protocol functions and protocol-trigger residue absent. V1/V2-shaped states require both ledger relations and required native relations of the expected kind/owner, plus exactly four/five signatures. Unknown names/overloads, wrong owners/kinds, partial presence and unexpected grantees/grant options refuse. This is ACL applicability, not full body/80-trigger certification.

Inside the real pure-migrator `--grants` transaction:

```sql
SELECT pg_catalog.pg_advisory_xact_lock(7194030);
```

Classify after acquiring the lock, apply only relation/sequence/column/default-relation normalization and observer relation grants, then verify relation/observer privileges and exact function ACLs before commit. Confirm applicability state is unchanged. No SET ROLE, head-value/coverage/barrier/empty-data requirement, helper invocation, new connection, admin credential fallback or full-finalizer call. Bad control-owned ACLs cause rollback of relation changes; no hidden function repair.

## Task 3 — regression and diagnostic acceptance

Run meaningful role-aware model tests against the actual orchestration. Inject failures after each role switch, DDL fragment, temporary grant, trigger installation, revocation and verification. Require original failure, no COMMIT, rollback attempt and no later install step. Add cold/upgrade/reentry, runtime head-read restoration, observer no-SET and migrator replay cases with coverage-1/populated heads that must remain unread by the applicability verifier.

For each signature test owner, PUBLIC/runtime/observer/admin/migrator exposure, controller policy, unexpected grantee, grant option, NULL ACL, overload, missing/extra function and partial relation shapes. Test lock acquisition before classification and relation mutation. Test relation rollback on post-normalization function refusal. Do not replace existing negative cases with weaker assertions.

Finite diagnostics must identify actual work; the new path must not label creation as ownership-transfer. Any new operation literal is added to producer, formatter, manual extractor, native parsers and their tests together; keep historical ownership-transfer parsing. No driver messages, SQL, URLs, errors, getters, arbitrary prefixes or private properties are exported.

Run from `cms/` with the exact changed test filenames:

```powershell
node --import tsx --test tests/unit/news-protocol-finalizer.test.ts tests/unit/payload-infrastructure.test.ts tests/unit/manual-runtime-diagnostics.test.ts
```

Then run offline CMS typecheck through `npm run verify` in the primary's exact package, not a worker-modified test inventory. Source snippets in this plan are constraints/assertions, not evidence that the implementation already exists.

## Task 4 — review, extraction and downstream PG16 gate

The implementer reports changed files, baseline comparisons, hashes, focused counts and unresolved concerns. Fresh reviewer inspects the actual diff and returns ship/fix-first/rethink. Primary reproduces checks and constructs a selective package on the published base; any binding relocation is mapped explicitly, never copied wholesale from the WIP catalog subsystem. Only a full exact-package verify and accepted review permit commit/push.

The next native work package is a small Linux PG16 CI driver attached to disposable target ownership, not broad surgery on the Desktop harness. It must use official provisioning and actual role logins. Cluster physical attestation remains with CI bootstrap authority; admin is non-superuser and does not receive `pg_control_system()` access. Native acceptance must cover:

1. Unmodified CLI cold V2 and both V2 reentries, exact final owners/ACLs/triggers and coverage 0.
2. Legitimate frozen V1 constructed under migrator/control, ordinary finalize refusal, explicit upgrade with only bootstrap/nine-column delta and preserved old OIDs/data.
3. Real pure-migrator replay before protocol, on V1/V2 and populated coverage-1 restore, twice without data/sequence mutation.
4. ACL drift/partial/overload negatives and rollback of relation normalization; no function repair.
5. Real supplied-client fixed SQL-error injection after successful cold/upgrade DDL/ACL boundaries; fresh authorized snapshots prove rollback. No event triggers, production failpoint or ownership allowlist exceptions.
6. Actual authority denials, role restoration, observer no-SET, triggers operating after temporary EXECUTE is revoked and controller bootstrap/session-user restrictions.
7. Lock contention with finalizer, with classification against the committed state observed after lock acquisition.

Until that CI completes, mark native installation/replay/rollback qualification pending. Browser direct-admin baseline mutation and the manual CAS integration remain distinct consumer work; never repair them with admin head privileges. H1, activation, active/frozen recovery and production acceptance remain outside this source package.

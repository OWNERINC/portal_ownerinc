# Proposed CMS Lifecycle, Readiness and Protocol Qualification

## Steps

- [ ] Resolve the independent review's CORRECTED/fix-first findings and obtain review of the amended contracts; the primary accepts the amendments, not a completed-package PASS.
- [ ] Wait for B0 review/shipping and completion of the running stable 38-file snapshot verification; coordinate a stable integration baseline and file ownership with the current CMS editorial and pre-floor recovery workers.
- [ ] Implement and verify immutable lifecycle configuration, shared catalog readers, native health and strict readiness while preserving the approved editorial-profile constraints.
- [ ] Implement and verify authenticated protocol installation, coverage qualification and candidate evidence through the existing independently administered trust channel.
- [ ] Implement and verify the append-only post-floor state transition, interrupted-commit handling and bound CMS restart receipts.
- [ ] Resolve and independently qualify the native-floor B1 source-state recovery prerequisite before permitting protocol mutation.
- [ ] Complete offline checks and separately authorized disposable native qualification, including privilege, crash-boundary, restart and recovery cases; report every unexecuted or incomplete case accurately.
- [ ] Hand the reviewed package and exact evidence interfaces to the primary for later activation integration.

## Status, coordination and execution boundary

This document remains **PROPOSED**, amended after independent full-plan review returned CORRECTED/fix-first with three HIGH findings. The primary accepts the amendments below and separately authorizes only the bounded slice-1 extraction described here. This is not a completed-package PASS, native qualification evidence or production authorization. Every coarse step remains unchecked; no recovery prerequisite is represented as fulfilled. The repository copy is authoritative for review, and the external copy must remain byte-identical.

The current CMS editorial worker owns application configuration/readiness/Payload/admin and related files, and the current pre-floor recovery worker owns operational files. B0 review/shipping and the stable 38-file snapshot verification remain with the primary. The only presently authorized implementation is a nonoverlapping preparation slice: new `cms/src/database/catalog-verification.ts`, focused new CMS unit tests, and extraction/compatibility wrappers in `cms/scripts/finalize-news-protocol.ts`. Do not change other CMS files, ops, CI, Compose or documentation outside these two plan copies. Do not inspect or overwrite unfinished worker changes or duplicate their work. Broader integration waits for the coordinated stable baseline.

The design is limited to lifecycle, readiness and protocol qualification after native private installation. Later activation, editorial promotion and active-content recovery retain their separate contracts. The approved editorial-profile plan at `C:/Users/Criação/.opencode/plan/2026-11-02-manual-editorial-profile.md` remains authoritative.

The user has delegated technical decisions. The primary should resolve the technical critique without a broad user questionnaire. Existing administrative authorization machinery is reused for operational authority; this proposal does not create an additional human approval ritual.

The original design session performed read-only source inspection. The current authorization adds only the bounded extraction and focused offline tests above, after these plan amendments. No dependency installation, local Docker/services, GitHub/SSH/remote operations, delegation, commits, git add/reset or changes to the parent's index are authorized. Full verification belongs to the primary on the later stable tree. Reviewer shell permission was blocked; no native proof is inferred from that review. Production operations remain unexecuted.

For future implementation, repository guidance still applies: read `README.md`, `docs/product/brief.md` and relevant documentation; preserve service boundaries, Node compatibility rules and LF for Linux-related files; keep changes localized; do not hardcode credentials. Run `npm run verify` and `git diff --check` before sharing implementation changes. Service-affecting Docker execution requires separate authorization. The future command and test descriptions below are requirements, not execution records.

**Proposed decision:** use two immutable lifecycle profiles in the same qualified CMS image. Native private installation uses a new protocol-absent health endpoint. After `installed-private`, an authenticated operation installs protocol V2 at coverage **0**, then separately qualifies coverage **1** and recreates CMS under strict readiness.

CMS remains `held-v1`, publication remains `manual`, authority remains `legacy/1`, admission remains closed, and workers remain held throughout this package.

### Three implementation slices

1. **Native configuration/readers/endpoints:** immutable profiles, shared SELECT-only catalog readers/comparators, native and strict endpoints, health/storage/boot observations and runtime packaging. The current authorization covers only the nonoverlapping reader/comparator extraction, finalizer wrappers and focused new tests; do not wire an unusable default lifecycle.
2. **State and recovery contracts:** schema-3 ancestry, protocol/recovery intents, authenticated B1 companion baseline, supported recovery source states, immutable failed attempts and native-held recovered successors.
3. **Authenticated operational integration:** guarded coverage CAS, current-generation resolver and route integration, purpose-bound admission, and native candidate CI exercising the actual installation and recovery commands.

All three slices must be complete in the **same final qualified image/package before operational admission**. CI may exercise the actual install/recover command paths on disposable targets before production authorization; candidate qualification does not depend on first running production, and production authorization does not substitute for CI evidence. This avoids an admission/qualification cycle.

## 1. Lifecycle and health contracts

Add `CMS_LIFECYCLE_PROFILE`, resolved once when constructing the Payload configuration:

| Profile | Required database state | Docker health target |
|---|---|---|
| `native-private-v1` | Exact native catalog; protocol absent; tracked News tables empty | `/editorial/internal/native-ready` |
| `protocol-qualified-v1` | Compatible native catalog; installed protocol V2; observed coverage 1 | `/editorial/ready` |

Production requires an explicit value. Empty, padded or unknown values fail configuration. Build-only configuration explicitly selects `native-private-v1`.

The running instance never selects its lifecycle by discovering tables, reading a request parameter, or rereading environment variables during a request.

### Immutable descriptor

Add a closed lifecycle descriptor containing:

- `descriptorVersion:1`;
- `lifecycleId`;
- `healthPath`;
- `databaseContract`: `native-absent-v1` or `protocol-v2-covered-v1`;
- `publicationMode:'manual'`;
- the loaded editorial descriptor hash.

Hash it with the existing canonical JSON algorithm:

`SHA256("ownerinc.cms.lifecycle-profile.v1\n" + canonicalJSON(descriptor))`

Here `\n` denotes one actual newline in the hashed UTF-8 bytes. These fields describe **expected configuration**, not observed coverage or operational permission. Validate the descriptor against the loaded, sanitized Payload configuration before emitting its headers.

The editorial-profile plan remains authoritative:

- `native-private-v1` requires `held-v1`;
- this package also uses `held-v1` after qualification;
- eventual `editorial-v1` promotion retains its separate authenticated binding and same-image requirements.

### Native endpoint

Implement:

**`GET /editorial/internal/native-ready`**

Success body:

```json
{"status":"native-ready"}
```

It succeeds only under `native-private-v1` and verifies:

1. Loaded lifecycle/editorial configuration.
2. Actual adapter connection identity: both `session_user` and `current_user` are `cms_runtime`; database is `ownerinc_cms`.
3. Expected migration ledger.
4. Exact native catalog through the existing native-catalog comparison.
5. Absence of protocol relations, functions and triggers.
6. Zero rows in the existing `NEWS_MUTATION_TABLES` inventory.

Use one checked-out connection from the **actual Payload adapter pool**, following the connection pattern already present in `cms/src/migration/target-binding.ts`. Begin a server-enforced `REPEATABLE READ READ ONLY` transaction before its observations. Set bounded timeouts and a pinned search path; rollback and discard an uncertain connection.

This endpoint performs no DDL, DML, sequence advancement, storage probe or advisory-lock acquisition. It returns 503 for a present, partial or unexpected protocol. It never falls back to strict readiness.

### Strict endpoint

Keep **`GET /editorial/ready`** and its exact success JSON:

```json
{"status":"ready"}
```

Require `protocol-qualified-v1`. Strict readiness MUST invoke the full native-plus-V2 catalog comparator, the full canonical protocol comparator and the shared head parser, retaining the existing readiness meaning rather than relying on the old partial runtime checklist. Observe all database checks through one actual Payload adapter connection in one bounded server-enforced `REPEATABLE READ READ ONLY` snapshot. Require both `session_user` and `current_user` to equal `cms_runtime`, the expected database, pinned search path and bounded timeouts. The shared parser must validate the actual mutation head:

- `coverage_version = 1`;
- valid sequence/hash representation;
- internally consistent barrier fields.

The zero-head/open-barrier requirement belongs to **qualification**, not perpetual readiness: later legitimate migration operations will advance that head.

The current `assertCmsDatabaseReady()` does not read coverage and its partial catalog checks are insufficient for this contract. A missing bootstrap function, changed seal body, unexpected trigger or weakened native constraint must each make strict readiness fail. A configuration value or descriptor cannot substitute for observation. Privileged ownership-helper execution remains in ops; do not grant it to web/runtime or import a read-write operational wrapper into a health route.

**Storage distinction:** native health is genuinely read-only. Strict `/editorial/ready` retains the existing create/fsync/unlink storage probe and therefore is database-read-only, but not filesystem-read-only. Keeping that bounded probe preserves the existing storage-readiness meaning. Do not replace it with `stat()` or access checks and claim equivalent writability.

For native installation and native restarts, the host separately invokes the existing durable-storage probe as the CMS container's configured OS user and binds its successful observation to that container's current boot and mounts.

Successful strict readiness emits the editorial headers required by the approved plan. Both endpoints may emit validated lifecycle ID/hash headers; failure responses emit no success descriptors. All responses remain private/no-store.

## 2. Reuse the catalog implementation without weakening its wrappers

Extract the SELECT-only catalog readers/comparators from `cms/scripts/finalize-news-protocol.ts` into:

**`cms/src/database/catalog-verification.ts`**

Retain existing exports as compatibility wrappers where callers/tests already use them.

Provide these bounded interfaces:

| Interface | Responsibility |
|---|---|
| `verifyNativeCatalogAbsent(client, migrationNames)` | Existing exact protocol-absent native comparison and unchanged native fingerprint |
| `verifyNativeCatalogWithProtocolV2(client, migrationNames)` | Exact native projection plus an exact allowlist of canonical V2 additions |
| `verifyProtocolV2Catalog(client)` | Canonical protocol object/signature/body/trigger comparison |
| Read-only head reader and shared parser | Actual head values, with no certification decision |

For the post-install verifier, validate the **complete catalog against native objects plus canonical V2 additions before deriving the native projection**. Merely filtering out names beginning with `owner_news_` would hide unexpected objects.

Preserve:

- the existing native fingerprint algorithm;
- its exact serialization byte contract: normalize CHECK definitions into the existing constraint array and hash `JSON.stringify({ migrationNames, ...inventory, constraints })` with the existing ordering (original finalizer lines 1235–1237); no canonicalization substitution;
- exact constraint/index/type/default comparisons;
- lexical/parameterized default comparison, without executing catalog expressions;
- strict protocol-absence behavior of `verifyPreauthorityCatalogReadOnly()`;
- finalizer coverage-0 behavior;
- observer audit's observation-only contract.

In particular:

- Do not invoke the admin-only preauthority wrapper from `cms_runtime`.
- Do not grant the web process access to `cms_cluster_guard.verify_cms_ownership_contract()`, admin credentials or control roles.
- Keep privileged role/ownership verification in the operational command.
- Extract common installed-object checks from private `verifyInstalled()`, but keep separate role and coverage policies around them. An "allow coverage 1" option must not silently relax the finalizer.

## 3. Docker health and restart binding

Add **`cms/scripts/check-cms-health.ts`** and use it as the fixed Docker healthcheck command in `docker-compose.payload.yml`.

It:

1. Parses the container's immutable lifecycle selection.
2. Chooses only the corresponding hardcoded loopback URL.
3. Rejects redirects, unexpected bodies and descriptor mismatches.
4. Fails within the Docker healthcheck deadline.

It does not choose whichever endpoint happens to succeed. The response descriptors are compared with the configured selection; actual database checks remain inside the server.

### Native installation

The B0 integration hook is narrow: `_private_cms_readiness()` must verify that the receipted container carries the native lifecycle, the approved healthcheck and the held editorial profile before accepting Docker's healthy status.

Its catalog/floor checks still require protocol absence. Their meaning does not change.

### Protocol transition

After native installation:

1. Verify the original container receipt.
2. Stop CMS and confirm quiescence.
3. Install and qualify the protocol while CMS remains stopped.
4. Durably record coverage qualification.
5. Recreate **only CMS**, using the same approved image and `protocol-qualified-v1`.
6. Verify strict readiness and record a new runtime-generation receipt.

Use explicit no-dependency recreation. This transition must not implicitly rerun provisioning or migrations.

The receipt binds actual observations of:

- previous and new container IDs;
- image digest;
- release and rendered configuration digests;
- lifecycle/editorial descriptor hashes;
- `Config.Healthcheck`;
- command, configured user, network attachments and absence of published CMS ports;
- mount identities and physical target binding;
- container `StartedAt` and restart count;
- durable-storage and health observations.

Original B0 container-creation receipts remain historical facts. Store replacement receipts separately rather than rewriting them.

A restart invalidates the previous boot observation even if the container ID is unchanged. Before another operational command relies on readiness, it must reobserve the current boot, configuration, targets and health and append a fresh receipt.

Docker health remains a service-health signal. `nginx.depends_on.cms` does not authorize route publication.

### Authenticated current-generation resolution

`ops/payload-route-promotion.py` currently follows `installIntent.creation.containers.cms`, which identifies the historical native container. Schema 3 requires an authenticated current-generation resolver instead. Preserve that original receipt and validate the signed replacement ancestry from it to the current generation. Require completed `qualified_private` protocol state, the exact replacement container/image/target/configuration, current boot (`StartedAt` and restart count), and valid strict-health observations. Reject the original container, a stale boot, a native lifecycle generation, incomplete restart or an unbound replacement; do not fall back to the original ID.

The route controller retains its own authorization and all existing gate checks. Its strict `/editorial/ready` probe and exact success JSON remain unchanged; current-generation resolution supplies the correct authenticated target, not route permission.

## 4. Authenticated installation and qualification interfaces

Extend the existing protected launcher with:

```text
--check-protocol-plan <record-id>
--install-protocol <record-id>
--qualify-protocol <record-id>
--reconcile-protocol <record-id>
--recover-protocol <record-id>
```

`record-id` resolves only within the existing protected registry. It is not an arbitrary request-file path.

The launcher delegates to phase-specific runtime methods under the existing operational lease. Preserve the operational FD9 lease discipline; do not confuse it with Gate E's signing-key descriptor.

### Admission channel

Reuse:

- `ops/provision-payload-candidate-trust.py`;
- `scripts/register-payload-candidate-admission.mjs`;
- `ops/payload-candidate-verifier.py`;
- the protected candidate registry and installed-tool/source-closure verification;
- the existing host HMAC journal for operational receipts.

Add a separately versioned candidate contract:

**`payload-protocol-qualification-v1`**

Keep `payload-preauthority-recovery-v1` and `payload-private-install-v2` unchanged. Their existing successful reports do not imply this new qualification.

Use a separate protected approval document, administered through the same provisioning channel:

**`/etc/ownerinc/payload-preparation/production-protocol-approval.json`**

Preserve the original installation approval and record bytes.

### Why a separate protocol authorization document

Native installation authorization is deliberately bound to protocol absence and ends at the native floor. Installing the protocol and setting coverage to 1 are different permitted effects, with different live preconditions, qualification evidence and recovery prerequisites. Treating the old installation authorization as permission for those effects would silently broaden its meaning.

The additional document is therefore a **purpose-scoped authorization record within the existing independently administered channel**, not a new signer, authority hierarchy, user-facing approval ceremony or repeated broad consent request. One bounded protocol approval may cover the explicitly listed install, qualification and held-runtime restart stages through their signed state ancestry. The primary should critique whether the separate-document storage shape is the smallest compatible implementation, while preserving explicit purpose/effect binding, independent administration and immutable historical installation evidence. No stage may rely on caller JSON or a self-issued candidate assertion instead.

The protocol approval binds:

| Binding | Required content |
|---|---|
| Purpose | `cms-protocol-qualification` |
| Operation | Explicit installation, coverage qualification and held-runtime restart permissions |
| Freshness | Request ID, nonce and absolute deadline to start, maximum 60 minutes |
| Origin | Exact signed installed-private state and installation-binding hashes |
| Candidate | Commit, CI run/attempt, release digest and exact image digests |
| Evidence | Registered protocol qualification report/artifact hashes |
| Tooling | Approved installed-tool and source-closure hashes |
| Target | Existing inventory plus physical shared-cluster/database/store binding |
| Recovery | B1 proof and separately qualified native-floor recovery evidence |
| Catalog | Native fingerprint and canonical V2 contract fingerprint |
| Configuration | Native/qualified lifecycle hashes and held editorial hash |
| Authority | `legacy/1` |

The registrar must independently obtain and reconstruct the authenticated CI artifacts and source/image correspondence through the existing channel. Caller-provided "passed" flags or copied reports are insufficient.

The launcher generates the internal request from verified material. Each stage binds its current signed predecessor and the same approved origin. Old installation authorization cannot authorize protocol mutation.

The deadline authorizes **starting** the operation: check it at reservation and before the first mutation. Once that exact operation has durably recorded its authorized start, signed continuation may complete its permitted stages after expiry. Every continuation revalidates the same operation/intent ancestry, candidate, binding, physical target, approved tools, live preconditions and exclusive lease. It cannot change effects, targets, evidence or request identity, start another attempt, or revive a revoked authorization. There is no recurring 60-minute human renewal ritual. An intent reserved but not started before its deadline cannot begin mutation after expiry.

Conditional recovery permission must explicitly name the new purpose `cms-protocol-native-floor-recovery`, supported source states and B1 companion baseline. It may be granted in advance through the same administrative channel, but ordinary installation/qualification permission does not imply recovery authority. Recovery gets its own authenticated intent and authorized-start record; the same exact-operation continuation rule applies.

## 5. Protocol installation and coverage qualification

### A. `--install-protocol`

Required before mutation:

- committed native floor and valid B1 binding;
- unchanged candidate, release and target;
- protocol purpose authorization valid to start, or an exact authenticated continuation of the same already-started operation, and qualified CI evidence;
- qualified B1 recovery prerequisite and authenticated companion baseline captured before protocol mutation, without rewriting B1 v1;
- admission closed, route unreleased, all relevant writers stopped;
- authority freshly observed as `legacy/1`, worker held;
- exact native catalog, protocol absence, zero tracked rows;
- existing cluster/admin/control/runtime/observer grant and ownership contracts.

Write and fsync the signed installation intent first.

Invoke the existing **`finalizeNewsProtocol()`** using the existing non-superuser `cms_admin` boundary. It continues to install V2 and return:

```text
installed: observed result
ready: false
coverageVersion: 0
```

Then independently verify the installed V2 catalog and actual coverage 0, capture the zero-head baseline and append the installation receipt.

Neither the finalizer nor its CLI gains a coverage-qualification switch.

### B. `--qualify-protocol`

Add:

**`cms/scripts/qualify-news-protocol.ts`**

This is a single-purpose privileged CLI invoked by the authenticated host launcher. Its inherited bounded request identifies the admitted intent; it accepts neither arbitrary SQL nor a requested coverage value. It does not possess the host HMAC key.

The host authenticates approval/evidence and verifies physical target identity. The SQL command rechecks its own database identity and live database preconditions.

Within one transaction:

1. Verify `session_user = cms_admin` and the existing non-superuser owner contract.
2. Acquire advisory reference lock **7194030**.
3. Reverify exact native-plus-V2 catalog, protocol functions/triggers and role/grant contracts.
4. Verify no tracked News rows, migration runs/items or mutation events.
5. Verify exactly one head with:
   - coverage 0;
   - sequence 0;
   - the canonical all-zero chain;
   - barrier `open`;
   - all barrier binding fields null.
6. Use the existing admin membership to `SET LOCAL ROLE cms_control`.
7. Perform one fixed, guarded compare-and-set of coverage **0 → 1**, requiring the same head predicates and exactly one affected row.
8. Restore role, validate the returned head and commit.

Perform reads under roles that already possess the required privileges. For example, `cms_control`'s INSERT privilege on events must not be mistaken for SELECT permission; event-emptiness checks can use the existing runtime-read boundary before switching roles, under the same transaction/reference lock.

No ledger event is manufactured for qualification. No sequence, chain, barrier or content row is reset.

After an acknowledged commit:

- durably store an authenticated commit receipt;
- perform a fresh independent read of target/catalog/grants/head;
- append the coverage-qualified state;
- proceed to the separately journaled runtime recreation.

The existing observer audit remains useful corroborating evidence, but continues returning `writeCoverageCertified:false`, `releaseCertified:false` and its existing physical-identity limitation. The host receipt supplies the authenticated operational binding; the audit does not become a certifier.

## 6. State compatibility and interrupted commits

Introduce **state schema 3**, phase **`protocol-preparation`**, after integration with the completed B0 package.

Entry requires schema 2 with `installIntent.stage = floor_committed`, no conflicting restore operation, closed admission and the verified native floor.

Preserve the existing signed envelopes and the completed installation binding, B0/B1 references and creation receipts. Add protocol-specific intent, observations and runtime-generation receipts.

Use explicit stages:

```text
reserved
→ protocol_install_pending
→ protocol_installed
→ coverage_commit_pending
→ coverage_committed
→ runtime_restart_pending
→ qualified_private
```

Add a terminal blocked classification **`coverage_in_doubt`**.

Schema 1/2 validators and proof contracts retain their original semantics. Journal replay accepts only the explicit schema-2-to-3 transition. There is no schema downgrade. Old preauthority backup/restore commands reject schema 3 rather than accepting installed protocol through widened old predicates.

### Crash decisions

| Durable state and live observation | Action |
|---|---|
| Installation pending; protocol absent | Reverify authorization/preconditions, then retry finalizer |
| Installation pending; exact V2, coverage 0, zero baseline | Reconcile the existing idempotent finalizer outcome |
| Partial/unexpected protocol/catalog | HELD and unsupported by the initial recovery contract; do not promise generic recovery |
| Coverage pending; coverage 0 and unchanged baseline | Retry only with valid authorization |
| Coverage pending; coverage 1 and a durable authenticated commit receipt | Reverify exact target/baseline and finish journal reconciliation |
| Coverage pending; coverage 1 **without** that receipt | `coverage_in_doubt`; CMS remains stopped |
| Coverage committed; restart incomplete | Resume only the bound CMS generation; do not repeat SQL qualification |
| Qualified state; live head/catalog/configuration mismatch | Fail closed; never lower coverage or switch automatically to native health |

**Proposed held decision for unknown commit outcome:** add no protocol table or database receipt to V2. Consequently, a crash after SQL commit but before durable host receipt cannot be automatically adopted as a successful qualification. A signed pending intent proves authorization to attempt the change, not completion.

An ambiguous coverage commit remains held. It may enter the separately authorized B1 recovery procedure only when the live source is exact canonical V2 at coverage 0 or 1 and satisfies all source-baseline constraints. Recovery appends a new authenticated successor; it never rolls the journal back or edits the coverage bit to zero. Partial/unexpected catalogs remain held and unsupported.

This is an explicit availability tradeoff submitted for the primary's critique, not a claim that unknown-commit recovery is already available. Until the B1 source-state recovery prerequisite in section 7 is independently resolved and qualified, the operation must remain blocked; an in-doubt commit must remain held. Missing receipts, bare coverage-1 observations and caller flags cannot be relabeled as successful qualification or successful recovery.

### Protocol-recovery intent and recovered successor

Add a separate immutable `protocolRecoveryIntent`, bound to the failed attempt/state digest, explicit recovery-purpose authorization, exact observed source V2/coverage state, physical target/store identities, B1 v1 proof digest, companion baseline digest, candidate/tools and lease. Journal bounded stages `reserved → source_verified → restore_pending → restored → native_verified → native_held_recovered`; every mutation follows the durable pending record and every retry revalidates the same source/target binding.

The successful successor remains schema 3 and records `native_held_recovered`, protocol absence, closed admission, held worker, legacy/1 authority, full restored-baseline verification and a new authenticated native runtime generation. The failed protocol attempt and all its receipts remain immutable historical evidence. No schema/journal downgrade, backward pointer, manual coverage-zero update or conversion of the failed attempt into a success is permitted.

Starting another protocol attempt after recovery is **DEFERRED** unless a separately reviewed, explicitly authorized new-attempt contract is added. This initial contract permits the native-held recovered successor, not automatic re-entry into installation or qualification.

## 7. Required B1 recovery prerequisite

**Unresolved prerequisite:** `payload-private-install-b1-v1` proves a capture. It does not, by itself, prove that the installed-protocol target can be restored safely. Neither the existing capture nor the preauthority recovery report fulfills the prerequisite below.

Before finalizer mutation, require separately authenticated evidence for:

**`payload-native-floor-recovery-v1`**

Its bounded acceptance is an exact operator procedure for the already-established shared-cluster topology, with machine-observed restore comparisons. Initially eligible **source** states are only exact canonical V2 at coverage 0 or 1, with the original empty tracked-data/zero-head/open-barrier and unchanged-source constraints. Partial or unexpected catalogs are held and unsupported, not implicitly covered by a generic recovery promise. It must cover:

- restoring from exact V2 coverage 0;
- restoring from exact V2 coverage 1, including an interrupted qualification;
- both database states/sequences and both upload trees;
- database ownership, roles/grants and shared-cluster identity;
- preserved Portal contents and security boundary;
- return to exact protocol-absent native catalog and zero tracked News rows;
- native health and durable-storage verification;
- closed admission, unreleased route and held worker;
- interruption handling that remains closed and preserves journal ancestry.

The restore preflight needs a separately versioned source-state contract for these installed-protocol cases. The existing preauthority restore preflight must continue rejecting them.

Before the first protocol mutation, authenticate an immutable **B1 companion baseline** linked to the existing `payload-private-install-b1-v1` proof and artifacts. It binds actual native schema/catalog/migration observations, both database data and sequences, both upload trees, roles/grants/ownership and the Portal security contract, physical targets, source state, candidate and observation/tool provenance. Compare the then-live quiescent source to that baseline. Do not rewrite or silently upgrade B1 v1. Restored schema/data/sequences/uploads/security must match this companion evidence before emitting the schema-3 native-held recovered successor.

B1 must still match the quiescent source being advanced. Reopening Portal writers or permitting subsequent content changes invalidates the assumption that restoring this B1 is lossless.

This is the recovery handoff prerequisite, not a completed recovery implementation or an assignment to duplicate the current pre-floor recovery worker. The approved exact B0 operator runbook retains its existing role. Do not require a generic clone orchestrator as a replacement for that approved runbook or as an unnecessary expansion of this bounded B1 acceptance.

If the new source-state procedure or its native qualification is missing, report the prerequisite as unresolved and reject protocol mutation. Do not synthesize recovery-qualified booleans, reuse a mismatched report kind, or infer restoration qualification from artifact existence.

## 8. Exact implementation ownership

The table identifies the proposed future edit surface; it does not transfer current ownership or authorize edits now.

| Files | Bounded change |
|---|---|
| `cms/src/config/lifecycle-profile.ts` **new** | Closed selector, immutable descriptor/hash, loaded-config assertions |
| `cms/src/config/environment.ts`, `cms/src/payload.config.ts` | Resolve lifecycle once; integrate approved editorial descriptor |
| `cms/src/database/catalog-verification.ts` **new** | Shared SELECT-only native/protocol catalog readers and comparisons |
| `cms/src/config/readiness.ts` | Native read-only check; explicit strict coverage observation; preserve storage probe |
| `cms/src/app/editorial/internal/native-ready/route.ts` **new** | Native-only private health endpoint |
| `cms/src/app/editorial/ready/route.ts` | Strict lifecycle requirement; unchanged ready JSON; validated profile headers |
| `cms/src/publication/mutation-ledger.ts` | Reuse/export head parsing without changing ledger DDL |
| `cms/scripts/check-cms-health.ts` **new** | Fixed lifecycle-bound Docker probe |
| `cms/scripts/verify-storage.ts` **new** | Operational wrapper around existing durable-storage probe |
| `cms/scripts/qualify-news-protocol.ts` **new** | Guarded, transactional coverage qualification |
| `cms/scripts/finalize-news-protocol.ts` | Shared-reader extraction; preserve finalizer and observer contracts |
| `docker-compose.payload.yml` | Explicit lifecycle input and fixed healthcheck |
| `cms/scripts/check-runtime-packaging.mjs` | Verify new runtime files/import closure |
| `ops/payload-control-runtime.py`, `ops/payload-control-state.py` | Post-floor commands, schema 3, receipts and reconciliation |
| `ops/payload-route-promotion.py` | Authenticated schema-3 current-generation resolver integration; retain strict probe and route-specific authorization |
| `ops/prepare-cms-authenticated.py` | Protected protocol approval/command dispatch |
| `ops/provision-payload-candidate-trust.py`, `ops/payload-candidate-verifier.py` | Independently administered protocol purpose/contract |
| `scripts/register-payload-candidate-admission.mjs`, `scripts/lib/payload-candidate-qualification.mjs`, `scripts/package-payload-candidate.mjs` | New authenticated evidence contract and packaged closure |
| `.github/workflows/ci.yml` | Actual candidate-image lifecycle/protocol qualification evidence |
| `docs/operations/payload-owner-news.md`, `docs/operations/payload-runtime-recovery.md` | Lifecycle, commands, evidence meanings and B1 prerequisite |

The current CMS editorial worker retains application-file ownership outside the explicitly authorized catalog extraction/finalizer wrappers/new focused tests; the current pre-floor recovery worker retains operational-file ownership. CI/Compose integration remains with the primary. B0 review/shipping and the running stable 38-file snapshot verification must finish before broader coordinated integration. The present extraction is preparation only and must preserve existing exports, absence/finalizer/observer contracts and fingerprint bytes, with no DDL or privilege changes.

For Nginx, preserve the exact/prefix denials in:

- `nginx/editorial-route.promoted.conf`;
- `nginx/editorial-route.inactive.conf`;
- `nginx/editorial-route.unavailable.conf`.

The new path is already beneath the denied `/editorial/internal/` namespace. Verify exact paths, trailing paths, query strings and normalized-path cases in every route state, with no proxy fallback or CMS success headers.

`ops/payload-route-promotion.py` must use section 3's authenticated current-generation resolver while continuing to probe `/editorial/ready` and its exact JSON. Native health cannot satisfy that gate, and the resolver cannot replace route-specific authorization.

## 9. Required acceptance tests

### Offline and compatibility checks

- Missing/invalid lifecycle input; forbidden profile combinations.
- Mutating environment after configuration construction cannot change request behavior.
- Descriptor assertions inspect actual loaded configuration.
- Existing native fingerprint golden cases remain unchanged.
- Native verifier rejects protocol objects, unexpected schemas and weakened native constraints.
- Full strict comparator rejects missing bootstrap, changed seal body, unknown functions, extra protocol/native objects and unexpected triggers; golden fingerprint tests protect the original serialization bytes rather than mirror expected constants.
- Finalizer still installs coverage 0 and refuses an already coverage-1 head.
- Observer report retains all observation-only limitations.
- Schema 1/2 journal replay remains valid; unauthorized schema transitions and historical receipt changes fail.
- Packaging includes every new helper.
- Nginx and route-promotion regressions preserve private-path denial and strict readiness consumption.
- Current-generation resolver rejects historical/native containers, stale boots, incomplete protocol/restart state and broken replacement ancestry while preserving the original installation receipt.
- Recovery rejects partial/unexpected source catalogs, missing/tampered companion baselines, altered data/sequences/uploads/security, unauthorized recovery purposes and attempted post-recovery re-entry; its successful successor is append-only schema 3/native-held with an immutable failed attempt.
- Deadline tests distinguish late first mutation from exact signed continuation, revalidate target/tools/lease, and prove that expiry cannot authorize a new attempt or broaden recovery effects.

### Real candidate-image qualification on disposable PostgreSQL 16

The report must come from the actual admitted image and production command paths:

1. Native absent-protocol health succeeds; strict readiness fails.
2. Repeated native health causes no persistent DB or filesystem mutation.
3. Native storage probe proves the actual mount; failures reject operational readiness.
4. Finalizer installs exact V2 at coverage 0; strict readiness still fails. At coverage 1, missing bootstrap, changed seal body, unexpected trigger and weakened native constraint each independently fail the full strict read-only snapshot check.
5. Authenticated qualification reaches coverage 1 through the guarded command.
6. Native adapter write paths exercise the mutation-table inventory, including versions, Home, media, migration bookkeeping and direct job-adapter behavior. Assert expected ledger effects and forbidden operations; do not infer coverage solely from trigger presence.
7. Runtime, observer and controller identities cannot directly qualify coverage.
8. Missing/disabled/altered triggers, native drift, incorrect grants, nonzero head/events, wrong target, stale approval, wrong image, replay and lease loss all reject.
9. Process-kill injection covers finalizer commit, coverage commit/receipt, journal commit and container recreation boundaries.
10. Same-image native-to-qualified recreation produces strict health and correctly bound receipts.
11. The actual native-floor B1 recovery command passes the independently specified restore acceptance from each supported exact V2 source, preserving the failed attempt and producing the schema-3 native-held successor; partial/unexpected source cases remain held.

Any fixture that directly sets coverage to 1 is excluded from protocol-qualification evidence. Offline `npm run verify` is required for implementation, but cannot replace these native execution results.

CI runs these actual command paths on disposable targets before production admission. Qualification is bound to the single final image/package containing all three slices; an intermediate extraction-only image is not operationally admissible. The current bounded change runs only focused offline tests. Full verification is deferred to the primary's stable integration; reviewer shell denial supplies no native execution proof.

**Proposed completion condition:** an authenticated `qualified_private` receipt binding the candidate, live target/catalog/grants, acknowledged coverage transition and current strict-health boot. It supplies the prerequisite for later activation work while preserving the separate editorial-promotion contract.

**Current status:** proposed design amended for the primary-accepted CORRECTED/fix-first findings. Only the catalog extraction/finalizer-wrapper preparation and focused new offline tests are authorized to start. No completed lifecycle, native PASS, B1 source-state recovery qualification, coverage qualification or production operation is claimed. The unresolved B1 prerequisite, unknown-commit hold, unsupported partial-catalog recovery and deferred post-recovery new-attempt contract remain explicit gates.

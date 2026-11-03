# Production pre-floor B0 recovery — B0-09 bounded design

## Steps
- [x] Integrate the current B0 capture/acceptance worker's fixes and review findings before beginning this package.
- [x] Obtain independent critique of this complete design and primary-session authorization for implementation.
- [x] Implement immutable pre-grant baseline, recovery authorization, state/replay contracts and administrative inspection.
- [x] Implement bounded protective capture, production fences and interrupted database/uploads recovery.
- [x] Implement exact previous-application private startup, readiness and egress verification through legacy_ready_held.
- [ ] Qualify portable contracts, native processes and production-shaped PostgreSQL/application CI; complete fresh review and required verification.
- [ ] Publish the reviewed runbook and evidence, keeping any live destructive recovery subject to its separate incident-specific approval.

## Status, authority and constraints

- **Status: IMPLEMENTATION AUTHORIZED AFTER INDEPENDENT CRITIQUE.** Primary reports B0 fresh review SHIP and both HIGH findings closed. The eight mandatory amendments incorporated below govern implementation.
- B0 reviewed bytes are staged in the primary index and detached verification is running. Never git add/reset/commit/checkout or otherwise change the index. Recovery changes remain unstaged on top. Ownership is ops/runtime/state/preparer/provisioner recovery and new helper/tests/native workflow. Do not edit ci.yml, the B0 workflow, or CMS/application DTO/manual-runtime files owned by the other worker.
- **Implementation present; NOT SHIP / native qualification incomplete.** The focused five-file Node regression run passed 93 tests, failed 0 and skipped 9 native tests on Windows. The expanded recovery fixture rerun passed 10 Python tests, failed 0 and explicitly skipped 2 Linux storage tests. Python syntax and git diff --check passed. Native PG/application/witness qualification and stable full verify remain pending; no live-host observation or restore qualification is claimed.
- Exact requirement: `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md:173`, B0-09: integrate interruptible, closed and auditable pre-floor recovery; use fresh processes/leases for resumes; reconcile unknown COMMIT; preserve CMS evidence; `data_verified_readiness_pending` does not open admission; forbid downgrade after native edits.
- Parent plan: `C:/Users/Criação/.opencode/plan/2026-11-02-portal-own34-completion.md`.
- **Actual destructive production recovery must NEVER execute under the existing isolated-restore/M2 authorization.** It requires a separate, authentic, incident-specific administrative approval for the exact recovery plan, target and B0. This document supplies no such approval.
- The supported terminal state is **`legacy_ready_held`**, not public reopening. Admission stays closed, public nginx stays stopped, CMS stays held and worker stays held.
- No generic recovery/clone orchestrator. Reuse the already approved operator-driven exact-B0 clone qualification.
- The isolated executor remains TEST-only and continues rejecting production before effects. No production-enabling flag, alias or widened interpretation of its request is permitted.
- No automatic rollback, automatic restoration of the protective backup, automatic candidate restart or automatic release of ingress/admission.
- Preserve immutable B0 bytes, original installation binding, acceptance, creation receipts, journals, B1, partial captures and ambiguous-operation evidence. Do not clear, rewind, replace or re-admit them to resume.
- Scope is production pre-floor recovery to the prior legacy application. Active/frozen Payload recovery, post-native-edit downgrade, protocol activation and editorial capability work are outside this package.
- Do not infer approval from root ownership, hash strings, an operator-supplied PASS or a name in JSON. Reuse the independently authenticated administrative provisioner model.
- No caller-selected SQL, commands, database URLs, images, release paths or destructive targets. Executable behavior comes only from the authenticated bounded implementation.
- Linux/VPS-targeted operations; preserve repository boundaries, Node 18 compatibility for shared API/cron code and LF conventions where relevant. Required implementation checks remain `npm run verify` and `git diff --check`.
- No delegation, dependencies, live production operations, local Docker, SSH, GitHub or Linear operations. Offline tests are authorized. Native qualification is implemented only in a new CI job; primary runs stable full verification later.

## 1. Findings that constrain the implementation

Implement a dedicated, ADMIN-only production B0 recovery path authenticated by the existing preparation launcher and provisioner. It must deliver an actual bounded restore executor, interrupted-operation reconciliation and private startup verification of the previous application. Merely recording approval of clone evidence does not satisfy B0-09.

The design is based on the inspected checkout, including the new v4 `b0GateVersion: 1` / `receiptId` acceptance path. Recheck those source contracts after the current B0 worker's review fixes are integrated; this document is not a claim that the moving checkout has been frozen or independently reviewed.

| Current contract | Consequence |
| --- | --- |
| `payload-control-state.py::validate_install_recovery()` accepts binding versions 2/3 and only `reserved` / `portal_grants_pending`. | Production v4 needs an explicit new recovery discriminator, not widened interpretation of historical records. |
| `payload-install-recovery-isolated.py::Executor.__init__()` rejects production before effects. | Preserve that rejection and its tests. |
| `Runtime._install_origin_check()` rejects any install containing `recovery`. | Preserve installation freeze once production recovery begins. |
| `validate_state_transition()` freezes installation evidence while recovery progresses. | Extend version-specific recovery rules; do not clear or rewind installation. |
| `portal_grants_pending` precedes the actual `migrate` invocation. `api/db/migrate.js` performs role provisioning and individually committed migrations. | Treat this checkpoint as possibly modified, including ambiguous completion. It is not pre-grant merely because its completion checkpoint is missing. |
| `verify_production_b0_artifacts()` verifies the exact four B0 files, HMAC, hashes and upload-content fingerprint. | It does not establish complete role/security restoration, upload metadata, application compatibility or permission to restore. |
| `provision_b0_acceptance()` authenticates the decision and hashes the qualification bundle, but publishes only the decision. | Recovery must retain authenticated evidence/contract bytes at fixed protected locations rather than depend on an operator path or PASS field. |
| `check_portal_destructive_fence()` requires both databases, embeds process-specific context and uses hard-coded Portal database service labels. | It cannot be applied unchanged to early stages with no CMS database or blindly reused for a differently configured Portal database. |
| Existing writer-resume methods require a migrated Payload floor. | They are not a previous-legacy application recovery mechanism. |

The existing B0 dump is not a cluster-role backup. A safe recovery profile cannot reconstruct pre-grant role attributes, credentials, consumers or complete upload metadata from a target already modified by installation.

## 2. Exact eligibility

### Eligible installation stages

Use this closed set:

```text
reserved
portal_grants_pending
portal_grants_verified
cms_resources_pending
cms_resources_bound
cms_provision_pending
provisioned
private_started
private_ready
b1_committed
```

These are stage candidates, not sufficient authorization by themselves. Every entry also requires:

- `schemaVersion: 2` host state.
- Production binding v4, `b0GateVersion: 1`, exact reserved `receiptId`.
- `authorizationFreshAtReservation: true`.
- Immutable, matching `b0Acceptance`.
- `phase: preauthority`, authority exactly `legacy/1`, admission closed and worker held.
- No ordinary `restoreIntent`; no rollback target.
- Current-release pointer still exactly `binding.sourceRelease`.
- No floor record and no historical floor commit in the authenticated journal.
- Exact source release, previous images, candidate provenance, inventory, lease inode and Portal targets.
- Authenticated recovery baseline and approved restore contract defined below.
- Actual CMS observations compatible with an installation-only, pre-editorial state.

### Always rejected

- `floor_commit_pending`, even if the pointer still names the source.
- `floor_committed`, `cmsStatus: migrated` or any previously committed native floor.
- Payload/Payload-frozen authority, authority epoch changes or activation history.
- Present protocol/run/seal/mutation history indicating progression beyond this package.
- Native article, version, media, schedule, migration-content or editorial audit evidence.
- Unknown or contradictory CMS state.
- Historical production bindings without the B0 gate.
- Missing pre-grant baseline after reaching `portal_grants_pending`.

The prohibition is stronger than current emptiness of news tables. Deleting native content must not make a used system eligible again.

### Partial-resource cases

| Stage family | Required handling |
| --- | --- |
| `reserved` through `portal_grants_verified` | Physically prove CMS absence. Unexpected CMS resources cause refusal. |
| `cms_resources_pending` | Verify every existing creator receipt. Unreceipted residue remains evidence, not an adopted resource. A create-to-receipt gap without sufficient authenticated provenance remains held. |
| `cms_resources_bound` / `cms_provision_pending` | Preserve the CMS database, roles, uploads and containers. Only absent/uninitialized native state remains a candidate; any native schema, including recognized prefixes, is held because historical non-use is unprovable. |
| `provisioned` through `b1_committed` | Native-schema states are refused, including empty/protocol-absent states. Preserve B1, including partial material. These stage names alone never confer eligibility. |

Use a finite source-derived catalog/migration-prefix classifier for partial CMS. Inspect ALL present content, version-child, media, jobs, schedules, audit and import-content relations; distinguish migration bookkeeping. Missing tables are acceptable only when predicted by the exact prefix, never because a query failed. Create/receipt gaps remain unsupported and held. Neither current emptiness nor `nativeUsed: false` proves unused history.

Compatibility refinement accepted in the second FIX-FIRST review: recognition is
not authorization. There is no already-existing trustworthy chain proving never
native use, so ALL native-schema prefixes refuse. Only an absent or uninitialized
target (no native tables; optional empty migration ledger), with the existing
authenticated receipts and fences, can remain eligible. No retrospective marker,
operator assertion, approval flag or sequence reset may manufacture non-use.
Native-schema/floor recovery is a separate gate/procedure, not covered here.

Do not delete any CMS database, volume, role or installation receipt to make legacy recovery succeed.

## 3. Architecture and administrative interfaces

### Recommended boundary

Add `ops/payload-production-b0-recovery.py` for production-only recovery contracts, bounded observations, state-machine execution and fixed operations. Add a small fixed external-fence witness helper if implementing the currently missing independent probe transport requires it.

Load the recovery module from captured, authenticated closure bytes, as `load_runtime_captured()` loads runtime/state. Add it to both closure manifests:

- `prepare-cms-authenticated.py::FILES`.
- `provision-payload-candidate-trust.py::PREPARATION_FILES`.

Do not expose recovery through the restricted CI receiver, generic `payload-control` dispatcher or an arbitrary `operations` callback supplied by a request.

### Public ADMIN interfaces

| Interface | Effect |
| --- | --- |
| `--capture-b0-recovery-baseline RECEIPT` | While still `reserved`, capture and bind supplementary pre-grant evidence. Host observations are read-only; protected evidence and signed state are appended. |
| `--check-b0-recovery RECEIPT` | Read-only eligibility/plan inspection. No head repair or service change. Return exact plan/head digests required for approval. |
| `--recover-b0 RECEIPT` | Execute or resume the one approved recovery. Authenticate afresh and acquire a new lease on each invocation. |

The internal launcher child is `--execute-b0-recovery RECEIPT`. It requires inherited FD9 and authenticated parent/process context. It is not a second standalone authorization channel.

Provisioning uses the existing interface with a new closed profile:

```text
provision-payload-candidate-trust.py
  --profile b0-recovery
  --check | --apply
  --approval <decision-file>
  --approval-sha256 <independently-approved-digest>
  --bundle <protected-evidence-bundle>
```

The provisioner program and expected approval digest must be independently authenticated through the administrative channel. Root ownership, an approver name in JSON or computing the expected digest from the supplied file is insufficient.

### Fixed internal interfaces

Suggested new internal functions:

- `validate_production_recovery_decision(value, install, plan)`.
- `validate_production_recovery_contract(value, install, baseline)`.
- `capture_production_recovery_baseline(context)`.
- `inspect_production_recovery(context)`.
- `collect_production_recovery_boundary(context, phase)`.
- `execute_production_recovery(context)`.
- `verify_previous_application(context)`.

The authenticated launcher constructs `context`. Operator JSON is never deserialized into executable capabilities.

## 4. Immutable evidence contracts

Use canonical UTF-8 JSON, duplicate-key rejection, exact-key validation and existing hash conventions. Preserve historical bytes and discriminator semantics.

### A. Supplementary pre-grant baseline

Introduce signed proof kind `production-b0-recovery-baseline-v1`. Store it outside the B0 directory: the current B0 verifier requires exactly four files.

Its closed contents bind:

- Schema/kind.
- Receipt and canonical installation-binding hash.
- Reserved origin state hash/sequence.
- B0 proof and manifest hashes.
- Source commit/release and exact `previousImages`.
- Portal physical target.
- Source schema/object inventory and migration-ledger digests.
- Source data/sequences fingerprint using the existing algorithm.
- Normalized legacy security observation and digest.
- Upload content and complete supported metadata-manifest digests.
- Source role-consumer/exclusivity evidence digest.
- Credential-verification evidence digest, containing no credentials.
- Capture fence observation digest.
- Authenticated executable/tool versions relevant to reproducibility.
- Exact artifact records: name, byte length and SHA-256.

Persist an immutable reference in `installIntent.b0RecoveryBaseline`.

Capture is allowed only at `reserved`, with a fresh source fence and live data/upload equality to B0. Never learn the baseline from `portal_grants_pending`.

Install the expanded recovery-capable authenticated closure BEFORE a NEW B0 reservation. Retrofitting a prior closure/reservation is unsupported; no bridge is in scope. Order: supplementary baseline, acceptance decision at the resulting head, acceptance append, recovery inspection and incident decision. A persisted acceptance retains its original head. Do not capture baseline after acceptance or learn original role facts late.

Supplementary baseline must prove source schema/security/upload-metadata correspondence to the exact archive and qualified clone, not merely data fingerprints. Preserve the existing legacy-security blockers. Facts absent before grants cannot be reconstructed from a modified target.

For new migration starts, require the baseline in runtime and `STATE.transition()` immediately before the first `portal_grants_pending` append. Historical journals remain readable; absence is not silently repaired.

### B. Approved recovery contract

Retain protected `recovery-contract.json`, independently approved as part of the recovery decision bundle, with:

- `schemaVersion: 1`.
- `kind: production-exact-b0-recovery-contract-v1`.
- Installation, baseline, B0 and acceptance hashes.
- Existing accepted qualification-evidence and procedure hashes.
- Fixed restore-profile identifier.
- Expected restored schema/catalog and data/sequence digests.
- Expected owner/ACL/default-ACL projection.
- Required unchanged role attributes, memberships and credential checks.
- Complete upload metadata policy and expected manifest.
- Exact previous-image startup configuration digest.
- Destructive-fence topology profile digest.
- Private-readiness/egress profile digest.
- Qualification material manifest.

The expected restored schema comes from the already approved operator-driven exact-B0 clone qualification. Do not build a new clone orchestrator, import the TEST autocard rewrite exception or add a generic SQL normalizer. ONE approved restore contract binds security, topology, witness and readiness/egress profiles; do not introduce multiple approval rituals.

If the old qualification bundle lacks a necessary measurement, the contract remains incomplete. A textual PASS is not a substitute.

### C. Incident-specific restore decision

Use a separate decision, not B0 migration acceptance:

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `production-exact-b0-recovery-approval-v1` |
| `purpose` | `restore-previous-legacy-prefloor-held` |
| `recoveryPlanSha256` | Canonical bounded plan, binding original head/stage, installation binding, immutable acceptance, pre-grant baseline and exact contract bytes |
| `approvedAt` / `expiresAt` | UTC integers; positive window of at most 3,600 seconds |
| `authenticatedChannel` | `independently-authenticated-admin-vps` |

The decision cannot select SQL, commands, database URL, release, target, image, volume or output directory.

The implemented closed decision derives receipt, B0/proof/manifest, previous images,
physical targets and qualification/procedure lineage through that immutable plan,
binding, baseline, acceptance and contract. These constraints remain mandatory;
they are not duplicated as separately editable decision fields.

Publish once at a fixed protected destination, retaining its evidence bundle in a digest-addressed directory. Exact bytes are idempotent; conflicting publication is rejected.

Expiry semantics:

1. Require freshness when first reserving recovery.
2. Check again immediately before the first durable destructive checkpoint, exactly `database_restore_pending`.
3. Once destructive pending is durably signed, permit only exact reconciliation/resumption after expiry.
4. Never renew the decision, candidate nonce, acceptance or installation reservation to resume.

The existing M2 authorization for isolated restoration does not instantiate this live-production approval. Destructive production recovery must never execute under that authorization.

## 5. Recovery state contract

Introduce `recoveryVersion: 3` with purpose `production-exact-b0-prefloor-recovery`. Keep versions 1/2 unchanged.

### Immutable recovery binding

Bind the decision, contract, baseline, plan and preserved-resource snapshot, plus:

- Original installation-binding hash.
- Original head and installation stage.
- Receipt.
- B0 proof/manifest.
- B0 acceptance hash.
- Source release and previous images.
- Portal target.
- Original lease device/inode.

Derive previous images, targets and receipt from the immutable installation binding instead of duplicating authorities. Any retained duplicates must match it. Plan hashing is acyclic: exclude process nonce/time, future outputs and its own approval digest. Canonical-value hashes are SHA-256 of canonical UTF-8 JSON WITHOUT LF. File/evidence/decision hashes cover exact bytes including a canonical JSON file's LF. Existing envelope/journal hash conventions stay unchanged.

### State progression

```text
reserved
quiesce_pending
quiesced
protection_capture_pending
protection_verified
database_restore_pending
database_restored
uploads_restore_pending
uploads_restored
data_verified_readiness_pending
legacy_start_pending
legacy_ready_held
```

Use small, typed, append-only evidence references for protective capture, database completion, upload progress/completion, recovery-owned application-container creation and readiness result.

Enforce these rules during writes and journal replay:

- Adjacent progression or exact idempotence only.
- Original `installIntent.stage` remains unchanged.
- Binding, acceptance, baseline, creation receipts, `cmsTarget`, B1 and prior journal entries remain immutable.
- No clearing `recovery` or transitioning back into installation.
- Admission stays closed, authority stays `legacy/1`, worker stays held.
- `cmsStatus` continues representing the preserved installation checkpoint; do not reset it to `cold` to hide evidence.
- The terminal state records private previous-legacy recovery, not a new installation floor.

`data_verified_readiness_pending` is not success and cannot open admission. `legacy_ready_held` is the supported terminal state; public reopening is not part of this package.

## 6. Execution and reconciliation

### Boundary authentication

Every invocation and destructive boundary revalidates:

1. Complete executable closure and approval/policy/admission record.
2. Exact original receipt/candidate correspondence.
3. Signed state and legal journal history.
4. FD9, lock pathname and original device/inode.
5. Current pointer and immutable source image/configuration.
6. B0 bytes through stable descriptors.
7. Portal cluster/database OID/name and volume identity.
8. Preserved CMS resources and evidence.
9. Actual current fence and role/security conditions.

Generate a fresh process nonce/PID/start-time observation on each invocation. This is freshness evidence, not renewed recovery authorization.

Reuse `reconcile_install_head()`'s narrow repair pattern only in the mutating entrypoint, with an additional exact-recovery check. Read-only inspection continues with `repair_head=False`.

### Protective backup

Before any destructive operation:

- Capture current Portal database and uploads.
- Capture every present CMS store, including partially provisioned stores, using a preservation-proof format that does not falsely claim a complete B1.
- Preserve role/security observations, physical identities, creation receipts, B1 references and relevant private diagnostics.
- Bind every captured artifact to the recovery decision and pre-destructive state.
- Verify complete files, hashes, metadata and the still-held fence.
- Persist `protection_verified` before allowing database pending.

Use the inventory's `preRestoreBackupRoot` and a deterministic decision-bound directory. Record attempt intent BEFORE exclusive files; fsync files/directories, validate the whole same-attempt capture and seal its manifest before `protection_verified`. Retain partial material and record a fresh attempt instead of truncating it. Never mix attempts. Destructive pending binds ONE sealed attempt/comparison tuple; never recapture after pending as a new previous state. Preserve partial B1/incomplete stores with explicit declared status.

This backup records the current state for protection. It must never become the desired legacy baseline.

### Database strategy

Choose one supported production profile: preserve archive owners and ACLs, retain existing database/cluster identities and leave cluster roles/credentials unchanged.

- Use the exact accepted archive.
- Use a single-transaction restore with error-on-failure.
- Resolve the target only from authenticated inventory/binding.
- Preserve database OID; do not drop/recreate the database.
- Do not invoke candidate migrate/provision as repair.
- Do not use `--no-owner` / `--no-acl` followed by broad grants.
- Do not restore cluster globals, rotate passwords or repair arbitrary roles.

`pg_restore --clean --if-exists` is safe only inside an enumerated qualified object-layout envelope. Initially support ONLY enumerated source/current layouts. It does not remove arbitrary candidate-only objects. Any necessary deletion plan is code-owned and atomic WITH archive restoration, without preliminary committed deletion. Refuse unsupported objects/dependencies before destruction; never accept operator SQL or a universal `DROP SCHEMA ... CASCADE` fallback.

`portal_grants_pending` remains potentially committed: the protective snapshot and observed supported layout, not its name, determine the restore path.

### Shared-cluster security distinction

Do not undo the CMS-to-Portal CONNECT fence when preserving CMS resources. The approved target-security projection distinguishes:

- Portal objects restored from B0.
- Immutable Portal role/credential requirements.
- Retained shared-cluster isolation restrictions, including CMS denial of Portal CONNECT.

The source proof stays unchanged. Explicitly retain database-level CMS CONNECT denial and preserve other grantees. Permitted source-ACL differences must be narrowly defined retained-fence rules in the one contract; incompatible cases remain held. Authenticate previous-application passwords against real runtime roles, not SCRAM verifier byte equality: provision can rotate salts for the same password. Never mutate roles/credentials or unrelated databases during restore.

### Unknown COMMIT

At `database_restore_pending`, a fresh process proves the previous restore backend is no longer running, then compares catalog, data/sequences, owners/ACL/default ACLs, physical identity and retained fence:

- Exact approved restored result: test FIRST, verify fully and append `database_restored`; do not restore again. If both restored and protected-previous match, this branch wins.
- Exact protected pre-restore result: the single transaction did not commit; the exact operation may be retried after fresh checks.
- Anything else: retain pending and refuse.

Never implement “not equal to B0, therefore run restore again.”

### Upload restoration

Before clearing:

- Verify target volume and all consumers.
- Validate archive with the existing bounded parser.
- Verify its approved metadata profile, including root/directory metadata.
- Refuse unsupported symlinks, devices, sparse files, ACLs/xattrs or ownership cases.

Metadata is exactly UID/GID/mode and qualified mtime precision, not ctime/atime/inode preservation. Use same-filesystem staging and atomic per-file installation. Persist intent BEFORE EACH create/replace/delete/metadata effect; fsync files/directories. Keep bounded progress evidence OUTSIDE the restored tree. Reconcile rename-before-completion, partial temps and file/directory conflicts; apply directory/root metadata bottom-up. Never clear the tree again on resume. Pending state distinguishes:

- Exact original entries awaiting removal.
- Removed entries.
- Fully verified B0 entries.
- Executor-owned temporary entries associated with the current operation.

On restart, reconcile only those recorded states. Unexpected names, bytes or metadata are drift, not permission to clear the volume again.

Verify the entire final content and metadata tree before `uploads_restored`; reverify database/security and preserved CMS evidence before `data_verified_readiness_pending`.

## 7. Fence and previous-application startup

### Destructive fence

The existing classifier is useful but is not a production collector. Add a narrowly versioned recovery fence supporting:

- Portal database always present.
- CMS database absent/present according to authenticated stage/resource evidence.
- Configured Portal database name.
- Stable approved topology separated from per-process freshness context.

Retain v1 behavior for existing callers. The production collector must obtain actual bounded observations:

- Two consistent Docker topology passes.
- Exact stopped writers and volume consumers.
- Known local daemon.
- No alternative ingress, host/container-network escape, unknown endpoints or one-shots.
- No active clients, transactions, prepared transactions or unsupported background writers.
- Approved non-Docker ingress coverage.
- Fresh independent external probes.

A JSON `independent: true` is not authentication. SELECTED TRANSPORT: fixed OpenSSH forced-read-only-probe to an independently provisioned external witness, pinned host key/profile. Launcher supplies fresh nonce/context/profile binding; require bounded canonical response over the authenticated channel with locally measured freshness. Fixed routes must match a QUALIFIED closed-response contract. No user URL, command or credentials in JSON. Transport failure/replay/mismatch denies. No shared-proxy changes; production eligibility stays blocked until a real qualified closed arrangement exists.

Timeout, DNS/TLS error, redirect or arbitrary upstream 502 does not prove closure.

### Previous application

Do not reuse `resume_writers()` or start candidate API/cron. Use exact `previousImages`, source configuration and a separately authenticated readiness profile. Prefer dedicated recovery-owned private API/cron containers to preserve candidate containers and their creator receipts.

Requirements:

- Record creation/start intent before effects.
- Record full IDs, images, mounts, configuration and network receipts.
- No published ports or public nginx restart.
- API connects to the exact restored Portal target.
- Cron uses qualified bootstrap-only mode and never schedules jobs, PLUS a fixed read-only DB-authentication probe using real runtime configuration. Bootstrap is not scheduled-worker health.
- External effects remain contained by an observed egress policy.
- Firebase/authentication checks use the approved private flow. A production authentication claim cannot be replaced by an emulator result.
- API probes verify exact target and database user plus approved authenticated read/upload. Controlled Firebase-verification egress is required for real auth claims; blocking all egress is not a substitute. Application readiness and real runtime-role authentication succeed.
- Recheck database/uploads and CMS preservation after probes.

Use a separate READINESS fence allowing only receipted recovery containers. Reentry at `legacy_start_pending` reconciles intended/receipted containers rather than blindly recreating them or applying all-writers-stopped rejection. Clone qualification establishes exact previous-image compatibility; runtime startup establishes actual-target usability.

On success, append `legacy_ready_held`. Keep admission closed, public nginx stopped, CMS stopped and worker held.

On failure, retain pending checkpoint/evidence. Stop only positively identified recovery-owned processes when necessary to restore the held boundary. Do not restore the protection backup automatically or restart the failed candidate.

## 8. Exact reuse and guard points

| Existing function | Reuse / restriction |
| --- | --- |
| `_authenticated_material()` | Authenticate the expanded closure before executing the new helper. |
| `deployment_lease(close_only=True)` | Parent acquisition for mutating recovery; retain lease through child cleanup. |
| `verify_inherited_lease()` | Child and boundary checks. |
| `run_bounded_subprocess()` | Launcher supervision, bounded output/process-group cleanup. Large archive streams need bounded streaming transport, not its 64-KiB response channel. |
| `protected()`, `read_protected()`, `publish()` | Protected immutable decisions/contracts/evidence. |
| `inspect_install_host()` | Read-only initial inspection. Do not retain its snapshot-bound state reader for mutating execution; load fresh captured runtime/state. |
| `validate_production_correspondence()` | Exact candidate/source/inventory authority comparison. |
| `verify_production_b0_artifacts()` | Preserve public result contract. Add private pinned-stream implementation underneath for executor consumption; do not expose descriptors in result JSON. |
| `portal_legacy_security_observation_sql()` / validator | Fixed security observation through new bounded transport. |
| `check_portal_legacy_security_baseline()` | Pre-grant semantics only. Do not remove blockers to turn it into authorization. |
| `_data_fingerprint()` / `_data_fingerprint_rows()` | Preserve fingerprint algorithm; supply bounded transport. |
| `_bounded_gzip_tar_tree()` | Archive/content validation supplemented by metadata proof. |
| `validate_state_transition()` / `transition()` | Versioned legal transitions, immutable evidence and immediately-before-append approval checks. |
| `_install_origin_check()` | Continue blocking installation after recovery begins. |
| `rollback_check()`, `open_admission()`, `resume_writers()` | Continue rejecting this pre-floor recovery state. |
| Isolated `Executor` | Remains TEST-only and production-refusing. |

Also explicitly guard `advance_install()`, `record_install_creation()`, `begin_install_floor()` and `commit_install_floor()` against production recovery, even though transition replay supplies a second barrier.

## 9. Required tests — portable subset passed; native qualification pending

### A. Portable contract and state tests — implemented subset passed, full matrix pending

Cover:

- All ten eligible stage candidates.
- Forbidden floor stages and migrated/active/frozen histories.
- `portal_grants_pending` with actual committed changes.
- Missing baseline after grants and attempted late baseline capture.
- Historical v2/v3 and ungated-v4 readability without authorization.
- Acceptance used as recovery approval; isolated approval used for production.
- Decision/contract/evidence mismatch, duplicate keys, extra keys and type coercion.
- Expiry at reservation and immediately before destructive pending.
- Exact continuation after expiry.
- Immutable binding, acceptance, baseline, receipts, B1 and journal bytes.
- Illegal stage skipping, evidence replacement, recovery removal and installation resumption.
- Content deleted after native use still denied.
- Configured non-default Portal database.
- Absent CMS versus unreceipted/partially provisioned CMS.
- Source-role/profile mismatch and forbidden broad ACL repair.
- No arbitrary SQL, commands, URLs, paths or images through any interface.

### B. Native Linux/root processes with Docker/PG doubles — NOT RUN

Follow `tests/fixtures/payload-b0-native.py`'s explicit scope:

- Real ADMIN/provisioner CLI and fresh child processes.
- Real root ancestry, protected files, HMAC journal, fsync and FD9.
- Real process nonce/start-time and independent lease acquisition on retry.
- Interruption before append, after append/before head, after simulated database COMMIT, after uploads clear/materialization and after private start.
- Child timeout, grandchildren, output overflow and failed-reap behavior.
- Concurrent-operation refusal.
- No mutation on authentication/fence failure.
- Proof flags explicitly identifying simulated Docker/PostgreSQL and unqualified real restore/application compatibility.

A PASS here is not B0-09 operational qualification.

### C. Dedicated production-shaped PostgreSQL CI — NOT RUN

The dedicated `payload-production-recovery-check.yml` now wires required native
ADMIN/provisioner/FD9/HMAC process chains, storage interruptions, PG16 restoration,
fixed historical API/cron image builds and forced OpenSSH/HTTPS transport. The
ADMIN fixture uses explicit persisted Docker/PG observations; its credential
refresh case calls the actual historical API. Real database and application
components run in separate bounded fixtures. Source adaptations and limits of
composition evidence are explicit in the sanitized reports. All components and
cleanup receipts are mandatory; skipped or missing proof fails the job. This is
authored wiring, NOT an execution result. No native job was run locally and no
remote workflow was dispatched; this step and B0-09 remain open.

Use a disposable Linux job/daemon, production-shaped v4 state and authenticated relocated fixture closure, without production credentials/endpoints. Exercise the actual new executor against:

- PostgreSQL 16 and real archive restore.
- Portal and CMS in the same cluster.
- Nonempty Portal data, sequences, role authentication and ACL/default-ACL/owner cases.
- Real committed Portal migration/provisioning effects.
- Partial/completed pre-floor CMS installation states.
- Preserved CMS database/uploads/B1 and an unrelated database sentinel.
- Invalid role passwords and unexpected memberships/dependencies.
- Real killed restore sessions and fresh-process reconciliation.
- Real interrupted uploads restoration and metadata comparison.
- Real pinned previous-application fixture images.
- Cron bootstrap-only startup and enforced egress containment.
- Real fence witness challenge/replay negatives.
- Unknown schema drift, prepared transactions, foreign volume consumers and native edits.

Assert command/effect counts so successful reconciliation proves destructive operations were not repeated.

The CI report separates:

1. Executor/data restoration qualification.
2. Previous-image fixture application qualification.
3. Exact real production B0 clone qualification.
4. Any eventual live recovery execution.

No synthetic result may close the latter two. No live destructive recovery test is authorized by this plan or the existing isolated-restore authorization.

## 10. Minimal file set and implementation order

These implementation targets are authorized by primary subject to the amended ownership/index and operational constraints above.

### Production files

1. New `ops/payload-production-b0-recovery.py`.
2. `ops/payload-control-state.py`: baseline reference, recovery v3, replay/expiry guards.
3. `ops/prepare-cms-authenticated.py`: ADMIN interfaces, captured loader, parent/child supervision.
4. `ops/provision-payload-candidate-trust.py`: `b0-recovery` profile and immutable evidence publication.
5. `ops/payload-control-runtime.py`: shared pinned-artifact/observation seams and baseline gate integration only.
6. New small witness helper if required for independent fixed probe transport.

### Tests and documentation

- New production recovery contract/native tests and fixture.
- New production-shaped PostgreSQL CI fixture/job.
- Extend preparation/provisioner authentication tests.
- Retain isolated recovery production-refusal regressions.
- Update `docs/operations/payload-runtime-recovery.md` and B0-09 status/acceptance documentation.

### Delivery sequence after independent critique and implementation authorization

1. Baseline and authorization contracts: state/replay rules, immutable evidence publication, read-only plan and negative tests.
2. Actual protected restoration: production fence collector/witness, protective backup, database/uploads executor and interrupted-operation reconciliation.
3. Previous-application recovery: bounded private startup, credentials/readiness/egress verification and held terminal state.
4. Qualification: native-process tests, real PostgreSQL/application CI, fresh review, `npm run verify` and `git diff --check`.

Acceptance boundary: ship only when the supported executor reaches `legacy_ready_held` in production-shaped qualification and refusal/interruption cases preserve the held state and immutable evidence. Actual live production recovery remains unavailable until separate incident-specific administrative approval exists.

Primary implementation authorization has arrived after B0 SHIP review and independent critique. Implementation may create proposals/evidence but cannot generate incident authority. Replay validates lineage, not today's clock; only first reservation and first destructive append require freshness. Operational execution still requires separate approval and is not authorized here.

## 11. Authorized FIX-FIRST refinements and native wiring

Primary accepted all three independent review findings and released the core
freeze to the same owner. These refinements preserve every preceding mandatory
constraint, the staged-index boundary and the separate incident approval gate.

### All-container resource fence

Before any relevance exclusion, inspect every Docker mount source and
network/PID/IPC `container:` reference. Revalidate the exact approved volume
receipts, then compare normalized Linux path components and resolved aliases
against their physical mountpoints/backing paths. Deny foreign mounts of the
target, its ancestors or descendants, including local named-volume bind aliases.
Read-only mounts, stopped containers, restart policies and network `none` do not
grant access or namespace-sharing exceptions. Unknown volume-driver/backing
options refuse. No substring/prefix approximation or guessed physical path is
allowed. Native CI includes actual foreign networkless binds and namespace sharing.

### Finite supported database classes

Refuse database classes absent from the supported restore-layout model before
baseline/protective measurement and again before restore: publications,
subscriptions, foreign infrastructure, event triggers, extended statistics,
custom text search, collations/conversions, operator/access-method infrastructure,
custom casts/transforms/languages, security labels, database settings and logical
replication infrastructure. Keep the existing catalog/security/metadata checks.
Do not add generic deletion or weaken the restore tuple. Native PG regression:
empty publication plus changed Portal rows must cause ZERO restore calls and
leave the rows and publication unchanged.

### Narrow authenticated readiness-credential refresh

Add only the ADMIN provisioner profile `b0-readiness-credential`, using the same
independently authenticated expected request digest, protected inputs and lease.
Allow it only at `legacy_start_pending` or `legacy_ready_held`. The closed request
has kind `production-b0-readiness-credential-v1`, purpose
`refresh-fixed-readiness-identity`, and exact decision, contract, recovery-binding,
profile, old-token and new-token hashes. It has no UID, URL, target, command,
destination path or renewed expiry field. UID derives solely from the immutable
approved readiness profile. JWT transport is bounded three-segment ASCII with
exactly one final LF; neither token nor private diagnostics are logged.

Before publication, verify the proposed token through the actual previous API's
fixed authenticated reader/upload probe, including its verified `req.user.uid`.
Append a token-free HMAC intent, compare old bytes/metadata, replace only the fixed
credential atomically with fsync, and append a token-free HMAC publication receipt.
`--check` remains read-only. An interrupted rename/receipt reconciles exact intended
bytes. Preserve incomplete intents; if their bearer expires, a separately
authenticated request based on the currently installed hash can supersede them,
bounded to 32 intents. This avoids another permanent readiness dead end. A failed
or unverified token never counts as readiness.

Incident decision, its expiry, contract, UID, B0, installation binding, recovery
lineage and destructive checkpoints are immutable. Refresh does not authorize a
new incident, repeat database/uploads restore or recreate containers. Native CI
requires an expired-token resume against the real historical API, wrong-UID and
changed-contract/lineage negatives, and interruption after actual credential
rename; final state remains `legacy_ready_held` with admission closed.

### Exact historical CI predecessor and qualification boundaries

- Select `b573a3d900c823a700c167878717bb7534bef500`, grounded in the newer read-only
  production observation in `docs/reviews/2026-11-02-portal-final-acceptance.md`.
  Retain `ce324b1b3d36fafb98270c9dfd8e62fed87d67a3` as the earlier documented baseline;
  this selection does not rewrite either observation or assert production pins.
- Build actual historical API/cron Dockerfiles from an immutable `git archive`,
  their lockfiles and pinned Node base. Record those exact inputs and resulting
  local image IDs. Do not publish images or substitute fabricated GHCR digests.
  Local IDs are component-fixture inputs, never production admission bindings.
- Preserve production environment guards: historical API/cron use
  `NODE_ENV=production` without emulator exemption. Firebase Admin cryptography
  and revoked-user lookup execute against a bounded local signed HTTPS peer on
  internal-only networks. This is explicitly NOT real Firebase qualification.
- Test actual helper private-create/receipt/start and fixed DB/API probes, cron
  bootstrap plus read-only DB authentication, wrong passwords/signature and
  unchanged reader/upload state. Resource caps apply to fixture containers/builds.
- Test actual pinned OpenSSH, forced helper and closed HTTPS responses, plus
  wrong key, replay, context/profile mismatch, overflow, 502, body/redirect and
  transport failure. Fixed path/origin/port/CA adaptations are hashed as evidence;
  no request-selected URL/command control is added. Loopback proves transport,
  not the independently provisioned external production witness/closure.
- Fresh root ADMIN processes authenticate the relocated closure and protected
  provisioning inputs, exercise FD9/path identity and HMAC journal, and resume
  commit/head/upload interruptions after expiry without renewing authorization.
  Docker/PG/application observations there remain explicit doubles, except the
  real-API credential-refresh case. Separate native components do not claim a
  fully qualified production-host composition.
- Required wrapper assertions reject skips, absent proofs, cleanup failure or
  inflated production claims. Only sanitized metadata reports are uploaded.
  Owned-resource receipts and strict cleanup survive failure; emergency cleanup
  cannot turn a failed qualification into PASS. Children receive clean environments.

**Current delivery status: fixes and native wiring authored; NOT SHIP.** Native
execution is still NOT RUN. Primary owns remote CI dispatch, fresh review and
stable snapshot `npm run verify`; this moving-tree worker does not run them.
Production profile qualification, exact-production-B0 clone evidence, independent
external closure and genuine incident approval remain separate operational gates.

## 12. Historical offline verification before the second review

Historical focused run after the first three fixes: **91 Node tests; 81 passed, 0 failed,
10 native skips on Windows**. The embedded recovery Python suite ran 15 cases:
**13 passed, 0 failed, 2 Linux-only skips**. Generated authenticated fixture
closure/fault-injection bytes compile in the offline wrapper without executing
services. Native cases have no execution result yet; the required CI mode refuses
their omission. No independent re-review of these amended bytes is claimed.

Executed checks:

```text
node --test tests/unit/payload-production-recovery.test.mjs tests/unit/payload-preparation-authentication.test.mjs tests/unit/payload-production-legacy-security-baseline.test.mjs tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-install-recovery.test.mjs
node --check tests/unit/payload-production-recovery.test.mjs
git diff --check
```

Python syntax, YAML action pins/cleanup, LF/whitespace and exact plan-copy equality
were checked with this PowerShell command (PyYAML was already available):

```powershell
@'
from pathlib import Path
import hashlib,yaml
files=list(Path('tests/fixtures').glob('payload-production-recovery*.py'))+[Path('ops/payload-production-b0-recovery.py'),Path('ops/payload-control-state.py'),Path('ops/provision-payload-candidate-trust.py')]
for p in files:compile(p.read_bytes(),str(p),'exec')
p=Path('.github/workflows/payload-production-recovery-check.yml')
doc=yaml.safe_load(p.read_text())
assert doc['permissions']=={'contents':'read'}
steps=doc['jobs']['required-native-recovery']['steps']
assert steps[0]['with']['persist-credentials'] is False
assert steps[0]['uses']=='actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
assert steps[1]['uses']=='actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
assert any(s.get('if')=='always()' and '--cleanup' in s.get('run','') for s in steps)
for p in files+[p,Path('tests/unit/payload-production-recovery.test.mjs')]:
 raw=p.read_bytes()
 assert b'\r' not in raw and raw.endswith(b'\n'),str(p)
 assert all(line.rstrip(b' \t')==line for line in raw.splitlines()),str(p)
src=Path.home()/'.opencode/plan/2026-11-02-production-prefloor-recovery.md'
dst=Path('docs/superpowers/plans/2026-11-02-production-prefloor-recovery.md')
assert src.read_bytes()==dst.read_bytes()
print('Syntax OK:',len(files),'Python files; YAML action pins and cleanup checked; LF/whitespace OK')
print('Identical plan copies SHA256:',hashlib.sha256(dst.read_bytes()).hexdigest())
'@ | python -B -
```

All these checks passed. The whole-tree `npm run verify`, native workflow,
GitHub dispatch, Docker/services/SSH, production operations, dependency installs
and index changes were not performed by this worker. Primary owns the new review
snapshot, stable verification and remote CI run. The earlier review snapshot is
historical: its hashes precede these explicitly authorized fixes.

## 13. Second FIX-FIRST review: conservative eligibility, kernel mounts, one deadline

The primary accepted the three fresh-wide-review findings and authorized these
localized amendments. All eight original constraints and the no-history-erasure
rule continue to apply; the native-schema compatibility restriction above narrows
eligibility rather than asserting past non-use. Publication and authenticated
readiness credential refresh remain the previously addressed findings.

- CMS: refuse every native schema before reservation, including empty recognized
  schemas with no protocol and unused sequences. `allow_cms` must still execute
  CMS observation. UUID article INSERT/COMMIT/DELETE does not prove non-use by
  returning the catalog/counts/sequences to their original observations. Native
  PG CI uses the actual initial migration, runtime-role INSERT and DELETE, the
  actual `execute` → `inspect` → `boundary` → `cms_observation` eligibility path,
  and asserts zero reservation/capture/restore calls. Authentication/resource
  observations are explicit component doubles there. Its positive case is a
  newly created, separately measured database before any native DDL.
- Mounts: use bounded Linux mountinfo (4 MiB/16384 records), escaped paths,
  device/root/subpath coordinates and nested mount coverage. Check identical
  process/PID1/dockerd mount namespace, single root daemon/start identity,
  no-follow path ancestry and stable observations. Refuse symlinks, ambiguous
  stacked mounts, namespace drift and filesystems outside ext4/xfs/tmpfs. No
  recursive filesystem scan. Native CI creates real host bind aliases and tests
  root/descendant/read-only/stopped foreign consumers through actual `resources()`
  discovery. Zero-effect counters are assertions pending CI, not observed native
  results. Only recorded owned mount IDs with matching namespace and physical
  coordinates are unmounted; mismatches fail cleanup and retain evidence.
- Deadline: authenticate GitHub run ID, attempt and `run_started_at` before setup.
  One absolute deadline is start + 45 minutes, including queue/setup/pulls and
  preparation. Work cutoff is minute 38; six minutes are reserved for cleanup
  and one minute for margin. Every supervised child is clamped to remaining time
  and requires a minimum-start window (application 300 s, preparation 60 s,
  other component fixtures 30 s; ordinary child calls 5 s). Ten seconds inside
  the cutoff cover termination/reaping. Clean environments carry only deadline
  metadata, never the API token. Monotonic anchoring prevents clock rollback from
  extending admitted work. Linux subreapers kill/reap detached adopted children
  after failed, idle or crashed work. The always-cleanup step uses the same
  deadline and cannot convert a failed qualification into PASS.

Portable simulated-clock tests exercise a slow child exhausting its work window,
termination, failed outcomes, completed cleanup, late-start refusal and backward
clock adjustment. Kernel mounts, PostgreSQL and detached-process proofs remain
CI-only and NOT RUN locally. The earlier §12 counts/commands are historical, not
evidence for these new bytes. Fresh focused results are recorded in the handoff;
primary still owns the independent review snapshot and native CI qualification.

### Fresh offline verification of the second-review changes

Fresh focused run: **91 Node tests: 81 passed, 0 failed, 10 native Windows skips**.
The embedded Python suite now has **19 cases: 17 passed, 0 failed, 2 Linux-only
skips**, including the deadline, mount identity/cleanup and eligibility regressions.
These counts come from a new run, not the historical §12 execution. Native zero-
effect/cleanup claims remain unexecuted assertions until the dedicated CI passes.

```text
node --test tests/unit/payload-production-recovery.test.mjs tests/unit/payload-preparation-authentication.test.mjs tests/unit/payload-production-legacy-security-baseline.test.mjs tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-install-recovery.test.mjs
node --check tests/unit/payload-production-recovery.test.mjs
git diff --check
```

Fresh syntax/YAML/pin/line-ending/plan-equality command (PowerShell):

```powershell
@'
from pathlib import Path
import hashlib,yaml
files=list(Path('tests/fixtures').glob('payload-production-recovery*.py'))+[Path('ops/payload-production-b0-recovery.py'),Path('ops/payload-control-state.py'),Path('ops/provision-payload-candidate-trust.py')]
for p in files:compile(p.read_bytes(),str(p),'exec')
p=Path('.github/workflows/payload-production-recovery-check.yml');doc=yaml.safe_load(p.read_text())
assert doc['permissions']=={'contents':'read','actions':'read'}
job=doc['jobs']['required-native-recovery'];assert job['timeout-minutes']==45
steps=job['steps'];assert 'run_started_at' in steps[0]['run'] and 'run_attempt' in steps[0]['run']
assert steps[1]['uses']=='actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
assert steps[1]['with']['persist-credentials'] is False
assert steps[2]['uses']=='actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
assert any(s.get('if')=='always()' and '--cleanup' in s.get('run','') for s in steps)
for p in files+[p,Path('tests/unit/payload-production-recovery.test.mjs')]:
 raw=p.read_bytes();assert b'\r' not in raw and raw.endswith(b'\n'),str(p)
 assert all(line.rstrip(b' \t')==line for line in raw.splitlines()),str(p)
src=Path.home()/'.opencode/plan/2026-11-02-production-prefloor-recovery.md';dst=Path('docs/superpowers/plans/2026-11-02-production-prefloor-recovery.md')
assert src.read_bytes()==dst.read_bytes()
print('Python syntax:',len(files),'files; YAML deadline/actions/cleanup; LF/whitespace: passed')
print('Identical plans SHA256:',hashlib.sha256(dst.read_bytes()).hexdigest())
'@ | python -B -
```

All listed checks passed. No local native Linux/Docker/mount/PG/SSH execution,
dependency installation, delegation, index mutation, commit, GitHub/Linear action
or production operation was performed. Stable whole-tree verification remains
with primary. **NOT SHIP; return these amended bytes for fresh review and CI.**

## 14. Third FIX-FIRST review: retained container binds and interrupted acquisition

These localized amendments address the latest P1/P2 findings. All eight original
constraints, strict refusal of every native CMS schema, immutable incident bindings,
witness/grants/ADMIN contracts and the no-history-erasure rule remain mandatory.

- P1: a current host `Mounts.Source` and repeated host passes cannot establish a
  live container's retained backing. Before relevance exclusion, inspect bounded
  `/proc/<pid>/mountinfo` (4 MiB/16384 entries), compare effective device/root
  regions, pin process/root/mount-namespace descriptors, verify container cgroup
  membership and recheck PID start, root, namespace, table, no-follow ancestry and
  Docker identity/StartedAt. Unprovable or changed observations refuse. Preserve
  read-only/network-none and stopped-consumer fencing; stopped nonconsumers require
  PID zero plus stable Docker identity and nonprotected current sources. Refuse
  privileged/SYS_ADMIN foreign live containers and unsupported layouts. Effective
  layouts are ext4/xfs/tmpfs, enumerated pseudo-filesystems, and root overlay only
  with Docker GraphDriver overlay2/overlayfs; other environments remain unqualified.
- P2: the CI-only mount helper uses documented libc `open_tree`, `mount_setattr`,
  `statx` and `move_mount`, compiled against the runner's own headers. Create a
  private detached clone; record ordinary and non-reused `STATX_MNT_ID_UNIQUE` IDs,
  boot identity, namespace, coordinates and source/target inode identities in an
  atomic fsynced `phase: prepared` receipt BEFORE attachment. A prepublication
  crash destroys an invisible clone; a post-attach crash can be cleaned using the
  prepared receipt without a completion event. Both normal and emergency cleanup
  require exact ownership, including unique ID and boot identity; never adopt a
  same-source/path replacement or an ID-null receipt. Ordinary guarded `umount`
  remains the only detach operation; no lazy/force fallback.
- Supported CI prerequisites: Linux 6.8 kernel/headers for non-reused mount IDs,
  glibc 2.36+ wrappers, an existing `/usr/bin/cc` and mount capability. Unsupported
  prerequisites fail before attachment. No guessed syscall numbers, Python kernel
  struct layouts, dependency installation or host workflow changes are introduced.
  ABI references: [open_tree(2)](https://man7.org/linux/man-pages/man2/open_tree.2.html),
  [mount_setattr(2)](https://man7.org/linux/man-pages/man2/mount_setattr.2.html),
  [move_mount(2)](https://man7.org/linux/man-pages/man2/move_mount.2.html),
  [statx(2)](https://man7.org/linux/man-pages/man2/statx.2.html).
- Required native regressions: start a foreign network-none container through a
  protected host alias, unmount/rebind the alias, prove the container still reads
  the protected bytes, and require actual `resources()` to refuse before effects,
  including read-only cases. Kill acquisition with SIGKILL after attach/before
  completion; exercise normal and fresh-process emergency cleanup from prepared
  receipts. Replace a mount with an independently receipted same-source/path mount;
  old receipts must refuse both cleanup paths while leaving the replacement intact.
  Report validation requires these proof fields and the C helper source hash.
- Keep the same authenticated absolute 45-minute deadline: work cutoff at minute
  38, six-minute cleanup reserve and one-minute margin. Compiler calls and all new
  child processes consume that original budget; they do not create fresh windows.

### Fresh offline evidence and remaining gate

The five-file focused command and Node syntax command listed in §13 were rerun:
**91 Node tests: 81 passed, 0 failed, 10 native Windows skips**. The embedded recovery
Python suite now has **22 cases: 20 passed, 0 failed, 2 Linux-only skips**. Portable
tests cover retained effective regions, Docker/PID restart drift, kernel snapshot
revalidation, pre-attach receipt ordering, prepared-receipt cleanup, reused ordinary
ID with a different unique ID and boot mismatch. Offline checks also construct and
compile the actual acquisition/crash/emergency/replacement child Python strings.

Native kernel/container behavior and C compilation have **NOT RUN**. Source wiring
and portable doubles are not native proof. Primary owns fresh independent review,
remote native CI and stable whole-tree `npm run verify`. Exact production B0 clone,
real Firebase, independent external closure and authentic incident approval remain
separate operational gates. **NOT SHIP; hand back these exact unstaged bytes.**

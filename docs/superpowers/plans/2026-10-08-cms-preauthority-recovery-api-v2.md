# CMS Preauthority Recovery and API v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate and publish a session-v2-compatible API candidate, implement genuine four-store backup/recovery for initial Payload operation, and qualify that control for installation on the prepared VPS.

**Architecture:** Keep the existing `payload-v1` release/backup format and distinguish the initial `preauthority` phase in signed operational state. Portal remains the legacy content authority; CMS stores identity projections/preferences but does not become the News writer. Publish all three candidate images without triggering production deployment, then validate actual PostgreSQL/storage recovery before host activation.

**Tech Stack:** Node 24 test tooling, Node-18-compatible shared API code, Express, PostgreSQL 16, Firebase Auth Emulator, Payload 3.90.2, Bash/Python host tooling, Docker Compose, GitHub Actions and GHCR.

## Global Constraints

- Preserve authority `legacy`, epoch `1`; do not freeze existing legacy editorial writes outside a coordinated backup/restore window.
- Native CMS protocol status must be `absent`; coverage is not applicable, not zero. Protocol-present targets are unsupported by this initial adapter.
- Preserve all six native Payload migrations and their historical snapshots.
- Keep `cms-worker` stopped in deploy, rollback, backup resume and restore paths.
- No fake adapter, fabricated seal, disabled security scan, or production restore used as a test.
- Use the existing shared `runtime/deploy.lock`; retain its inode and inherited descriptor.
- Preserve unrelated draft/spec files and prior failed-run evidence.
- Linux shell/Docker files use LF. Secrets are generated/stored privately and never printed.
- The local Docker engine is unavailable; actual Docker acceptance runs in disposable Linux CI infrastructure.
- Task 3 authorization covers bounded code changes and a real disposable CI acceptance after review. This handoff does not authorize VPS activation, production writes, commit, push, merge, deployment, or PR creation.

## Task 1: Publish-only candidate and actual API-v2 acceptance

**Files:**
- Modify `.github/workflows/ci.yml` and `tests/unit/cms-image-pipeline.test.mjs`.
- Create `scripts/test-editorial-admin-session-integration.mjs`.
- Create `tests/unit/editorial-admin-session-integration-guard.test.mjs`.
- Update `docs/operations/deployment.md` with exact candidate usage and acceptance limits.

**Interfaces:**
- New boolean workflow input `publish_candidate_only`, default false, mutually exclusive with `cms_image_only`.
- Separate artifact `payload-release-candidate` containing `candidate.json`:

```json
{
  "schemaVersion": 1,
  "commit": "40-character checked-out GITHUB_SHA",
  "runId": "GITHUB_RUN_ID",
  "runAttempt": "GITHUB_RUN_ATTEMPT",
  "images": {"api": "immutable API reference", "cron": "immutable cron reference", "cms": "immutable CMS reference"}
}
```

The descriptions above specify validated string fields, not deployable example digests. Runtime values must come from actual pushes in this one run. All three references must match their respective `ghcr.io/ownerinc/ownerinc-portal-*` repositories and `@sha256:[0-9a-f]{64}`.

- Integration runner accepts only explicit disposable test inputs and the built API image; it rejects production origins, credentials fallbacks, and non-demo Firebase project IDs before starting services.
- Runner creates its own unique fixture identity and only acts on that fixture. It produces a redacted JSON report and nonzero exit on a failed assertion.
- CMS readiness may use a narrowly scoped `/editorial/ready` fixture. This tests the API session contract, not real CMS startup/browser acceptance.

- [ ] Add guard-matrix tests before changing publication conditions. Assert branch candidate dispatch publishes three images and skips deploy; CMS-only retains its contract; conflicting flags fail before publication; ordinary main behavior is preserved.
- [ ] Implement the runner using the actual API image, a disposable Portal PostgreSQL database and Firebase Emulator. Reuse existing migration/provisioning contracts and project dependencies rather than adding a database/auth mock.
- [ ] Use real HTTP to issue (`POST /api/cms/v2/session`), resolve (`GET`), resolve privately (`POST /api/internal/editorial/admin/session/resolve`) and revoke (`DELETE`) a synthetic session. Assert HTTP 201/200/204 and stale-cookie 401, secure host-only cookie attributes, database hash-only storage, runtime-role permissions, forced expiry of the fixture row, permission reload and unchanged authority.
- [ ] Wire integration after image build and before candidate publication. Upload redacted failure evidence without tokens, cookies, user credentials or database URLs.
- [ ] Run offline checks:

```sh
node --test tests/unit/cms-image-pipeline.test.mjs tests/unit/editorial-admin-session-integration-guard.test.mjs
npm run verify
git diff --check
```

- [ ] Obtain fresh read-only review, commit the bounded task, push the feature branch and dispatch:

```sh
gh workflow run ci.yml --repo OWNERINC/portal_ownerinc --ref feat/payload-cms-final -f publish_candidate_only=true
```

- [ ] Verify the run commit, integration success, three scans, publication steps, artifact digests and skipped deployment. Preserve a failed run and fix its actual cause before rerunning.

## Task 2: Implement the preauthority operational adapter

**Files:**
- Create `ops/payload-control` as a thin executable host entrypoint.
- Create `ops/payload-control-state.py` for strict proof/state parsing and signing.
- Create `ops/payload-control-runtime.py` for bounded Docker/PostgreSQL inspection.
- Modify `ops/payload-operations-guard.sh`, `scripts/payload-operations.sh`, `ops/deploy-from-ci.sh`, `scripts/payload-release.sh`, and installer sources only where the contract requires wiring.
- Extend `tests/unit/payload-operations.test.mjs`; create `tests/unit/payload-control.test.mjs`.

**Interfaces:**
- Preserve guard CLI `(action, absoluteRelease, optionalEvidencePath)`.
- Support verbs `release-preflight`, `close-admission`, `quiescence-proof`, `backup-metadata`, `restore-preflight`, `prepare-restore`, `portal-restore-intermediate`, `verify-restored`, `verify-release`, `rollback-check`, `open-admission` only within the supported preauthority phase.
- Reject other authority modes, epochs, protocol-present/mixed catalogs and unsupported operations explicitly.
- Canonical JSON proofs bind phase, release images/SHA, source database system identifiers/OIDs, verified migrations, protocol absence and SHA-256/size of all four backup artifacts. They contain no credentials or content bodies.
- Sign canonical bytes with a private host key; persist atomic state with sequence and previous-state hash. Never restore the host key/state from a data backup or present this proof as a cutover seal.
- Restore intent binds target identities/volumes and the explicit Portal-restored/grants-reverified stages. A fresh clone legitimately differs from source identities; compare the target with its reserved intent immediately before destructive operations.

- [x] Add tests rejecting unknown/duplicate proof fields, bad signatures, modified artifacts, changed target identities/volumes, unsupported phases and worker admission.
- [x] Implement cold preflight that verifies the actual Portal floor/authority and absence of unexpected CMS containers/volumes without connecting to a nonexistent CMS database.
- [x] Implement post-migration catalog checks against the expected native schema and six migrations, not an arbitrary live snapshot blessed as canonical.
- [x] Align operational Compose invocations with the receiver's regular and Payload production overrides. Explicitly hold the worker in all supported paths.
- [x] Implement real quiescence checks after writers stop; maintain admission closure on failure. Portal legacy writers are allowed while live, but none may remain active during capture/restore.
- [x] Bind artifact hashes only after capture completes. Before restore, validate manifest, signature, archive paths/types and target lease. Recheck target binding at the destructive boundary, then verify restored database content, sequence state and storage hashes before reopening.
- [x] Run meaningful offline tests.
- [x] Obtain a fresh independent read-only review before enabling actual disposable restore acceptance. Review gate closed with accepted Task 2 baseline commit `247fac2`.

## Task 3: Disposable four-store recovery acceptance

**Files:**
- Create `scripts/test-payload-preauthority-recovery.mjs`, `scripts/integration/payload-preauthority-fixture.mjs`, `scripts/integration/payload-preauthority-fixture.compose.yml`, and `tests/unit/payload-preauthority-recovery-guard.test.mjs`.
- Modify `ops/payload-control-inventory.py`, `ops/payload-control-runtime.py`, `ops/payload-control-state.py`, `ops/prepare-cms-infrastructure.sh`, `scripts/payload-operations.sh`, and focused tests only to add strict protected-inventory identity, trust-transfer and destructive-boundary support required by the real fixture.
- Modify `.github/workflows/ci.yml`, `docs/operations/payload-runtime-recovery.md`, and this plan to document candidate publication versus recovery qualification and the actual evidence boundary.
- Never add service startup to `npm run verify`; preserve unrelated draft/spec files and Task 2 catalog behavior.

**Interfaces:** the harness accepts only the three immutable GHCR image digests published in the same CI run and a checked-out SHA/run identity. It creates random disposable source/target project names, four project-labeled volumes per host, unique roots/locks, and a 0600 inventory. The source inventory identity is explicitly authorized in target inventory before copying the fixture-only host signing key; that key is not a backup artifact. Production and fixture paths are loaded through the same adapter and strict validations. Success requires actual coordinator/adapter capture/restore plus independent database (including sequence) and file-tree comparisons.

- [x] Implement synthetic Portal identity, poll and legacy announcement seed, permitted CMS identity/preferences, and Portal/CMS media and staging files.
- [x] Implement coordinated four-store backup and target restore through the inherited shared-lock coordinator and real Task 2 adapter.
- [x] Implement independent native/catalog, data/sequence and file-tree comparisons, requiring `authority=legacy/1`, protocol absence and worker absence.
- [x] Implement tampered dump/proof/manifest, unsafe archive/schema, wrong immutable image digest, migration mismatch, weak native constraint, extra materialized view and target-volume lease-change cases. The harness asserts rejection before restore, detects unchanged target catalog/data/files, and explicitly cleans fixture-only DDL after evidence is checked.
- [x] Implement a repeated actual capture/restore after a permitted synthetic live edit.
- [x] Order candidate CI as build/test/security scans → publish all three same-SHA digests → run recovery on those exact digests → emit a separate qualified manifest only after a passing report. Candidate digest capture is unqualified, the report is redacted, and recovery stays outside `npm run verify`.
- [ ] Run `npm run verify`, `npm run security`, and `git diff --check`; obtain a fresh read-only review before the real Docker acceptance run.
- [ ] Run the candidate-dispatch CI recovery after review. Preserve its redacted report artifact and actual run/SHA/image digests; only then add the report hash and outcome to `docs/reviews/` without including private fixture content. Local Docker is unavailable, so no real recovery pass is claimed here.

## Task 4: Install validated control and compatible release on the VPS — separate authorization required

**Files:** reviewed adapter/helper artifacts, prepared production overlay, private operational state and the selected release manifest. Update `docs/reviews/2026-10-08-cms-vps-infrastructure-preparation.md` with subsequent evidence without overwriting its historical result.

- [ ] Under the deployment lock, recheck active release, Portal migration/grants, authority, existing volumes and prepared configuration. Back up replaced host artifacts privately.
- [ ] Install the reviewed adapter and helpers with protected ownership/modes. Confirm installed hashes and retain the previous scripts for rollback.
- [ ] Select a complete immutable three-image candidate with traceable source/CI acceptance. Do not splice digests and claim a common source SHA.
- [ ] Execute the reviewed coordinated first-install flow, native CMS provisioning/migrations and worker hold. No import finalizer or authority transition is part of this task.
- [ ] Verify API and CMS readiness, public proxy response, session-v2 availability and the accepted login/session contract. Confirm authority remains legacy and the worker remains stopped.
- [ ] Report exactly what is running, backup/recovery acceptance evidence, release/image identities, and any remaining editorial limitations. Do not report News CRUD/cutover as completed by admin availability.

## Acceptance boundary

Completion requires both candidate API evidence and actual four-store recovery evidence, followed by a verified installation. A green unit suite, a readiness response, an empty adapter, or a signed JSON file alone is insufficient. If an external dependency blocks execution, retain the evidence and state the exact uncompleted step rather than calling preparation deployment.

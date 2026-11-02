# Production B0 capture and acceptance

## Steps
- [x] Independently investigate and cross-critique the missing boundary; obtain design approval.
- [x] Implement production capture-only and immutable acceptance with runtime and signed-state enforcement.
- [x] Support authenticated administrative provisioning and receipt-based continuation.
- [x] Document exact-B0 isolated qualification and add portable/native regression coverage.
- [ ] Run verification, obtain fresh independent review, and qualify in CI before operational use.

## Approved design and authority

The user approved this design on 2026-11-02. The user will accept the actual
exact-B0 restoration evidence through the independently authenticated
administrative VPS channel. That future decision permits beginning migrations
for at most 60 minutes after acceptance. This design approval is not acceptance
of a backup that has not yet been captured or tested.

Use administrator-only capture and acceptance, retaining the restricted receiver
apply operation as continuation. Capture must finish at signed `reserved`, with
CMS cold, writers fenced/stopped, admission closed, legacy authority and worker
hold. Release FD9 while waiting and reacquire/revalidate on every invocation.

Acceptance is a separate versioned immutable administrative document, provisioned
through an explicitly supported extension of the existing authenticated trust
channel. Root ownership and caller-provided hashes alone do not establish
authority. Do not add a signer, export the production HMAC key, or modify the
preparation approval body after reservation.

Bind acceptance to the exact install binding, held checkpoint, receipt,
preparation authority, inventory, B0 proof/manifest/artifacts, previous images,
qualification evidence and procedure revision. Record its authenticated origin
and digest in signed state. Compare the held head atomically at acceptance;
later continuation validates its origin rather than requiring an unchanged head.

Original candidate authorization remains fresh at reservation. Its expiry and
nonce are never renewed. The separate acceptance window must be checked
atomically at the first migration-start checkpoint. Once that checkpoint is
durable, retain exact continuation semantics, including ambiguous command-start
crashes. An expired decision before that checkpoint blocks migration; no silent
replacement, renewal or automatic retry is authorized by this design.

## Implementation boundaries

1. `ops/payload-control-state.py`: explicit production contract discrimination,
   strict acceptance validation/persistence, atomic migration-start guard.
   Historical production journals remain readable but cannot acquire implicit
   acceptance or bypass the new gate. Preserve isolated contracts.
2. `ops/payload-control-runtime.py`: supported capture-only operation; existing
   production apply must refuse cold/unaccepted state before migrations or CMS
   provisioning. Revalidate artifacts, protected authority and physical fences.
3. `ops/prepare-cms-authenticated.py`: authenticated receipt-based capture and
   acceptance entrypoints, fixed protected decision location, truthful held
   result, existing authenticated apply continuation.
4. `ops/provision-payload-candidate-trust.py`: supported independently approved
   acceptance provisioning, protected immutable destination, exact bytes and
   correspondence; no arbitrary executable/evidence path from receiver requests.
5. `.github/workflows/payload-install-production.yml` and narrowly necessary
   dispatch contracts: separate admission from continuation using the existing
   receipt. Never re-admit the original nonce to resume. Preserve all provenance
   checks and protected Environments.
6. Relevant state/runtime/preparation/provisioning/workflow tests and native CI
   wiring; `docs/operations/deployment.md` and
   `docs/operations/payload-runtime-recovery.md` for operator procedures.

No production mutation, Docker Desktop startup, new signer, automatic rollback,
route release, worker enablement or generic recovery orchestrator belongs to
implementation. Preserve the already-reviewed PDF/manual-deploy changes.

## Exact-B0 qualification

An operator-driven supported isolated restoration procedure is sufficient for
this boundary; an automated clone executor is not mandatory. It must authenticate
the reserved signed B0 and exact artifacts before and after transfer, use fresh
isolated targets, verify schema/data/security/owners/ACLs and upload fingerprints,
start the exact previous application images, verify private authentication and
readiness, contain external effects, and retain independently reviewed evidence.
Do not repurpose test-only recovery helpers or substitute a generic legacy backup.
This pause and acceptance do not waive any separate B0 recovery-programme gate.

## Verification and failure cases

Require capture to produce zero migration/provision/floor effects. Reject cold
apply, missing/forged/mismatched acceptance, stale held head, changed artifacts,
candidate/receipt/inventory substitution and expiry before migration start.
Cover exact duplicate capture/acceptance, conflicting decisions, interruptions,
fresh-process continuation, FD9 contention/substitution, source/fence drift,
expired original authorization after reservation and nonce-marker reaping.
Preserve partial evidence; never silently recapture or rewrite signed history.

Run focused portable tests, `git diff --check`, `npm run verify`, fresh read-only
review and actual Linux/root qualification in CI. Local Windows skips are not
native evidence. Changed pinned ops bytes require a fresh authenticated
preparation closure and a new final candidate before any operational use.

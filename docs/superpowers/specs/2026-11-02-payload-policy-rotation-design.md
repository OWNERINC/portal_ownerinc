# Administrative Payload policy-only rotation

## Decision and authorization

The user approved authenticated policy-only rotation, replacement of the old
approved revision by the final qualified revision, and atomic policy publication
with no automatic closure rollback. The user subsequently delegated remaining
technical decisions to the primary session and an Astra Max advisor and switched
to Build. Two independent read-only investigations and one cross-critique round
selected the single-use fail-stop design below. No further preference gate is
required for this bounded implementation.

## Goal and scope

Add `--profile policy-rotation` to `ops/provision-payload-candidate-trust.py`.
The only authority-bearing file replaced is
`/etc/ownerinc/payload-candidate/production-policy.json`. Private snapshots and
staging evidence are additional permitted writes. Implementation ownership is
the provisioner, `tests/unit/payload-candidate-trust-provisioning.test.mjs`,
`docs/operations/deployment.md`, and the isolated native test workflow
`.github/workflows/payload-policy-rotation-check.yml`, plus these design/planning
documents.

Preserve both existing provisioning profiles and their no-replace publication
helpers. Preserve all four admission TOOL_FILES and `.github/workflows/ci.yml`
byte-for-byte. Do not create admission records, install receiver/wrappers, change
runtime, databases, Compose, images, roles, routing, scheduling, authority, or
perform private install, production restore, deploy, or cutover.

The final candidate is `a7b7f35792ca5c7b3f5db82094f406b56912ba70`, run
`41379393576`, attempt `1`. Its workflow SHA-256 is
`c74fdc72ce452f1072336b50e0b71d81c49fa632ca9cddcc622026c7b9176e29`.
The observed old policy digest is
`bfd564a5e8c3e99badacdafe47a85daee4aa07b6ca3f576031915821e2216aa0`, approving
`24ccb9d5186cf83e30c18ddcdea8c247f67a44dc`. Those observations are not hardcoded
authorization inside the general rotation mechanism. The eventual administrative
approval must bind the exact final revision and freshly authenticated policy bytes.

## Closed approval and input contract

Exact approval keys:

- `schemaVersion`: integer 1 (booleans rejected).
- `kind`: `ownerinc-payload-policy-rotation-approval-v1`.
- `environment`: `production`.
- `repository`: `OWNERINC/portal_ownerinc`; `repositoryId`: string `1308080511`.
- `workflow`: `.github/workflows/ci.yml`; `workflowId`: string `317709204`.
- `rotationId`: 64 lowercase hexadecimal characters, independently issued once.
- `issuedAt`, `expiresAt`: integer Unix seconds, with
  `0 < expiresAt - issuedAt <= 3600`.
- `fromPolicySha256`, `toPolicySha256`: distinct 64-character lowercase digests.
- `candidate`: exact keys `commit`, `runId`, `runAttempt`, `approvalSha256`,
  `inventoryIdentity`. Commit is 40 lowercase hex; run and attempt are nonzero
  decimal strings of at most 20 digits; hashes are 64 lowercase hex.
- `targetRevision`: exact keys `commit`, `workflowSha256`; commit equals
  `candidate.commit` and the workflow hash is 64 lowercase hex.

Use existing strict JSON and protected-read primitives. Authenticate the raw
approval bytes against independent `--approval-sha256`; do not canonicalize input
bytes. The candidate approval digest is the existing preparation-binding digest,
not the outer rotation approval digest. Candidate fields are administrative audit
context, not independently established CI provenance or live inventory proof.
Rotation does not renew candidate authorization or enforce a run-exclusive policy.

Bundle layout is exactly one root:root 0600 single-link regular file named
`production-policy.json`, whose raw digest equals `toPolicySha256`. Preserve
canonical-path, bounded-read, protected-ancestry, owner/mode and no-symlink checks.
Both policies must satisfy the existing closed schema and exact official IDs.
Every field except `approvedRevisions` must remain semantically identical. Target
revisions must equal `[targetRevision]`; its commit must not already be approved.
An unchanged revision list or bytes-only rewrite is not an eligible rotation.

Keep the exact existing CLI envelope and cardinality, adding only the new profile:

```sh
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C \
  /usr/bin/python3 -I -S -B /root/approved/provision-payload-candidate-trust.py \
  --profile policy-rotation --check \
  --approval /root/approved/rotation.json \
  --approval-sha256 "$INDEPENDENT_APPROVAL_SHA256" \
  --bundle /root/approved/rotation-bundle
```

Apply replaces `--check` with `--apply`. Require Linux, root uid/euid/gid/egid,
isolated/no-site/no-bytecode Python, exact clean environment, and the installed
policy's canonical Python executable. No destination overrides or production test
hooks. Import Linux-only locking support inside the rotation path.

## Concurrency contract

Open the existing protected `STATE_ROOT/records` directory using
`O_RDONLY | O_DIRECTORY | O_NOFOLLOW` and acquire nonblocking exclusive flock.
Require root:root 0700, protected ancestry, and stable descriptor/path identity.
Hold the lease throughout either action, including final checks. Never lock the
replaceable policy inode or assume deployment/incoming locks cover registration.

This is cooperative exclusion. The unchanged registrar does not acquire this
lease itself. Administrative registrar launches must hold this same directory
lease for their entire invocation, before Node starts. An exclusive administrative
window must drain any earlier unwrapped invocation. Empty directories, missing
wrappers and process listings do not prove that prerequisite. If it is not
established, remote apply is operationally blocked; implementation must not claim
that advisory flock excludes direct unwrapped root writers.

Before and immediately before actual replacement, require `records` to contain
no entries whatsoever, including dotfiles, pending files, links and directories.
Repeat this check after replacement and at the final successful return boundary.
Never delete or adopt records. Old records remain bound to the old policy digest.

## Durable single-use evidence

Require existing protected `STATE_ROOT/trust-snapshots`. Reserve exclusively:

`trust-snapshots/policy-rotation-<rotationId>/`

Any existing pathname consumes the ID, even an unsafe entry, an empty directory,
partial evidence, or different approval bytes. An apply must never resume,
complete, repair, fsync-reconcile or delete an existing reservation. Create the
directory 0700 and immediately fsync its parent before proceeding. An uncertain
reservation failure is operationally spent. External records of issued/attempted
IDs must also prevent reuse: a crash before parent fsync can lose a directory
entry, which filesystem inspection alone cannot distinguish from an unused ID.

Evidence files are root:root 0600 regular single-link files:

1. `approval.json`: exact authenticated approval bytes.
2. `policy.before.json`: exact authenticated active policy bytes.
3. `policy.after.json`: exact authenticated bundle policy bytes.
4. `manifest.json`: exact keys `schemaVersion: 1`,
   `kind: ownerinc-payload-policy-rotation-prestate-v1`, `rotationId`,
   `approvalSha256`, `fromPolicySha256`, `toPolicySha256`.
5. `completion.json`: only after successful replacement and postverification;
   exact keys `schemaVersion: 1`,
   `kind: ownerinc-payload-policy-rotation-completion-v1`, `rotationId`,
   `manifestSha256`, `activePolicySha256`.

All hashes bind raw stored bytes, never reconstructed JSON. Cross-check all
identities with the authenticated approval and directory basename. Publish the
manifest after its three referenced files; fsync evidence and directories before
replacement. Completion binds the raw manifest and target policy digest. Preserve
failed staging evidence. Unexpected retained files are never trusted as evidence;
consumed inspection must conservatively classify them, not clean them up.

## Fresh check and apply

Both actions acquire the lease and authenticate inputs anew. A fresh check verifies
eligibility and returns without creating, writing, renaming, repairing or fsyncing
anything. It neither consumes an ID nor grants reusable apply authority.

Apply performs these ordered steps:

1. Authenticate approval and bundle, verify initial freshness
   (`issuedAt <= now < expiresAt`), active raw source digest and restricted delta.
2. Verify the four installed admission files and all four executable hashes,
   explicitly including `gitRemoteHttps`, plus protected metadata and interpreter.
3. Require empty registry, valid existing snapshot parent and unused rotation ID.
4. Durably reserve and publish exact prestate evidence.
5. Create an exclusive same-directory 0600 policy temporary; write, flush, fsync
   and verify its bytes and metadata.
6. Reauthenticate original inputs, closure, old policy, snapshot completeness,
   lease/path identities, empty registry and a newly sampled freshness check.
7. Mark phase `swap-attempted` immediately BEFORE calling atomic replacement.
   Use a dedicated routine; never weaken existing no-replace helpers, unlink
   the policy first, or write it in place.
8. Fsync the policy parent; verify active target bytes/metadata, full closure,
   empty registry and lease identity.
9. Durably publish and verify completion evidence, then repeat nonmutating
   policy/closure/registry/lease checks before success is announced.

No network, GitHub authentication, bundle code execution, live runtime baseline
validation or deployment authorization is performed by this profile. Successful
reports must state these boundaries and `deploymentAuthorized: false`.

## Failure and consumed-check behavior

Existing failure exit code remains 2. Before replacement is attempted, report that
this invocation did not attempt policy replacement; private evidence may have
been written. From the swap-attempt boundary onward, EVERY failure, including
lease finalization and completion persistence, is reconciliation-required.
Never infer old-policy preservation from a nonzero exit; never auto-rollback.

Use a bounded vocabulary including `rotation_lock_busy`, `rotation_id_consumed`,
`rotation_approval_not_current`, `rotation_policy_mismatch`,
`rotation_delta_not_allowed`, `rotation_closure_mismatch`,
`rotation_registry_not_empty`, `rotation_context_changed`,
`rotation_preswap_io_failed`, `rotation_reconciliation_required`,
`rotation_evidence_conflict`, and `rotation_evidence_unsafe`. Existing strict-input
and protected-filesystem codes remain available before the swap-attempt phase.

Consumed `--check` authenticates supplied approval bytes and schema first, then
branches BEFORE freshness, bundle eligibility, active-source or installed-closure
requirements. It is observational even when expired, always ineligible, exit 2,
and never repairs, fsyncs, deletes or resumes anything. Its closed JSON report has
`schemaVersion: 1`, `kind: ownerinc-payload-policy-rotation-check-v1`,
`status: consumed`, `code`, `rotationId`, `eligible: false`, `approvalFresh`,
`snapshotState`, `activePolicy`, `observedPolicySha256`, `mutated: false`,
`deploymentAuthorized: false`.

Snapshot classifications: `partial`, `prestate-valid`, `completion-recorded`,
`conflict`, `unsafe`. Invalid/unsafe completion must not be ignored. Independently
classify active policy as `from`, `to`, `other`, or `unknown`; return a digest only
after a protected stable read, otherwise null. Completion-recorded is historical
evidence, not current eligibility or a renewed durability acknowledgement.

After an interrupted attempt, reconcile retained evidence. If old policy remains,
only a fresh independently authenticated approval and fresh ID may authorize
another operation. If target is active, do not repeat rotation; unresolved
durability/completion requires separate administrative reconciliation.

## Source separation and verification

The provisioner is not an admission TOOL_FILE, but IS in the preparation closure.
The new administrative program must be reviewed and authenticated independently.
Preserve the historical preparation source closure from the final candidate,
including its original provisioner bytes. Changing preparation `source` changes
its candidate approval binding; changing only `admission` does not. Do not assemble
the old preparation approval's bundle from new branch HEAD. The old candidate CI
run cannot qualify new rotation code.

On 2026-11-02 the primary independently verified the preserved preparation body
against binding `1877ed16868b94d0f9eb1274655833372b005f5204ef7b313ba27758bce47cd2`:
all 16 archived source files match their approved hashes and the exact final
candidate Git blobs. The original provisioner's SHA-256 is
`8b90482c93f924920ba21ae2dd1b6d192f4475bdcfc9dd6eea2dd95f37622f88`.
This resolves source selection; it does not authorize executing new administrative
bytes or establish an exclusive host window.

Portable tests cover strict contracts, read-only checking, delta restrictions,
closure/registry drift, single-use consumption, evidence cross-bindings, expiry,
phase-aware failures and unchanged original profiles, with doubles labelled.
Extend the existing trust test file's mandatory native Linux/root coverage without
changing `ci.yml` bytes: real metadata, directory flock between processes,
cooperative registrar lifetime, explicitly unwrapped-writer limitation, atomic
replacement and concurrent readers, fsync ordering and retained failure evidence.
Distinguish injected failures from actual power-loss qualification.

Primary inspection found that the existing native step in `ci.yml` runs only for
candidate-only dispatches on main. Add the isolated workflow above to exercise
the same mandatory native trust suite on relevant pull requests and explicit test
dispatches. Use read-only repository permission, pinned checkout/setup-node actions,
no persisted credentials, and disposable root fixtures on a hosted Linux runner.
It must have no deployment, publication, host connection, secrets or environment
approval inputs. This additional workflow qualifies administrative code before
merge without changing the qualified candidate workflow or rerunning publication.

Run focused admission/provisioning/preparation/pipeline regressions, the native
trust suite in a disposable Linux root sandbox, `npm run verify`, and
`git diff --check`. Inspect actual diff and obtain fresh independent review.
Remote apply additionally requires a proven cooperative administrative window and
fresh externally authenticated authorization; it is not an effect of this patch.

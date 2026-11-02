# Payload Policy Rotation Implementation Plan

**Goal:** Implement the approved single-use policy-only administrative rotation.

**Architecture:** Extend the existing standalone provisioner with a separate
profile and profile-specific helpers. Keep its original publication helpers and
both existing profiles unchanged. A protected records-directory lease coordinates
cooperating administrators; durable single-use evidence precedes atomic policy
replacement.

**Tech stack:** Python standard library on Linux, dependency-free Node test runner,
native Linux root fixtures, existing CI test entrypoint.

## Global constraints

The complete contract is
`docs/superpowers/specs/2026-11-02-payload-policy-rotation-design.md`.
Every step below inherits that contract, including the 3600-second maximum,
single-use IDs, honest cooperative-lock limitation, separate administrative source,
no automatic retry/reconciliation/rollback, and exact evidence schemas.

Implementation ownership is limited to:

- `ops/provision-payload-candidate-trust.py`
- `tests/unit/payload-candidate-trust-provisioning.test.mjs`
- `docs/operations/deployment.md`
- `.github/workflows/payload-policy-rotation-check.yml` (primary-owned native gate)

Preserve all four pinned admission files and workflow bytes. Linux-only imports
must not break Windows loading. Keep Node 18 compatibility for shared test code.
Use the existing fixture patterns; label metadata/syscall doubles explicitly.
No production writes, record registration, installation or deployment in this plan.

## Steps

- [x] Implement and test strict rotation contracts and observational checks.
- [ ] Implement and test single-use application and native filesystem behavior.
- [ ] Document operation and finish regressions, verification and independent review.

## Step 1 — Contracts and observation

Add `validate_rotation_approval(value)` and
`provision_policy_rotation(mode, approval_path, expected_hash, bundle)` as the
profile's entrypoints. Existing `main(args=None)` selects the new profile while
preserving its argument cardinality, process environment and root checks.
Use existing `shape`, `matches`, `strict_json`, and `read_protected` primitives.
For example, the freshness predicate must be equivalent to:

```python
type(issued_at) is int and type(expires_at) is int and \
    0 < expires_at - issued_at <= 3600 and issued_at <= now < expires_at
```

Add a closed approval fixture with official repository/workflow IDs. Mutation
cases must independently cover duplicate/extra/missing keys; boolean, float and
string timestamps; zero/overlong windows; future/expired approvals; wrong official
IDs; malformed run/attempt/commit/hash; equal source/target; differing candidate
and target commit; expanded revisions and changed toolchain fields.

Use the real Python entrypoints through the existing `probe()` harness. First run
new assertions against the unimplemented profile and retain the failing result;
then implement. Check and consumed-check tests must detect filesystem mutation
calls, not only compare surviving file bytes. Consumed inspection must not need
a valid bundle, fresh approval or source-current state. Exercise each independent
snapshot and active-policy classification and exact raw-byte cross-binding.

```sh
node --test tests/unit/payload-candidate-trust-provisioning.test.mjs
```

Expected final result: portable contracts pass; native-only cases explicitly skip
on Windows rather than silently replacing native evidence with doubles.

## Step 2 — Application and failure boundaries

Introduce dedicated lease, snapshot, staging and replacement helpers without
modifying the semantics of `publish()` or `snapshot_prestate()`. Use the exact
ordered apply sequence from the specification. Set swap-attempt phase before the
replacement syscall. All errors after this point, including cleanup/final lease
validation, must preserve reconciliation-required classification.

Test source/target preservation and single-use behavior at reservation creation,
reservation-parent fsync, each snapshot publication, staging fsync, revalidation,
replacement attempt, policy-parent fsync, postverify, completion publication and
final return check. Verify no failed attempt auto-resumes, erases evidence or
reuses an ID after changed approval expiry. Assert the four installed tools and
all four executable hashes are checked, including the HTTPS Git helper.

Extend the existing test file so its mandatory native CI invocation discovers
the new cases automatically. Add a separate read-only pull-request workflow using
the same pinned checkout/setup-node actions and mandatory native test command;
the existing `ci.yml` step is candidate-only/main gated and cannot qualify a PR.
Keep checkout credentials unpersisted and include no secrets or deployment jobs.
Run genuine Linux root tests in a disposable
sandbox: independent flock contenders, descriptor/path replacement, lock held
for a cooperating child lifetime, a separately labelled unwrapped writer,
concurrent policy readers observing only complete old/new bytes, real replacement,
root metadata and fsync ordering. Fault injection must be identified separately
from healthy syscall/concurrency proof; neither is power-loss certification.

```sh
PAYLOAD_REQUIRE_NATIVE_TRUST=1 node --test tests/unit/payload-candidate-trust-provisioning.test.mjs
```

Expected result on Linux root: every native case executes and passes. Non-Linux
or non-root execution with the required flag must fail, not skip qualification.

## Step 3 — Documentation, regressions and acceptance

Document the exact clean CLI, independent authentication of the new program,
external single-use issuance/attempt ledger, 3600-second authorization window,
private evidence paths, consumed-check output, and phase-aware failures.
Provide a cooperative directory-flock registrar launch envelope that retains
the lock for the complete Node invocation and explicitly requires earlier
unwrapped invocations to be drained. Do not claim the envelope changes the
unchanged registrar's enforcement.

Document that the original preparation closure remains from the final candidate;
new administrative bytes are not substituted into its old approved `source`.
State that remote apply requires administrative quiescence and independently
authenticated current approval; no remote apply follows automatically from tests.

```sh
node --test tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-candidate-admission.test.mjs tests/unit/payload-preparation-authentication.test.mjs tests/unit/cms-image-pipeline.test.mjs
npm run verify
git diff --check
git diff a7b7f35792ca5c7b3f5db82094f406b56912ba70 -- ops/payload-candidate-verifier.py scripts/register-payload-candidate-admission.mjs scripts/package-payload-candidate.mjs scripts/lib/payload-candidate-qualification.mjs .github/workflows/ci.yml
```

The final command must have empty output. Review the actual full diff and test
evidence in the primary session. Obtain a fresh read-only independent review;
resolve Important/Critical findings, rerun affected checks, and accept only after
the reviewer and primary agree. Report separately implemented behavior, executed
qualification, and any operational prerequisites that remain unproven.

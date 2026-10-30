# Payload B0 Native Inventory Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan inline in the owning session; production authorization, evidence, and GitHub run continuity must remain with the primary worker.

**Goal:** Make the required native isolated B0 recovery create and consume a protected schema-v3 inventory before computing the baseline data fingerprint.

**Architecture:** Keep the fixture disposable by introducing a private sandbox with a nested runtime directory. Create the inventory through the real authenticated inventory helper, use its computed identity for state and binding, and leave production runtime behavior unchanged.

**Tech Stack:** Python 3 stdlib, Node.js test runner, Docker-based disposable PostgreSQL 16 fixture, GitHub Actions.

## Global Constraints

- No production paths, credentials, services, volumes, or inventory may be read or modified by the fixture.
- The inventory must be root-owned mode `0600` under the private fixture runtime.
- The same computed inventory identity must bind state initialization and the signed candidate binding.
- Do not add runtime fallbacks, cache injection, or caller-selected database arguments.
- Candidate publication must use a fresh nonce after the fix merges; the failed authorization is not reusable.

---

### Task 1: Protected fixture inventory

**Files:**
- Modify: `ops/payload-install-recovery-isolated.py:820-1065`
- Test: `tests/unit/payload-install-recovery.test.mjs:1-802`
- Modify: `docs/operations/deployment.md:806-845`

**Interfaces:**
- Consumes: `payload_control_inventory.production_inventory(...)`, `create(path, document)`, and `identity(document)`.
- Produces: `_create_fixture_inventory(runtime, sandbox: pathlib.Path, runtime_root: pathlib.Path) -> str`, returning the exact 64-hex inventory identity used by state and binding.

- [x] **Step 1: Write the failing portable contract test**

Add a probe that supplies a recording fake `runtime.INVENTORY`, calls `_create_fixture_inventory`, and asserts:

```python
identity = E._create_fixture_inventory(runtime, sandbox, runtime_root)
assert identity == 'a' * 64
assert created_path == str(runtime_root / 'payload-control-inventory.json')
assert production_args[0:2] == (str(sandbox), str(runtime_root))
assert production_args[-1] == 'portal'
```

Also assert from the source that the helper call occurs before `runtime._data_fingerprint` and that `inventory_identity` is passed to both `S.initialize` and the binding.

- [x] **Step 2: Run the focused test and confirm the new contract fails**

Run:

```bash
node --test tests/unit/payload-install-recovery.test.mjs
```

Expected: the new test fails because `_create_fixture_inventory` does not exist and the fixture still uses a synthetic digest.

- [x] **Step 3: Implement the minimal fixture change**

Add `_create_fixture_inventory` with fixed fixture-owned paths:

```python
def _create_fixture_inventory(runtime, sandbox, runtime_root):
    inventory = runtime.INVENTORY.production_inventory(
        str(sandbox), str(runtime_root), str(sandbox / 'releases'),
        str(sandbox / 'current-release'), str(runtime_root / 'deploy.lock'),
        str(sandbox / 'backups' / 'daily'), str(sandbox / 'backups' / 'production'),
        str(sandbox / 'backups' / 'production' / 'restore-protection'),
        str(sandbox / 'production.runtime.conf'),
        str(runtime_root / 'compose.production.yaml'),
        str(runtime_root / 'compose.payload.production.yaml'), 'portal')
    runtime.INVENTORY.create(str(runtime_root / 'payload-control-inventory.json'), inventory)
    return runtime.INVENTORY.identity(inventory)
```

Change the native fixture to create `sandbox` with `mkdtemp`, create `root = sandbox / 'runtime'`, call the helper immediately after authenticated closure loading, and replace both synthetic inventory identities with the returned identity. Successful cleanup removes `sandbox`, not only `root`.

- [x] **Step 4: Document the native fixture invariant**

Update the native provisioner qualification section in `docs/operations/deployment.md` to state that the disposable B0 fixture creates a protected schema-v3 inventory through the real helper before baseline fingerprinting, and uses one identity for runtime lookup, state, and binding.

- [x] **Step 5: Run focused verification**

Run:

```bash
node --test tests/unit/payload-install-recovery.test.mjs
node --test tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-preparation-authentication.test.mjs
git diff --check
```

Expected: all portable tests pass; only explicitly gated native Linux tests may skip locally; diff check passes.

- [x] **Step 6: Run repository verification**

Run:

```bash
npm run verify
```

Expected: PASS. If the existing OpenChamber Windows sandbox still denies `mkdtemp` under `C:\Users`, record the exact environmental failures and rely on the required Linux CI for acceptance; do not weaken tests.

- [x] **Step 7: Commit implementation**

```bash
git add ops/payload-install-recovery-isolated.py tests/unit/payload-install-recovery.test.mjs docs/operations/deployment.md
git commit -m "fix(payload): create inventory for native B0"
```

### Task 2: Linux acceptance and candidate retry

**Files:**
- No repository file changes expected.

**Interfaces:**
- Consumes: merged main SHA and the protected approval body/inventory baseline already staged on the VPS.
- Produces: a green candidate-only run and immutable candidate/qualification/recovery artifacts for admission registration.

- [ ] **Step 1: Push the branch and open a narrow PR**

Push `fix/payload-b0-inventory`, open a PR to `main`, and state that no CMS install, route, worker, authority transition, or cutover is included.

- [ ] **Step 2: Require Linux CI and review before merge**

Confirm the required native B0 job passes on Linux. Merge only after all required checks pass and the diff remains limited to the fixture, test, and documentation.

- [ ] **Step 3: Refresh protected source bindings**

Rebuild preparation/trust source hashes from the new merged main SHA because the source closure and approved workflow revision are commit-bound. Install only missing or exactly identical trust material through the existing provisioner contract.

- [ ] **Step 4: Issue a fresh candidate authorization**

Recompute the approval binding digest and inventory identity from the unchanged production baseline, generate a new 64-hex nonce and a future expiry no more than 24 hours ahead, and preserve the authorization root-only. Do not reuse the nonce from failed run `41122692105`.

- [ ] **Step 5: Run candidate-only and continue gate installation**

Dispatch `ci.yml` on the exact merged main SHA with `publish_candidate_only=true`. After success, authenticate artifacts, register admission, finalize the preparation approval, run preparation provisioner `--check` then `--apply`, verify idempotence, and collect the authenticated context. Do not install or activate CMS, route, worker, scheduling, authority, or cutover in this task.

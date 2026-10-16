# Payload B0-01a Minimal Collector Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a bounded, authenticated, read-only production-context collector that binds source, inventory, signed state, process identity, nonce, and the inherited FD9 lease without granting any production authority.

**Architecture:** The installed authenticated preparation launcher remains the only parent authority. It authenticates the complete closure, holds FD9, starts one fixed observer operation in isolated Python, validates a small JSON result, and rechecks the complete context after the child exits. The observer re-enters the authenticated launcher through its fixed installed path, reads only fixed host sources, emits hashes and identifiers rather than private state, and never persists or authorizes anything.

**Tech Stack:** Python 3.9+ isolated mode, Linux `flock`/FD9 and `/proc`, Node 24 dependency-free tests, GitHub Actions existing candidate-only native root gate, Markdown runbooks.

## Global Constraints

- Keep Node 18 compatibility for API/cron shared code; repository verification uses Node 24.
- Linux/VPS behavior is authoritative; Windows filesystem and FD tests must be labelled as doubles.
- Preserve the current `api/`, `cron/`, `public/`, `nginx/`, and `cms/` boundaries.
- Do not read or emit passwords, DSNs, environment values, private state bodies, dumps, upload names, or credentials.
- Do not execute SQL, Docker mutations, service actions, backup, restore, installation, rollback, activation, or deploy.
- Do not modify journal/state, policy, records, releases, pointers, services, containers, networks, volumes, roles, grants, or passwords.
- Keep `install_receiver_preflight()` and every `release_not_preflighted` denial unchanged.
- Keep `destructiveOperationAuthorized`, `installationExecuted`, `deploymentAuthorized`, and `productionAuthorized` false.
- B0-02 and B0-03 remain pending; P2-03 remains blocked.
- Do not run Docker, remote CI, SSH, VPS commands, databases, or production services without separate explicit authorization.
- Preserve the existing CI step name `Test preauthority CI setup with native Linux root` and its required-native no-skip behavior.
- The implementation worker owns only the files listed in this plan. Unknown concurrent changes stop the task for primary review.

---

## File Structure

### Create

- `ops/payload-production-observer.py` — closed request/response schemas, fixed-path context observation, inherited FD9/process projection, sanitized CLI.
- `tests/unit/payload-production-observer.test.mjs` — portable contract, schema, privacy, no-effect, and negative tests for the observer.

### Modify

- `ops/provision-payload-candidate-trust.py` — add the observer to `PREPARATION_FILES`, making its exact bytes part of the independent approval and closure-first publication.
- `ops/prepare-cms-authenticated.py` — add the fixed bounded child runner, pre/post context comparison, and `--collect-context APPROVAL_SHA256` entrypoint.
- `tests/unit/payload-candidate-trust-provisioning.test.mjs` — prove observer hash/installation/order/re-entry behavior.
- `tests/unit/payload-preparation-authentication.test.mjs` — prove authentication-before-exec, bounded child execution, context drift denial, false authority, and native FD9 inheritance.
- `.github/workflows/ci.yml` — change only if the existing preparation test command does not execute the new required-native case; expected implementation requires no workflow edit.
- `docs/operations/payload-runtime-recovery.md` — document B0-01a contract, evidence boundary, and remaining blockers.
- `docs/operations/deployment.md` — document the installed fixed entrypoint and its non-authorizing behavior.
- `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md` — close P1-02 evidence bookkeeping and split B0-01a from the still-pending productive collector completion.

## Locked Interfaces

### Observer request

Canonical JSON on stdin, maximum 4 KiB including the final LF:

```json
{
  "schemaVersion": 1,
  "kind": "payload-production-context-request-v1",
  "operation": "collect-context",
  "nonce": "<64 lowercase hex>",
  "approvalSha256": "<64 lowercase hex>"
}
```

No path, command, role, database, SQL, origin, state body, or caller-selected module is accepted.

### Observer response

Canonical JSON on stdout, maximum 4 KiB including the final LF:

```json
{
  "schemaVersion": 1,
  "kind": "payload-production-context-observation-v1",
  "operation": "collect-context",
  "nonce": "<same request nonce>",
  "context": {
    "approvalSha256": "<authenticated approval bytes>",
    "sourceCommit": "<40 lowercase hex>",
    "inventoryIdentity": "<64 lowercase hex>",
    "stateSha256": "<SHA-256 of canonical authenticated state body>",
    "stateSequence": 0,
    "pid": 123,
    "processStart": 123,
    "leaseDevice": 123,
    "leaseInode": 123
  },
  "sourceAuthenticated": true,
  "inventoryAuthenticated": true,
  "stateAuthenticated": true,
  "leaseVerified": true,
  "destructiveOperationAuthorized": false,
  "installationExecuted": false,
  "deploymentAuthorized": false,
  "productionAuthorized": false
}
```

`processStart` is Linux `/proc/self/stat` field 22 in clock ticks. The observer parses it by separating the final `)` of the comm field, rejects malformed or non-positive values, and never emits the comm value.

### Python functions

`ops/payload-production-observer.py` produces:

The exact function signatures are:

- `canonical(value) -> bytes`
- `strict_json(raw: bytes, maximum: int = 4096) -> dict`
- `validate_request(value: object) -> dict`
- `validate_response(value: object, expected_nonce: str, expected_approval: str) -> dict`
- `process_start_ticks() -> int`
- `collect_context(request: dict, launcher) -> dict`
- `main(args=None) -> None`

`ops/prepare-cms-authenticated.py` produces:

The exact function signatures are:

- `expected_context(approval, captured, approval_digest) -> dict`
- `run_bounded_observer(request: dict) -> dict`
- `collect_context() -> dict`

`expected_context()` calls the existing authenticated host/state readers and returns only the response `context` fields that the parent can independently verify. `run_bounded_observer()` is the only child-process transport. `collect_context()` owns the parent lease, pre/post authentication, nonce generation, and exact comparison.

---

### Task 1: Closed Observer Contract

**Files:**
- Create: `ops/payload-production-observer.py`
- Create: `tests/unit/payload-production-observer.test.mjs`

**Interfaces:**
- Consumes: fixed installed launcher path `/usr/local/libexec/ownerinc-payload-prepare.py`; inherited FD9; canonical request shown above.
- Produces: `canonical`, `strict_json`, `validate_request`, `validate_response`, `process_start_ticks`, `collect_context`, and the exact response schema above.

- [ ] **Step 1: Write failing request/response schema tests**

Create `tests/unit/payload-production-observer.test.mjs` with a Python probe that imports the real new module in isolated mode. Include a valid request and mutations for every closed field:

```js
const request = {
  schemaVersion: 1,
  kind: 'payload-production-context-request-v1',
  operation: 'collect-context',
  nonce: 'a'.repeat(64),
  approvalSha256: 'b'.repeat(64),
};
const mutations = [
  value => { value.schemaVersion = true; },
  value => { value.schemaVersion = 2; },
  value => { value.kind = 'other'; },
  value => { value.operation = 'security'; },
  value => { value.nonce = 'A'.repeat(64); },
  value => { value.approvalSha256 = 'short'; },
  value => { value.path = '/tmp/caller-selected'; },
  value => { value.sql = 'select 1'; },
  value => { value.role = 'postgres'; },
  value => { value.command = ['sh']; },
];
```

Assert canonical UTF-8, duplicate-key rejection, unknown/missing-field rejection, boolean-versus-integer rejection, depth/size rejection, exact false authorization fields, and response nonce/approval mismatch rejection.

- [ ] **Step 2: Run the observer test and retain the expected red result**

Run:

```powershell
node --test tests/unit/payload-production-observer.test.mjs
```

Expected: FAIL because `ops/payload-production-observer.py` does not exist.

- [ ] **Step 3: Implement strict JSON and schemas**

Create `ops/payload-production-observer.py` with no third-party imports. Use exact-key validation and reject booleans where integers are required:

```python
MAX_FRAME = 4096
HEX_64 = re.compile(r'[0-9a-f]{64}')
HEX_40 = re.compile(r'[0-9a-f]{40}')

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')

def strict_json(raw, maximum=MAX_FRAME):
    require(isinstance(raw, bytes) and 0 < len(raw) <= maximum)
    def pairs(items):
        value = {}
        for key, item in items:
            require(isinstance(key, str) and key not in value)
            value[key] = item
        return value
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs)
    require(canonical(value) + b'\n' == raw)
    return value

def validate_request(value):
    keys(value, 'schemaVersion kind operation nonce approvalSha256')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1)
    require(value['kind'] == 'payload-production-context-request-v1')
    require(value['operation'] == 'collect-context')
    require(isinstance(value['nonce'], str) and HEX_64.fullmatch(value['nonce']))
    require(isinstance(value['approvalSha256'], str) and HEX_64.fullmatch(value['approvalSha256']))
    return value
```

Implement `validate_response()` with the exact response keys and types from the locked interface. Require the four authorization flags to be `False` and the four evidence flags to be `True`.

- [ ] **Step 4: Add the fixed observer collection logic**

Load only the installed launcher path, then use its existing authenticated material and signed-state path:

```python
LAUNCHER = '/usr/local/libexec/ownerinc-payload-prepare.py'

def collect_context(request, launcher):
    request = validate_request(request)
    approval, captured, _, _, digest = launcher.context_material(request['approvalSha256'])
    require(digest == request['approvalSha256'])
    runtime, inventory, body, _ = launcher.inspect_install_host(approval, captured)
    lease = os.fstat(9)
    launcher.verify_inherited_lease()
    context = {
        'approvalSha256': digest,
        'sourceCommit': approval['hostBaseline']['currentCommit'],
        'inventoryIdentity': runtime.INVENTORY.identity(inventory),
        'stateSha256': hashlib.sha256(runtime.STATE.canonical(body)).hexdigest(),
        'stateSequence': body['sequence'],
        'pid': os.getpid(),
        'processStart': process_start_ticks(),
        'leaseDevice': lease.st_dev,
        'leaseInode': lease.st_ino,
    }
    launcher.verify_inherited_lease()
    response = {
        'schemaVersion': 1,
        'kind': 'payload-production-context-observation-v1',
        'operation': 'collect-context',
        'nonce': request['nonce'],
        'context': context,
        'sourceAuthenticated': True,
        'inventoryAuthenticated': True,
        'stateAuthenticated': True,
        'leaseVerified': True,
        'destructiveOperationAuthorized': False,
        'installationExecuted': False,
        'deploymentAuthorized': False,
        'productionAuthorized': False,
    }
    return validate_response(response, request['nonce'], digest)
```

Do not add fields to this response. `main()` accepts exactly `['collect-context']`, reads at most `MAX_FRAME + 1` bytes from stdin, imports `LAUNCHER` by fixed path, emits one canonical response line, and on any exception emits only `Production context collection denied.` to stderr with exit 1.

- [ ] **Step 5: Add privacy and no-effect source invariants**

In the Node test, read the observer source and assert it contains no `subprocess`, `socket`, `psycopg`, `docker`, `pg_authid`, `environ`, `eval`, `exec`, write mode, or caller path option. Exercise a launcher double that returns authenticated synthetic objects and assert the output has only the locked keys, hashes the canonical state body, and never includes synthetic secrets inserted into the unprojected body.

- [ ] **Step 6: Run the observer tests**

Run:

```powershell
node --test tests/unit/payload-production-observer.test.mjs
python -m py_compile ops/payload-production-observer.py
```

Expected: all observer tests PASS; Python compilation exits 0.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- ops/payload-production-observer.py tests/unit/payload-production-observer.test.mjs
git diff --cached --check
git commit -m "feat(cms): add closed Payload context observer"
```

---

### Task 2: Bind Observer Bytes into the Preparation Closure

**Files:**
- Modify: `ops/provision-payload-candidate-trust.py:25-40`
- Modify: `ops/prepare-cms-authenticated.py:24-31`
- Modify: `tests/unit/payload-candidate-trust-provisioning.test.mjs`
- Modify: `tests/unit/payload-preparation-authentication.test.mjs:468-486`

**Interfaces:**
- Consumes: `ops/payload-production-observer.py` from Task 1.
- Produces: identical 16-entry `PREPARATION_FILES`/`FILES` tuples and mandatory approval hash for the observer.

- [ ] **Step 1: Write failing closure tests**

Update assertions to require:

```js
assert.equal(p.PREPARATION_FILES.length, 16);
assert.deepEqual(p.PREPARATION_FILES, l.FILES);
assert.ok(p.PREPARATION_FILES.includes('ops/payload-production-observer.py'));
```

Add mutations that remove the observer hash, add an extra hash, alter the observer bytes after approval, preinstall conflicting bytes, and interrupt publication immediately before approval. Assert each case refuses and never publishes approval early.

- [ ] **Step 2: Run focused tests and verify red**

Run:

```powershell
node --test tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-preparation-authentication.test.mjs
```

Expected: FAIL because both closure tuples still contain 15 files.

- [ ] **Step 3: Add the observer to both closure tuples**

Insert `ops/payload-production-observer.py` immediately before the launcher/provisioner pair in both files:

```python
'ops/payload-control-runtime.py', 'ops/compose.payload.production.yaml', 'docker-compose.payload.yml',
'ops/payload-production-observer.py',
'ops/prepare-cms-authenticated.py', 'ops/provision-payload-candidate-trust.py')
```

Do not change schema version, target calculation, mode calculation, publication order, or approval format. Existing exact-key validation makes the new hash mandatory without a compatibility default.

- [ ] **Step 4: Prove closure-first and authentication-before-exec**

Extend the existing provisioning filesystem fixture so the observer payload would create a sentinel if executed. Confirm bootstrap only reads/hashes/copies it. In preparation authentication tests, replace installed observer bytes with `raise Exception("MUST NOT EXECUTE")` and assert no closure module was loaded before the hash mismatch denied the request.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
node --test tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-preparation-authentication.test.mjs
```

Expected: PASS, with the native cases skipped only when their required-native flags are absent.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- ops/provision-payload-candidate-trust.py ops/prepare-cms-authenticated.py tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-preparation-authentication.test.mjs
git diff --cached --check
git commit -m "feat(cms): bind Payload observer to trusted closure"
```

---

### Task 3: Authenticated Bounded Parent Dispatch

**Files:**
- Modify: `ops/prepare-cms-authenticated.py:423-575,617-699`
- Modify: `tests/unit/payload-preparation-authentication.test.mjs`
- Test: `tests/unit/payload-production-observer.test.mjs`

**Interfaces:**
- Consumes: observer request/response and `validate_response()` from Task 1; authenticated closure from Task 2.
- Produces: `expected_context()`, `run_bounded_observer()`, `collect_context()`, and CLI `--collect-context APPROVAL_SHA256`.

- [ ] **Step 1: Write failing parent-dispatch tests**

Add portable process doubles that assert:

- parent authenticates before spawn;
- parent owns an exclusive `deployment_lease(close_only=True)` across child lifetime;
- command is exactly `/usr/bin/python3 -I -S -B ROOT/ops/payload-production-observer.py collect-context`;
- environment is exactly `PATH=/usr/bin:/bin`, `LANG=C`, `LC_ALL=C`;
- only FD9 is inherited;
- stdin is the exact canonical request and is at most 4 KiB;
- child timeout, output byte 4097, nonzero exit, malformed JSON, wrong nonce, wrong approval, unexpected stderr path, and context mismatch all deny;
- source, inventory, state, approval, or FD9 drift after child completion denies;
- the success result exactly equals the validated observer response and retains all false authority fields.

- [ ] **Step 2: Run the preparation test and verify red**

```powershell
node --test tests/unit/payload-preparation-authentication.test.mjs
```

Expected: FAIL because `collect_context()` and the CLI branch do not exist.

- [ ] **Step 3: Implement independent expected context projection**

Use the existing authenticated host reader; do not trust values echoed by the child:

```python
def expected_context(approval, captured, approval_digest):
    runtime, inventory, body, _ = inspect_install_host(approval, captured)
    lease = os.fstat(9)
    return {
        'approvalSha256': approval_digest,
        'sourceCommit': approval['hostBaseline']['currentCommit'],
        'inventoryIdentity': runtime.INVENTORY.identity(inventory),
        'stateSha256': hashlib.sha256(runtime.STATE.canonical(body)).hexdigest(),
        'stateSequence': body['sequence'],
        'leaseDevice': lease.st_dev,
        'leaseInode': lease.st_ino,
    }
```

The parent intentionally does not predict the child PID/start ticks. It validates them as positive safe integers and requires the actual child PID to match the spawned process PID.

- [ ] **Step 4: Implement bounded child transport**

Use `subprocess.Popen`, `selectors.DefaultSelector`, `time.monotonic`, nonblocking pipe reads, and these constants:

```python
OBSERVER_TIMEOUT_SECONDS = 30
OBSERVER_MAX_FRAME = 4096
OBSERVER = ROOT + '/ops/payload-production-observer.py'
```

Write the canonical request, close stdin, and read at most `OBSERVER_MAX_FRAME + 1` bytes. Register stdout with the selector and stop at EOF, timeout, or overflow. Route stderr to `subprocess.DEVNULL`; diagnostics are parent-owned finite denials. On timeout/overflow/error, kill only the directly owned child, wait for it, and raise `VerificationError('preparation_verification_denied')`. Always close pipes and selector.

The production command must be:

```python
['/usr/bin/python3', '-I', '-S', '-B', OBSERVER, 'collect-context']
```

with `pass_fds=(9,)`, `env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}`, and no shell.

- [ ] **Step 5: Implement pre/post authenticated collection**

```python
def collect_context():
    initial = authenticate()
    with deployment_lease(close_only=True) as reaffirm:
        approval, captured, cms_image, support, digest = authenticate()
        require(digest == initial[4])
        verify_host_baseline(approval, captured, cms_image, support)
        before = expected_context(approval, captured, digest)
        reaffirm()
        request = {
            'schemaVersion': 1,
            'kind': 'payload-production-context-request-v1',
            'operation': 'collect-context',
            'nonce': os.urandom(32).hex(),
            'approvalSha256': digest,
        }
        result = run_bounded_observer(request)
        reaffirm()
        final = authenticate()
        require(final[4] == digest and final[1] == captured)
        verify_host_baseline(final[0], final[1], final[2], final[3])
        after = expected_context(final[0], final[1], digest)
        require(before == after)
        require(all(result['context'][key] == value for key, value in after.items()))
        reaffirm()
        return result
```

`run_bounded_observer()` also validates `result.context.pid == process.pid`, positive `processStart`, exact nonce/approval, response schema, and a final frame length no greater than 4096 bytes.

- [ ] **Step 6: Add the fixed CLI branch**

Extend the current exact grammar with only:

```python
len(args) == 2 and args[0] == '--collect-context'
```

Require `args[1]` to equal the authenticated approval digest before collection; do not permit flags or selectors after it. Print `json.dumps(result, sort_keys=True, separators=(',', ':'))` and one LF. Keep the existing generic sanitized exception handler.

- [ ] **Step 7: Run portable focused tests**

```powershell
node --test tests/unit/payload-production-observer.test.mjs tests/unit/payload-preparation-authentication.test.mjs
python -m py_compile ops/payload-production-observer.py ops/prepare-cms-authenticated.py
```

Expected: PASS with no unbounded or private diagnostic output.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- ops/prepare-cms-authenticated.py tests/unit/payload-preparation-authentication.test.mjs tests/unit/payload-production-observer.test.mjs
git diff --cached --check
git commit -m "feat(cms): collect authenticated Payload production context"
```

---

### Task 4: Native Linux/Root Qualification and CI Invariants

**Files:**
- Modify: `tests/unit/payload-preparation-authentication.test.mjs:260-361`
- Modify only if proven necessary: `.github/workflows/ci.yml:224-236`

**Interfaces:**
- Consumes: `collect_context()` and observer CLI from Task 3.
- Produces: bounded `native-production-context-envelope-proof` inside the existing required-native preparation test command.

- [ ] **Step 1: Extend the native test with an isolated real-filesystem fixture**

Under a fresh `/root/payload-context-observer-*` sandbox, redirect only the module constants used for fixed host roots. Keep actual Linux syscalls, metadata checks, `flock`, FD inheritance, `/proc/self/stat`, isolated Python, and observer bytes. The fixture must prove:

```json
{
  "kind": "native-production-context-envelope-proof",
  "schemaVersion": 1,
  "rootIdentity": true,
  "isolatedPython": true,
  "exclusiveLeaseInherited": true,
  "sameOpenDescriptionRetained": true,
  "processIdentityBound": true,
  "pathReplacementRefused": true,
  "outputOverflowRefused": true,
  "timeoutRefused": true,
  "privateMaterialAbsent": true,
  "authorityRemainedFalse": true,
  "sandboxRemoved": true
}
```

Keep the proof at or below 1024 bytes. Assert the fixture never opens the production paths from the unchanged module constants.

- [ ] **Step 2: Run the native test only in an authorized Linux/root environment**

Do not emulate this command on Windows and do not start Docker. In the existing candidate-only GitHub gate, the command remains:

```sh
sudo -n /usr/bin/env -i PATH=/usr/bin:/bin HOME=/root \
  PAYLOAD_REQUIRE_NATIVE_PREPARATION=1 "$NODE_BIN" --test \
  tests/unit/payload-preparation-authentication.test.mjs
```

Expected: PASS with zero skipped required-native cases and the bounded proof above.

- [ ] **Step 3: Prove the current workflow already executes the case**

Add a static assertion in `tests/unit/payload-preparation-authentication.test.mjs` or the existing CI setup test that `.github/workflows/ci.yml` retains:

- exact step name `Test preauthority CI setup with native Linux root`;
- `PAYLOAD_REQUIRE_NATIVE_PREPARATION=1`;
- the exact preparation test path;
- candidate-only branch condition;
- no deploy condition change.

If that assertion passes against the current workflow, leave `.github/workflows/ci.yml` untouched. Modify the workflow only if the test demonstrates the existing command cannot discover the new case.

- [ ] **Step 4: Run portable invariants**

```powershell
node --test tests/unit/payload-preparation-authentication.test.mjs
git diff --check
```

Expected: portable tests PASS; the native proof is explicitly skipped on non-Linux/non-root without the required flag.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- tests/unit/payload-preparation-authentication.test.mjs
if (git diff --quiet -- .github/workflows/ci.yml) { } else { git add -- .github/workflows/ci.yml }
git diff --cached --check
git commit -m "test(cms): qualify native Payload context envelope"
```

---

### Task 5: Operational Documentation and Status

**Files:**
- Modify: `docs/operations/payload-runtime-recovery.md`
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md`

**Interfaces:**
- Consumes: final code/test behavior from Tasks 1-4.
- Produces: exact runbook boundary and backlog state without production promotion.

- [ ] **Step 1: Document B0-01a in runtime recovery**

Add a section that records:

- exact request/response kinds and 4 KiB caps;
- fixed `collect-context` operation;
- complete closure authentication before execution;
- FD9/process/nonce/source/inventory/state binding;
- pre/post drift rejection;
- finite sanitized failure behavior;
- native TEST evidence boundary;
- no durable receipt, approval, B0 capture, B0-02, B0-03, or production authority.

- [ ] **Step 2: Document the installed entrypoint in deployment**

Document the exact internal command:

```text
/usr/bin/python3 -I -S -B /usr/local/libexec/ownerinc-payload-prepare.py --collect-context APPROVAL_SHA256
```

State that only the authenticated coordinator supplies the digest, FD9 must already be inherited, environment is empty except fixed PATH/locale, and success still leaves installation and deployment unauthorized. Do not present this command as an operator shortcut or host-install instruction.

- [ ] **Step 3: Update the completion backlog without overclaiming**

In `payload-pendencias-e-plano-de-conclusao-2026-10-14.md`:

- update E04/P1-02 with run `38617436909`, attempt 1, SHA `242652c9b43f5d3a7c8a93cebc85634a6fe0bbd1`, workflow success, deploy skipped, report 14 checks/11 negatives/2 restores, and exact artifact linkage already verified by the primary session;
- add B0-01a as implemented/TEST only after its local/native evidence exists;
- keep B0-01 productive host collection pending;
- keep B0-02 and B0-03 pending;
- keep P2-03 blocked;
- preserve the statement that B0 completion does not deliver the CMS.

- [ ] **Step 4: Scan documentation for contradictions and placeholders**

```powershell
rg -n "E04|P1-02|B0-01|B0-02|B0-03|release_not_preflighted|productionAuthorized" docs/operations
git diff --check
```

Expected: no placeholder hits in the changed sections and no contradictory production claim.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- docs/operations/payload-runtime-recovery.md docs/operations/deployment.md docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md
git diff --cached --check
git commit -m "docs: define Payload B0 context collector boundary"
```

---

### Task 6: Full Verification, Fresh Review, and Evidence Handoff

**Files:**
- Review: all files changed by Tasks 1-5
- No new production or CI files by default

**Interfaces:**
- Consumes: complete local implementation.
- Produces: primary-session acceptance evidence and a decision whether a separately authorized remote native candidate run is warranted.

- [ ] **Step 1: Run focused tests together**

```powershell
node --test tests/unit/payload-production-observer.test.mjs tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-preparation-authentication.test.mjs
```

Expected: zero failures; platform-native cases may skip only according to their explicit non-required guards.

- [ ] **Step 2: Run repository verification**

```powershell
npm run verify
```

Expected: exit 0 and `verify: ok`. Record pass/fail/skip counts exactly; do not copy prior counts onto new bytes.

- [ ] **Step 3: Run final static checks**

```powershell
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected: no whitespace diagnostics; only reviewed task changes are present.

- [ ] **Step 4: Primary inspects the actual diff**

Confirm:

- no changes to `install_receiver_preflight()` or existing `release_not_preflighted` sites;
- no SQL, Docker mutations, secret reads, state writes, or production commands;
- observer path is fixed and closure-authenticated;
- parent output/time limits are enforced rather than trusted to the child;
- pre/post source, inventory, signed state, approval, and FD9 checks are exact;
- every authority flag remains false;
- documentation calls the result TEST-only.

- [ ] **Step 5: Obtain a fresh read-only review**

The reviewer must inspect the real diff and verification evidence and return exactly one verdict:

- `ship` — scope and security contract are satisfied;
- `fix-first` — bounded corrections are required;
- `rethink` — architecture or authority boundary is unsound.

For `fix-first`, send only the demonstrated defects back to the same sole implementer, rerun focused/full verification, and obtain a fresh review.

- [ ] **Step 6: Create the final local evidence commit if review corrections changed files**

```powershell
git add -- ops/payload-production-observer.py ops/provision-payload-candidate-trust.py ops/prepare-cms-authenticated.py tests/unit/payload-production-observer.test.mjs tests/unit/payload-candidate-trust-provisioning.test.mjs tests/unit/payload-preparation-authentication.test.mjs docs/operations/payload-runtime-recovery.md docs/operations/deployment.md docs/operations/payload-pendencias-e-plano-de-conclusao-2026-10-14.md
git diff --cached --check
git commit -m "fix(cms): address Payload context collector review"
```

Skip this commit when the index is empty. Do not push, dispatch CI, install on the host, or deploy in this task.

- [ ] **Step 7: Report the next authorization gate**

Report:

- commit SHAs and changed files;
- focused and full verification counts;
- native cases run versus skipped;
- reviewer verdict;
- B0-01a status as local/TEST only;
- B0-01 productive host proof, B0-02, and B0-03 still pending;
- P2-03 still blocked;
- whether a new candidate CI run is recommended and what explicit authorization it would require.

Do not claim CMS release readiness or production authorization.

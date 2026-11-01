# Payload Preauthority Closed Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real smoke script prove that the editorial route is closed in the disposable preauthority fixture while preserving the exact production redirect requirement by default.

**Architecture:** Add one enumerated environment contract at the smoke boundary: `redirect` remains the default and `closed` is emitted only by `recoveryFixtureEnvironment()`. The same real HTTP smoke and diagnostic channel serve both profiles, with exact status/header assertions and no skipped check.

**Tech Stack:** Bash, curl, Node.js 18-compatible ESM, `node:test`, real local HTTP test server.

## Global Constraints

- The only accepted values are `redirect` and `closed`; an unset value means `redirect`.
- `redirect` requires exactly `308` and `Location: /editorial/admin`.
- `closed` requires exactly `404` and no `Location` header.
- Invalid modes fail before the retry loop and before any HTTP request.
- Only `recoveryFixtureEnvironment()` sets `SMOKE_EDITORIAL_MODE=closed`.
- Every versioned production deploy, release, and restore entrypoint explicitly binds `SMOKE_EDITORIAL_MODE=redirect`; the shared coordinator preserves the caller's explicit mode, and the fixture wrapper rejects any value other than `closed` before proxy or HTTP work.
- Keep the finite public diagnostic identifier `editorial_redirect`; never publish URLs, header values, bodies, or raw stderr.
- Do not activate CMS, publish routes, install protocol, enable workers/scheduling, deploy, restore production, transition authority, or cut over.
- Preserve Node 18 compatibility and LF endings for `scripts/smoke.sh`.

---

### Task 1: Pin the two editorial smoke profiles with real HTTP tests

**Files:**
- Modify: `tests/unit/smoke-origin.test.mjs:255-627`
- Modify: `tests/unit/payload-preauthority-snapshot-configuration.test.mjs`

**Interfaces:**
- Consumes: `run({ baseUrl, attempts, editorialMode })`, the test-local wrapper around `scripts/smoke.sh`.
- Produces: regression coverage for the `SMOKE_EDITORIAL_MODE` environment contract and fixture-only producer.

- [ ] **Step 1: Extend the real smoke wrapper to accept an explicit mode**

Change the helper to pass the variable only when requested, preserving the real unset/default path:

```js
const run = async ({baseUrl=origin,attempts='1',editorialMode,onSpawn}={}) => {
  const env = { ...process.env, BASE_URL: `${baseUrl}/`, SMOKE_ATTEMPTS: attempts };
  if (editorialMode !== undefined) env.SMOKE_EDITORIAL_MODE = editorialMode;
  const result = await ownedTestProcess(bash, ['scripts/smoke.sh'], { env, onSpawn, ledger: ownership });
  return {code:result.code,signal:result.signal,output:result.stdout+result.stderr,ownership:result.proof};
};
```

- [ ] **Step 2: Add failing real HTTP tests for `closed` and invalid modes**

Add tests that override `/editorial` and assert:

```js
overrides.set('/editorial', { status: 404 });
assert.equal((await run({ editorialMode: 'closed' })).code, 0);

overrides.set('/editorial', { status: 404, headers: { Location: '/editorial/admin' } });
const leaked = await run({ editorialMode: 'closed' });
assert.equal(leaked.code, 1);
assert.deepEqual(extractSmokeFailure(leaked.output, {
  smokeCommandContext: FIXTURE_SMOKE_CONTEXT,
  substep: 'fixture_full_smoke',
  status: leaked.code,
}), {
  check: 'editorial_redirect', reason: 'redirect', httpStatus: 404,
});
```

Also assert that `closed` rejects the normal `308`, the unset/default profile
still rejects an absolute redirect, and `SMOKE_EDITORIAL_MODE=invalid` exits
nonzero without increasing `requests.length`.

- [ ] **Step 3: Pin the fixture environment producer**

In `payload-preauthority-snapshot-configuration.test.mjs`, call the actual
`recoveryFixtureEnvironment()` producer and assert:

```js
assert.equal(environment.SMOKE_EDITORIAL_MODE, 'closed');
assert.equal(environment.SMOKE_ATTEMPTS, '8');
```

- [ ] **Step 4: Run the tests and verify the new assertions fail**

Run:

```bash
node --test tests/unit/smoke-origin.test.mjs tests/unit/payload-preauthority-snapshot-configuration.test.mjs
```

Expected: FAIL because `closed` is not implemented and the producer does not set the variable.

---

### Task 2: Implement the enumerated smoke contract and fixture binding

**Files:**
- Modify: `scripts/smoke.sh:4-110`
- Modify: `scripts/integration/payload-preauthority-snapshot-runtime.mjs:55-64`
- Modify: `tests/unit/smoke-origin.test.mjs:496-552`

**Interfaces:**
- Consumes: optional `SMOKE_EDITORIAL_MODE` from the process environment.
- Produces: `recoveryFixtureEnvironment(project, runtime, hostPath)` with `SMOKE_EDITORIAL_MODE: 'closed'`; smoke exit status and existing finite diagnostics.

- [ ] **Step 1: Validate the mode before allocating retry state**

At the top of `scripts/smoke.sh`, add:

```bash
editorial_mode=${SMOKE_EDITORIAL_MODE:-redirect}
case $editorial_mode in
  redirect|closed) ;;
  *) printf '%s\n' 'Invalid SMOKE_EDITORIAL_MODE.' >&2; exit 2 ;;
esac
```

Keep this before `mktemp` and the retry loop so invalid configuration performs no HTTP request.

- [ ] **Step 2: Replace the redirect-only helper with a profile-aware exact check**

Rename it to `check_editorial_route` and retain one curl metadata request:

```bash
case $editorial_mode in
  redirect) expected_status=308; expected_location=/editorial/admin ;;
  closed) expected_status=404; expected_location= ;;
esac
[[ $status == "$expected_status" ]] || {
  smoke_result editorial_redirect fail http_status "$status"; return 1;
}
[[ $location == "$expected_location" ]] || {
  smoke_result editorial_redirect fail redirect "$status"; return 1;
}
```

Update the retry chain to call `check_editorial_route`. Do not add `--location`, `--fail`, or response-body reads.

- [ ] **Step 3: Bind `closed` only in the fixture environment producer**

Add the exact property alongside the existing smoke attempts:

```js
RESTORE_BASE_URL: runtime.baseUrl,
SMOKE_ATTEMPTS: '8',
SMOKE_EDITORIAL_MODE: 'closed',
```

- [ ] **Step 4: Assert the real full-smoke wrapper transports `closed`**

Extend `transportCorrect` in `smoke-origin.test.mjs` with:

```js
&& options.env.SMOKE_EDITORIAL_MODE === 'closed'
```

For full-smoke phases, return `404` from the test server when the fixture mode
is used and continue asserting `/editorial` is requested before seed/restore callbacks.

- [ ] **Step 5: Run the focused suite**

Run:

```bash
node --test tests/unit/smoke-origin.test.mjs tests/unit/payload-preauthority-snapshot-configuration.test.mjs tests/unit/payload-preauthority-recovery-guard.test.mjs tests/unit/payload-preauthority-diagnostics.test.mjs
```

Expected: all tests pass, with only platform-declared skips.

- [ ] **Step 6: Commit the behavior and tests**

```bash
git add scripts/smoke.sh scripts/integration/payload-preauthority-snapshot-runtime.mjs tests/unit/smoke-origin.test.mjs tests/unit/payload-preauthority-snapshot-configuration.test.mjs
git commit -m "fix(payload): require closed preauthority route"
```

---

### Task 3: Document and verify the complete contract

**Files:**
- Modify: `docs/operations/payload-runtime-recovery.md:2107-2121`

**Interfaces:**
- Consumes: the tested `redirect|closed` behavior from Tasks 1-2.
- Produces: operator-facing recovery contract and complete repository verification evidence.

- [ ] **Step 1: Update the recovery runbook**

Document that production/default smoke requires `308` plus the exact relative
location, while the preauthority fixture sets `closed` and requires `404` with
no `Location`. State explicitly that this is a strict alternate assertion, not
a skipped smoke check.

- [ ] **Step 2: Run the full repeatable verification**

On Windows, create a fresh external parent outside `C:\Users\Criação\.git`, set
`PAYLOAD_TEST_EXTERNAL_PARENT` to it, then run:

```bash
npm run verify
git diff --check
```

Expected: root tests, CMS tests, security checks, shell syntax, and Compose checks pass; `git diff --check` prints nothing.

- [ ] **Step 3: Commit the runbook update**

```bash
git add docs/operations/payload-runtime-recovery.md
git commit -m "docs(payload): explain preauthority smoke mode"
```

- [ ] **Step 4: Open a narrow PR and wait for Linux CI**

Push `fix/payload-preauthority-smoke`, open a PR against `main`, and require the
Linux validation check to pass before merge. The PR must state that no deploy,
activation, restore, protocol installation, authority transition, or cutover occurs.

- [ ] **Step 5: Requalify with fresh authorization only after merge**

Revalidate the production baseline read-only, generate a new approval binding
for the new merge SHA, and use a fresh nonce for `publish_candidate_only`. Never
reuse nonce `1d59eddeaa7d7e5ccf8de953782bb3a8627792758ac430fdb7567bcedf312c9b`.

If qualification fails, download only redacted artifacts first and preserve the
private failed fixture until diagnosis is complete. Do not deploy or cut over.

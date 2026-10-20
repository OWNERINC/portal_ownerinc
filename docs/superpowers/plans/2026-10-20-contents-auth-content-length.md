# Contents Auth Content-Length Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reject malformed or over-cap advertised `Content-Length` values before the opt-in 401/403 authentication clone is read, without changing default auth callers or original response ownership.

**Architecture:** Add one pure shared parser for the existing canonical decimal, safe-integer, and endpoint-cap rules. Reuse it in the Contents reader and the opt-in authentication decoder. On rejected auth headers, cancel only the clone branch once and do not await the tee cancellation promise; keep streamed byte counting for missing or understated lengths.

**Tech Stack:** Browser ES modules, Node test runner, native `Response.clone()`/`ReadableStream`; Node 18-compatible shared JavaScript syntax.

## Global Constraints

- Preserve default authentication callers and public API behavior.
- The opt-in auth clone is bounded to 16 KiB.
- Missing `Content-Length` remains readable; actual streamed bytes remain capped.
- Do not expose response bodies/server error text and do not cancel the caller-owned original branch from the clone decoder.
- Use no server, database, Firebase, Docker, or production changes.

---

### Task 1: Shared canonical Content-Length parser

**Files:**
- Create: `public/js/content-length.js`
- Test: `tests/unit/content-length.test.mjs`
- Modify: `public/js/portal-contents/api.js`
- Test: `tests/unit/portal-contents-api.test.mjs`

**Interface:**
- `parseContentLength(value, maxBytes)` returns `{kind: 'absent'}` when the header is `null`/`undefined`; `{kind: 'valid', length}` for canonical decimal text whose value is a safe integer at or below the cap; otherwise `{kind: 'invalid'}` or `{kind: 'too-large', length}`.
- `api.js` continues to reject all non-valid, non-absent headers before `reader.read()` and retains its existing public error mapping.

- [ ] Add parser tests for absent values; canonical `0`, below-cap, and exact-cap values; and `''`, leading zero, sign, whitespace, decimal/exponent, comma-combined, negative, unsafe integer, and cap-plus-one values.
- [ ] Run `node --test tests/unit/content-length.test.mjs` and confirm the missing parser export/import fails.
- [ ] Implement the pure parser with `Number.isSafeInteger`, the canonical decimal expression `^(?:0|[1-9][0-9]*)$`, and an explicit cap comparison.
- [ ] Replace the local `Content-Length` parsing in `api.js` with the shared parser; leave byte counting and all external error shapes unchanged.
- [ ] Run `node --test tests/unit/content-length.test.mjs tests/unit/portal-contents-api.test.mjs`.

### Task 2: Opt-in authentication clone precheck and tee regressions

**Files:**
- Modify: `public/js/auth.js`
- Test: `tests/unit/auth-stability.test.mjs`
- Test: `tests/unit/portal-contents-api.test.mjs`

**Interface:**
- `readBoundedAuthenticationBody(response, maxBytes)` checks the shared parser before acquiring a reader. For rejected headers it calls `response.body.cancel()` once, observes rejection without awaiting the tee promise, and returns `{}`. For valid/absent headers it preserves streaming byte limits and JSON shape behavior.
- `handleAuthenticationFailure` and `authenticatedFetch` retain their existing default path and continue owning/cancelling the original response according to current auth semantics.

- [ ] Add integration tests using real `Response.clone()` and zero-high-water-mark streams. Cover valid length, absent length, understated length with actual overflow, over-cap length, malformed text, duplicate/comma-combined length, negative value, and unsafe integer.
- [ ] Before fixes, run the focused auth test and confirm rejected declared lengths still pull body bytes or violate original-branch tee ownership.
- [ ] Precheck cloned response headers before `getReader()`. On rejection, call only the clone branch's `cancel()` once; do not await its promise. Retain current chunk-by-chunk byte counting.
- [ ] For a nonfatal 403, prove the returned original branch remains readable. In a separate deferred-stream case, verify precheck rejection creates no clone-reader reads or pulls beyond the native tee baseline, then cancel the original branch and require settlement within a bounded timeout with exactly one underlying source cancellation.
- [ ] For a fatal 401, prove the clone precheck does not hang normal auth handling, the original branch is cancelled by existing auth semantics, and server body text is absent from the thrown error.
- [ ] Run `node --test tests/unit/auth-stability.test.mjs tests/unit/portal-contents-api.test.mjs tests/unit/portal-contents-routing.test.mjs`.

### Task 3: Verification, report, and focused commit

**Files:**
- Modify: `.superpowers/sdd/2026-10-20-portal-contents-reader/task-2-report.md`
- Commit the parser, auth/API changes, regression tests, and report evidence.

- [ ] Record RED/GREEN results and final exact suite counts in the Task 2 report; retain its local ignored status unless it is already tracked.
- [ ] Run the changed shared files through a Node 18 syntax check/probe and run the focused auth/Contents tests.
- [ ] Run the full public unit suite with bounded concurrency and `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp`.
- [ ] Run `node scripts/generate-public-shell.mjs --check`, `npm run verify -- security`, `git diff --check`, and applicable syntax/type/DHO/CMS checks.
- [ ] Review the staged diff, then commit with message `fix(contents): precheck auth clone content length`.

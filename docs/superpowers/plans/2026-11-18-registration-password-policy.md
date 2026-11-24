# Registration Password Policy Implementation Plan

> **For agentic workers:** Execute inline in this isolated worktree. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept registration passwords with 8–128 UTF-16 units and an uppercase
letter, with visible validation feedback.

**Architecture:** Keep existing API and form validators. Add Unicode uppercase
checks in both; let the submit handler control form validation so native invalid
fields cannot bypass Portal feedback. No dependencies or database changes.

**Tech Stack:** Express/CommonJS, browser JavaScript, HTML, node:test.

## Global Constraints

- Preserve Node 18 service compatibility and existing directory boundaries.
- Never trim, normalize, persist or log passwords.
- Do not change existing passwords, approval, recovery, rate limits or deployment.
- Do not add network timeouts in this task.

## Task 1: Update registration policy and validation feedback

**Files:**
- Modify: `api/middleware/validation.js`
- Modify: `public/login.html`, `public/js/login.js`
- Test: `tests/unit/api-security.test.mjs`
- Test: `tests/unit/registration-feedback.test.mjs`
- Test: `tests/unit/registration-http.test.mjs`
- Test: `tests/unit/login-approved-reference.test.mjs`
- Fixture: `tests/helpers/registration-api-harness.mjs`
- Docs: `docs/architecture/data-flow.md`, `docs/product/feature-inventory.md`,
  `docs/operations/manual-operadores.md`, `docs/operations/registration-traffic.md`

**Interfaces:** Keep `validateRegistration(body): boolean` and
`POST /api/auth/register` response contracts unchanged. Only valid passwords
reach Firebase. Registration form errors remain in `#register-error`.

- [x] Add failing validator tests for 7 characters, 8 without uppercase,
  8 with uppercase, accented uppercase, 128 and 129 characters.

```js
assert.equal(validateRegistration({ ...valid, password: 'Abcdefgh' }), true);
assert.equal(validateRegistration({ ...valid, password: 'abcdefgh' }), false);
assert.equal(validateRegistration({ ...valid, password: 'Ábcdefgh' }), true);
```

- [x] Add form tests for visible errors, zero HTTP calls on invalid input,
  and successful resubmission after validation failure. Update valid fixtures
  to contain an uppercase letter without changing their whitespace.
- [x] Run focused tests and observe the old policy failing the new expectations:

```sh
node --test tests/unit/api-security.test.mjs tests/unit/registration-feedback.test.mjs tests/unit/registration-http.test.mjs tests/unit/login-approved-reference.test.mjs
```

- [x] Change API and browser checks to minimum 8, maximum 128 and
  `/\p{Lu}/u.test(password)`. Keep exact confirmation and no normalization.
- [x] Set password HTML `minlength="8"` and update help/error text to mention
  the uppercase requirement. Set `form.noValidate = true` from JavaScript
  once the submit handler is registered, preserving native validation as the
  fallback before initialization.
- [x] Remove the native invalid listener that clears passwords before submit;
  call `reportValidity()` inside submit, set a textual field-validation error
  before clearing passwords when it returns false, and retain retry controls.
- [x] Update current product/operations docs, preserving historical reviews.
- [x] Re-run focused tests, `npm run verify`, and `git diff --check`.
- [x] Review the diff for matching policies, secrets, scope and untested branches.
  Record local evidence separately from production publication.

## Local evidence

- Before implementation, the focused run failed 17 of 82 tests against the old
  policy, including eight-character acceptance and visible validation feedback.
- After implementation, full `npm run verify` passed: 1,288 passed, 4 skipped,
  0 failed, including the registration HTTP journey and validation regressions.
- `git diff --check` passed.
- Independent read-only review completed without relevant findings.
- External Firebase and PostgreSQL calls are stubbed by the registration HTTP
  test harness. No real account was created and no production write was made.
- No deployment was performed. Network timeout handling remains out of scope.

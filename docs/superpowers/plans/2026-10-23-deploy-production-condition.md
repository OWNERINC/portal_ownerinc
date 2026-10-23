# Production Deploy Condition Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore production deployment after a green normal-main validation without allowing cancelled, failed, pull-request, non-main, CMS-only, or candidate-only runs to deploy.

**Architecture:** Replace the deploy job's implicit GitHub status handling with an explicit `!cancelled()` and direct `needs.validate.result == 'success'` guard while retaining the existing event/ref/mode policy. Bind the exact workflow expression to a dependency-free scenario matrix in the existing CI contract suite.

**Tech Stack:** GitHub Actions YAML, Node.js test runner, repository verification scripts, GitHub CLI.

## Global Constraints

- Keep `needs: validate`, `environment: production`, production concurrency, immutable API/cron digests, restricted SSH, backup, migration, smoke, retry, and rollback behavior unchanged.
- Use `!cancelled()`; do not use `always()` for the production job.
- Deploy only after direct validation result `success`.
- Permit only `push` or normal `workflow_dispatch` on exact ref `refs/heads/main`.
- Never deploy CMS-only or candidate-only dispatches.
- Do not change application code, dependencies, images, database schema, receivers, secrets, environment protection, Trivy, or npm audit policy.

---

### Task 1: Make production eligibility explicit and test its event matrix

**Files:**
- Modify: `.github/workflows/ci.yml:573-577`
- Modify: `tests/unit/cms-image-pipeline.test.mjs:27-46,68-73,144-150`
- Modify: `tests/unit/operations-invariants.test.mjs:406-417`
- Modify: `docs/operations/deployment.md:194-206`
- Test: `tests/unit/cms-image-pipeline.test.mjs`
- Test: `tests/unit/operations-invariants.test.mjs`

**Interfaces:**
- Consumes: `needs.validate.result`, `github.event_name`, `github.ref`, `inputs.cms_image_only`, and `inputs.publish_candidate_only`.
- Produces: a production job condition that is eligible only after successful normal-main validation.

- [ ] **Step 1: Add the failing deploy policy contract**

Add this closed evaluator near the existing `condition()` helper in
`tests/unit/cms-image-pipeline.test.mjs`. It substitutes every allowed GitHub
context token in the expression extracted from `ci.yml`, rejects any remaining
identifier or unsupported character, and only then evaluates the resulting
boolean expression:

```js
function evaluateDeployCondition(expression, context) {
  const replacements = new Map([
    ['cancelled()', String(Number(context.cancelled ?? false))],
    ["needs.validate.result == 'success'", String(Number(context.validateResult === 'success'))],
    ["github.event_name == 'push'", String(Number(context.eventName === 'push'))],
    ["github.event_name == 'workflow_dispatch'", String(Number(context.eventName === 'workflow_dispatch'))],
    ["github.ref == 'refs/heads/main'", String(Number(context.ref === 'refs/heads/main'))],
    ['inputs.cms_image_only != true', String(Number(context.cmsImageOnly !== true))],
    ['inputs.publish_candidate_only != true', String(Number(context.publishCandidateOnly !== true))],
  ]);
  let resolved = expression;
  for (const [token, value] of replacements) resolved = resolved.replaceAll(token, value);
  assert.doesNotMatch(resolved, /[A-Za-z_$]/u, `unsupported token remains in deploy condition: ${resolved}`);
  assert.match(resolved, /^[\s!()&|01]+$/u, 'deploy condition contains unsupported syntax');
  return Function(`"use strict"; return (${resolved});`)();
}
```

Replace the deploy assertion with an exact expression contract:

```js
const productionDeployCondition = "!cancelled() && needs.validate.result == 'success' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && inputs.cms_image_only != true && inputs.publish_candidate_only != true";
assert.equal(condition(productionDeploy, 4), productionDeployCondition,
  'production deployment must override skipped-ancestor propagation and require successful normal-main validation');
```

Add the scenario matrix:

```js
for (const [name, context, expected] of [
  ['main push', { validateResult: 'success', eventName: 'push', ref: 'refs/heads/main' }, true],
  ['normal main dispatch', { validateResult: 'success', eventName: 'workflow_dispatch', ref: 'refs/heads/main' }, true],
  ['pull request', { validateResult: 'success', eventName: 'pull_request', ref: 'refs/pull/64/merge' }, false],
  ['non-main dispatch', { validateResult: 'success', eventName: 'workflow_dispatch', ref: 'refs/heads/fix/deploy' }, false],
  ['CMS-only dispatch', { validateResult: 'success', eventName: 'workflow_dispatch', ref: 'refs/heads/main', cmsImageOnly: true }, false],
  ['candidate-only dispatch', { validateResult: 'success', eventName: 'workflow_dispatch', ref: 'refs/heads/main', publishCandidateOnly: true }, false],
  ['failed validation', { validateResult: 'failure', eventName: 'push', ref: 'refs/heads/main' }, false],
  ['cancelled workflow', { cancelled: true, validateResult: 'success', eventName: 'push', ref: 'refs/heads/main' }, false],
]) {
  assert.equal(evaluateDeployCondition(condition(productionDeploy, 4), context), expected, name);
}
```

Update `operations-invariants.test.mjs` to require `!cancelled()` and `needs.validate.result == 'success'` in the deploy job instead of accepting only the old event/ref prefix.

- [ ] **Step 2: Run the focused tests and prove they fail**

```sh
node --test tests/unit/cms-image-pipeline.test.mjs tests/unit/operations-invariants.test.mjs
```

Expected: FAIL because `.github/workflows/ci.yml` still has the old condition without explicit status handling.

- [ ] **Step 3: Apply the minimal workflow correction**

Replace only the deploy job condition with:

```yaml
    if: >-
      !cancelled() &&
      needs.validate.result == 'success' &&
      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&
      github.ref == 'refs/heads/main' &&
      inputs.cms_image_only != true &&
      inputs.publish_candidate_only != true
```

Do not change the job's `needs`, environment, timeout, concurrency, permissions, or steps.

- [ ] **Step 4: Document the explicit status guard**

After the normal-mode paragraph in `docs/operations/deployment.md`, state that `isolated-b0-recovery` is expected to skip in normal mode and that `Deploy production` deliberately uses `!cancelled()` plus direct `validate=success` to avoid implicit skipped-ancestor propagation. State that failed/cancelled validation and both special dispatch modes remain ineligible.

- [ ] **Step 5: Run focused and full verification**

```sh
node --test tests/unit/cms-image-pipeline.test.mjs tests/unit/operations-invariants.test.mjs
npm run verify
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 6: Commit the correction**

```sh
git add .github/workflows/ci.yml tests/unit/cms-image-pipeline.test.mjs tests/unit/operations-invariants.test.mjs docs/operations/deployment.md
git commit -m "fix(ci): restore production deploy eligibility"
```

### Task 2: Review, publish, and prove deployment

**Files:**
- No additional source changes expected.

**Interfaces:**
- Consumes: the verified Task 1 branch and GitHub Actions environment.
- Produces: a reviewed pull request and a successful production deployment of the exact merged commit.

- [ ] **Step 1: Obtain a fresh whole-branch review**

Review the branch against `origin/main` for exact condition semantics, fail-closed behavior, test coverage, documentation accuracy, and unchanged deployment steps. Fix all Critical or Important findings and re-run affected checks.

- [ ] **Step 2: Push and open a separate pull request**

Push `fix/deploy-production-condition`, open a PR against `main`, and link it to the active session. The PR must include the two reproduced skipped run IDs (`39946474596`, `39947566880`), root-cause explanation, test evidence, and explicit statement that no VPS change has occurred yet.

- [ ] **Step 3: Wait for the PR validate check**

Use `gh pr checks --watch` and require `validate` success. Do not merge automatically; report that the PR is ready for user approval.

- [ ] **Step 4: After user approval and merge, monitor main**

Watch the automatic push run for the merge commit. Confirm `validate` success and that `Deploy production` is created rather than skipped.

- [ ] **Step 5: Confirm the production receiver result**

Require the existing `Deploy with backup, migration, smoke and rollback` step to succeed. If it fails, inspect only the sanitized hosted logs and report whether rollback ran; do not bypass the workflow with SSH or manual VPS commands.

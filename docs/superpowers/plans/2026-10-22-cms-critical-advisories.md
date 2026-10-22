# CMS Critical Advisories Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the newly disclosed critical Next.js and DOMPurify findings from the CMS production dependency graph and restore the hosted `validate` gate.

**Architecture:** Keep the existing CMS dependency graph and change only two exact pins: Next.js 16.4.2 and the Monaco-specific DOMPurify override 3.4.17. Add a repository contract test for declarations and resolved lockfile versions, then verify the full application before publication.

**Tech Stack:** npm lockfile v3, Next.js, Payload CMS, Monaco Editor, DOMPurify, Node.js 24 test runner, GitHub Actions.

## Global Constraints

- Pin `next` to exactly `16.4.2`.
- Pin the `monaco-editor@0.57.0` override for `dompurify` to exactly `3.4.17`.
- Keep Payload `3.90.2`, Monaco Editor `0.57.0`, React `19.3.0`, esbuild `0.28.2`, and all other declared dependencies unchanged.
- Do not add npm audit exceptions or weaken the `high` audit threshold.
- Do not change application code, database schema, deployment scripts, Trivy policy, API dependencies, or cron dependencies.

---

### Task 1: Update and verify the CMS security pins

**Files:**
- Modify: `tests/unit/cms-image-pipeline.test.mjs`
- Modify: `cms/package.json:26,43-45`
- Modify: `cms/package-lock.json`
- Test: `tests/unit/cms-image-pipeline.test.mjs`

**Interfaces:**
- Consumes: exact fixed releases Next.js 16.4.2 and DOMPurify 3.4.17.
- Produces: an npm production graph with no high/critical audit finding and a static contract that prevents either vulnerable pin from returning.

- [ ] **Step 1: Add the failing dependency contract**

Add a test that parses `cms/package.json` and `cms/package-lock.json` and asserts:

```js
test('CMS pins the audited Next and DOMPurify security releases', async () => {
  const [manifest, lockfile] = await Promise.all([
    read('cms/package.json').then(JSON.parse),
    read('cms/package-lock.json').then(JSON.parse),
  ]);

  assert.equal(manifest.dependencies.next, '16.4.2');
  assert.equal(manifest.overrides['monaco-editor@0.57.0'].dompurify, '3.4.17');
  assert.equal(lockfile.packages['node_modules/next'].version, '16.4.2');
  assert.equal(lockfile.packages['node_modules/dompurify'].version, '3.4.17');
});
```

- [ ] **Step 2: Prove the contract initially fails**

Run `node --test tests/unit/cms-image-pipeline.test.mjs`.

Expected: FAIL because the manifest and lockfile still resolve Next.js 16.3.8 and DOMPurify 3.4.16.

- [ ] **Step 3: Apply only the approved exact pins**

Change `cms/package.json` to `"next": "16.4.2"` and the Monaco override to `"dompurify": "3.4.17"`. Regenerate only the CMS lockfile with:

```sh
npm install --prefix cms --package-lock-only --ignore-scripts
```

Confirm the lockfile diff contains only resolution/integrity changes required by these two upgrades and their exact dependency metadata.

- [ ] **Step 4: Install and run focused CMS validation**

```sh
npm ci --prefix cms
node --test tests/unit/cms-image-pipeline.test.mjs
npm run typecheck:cms
npm run test:cms
```

Expected: all commands exit 0.

- [ ] **Step 5: Run security and repository gates**

```sh
npm run security
npm run verify
git diff --check
```

Expected: all commands exit 0; npm reports zero high/critical production vulnerabilities for API, cron, and CMS.

- [ ] **Step 6: Commit the remediation**

```sh
git add cms/package.json cms/package-lock.json tests/unit/cms-image-pipeline.test.mjs
git commit -m "fix(cms): patch critical Next and DOMPurify advisories"
```

### Task 2: Publish and prove the hosted gate

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the verified Task 1 commit.
- Produces: a green hosted `validate` run on `main`, after which PR #63 may safely merge `main`.

- [ ] **Step 1: Merge the remediation into local main**

Fast-forward `main` from `fix/cms-critical-advisories` after confirming both trees are clean.

- [ ] **Step 2: Publish main**

Run `git push origin main` and record the resulting GitHub Actions run ID.

- [ ] **Step 3: Wait for authoritative validation**

Run `gh run watch <run-id> --exit-status`.

Expected: `validate` passes the three Trivy image scans and `npm run security`; deployment follows only the repository workflow's existing conditions.

- [ ] **Step 4: Update PR #63 only after main is green**

Merge `origin/main` into `fix/cards-pos-remove-lunch`, push without force, and wait for PR #63's `validate` check to complete successfully.

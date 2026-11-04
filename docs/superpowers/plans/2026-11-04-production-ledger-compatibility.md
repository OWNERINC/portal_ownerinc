# Production Ledger Compatibility Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the corrected API image release to pass production migration verification when the existing database contains the already-applied historical migrations `036_payload_editorial_control` and `037_owner_news_cutover`, then rerun the protected production pipeline and verify the live service read-only.

**Architecture:** Keep the repository's current 35-version migration set and its 038 write-protection migration unchanged. Add a pure, strict ledger-acceptance helper in `api/db/verify-migrations.js` that accepts either the current repository ledger or the production-shaped ledger with `036/037` inserted before `038`; it rejects unknown, missing, duplicated, or reordered versions. Unit tests exercise both accepted ledgers and invalid variants without connecting to a database. The existing migration runner remains responsible for applying only files present in the release, so `038` is applied once and the deploy receiver's backup/rollback behavior is unchanged.

**Tech Stack:** Node.js 24, CommonJS API database verifier, Node test runner, PostgreSQL migrations, GitHub Actions, Docker/Trivy, protected production deploy receiver.

## Global Constraints

- Preserve `multer` `^2.5.0`, `sharp` `^0.35.5`, and the fixed transitive security overrides already merged to `main`.
- Keep the existing image scanner, HIGH/CRITICAL dependency gate, SBOM generation, immutable GHCR digests, and deployment receiver validation unchanged.
- Treat `036_payload_editorial_control` and `037_owner_news_cutover` as historical ledger markers only; do not re-add their SQL files, CMS code, Owner News runtime, or new data writes.
- Keep `038_disable_legacy_editorial_writes.sql` unchanged and ensure its effective privilege checks remain mandatory.
- Preserve migrations, historical tables, uploads, grants outside the denied editorial matrix, and production data; do not run destructive SQL manually.
- Do not execute the mutable migration harness against production; production validation is performed only by the protected deploy's existing backup/migration/verification/smoke/rollback flow.
- Do not weaken or bypass any CI security or deploy gate.
- Production is successful only when the new `main` workflow completes `validate`, image publication, `Deploy production`, and the post-deploy smoke/rollback gates, followed by a read-only live check.

---

### Task 1: Add strict ledger compatibility coverage

**Files:**
- Create: `tests/unit/migration-ledger-compatibility.test.mjs`
- Test: `api/db/verify-migrations.js`

**Interfaces:**
- Consumes: the exported ledger constants/helper from `api/db/verify-migrations.js`.
- Produces: executable unit coverage proving that the current 35-version ledger and the production-shaped ledger with `036/037` are the only accepted forms.

- [x] **Step 1: Write the failing unit test for the two accepted ledgers**

Create a Node test that imports `expectedVersions`, `historicalVersions`, `historicalExpectedVersions`, and `isAcceptedMigrationLedger` through `createRequire`. Assert:

```js
assert.deepEqual(historicalVersions, [
  '036_payload_editorial_control',
  '037_owner_news_cutover',
]);
assert.equal(isAcceptedMigrationLedger(expectedVersions), true);
assert.equal(isAcceptedMigrationLedger(historicalExpectedVersions), true);
```

Also assert that these variants are rejected:

```js
assert.equal(isAcceptedMigrationLedger([...historicalExpectedVersions, '039_unknown']), false);
assert.equal(isAcceptedMigrationLedger(historicalExpectedVersions.filter((version) => version !== '037_owner_news_cutover')), false);
assert.equal(isAcceptedMigrationLedger([
  ...historicalExpectedVersions.slice(0, -1),
  '038_disable_legacy_editorial_writes',
  '037_owner_news_cutover',
]), false);
```

- [x] **Step 2: Run the new test and confirm the current verifier lacks the helper**

Run:

```powershell
node --test tests/unit/migration-ledger-compatibility.test.mjs
```

Expected: FAIL because the verifier does not yet export the historical ledger constants/helper.

### Task 2: Implement the minimal verifier compatibility model

**Files:**
- Modify: `api/db/verify-migrations.js:3-39,72-80,398`
- Test: `tests/unit/migration-ledger-compatibility.test.mjs`

**Interfaces:**
- Consumes: the ordered `expectedVersions` array already used by migration tests.
- Produces: `historicalVersions`, `historicalExpectedVersions`, and `isAcceptedMigrationLedger(appliedVersions)`; `verifyMigrations()` uses this helper before schema and privilege checks.

- [x] **Step 1: Define the historical versions and the production-shaped ledger**

Immediately after `expectedVersions`, add:

```js
const historicalVersions = Object.freeze([
  '036_payload_editorial_control',
  '037_owner_news_cutover',
]);
const historicalExpectedVersions = Object.freeze([
  ...expectedVersions.slice(0, -1),
  ...historicalVersions,
  expectedVersions.at(-1),
]);

function isAcceptedMigrationLedger(appliedVersions) {
  return [expectedVersions, historicalExpectedVersions]
    .some((accepted) => JSON.stringify(appliedVersions) === JSON.stringify(accepted));
}
```

Keep the comparison exact and order-sensitive; do not use a set or a subset check.

- [x] **Step 2: Replace the single-ledger comparison with the strict helper**

Change the verifier condition to:

```js
if (!isAcceptedMigrationLedger(appliedVersions)) {
  throw new Error(`Unexpected migration ledger: ${appliedVersions.join(',')}`);
}
```

Do not alter any later structural, grant, or editorial privilege checks.

- [x] **Step 3: Export the helper and constants for unit coverage**

Update the CommonJS export to:

```js
module.exports = {
  expectedVersions,
  historicalVersions,
  historicalExpectedVersions,
  isAcceptedMigrationLedger,
  verifyMigrations,
};
```

- [x] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
node --test tests/unit/migration-ledger-compatibility.test.mjs
```

Expected: all accepted and rejected ledger assertions pass.

- [x] **Step 5: Commit the focused verifier change**

Run:

```powershell
git add api/db/verify-migrations.js tests/unit/migration-ledger-compatibility.test.mjs
git commit -m "fix: accept historical production migration ledger"
```

### Task 3: Run repository and security validation

**Files:**
- Test: `api/db/verify-migrations.js`
- Test: `tests/unit/migration-ledger-compatibility.test.mjs`
- Test: existing repository suites and security gates

**Interfaces:**
- Consumes: the focused verifier commit.
- Produces: evidence that vulnerability remediation, application behavior, migration contracts, and CI invariants remain green.

- [x] **Step 1: Run the migration-ledger and operations-focused tests**

Run:

```powershell
node --test tests/unit/migration-ledger-compatibility.test.mjs tests/unit/operations-invariants.test.mjs tests/unit/schema-invariants.test.mjs
```

Expected: all tests pass, including the existing assertions that `038` is present and editorial runtime privileges are denied.

- [x] **Step 2: Run the full verification and dependency security checks**

Run:

```powershell
npm run verify
npm run security
git diff --check
```

Expected: the full suite passes; security has no HIGH/CRITICAL findings; any existing MODERATE-only notices remain below the configured gate; diff check passes.

- [x] **Step 3: Confirm the change does not reintroduce removed runtime surfaces**

Run:

```powershell
git diff -- api/db/migrations api api/owner-news public nginx
git status --short --untracked-files=all
```

Expected: only the verifier and its unit test are changed by this fix; no historical migration file is recreated and no CMS/Owner News runtime file is added.

### Task 4: Publish the compatibility fix through protected CI

**Files:**
- No workflow changes; use the existing `.github/workflows/ci.yml`.

**Interfaces:**
- Consumes: the validated compatibility commit and the already-merged API image security fix.
- Produces: a PR with passing image scan/security checks, a protected merge, and a new `main` workflow using fully-qualified immutable GHCR digests.

- [x] **Step 1: Push the branch and open a focused PR**

Run:

```powershell
git push origin rewrite/portal-sem-cms
$body = @'
## Objetivo
Aceitar o ledger histórico já presente na produção, que contém as migrations 036/037, sem reintroduzir CMS/Owner News e permitir o deploy da imagem API já aprovada pelo scanner.

## Correção
- O verificador aceita somente o ledger atual ou o ledger atual com `036_payload_editorial_control` e `037_owner_news_cutover` entre 035 e 038.
- A ordem, ausência de duplicatas e rejeição de versões desconhecidas continuam estritas.
- Nenhum arquivo de migration histórico é recriado; 038 e os checks de privilégios editoriais permanecem inalterados.

## Evidências esperadas
O PR deve passar pelos mesmos checks de imagem, segurança, SBOM, migrations e validações do CI. A promoção só será considerada concluída após Deploy production e smoke read-only no domínio oficial.
'@
$prUrl = $body | gh pr create --repo OWNERINC/portal_ownerinc --base main --head rewrite/portal-sem-cms --title "Fix production migration ledger compatibility" --body-file -
$prNumber = ($prUrl.Trim() -split '/')[-1]
gh pr checks $prNumber --repo OWNERINC/portal_ownerinc --watch --interval 10
```

Expected: GitHub returns the PR URL, `$prNumber` resolves to that PR, and validation, image builds, Trivy scans, the HIGH/CRITICAL dependency gate, SBOMs, and migration tests pass. Do not merge if any required check fails.

- [x] **Step 3: Merge through the normal protected path**

Run only after PR checks are green:

```powershell
gh pr merge $prNumber --repo OWNERINC/portal_ownerinc --merge --delete-branch=false
```

Expected: GitHub reports a merge commit on `main` and starts a new push workflow.

### Task 5: Monitor deploy, rollback gates, and live read-only smoke

**Files:**
- No source changes unless a new failure is observed and its smallest fix is approved by the evidence.

**Interfaces:**
- Consumes: the merged compatibility commit and its main workflow.
- Produces: observed results for image publication, remote backup, migration verification, smoke, rollback behavior, and live read-only endpoints.

- [x] **Step 1: Watch every main workflow job**

Run:

```powershell
gh run list --repo OWNERINC/portal_ownerinc --branch main --limit 3
$runId = gh run list --repo OWNERINC/portal_ownerinc --branch main --limit 1 --json databaseId --jq '.[0].databaseId'
gh run watch $runId --repo OWNERINC/portal_ownerinc --exit-status
```

Expected: `validate`, image publication, and `Deploy production` all pass; the deploy log confirms migration verification accepts the production ledger and the smoke gate succeeds.

- [x] **Step 2: If the deploy fails, inspect the exact failed log before editing**

Run:

```powershell
$runId = gh run list --repo OWNERINC/portal_ownerinc --branch main --limit 1 --json databaseId --jq '.[0].databaseId'
gh run view $runId --repo OWNERINC/portal_ownerinc --log-failed
```

Expected: either a successful deployment/rollback result or one concrete observed failure. Do not perform manual production SQL or bypass rollback/security gates.

- [ ] **Step 3: Run the read-only live smoke after a successful deploy**

Run from an environment with Bash and curl:

```bash
BASE_URL=https://portal.ownerinc.com.br bash scripts/smoke.sh
```

Expected: `{"check":"smoke","status":"ok",...}`. The command performs GET-only checks for health, readiness, same-origin health, root, login, AutoCard shell/router/entry, and the legacy redirect.

- [ ] **Step 4: Record evidence in OWN-49**

Record the compatibility commit, PR, main workflow URL, scan/security result, deploy result, migration verification result, smoke result, and whether rollback was invoked. Do not include secrets, credentials, private payloads, or raw production data.

### Task 6: Keep post-smoke backup retention failures non-fatal

**Files:**
- Modify: `ops/deploy-from-ci.sh:484`
- Modify: `tests/unit/operations-invariants.test.mjs:380-426`
- Modify: `docs/operations/deployment.md:78-86`

**Interfaces:**
- Consumes: the validated release, completed migration verification, readiness, and read-only smoke.
- Produces: a successful release transition even when an old backup directory is not removable by the deploy user, with a bounded warning for operator follow-up.

- [x] **Step 1: Add a failing invariant for guarded retention cleanup**

Extend the deployment invariants to require that the post-smoke `find "$backup_root" ... rm -rf` operation runs inside an `if ! ...; then` guard and logs that retention is incomplete while continuing with the validated release.

- [x] **Step 2: Run the focused invariant test and confirm the current cleanup is fatal**

Run:

```powershell
node --test tests/unit/operations-invariants.test.mjs
```

Expected: FAIL because the current retention command is unguarded and a permission error reaches the deployment rollback trap.

- [x] **Step 3: Make only post-smoke retention cleanup best-effort**

Replace the unguarded command:

```bash
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +
```

with:

```bash
if ! find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +; then
  echo "Backup retention cleanup incomplete; continuing with the validated $target release." >&2
fi
```

Do not make backup creation, checksum verification, migration, readiness, smoke, or cron health best-effort. Only the housekeeping deletion after a successful public smoke may continue after a failure.

- [x] **Step 4: Document the operator follow-up without changing the VPS**

Update the release flow documentation to state that retention permission failures are warnings after smoke, the release remains active, and root-owned historical backup directories require a separate authorized VPS permissions cleanup.

- [x] **Step 5: Run focused and full validation**

Run:

```powershell
node --test tests/unit/operations-invariants.test.mjs
npm run verify
npm run security
git diff --check
```

Expected: all tests and security gates pass, with no scanner or rollback bypass.

- [x] **Step 6: Commit the retention behavior fix**

Run:

```powershell
git add ops/deploy-from-ci.sh tests/unit/operations-invariants.test.mjs docs/operations/deployment.md
git commit -m "fix: keep retention cleanup from rolling back releases"
```

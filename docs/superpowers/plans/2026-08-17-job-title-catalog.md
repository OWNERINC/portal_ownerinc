# Job Title Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active job-title catalog with the approved standardized list, migrate the two approved DHO nomenclatures, and restrict AutoCard access to the new RH titles.

**Architecture:** A new idempotent PostgreSQL migration seeds the canonical active catalog, preserves old rows as inactive, and moves users from the two explicitly mapped DHO titles to their RH equivalents. The API policy becomes the single source of truth for AutoCard title access; the existing admin API/UI automatically consumes active job titles.

**Tech Stack:** PostgreSQL migrations, Express policy middleware, static admin UI, Node.js 24, Node test runner, migration integration checks.

## Global Constraints

- Keep the existing `users.job_title_id` foreign key with `ON DELETE RESTRICT`.
- Do not delete historical job-title rows or leave assigned users without a readable title.
- Active catalog names are exactly the standardized list in `docs/superpowers/specs/2026-08-17-job-title-catalog-design.md`.
- AutoCard access is allowed only for `Analista de RH Sênior` and `Gerente de RH`.
- `Assistente de DHO` and `Coordenador de DHO` remain inactive and are not migrated automatically.
- Continue normalizing AutoCard comparisons with `toLocaleLowerCase('pt-BR')`.
- Keep API and `api/`/`public/` boundaries; do not add client-side access bypasses.
- Migrations must be idempotent and run before the production smoke test.

---

### Task 1: Seed and migrate the PostgreSQL job-title catalog

**Files:**
- Create: `api/db/migrations/013_job_title_catalog.sql`
- Modify: `api/db/verify-migrations.js`
- Modify: `scripts/test-migrations.mjs`
- Modify: `tests/unit/schema-invariants.test.mjs`
- Test: `scripts/test-migrations.mjs`

**Interfaces:**
- Produces migration version `013_job_title_catalog` in `schema_migrations`.
- Preserves the existing `job_titles` and `users.job_title_id` schema.
- Leaves active rows matching the canonical list and migrates users assigned to the two mapped DHO rows.

- [ ] **Step 1: Extend static migration expectations before implementation.**

  Add `013_job_title_catalog` to the expected ordered migration arrays in `api/db/verify-migrations.js`, `scripts/test-migrations.mjs`, and `tests/unit/schema-invariants.test.mjs`. Add static assertions that the new migration contains `job_titles`, `users`, `Analista de DHO`, `Analista de RH Sênior`, `Gerente de DHO`, `Gerente de RH`, and `active = FALSE`.

- [ ] **Step 2: Run the focused static migration test and confirm it fails.**

  Run:

  ```text
  node --test tests/unit/schema-invariants.test.mjs
  ```

  Expected result: the new migration file/version assertions fail because `013_job_title_catalog.sql` does not exist yet.

- [ ] **Step 3: Create the idempotent catalog migration.**

  The migration must use one transaction supplied by the migration runner and follow this order:

  ```sql
  WITH desired(name) AS (VALUES
    ('Analista Administrativo'), ('Analista de Cobrança'), ('Analista de Engenharia'),
    ('Analista de Pós-Vendas'), ('Analista de RH Sênior'),
    ('Analista de Departamento Pessoal'), ('Analista Financeiro'),
    ('Analista Financeiro Sênior'), ('Assistente Administrativo'),
    ('Auxiliar de Limpeza'), ('CEO'), ('Consultor de Vendas'),
    ('Consultora de Pós-Vendas'), ('Consultora de Pós-Vendas Júnior'),
    ('Consultora de Pós-Vendas Pleno'), ('Coordenador Central de Férias'),
    ('Coordenador de Compras'), ('Coordenador de Contratos'), ('Coordenador de Sala'),
    ('Coordenador Financeiro'), ('Coordenador de Pós-Vendas'),
    ('Coordenadora Administrativa'), ('Coordenadora de Planejamento'),
    ('Coordenadora de Projetos'), ('Coordenadora de Vendas'), ('Design'),
    ('Diretor Comercial'), ('Diretor de Incorporação'), ('Diretor de Marketing'),
    ('Engenheiro Civil'), ('Especialista de Controladoria'),
    ('Especialista de Marketing'), ('Garçom'), ('Garçom Sênior'), ('Garçonete'),
    ('Gerente Administrativo'), ('Gerente Comercial'), ('Gerente de Marketing'),
    ('Gerente de Obra'), ('Gerente de Pós-Vendas'), ('Gerente de Promoção'),
    ('Gerente de RH'), ('Jovem Aprendiz'), ('Líder de Promoção'), ('Motorista'),
    ('Promotor de Vendas'), ('Recepcionista'), ('Redator'), ('SDR'), ('Social Media')
  )
  INSERT INTO job_titles (name, active)
  SELECT name, TRUE FROM desired
  ON CONFLICT DO UPDATE SET name = EXCLUDED.name, active = TRUE, updated_at = NOW();
  ```

  Use a canonical case-insensitive comparison for the subsequent operations. Move users whose current title is `Analista de DHO` to the canonical `Analista de RH Sênior`, and users whose current title is `Gerente de DHO` to `Gerente de RH`. Then set `active = FALSE` for every title whose lowercased name is not in the canonical list. Keep `Assistente de DHO` and `Coordenador de DHO` as inactive rows and never delete any row.

- [ ] **Step 4: Add integration assertions for the post-migration catalog.**

  After the existing migration version assertion in `scripts/test-migrations.mjs`, query `job_titles` and assert that the active names equal the 50 canonical names sorted by `lower(name)`, that both mapped DHO titles have zero assigned users, that `Analista de RH Sênior` and `Gerente de RH` receive those assignments, and that `Assistente de DHO` and `Coordenador de DHO` are inactive when present.

- [ ] **Step 5: Run migration and static tests.**

  Run:

  ```text
  node --test tests/unit/schema-invariants.test.mjs
  npm run test:migrations
  ```

  Expected result: static tests pass and the migration integration check passes twice, proving idempotence.

- [ ] **Step 6: Commit the migration task.**

  ```text
  git add api/db/migrations/013_job_title_catalog.sql api/db/verify-migrations.js scripts/test-migrations.mjs tests/unit/schema-invariants.test.mjs
  git commit -m "feat: update job title catalog"
  ```

### Task 2: Update AutoCard access policy and regression tests

**Files:**
- Modify: `api/middleware/policy.js`
- Modify: `tests/unit/autocard-invariants.test.mjs`
- Modify: `docs/operations/v1-release-checklist.md`

**Interfaces:**
- `canUseAutoCard(user)` keeps its current input and boolean return value.
- `AUTOCARD_JOB_TITLES` contains exactly the two approved canonical titles.

- [ ] **Step 1: Update the access regression test.**

  Change the allowlist test to assert `true` for `Analista de RH Sênior` and `Gerente de RH`, and `false` for `Analista de RH`, all four old DHO names, `DHO Manager`, `Gerente de Pessoas`, an empty title, and a super-admin with an unrelated title.

- [ ] **Step 2: Run the focused AutoCard test and confirm it fails against the old policy.**

  Run:

  ```text
  node --test tests/unit/autocard-invariants.test.mjs
  ```

  Expected result: the old DHO allowlist assertions fail after the test expectation changes.

- [ ] **Step 3: Replace the policy allowlist.**

  Set the `AUTOCARD_JOB_TITLES` set in `api/middleware/policy.js` to:

  ```js
  const AUTOCARD_JOB_TITLES = new Set([
    'analista de rh sênior',
    'gerente de rh',
  ]);
  ```

  Keep `canUseAutoCard`'s `String(...).trim().toLocaleLowerCase('pt-BR')` normalization unchanged.

- [ ] **Step 4: Update the release checklist.**

  Replace the four DHO AutoCard access checks with the two approved RH titles, and keep the negative checks for a user without an approved title and an admin without an approved title.

- [ ] **Step 5: Run the focused AutoCard tests and commit.**

  Run `node --test tests/unit/autocard-invariants.test.mjs`, expect all tests to pass, then commit:

  ```text
  git add api/middleware/policy.js tests/unit/autocard-invariants.test.mjs docs/operations/v1-release-checklist.md
  git commit -m "fix: align AutoCard access with RH titles"
  ```

### Task 3: Verify admin catalog behavior and repository contracts

**Files:**
- Modify: `tests/unit/operations-invariants.test.mjs`
- Modify: `tests/unit/frontend-invariants.test.mjs` only if an existing job-title UI invariant needs a catalog assertion

**Interfaces:**
- `GET /api/job-titles` continues to return active titles by default.
- Existing user edit forms continue to submit `job_title_id` without embedding a hardcoded title list.

- [ ] **Step 1: Add a contract test for active-only job-title loading.**

  Assert that `api/routes/job-titles.js` retains `WHERE jt.active = TRUE` for the default list and that `public/js/admin.js` loads `/api/job-titles` rather than defining a separate client-side catalog. This prevents the UI from drifting from the migration.

- [ ] **Step 2: Run the focused contract tests.**

  Run `node --test tests/unit/operations-invariants.test.mjs tests/unit/frontend-invariants.test.mjs` and expect all tests to pass.

- [ ] **Step 3: Commit only if this task changed tests.**

  ```text
  git add tests/unit/operations-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
  git commit -m "test: cover active job title catalog contract"
  ```

### Task 4: Full verification, deployment, and live validation

**Files:**
- Verify all changed files from Tasks 1-3.

**Interfaces:**
- The deployed migration must leave the active catalog and AutoCard policy consistent.

- [ ] **Step 1: Run the complete local verification.**

  Run `npm run verify`, `npm run test:migrations`, and `git diff --check`. Confirm the migration list includes `013_job_title_catalog` and no tracked files contain the old AutoCard allowlist as an active rule.

- [ ] **Step 2: Inspect and commit the final diff.**

  Run `git status --short`, `git diff --stat`, `git diff --check`, and `git log --oneline -10`. Commit only intended files with `feat: update job title catalog and access rules` if prior tasks did not already create the final integration commit.

- [ ] **Step 3: Push `main` and monitor CI/deploy.**

  Run `git push origin main` and wait for the validation and production deploy jobs to succeed. The deploy applies migration `013_job_title_catalog` before smoke tests.

- [ ] **Step 4: Validate production.**

  Confirm `https://portal.ownerinc.com.br` returns HTTP 200, then verify in the admin UI that the active list contains the approved catalog and that AutoCard access works for `Analista de RH Sênior` and `Gerente de RH` while old DHO titles do not receive access.

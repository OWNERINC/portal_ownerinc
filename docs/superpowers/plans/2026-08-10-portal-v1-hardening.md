# Portal Ownerinc V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the current Portal Ownerinc implementation into a locally verified V1 with native AutoCard integration, complete bounded lists, reliable notification operations, S3-compatible backups, SMTP alerts, accessibility coverage, and an explicit production handoff.

**Architecture:** Preserve the static HTML frontend, Express API, PostgreSQL, cron, Nginx, and Docker Compose boundaries. Integrate AutoCard into the existing Portal shell without replacing the duplicated static shell with a runtime SPA. Add only focused backend helpers, migrations, scripts, tests, and operational documentation where the approved V1 design requires them.

**Tech Stack:** Node 24, vanilla JavaScript modules, Express, PostgreSQL 16, Firebase Auth/Admin, SendGrid, SMTP, Docker Compose, Nginx, Bash, and the existing dependency set.

## Global Constraints

- Implement the approved V1 scope only; do not add WhatsApp, LMS progress, benefits redemption, PJ invoice processing, MFA, social login, dark mode, native mobile, or Sólides write access.
- Keep `/autocard/` as the canonical AutoCard URL and render it inside the Portal shell.
- Keep AutoCard authorization restricted to the exact normalized DHO job titles already defined in `api/middleware/policy.js`.
- Remove the PJ invoice CTA from the V1 dashboard.
- Keep V1 notifications email-only and keep Sólides release stage `off`.
- Use RPO 24 hours and RTO 4 hours for operations documentation and checks.
- Keep Firebase, SMTP, S3, VPS, TLS, and production credentials out of source control.
- Use Node 24 as the official project runtime; do not introduce Node 24-only application APIs without a concrete need.
- Preserve API, cron, public, and Nginx boundaries.
- Preserve LF line endings in shell, Docker, and Nginx files.
- Keep database writes protected by migrations, constraints, transactions where already established, and least-privilege runtime roles.
- Every new branch, parser, query contract, or operational script must leave one executable regression check.
- Run `npm run verify` and `git diff --check` before each implementation checkpoint.

---

## File Map

### AutoCard shell

- Modify: `public/autocard/index.html` to adopt the Portal shell and place the existing editor inside `main.page-body`.
- Modify: `public/autocard/styles.css` to scope editor styles below the Portal shell without changing card-canvas output styles.
- Modify: `public/autocard/entry.js` and `public/autocard/guard.js` to preserve auth/access failures inside the Portal main region.
- Modify: `public/autocard/app.js` to use the namespaced API paths and bounded history pagination.
- Modify: `tests/unit/autocard-invariants.test.mjs` and `tests/unit/frontend-invariants.test.mjs` for shell, active navigation, and guard contracts.

### Public lists and dashboard

- Modify: `api/routes/knowledge.js` for server-side search/category filtering and `GET /api/knowledge/categories`.
- Modify: `api/routes/academy.js` and `api/routes/benefits.js` for explicit filtering/pagination behavior and category metadata endpoints.
- Modify: `public/js/knowledge.js`, `public/js/academy.js`, and `public/js/benefits.js` for server pagination/filter state and accessible controls.
- Modify: `public/knowledge.html`, `public/academy.html`, and `public/benefits.html` for pagination containers and filter status.
- Modify: `api/routes/reminders.js` for `GET /api/reminders/upcoming`, individual audience validation, and delivery history contracts.
- Modify: `public/js/dashboard.js` and `public/dashboard.html` to remove the PJ invoice card and request enough reminder data for the next-seven-day view.

### Administration and notifications

- Modify: `public/js/reminders.js` and `public/reminders.html` for individual audience editing and delivery history filters/pagination.
- Modify: `public/js/admin.js` and `public/admin.html` for Ombudsman filters, audit pagination, and complete delivery/audit views.
- Modify: `cron/checkReminders.js`, `cron/health.js`, `cron/index.js`, and `cron/sendEmail.js` for failure classification and SMTP operational alerts while preserving SendGrid reminder delivery.
- Create: `cron/sendOperationalAlert.js` as the isolated SMTP alert transport.
- Modify: `cron/package.json` and `cron/package-lock.json` to add the minimum SMTP transport dependency required by the cron image.

### Backup and operations

- Modify: `scripts/backup.sh` to expose a stable backup artifact contract and invoke optional external transfer only after a verified local backup.
- Create: `scripts/backup-s3.sh` for S3-compatible upload, preflight, checksum verification, retention metadata, and failure behavior.
- Modify: `scripts/restore.sh` and `scripts/smoke.sh` for documented restore verification and local V1 smoke coverage.
- Modify: `docker-compose.yml`, `.env.example`, and deployment docs only for explicitly required operational variables and checks.
- Modify: `docs/operations/deployment.md`, `docs/operations/local-development.md`, and a new V1 release checklist for RPO/RTO, SMTP alerts, S3, TLS, firewall, restore, and rollback.

### Tests and documentation

- Modify: `tests/unit/operations-invariants.test.mjs` for S3, alert, backup, restore, and release contracts.
- Modify: `tests/unit/notification-scheduling.test.mjs` and route tests for individual audiences, delivery history, and alert boundaries.
- Modify: `tests/unit/repository-boundaries.test.mjs`, `tests/unit/schema-invariants.test.mjs`, and `tests/unit/frontend-invariants.test.mjs` for new files and security/UI contracts.
- Modify: `scripts/test-migrations.mjs` only if the schema changes during implementation.
- Modify: `docs/product/feature-inventory.md` and `docs/product/roadmap.md` after each V1 capability is actually verified.

## Implementation Tasks

### Task 1: Establish the V1 verification baseline

**Files:**
- Read: `docs/superpowers/specs/2026-08-10-portal-v1-hardening-design.md`
- Read: `package.json`, `api/package.json`, `cron/package.json`, `docker-compose.yml`
- Modify: `tests/unit/operations-invariants.test.mjs` only if the baseline exposes an existing false invariant.

**Interfaces:**
- Consumes: current repository at commit `b8170f9`.
- Produces: a recorded baseline of `npm run verify`, migration integration, and Docker availability without changing behavior.

- [ ] **Step 1: Confirm the current tree and branch.**

Run:

```powershell
git status --short
git log --oneline -5
```

Expected: clean worktree at the approved design commit or an explicitly documented user change.

- [ ] **Step 2: Run the static verification baseline.**

Run:

```powershell
npm run verify
git diff --check
```

Expected: all existing checks pass; record any pre-existing failure before editing.

- [ ] **Step 3: Run migration integration when PostgreSQL is available.**

Run the repository's migration test in the PostgreSQL network:

```powershell
docker compose run --rm --entrypoint node -w /workspace -v "${PWD}:/workspace" -v "${PWD}\api\node_modules:/workspace/api/node_modules" migrate scripts/test-migrations.mjs
```

Expected: migration integration passes twice and verifies the ledger, tables, and runtime roles. If Docker or required environment variables are unavailable, record that as an environment prerequisite rather than changing credentials.

- [ ] **Step 4: Commit the baseline note only if a new test contract was required.**

```powershell
git add tests/unit/operations-invariants.test.mjs
git commit -m "test: establish Portal V1 verification baseline"
```

Do not create an empty commit when no baseline change is needed.

### Task 2: Integrate AutoCard into the Portal shell

**Files:**
- Modify: `public/autocard/index.html`
- Modify: `public/autocard/styles.css`
- Modify: `public/autocard/entry.js`
- Modify: `public/autocard/guard.js`
- Modify: `public/autocard/app.js`
- Modify: `public/js/auth.js` only if the active-link state needs a shared contract.
- Modify: `tests/unit/autocard-invariants.test.mjs`
- Modify: `tests/unit/frontend-invariants.test.mjs`

**Interfaces:**
- Consumes: `requireAutoCard()`, `sidebar.js`, Portal shell markup, and `/api/autocard/*`.
- Produces: `/autocard/` with `.portal-wrapper`, `.sidebar`, `.main-content`, `.topbar`, `.page-body#main-content`, an active AutoCard link, and the existing editor IDs unchanged.

- [ ] **Step 1: Add failing shell invariants.**

Add assertions that `public/autocard/index.html` contains the Portal landmarks and does not contain the old standalone AutoCard topbar as the page shell:

```js
assert.match(html, /class="portal-wrapper"/);
assert.match(html, /class="sidebar"/);
assert.match(html, /class="page-body"[^>]+id="main-content"/);
assert.match(html, /href="\.\/autocard\/"[^>]+class="active"/);
assert.match(html, /id="templateGallery"/);
assert.doesNotMatch(html, /<header class="topbar">[\s\S]*AutoCard DHO/);
```

Run:

```powershell
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
```

Expected: the new shell assertions fail against the current standalone page.

- [ ] **Step 2: Move the existing application markup into the Portal shell.**

Keep these IDs unchanged: `templateGallery`, `editorView`, `fields`, `cardCanvas`, `savedView`, `savedSearch`, `savedFilters`, `savedList`, `savedEmpty`, `assetDialog`, `assetGrid`, and `toast`. Place the application markup inside `main#main-content`, include the shared Portal CSS/scripts, and mark the AutoCard sidebar link active.

- [ ] **Step 3: Scope AutoCard styles to the page body.**

Remove standalone body layout rules that assume a full viewport topbar. Prefix page-level selectors with an AutoCard root class and preserve card canvas classes. Set the AutoCard root to use the Portal page-body width and prevent global overflow at 320 px.

- [ ] **Step 4: Keep guard failures inside the Portal main region.**

Change `guard.js` to replace `#main-content` contents instead of `document.body`, retain the heading and return link, and focus the `main` region. Keep `requireAuth()` as the authentication source and keep `/api/autocard/access` as the server authorization check.

- [ ] **Step 5: Switch editor requests to the canonical namespace.**

Use these exact paths in `app.js`:

```text
GET    /api/autocard/cards
POST   /api/autocard/cards
GET    /api/autocard/cards/:id
PUT    /api/autocard/cards/:id
POST   /api/autocard/cards/:id/duplicate
DELETE /api/autocard/cards/:id
POST   /api/autocard/media
```

Preserve the legacy aliases in the API until all client calls and tests use the namespaced paths.

- [ ] **Step 6: Run shell and editor checks.**

Run:

```powershell
node --test tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
npm run verify
git diff --check
```

Expected: shell, authorization, editor IDs, and existing tests pass.

- [ ] **Step 7: Commit the shell integration.**

```powershell
git add public/autocard public/js/auth.js tests/unit/autocard-invariants.test.mjs tests/unit/frontend-invariants.test.mjs
git commit -m "feat: integrate AutoCard into Portal shell"
```

### Task 3: Complete public content pagination and filtering

**Files:**
- Modify: `api/routes/knowledge.js`
- Modify: `public/js/knowledge.js`
- Modify: `public/knowledge.html`
- Modify: `public/js/academy.js`
- Modify: `public/academy.html`
- Modify: `public/js/benefits.js`
- Modify: `public/benefits.html`
- Modify: `tests/unit/governance-routes.test.mjs`
- Modify: `tests/unit/frontend-invariants.test.mjs`

**Interfaces:**
- Consumes: existing `parseListQuery()`, `X-Total-Count`, `GET /api/knowledge`, `GET /api/academy`, and `GET /api/benefits`.
- Produces: bounded server-side query contracts that preserve active-content filtering and allow public pages to navigate all available records.

- [ ] **Step 1: Add backend query-contract tests.**

Cover these requests and outcomes:

```text
GET /api/knowledge?limit=20&offset=20&q=viagem&category=Financeiro
GET /api/academy?active=true&limit=20&offset=20&category=Liderança
GET /api/benefits?active=true&limit=20&offset=20&category=Saúde
```

Assert that public results exclude inactive rows, filters are parameterized, counts are returned, and unknown query parameters are rejected with `400`.

- [ ] **Step 2: Implement server-side knowledge filters.**

Accept only `q`, `category`, `limit`, and `offset` for the list route. Apply escaped case-insensitive matching to title/content and exact category matching using query parameters. Keep content rendered as text on the frontend.

- [ ] **Step 3: Add reusable frontend pagination state per page.**

Use the existing `page`, `pageSize`, and `X-Total-Count` pattern. Each page must update the URL with its filters and offset, restore state on load, and expose previous/next controls with disabled states and an accessible status.

- [ ] **Step 4: Move Knowledge search/category filtering to the server.**

`loadArticles()` must send the current URL filters and offset; `render()` must no longer filter only the loaded first page. Preserve `article` deep links and Back/Forward behavior.

- [ ] **Step 5: Add category metadata and public Academy/Benefits pagination.**

Add `GET /api/knowledge/categories`, `GET /api/academy/categories`, and `GET /api/benefits/categories`. Each endpoint returns a sorted JSON array of distinct non-empty categories visible to the current user; public endpoints include active rows only, and admin requests retain the existing permission gate. Keep category grouping for the current page, populate filters from these endpoints, and do not load all records into the browser.

- [ ] **Step 6: Verify content behavior.**

Run:

```powershell
node --test tests/unit/governance-routes.test.mjs tests/unit/frontend-invariants.test.mjs
npm run verify
git diff --check
```

- [ ] **Step 7: Commit public pagination.**

```powershell
git add api/routes/knowledge.js public/js/knowledge.js public/knowledge.html public/js/academy.js public/academy.html public/js/benefits.js public/benefits.html tests/unit/governance-routes.test.mjs tests/unit/frontend-invariants.test.mjs
git commit -m "feat: complete public content pagination"
```

### Task 4: Correct dashboard and reminder administration

**Files:**
- Modify: `public/js/dashboard.js`
- Modify: `public/dashboard.html`
- Modify: `public/js/reminders.js`
- Modify: `public/reminders.html`
- Modify: `api/routes/reminders.js` only if explicit UID validation or response fields need correction.
- Modify: `tests/unit/api-routes.test.mjs`
- Modify: `tests/unit/notification-scheduling.test.mjs`
- Modify: `tests/unit/frontend-invariants.test.mjs`

**Interfaces:**
- Consumes: `/api/reminders`, `/api/reminders/deliveries`, `resolveTargets()`, and the existing reminder ledger.
- Produces: correct seven-day dashboard display, editable explicit UID audiences, and complete delivery-history controls without enabling WhatsApp.

- [ ] **Step 1: Add failing dashboard invariants.**

Assert that `dashboard.html` no longer contains `pj-card`, `pj-status`, or a visible Nota Fiscal label, and that `dashboard.js` does not render a PJ invoice branch.

- [ ] **Step 2: Remove the PJ card and preserve unrelated dashboard behavior.**

Remove only the invoice card markup and its rendering branch. Keep contract detection for other contract-specific links and keep the Sólides release gate behavior unchanged.

- [ ] **Step 3: Add and consume the upcoming-reminders contract.**

Add `GET /api/reminders/upcoming` before the root list route. It accepts only `days=7`, applies the existing authenticated audience scope, calculates each monthly `next_occurrence` with Brasilia calendar rules and month-end clamping, and returns rows ordered by `next_occurrence, id`. Update `dashboard.js` to consume this endpoint and render the server-provided date; do not fetch unbounded rows or rely on browser-side authorization decisions.

- [ ] **Step 4: Add explicit UID audience editing.**

Represent the form state as one of `all`, `pj`, `clt`, or `uids`. For `uids`, show a validated newline-separated UID input, preserve existing values during edit, reject empty/duplicate/malformed entries, and submit the exact array expected by `target_users`.

- [ ] **Step 5: Add delivery filters and pagination.**

Expose status, channel, reminder, user UID, and scheduled date filters already supported by the API. Request `limit`, `offset`, and consume `X-Total-Count`; do not keep the fixed `limit=10&offset=0` behavior.

- [ ] **Step 6: Run reminder tests.**

```powershell
node --test tests/unit/api-routes.test.mjs tests/unit/notification-scheduling.test.mjs tests/unit/frontend-invariants.test.mjs
npm run verify
git diff --check
```

- [ ] **Step 7: Commit dashboard and reminders.**

```powershell
git add public/js/dashboard.js public/dashboard.html public/js/reminders.js public/reminders.html api/routes/reminders.js tests/unit/api-routes.test.mjs tests/unit/notification-scheduling.test.mjs tests/unit/frontend-invariants.test.mjs
git commit -m "fix: complete dashboard and reminder V1 flows"
```

### Task 5: Complete admin filters, audit, and operational history

**Files:**
- Modify: `public/js/admin.js`
- Modify: `public/admin.html`
- Modify: `api/routes/users.js` only if audit filters or explicit count fields need extension.
- Modify: `api/routes/ombudsman.js` only if its existing filter contract needs a missing validated field.
- Modify: `tests/unit/governance-routes.test.mjs`
- Modify: `tests/unit/frontend-invariants.test.mjs`

**Interfaces:**
- Consumes: paginated users, audit, Ombudsman, Academy, Benefits, job-title, reminder delivery endpoints and their existing policy gates.
- Produces: usable admin filters and complete navigable audit/delivery/Ombudsman views.

- [ ] **Step 1: Add failing UI invariants for admin history.**

Assert that the admin page contains pagination containers and filter controls for Ombudsman and delivery history, and that `loadAudit()` does not permanently request only `limit=10&offset=0`.

- [ ] **Step 2: Add Ombudsman status and assignee filters.**

Keep filter values in the URL, validate them against the backend enums, reset offset when a filter changes, and announce result counts.

- [ ] **Step 3: Add audit pagination.**

Use the existing `serverPagination()` helper if its contract fits; otherwise extend it with a single documented option. Keep audit access super-admin-only and preserve audit records for reads/exports.

- [ ] **Step 4: Connect complete delivery history to the admin UI.**

Reuse the filters from Task 4 and ensure changing filters reloads the same bounded result container without losing the current admin tab.

- [ ] **Step 5: Verify admin lists.**

```powershell
node --test tests/unit/governance-routes.test.mjs tests/unit/frontend-invariants.test.mjs
npm run verify
git diff --check
```

- [ ] **Step 6: Commit admin history improvements.**

```powershell
git add public/js/admin.js public/admin.html api/routes/users.js api/routes/ombudsman.js tests/unit/governance-routes.test.mjs tests/unit/frontend-invariants.test.mjs
git commit -m "feat: complete administrative history views"
```

### Task 6: Add SMTP operational alerts without changing reminder delivery

**Files:**
- Create: `cron/sendOperationalAlert.js`
- Modify: `cron/checkReminders.js`
- Modify: `cron/health.js`
- Modify: `cron/index.js`
- Modify: `cron/sendEmail.js` only if shared retry/error classification is needed.
- Modify: `cron/package.json` and `cron/package-lock.json` to add the minimum SMTP transport dependency required by the cron image.
- Modify: `.env.example` with non-secret alert variables.
- Modify: `tests/unit/notification-scheduling.test.mjs`
- Modify: `tests/unit/operations-invariants.test.mjs`

**Interfaces:**
- Consumes: `cron_status`, existing cron failure counts, and SMTP configuration.
- Produces: `sendOperationalAlert({ subject, text }) -> Promise<void>` with a bounded timeout, generic error logging, and no effect on the primary reminder job.

- [ ] **Step 1: Add failing transport-contract tests.**

Test that missing `OPERATIONAL_ALERT_EMAIL` disables alerts with an explicit startup diagnostic, valid configuration generates an SMTP message without logging credentials, and transport failure is swallowed after structured logging.

- [ ] **Step 2: Add the cron SMTP dependency and implement the isolated transport.**

Add `nodemailer` to `cron/package.json` and `cron/package-lock.json` because the cron image does not currently contain the API's SMTP dependency. Require `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `MAILER_SENDER_EMAIL`, and `OPERATIONAL_ALERT_EMAIL` only when alerts are enabled. Keep secrets out of thrown messages and logs.

- [ ] **Step 3: Trigger stale-heartbeat alerts.**

Add a bounded, deduplicated alert decision based on `checkHealth()` results. A stale heartbeat must not send an email every cron tick; persist or derive a notification key from the failure class and recovery transition.

- [ ] **Step 4: Trigger repeated-failure alerts.**

Alert after a defined consecutive failure threshold, include request-safe counts/timestamps, and send a recovery email once the cron returns to healthy status. Do not include personal content or provider response bodies.

- [ ] **Step 5: Verify cron behavior.**

```powershell
node --test tests/unit/notification-scheduling.test.mjs tests/unit/operations-invariants.test.mjs
npm run verify
git diff --check
```

- [ ] **Step 6: Commit operational alerts.**

```powershell
git add cron/sendOperationalAlert.js cron/checkReminders.js cron/health.js cron/index.js cron/sendEmail.js cron/package.json .env.example tests/unit/notification-scheduling.test.mjs tests/unit/operations-invariants.test.mjs
git commit -m "feat: add cron operational email alerts"
```

### Task 7: Add S3-compatible backup transfer and restore checks

**Files:**
- Create: `scripts/backup-s3.sh`
- Modify: `scripts/backup.sh`
- Modify: `scripts/restore.sh`
- Modify: `scripts/smoke.sh`
- Modify: `.env.example`
- Modify: `tests/unit/operations-invariants.test.mjs`
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/local-development.md`

**Interfaces:**
- Consumes: a completed local backup directory containing `postgres.dump`, `uploads.tar.gz`, and `manifest.sha256`.
- Produces: a transfer command that accepts `BACKUP_DIR`, `S3_BUCKET`, `S3_PREFIX`, optional `AWS_ENDPOINT_URL`, and an AWS-compatible CLI command; it never removes a verified local backup after remote failure.

- [ ] **Step 1: Add failing backup-contract tests.**

Assert that the script requires `BACKUP_DIR` and `S3_BUCKET`, rejects a missing `manifest.sha256`, verifies `sha256sum --check`, uses a timestamped remote prefix, and does not call remote deletion on upload failure.

- [ ] **Step 2: Implement `backup-s3.sh` with fail-closed preflight.**

Use `command -v aws` to require an AWS-compatible CLI, run `aws s3 cp --recursive` against the explicit bucket/prefix, support `AWS_ENDPOINT_URL` for S3-compatible providers, and emit only paths/bucket prefixes in logs. Never print access keys or secret values.

- [ ] **Step 3: Chain transfer after successful local backup.**

Make `backup.sh` create and checksum the local artifact first. Invoke the transfer only when `BACKUP_UPLOAD_S3=true`; keep local success independent from remote success and return a distinct non-zero code for remote transfer failure.

- [ ] **Step 4: Add restore verification documentation and checks.**

Document the pre-restore backup, checksum validation, disposable restore, migration verification, readiness, and smoke sequence. Keep the destructive `--confirm RESTORE` guard unchanged.

- [ ] **Step 5: Verify shell contracts.**

```powershell
node --test tests/unit/operations-invariants.test.mjs
npm run verify
git diff --check
```

- [ ] **Step 6: Commit backup transfer.**

```powershell
git add scripts/backup-s3.sh scripts/backup.sh scripts/restore.sh scripts/smoke.sh .env.example tests/unit/operations-invariants.test.mjs docs/operations/deployment.md docs/operations/local-development.md
git commit -m "feat: add S3-compatible backup transfer"
```

### Task 8: Close security, privacy, and release documentation gaps

**Files:**
- Modify: `docs/product/privacy-retention.md`
- Modify: `docs/product/feature-inventory.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/operations/deployment.md`
- Create: `docs/operations/v1-release-checklist.md`
- Modify: `tests/unit/repository-boundaries.test.mjs`
- Modify: `tests/unit/api-security.test.mjs` only if a missing boundary is discovered.

**Interfaces:**
- Consumes: implemented behavior from Tasks 2-7.
- Produces: a truthful V1 inventory, explicit release gates, RPO/RTO procedures, Sólides-off statement, and operational handoff checklist.

- [ ] **Step 1: Add release checklist sections.**

The checklist must contain these exact sections: environment variables, Firebase, SMTP, PostgreSQL migration, AutoCard access, content/pagination, notifications, backup/restore, S3 transfer, TLS/firewall, smoke tests, monitoring, rollback, and sign-off.

- [ ] **Step 2: Document external validation boundaries.**

Separate checks executable locally from checks requiring real Firebase, SMTP, S3, VPS, TLS, or operator approval. Do not claim production validation from local Docker results.

- [ ] **Step 3: Update product inventory only from evidence.**

Change entries from Partial to Operational only when the corresponding code and test exist. Keep Sólides `off`, PJ invoices absent, and post-V1 features explicitly out of scope.

- [ ] **Step 4: Verify repository boundaries.**

```powershell
node --test tests/unit/repository-boundaries.test.mjs tests/unit/api-security.test.mjs
npm run verify
git diff --check
```

- [ ] **Step 5: Commit documentation and release gates.**

```powershell
git add docs/product/privacy-retention.md docs/product/feature-inventory.md docs/product/roadmap.md docs/operations/deployment.md docs/operations/v1-release-checklist.md tests/unit/repository-boundaries.test.mjs tests/unit/api-security.test.mjs
git commit -m "docs: add Portal V1 release checklist"
```

### Task 9: Add local integration and authenticated smoke coverage

**Files:**
- Modify: `scripts/smoke.sh`
- Modify: `scripts/doctor.mjs` only if diagnostics need to identify missing V1 prerequisites.
- Modify: `docker-compose.yml` only for required healthcheck/readiness fixes.
- Modify: `tests/unit/operations-invariants.test.mjs`
- Modify: `docs/operations/local-development.md`

**Interfaces:**
- Consumes: local Docker services, `/api/health`, `/api/ready`, existing smoke command, and optional Auth Emulator.
- Produces: deterministic unauthenticated liveness/readiness checks and a documented authenticated smoke flow that an operator can execute when local auth fixtures exist.

- [ ] **Step 1: Add failing smoke invariants.**

Assert that smoke checks `/api/health`, `/api/ready`, the Portal entry page, `/autocard/`, and Nginx proxy behavior without exposing PostgreSQL directly.

- [ ] **Step 2: Implement safe unauthenticated smoke checks.**

Keep liveness and readiness checks separate. A failed readiness check must identify the dependency without dumping environment values.

- [ ] **Step 3: Document local authenticated smoke setup.**

Document Auth Emulator startup, local admin bootstrap, the DHO test user, and the exact journeys to verify. Store no test credential in the repository.

- [ ] **Step 4: Run local Compose validation with explicit approval.**

```powershell
docker compose --profile local up -d --build
docker compose ps
sh scripts/smoke.sh
```

Expected: required services are healthy, Nginx reaches API readiness, and smoke reports failures with actionable service names.

- [ ] **Step 5: Stop local services after validation.**

```powershell
docker compose --profile local down
```

- [ ] **Step 6: Commit local integration coverage.**

```powershell
git add scripts/smoke.sh scripts/doctor.mjs docker-compose.yml tests/unit/operations-invariants.test.mjs docs/operations/local-development.md
git commit -m "test: add Portal V1 local smoke coverage"
```

### Task 10: Accessibility and responsive acceptance pass

**Files:**
- Modify: affected `public/*.html` files from Tasks 2-5.
- Modify: affected `public/js/*.js` files from Tasks 2-5.
- Modify: affected `public/css/*.css` files from Tasks 2-5.
- Modify: `tests/unit/frontend-invariants.test.mjs`.
- Modify: `docs/operations/v1-release-checklist.md`.

**Interfaces:**
- Consumes: completed Portal shell, public pagination, dashboard, admin, reminders, and AutoCard journeys.
- Produces: documented manual acceptance evidence for 320 px, desktop, keyboard, reduced motion, focus, headings, labels, dialogs, and live regions.

- [ ] **Step 1: Add automated DOM invariants for new controls.**

Assert that every new search/filter/pagination control has a label or accessible name, every page has one main heading, pagination has a live result status, and active sidebar links use `aria-current="page"`.

- [ ] **Step 2: Run the keyboard checklist.**

Verify login, sidebar drawer, AutoCard tabs, AutoCard dialogs, reminder editor, admin filters, article detail, and profile dialogs with only Tab, Shift+Tab, Enter, Space, Escape, and arrow keys where applicable.

- [ ] **Step 3: Run the responsive checklist.**

Verify 320 px, 768 px, 1024 px, and desktop widths. Confirm no global horizontal scroll and that tables, editor preview, filters, and dialogs remain usable.

- [ ] **Step 4: Record manual evidence.**

Add the test date, browser/reader, viewport, journey, result, and issue references to the V1 release checklist. Do not mark NVDA/VoiceOver as passed without physically running them.

- [ ] **Step 5: Commit the acceptance evidence updates.**

```powershell
git add public tests/unit/frontend-invariants.test.mjs docs/operations/v1-release-checklist.md
git commit -m "test: complete V1 accessibility acceptance"
```

### Task 11: Final V1 verification and handoff

**Files:**
- Modify: `docs/operations/v1-release-checklist.md` with actual local results.
- Modify: `docs/product/feature-inventory.md` only for verified final states.

**Interfaces:**
- Consumes: all completed tasks and local services when available.
- Produces: a truthful V1 status with no unstated local verification gaps.

- [ ] **Step 1: Run the complete automated suite.**

```powershell
npm run verify
git diff --check
```

Expected: syntax, unit tests, security checks, shell checks, and Compose invariants pass.

- [ ] **Step 2: Run migration verification twice.**

```powershell
docker compose run --rm --entrypoint node -w /workspace -v "${PWD}:/workspace" -v "${PWD}\api\node_modules:/workspace/api/node_modules" migrate scripts/test-migrations.mjs
```

Expected: fresh/upgrade behavior and repeated execution pass.

- [ ] **Step 3: Run local backup and restore against disposable data.**

Use the documented commands from `docs/operations/v1-release-checklist.md`, require `--confirm RESTORE` for restore, and record measured duration against the 4-hour RTO target.

- [ ] **Step 4: Confirm repository state.**

```powershell
git status --short
git log --oneline -10
```

Expected: only intentionally committed files are present; no secrets, archives, uploads, or temporary worktrees are tracked.

- [ ] **Step 5: Commit the final evidence.**

```powershell
git add docs/operations/v1-release-checklist.md docs/product/feature-inventory.md
git commit -m "docs: record Portal V1 verification"
```

- [ ] **Step 6: Prepare the operational handoff.**

The final report must distinguish local verification from pending external checks for Firebase, SMTP, S3, VPS/TLS/firewall, real backup scheduling, and production rollback. Do not call the product production-ready until those external checks are completed by an authorized operator.

## Plan Self-Review

- AutoCard shell integration is covered by Task 2.
- Public/admin pagination and filters are covered by Tasks 3-5.
- PJ CTA removal and dashboard reminder correctness are covered by Task 4.
- Individual audiences and email-only reminders are covered by Tasks 4 and 6.
- SMTP operational alerts are covered by Task 6.
- S3-compatible backups, checksum, restore, and RPO/RTO are covered by Task 7 and Task 11.
- Security, LGPD, Sólides-off, and release documentation are covered by Task 8.
- Local Docker and smoke coverage are covered by Task 9.
- Keyboard, mobile, reduced motion, and manual accessibility evidence are covered by Task 10.
- Final verification and truthful handoff are covered by Task 11.

No task depends on an undefined API name: the only new interfaces are
`sendOperationalAlert({ subject, text }) -> Promise<void>` and the documented
`backup-s3.sh` environment contract. No task requires live credentials for
local verification.

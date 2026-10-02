# Sol Advisor — release integration report

## Result

Integrated `origin/main@43b9126` (Academy) with
`origin/fix/revert-review-artifacts@70a5b44` (Owner News) on
`release/owner-news-main-20261001`. The merge was composed manually at the
shared CMS, migration, and test seams. No deployment, production write, push,
or main-branch merge was performed.

## Migration assumption and evidence

- The release worktree contained two Owner News migrations using the source
  branch's conflicting prefixes (editorial first, polls second); they were
  present only on the source branch and were not recorded in a production
  ledger by the supplied repository evidence.
- `origin/main@43b9126` contains Academy migration
  `033_academy_learning.sql` and its Academy ledger/tests. No checked-in
  production database snapshot or production migration ledger contradicting
  the stated assumption was found.
- The ordered release ledger is therefore:
  `033_academy_learning`, `034_owner_news_editorial`,
  `035_owner_news_polls`.
- Owner News files were renamed to `034_owner_news_editorial.sql` and
  `035_owner_news_polls.sql`. `api/db/verify-migrations.js`,
  `scripts/test-migrations.mjs`, schema invariants, and normative docs now use
  the exact order. There are no duplicate numeric migration prefixes; the two
  old source prefixes occur only in the migration runner's explicit
  compatibility stop, not in the active release ledger.

## Composed implementation

- Preserved the complete Academy API, curriculum/progress implementation,
  frontend module graph/assets, CMS lesson publication and access checks,
  auth/CMS permissions, source visibility, timers/backup work, docs, and
  Academy tests from main.
- Preserved Owner News editorial reader/catalog/mosaic/overlay/history,
  metadata validation, private media, CMS home/polls, importer/bundle tooling,
  docs, tests, and Nodemailer 10.0.13 from the source branch.
- Composed shared CMS behavior in `api/cms/blocks.js`,
  `api/cms/reader.js`, `api/cms/permissions.js`, `api/cms/sources.js`,
  `api/routes/cms.js`, `api/routes/cms-assets.js`, `public/js/cms.js`,
  `public/cms.html`, `public/js/announcements.js`, and
  `public/js/dashboard.js`, retaining Academy lesson publication and Owner
  News metadata/private assets/polls.
- Kept both Academy and Owner News behavior in the previously conflicted CMS,
  schema, migration, frontend, and mobile-shell tests. Updated the Academy
  dashboard assertion to the Owner News article-kind endpoint and made the
  profile-media fixture include the current publication-validity contract.
- Kept `tests/unit/nodemailer-local-smtp.test.mjs` and the source-side exact
  Nodemailer invariant. Removed the source-only root report
  `sol-advisor-implementation.md`; this report is the requested release
  handoff and is not a runtime artifact.
- Cron remains on the Node 24 image contract. Its Dockerfile includes the
  shared CMS reader and `api/owner-news/editorial.js` dependency required by
  scheduled publication processing. Academy dependencies remain in the API
  image/module graph and were covered by the Academy suites.

## Checks run

Passed:

- `git diff --check` — passed during conflict resolution and final review.
- No merge conflict markers remain in tracked source files.
- `npm ci --prefix api` and `npm ci --prefix cron` — completed; install audit
  output was not used as the release security result.
- `npm run verify` — passed: 1,108 tests, 1,106 passed, 0 failed, 2 skipped;
  syntax, security checks, and Compose static checks passed.
- `npm run security` — passed: API and cron reported 0 vulnerabilities at the
  configured high threshold.
- The release verifier now gates the ordered ledger, all Owner News relations,
  the CMS editorial JSONB/check, home singleton columns/defaults/row, poll
  constraints and indexes, API grants, and complete cron denial on Owner News
  tables. The migration runner also stops on legacy Owner News ledger versions
  instead of renaming or silently marking them applied.
- CI now retains the default migration run, creates separate disposable
  `portal_test_upgrade` and `portal_test_bootstrap` databases, exercises both
  documented `MIGRATION_TEST_SETUP` paths, and then runs the Owner News and
  Academy PostgreSQL integration suites with the existing test database.
- Targeted shared-CMS, migration-invariant, Academy, Owner News, and shell
  suites — passed (the final full verify includes them).
- Academy frontend plus the legacy-area removal invariant test — passed,
  23/23.
- Final parent comparison: staged diff was inspected against both
  `origin/main@43b9126` and `70a5b44`; Academy additions and Owner News
  additions were both present, with migration renames visible as 100% renames.

Blocked by the local environment (not silently substituted):

- `npm run test:migrations` — could not start because
  `MIGRATION_TEST_DISPOSABLE=true` and a disposable `MIGRATION_DATABASE_URL`
  were not configured. A local `psql` client was not installed.
- `node scripts/test-owner-news-integration.mjs` — same disposable database
  prerequisite blocked startup.
- `node scripts/test-academy.mjs` — same disposable database prerequisite
  blocked startup; the Academy unit/integration helpers were nevertheless
  included in the passing `npm run verify` run where no external database was
  required.
- `docker build -f api/Dockerfile ...` and `docker build -f cron/Dockerfile
  ...` — blocked because Docker Desktop's Linux engine was unavailable.
  `docker compose build api cron` also could not proceed: Compose first
  required unset local SMTP variables. No secrets were printed and no service
  was started.

## Unresolved limits and self-review

- The required disposable PostgreSQL twice-run/idempotence evidence remains
  outstanding. The migration integration source does assert the ordered
  ledger, second-run equality, Academy relations/constraints/privileges, Owner
  News home/polls grants, and both upgrade/bootstrap setup paths; it still needs
  execution in a disposable PostgreSQL environment or remote CI.
- The actual production migration ledger has not been inspected. No production
  readiness claim is made until that ledger is externally confirmed and the
  disposable PostgreSQL suites, Docker image/startup checks, and remote CI pass.
- API/cron image build and runtime startup/module-graph evidence remains
  outstanding until a Docker engine is available. Static verification did
  pass the cron CMS reader dependency invariant.
- No production database state was inspected or changed. The migration order
  is based on the explicit release assumption and repository evidence above;
  if a production ledger later shows either Owner News migration was already
  applied under 033/034, release integration must stop for an explicit
  migration plan
  rather than reusing these names.
- No deploy workflow, production script, secret, or external service was
  altered. No production deployment or external DB validation is claimed.

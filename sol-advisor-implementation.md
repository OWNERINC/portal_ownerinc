# Sol Advisor implementation report — issue #48

## Scope and rationale

- Implemented only issue #48 on `fix/issue-48-nodemailer-20261001` from base
  `55f8f33`.
- Updated both production services to the selected Nodemailer policy:
  declared minimum `10.0.13`, with the lockfiles resolving exactly `10.0.13`.
- No SMTP options, credentials, environment variables, Docker deploy settings,
  or provider configuration were changed.
- Added a focused invariant that checks the API and cron manifests, lockfile
  root dependencies, and resolved lockfile package against the `10.0.13`
  minimum.

## Changed files

- `api/package.json` — Nodemailer range `^10.0.2` -> `^10.0.13`.
- `api/package-lock.json` — root dependency and resolved package updated to
  Nodemailer `10.0.13`, including its integrity value.
- `cron/package.json` — Nodemailer range `^10.0.2` -> `^10.0.13`.
- `cron/package-lock.json` — root dependency and resolved package updated to
  Nodemailer `10.0.13`, including its integrity value.
- `tests/unit/operations-invariants.test.mjs` — added the production
  dependency invariant described above.
- `sol-advisor-implementation.md` — this handoff report.

## Verification commands and actual results

All commands below were run from the repository root unless a service directory
is explicitly stated.

### Dependency installation and resolution

- `npm ci` in `api/` — **passed** (exit 0); installed 324 packages. npm printed
  the existing full API tree summary of 9 vulnerabilities (6 moderate, 3
  high), plus deprecation warnings. This is broader than the production audit
  scope and was not changed with `npm audit fix`.
- `npm ci` in `cron/` — **passed** (exit 0); installed 17 packages and
  reported 0 vulnerabilities.
- `node -e "for (const service of ['api','cron']) console.log(service + ': ' + require('./' + service + '/node_modules/nodemailer/package.json').version)"`
  — **passed**, output:

  ```text
  api: 10.0.13
  cron: 10.0.13
  ```

### Focused SMTP tests

- `node --test tests/unit/password-reset-email.test.mjs` — **passed**, 10/10
  tests.
- `node --test tests/unit/cron-mail-transport.test.mjs tests/unit/notification-scheduling.test.mjs`
  — **passed**, 18/18 tests.

### Repository checks

- `npm run verify` — **passed**, exit 0; 901/901 tests passed, with syntax,
  repository security, DHO naming, and Compose checks successful.
- `npm run security` — **passed**, both production-scoped audits reported
  `found 0 vulnerabilities` using `--omit=dev --omit=optional`.
- `git diff --check` — **passed**, no output.

## Production image evidence

Docker was available. Both production images built successfully:

- `docker build --file api/Dockerfile --tag ownerinc-portal-api:issue48-nodemailer-20261001 api`
  — **passed**.
- `docker build --file cron/Dockerfile --tag ownerinc-portal-cron:issue48-nodemailer-20261001 .`
  — **passed**.
- `docker run --rm --entrypoint node ownerinc-portal-api:issue48-nodemailer-20261001 -e "console.log(require('/app/node_modules/nodemailer/package.json').version)"`
  — **passed**, output `10.0.13`.
- `docker run --rm --entrypoint node ownerinc-portal-cron:issue48-nodemailer-20261001 -e "console.log(require('/app/node_modules/nodemailer/package.json').version)"`
  — **passed**, output `10.0.13`.

No secrets were passed to or printed from these image checks.

## Image scan and remaining limits

- `trivy --version` — unavailable in the local environment.
- Repository-equivalent `docker scout cves local://ownerinc-portal-api:issue48-nodemailer-20261001 --only-severity high,critical`
  and the corresponding cron command — **blocked before scanning** because
  Docker Scout requires Docker ID/PAT authentication. No credentials were
  supplied and no CI scan settings were changed.
- There was no new remote CI run, push, deploy, or production verification, so
  this report does not claim CI green or production deployment success.
- The local image tags are build evidence only; they were not published.

## Self-review

- The diff is limited to the two production dependency manifests and
  lockfiles, one focused invariant, and this report.
- SMTP behavior remains covered by the existing API password-reset/invitation
  tests and cron transport tests; no transport code or configuration changed.
- The invariant fails if either service's declared minimum, lockfile root
  range, or resolved Nodemailer version is below `10.0.13`.
- The production-scoped security command is clean. The broader API `npm ci`
  summary still reports development/full-tree vulnerabilities; they were not
  silently broadened into this issue and should be triaged separately if they
  remain relevant to CI policy.

# Resend SMTP Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move API and cron email delivery to the Resend SMTP service using one protected SMTP configuration.

**Architecture:** The API keeps its existing Nodemailer mailer and removes the SendGrid branch. The cron gets one SMTP transport helper used by reminders and operational alerts, replacing its direct SendGrid client while preserving notification logging and retry behavior.

**Tech Stack:** Node.js 24, Nodemailer, Express API, PostgreSQL-backed cron, Docker Compose, Node test runner.

## Global Constraints

- Use `smtp.resend.com` with SMTP username `resend` and port `465` with implicit TLS.
- `SMTP_PASSWORD` is the Resend API key and must remain only in the protected VPS `.env`.
- `MAILER_SENDER_EMAIL` must be a sender verified in Resend.
- Do not add SendGrid fallback or automatic provider switching; this avoids duplicate messages.
- Preserve the API Firebase compensation and database rollback behavior when email delivery fails.
- Preserve cron retry, notification status, operational alert, and retention behavior.
- Keep Node 24 compatibility and do not expose secrets in source, tests, logs, or CI artifacts.

---

### Task 1: Replace API SendGrid transport with Resend SMTP

**Files:**
- Modify: `api/integrations/password-reset-email.js`
- Modify: `api/package.json`
- Modify: `api/package-lock.json`
- Test: `tests/unit/password-reset-email.test.mjs`

**Interfaces:**
- `sendPasswordReset({ to, link, env })` and `sendInvitation({ to, name, link, env })` keep their current signatures.
- `smtpOptions(env)` remains the single API transport configuration function.

- [ ] **Step 1: Update the mailer tests to describe Resend SMTP.**

  Replace SendGrid-specific assertions with checks that `smtpOptions` returns `host: 'smtp.resend.com'`, numeric port `465`, `secure: true`, `requireTLS: false`, the Resend SMTP username, and `tls.rejectUnauthorized: true`. Keep assertions that rendered messages contain escaped links and no password or SMTP secret.

- [ ] **Step 2: Run the focused API mailer tests and confirm the old contract fails.**

  Run `node --test tests/unit/password-reset-email.test.mjs`.

  Expected result: the new Resend SMTP assertions fail against the current SendGrid-aware implementation, while the existing message assertions identify any unintended sender behavior.

- [ ] **Step 3: Simplify the API mailer to SMTP-only.**

  Remove `require('@sendgrid/mail')`, `usesSendGrid`, `sendGridMessage`, and SendGrid-specific sender selection. Keep `portalSender`, message rendering, and Firebase-facing function signatures unchanged. Make `sendTransactional` create the Nodemailer transport from `smtpOptions(env)` and call `sendMail(message)`.

  The resulting transport path should be equivalent to:

  ```js
  async function sendTransactional(message, env = process.env) {
    transporter ||= nodemailer.createTransport(smtpOptions(env));
    return transporter.sendMail(message);
  }
  ```

- [ ] **Step 4: Remove the API SendGrid dependency and regenerate its lockfile.**

  Remove `@sendgrid/mail` from `api/package.json`, then run `npm install` from `api/`. Confirm `api/package-lock.json` no longer contains the SendGrid package.

- [ ] **Step 5: Run the focused API tests.**

  Run `node --test tests/unit/password-reset-email.test.mjs`.

  Expected result: all password-reset and invitation tests pass.

### Task 2: Use one Resend SMTP transport in cron

**Files:**
- Create: `cron/mailTransport.js`
- Modify: `cron/sendEmail.js`
- Modify: `cron/sendOperationalAlert.js`
- Modify: `cron/index.js`
- Modify: `cron/package.json`
- Modify: `cron/package-lock.json`
- Test: `tests/unit/cron-mail-transport.test.mjs`

**Interfaces:**
- `getMailTransport(env = process.env)` returns a cached Nodemailer transport configured from `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and TLS settings.
- `sendEmail({ to, subject, text }, env = process.env)` remains the reminder delivery interface.
- `sendOperationalAlert({ subject, text }, env = process.env)` keeps its current boolean result and optional `OPERATIONAL_ALERT_EMAIL` behavior.

- [ ] **Step 1: Add focused cron transport tests.**

  Assert that `getMailTransport` receives the Resend SMTP host, port `465`, `secure: true`, Resend username, password, and `rejectUnauthorized: true` without sending a network request. Assert that cron source files no longer import `@sendgrid/mail`.

- [ ] **Step 2: Run the focused cron test and confirm the missing helper/source contract.**

  Run `node --test tests/unit/cron-mail-transport.test.mjs`.

  Expected result: it fails because the shared helper and SMTP-only wiring are not yet present.

- [ ] **Step 3: Implement the shared cron SMTP helper.**

  Create `cron/mailTransport.js` with a module-level cached transport. Use `nodemailer.createTransport({ host, port: Number(port), secure: Number(port) === 465, auth: { user, pass }, tls: { rejectUnauthorized: true } })`. Do not log or throw the password value.

  The helper's implementation shape should be:

  ```js
  const nodemailer = require('nodemailer');
  let transport;

  function getMailTransport(env = process.env) {
    transport ||= nodemailer.createTransport({
      host: env.SMTP_ADDRESS,
      port: Number(env.SMTP_PORT),
      secure: Number(env.SMTP_PORT) === 465,
      auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
      tls: { rejectUnauthorized: true },
    });
    return transport;
  }

  module.exports = { getMailTransport };
  ```

- [ ] **Step 4: Migrate reminder and operational alert senders.**

  Change `cron/sendEmail.js` and `cron/sendOperationalAlert.js` to use `getMailTransport`. Keep the operational alert early return when `OPERATIONAL_ALERT_EMAIL` is absent, the existing subject prefix, success log, failure log truncation, and boolean return. Remove SendGrid initialization from `cron/index.js` and validate `DATABASE_URL`, `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, and `MAILER_SENDER_EMAIL` instead.

- [ ] **Step 5: Remove the cron SendGrid dependency.**

  Remove `@sendgrid/mail` from `cron/package.json`, then run `npm install` from `cron/` and confirm the lockfile no longer contains SendGrid packages.

- [ ] **Step 6: Run the focused cron tests.**

  Run `node --test tests/unit/cron-mail-transport.test.mjs`.

  Expected result: all transport shape and source-boundary assertions pass.

### Task 3: Update runtime configuration and operational documentation

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/troubleshooting.md`
- Modify: `tests/unit/operations-invariants.test.mjs`

**Interfaces:**
- API and cron receive the same `SMTP_*` and `MAILER_SENDER_EMAIL` values from Compose.
- SendGrid variables are not required by any Portal service.

- [ ] **Step 1: Update the Compose environment contract.**

  Remove `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` from the API and cron environment blocks. Make cron SMTP variables required in the same way as API SMTP variables, since reminders now use SMTP directly.

- [ ] **Step 2: Update the example environment and deployment guide.**

  Document the Resend values in `.env.example` and `docs/operations/deployment.md`, including the requirement that `MAILER_SENDER_EMAIL` is verified in Resend and `SMTP_PASSWORD` is stored only at `/opt/ownerinc-portal/shared/.env`.

- [ ] **Step 3: Update operational troubleshooting and invariants.**

  Replace SendGrid checks with Resend SMTP checks in `docs/operations/troubleshooting.md`. Extend `tests/unit/operations-invariants.test.mjs` to require the shared SMTP variables, Nodemailer dependency, and absence of SendGrid configuration in the service blocks.

- [ ] **Step 4: Run the configuration-focused test.**

  Run `node --test tests/unit/operations-invariants.test.mjs`.

  Expected result: all Compose, package, and operational invariants pass.

### Task 4: Full verification, commit, deploy, and live validation

**Files:**
- Verify all modified files from Tasks 1-3.

**Interfaces:**
- The deployed commit must contain no SendGrid email dependency or runtime configuration.

- [ ] **Step 1: Run the full verification suite.**

  Run `npm run verify` and `git diff --check`.

  Expected result: verification passes, including syntax, tests, security, and Compose checks.

- [ ] **Step 2: Inspect the final diff and commit only intended files.**

  Run `git status --short`, `git diff --stat`, `git diff --check`, and `git log --oneline -10`; then commit with `fix: use Resend SMTP for portal email`.

- [ ] **Step 3: Push `main` and wait for CI/deploy.**

  Run `git push origin main`, then monitor the generated GitHub Actions run until both validation and production deployment succeed.

- [ ] **Step 4: Verify production health.**

  Request `https://portal.ownerinc.com.br` and confirm HTTP 200. Confirm the deployment run is green. A real invitation test requires a verified Resend sender and the Resend API key already present in the protected VPS `.env`; never paste that key into chat.

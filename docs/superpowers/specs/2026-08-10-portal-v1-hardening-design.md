# Portal Ownerinc V1 Hardening and Integration

## Context

The Portal Ownerinc already has the core internal-product capabilities in
place: closed Firebase authentication, PostgreSQL-backed profiles and content,
administration, reminders, email delivery, Ombudsman, audit, retention, Docker
Compose, migrations, backups, and the AutoCard module. The remaining work is to
turn that MVP-plus foundation into a cohesive V1 that can be locally validated
and handed to operations for real-service homologation.

This design covers only the V1 path. Post-V1 features such as WhatsApp, LMS
progress, benefit redemption, PJ invoice processing, MFA, social login, and
dark mode remain out of scope.

## Decisions

- Preserve the current static frontend, Express API, PostgreSQL, cron, Nginx,
  and Docker Compose architecture.
- Do not introduce a frontend framework or replace the duplicated Portal shell
  with a runtime-generated SPA shell.
- Keep `/autocard/` as the canonical AutoCard URL.
- Render AutoCard inside the Portal shell with the shared sidebar, topbar,
  skip link, `main.page-body`, logout behavior, and mobile drawer.
- Keep AutoCard server authorization restricted to the exact normalized DHO job
  titles: Analista, Assistente, Coordenador, and Gerente de DHO.
- Remove the misleading PJ invoice CTA from the dashboard in V1.
- Keep V1 notifications email-only. WhatsApp, read/completed state, and
  individual communication preferences remain deferred.
- Keep Sólides in `off` at V1 launch.
- Use RPO 24 hours and RTO 4 hours as the operational recovery targets.
- Extend the existing backup flow with configurable upload to an S3-compatible
  destination. Credentials remain environment/secret-manager configuration and
  never enter source control.
- Deliver operational alerts through the existing SMTP capability.
- Validate code, migrations, Docker, restore, and smoke flows locally. Real
  Firebase, SMTP, VPS, TLS, external S3, and production deployment checks are
  operational handoff items unless a configured homologation environment is
  supplied outside the repository.

## Architecture

### AutoCard shell integration

`public/autocard/index.html` becomes a normal authenticated Portal page. Its
own application content remains inside `main.page-body`, while the AutoCard
topbar and page-level body shell are removed. The existing editor scripts keep
their element IDs and behavior to minimize regression risk. Relative API calls
continue to use the Portal's same-origin `/api` namespace.

The sidebar item remains present for all authenticated pages but is hidden by
the existing exact-title navigation guard for users without DHO access. The
backend remains authoritative for direct navigation and API calls.

### Lists and administration

Endpoints that currently expose only a first page will gain consistent bounded
pagination and total-count behavior. Search and operational filters move to the
server where they are needed for correctness or scale. Existing allowlists,
explicit column selection, policy checks, and error contracts remain in place.

### Notifications

The existing durable ledger and cron remain the source of truth. The V1 work
completes individual reminder audience editing, verifies idempotence and
catch-up behavior, exposes complete paginated delivery history, and sends
operational email alerts for stale heartbeat and repeated failure conditions.

### Backup and operations

The current backup script remains responsible for consistent PostgreSQL and
uploads snapshots, checksums, retention, and local restore. A separate,
configuration-driven S3-compatible transfer step will fail closed when its
required configuration or CLI is missing, without weakening the local backup.
Operational documentation will describe the S3 variables, lifecycle, restore
procedure, RPO/RTO, TLS boundary, and alert recipient configuration.

## User Journeys

### AutoCard

An authorized DHO user opens AutoCard from the Portal sidebar, remains inside
the standard Portal shell, creates or edits a card, uploads optional media,
saves to the shared history, duplicates or deletes an existing card, and
exports a PNG. An unauthorized user cannot access the page or API, even by
direct URL or stale browser state.

### Dashboard

The dashboard shows only active reminders intended for the current user, with
correct calendar handling and recoverable network states. It does not advertise
an unavailable PJ invoice workflow.

### Administration

Authorized administrators can paginate and filter operational lists, including
individual reminder audience selection and complete notification/audit views.
Every privileged operation remains authenticated, authorized, validated, and
audited.

### Operations

An operator can create a local backup, verify its checksum, restore it in a
disposable environment, upload a copy to S3-compatible storage, inspect health
and heartbeat state, and receive email when defined operational failures occur.

## Error Handling and Security

- Preserve generic client-facing API errors and request IDs.
- Reject missing or invalid configuration at the boundary with variable names,
  never values.
- Keep uploads validated by signature, size, decoded dimensions, normalized
  storage format, and authenticated access rules.
- Maintain same-origin API access, CSP, HSTS, frame protection, `nosniff`, and
  rate limiting.
- Ensure disabled users and expired/revoked Firebase identities cannot access
  Portal resources.
- Keep Sólides inaccessible while its release stage is `off`.
- Ensure S3 upload failure does not delete or invalidate a successful local
  backup.
- Ensure alert delivery failure is logged without stopping the cron's primary
  work.
- Update retention and privacy documentation for AutoCard media/history and
  Ombudsman handling.

## Verification

### Automated

- `npm run verify` remains green.
- Migration integration test passes on a fresh database and an upgraded
  database, including repeated execution.
- Unit invariants cover AutoCard shell, DHO authorization, pagination, filters,
  notification behavior, backup configuration, and security boundaries.
- `git diff --check` passes.

### Local integration

- Docker Compose starts the required local services.
- Authenticated smoke checks cover login, dashboard, profile, content,
  reminders, admin, Ombudsman, uploads, and AutoCard.
- Backup and restore are demonstrated against disposable local data.
- S3 transfer preflight and missing-configuration failure paths are tested
  without requiring live credentials.
- Responsive and keyboard checks cover the main journeys at 320 px and desktop
  widths.

### Operational handoff

The repository will include a release checklist for real Firebase, SMTP,
external S3, VPS/TLS/firewall, production backup, alert recipient, and rollback
validation. Local verification must not be represented as production
homologation.

## Non-Goals

- WhatsApp delivery.
- LMS enrollment, progress, completion, or certificates.
- Benefits coupons, eligibility, validity, or redemption.
- PJ invoice upload or processing.
- MFA or social login.
- Dark mode.
- Native mobile application.
- Sólides write operations or general release.
- Replacing the Portal architecture or introducing a frontend framework.

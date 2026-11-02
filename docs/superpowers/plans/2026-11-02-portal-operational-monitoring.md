# Portal operational monitoring implementation plan

## Steps
- [x] Implement bounded SMTP results, timeout cleanup, durable runner and offline tests.
- [x] Implement authenticated read-only host collection, backup monitoring receipts and systemd units.
- [x] Implement authenticated API-only observations, finite signals and read-only feed sampling.
- [x] Add isolated native CI SMTP acceptance, focused verification and operating documentation.
- [ ] Integrate the released CMS observation contract and approved deployment credential/Compose wiring.
- [ ] Verify production inbox failure/recovery delivery, human ownership and independent off-host loss detection.

## Goal and authorization

Implement OWN34 using existing systemd operations and SMTP transport. The primary accepted the design on 2026-11-02 and authorized the bounded core/API implementation. Execute inline without delegation. No installation, real email, remote/GitHub/SSH/Docker/database/service operations, dependency installation, staging, reset or commits. Local tests use dependency injection and real temporary files, not listening services. Full repository verification belongs to the primary when concurrent changes stabilize. This plan has an identical review copy at `C:/Users/Criação/.opencode/plan/2026-11-02-portal-operational-monitoring.md`; update only checklist completion as work finishes.

Tech: Node 18-compatible shared JavaScript, existing Nodemailer/Express/PostgreSQL clients, Python standard library, Linux systemd. No new dependencies, roles, tables or schema migrations. PostgreSQL guidance must be loaded before authoring queries. Preserve LF in operational files and current api/cron/public/nginx boundaries.

## Decision and alternatives

Use one host timer, a narrowly scoped protected collector and a separate unprivileged Node email runner. Keep existing cron worker-health alerts. Extending cron/health.js alone would couple deduplication to Portal DB and container availability, and require inappropriate host privileges. No existing external monitor was found in inspected sources; do not assume one exists. An off-host monitor remains required for complete VPS/network loss. No generic observability platform is introduced.

Current evidence: cron/health.js checks reminders/user-imports/retention with cron_status deduplication. sendOperationalAlert.js currently trusts any resolved sendMail and logs raw errors. mailTransport.js has reusable SMTP classifiers. CMS /editorial/ready creates a temporary durable storage file. Legacy announcement reads promote scheduled content. Neither endpoint is a harmless read-only monitor probe. backup-from-timer.sh verifies hashes before its success message but has no durable monitoring receipt. payload-production-observer.py needs approved context and inherited lease; Gate E observers sign control evidence and are not periodic monitors. Host state/inventory/recovery schemas are under concurrent development.

## Execution and trust boundary

Run every 60 seconds with a short boot delay. monitor.service Wants= and After= observe.service, never Requires=: collector failure must still run the mailer. Both are bounded oneshots without RemainAfterExit. The Python collector reads protected inventory, signed state, admission/route evidence, fixed systemd backup properties, backup receipts and explicitly mapped filesystem capacity/inodes. It writes only its protected monitoring observation directory. It has no Docker socket/CLI, database/CMS-controller credentials, network access or arbitrary command/target input. It must never run payload-control, preparation/recovery launchers, backups or service mutations.

Load the installed independently reviewed verifier closure, verify its expected digests and inventory identity, and call the state reader with repair_head=False. Use Python -I -S -B. Do not import the runtime/controller. If consistency needs the existing operation lock, open that existing file read-only and acquire a nonblocking shared lock; never create/replace/wait on it. Contention is observation_busy, not operational authority. Bound signed-state replay by process memory/time limits. Unknown versions/stages are unsupported_contract; never reinterpret lifecycle v3 or inventory v3 as supported state v3.

The Node runner is an unprivileged service identity using reviewed installed cron code and locked existing dependencies. It receives SMTP config, existing OPERATIONAL_ALERT_EMAIL, a dedicated application-monitor credential, the fixed Portal HTTPS origin, read access to collector observations and write access only to incident state. It does not import cron/index.js, cron/db.js or Firebase and needs no bulk-import credentials. Provisioning identity, token and environment is an operational pending step, not automatically assigned here.

## Observation contract

Use an exact portal-operational-observation-v1 envelope: schema/kind, observation time/expiry, source identity/generation, supported adapter, fixed check IDs, finite status/reason and bounded numeric measurements. Statuses: ok, degraded, failed, unknown, not_applicable. Authentication comes from the actual protected producer/verifier or authenticated HTTPS connection, never a JSON authenticated=true field. Reject stale/future-dated, oversized, malformed, unknown-version or identity-mismatched observations. Monitoring output is notification evidence only, stored outside journals/proofs/qualification bundles. No control consumer may accept it as authority.

The fixed GET /api/operational/observe authenticates the dedicated bounded secret with constant-time comparison before dependency access. It accepts no caller-selected URL/path/query/SQL/actor/mode/action. Its token works only here, never for browser sessions/content/mutations. The later fixed private POST /editorial/api/portal-news/operational-observe uses existing API-to-CMS service authentication, remains publicly blocked by the existing Nginx prefix rule and adds only an exact service-path exception. Return no content, users, cookies, credentials, paths, SQL, raw exceptions or upstream bodies.

Required checks:
- Private CMS: database identity/catalog/editorial profile through a new read-only operation. Never call storage-writing readiness. Metadata observations cannot prove writable storage.
- Public editorial: HTTPS exact status/relative redirect contract for the supported authenticated phase. Never arbitrary redirect following or treating a login/200 as bridge success.
- Bridge: API-to-CMS observation and CMS-to-Portal authenticated authority read; classify auth/transport/schema failures finitely. Service path is distinct from actual browser session coverage.
- Feed: real response status and X-Owner-News-Read-State degradation signals plus bounded internal read-only sampling with existing selectors/validators, excluding scheduled promotion, row UPDATE locks and write hooks. Empty valid feed is valid. Summary only, no content in observation.
- Authority/barrier: Portal authority versus CMS authority/mutation head and supported host/profile adapter. Re-read authority at sample end: changed epoch is incoherent, not a stable contradiction. Current activation preflight excludes normal payload mode and cannot serve unchanged as continuous monitoring.
- DB: independent bounded reads on application runtime connections. Inaccessible API or both unavailable DB observations are application_unavailable/unknown, never invented DB diagnoses.
- Storage: mapped Portal uploads, CMS uploads, PostgreSQL storage, backup and monitor-state filesystems; mount identity, existence/read-only status, available bytes and inodes. Never substitute / for missing mapping.
- Backup: last attempt separately from last verified capture, format/components, unit result and timer schedule. Preserve prior verified age while running or failed.
- Legacy writes: distinguish refused writer=legacy (the current event can also label Payload refusals) from committed writes. Existing transactional audit records need narrow nonpersonal News content-type/authority mode/epoch metadata to classify deleted revisions and write-time authority. No second ledger. Missing audit coverage or scan limits remain unknown, never prove absence.

Finite in-process request counters include process generation/monotonic counts; restart/reset is a coverage gap. No traffic is not probe success. Quiet counters cannot recover a failed active probe. API/CMS observations must be timed/bounded, using existing grants and read-only transactions with statement/lock limits. Missing CMS integration is explicitly unknown until its owner releases the contract.

## Host-phase adapter

Keep interpretation separate from collection/delivery and bind to reviewed installed verifier versions. A verified cold/held state can explain CMS absence; absence cannot infer hold. Planned hold is distinct from healthy public availability. Unknown recovery stage/profile/version gives unsupported_contract. Transitions never suppress alerts indefinitely. Future lifecycle v3 is one bounded adapter addition with owner-supplied fixtures, not changes to runner/transport and not guessed field semantics.

## Backup receipts

Narrowly instrument backup-from-timer.sh to atomically record attempt start and completion in a root-protected monitoring directory. Include attempt/invocation ID, start/finish, running/failed/verified outcome, capture timestamp, format, verified component set, manifest digest and bounded artifact metadata. Only the existing post-verification success branches may record verified. Receipt write failure is monitoring failure, not proof of corrupt backup. Preserve last verified independently of latest attempt. A receipt is not control/restore qualification.

RPO is capture age >24 hours, not directory mtime or verification time. Immediate incident on completed failure, invalid evidence or missing required components. Running backup does not reset age. Unit timeout/failure or missing receipt cannot imply success. Changed/missing artifacts invalidate cached verification. Existing daily wrapper verifies hashes; this does not promise continuous rehashing, restoration qualification or external copy. S3 is disabled: report local_only.

## Incident/delivery state

Use separate protected collector and unprivileged runner directories. Exclusive per-run lock, fixed checks, bounded validated JSON, unsafe-owner/symlink rejection. Atomic temporary write + fsync + rename + directory fsync. Persist outbox before send and accepted state only after confirmed SMTP result. Portal DB outage cannot affect deduplication.

Availability/degradation alert after two consecutive bad samples; recover after two fresh clean samples with all required evidence. Immediate: stable authenticated authority/barrier contradiction, forbidden committed legacy write, invalid backup evidence, critical disk. Disk/inode warning >=80%, critical >=90%, recovery below75% for two samples. Unknown/stale is an incident and cannot clear another incident. One notification per stable signature then one recovery, aggregate at most one bounded email per run. Refused writes clear only after continuous complete quiet coverage; forbidden committed-write evidence does not clear merely through silence.

SMTP adds detailed accepted/retryable/permanent/unknown results while preserving boolean wrapper for existing callers. Acceptance requires actual configured recipient acceptance, compatible final 2xx response and no contradictory rejected/pending recipient. Raw error text is forbidden. Connection/greeting/socket limits plus overall deadline must close/cancel transport on timeout. Temporary retries use bounded backoff, permanent/ambiguous outcomes slower. Stable notification ID/Message-ID assists dedup, but the SMTP-acceptance/local-persist crash window means exactly-once delivery cannot be promised. In-flight after crash is ambiguous. If incident state cannot be safely persisted, fail unit rather than emit untracked per-minute mail.

Limits: collector10s; individual HTTP5s; application observation10s overall; SMTP20s overall; whole cycle<50s; observation16KiB; email8KiB; incident state256KiB. All diagnostics finite; no upstream body/stderr/secret leakage.

## File ownership and implementation boundaries

Core: add cron/operational-monitor.js, cron/operational-monitor-state.js and focused supporting operational modules; modify cron/mailTransport.js and cron/sendOperationalAlert.js. Add ops/portal-operational-observe.py, ops/ownerinc-portal-observe.service, ops/ownerinc-portal-monitor.service and ops/ownerinc-portal-monitor.timer. Modify ops/backup-from-timer.sh only for monitoring receipts. Add docs/operations/operational-monitoring.md.

API: add api/operational/* and api/routes/operational.js; narrow integration only in api/index.js, api/cms/reader.js, api/owner-news/authority.js, api/routes/cms.js and api/routes/owner-news-admin.js. No api/DTO edits. Primary owns full verify and deployment wiring. Reserved: all cms/, core ops state/runtime/preparer/provisioner, Compose/lifecycle files, existing workflows/ci.yml, docs/operations/deployment.md and payload-runtime-recovery.md. Do not edit them.

Queued CMS integration exact proposed files: cms/src/operational/observe.ts, cms/src/operational/signals.ts, cms/src/endpoints/operational.ts, narrow cms/src/auth/portal-client.ts/service-access.ts and cms/src/payload.config.ts registration. These remain queued under CMS owner. Approved environment/Compose token wiring is queued under primary. Host future phase adapters remain queued with schema owner.

Tests: add tests/unit/operational-monitor.test.mjs, operational-monitor-state.test.mjs, operational-observer.test.mjs, operational-routes.test.mjs; extend cron-mail-transport.test.mjs and operational-timers.test.mjs. Add narrow sampling/audit tests within new owned monitor test files. Add a dedicated PR-scoped SMTP workflow with existing pinned actions, and its isolated fixture within owned new monitor files/tests; never edit ci.yml.

## Verification contract

Local offline injected doubles with real temporary files: failures/recovery for API/DB/CMS/bridge; rejected/malformed/oversized/timeout observations; 200 degraded/empty valid feed; no promotion/content/storage writes/controller invocation; valid hold versus absent/forged hold; epoch drift versus stable contradiction; unsupported schemas; legacy refused versus committed; disk/inodes/missing mount; backup stale/running/failure/partial/misleadingmtime/recovery; durable dedup across restart and DB outage; corrupt state/symlink/concurrency/fsync-rename failure/time reversal; SMTP retry/rejection/ambiguity/timeout/crash. Secret canaries must not appear in outputs/email/state. Native permissions qualify only in Linux CI, not Windows fixtures.

Real SMTP fixture only in isolated Linux CI: loopback synthetic .test identities, explicit clean environment, actual runner and sendOperationalAlert. Receive failure once, dedup repeat/restart, receive recovery, retain rejection pending and later deliver, bound socket timeouts, reject TLS verification failures, check envelope/content/ID, close all sockets. No production credentials or external SMTP. Native ownership and sandbox checks use disposable paths. Targeted checks first; primary runs npm run verify when stable. Do not report unexecuted CI as passed.

## External acceptance remains pending

Reviewed units/config installed and execution identities/limits/permissions/next trigger checked; mount mappings and phase adapters bound to real deployment; approved observation token provisioned; CMS integration accepted; controlled production failure/recovery delivered to OPERATIONAL_ALERT_EMAIL and human receipt acknowledged; actual operational owner accepts response responsibility; independent off-host loss detection established. Existing docs authorize the configured recipient but do not establish timer delivery. Authorization, SMTP acceptance, inbox arrival and monitored ownership are separate evidence. No invented recipient/owner and no email during this implementation. Core completion is not full OWN34 or production acceptance.

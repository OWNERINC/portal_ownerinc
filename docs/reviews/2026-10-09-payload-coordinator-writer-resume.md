# Coordinated backup — exact writer resume after CI 37982456244

Status: **uncommitted/unpushed, ready-for-fresh-read-only-review**. This is not
native recovery acceptance, independent review, or production activation.

## Evidence and source diagnosis

Read-only GitHub inspection of run `37982456244`, commit
`0fa5818d2476bf61ae84faf3953d72c9574971e6`, confirms the existing root setup,
build/scan/publication gates passed, recovery failed, qualification and production
deploy were skipped. The downloaded report confirms all three fixtures passed
initial CMS health, writer restart and quiescent comparison. Its three initial
checks are true; coordinated adapter/four-store restore acceptance is not true.
Failure: `capture_actual_coordinated_backup`, `coordinator_backup_failed`, exit 1,
`coordinatorStep=resume_writers`, `controlErrorIdentifier=null`.

**Proven source defect:** coordinator `resume()` used `compose start` with service
names rather than identities observed before stop. It neither bound the start to
the original containers nor isolated the start from Compose dependency traversal.
`cms` depends on `cms-migrate: service_completed_successfully`; initializer runs
that one-shot with `--rm --no-deps`. Compose's public v2.40.3 implementation invokes
`InDependencyOrder`/`startService` in its start path:
<https://github.com/docker/compose/blob/v2.40.3/pkg/compose/start.go>.

**Historical cause still unproven:** the available report has no raw Docker
stderr. Missing `cms-migrate` is a concrete plausible explanation, not the
recovered exact error of this CI. The regression deliberately models that
dependency error if Compose start is invoked, rather than claiming a local
Docker reproduction. No Docker daemon/service/container was operated here.

The front-1 `payload-preauthority-writer-restart.mjs` was read as a reference,
not imported or edited. Its observe-before-stop / validate-all-before-start
principle is retained, with the host adapter's own inventory/state/lease boundary.

## Bounded implementation and compatibility

- `observe-writers` runs before close/stop and captures full IDs plus fingerprints
  of immutable image/config image, labels, creation, mounts and healthcheck for
  running API/cron/CMS and optionally running Nginx. Required API/cron/CMS must
  match the already signed migrated release; ambiguity or invalid states refuse.
- The existing host key signs a purpose-discriminated ticket. It binds release,
  inventory identity, an existing journal sequence/hash, root coordinator PID and
  start ticks, and the exact inherited fd9 device/inode. The coordinator PID must
  be a live root ancestor whose fd9 references the protected lock. The runtime's
  normal constructor still validates its own inventory/root/lease/state first.
- Ticket is kept only in coordinator shell memory. **No new state schema, journal
  field, raw-trust sidecar, durable resume file or operator state setter.** Both
  v1/v2 signed journals remain strict and use the existing full replay validation.
  Snapshot origin is reread as a private 0600 signed journal entry and its hash
  uses the existing canonical-envelope convention (without the file newline).
- Resume requires closed admission, migrated floor, no pending install/restore,
  unchanged signed release/catalog/terminal audit, and a new signed backup proof
  since observation. Another coordinator process/lease cannot replay the ticket.
  An interrupted process is **not automatically resumable**: reconciliation stays
  a separate operation. `LEAVE_STOPPED` does not persist a resume authorization.
- Under the same outer fd9, validate the entire captured set before the first
  start: exact current ID/fingerprint, project/service/non-oneoff labels, legal
  exited/running status and Running/Paused/Restarting flags; worker must remain
  stopped. Replacement, missing, duplicate, foreign image/mount/label or active
  uncaptured writer refuses before a start. No lookup-by-name adoption.
- Start only captured full IDs via `docker start`; no Compose start/up, pull,
  recreate, delete or automatic dependency migration. Re-inspect exact identities
  and health afterward (API/cron/CMS require healthy; Nginx may have no healthcheck).
  Starting health gets up to 180 observations with one-second sleeps per writer;
  bad states/health/transport refuse. Existing outer timeouts remain unchanged.
- Backup resume does not mutate journal or admission. Existing verify-release and
  open-admission remain separate mandatory gates. Failure leaves admission closed
  and retained capture/proof; a partially successful start is not called recovery.
- Restore readiness also uses the ticket, not the previous `compose up`. It starts
  only original API/CMS/Nginx, leaving cron for final resume after smoke. An
  original Nginx absent/stopped is not created/adopted; if smoke needs it, the
  operation fails closed and requires explicit setup/reconciliation. No new
  fixture/harness behavior was invented to satisfy that case.
- Tool failures map to fixed reasons such as `writer_start_command_failed` or
  `writer_inspect_command_failed`. A bounded 16 KiB stderr tail stays in an
  exclusive private 0600 `payload-writer-command-<random>.stderr` file. Retention
  errors do not replace the primary failure; raw tool stderr is not echoed into
  the coordinator wire. The parser recognizes these exact guard steps/reasons;
  appended/unknown tool or cleanup output stays private/unclassified.

Report schema, 14 checks, 11 negatives, comparators, probe, seeds, initializer
audit/receipts, authority legacy/1, worker policy and productive ownership are
unchanged. Receiver/outer qualification gate remain unactivated. No front-1 owned
helper, workflow, production deploy script or state schema file was changed.

## Executable regression coverage

1. Actual Bash coordinator/backup/restore scripts with declared Docker/guard
   doubles: Compose start would fail on a missing one-shot dependency; corrected
   flow uses full raw start IDs. Seven-entry manifest/proof remains; readiness
   precedes smoke, cron resumes afterward, verify/open order is retained.
2. Actual Python runtime observe/resume plus real signed journal/HMAC/replay for
   v1 and v2, with explicit process/lease/Docker metadata doubles. Signature/process
   replay, identity/image/label/mount/state drift and missing service refuse before
   any start. Readiness excludes cron; final resume starts only cron; successful
   resume changes no journal bytes/state. Start/health failure stays closed and
   unknown tool stderr is retained privately.
3. Actual initializer → terminal → normal backup metadata → writer resume → normal
   verify/open instrumented path: immutable binding, receipts and floor audit
   remain exactly equal; resume itself advances no signed state. This is not
   Docker/DB restore evidence.
4. Actual coordinator capture failure at resume retains proof, admission closed,
   exact primary step/reason and no verify/open. Unknown output remains unclassified.
   Existing destructive cleanup-failure regression still preserves primary status.

An initial focused run caught a hash-convention mismatch in the new ticket check:
file bytes include a newline, whereas existing journal parent hashes use canonical
envelope bytes. The check now uses the existing convention; no signature/hash
gate was relaxed, and v1/v2 action-flow regressions passed after correction.

## Verification before the P2 follow-up and remaining gates

- Focused: **85 tests, 80 PASS / 5 skips / zero failures**.
- `npm run verify`: **PASS**, Portal **1,726 PASS / 12 skips**; CMS
  **448 PASS / 11 skips**; zero failures and `verify: ok`.
- `npm run security`: **zero vulnerabilities** API/cron/CMS.
- `git diff --check`: **PASS**, including repetition after documentation.
- Logs: `coordinator-resume-focused.log`, `coordinator-resume-verify.log` in the
  approved OpenCode temp directory. Skips are the existing unavailable Windows
  native ownership/root/lease branches, not skipped new transport/state tests.

Fresh independent read-only review is **required and pending**. No delegation
was made because this session is explicitly prohibited from delegating. Local
read-only self-inspection is not mislabeled as independent review. Native Linux
process ancestry/fd9 and Docker identity/health/start behavior of this patch,
backup positive completion, restore/smoke with the same pre-stop objects, all
negative cases and repeated restore acceptance remain separate authorized gates.
There was no new CI, commit/push, SSH, production action or service/DB mutation.
Pre-existing untracked files were preserved.

## Fresh reviewer P2 — parent observation step fixed

Fresh review identified a diagnostic defect in the observation call: `guard`
executed `step guard_observe_writers` inside command substitution, so only the
subshell's variable changed. On observation failure, the parent's EXIT still
emitted `writers_inventory_before`, inconsistent with the last progress frame.
The real extractor correctly refused that inconsistent transcript, losing an
otherwise recognized finite reason.

This follow-up changes only `scripts/payload-operations.sh`, its existing Bash
regression suite, and this record. Observation now sets `guard_observe_writers`
in the **parent**, then directly invokes the same guard with the same three
arguments inside command substitution. Only ticket stdout is captured; progress
is emitted once, outside the substitution. No parser relaxation, ticket binding,
runtime/state/lease or gate change was made.

The new **actual Bash coordinator** regression first failed against the previous
code with `writers_inventory_before` versus `guard_observe_writers`, confirming
the review finding. After correction, all four scenarios passed: exact
`writer_coordinator_scope_invalid`, exact `writer_inspect_command_failed`, opaque
stderr, and a known reason with appended private detail. It checks the real
STEP/EXIT match, single observation marker/primary failure frame, exact exit 2,
the real extractor's recognized reason or null, and no private detail in the
redacted diagnostic. No close/stop/start/capture occurs: admission and running
inventory remain unchanged, backup/protection directories empty, and only
preflight/observe guard calls execute. Docker/guard are declared doubles; this
is shell control-flow evidence, not native runtime/Docker acceptance.

The existing successful backup/restore shell regressions now also require the
resume guard to receive exactly the synthetic ticket stdout, with no progress
marker contamination. Existing resume-failure and private-output coverage remain.

Final checks after this P2 correction:

- Focused: **86 tests — 81 PASS / 5 skips / zero failures**.
- `npm run verify`: **PASS** — Portal **1,727 PASS / 12 skips**, CMS
  **448 PASS / 11 skips**, zero failures; `verify: ok`.
- `npm run security`: **zero vulnerabilities** API/cron/CMS.
- `git diff --check`: **PASS**, including repetition after this record.
- Logs: `coordinator-observation-p2-focused.log` and
  `coordinator-observation-p2-verify.log` in the approved OpenCode temp directory.

**Ready for another fresh read-only review**, not an assertion of reviewer
acceptance. 14 checks/11 negatives and all ticket/safety bindings remain intact.
No CI, commit/push, SSH, service/DB operation or delegation was performed; native
acceptance and production activation remain outside this local correction.

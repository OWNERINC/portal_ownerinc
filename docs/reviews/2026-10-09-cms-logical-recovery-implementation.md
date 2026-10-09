# Task 3 — independent logical recovery snapshots

Implementation worker evidence, 2026-10-09. This completes the offline snapshot
implementation, not runtime recovery acceptance. Primary owns integration, fresh
review and any separately authorized CI execution. No commit, push, dispatch,
production SSH, service changes or delegation were performed by this worker.

## Fresh-review follow-up — four bounded integration corrections

1. **Complete unsupported-object boundary:** user `pg_conversion` entries,
   unused `pg_foreign_data_wrapper` entries and extra `pg_am` entries now reject
   the snapshot with `logical_snapshot_unsupported_object`. The AM exception is
   the seven PG16 bootstrap identities (fixed OID, name, type and qualified
   builtin handler), not a name-only exemption. Those identities were inspected
   in the actual PGlite PostgreSQL catalog. No rows/sequences logic changed.
2. **Full hold budget:** five requested services each retain the 120s Compose
   allowance. Admission close has its own 120s GNU timeout and 10s kill grace.
   With the existing 30s orchestration margin, the outer command budget is
   **760,000 ms**, not seven minutes. Stop remains attempted after close rejects
   or times out. This is bounded fixture failure handling, not a pre-open gate.
3. **Partial hold results survive a throw:** the command wrapper recognizes the
   exact entire fixed status line only in `post-restore-fixture-hold` context.
   Both integer statuses must be 0..255 and agree with shell exit 0 or 2; timeout,
   missing/malformed status, extra stdout and inconsistent exits authorize no
   result. On nonzero exit the original `FixtureFailure` still throws and retains
   stderr privately, but carries the validated typed outcome. Reports now
   distinguish admission-failed/writers-stopped from admission-closed/stop-failed.
   No arbitrary stdout is carried on the exception or published. The primary
   restore/acceptance error is unchanged.
4. **Inventory producer/consumer v2:** the actual JS fixture producer now emits
   `schemaVersion: 2` and `environmentFileOwner: {uid:0,gid:0}` before canonical
   identity hashing. A regression writes the actual protected producer JSON and
   environment file, then invokes the actual Python `load`, `validate`, `identity`
   and environment owner checks. It verifies identity agreement and rejects v1,
   missing owner, wrong owner and boolean uid. On local Windows/nonroot accounts
   only the test POSIX metadata view is simulated; real files/open/path/type/link
   checks remain. Production Python policy was not changed.

The new regression exercised real handlerless FDW and unused user AM DDL in
PGlite; each snapshot rejects, and cleanup restores the baseline. Conversion DDL
cannot run on this WASM build: PG returns **58P01**, missing
`$libdir/utf8_and_iso8859_1`. That is a visible capability skip, **not** a PASS for
conversion rejection. No fake conversion rows were substituted.

**Linux conversion prerequisite is now executable in the existing recovery
runner, not documentation-only; runtime execution is still pending.** During
the source's existing quiescent snapshot check, before marking
`quiescentSnapshotComparison='passed'` or `quiescentSnapshotStable=true`, the
runner invokes `payload-logical-snapshot-conversion-probe.mjs` under one inherited
FD9 lease. Application writers remain stopped throughout. The probe accepts
only Linux/root, the disposable `payload-preauth-…-source` project, its canonical
source runtime/release paths and the exact existing Compose arguments; inherited
FD9 must match the root-owned regular lock file. Production/target/conflicting
Compose projects cannot authorize DDL.

The probe checks that api/cron/cms/cms-worker are not running, captures all **six**
components (two data, two schema, two storage), then runs actual `CREATE CONVERSION
public."fixture_conversion_<uuid-v4>" FOR 'UTF8' TO 'LATIN1' FROM
pg_catalog.utf8_to_iso8859_1` in the source Portal database via Compose `exec` and
`psql ON_ERROR_STOP`. It confirms that specific conversion's namespace, name,
encodings and qualified builtin function in `pg_conversion`. Only then does it
execute the actual `logicalSnapshotScript` and actual snapshot CLI. The CLI must
exit **2**, without process error, with the exact finite
`logical_snapshot_unsupported_object` identifier. DDL/library failure, absent
catalog entry, successful capture, unrelated CLI error, timeout or process error
cannot satisfy the prerequisite. **Linux capability absence fails; no skip.**

Cleanup uses `DROP CONVERSION` only after this invocation's CREATE succeeded,
with exactly its generated UUID name; no `DROP IF EXISTS`, fixed name or other
object cleanup is permitted. Successful cleanup is followed by another writer
check and independent all-six-component snapshot equality. A primary failure is
preserved even if cleanup/comparison also fails. The outer command is bounded at
15 minutes with per-command limits and emits only a fixed success protocol or a
finite failure stage; driver/DDL stderr stays in private command evidence.

This extends the meaning of the existing **quiescentSnapshotStable** check: source
stability additionally requires successful actual conversion rejection and
complete post-cleanup equality. All **14** existing checks and **11** existing
restore-negative cases remain unchanged; there is no twelfth negative, new
report field or workflow edit. The existing CI recovery entrypoint executes this
prerequisite automatically when primary dispatches an authorized Linux run.

Local orchestration regressions (explicit callbacks/doubles, **not engine proof**)
cover ordering, strict source argument/lease boundary, UUID ownership, absent
catalog, DDL/capability failure, unexpected success/error/timeout, cleanup-only
failure, preservation of the original error, and changes to each of the six
components. A static runner regression requires the direct `psql`/capture/CLI
path before the existing flag and restart. Actual Linux conversion execution and
four-store recovery acceptance remain unproven. PGlite's conversion capability
skip remains explicit; its actual handlerless FDW/user AM rejection tests remain
separate real-engine local evidence.

Focused follow-up checks: 24 Portal tests passed/one lease-shell skip; nine
logical PG/PGlite tests yielded eight passed/one conversion capability skip.
The hold regression executes the actual shell and **throwing command wrapper**
for success, each partial failure, both failures and a shortened synthetic guard
deadline; malformed/absent stdout cannot convert failure into success.
Previous four-fix follow-up `npm run verify`: **PASS**, Portal 1,581 passed/seven skipped;
CMS 448 passed/11 skipped, zero failures. Optional PGlite was separately enabled
in the focused run above, not in this whole-suite run. `npm run security`:
**PASS**, zero npm vulnerabilities in API/cron/CMS. CMS typecheck and
`git diff --check`: **PASS**. Latest full verify log:
`%LOCALAPPDATA%/Temp/opencode/cms-logical-snapshot-review-fixes-final-verify.log`.
Earlier shared-checkout failures recorded below are historical and superseded by
these final results, not silently reclassified as passes. No Linux runtime gate
or conversion case was executed by this worker.

### Executable Linux prerequisite — final local checks

- Focused Portal snapshot/command/inventory/conversion suite: **41 passed,
  one lease-shell skip**, zero failures. Nine conversion-specific tests are
  orchestration/static checks, not real Linux PostgreSQL execution.
- Optional PGlite enabled explicitly: **eight passed, one conversion capability
  skip** (`58P01`), zero failures. The native/Portal migrations, FDW and user AM
  tests still run on the actual local engine.
- Final `npm run verify` rerun: **PASS**, Portal **1,643 passed/seven skipped**;
  CMS **448 passed/11 skipped**, zero failures. Security: **PASS**, zero npm
  vulnerabilities API/cron/CMS. CMS typecheck and `git diff --check`: **PASS**.
- The first full run had three failures: outside-scope install-retry grant floor
  and diagnostics allowlist (`unsupported_state_shape`), plus an owned hold-test
  startup race. That test's 100ms synthetic deadline could elapse before Git Bash
  launched the guard under the parallel suite. It now gives the synthetic guard
  2s with 1s kill grace, sleeps 20s if started, and still requires the exact
  `guard\nstop\n` trace and false/true partial outcome. **No production hold
  deadline/budget changed.** Outside-scope files were not changed by this worker;
  their current shared-checkout tests passed in the final rerun.
- Logs: `%LOCALAPPDATA%/Temp/opencode/cms-logical-conversion-runtime-final-verify.log`
  (first failure) and
  `%LOCALAPPDATA%/Temp/opencode/cms-logical-conversion-runtime-final-verify-rerun.log`
  (final PASS). Final results supersede prior local full-suite counts only, not
  the outstanding runtime acceptance obligation.

This follow-up changes only the recovery runner, adds
`scripts/integration/payload-logical-snapshot-conversion-probe.mjs` and
`tests/unit/payload-logical-snapshot-conversion.test.mjs`, stabilizes the existing
owned hold regression, and updates this document. No CI dispatch/write, commit,
push, production access, Docker service changes or delegation. Linux conversion
and full positive/repeated four-store restore acceptance are still **pending**.

## CI 37964466848 / 13b6cfb — probe attribution follow-up

### Confirmed facts versus unresolved runtime cause

Read-only inspection of the actual redacted report and `gh run view --log` confirms
source `initialCmsHealthPassed=true`, primary `linux_conversion_prerequisite_failed`
with exit 2, and separate secondary `snapshot_restart_writers` exit 1. The recovery
step's public log contains only the final redacted failure message. The artifacts
list contains only `payload-preauthority-recovery-report` for recovery, not the
fixture's private stderr. No production/runner SSH or CI writes were used.

The **confirmed implementation defect** is lost attribution: the child emitted a
finite `... failed step=...` line, but the throwing command wrapper had no matching
probe context/parser. It therefore reduced every child phase/reason to the same
exit-2 diagnostic with null SQLSTATE/identifier. This patch fixes that wire defect.
The underlying Linux runtime failure's phase/reason **cannot be recovered from
the available old public evidence**, so it is not claimed fixed or assigned to a
converter/library, pgcrypto, builtin AM, encoding, module or lease hypothesis.

Ordering narrows the investigation: the parent runner's two complete snapshots
and equality assertion occur *before* the source probe. Reaching the reported
probe substep proves that those parent observations succeeded. Parent and child
both use the host `process.execPath`, absolute `cms/node_modules/tsx/dist/loader.mjs`
and `scripts/integration/payload-logical-snapshot-cli.mjs`; neither launches this
CLI inside the CMS container or relies on Node's implicit TS stripping. Child
`psql` runs in the source postgres container using the same capture script.
This rules out claiming a blanket unsupported baseline as the observed cause;
child-specific configuration/lease/driver failures remain possible. Existing
pgcrypto/catalog/AM coverage was not weakened or replaced to make CI pass.

### Precise bounded diagnostic path now implemented

`payload-logical-snapshot-probe-protocol.mjs` defines a closed canonical protocol.
It separates configuration, lease, stopped writers, baseline Portal/CMS SQL and
CLI, each archive/tree hash, CREATE, catalog presence, rejection SQL/CLI, cleanup,
post-cleanup captures and final all-component comparison. The child retains the
**first failing detailed phase**, even while cleanup/comparison/restart are attempted.
FD9/file identity now uses BigInt stats; this is hardening, not a demonstrated
explanation of the old CI failure.

The runner passes the explicit `linux-conversion-probe` context into the actual
throwing wrapper. A failure is parsed only for one exact complete canonical line,
clean outer exit **2**, no signal/process error and empty stdout. Timeout, malformed
or additional output, duplicate fields, unknown phase/reason, contradictory status
or absent context cannot authorize diagnostics or success. Success requires the
exact fixed stdout and empty stderr. The expected unsupported-object rejection
still requires the actual CLI exit 2, exact finite identifier and no process error
or signal; a DDL/SQL failure cannot stand in for rejection.

The wrapper propagates only existing report fields: finite `failureCode` and
`failedSubstep`, known `commandDiagnostic.sqlState`/error identifier and CLI logical
identifier, plus existing `snapshotMismatch` component/hash pairs when applicable.
For example, CREATE with missing library reports
`linux_conversion_create_psql_failed`, `conversion_create`, SQLSTATE `58P01`.
Known `0A000`, `42710` and `22021` also survive actual known-psql context parsing.
Native Node missing-module/extension/unsupported-stripping footers are classified
only for a clean direct CLI exit 1; names/paths/stacks remain private. Neither raw
DDL/data nor arbitrary exception messages cross the wire. No new report/check or
negative-case fields were added.

The secondary restart still uses direct `composeWithLease(... ['start', ...writers])`
in the runner's quiescence callback (currently around lines 824–827), through the
helper near lines 607–611. Its old stderr is not in the public artifact, so stale
receipts/labels/configuration are **unproven hypotheses**, not attributed causes.
`runSnapshotAndRestart` continues preserving it as secondary. No initializer/state,
runtime/preparer/receiver, finalizer or mutation-ledger code was changed.

### Local verification and remaining acceptance boundary

- The focused snapshot/probe/command/diagnostics suite passed **48 tests/two
  skips** before the final additional native-loader regression; the final
  conversion/protocol-only run passed **16 tests/one native-Linux FD skip**.
  Tests invoke the actual throwing wrapper and actual probe executable, and
  verify per-phase SQLSTATE/logical errors, malformed/timeout rejection, all-store
  mismatch hashes and preservation of primary over cleanup/restart failures.
- A real Node missing-import command exercises the finite launch classifier,
  not a synthetic module error. A new no-Docker native Linux Bash/flock → Node
  → asynchronous stdin EOF → FD9 identity check is executable in the ordinary
  Linux unit suite; **explicitly skipped on this Windows worker**. It is not
  represented as a local Linux PASS.
- Explicit PGlite rerun: **eight passed/one conversion `58P01` capability skip**,
  zero failures. Actual native/Portal reconstruction, row/sequence precision,
  handlerless FDW and user AM coverage remain passing. WASM pgcrypto and conversion
  library gaps are local limitations, never permitted Linux recovery skips.
- Final stable `npm run verify`: **PASS**, Portal **1,707 passed/11 skipped**,
  CMS **448 passed/11 skipped**, zero failures. `npm run security`: **PASS**,
  zero npm vulnerabilities in API/cron/CMS. CMS typecheck and `git diff --check`:
  **PASS**. Full log:
  `%LOCALAPPDATA%/Temp/opencode/cms-conversion-probe-attribution-final-verify.log`.
  Actual Linux conversion/recovery acceptance remains **unproven**.

Changed in this attribution follow-up: the probe, new pure protocol helper, narrow
command-wrapper/SQLSTATE diagnostic handling, one runner context option, the
existing conversion ordering regression, new protocol/real-command regressions
and this owned review document. No snapshot row/sequence/catalog exclusion change,
no outside-scope implementation edits, no CI write/dispatch, commit/push, production
SSH, Docker host-service change or delegation. Unrelated untracked files remain.

## CI 37970701268 / 5538227 — concrete producer/consumer release mismatch

The new redacted report proves `conversion_validate_fixture`, exit 2, with source
initial CMS health passed and restart exit 1 still secondary. At that phase the
probe has not inspected file ownership/modes, FD9, PostgreSQL or the CLI. Those
are not the cause of this configuration rejection.

**Concrete source evidence at 5538227:**

- `scripts/test-payload-preauthority-recovery.mjs:359–360` builds the legacy release
  from source material, and the Payload release with
  `path.join(releases, runIdentity.commit)` — a commit-addressed directory.
- The same runner at `184–196` uses that `runtime.payloadRelease` for all release
  Compose inputs: `.image-env`, both release Compose files and project-directory.
  At `806–807` it serializes those exact arguments into probe stdin.
- `payload-logical-snapshot-conversion-probe.mjs:25–32` instead hardcoded
  `releases/payload-candidate`. That expected path disagrees with **four** real
  arguments (indexes 5, 7, 9, 17). Thus the real producer is deterministically
  rejected by the old consumer. This is the confirmed primary configuration bug,
  not a pgcrypto/AM/converter/module-loader hypothesis.

### Bounded fix, strict binding retained

Pure producer functions were extracted from the runner into
`payload-preauthority-snapshot-runtime.mjs`: the actual commit-addressed release,
Compose argument list, sanitized fixture environment and serialized probe input.
Their existing valid-run semantics remain unchanged; the runner now calls those
same exported functions, making the producer executable in offline regressions.

Probe stdin additionally carries the approved parent `commit`. The parent passes
that identity explicitly as `PAYLOAD_RECOVERY_COMMIT` through `options.env`; the
existing `withLease` merge and `safeEnvironment` preserve it along with the fixture
fields, while ambient `GITHUB_SHA` and unrelated environment values remain stripped.
The consumer requires exact shape, lowercase **40-hex** commit, equality to that
independent parent environment binding, and release directory
`<own source>/releases/<commit>`. It still compares every Compose flag/path/project
exactly, with canonical source runtime paths, exact lock/held-lease markers and the
unchanged subsequent root/FD9/inode/mode checks. It does **not** learn authority from
an arbitrary supplied `--project-directory`, allow a fixed alias, or accept another
project/release/override. Private paths are never added to the report.

Configuration errors now have finite field-specific reasons: JSON/shape, runtime,
project/commit and environment bindings, lock/held marker, Python, Compose shape,
options, environment path, release paths, overrides and project argument. For
example, reversing the valid commit-addressed arguments to `payload-candidate`
emits `linux_conversion_validate_fixture_configuration_compose_release_mismatch`.
The catch handler preserves those reasons instead of overwriting them with generic
`configuration_invalid`. No new report field/check/negative case was introduced.

### Actual producer → consumer → wrapper regression

The new test reads and executes the **actual production producer source modules**,
including `createFixtureProjectNames` and `createInventory`, builds the real release
and Compose/env input, then gives its serialized JSON to the actual consumer in a
native Node child via the real throwing wrapper. It is not a hand-authored config
document or copied expected Compose array. On Windows only, the producer modules
run with Node's real POSIX path implementation in a test-local VM path ABI view;
production files/guards are unchanged. This is transport/contract evidence, **not**
Linux filesystem, lease or database-engine proof.

The actual probe executable also consumes this produced stdin/environment: fixture
validation passes, then the intentionally unleased test child is rejected in
`conversion_validate_lease`, before effects. Reversing to the old release alias,
altering any field/Compose group or stripping commit/project/lock/held exports
fails with the exact field-specific reason through the real wrapper. A static
regression requires the runner to use these tested producers; changing only a test
fixture can no longer hide this integration mismatch.

### Secondary restart: separate investigation required

The restart never invokes the probe validator. Its actual Compose producer already
used the commit-addressed `runtime.payloadRelease` before this patch. There is no
source-grounded link from this hardcoded consumer alias to restart exit 1; no
restart/resource/receipt logic was changed. Next investigation is the retained
private stderr for `snapshot_restart_writers` from the source fixture, specifically
the `composeWithLease` call now around runner `805–808`, helper `588–593`, and the
generated `docker compose … start api cron cms` invocation. Check existing container
names/service/project labels and receipt/config identity against that invocation
only after obtaining actual Docker error evidence. Stale labels/receipts remain
hypotheses; the primary configuration error is preserved independently.

### Verification of this patch

- Focused producer/configuration, conversion/protocol, command, inventory and hold
  tests: **45 passed/two native lease skips**, zero failures.
- Explicit PGlite native/Portal logical suite: **eight passed/one conversion-library
  capability skip** (`58P01`), zero failures. No Linux recovery capability skip added.
- Final `npm run verify`: **PASS**, Portal **1,712 passed/11 skipped**, CMS
  **448 passed/11 skipped**, zero failures. Security **PASS**, zero npm vulnerabilities
  API/cron/CMS; CMS typecheck and `git diff --check` **PASS**.
- Log: `%LOCALAPPDATA%/Temp/opencode/cms-conversion-producer-consumer-verify.log`.

Fresh review and actual Linux conversion/four-store recovery acceptance remain
required; no Linux recovery PASS is claimed. No CI dispatch/write, commit/push,
production SSH, Docker service mutation or delegation. No ops runtime/state,
preparer/receiver, finalizer or other worker implementation was modified.

## CI 37975805734 / cbf0497 — same-container writer resume

### Actual evidence and prerequisite order

Read the supplied redacted report and downloaded `gh run view 37975805734 --log`
read-only. The report has sole primary `restart_writers_source`,
`snapshot_restart_writers`, exit 1; source `initialCmsHealthPassed=true`,
`quiescentSnapshotComparison=passed`, `writersRestartedHealthy=false`. Target and
both restore acceptances are not started. The public log still has no private
Docker error. The failed report has not been rewritten or promoted to PASS.

At **cbf0497**, runner `779–793` invokes the actual Linux conversion executable
under the lease with the strict conversion context. Only after its exact success
output is accepted does `796` set the source comparison to passed and `801` mark
the internal snapshot flag. The probe must have created the conversion, verified its
catalog presence, observed actual CLI unsupported-object rejection, removed its
owned object and compared all six original components. Thus **this CI provides
source Linux conversion prerequisite evidence**, not just parent snapshot equality.
The public `quiescentSnapshotStable` check is correctly still false: restart
failed before the aggregate check could be marked. This supersedes the earlier
pending-source-prerequisite status; full positive/repeated four-store recovery
acceptance is still unproven.

### Proven source incompatibility versus historical error attribution

The old runner uses `composeWithLease` (`588–593`) with the same real producer of
commit-addressed Compose args as initial startup. That function executes
`/usr/bin/env -i PATH=<fixed host path> HOME=/root docker compose …`; the outer
lease/environment is not silently a different project. Profiles are unchanged:
`notifications` enables cron; `cms`/`cms-migrate` have no profile. Source initial
start (`615`) uses `up --detach --no-deps --no-recreate --no-build --pull never
api cron cms`, but resume (`806–809`) uses `start api cron cms` without dependency
isolation.

The actual repository model in `docker-compose.payload.yml:94–96` makes CMS depend
on `cms-migrate: service_completed_successfully`. The initializer at
`ops/payload-control-runtime.py:2074–2084` persists only receipted `cms-postgres` and
`cms`, using create-only `up --no-start --no-recreate --no-deps`. At `2232`, it runs
`cms-migrate` with **`run --rm --no-deps`**: the migration executes and verifies its
floor but leaves no persistent service container for Compose dependency waiting.
The legacy provision path starts postgres/api/cron; no intervening call creates a
persistent cms-migrate container. One-off migration containers are not a substitute
for the normal service container.

The actual CI log identifies runner-image `ubuntu24/20261004.327`; its immutable
[software manifest](https://github.com/actions/runner-images/blob/ubuntu24/20261004.327/images/ubuntu/Ubuntu2404-Readme.md)
lists Compose **2.38.2**. Inspection of that exact version's
[`cmd/compose/start.go`](https://github.com/docker/compose/blob/v2.38.2/cmd/compose/start.go),
[`pkg/compose/start.go`](https://github.com/docker/compose/blob/v2.38.2/pkg/compose/start.go)
and [`pkg/compose/convergence.go`](https://github.com/docker/compose/blob/v2.38.2/pkg/compose/convergence.go)
shows that `startService` calls `waitDependencies`, which excludes one-offs and
returns `<service> is missing dependency <dependency>` when a required normal
dependency container is absent. `--no-deps` is not an option on `compose start`.

**Confirmed defect:** the resume command requires a persistent dependency that
this fixture deliberately never creates. **Not recovered from historical public
evidence:** the exact stderr emitted in this CI, or whether another Docker error
occurred first. Missing cms-migrate is a deterministic source incompatibility,
not a recovered private error message. No stale label/receipt, permissions or
daemon hypothesis is promoted to fact.

### Bounded correction and diagnostics

The new `payload-preauthority-writer-restart.mjs` executable observes the physical
IDs of api/cron/cms under lease **before stop**, requiring exactly one full ID per
service, distinct IDs, expected project/service labels, non-one-off and running
state. Resume reacquires the same operation lease, inventories and inspects all
three stopped services before any start, and requires the **same IDs** with exited,
not paused/restarting state. It then uses only `docker start <captured ID>` and
inspects those same IDs for running state. Existing per-service health/readiness
checks still follow; only after they pass is writersRestartedHealthy set.

This cannot create/pull/reconfigure/relabel/adopt containers or start migration,
worker or dependency services. It preserves the original physical container config,
including legacy Portal and private CMS receipt overlay labels. No initializer,
receipt, controller state, Compose service model or signed contract is changed.
The helper reuses the actual serialized commit-bound fixture configuration and
sanitized parent environment producer. It requires the existing root-owned
canonical lock/held marker, Linux/root, FD9 dev/inode identity and safe mode before
Docker inspection or effects.

The complete callflow provisions and seeds **all three** fixtures (`provisionProject`
source, target and leaseTarget). The shared exact configuration validator was
extracted from the probe into the runtime helper: conversion still explicitly
passes only `['source']`, while resume explicitly allows the three known runtime
directory/project suffix pairs `source/-source`, `target/-target` and
`lease-target/-lease`. This policy is hardcoded, not a stdin-selected option;
cross-role/project/path/Compose bindings remain rejected. Actual producer/CLI
regressions cover all three fixtures and prove target/lease rejection by conversion.

Closed helper diagnostics carry only finite phase/service/reason/state. The real
throwing wrapper accepts them only in `snapshot-writer-restart` context with clean
exit 2, empty stdout and one canonical stderr line. Observe success requires an
exact canonical three-ID response (private transport, never a report field);
resume success requires one fixed line and empty stderr. Missing, ambiguous,
replaced/foreign identities, invalid physical state, inventory/inspect/start/verify
failures and known Compose/Docker errors now distinguish themselves through the
**existing** failureCode/failedSubstep/commandDiagnostic fields. For example:
`writer_restart_cms_inventory_missing`,
`writer_restart_api_inspect_state_invalid_running`, or
`writer_restart_cron_start_command_failed_exited`. Arbitrary exit 2/output does not
become successful resume, and primary snapshot/conversion errors retain precedence
over resume failures. No new report field, check or negative case is introduced.

Known dependency-missing, unknown-service, no-container, container-not-found and
daemon-unavailable errors map to finite enums only after a failed actual command.
Unrecognized stderr remains `command_failed` at the observed phase/service, with
its bounded raw bytes retained in a unique private
`<runtime>/writer-restart-<uuid>/private-diagnostics/command-stderr.txt`. Neither
paths, IDs, labels, errors nor stacks cross the public diagnostic protocol. The
outer wrapper also retains its private failure evidence. Evidence write failure
does not replace the original failure.

### Tests and checks

- Actual inventory/release/Compose/environment/JSON producer modules now emit both
  observe and resume requests; the actual restart executable consumes them through
  the actual command wrapper and refuses an unleased child at the lease phase,
  before Docker. This is executable producer/consumer validation, not a manually
  typed configuration document.
- Orchestration tests explicitly double Docker state only: require validation of
  all services before the first effect, no adoption/recreation, partial-start
  attribution, post-start state checks, known errors, strict codec/redaction and
  primary-over-secondary preservation. A static regression checks the actual
  Compose/initializer one-shot mismatch and the runner's before-stop observation,
  prerequisite-before-comparison-before-resume/readiness order.
- The full native Linux root Bash/flock → actual CLI → fake Docker executable test
  checks actual argument/environment transport, before-stop ID capture and resume
  of those IDs. No Docker daemon is involved. It is **explicitly skipped on this
  Windows host**, not reported as Linux/service acceptance.
- Final focused run: **55 passed / three native lease skips**, zero failures.
- Explicit PGlite suite: **eight passed / one local conversion-library `58P01`
  capability skip**, zero failures; no Linux capability skip added.
- First full verify attempt failed in a new static test whose YAML/initializer
  assertion used the wrong source spelling. Corrected the test to the actual
  multiline dependency and create-only initializer; production ops/model untouched.
- Final `npm run verify`: **PASS**, Portal **1,722 passed / 12 skipped**, CMS
  **448 passed / 11 skipped**, zero failures. Log:
  `%LOCALAPPDATA%/Temp/opencode/cms-writer-restart-final-verify.log`.
- `npm run security`: **PASS**, zero vulnerabilities in API/cron/CMS.
  `npm --prefix cms run typecheck` and `git diff --check`: **PASS**.

The patch is uncommitted and requires independent fresh review by the primary
before integration. No delegation, CI dispatch/write, commit/push, SSH, live Docker
service operation or outside-owned ops/runtime/state edits were performed. The
14-check/11-negative acceptance contracts are retained. Another authorized Linux
wave is needed for **resume and full four-store acceptance**; this local patch has
no recovery PASS. If resume still fails, the finite observation phase/service/reason
is now actionable and the exact raw unknown cause stays in the private runner file.

## Acceptance boundary

The runner now compares independent observations of the two databases and two
storage trees. It does not trust the controller's data fingerprint as its own
snapshot. `pg_dump` output is private diagnostic evidence only, never an
acceptance hash. Signed native-catalog comparison, role/grant checks, authority,
writer holds and all negative restore guards remain mandatory and unchanged.

The previous CI `37918102226`/`7893d35` reported a residual `snapshot_cms_media`
assertion substep. Its exact differing component is unknown. The earlier real
PG/PGlite CHECK reparse reproduction demonstrates a text-comparison defect, not
the exclusive cause of that particular CI failure.

### Database schema

The fixture captures PostgreSQL catalog sections in a repeatable-read/read-only
transaction, with fixed encoding, search_path, timezone and text-output settings.
Actual user namespaces, including empty/extra namespaces, are included. Sections
cover relations, visible columns in logical order, types/enums/domains/composites,
defaults, indexes, constraints, routines, non-internal triggers, views/rules,
materialized views, policies, inheritance/partitions, sequence parameters and
ownership, collations, extended statistics, extensions, casts and security labels.
OIDs are resolved to logical names. Dropped physical attribute-number holes do
not change logical ordinals; reordering visible columns does change the hash.
Metadata/comments/options represented by these sections remain bound.

Owners and ACLs retain the old fixture's `--no-owner --no-privileges` boundary;
they are not silently treated as irrelevant to security. Separate production
role/grant verification still rejects drift. Internal FK triggers are represented
by their constraint, not unstable OID-generated trigger names.

Unsupported user relation/type categories, aggregates, operator classes/families,
operators, text-search objects, publications/subscriptions, event triggers,
foreign servers, large objects, transforms and additional languages fail closed.
No unsupported section is silently omitted. A finite unsupported-object error
does not publish object names or schema content.

### CHECK semantics and intentional invalid catalogs

The snapshot does not invoke the strict native validator before capturing a
negative fixture. Weak CHECKs, empty namespaces, extra enum/types and materialized
views must remain observable so before/after equality can be tested.

The CLI consumes the narrow pure helper interface
`canonicalObservedCheckDefinition(definition: string): string`. This mode keeps
observed casts and quoted identifiers; it does not inherit the native validator's
reviewed cast equivalences or use expected definitions as output. It normalizes
redundant grouping through the same SQL parser. Unknown grammar is retained as
marked raw text, not discarded or replaced with `true`.

### All rows and sequences

Each discovered user table/partition/materialized view is read with `ONLY` so
inheritance does not double-count rows. PostgreSQL constructs a JSONB map of
column to **SQL text value or SQL NULL**. The whole map is carried as a JSON
string; Node never parses row numbers. This preserves numeric precision above
2^53, SQL NULL versus JSON null, JSON lexemes, array bounds, and null composites.
Schema binds each column's actual type. Byte sorting and length-framed hashing
preserve duplicate rows. Empty and zero-column tables still have identities and
checked counts. There are no exclusions for sessions, migration ledgers or other
operational tables.

Every user sequence binds type/start/increment/min/max/cache/cycle/owned-by and
`last_value`/`is_called`. Int64 values travel as strings. Reads never call
`nextval`. Sequences are not MVCC; the existing writer/quiescence barriers are
still required. Limits are explicit: 32 MiB transport per database, 100,000 rows,
120s statement timeout. Buffer overflow, count mismatch, missing catalog section
or missing table/sequence fails; hashed input is never silently truncated.

### Files, diagnostics and fixture failure hold

The existing tar-tree contract remains: ordered paths, type, modes, sizes and
content hashes, including import staging. Archive order, mtime and uid/gid were
already excluded from that contract; no new normalization was added. Mutation
regressions cover bytes, modes, paths, type, extra/missing files and staging.

The report separates successful coordinator return from complete snapshot
comparison. Post-operation assertions have fixed substeps. Mismatch details are
restricted to six component IDs and expected/observed hashes. Private dump/tar
copies are capped at 1 MiB/component with explicit original size/truncation,
stored under mode0700/0600 and not uploaded as public artifacts. The diagnostic
cap never affects logical hashes.

If acceptance fails after a coordinator returned successfully, the runner tries
to close admission and stop writers in **every disposable fixture** under each
fixture's lease. Stop is attempted even when admission close fails. Results are
reported separately; hold errors retain private diagnostics and do not replace
the primary acceptance error. This is a fixture post-operation fail-safe, **not a
production pre-open verification gate**. It never reopens admission. A failed
hold is reported as failed, not claimed safe.

## Verification evidence

- Focused Portal tests: 21 passed, zero failures/skips. Includes actual synthetic
  shell hold execution: guard failure still reaches stop, and stop failure does
  not masquerade as success.
- Optional PGlite tests explicitly enabled: 28 passed, zero failures/skips across
  logical snapshots, real native catalog queries and catalog regressions.
- Six actual CMS migrations and Portal migrations are executed in PG16.4/WASM;
  observed logical schema reconstruction preserves rows and full sequence
  parameters/state/ownership. Dropped physical columns and altered row order do
  not cause false mismatch; logical column reorder, row edits/deletion, precision,
  NULL distinctions, sequence state/settings and same-name index/routine changes
  do cause mismatch. Intentional invalid native catalogs remain capturable.
- Portal PGlite test omits **only** the `CREATE EXTENSION pgcrypto` loader because
  the available WASM library fails to resolve `EVP_bf_cbc`; PostgreSQL's native
  `gen_random_uuid` is available. Real capture includes extensions and functions;
  pgcrypto Linux equivalence remains runtime evidence, not a local PASS claim.
- The first focused rerun after resumption timed out at the CLI test's 30s local
  process cap. The cap now matches the command boundary's 120s budget, and the
  focused rerun passed. A full execution has not been inferred from that failure.

Final checks on the shared in-progress checkout:

- `npm run verify`: **FAIL**, 1,479 Portal tests passed, six skipped and two failed
  outside this worker's owned snapshot implementation. The failures were
  malformed-byte rejection in `payload-candidate-qualification.test.mjs` and
  allowlist synchronization for new adapter reason `invalid_environment_file_owner`
  in `payload-preauthority-diagnostics.test.mjs`. Full verify stopped before its
  CMS phase. This worker did not change either other worker's implementation to
  conceal those failures. Log:
  `%LOCALAPPDATA%/Temp/opencode/cms-logical-snapshot-final-worker-verify.log`.
- Final `npm run verify` rerun after the last schema metadata addition also
  **FAILed**: 1,514 Portal tests passed, seven skipped, two failed. The malformed
  byte test had advanced; the remaining failures were
  `payload-candidate-package.test.mjs` (`private_or_reserved_source_path`) and the
  same missing `invalid_environment_file_owner` diagnostic allowlist entry.
  Again, verify stopped before CMS; snapshot tests in that run passed. Log:
  `%LOCALAPPDATA%/Temp/opencode/cms-logical-snapshot-final-worker-verify-rerun.log`.
- `npm --prefix cms run test:unit`: **PASS**, 447 passed, ten skipped, zero failures.
  Optional PGlite was not enabled for this whole-suite run; the separate explicit
  PGlite focused run above exercised the actual SQL and reported no skips.
  An initial `npm --prefix cms test` attempt failed because CMS has no `test`
  script; it was corrected to the repository's actual `test:unit` command.
- `npm --prefix cms run typecheck`: **PASS**.
- `npm run security`: **PASS**, zero npm vulnerabilities across API, cron and CMS.
- `git diff --check`: **PASS**.
- Final logical PG16/PGlite rerun after adding type-function identities and ICU
  metadata: five logical snapshot tests passed, zero failures/skips. Typecheck
  and diff-check were repeated after that change and passed.

Shared-checkout integration failures remain for primary/the respective file
owners. Local reconstruction is not Linux pg_dump/restore, not a lease or
role/grant runtime test, and not four-store acceptance.

## Integration ownership

The owned implementation files are `payload-logical-snapshot*`,
`payload-preauthority-snapshot*`, the recovery runner/flow, their Portal tests and
`cms/tests/unit/logical-recovery-snapshot-pg16.test.ts`.

Before the narrowed ownership message, this worker also edited:

- `cms/scripts/finalize-news-protocol.ts` — pure helper/export and parser mode;
- `cms/tests/fixtures/recreate-native-catalog.ts` — test clone preserves rows,
  sequence type/state/ownership, schema comment and extensions;
- `scripts/integration/payload-preauthority-command.mjs` and
  `payload-preauthority-diagnostics.mjs` — explicit logical CLI error context,
  finite error codes, output-limit and query-canceled diagnostics;
- `docs/operations/payload-runtime-recovery.md` — earlier task narrative.

These pre-existing edits were preserved, not reverted or further broadened after
ownership was narrowed. Primary should integrate them with their owners. Other
workers' finalizer/mutation-ledger edits and untracked documents/cache are not
this worker's changes. This review document is the only documentation file edited
by this worker after the new ownership message.

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

# Task 4 — completion and evidence report

**Delivery status: PARTIAL / BLOCKED.** Task 4 source, tests and docs are committed;
offline focused checks pass. The prior full `npm run verify` failed on Windows
temporary-directory and Academy issues, and its smoke-origin metadata discrepancy
passed in one isolated run but remains unexplained in the full-suite context. Every
real service/browser case is `NOT_EXECUTED`. This is not acceptance or production
readiness.

## Scope and commit

- Tested base: `55bd6c66ba2bb49a3e9cf5c3768538bde5c471d5` plus Task 4 source
  commit `19d9c2fdd90140df6a453f4bdeb09462236e556f`.
- No Task 1–3 product implementation was repeated or changed. Task 4 changes are
  limited to Portal CSP, router/auth/media/mobile regressions and harness support,
  acceptance runner/tests, reader operation/architecture docs and reports.
- Owner News product files, editorial data/schema and publication behavior are
  unchanged.

## Offline verification

| Command | Result |
| --- | --- |
| `node --test --test-skip-pattern='^Academy initial/repeated error focuses usable retry' tests/unit/portal-contents-routing.test.mjs tests/unit/portal-contents-acceptance.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/task-7-shell-mobile.test.mjs` | exit 0; 82 passed, 0 failed, 0 skipped |
| `node --test --test-skip-pattern='^Academy initial/repeated error focuses usable retry' tests/unit/portal-contents-routing.test.mjs tests/unit/portal-contents-acceptance.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/task-7-shell-mobile.test.mjs tests/unit/persistent-navigation.test.mjs tests/unit/auth-stability.test.mjs tests/unit/portal-contents-media.test.mjs tests/unit/academy-player.test.mjs tests/unit/owner-news-reader.test.mjs` | exit 0; 223 passed, 0 failed, 0 skipped |
| `node scripts/generate-public-shell.mjs --check` | exit 0; generated shell is current |
| `git diff --check` | exit 0 |
| `node scripts/test-portal-contents-acceptance.mjs --check-config` | `CONFIG_VALID`; all cases `NOT_EXECUTED`; process exit 2 by contract; no evidence write |
| `node scripts/test-portal-contents-acceptance.mjs --aggregate` | manifest has 15 records, all `NOT_EXECUTED`; status `NOT_EXECUTED`, exit 2; no errors |
| `npm run verify` with `NODE_OPTIONS="--test-skip-pattern=^Academy initial/repeated error focuses usable retry"` | exit 1; 2,139 discovered tests: 2,103 pass, 17 fail, 19 skipped; syntax and CMS typecheck completed before root tests |

The previous `npm run verify` failures were recorded; this follow-up did not rerun
the broad suite:

1. Four `EPERM` temporary-directory failures in `payload-preview-https.test.mjs`
   and ten in `payload-preview-preparation.test.mjs`, attempting `mkdtemp` under
   `C:\Users\payload-*`.
2. `academy-frontend.test.mjs` / “catalog restores the initiating filter focus
   after remount…” failed after about 154 seconds with
   `RangeError: Array buffer allocation failed`.
3. The prior full-suite observation for `smoke-origin.test.mjs` / “rejects entry
   without mount export” returned null metadata where the test expected
   `{check:'autocard_entry',reason:'module',httpStatus:200}`. In the Task 4 round 1
   isolated run, that exact case passed; the original full-suite discrepancy is
   not reproduced, but its cause remains unproven and is not called unrelated.

The 17 failing count includes the failed parent suite. `npm run verify` stopped
before CMS unit tests, secret scanning, DHO naming and Compose validation. Root
test discovery included all `tests/unit/owner-news*.test.mjs`, including
`owner-news-reader.test.mjs`; none is among the failures. The focused suite also
ran `owner-news-reader` directly and passed.

## Service, browser and manual acceptance

- Run ID: `a72e87b2-f750-4d51-88e3-ffe8d92a6a68`.
- Authorization reference: the supervising task authorized only a uniquely named
  **disposable local Docker stack**. No project/stack name or resource IDs were
  selected. Authorization was not broadened to VPS, production, deploy or remote
  actions.
- Read-only `docker info --format '{{.ServerVersion}}'` failed because the Docker
  Desktop Linux engine pipe `npipe:////./pipe/dockerDesktopLinuxEngine` is absent.
  No Docker command started services.
- Browser handoff was unavailable without a local stack; no browser, viewport,
  screen reader or DevTools session was used. Firebase Auth Emulator and Firebase
  real were not used.
- External evidence directory:
  `C:\Users\Criação\AppData\Local\Temp\opencode\portal-contents-acceptance-a72e87b2-f750-4d51-88e3-ffe8d92a6a68`.
  Its `portal-contents-acceptance.json` manifest contains all 15 exact case names
  as `NOT_EXECUTED`, with `artifact: null` and browser/viewport `NOT_EXECUTED`.
  It contains no cookies, tokens, HAR, storage state, screenshots or personal data.

| Required case | Result | Evidence not obtained |
| --- | --- | --- |
| `live-auth-gate` | NOT_EXECUTED | Live `/users/me`, availability, active/inactive auth and CMS outage |
| `catalog-routing` | NOT_EXECUTED | Real browser routing, pagination, tabs, Back/Forward and refresh |
| `native-image` | NOT_EXECUTED | Real 204 issuance, scoped cookie and native image GET |
| `native-range` | NOT_EXECUTED | Real Nginx 206/416, streaming and cancellation |
| `long-video-renewal` | NOT_EXECUTED | >6-minute playback and refresh without source reset |
| `media-failure-recovery` | NOT_EXECUTED | Real network/429/expiry and revision replacement recovery |
| `large-pdf` | NOT_EXECUTED | Large native PDF and standalone-tab cookie expiry behavior |
| `auth-exit-cross-tab` | NOT_EXECUTED | Two real tabs, account switch/logout and revoked asset request |
| `gallery-keyboard` | NOT_EXECUTED | Manual key sequence, focus, inert, backdrop and mobile drawer |
| `screen-reader-gallery` | NOT_EXECUTED | Actual browser/screen-reader accessibility-tree and speech check |
| `embeds-effective-csp` | NOT_EXECUTED | Effective Nginx headers and actual provider playback |
| `layout-mobile` | NOT_EXECUTED | 320/375/768/1440 viewports, 200% zoom, touch, motion and screenshots |
| `bfcache-cleanup` | NOT_EXECUTED | Real `pageshow.persisted` and ten browser enter/leave cycles |
| `owner-news-regression` | NOT_EXECUTED | Browser smoke of News/Academy/editor; offline regressions passed |
| `editorial-accessibility` | NOT_EXECUTED | Manual PDF tagging/reading order and authored video alternatives |

No service/manual PASS is claimed. Emulator evidence, if later gathered, must not
be generalized to Firebase real.

## Cleanup record and remaining concerns

Cleanup for this acceptance: **none required**. No Compose project, containers,
volumes, network, published ports, database rows, CMS fixtures, users, media assets,
browser state or Nginx reload were created. No `docker compose down`, `down -v` or
deletion command was run. The external evidence directory is retained with only
the sanitized NOT_EXECUTED manifest; no fixture cleanup is pending.

Remaining blockers are the previously failed broad `npm run verify` conditions,
the unproven cause of its smoke-origin discrepancy and unavailable named
stack/browser prerequisites. Real HTTP authorization, native Range streaming,
effective CSP/playback, PDF behavior, screen-reader output and BFCache remain
unproven. Procedure and cleanup instructions are in
[`docs/operations/portal-contents-reader.md`](../../../docs/operations/portal-contents-reader.md);
the acceptance matrix is in
[`docs/reviews/2026-10-20-portal-contents-reader-acceptance.md`](../../../docs/reviews/2026-10-20-portal-contents-reader-acceptance.md).

## Post-commit finalization

- Task 4 source/tests/docs commit: `19d9c2fdd90140df6a453f4bdeb09462236e556f`
  (`test(contents): complete task 4 acceptance coverage`).
- Created the sanitized external `portal-contents-acceptance.json` manifest after
  that commit. It contains all 15 required cases with the source commit SHA,
  matching run ID, `status: NOT_EXECUTED`, and `artifact: null`.
- Ran `node scripts/test-portal-contents-acceptance.mjs --aggregate` with the
  guarded disposable-local test configuration: **status `NOT_EXECUTED`, exit 2**,
  all 15 cases `NOT_EXECUTED`, and no errors. Aggregate acceptance remains
  blocked; this is not a PASS.

## Task 4 fix round 1 — RED/GREEN and smoke diagnosis

### Acceptance metadata and router harness

- **RED:** `node --test --test-timeout=30000 tests/unit/portal-contents-acceptance.test.mjs tests/unit/portal-contents-routing.test.mjs`
  initially reported **25 passed / 5 failed** after adding execution timestamps
  and the isolated-identity regression. The valid PASS fixture and the current
  `NOT_EXECUTED` fixture failed the old exact-key validator; the real isolated
  getter remained at user A after notifying user B. The placeholder regression
  was tightened to require a `*_placeholder` reason, so a shape/configuration
  error cannot satisfy the exploit test.
- **GREEN:** after the validator and harness changes, the same focused suites
  reported **31 passed / 0 failed / 0 skipped**. Coverage includes the all-PASS
  exploit using `NOT_EXECUTED`, `NOT EXECUTED`, `NOT-EXECUTED` and
  `not_executed` across browser/viewport/scenario/notes; empty/TODO/TBD/unknown/
  n-a variants across provenance fields; real PASS metadata; canonical ordered
  timestamps; generated `NOT_EXECUTED` records; non-placeholder optional artifact
  paths; and getter/subscriber agreement. A separate real-auth harness check
  confirms Firebase auth remains the identity source of truth.
- Record schema now requires `startedAt`/`finishedAt` for executed PASS/FAIL,
  permits both `null` only for an unexecuted case, requires browser/version and
  viewport dimensions for executed evidence, and scans all required provenance
  fields for placeholders. `NOT_EXECUTED` aggregation still returns exit 2.

### One-case smoke-origin diagnosis

- A first test-name-pattern attempt matched the containing parent and ran sibling
  HTTP cases; it hit the parent's 30-second timeout before the target. The test
  runner process ended after 59,232 ms (exit 1; 34 reported, 8 passed, 24 failed,
  2 cancelled). A `--test-only` selector probe then emitted only a file-level
  result and no nested-case name, so it was not treated as diagnosis. Captures:
  `C:\Users\Criação\AppData\Local\Temp\opencode\portal-contents-smoke-round1-stdout.txt`
  and `...-stderr.txt` (stderr empty).
- Added a test-only environment selector that skips sibling smoke cases without
  changing production source, parser or deploy behavior. The **single qualifying
  target run** used `PORTAL_CONTENTS_SMOKE_ORIGIN_CASE='entry without mount export'`
  and `node --test --test-timeout=30000 tests/unit/smoke-origin.test.mjs`.
- Captured runner metadata: start `2026-10-21T18:06:07.8213875Z`; wall time
  6,462 ms; Node test timeout 30,000 ms; exit 0. Runner stdout:
  `rejects entry without mount export (6174.7121ms)`, parent 6,240.0608 ms,
  `tests 3 / pass 2 / fail 0 / skipped 1`; runner stderr was empty. Captures:
  `C:\Users\Criação\AppData\Local\Temp\opencode\portal-contents-smoke-round1-actual-stdout.txt`
  and `...-actual-stderr.txt`.
- The target assertion parsed the actual smoke failure diagnostic as
  `{check:'autocard_entry',reason:'module',httpStatus:200}` from the intentional
  fixture with `export function mount` removed. `scripts/smoke.sh` reports this
  sanitized failure on stderr; its accepted canonical record is
  `{"check":"smoke","status":"failed","attempts":1,"diagnostic":{"check":"autocard_entry","reason":"module","httpStatus":200}}`.
  No response body, URL, header, token or cookie is included. The parser and
  expectation agree in the isolated run; the old full-suite-only discrepancy is
  unresolved. No production source or parser semantics were changed.

### Operational handoff and remaining status

- Expanded the tracked runbook with shared fixture/prerequisite rules, exact
  steps/PASS criteria for all 15 service/browser/manual cases (including 10 block
  types × five layouts plus default, Range variants/streaming, renewals, both
  cross-tab transports, late issuance, BFCache and accessibility), and a
  sanitized JSON shape-only record. The review matrix records matching criteria.
- The live-service/browser/manual result remains **15 × `NOT_EXECUTED`**. Docker,
  Portal services, Nginx and a real browser were not started; this follow-up only
  ran the named unit smoke case's ephemeral loopback fixture. Cleanup for test
  fixtures was handled by the test harness; the captured sanitized logs remain
  outside the checkout.
- Final scoped checks after the follow-up edits: acceptance/router **31 passed**;
  persistent-navigation/auth-stability **55 passed**; `git diff --check`, public
  shell generation check, syntax verification and security verification all exit 0.
  The broad `npm run verify` was not rerun.

## Fix round 2 — procedure-coverage closure (2026-10-21)

- Expanded the existing 15 runbook cases in place with directly executable
  preconditions, steps, and case-specific PASS criteria. Coverage now calls out
  the zero-publication sidebar gate versus authenticated deep links, three
  independent availability triggers, query canonicalization/hostile inputs and
  native modified-link gestures; private original-path denial; prefix,
  open-ended, suffix, unsatisfiable and multi-range requests; hidden-tab renewal,
  post-five-minute seek, measured 5/15/30-second retries and retry exhaustion;
  PDF lease-release/expiry/open/download fallback; failed logout clear and
  editorial revoke; gallery recovery/focus/Back/backdrop/mobile-drawer behavior;
  real assistive-technology checks; and Owner News/logout regression.
- Replaced the abbreviated responsive fixture instruction with an explicit
  ten-block × five-layout matrix plus one omitted-layout fixture per block (60
  cells), and added 320/375/768/1440 widths, 100%/200% zoom, mobile sidebar states
  and measured 44×44 CSS-pixel touch-control criteria. BFCache now requires a real
  `pageshow.persisted === true` return among ten recorded cycles.
- Added `tests/unit/portal-contents-reader-runbook.test.mjs` to bind all 15 case
  anchors to the review matrix, assert the reviewer-identified procedure markers,
  verify all layout cells, and protect the acceptance record schema/privacy
  guidance. The review matrix now links each outcome to its runbook procedure.
- Secret-safe evidence guidance now specifies sanitized `key=value` observations
  (status, elapsed time, counts, booleans, viewport/layout and measured timings)
  and explicitly prohibits credentials, IDs, full URLs/queries, private bodies,
  HAR, storage/channel payloads and unsanitized screenshots.
- Scope remained documentation, review references and tests only; no production
  code was changed. The external acceptance manifest was left untouched and still
  contains exactly 15 `NOT_EXECUTED` outcomes with null timestamps. No live
  service/browser acceptance was performed; Docker's Linux daemon was unavailable.
- **Checks:** focused acceptance/router/navigation suite — **60 passed, 0 failed**;
  `node scripts/generate-public-shell.mjs --check` — exit 0;
  `git diff --check` — exit 0. Broad `npm run verify` was not run.

## Fix round 3 — hidden renewal and Owner News media contract (2026-10-21)

- Tightened `long-video-renewal`: PASS now requires the authenticated
  `POST /api/contents/media-session` to return 204 with request/response observed
  while the document is still hidden and the video is still playing. A later
  visibility/focus recovery is a separate observation and cannot satisfy hidden
  renewal. The runbook limits capture to redacted method/path, status, timestamps
  and necessary boolean playback/visibility state; it forbids request/response
  headers, cookies, body and HAR. If suspension prevents observing the complete
  hidden-playing response, both the subcase and whole case remain
  `NOT_EXECUTED`; an observed unsuccessful renewal is `FAIL`.
- Expanded `owner-news-regression` to open a synthetic published News article and
  invoke its existing private image/video/PDF action through the regular UI. It
  now requires the `owner-news` scope to resolve to the authenticated
  `GET /api/announcements/assets/:id` contract, expected 200/MIME and
  `private,no-store`/`nosniff` headers, plus the existing native image/video/PDF
  rendering/open/download behavior. It distinguishes the UI's authenticated
  Blob-to-native-element flow from HTTP Range testing, verifies unauthenticated
  or post-logout denial without bytes, and preserves published reader access for
  active viewers without `manageKnowledge`.
- Updated the review row and the runbook invariant test to require these semantic
  markers, including hidden+playing 204, foreground separation, suspension
  handling, private News endpoint/status/headers, native element use, and
  unauthorized/logout denial. Acceptance outcomes remain **15 × `NOT_EXECUTED`**;
  no production code or external manifest was changed and no live service/browser
  acceptance was performed.
- **Checks:** focused documentation/acceptance tests — **19 passed, 0 failed**;
  `git diff --check` — exit 0. Broad `npm run verify` was not run.

# Task 4 — completion and evidence report

**Delivery status: PARTIAL / BLOCKED.** Task 4 source, tests and docs are committed;
offline focused checks pass. Full `npm run verify` fails in unrelated
Windows/Academy/smoke test areas, and every real service/browser case is
`NOT_EXECUTED`. This is not acceptance or production readiness.

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

The `npm run verify` failures were recorded, not fixed out of scope:

1. Four `EPERM` temporary-directory failures in `payload-preview-https.test.mjs`
   and ten in `payload-preview-preparation.test.mjs`, attempting `mkdtemp` under
   `C:\Users\payload-*`.
2. `academy-frontend.test.mjs` / “catalog restores the initiating filter focus
   after remount…” failed after about 154 seconds with
   `RangeError: Array buffer allocation failed`.
3. `smoke-origin.test.mjs` / “rejects entry without mount export” returned null
   metadata where the test expected
   `{check:'autocard_entry',reason:'module',httpStatus:200}`; its parent real-smoke
   suite also failed because of that subcase.

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

Remaining blockers are the failed `npm run verify` cases and unavailable named
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

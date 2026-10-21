# Task 3 Media Hardening Implementation Plan

**Goal:** Close the authenticated media-issue deadlock and all seven reported media/lifecycle defects, with behavioral regression coverage and no Task 4 or Owner News changes.

**Architecture:** Keep media issuance on centralized `authenticatedFetch`. Add an internal, response-metadata-only raw-transport-settled callback that fires before centralized auth error handling; the coordinator's clear barrier waits for that boundary, then preserves its second DELETE for a potentially late cookie. Make resource activation, playback, gallery recovery, and disposal explicitly generation- and owner-scoped.

**Tech Stack:** Existing browser ES modules, Firebase Auth transport, dependency-free Node `node:test`, fake DOM/clock harnesses.

## Global Constraints

- Keep same-origin native URLs, bodyless media-session requests, and no Blob buffering.
- Never expose tokens, cookie values, private response bodies, storage keys, or filesystem paths.
- Preserve identity/generation fencing and the late-POST clear barrier.
- Do not change API, Nginx, deploy, Owner News, or Task 4 behavior.
- Maintain Node 18 syntax compatibility for shared public code; project verification uses Node 24.
- Do not start Docker services or contact production services.

---

## Files and ownership

- `public/js/auth.js`: strip the internal settlement callback before raw fetch; invoke it exactly once on response or transport error before auth response handling.
- `public/js/portal-contents/media-session.js`: consume raw settlement, preserve the two-DELETE barrier, track playing resources, and recover expired leases on visible/focus checks only for live leases.
- `public/js/portal-contents/media.js`: make initial/pending activation idempotent on `ready`; resource-keyed playing state; generation-fenced playback/recovery intent; explicit embed disposal.
- `public/js/portal-contents/gallery.js`: shared per-asset retry budget, validated reload fallback, and exact thumbnail listener cleanup.
- `tests/helpers/portal-contents-harness.mjs` plus an auth/media integration fixture: deferred raw/auth transport and lifecycle race controls.
- `tests/unit/portal-contents-media.test.mjs`, `tests/unit/portal-contents-gallery.test.mjs`, `tests/unit/auth-stability.test.mjs`, and adjacent routing/lifecycle tests: RED/GREEN behavior evidence.
- `.superpowers/sdd/2026-10-20-portal-contents-reader/task-3-report.md`: append this fix round's RED/GREEN and verification evidence.

## Implementation sequence

### 1. Reproduce defects with behavioral RED tests

- Build an integrated VM fixture that loads real `auth.js` and the real media coordinator. Make `/api/users/me`, media POST, editorial revoke, and raw DELETE deferred. Confirm 401 and terminal 403 do not deadlock, and a raw 204 arriving after first DELETE is followed by a second DELETE before redirect/sign-out.
- Add a multi-video hidden-page test: play A and B, pause B, advance the injected clock to 240 seconds, and require one renewal while A remains active.
- Add video intent tests: a user pause clears resume intent; recovery pause preserves it only for its generation; a stale `loadedmetadata` cannot resume; manually paused playback remains paused.
- Add 503→automatic retry→204 behavior for image, gallery thumbnail, video, and PDF; repeated ready notifications must not duplicate activation or change active video source/currentTime.
- Add visibility/focus tests for an expired lease whose `expiresAt` was cleared while hidden, with disposed and old-identity generations remaining unable to issue.
- Add gallery thumbnail/lightbox repeated-native-failure tests, asserting one fresh lease attempt then one accessible content reload per activation, reset only by a new view/DTO generation.
- Add embed-only disposal and exact thumbnail listener removal tests; dispatch late events after disposal and assert detached DOM is unchanged.
- Run the focused tests and record the intended RED failures before implementation.

### 2. Break the auth/coordinator wait cycle without weakening auth

- Extend the internal request options with `onRawTransportSettled({status})`; `authenticatedFetch` removes it from fetch options and invokes it once immediately after raw fetch settles, before `handleAuthenticationFailure` can await `finishSessionExit`.
- The callback contains no response/body/identity data; coordinator callbacks capture only the issue's local generation and settlement/status bit.
- Keep centralized 401/403 body handling, invalidation, editorial revoke, and sign-out logic unchanged in authority.
- In coordinator clear, issue the first raw DELETE, wait for the pending issue's raw settlement (not the full authenticated promise), and issue the second DELETE after any possibly successful POST. Keep the clear barrier blocked on failed DELETE and preserve old-generation rejection.
- Run integrated auth/media tests for 401, terminal 403, and delayed 204, including finite settlement and redirect ordering.

### 3. Correct lease renewal and per-resource playback ownership

- Change lease playing registration to key each video resource; adding/removing B cannot clear A's active state. Disposal and error paths remove only the exact resource.
- On visible/focus/online recheck, treat missing `expiresAt` as needing issue, but select only an active lease matching current validated identity/local generation and `isCurrent`.
- On a successful `ready`, notify the media activation owner. Activate only resources with no current source/action, clear their stale unavailable UI, and leave already active resources and video position untouched.
- Separate user pause from programmatic recovery pause. Maintain a recovery token and pending restore record; only the matching `loadedmetadata` callback may restore time/resume intent. User pause invalidates that intent.
- Run media/auth tests for hidden renewal, zero-expiry recovery, ready activation, exact video ownership, and stale-generation suppression.

### 4. Bound gallery recovery and complete native resource cleanup

- Route thumbnail and lightbox failures through one controller-level recovery record keyed by DTO/revision/asset and view activation generation.
- Permit one forced fresh lease/reload attempt for the asset. After that fresh lease succeeds, a repeat native failure offers `Recarregar conteúdo` calling the current validated `context.onReload()` at most once for the activation; a new activation resets the record.
- Keep captions/alt text and status accessible; never assign a URL without a current prepared lease.
- Store exact thumbnail `load`/`error` handler references and remove them during dispose before removing sources/DOM.
- Track embed frame/iframe ownership; on disposal remove `src`, detach the iframe/frame, and make late callbacks no-ops. Preserve the approved provider fallback link only while the active view exists.
- Run gallery/media lifecycle tests, including embed-only disposal and detached-node event dispatch.

### 5. Verify, append evidence, and commit

- Run focused media/gallery/auth tests, adjacent Tasks 1–2 routing/API/availability/DTO tests, and Owner News boundary checks.
- Run Node 18 `--check` syntax/probes, then the public test suite with explicit test concurrency and a finite shell timeout; do not loop a timed-out command. Run security scan and `git diff --check`.
- Append concise RED and GREEN commands/results, skipped tests, timeout/environment failures, and evidence limits to the Task 3 report.
- Review the full diff and commit the coherent fix round with a focused message. Do not alter Task 4 or production services.

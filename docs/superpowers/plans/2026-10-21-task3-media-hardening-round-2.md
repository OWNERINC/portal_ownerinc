# Task 3 Media Lifecycle Fix Round 2 Implementation Plan

> **For agentic workers:** Execute inline in this session; do not delegate. Keep each regression finite and do not loop the full suite.

**Goal:** Make media issue retirement independent of settlement order and prevent routine lease readiness from reviving terminally failed resources.

**Architecture:** Give each issue entry independent `processingDone` and `transportSettled` flags. A single exact-entry retirement helper retires an entry only after both flags are true, regardless of which event arrives last. The completed clear barrier may detach the old generation from the current single-flight slot without retiring it, allowing a new generation to issue while the old entry remains fenced until both completions. Give every ordinary media resource and each gallery asset/view activation a generation-scoped lifecycle state; coordinator `ready` only activates pending resources, while explicit recovery transitions own recovery and terminal-failure behavior.

**Tech Stack:** Browser ES modules, Node `node:test`, deferred transports, fake DOM, and injected media-session clock.

## Global Constraints

- Preserve centralized authenticated transport, status-only raw settlement, bodyless same-origin POST/DELETE, and the second DELETE late-cookie barrier.
- A raw late response after the 15-second issue timeout must not prepare that timed-out entry.
- Never let an old issue entry retire a newer `inFlight` entry.
- Initial `503` followed by automatic `204` remains pending and activates normally.
- `ready` must not assign sources or remove the validated reload action of a terminal asset failure.
- PDF terminal failure follows repeated lease-preparation failure; PDF anchors have no assumed native load/error event.
- A new DTO/view activation resets its own resource recovery state.
- Keep Node 18-compatible shared code; make no API, Nginx, deployment, Task 4, or production-service changes.

---

## Files and ownership

- `public/js/portal-contents/media-session.js`: issue completion flags, exact-entry retirement, expiry/clear interaction.
- `public/js/portal-contents/media.js`: explicit ordinary image/video/PDF lifecycle states and state-owned recovery/terminal UI.
- `public/js/portal-contents/gallery.js`: per-view/per-asset thumbnail and lightbox lifecycle states; `ready` only prepares initial pending assets.
- `tests/unit/portal-contents-media.test.mjs`: timeout/raw order permutations, force retry and clear/new-issue races, ordinary asset lifecycle and remount tests.
- `tests/unit/portal-contents-gallery.test.mjs`: terminal thumbnail/lightbox persistence over renewal and fresh activation reset.
- `tests/unit/auth-stability.test.mjs`: retain integrated centralized-auth clear-barrier coverage and add any necessary raw/processing ordering assertion.
- `.superpowers/sdd/2026-10-20-portal-contents-reader/task-3-report.md`: append round-two RED/GREEN evidence and bounded-check limitations.

## Task 1: Retire issued requests only after both completions

- [x] Add fake-clock regression for timeout-first: hold the authenticated request after abort, advance 15 seconds, assert the issue reports timeout, invoke late raw settlement with status 204, then force a retry. Expect a second POST, resolve it with 204, and assert the current lease becomes prepared.
- [x] Add the inverse ordering: deliver raw settlement first while centralized processing remains deferred, advance to 15 seconds, then assert timeout completion retires the exact old entry and permits a second POST.
- [x] Add a clear race: begin old POST, start clear, settle first DELETE and old raw transport, settle second DELETE, start a new-generation POST, then finish old centralized processing. Assert old finalization leaves the newer request single-flight and does not clear its entry.
- [x] Implement `retireIssueIfComplete(entry)`: return unless both `entry.processingDone` and `entry.transportSettled`; retire idempotently and clear `inFlight` only when `inFlight === entry`. The clear barrier separately detaches only its old entry after the second DELETE, without marking it retired.
- [x] Set `processingDone` in every `requestIssue` terminal path, including the 15-second timeout race. Keep `rawSettlementPromise` and centralized `transportPromise` available to the clear barrier.
- [x] Run `node --test tests/unit/portal-contents-media.test.mjs`; require all new ordering/race tests to pass.

## Task 2: Make resource activation lifecycle-aware

- [x] Add failing regressions proving 503→automatic retry→204 activates pending image, thumbnail, video, and PDF, while a ready notification on an unrelated 240-second renewal leaves terminal content and its reload action untouched.
- [x] Model ordinary resources with activation-local state and generation. Initialize as `pendingInitialActivation`; successful preparation becomes `active`; a source/media recovery enters `recovering`; a repeated asset failure becomes `terminalAssetFailure`.
- [x] Change coordinator `ready` handling to activate only `pendingInitialActivation`. Do not call source assignment or clear status for `recovering` or `terminalAssetFailure`. Keep explicit retry completion responsible for moving a recovering image/video/PDF back to active.
- [x] For PDFs, leave the initial state pending through transient initial failures. Count distinct lease-issuance failures, including bounded automatic retries; only repeated failure transitions to terminal and exposes the current-view `Recarregar conteúdo` callback. A successful automatic 204 while still pending activates normally.
- [x] Add tests that terminal ordinary image/video/PDF state survives forced routine renewal at 240 seconds, retains the same reload control, and does not reassign the failed asset URL.
- [x] Add a fresh view/DTO activation regression: the new lifecycle starts pending and can activate after a 204 even when the previous activation of the same asset was terminal.
- [x] Run `node --test tests/unit/portal-contents-media.test.mjs` and preserve existing exact-204, stale identity, and playback tests.

## Task 3: Share lifecycle state across gallery surfaces

- [x] Add failing gallery tests: terminal thumbnail failure survives a routine coordinator `ready`, lightbox navigation/open does not reactivate that asset or erase its reload fallback, and a new view context resets the same asset to pending.
- [x] Extend the view-scoped asset recovery record with lifecycle state and activation identity while retaining the one-forced-retry budget shared by thumbnail and lightbox.
- [x] `prepare()` assigns a thumbnail source only while that record is pending. Explicit recovery may assign while recovering; successful native load becomes active. A repeated native error or repeated forced lease-preparation failure becomes terminal and displays one current-context reload action.
- [x] `loadCurrentImage()` checks the shared state before and after lease preparation. It assigns URLs for pending/active initial presentation only, uses an explicit retry transition for recovering state, and renders the preserved terminal fallback without setting `src` for terminal state.
- [x] Reset records only when the gallery receives a new view context/DTO generation or is disposed; keep stale-context and callback-once guards.
- [x] Run `node --test tests/unit/portal-contents-gallery.test.mjs` and confirm existing focus, dialog, accessibility, disposal, and retry behavior remains green.

## Task 4: Verify, document, and commit

- [x] Run focused media/gallery/auth tests with `--test-concurrency=1` and a finite shell timeout.
- [x] Run adjacent portal contents routing, reader, and shell lifecycle tests with a finite timeout; do not run or loop the full suite.
- [x] Run `npm run verify -- syntax`, `git diff --check`, and a scoped review for secrets, same-origin URLs, bodyless requests, and out-of-scope files. Record runtime version and any unavailable Node 18 runtime.
- [x] Append Fix Round 2 RED/GREEN commands/results and evidence limitations to the local Task 3 report.
- [x] Commit the focused plan, implementation, and regressions with message `fix(contents): fence media lifecycle settlement`.

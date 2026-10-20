# Task 4 Review Fix Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close all five Important Task 4 findings with behavioral regressions, exhaustive acceptance evidence, and a focused commit.

**Architecture:** Keep fixes inside the existing editorial preview boundary and disposable test harness. Add narrow test seams for stream opening, platform-aware evidence privacy, and exhaustive acceptance case aggregation; preserve Payload’s public field APIs and the existing native editor.

**Tech Stack:** Node 24, Payload 3.90.2, Next 16, React 19, TypeScript, built-in `node:test`, existing Playwright module convention.

## Global Constraints

- Require `MIGRATION_TEST_DISPOSABLE=true`, `NODE_ENV=test`, guarded distinct loopback targets, private external upload/evidence directories, and UUIDv4 run ID before adapter/network/browser imports.
- On Linux, private directories are owned by the current UID and have no group/other permissions; private evidence files are regular, non-symlink files owned by the current UID and have no group/other permissions.
- On Windows, perform portable path/type checks and do not claim POSIX ownership/mode privacy.
- Never expose `originalName`, `storageKey`, disk paths, tokens, database URLs, or raw adapter errors in preview response or reports.
- Missing/failed acceptance cases cannot yield overall `PASS`; unavailable real acceptance remains `NOT_EXECUTED`.
- Do not start Docker, contact production, or weaken existing integration guards.

---

### Task 1: Safe preview asset headers and observable stream ownership

**Files:** `cms/src/portal-pages/editorial-preview.ts`, `cms/src/portal-pages/read-file.ts` only if a narrowly scoped helper is needed, `cms/tests/unit/portal-page-editorial-preview.test.ts`.

**Interfaces:** Keep `readEditorialPreviewAsset(req): Promise<Response>`. Add a factory/injection seam for the private open operation used by unit tests. Its default remains `openPortalPageMedia`.

- [x] Add a regression using a canonical but distinctive secret storage key and secret original name; call the actual editorial asset endpoint; assert neither appears in any response header or body.
- [x] Override only `Content-Disposition` at the editorial boundary with `inline; filename="portal-page-<asset UUID>.<allowlisted extension>"`. Preserve `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `Cache-Control`, and `X-Content-Type-Options`.
- [x] Inject an opened stream whose cancel callback closes a counted descriptor; assert endpoint downstream cancellation closes/cancels exactly once.
- [x] Inject a transaction commit failure after open; assert the endpoint cancels the body and closes the descriptor exactly once before returning sanitized 503.
- [x] Exercise `portalPageMediaResponse` with a generated asset larger than 128 KiB and a counted fake descriptor: assert zero reads before demand, one 64 KiB read for the first `reader.read()`, no next read while the consumer is paused, then cancellation closes exactly once.
- [x] Run `node --import tsx --test tests/unit/portal-page-editorial-preview.test.ts`; require all tests green.

### Task 2: Linux disposable-directory and evidence-file privacy

**Files:** `cms/tests/support/integration-config.mjs`, new focused helper in `cms/tests/support/` if needed, `cms/tests/unit/portal-page-editorial-integration-guard.test.ts`, `cms/tests/integration/run-portal-page-editorial.mjs`, `cms/tests/integration/portal-page-editorial-native.ts`, `cms/tests/integration/portal-page-editorial-browser.mjs`.

**Interfaces:** Export pure stat validators with injectable `{ platform, uid }` for deterministic unit tests. Add an atomic private-evidence writer for JSON artifacts; call it for runner/native/browser evidence and credential handoff/storage-state files.

- [x] Add pure directory validation: on Linux require `isDirectory`, not symlink, matching UID, and `(mode & 0o077) === 0`; reject synthetic modes 0755 and 0777 and wrong UID.
- [x] Add pure file validation: on Linux require regular non-symlink file, matching UID, and `(mode & 0o077) === 0`; reject synthetic modes 0644 and 0666 and wrong UID.
- [x] Keep Windows checks limited to absolute isolated paths and regular non-symlink files; tests must verify no POSIX privacy claim is emitted there.
- [x] Validate existing known handoff, storage-state, and evidence paths before any adapter/network/browser import. Reject unsafe files rather than reading or following them.
- [x] Implement writes using a same-directory exclusive temporary file, `chmod(0o600)` on Linux even for reused output targets, `FileHandle.sync()`, atomic replacement, and directory sync where supported. Never rely only on `writeFile({ mode: 0o600 })` for an existing file.
- [x] Run the integration-guard unit tests and verify no adapter import occurs for unsafe directory/file fixtures.

### Task 3: Native textarea wrapper and strict runner environment

**Files:** new `cms/src/admin/portal-pages/PortalPageRequiredTextareaField.tsx`, `cms/src/portal-pages/native-blocks.ts`, generated `cms/src/app/(payload)/editorial/admin/importMap.js`, `cms/tests/unit/portal-page-editorial-config.test.ts`, `cms/tests/support/integration-config.mjs`, guard tests.

**Interfaces:** Export `PortalPageRequiredTextareaField(props: TextareaFieldClientProps): React.JSX.Element`; use public `TextareaField` from `@payloadcms/ui` and public `TextareaFieldClientProps` from `payload`.

- [x] Add a failing config test asserting `body.callout.text` resolves to the new textarea wrapper while title, URL, alt, and other single-line fields still resolve to the text wrapper.
- [x] Implement the wrapper with the Task 2 focus registration bound to the actual `HTMLTextAreaElement` ref and render Payload’s native `TextareaField`.
- [x] Register the exact wrapper path for `callout.text`, preserve `required`, `maxLength`, and other native field behavior, then regenerate the import map with the Payload CLI.
- [x] Require `NODE_ENV === 'test'` in `readIntegrationConfig`; the browser entrypoint runs under test mode while only its owned Next child is explicitly set to development.
- [x] Run config tests, typecheck, and import-map generation consistency check.

### Task 4: Exhaustive native/browser acceptance registry and handoff lifecycle

**Files:** `cms/tests/integration/portal-page-editorial-native.ts`, `cms/tests/integration/portal-page-editorial-controls.mjs`, `cms/tests/integration/portal-page-editorial-browser.mjs`, `cms/tests/integration/run-portal-page-editorial.mjs`, `cms/tests/unit/portal-page-editorial-config.test.ts`, `cms/tests/unit/portal-page-editorial-integration-guard.test.ts`, docs under `docs/operations/` and `docs/reviews/`.

- [x] Define exported expected-case registries for native and browser acceptance. At finalization, fail if a name is missing, duplicated, or has an invalid status. Overall status is `FAIL` for any `FAIL`, otherwise `NOT_EXECUTED` for any `NOT_EXECUTED` or `SKIP`, and only `PASS` when every required case is present and `PASS`.
- [x] Add named native cases for direct REST publish/restore denial, exact old preview after a subsequent publication, fresh asset/Range denial after editor permission/session revocation, complete MIME-role matrix, and incomplete media rejection. Keep each operation bounded to the already guarded disposable CMS fixture.
- [x] Add named browser cases for native Versions/diffs, block insertion/reordering, and existing News controls smoke; integrate each returned case into the expected registry rather than hiding omitted cases behind a successful child exit.
- [x] Delete only the exact stale Task 4 handoff/storage-state/result filenames after path/type/privacy checks and before migration/native acceptance begins.
- [x] Create the new storage-state and browser handoff only in native test teardown after setup and every required native acceptance case passed; do not emit a handoff on setup/test failure. Use the secure writer.
- [x] Browser entrypoint validates the strict test environment and handoff’s run ID/private path/mode before importing Playwright, then records required unavailable checks explicitly as `NOT_EXECUTED`.
- [x] Run runner syntax and source/config/guard tests; verify synthetic missing/skip cases cannot aggregate to `PASS`.

### Task 5: RED/GREEN evidence, documentation, and focused commit

**Files:** `docs/reviews/2026-10-19-portal-pages-editorial-acceptance.md`, `docs/operations/portal-pages-editorial.md`, `.superpowers/sdd/2026-10-19-portal-pages-editorial-experience/task-4-report.md`, and only matching source/tests above.

- [x] Record each finding’s failing regression before the fix and its passing result after the fix; state separately that real database/browser/manual cases remain `NOT_EXECUTED` if no fixture is supplied.
- [x] Document Linux versus Windows privacy semantics, stale-handoff deletion/creation timing, and exact result aggregation policy.
- [x] Run focused preview/config/guard/integration-source tests, `npm --prefix cms run test:unit`, `npm --prefix cms run typecheck`, import-map/types generation consistency, runner `node --check`, and `git diff --check`.
- [x] Run `npm run verify` with `PAYLOAD_TEST_EXTERNAL_PARENT=C:\Windows\Temp`; do not change its guards if the environment rejects that path.
- [x] Review the complete diff and stage only Task 4 fix files plus matching docs/report; create one focused fix commit.

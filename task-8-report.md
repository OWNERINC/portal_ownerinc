# Task 8 — rich-text reader and authenticated saved previews

## Status and scope

Implemented Task 8 on base `d143e1c3948c896d564e5acb49c37679da2235b7` in the
approved `payload-owner-news` worktree. Local implementation and self-review are
complete; final targeted tests, root verify, CMS typecheck/unit/build, browser
check and diff check pass. The commit containing this report uses the requested
message `feat(news): render Payload rich text and authenticated previews`.

Read the exact Task 8 brief/context first, then repository instructions, README,
product brief, read-bridge operations document and existing frontend/CMS/tests.
Loaded uncodixfy before frontend changes; used the already-approved plan rather
than redesigning Portal or native Payload. No delegation, push, merge, PR, remote
service changes, deployment or Docker changes. **ASK before any VPS deployment.**
Task 9 entry/logout/account-watch/brand/polls, Task 10 history UI, Task 14 verifier
expansion and Task 15 final visual acceptance remain separate.

## Delivered interfaces and behavior

- `validateNewsBlocks(value, version=1)` in `content-contract.js`: v1 calls the
  unchanged legacy validator; v2 accepts the eleven legacy blocks plus strict
  `rich_text`. Whole-body validation before media/rendering. Limits: 100 blocks,
  5 MiB normalized blocks, global 10,000-node budget, inline depth at most 4.
  Unknown fields/nodes, invalid marks, duplicate marks, h1 rich headings,
  credentialed/non-HTTPS links and nested links are rejected. API/CMS retain
  their authoritative combined `{blocks,editorial}` byte budget.
- `renderRichContent(root,nodes): void`: validates the complete tree before DOM
  construction/replacement; uses text nodes/createElement, not HTML sinks.
  Marks become strong/em/u/code; lists and inline breaks survive; new-tab links
  use `noopener noreferrer`. Rich headings are h2–h6. The article title remains
  the only h1 in the reader; the preview shell h1 is paired with an article h2.
- `newsBlocksToText(blocks)`: feeds summary/read-time fallbacks, including rich
  text. File titles do not manufacture reading time. Legacy null-editorial PDF
  editions keep their no-minutes fallback.
- `cmsAssetEndpoint(id,scope='legacy')` in pure `asset-path.mjs`, also exported
  from the shared renderer. UUID-only IDs and closed scopes `legacy`,
  `owner-news`, `owner-news-preview`. `renderBlocks` gains `assetScope` while
  remaining legacy-only. Cover, inline image, profile, PDF, video, catalog and
  Dashboard all propagate the proper scope. Existing generic consumers keep
  the legacy default. Abort, local retry and retained/late blob revocation stay
  intact.
- `mountNewsPreview(page)` and shell route `/news-preview.html`: strict
  id/version UUIDs, source payload(default)/legacy, no duplicate/unknown query
  parameters. Uses `page.bindAPI({fetchAPI})`, current editorial permission,
  exact saved-preview GET, focus revalidation, local retry focus, cleanup and
  stale-result rejection. No custom Firebase config or raw authenticatedFetch
  JSON path. Real auth epoch tests cover account changes during JSON and blob
  body completion before the router has disposed the page.
- Native public Payload `beforeDocumentControls` extension **Conferir prévia
  salva** reads the existing `/editorial/api/news-schedule` GET, confirms an
  actual persisted Versions UUID, then offers **Abrir prévia editorial em nova
  aba**. This two-action pattern avoids async popup blockers. It never creates
  or saves on GET, uses no document-ID/date substitute, has no cookie/token in
  its URL, and leaves inputs untouched on 409. Guards match ScheduleRevision
  (dirty, initialization, save/background-save, upload, lock/disabled, another
  drawer); changing the form/doc or unmounting invalidates pending lookups and
  previously resolved links.

### Narrow compatible DTO extension

The existing DTO lacked authoritative saved-status metadata. As explicitly
permitted by the handoff, added optional:

```text
preview_revision?: {
  id: UUID,
  source: 'payload' | 'legacy',
  status: 'draft' | 'published' | 'scheduled' | 'archived'
}
```

CMS query uses the exact native Version `_status` (draft/published), or imported
history `originalStatus`. Pre-cutover legacy backend uses `cms_revisions.status`.
API validates shape, scope, status and correspondence to requested id/source;
published DTOs cannot carry this preview-only field. No schema/migration change.

Draft banner: **Conteúdo não publicado**. Published revision: **Revisão salva
como publicada**, not a claim that the revision is the current public one.
Legacy source adds **Histórico anterior à migração**. Missing optional metadata
uses the neutral **Revisão salva**; it never fabricates “unpublished”. All include
the caution that the saved revision may differ from the current publication.

## Changed files

### Frontend and shell

Created:
- `public/js/owner-news/asset-path.mjs`
- `public/js/owner-news/content-contract.js`
- `public/js/owner-news/rich-content.js`
- `public/js/news-preview.js`
- `public/news-preview.html`

Modified:
- `public/js/cms-block-renderer.js`
- `public/js/owner-news/reader-view.js`
- `public/js/owner-news/model.js`
- `public/js/owner-news/catalog.js`
- `public/js/dashboard.js`
- `public/js/router.js` (only route/permission registration)
- `public/css/owner-news.css` (rich links/code and preview status only)
- `scripts/generate-public-shell.mjs` (preview registration)

### CMS/API and documentation

Created:
- `cms/src/admin/SavedPreview.tsx`
- `cms/src/admin/preview-state.ts`
- `task-8-report.md`

Modified:
- `cms/src/collections/NewsArticles.ts`
- `cms/src/app/(payload)/editorial/admin/importMap.js` (generated)
- `cms/src/contracts/news.ts`
- `cms/src/news/queries.ts`
- `api/owner-news/payload-dto.js`
- `api/owner-news/backend.js`
- `docs/operations/owner-news-payload-read-bridge.md`

### Tests and harness dependencies

Created:
- `tests/unit/owner-news-rich-content.test.mjs`
- `tests/unit/owner-news-payload-preview.test.mjs`
- `cms/tests/unit/news-preview.test.ts`
- `cms/tests/integration/run-task8.mjs`
- `cms/tests/integration/task8-browser.mjs`

Modified:
- `cms/tests/unit/news-queries.test.ts`
- `tests/unit/owner-news-payload-api.test.mjs`
- `tests/unit/owner-news-frontend.test.mjs`
- `tests/unit/owner-news-editorial.test.mjs`
- `tests/unit/cms-frontend.test.mjs`
- `tests/unit/cms-editor-ui.test.mjs`
- `tests/unit/persistent-navigation.test.mjs`
- `tests/helpers/frontend-feedback-harness.mjs`
- `tests/helpers/academy-frontend.mjs`
- `tests/helpers/cms-harness.mjs`
- `tests/helpers/knowledge-editorial-harness.mjs`

Harness changes load the real new production dependencies, not substitute
renderers. Existing Dashboard invalid fake IDs were replaced with real UUID
fixtures to preserve the strict asset contract and all cleanup assertions. The
old inline asset-path source assertion now checks resolver use and its actual
default URL. No assertions were weakened to allow insecure content or stale
responses. `cms/next-env.d.ts` changed transiently during dev but returned to its
original production-build content; it is not part of this change.

## Verification — exact commands and outcomes

Commands below ran from the worktree root in PowerShell, using Node 24.15.0 on
Windows. Each check was bounded separately (unit/type/root 120s, build 300s,
browser 180s). No Node 18 runtime claim is made; Portal additions use Node
18-compatible APIs and CMS retains its previously approved Node 24 requirement.

### RED → GREEN and intermediate failures

1. `node --test tests/unit/owner-news-rich-content.test.mjs`
   - Initial RED: 0/4 passed, missing asset-path/content-contract modules.
   - Final suite has 6 behavioral tests and passes in the targeted run below.
2. `node --test tests/unit/owner-news-payload-preview.test.mjs`
   - Initial RED: 0/4 passed, missing preview HTML/controller.
   - Final suite has 7 behavioral tests and passes below.
3. `node --test tests/unit/owner-news-rich-content.test.mjs tests/unit/owner-news-reader.test.mjs tests/unit/owner-news-editorial.test.mjs`
   - Intermediate: 25/27 passed. Fixed presentation reference identity regression
     without changing the legacy assertion, and used explicit DOM link attributes
     so the existing harness observes rel/href correctly.
4. `node scripts/generate-public-shell.mjs` — PASS, only the new preview shell
   needed generation.
5. `$env:CMS_BUILD_ONLY='true'; npm --prefix cms run generate:importmap; npm --prefix cms run typecheck; Remove-Item Env:CMS_BUILD_ONLY`
   - First attempt failed the intentional build-phase environment gate; typecheck
     also found a test-double cast. Corrected test cast and used the proper
     explicit synthetic phase for codegen, not operational credentials.
6. `$env:CMS_BUILD_ONLY='true'; $env:NEXT_PHASE='phase-production-build'; npm --prefix cms run generate:importmap; Remove-Item Env:CMS_BUILD_ONLY; Remove-Item Env:NEXT_PHASE; npm --prefix cms run typecheck; npm --prefix cms run test:unit`
   - PASS: generated import map, typecheck clean, CMS 110 pass/1 existing skip.
7. First `npm run verify`: 1167 pass/5 fail/2 skip. Failures were the moved
   asset-path string assertion and stale Dashboard harness imports/non-UUID
   fixtures. Fixed dependencies/fixtures while retaining lifecycle assertions.
8. `node --test tests/unit/owner-news-rich-content.test.mjs tests/unit/owner-news-payload-preview.test.mjs tests/unit/owner-news-frontend.test.mjs tests/unit/cms-frontend.test.mjs`
   - PASS: 51/51 at that point (before the final eleven-block regression test).
9. `node --test tests/unit/owner-news-editorial.test.mjs tests/unit/owner-news-rich-content.test.mjs`
   - Intermediate failure after adding the requested renderer re-export exposed
     a data-URL loader that stripped its dependency; fixed the loader to import
     the real resolver. The next root run caught the same issue in the CMS palette
     loader (1175 pass/1 fail/2 skip); it was fixed the same way.

### Final repeatable checks

```powershell
node --test tests/unit/owner-news-rich-content.test.mjs tests/unit/owner-news-payload-preview.test.mjs tests/unit/owner-news-reader.test.mjs tests/unit/owner-news-editorial.test.mjs tests/unit/owner-news-payload-api.test.mjs
# PASS: 50/50, no skip/failure

npm --prefix cms run typecheck
# PASS: tsc --noEmit

npm --prefix cms run test:unit
# PASS: 110 passed, 1 existing Windows symlink-permission skip, 0 failed

$env:CMS_BUILD_ONLY='true'; npm --prefix cms run build; $result=$LASTEXITCODE; Remove-Item Env:CMS_BUILD_ONLY; exit $result
# PASS: Next 16.3.8 production compilation, TypeScript and static page generation;
# editorial routes remain dynamic; synthetic build inputs only

npm run verify
# PASS: 1176 passed, 2 existing skips, 0 failed; verify: ok

node --check public/js/owner-news/asset-path.mjs
node --check cms/tests/integration/run-task8.mjs
node --check cms/tests/integration/task8-browser.mjs
node scripts/generate-public-shell.mjs --check
git diff --check
# PASS: all exit 0, no diagnostics
```

Final root/CMS unit output was retained with these exact logging wrappers:

```powershell
npm run verify *> "C:\Users\Criação\AppData\Local\Temp\opencode\ownerinc-task8-BC9oXV\root-verify.log"; $result=$LASTEXITCODE; Get-Content "C:\Users\Criação\AppData\Local\Temp\opencode\ownerinc-task8-BC9oXV\root-verify.log" -Tail 18; exit $result
npm --prefix cms run test:unit *> "C:\Users\Criação\AppData\Local\Temp\opencode\ownerinc-task8-BC9oXV\cms-unit.log"; $result=$LASTEXITCODE; Get-Content "C:\Users\Criação\AppData\Local\Temp\opencode\ownerinc-task8-BC9oXV\cms-unit.log" -Tail 12; exit $result
```

### Bounded native/browser check

```powershell
node cms/tests/integration/run-task8.mjs --prepare-new-task8
node cms/tests/integration/run-task8.mjs --browser "C:\Users\Criação\AppData\Local\Temp\opencode\ownerinc-task8-BC9oXV"
```

- Prepare PASS: created only new `cms_task8_test` on already-authorized loopback
  PostgreSQL 55441 and applied existing migrations. It refuses to reset an
  existing database. No `portal_task8_test` was needed. All prior databases were
  preserved, as were ignored sample snapshots/drafts/assets and original files.
- Browser initial three attempts failed at preview loading due to harness-only
  private-bridge mistakes: a cookie-bearing APIRequestContext (including an empty
  Cookie header), then missing X-Request-ID. Replaced manual service calls with
  the existing real `createPayloadNewsClient`; no production guard was relaxed.
- First successful run's screenshot exposed incomplete synthetic Lexical
  element defaults (“Invalid indent value” in native error boundary). Fixed
  only the fixture serialization and added an explicit native-error assertion.
  Final run PASS with native editor rendering normally.
- Final PASS evidence: actual persisted Versions ID differs from document ID;
  dirty and in-flight autosave disable preview; new completed save resolves a
  new exact Version; injected GET 409 leaves title unchanged and no stale link;
  preview opens in its own tab; strict rich DOM/single h1 and truthful draft
  banner; 1440×900, 390px and 320px have no horizontal document overflow; older
  saved B remains B after actual C publication, and C's preview says saved as
  published; no browser page errors. All owned child processes stopped.
- Real: Next/Payload/native admin/autosave/Versions/PostgreSQL, API bridge client
  and DTO validator, Portal module graph/router/lifecycle/auth decode guards.
  Doubles: Firebase identity, Portal introspection/authority, static hosting and
  the Express/Nginx HTTP dispatch between browser and real client. The 409 is an
  injected read response; its UI behavior is real. DOM harness covers private
  cover/profile/PDF/video/scopes and denied/late media separately; the browser
  fixture is text-only, not proof of real codec playback or upload-dialog guards.
- Screenshots inspected: `native-preview-409.png`, `preview-1440.png`,
  `preview-320.png`; also produced `preview-390.png`. Files and final logs are in
  the private directory printed above (not committed; env.json contains private
  local runtime inputs and must not be shared).

## Self-review and remaining concerns

- Reviewed complete production diff against all eight brief steps and ownership
  constraints; no unresolved implementation blocker found. Fresh external
  review belongs to the primary session; no reviewer agent was delegated here.
- Existing all-eleven legacy validator/DOM behavior, shared consumers, metadata
  fallbacks, reader navigation/focus, retry and cleanup remain covered by root
  and focused tests. Native preview is read-only and never clears form inputs.
- Optional `preview_revision` is the only cross-boundary contract addition.
  Task 10/history consumers may reuse it but must retain original-source labels.
- Task 14 still needs `.mjs` included in the general public syntax scan. Explicit
  syntax check ran here. Before any deployment, verify actual Nginx `.mjs` MIME
  delivery and CSP under the deployment/Task 15 acceptance; local route harness
  deliberately serves JavaScript with the correct MIME. No Nginx/Docker config
  was changed in this task.
- Desktop/mobile screenshots are bounded synthetic evidence, not final design
  acceptance. Existing Portal shell/no-cover hero geometry was deliberately not
  redesigned. Task 15 remains responsible for complete real content layouts,
  keyboard/accessibility review and production hosting behavior.
- Native control shares tested ScheduleRevision guards for upload/lock/drawers;
  this browser run specifically proves dirty/autosave and 409, not a real upload
  in progress. Full Firebase/Portal account login, remote Nginx/VPS and Node 18
  execution were not exercised. Existing Windows symlink skip remains.
- Nothing was deployed. **Ask the user before VPS deploy.**

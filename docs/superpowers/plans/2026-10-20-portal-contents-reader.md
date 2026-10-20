# Portal Conteúdos Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an authenticated, availability-gated Conteúdos catalog and dedicated published-page reader with strict validation, native private media, and an accessible gallery lightbox.

**Architecture:** Use the existing persistent Portal router and authentication lifecycle, with focused ES modules under `public/js/portal-contents/`. Keep availability and media-session coordination alive across soft navigation, while each view owns its requests, DOM, media bindings and gallery. Add only the authenticated availability backend route; consume the existing published DTO and revision-bound native-cookie transport.

**Tech Stack:** Vanilla browser ES modules, semantic HTML/CSS, Express/CommonJS compatible with Node 18, existing Firebase helpers, dependency-free `node:test`/VM/DOM harnesses; existing CMS tooling uses Node 24.

## Global Constraints

- Approved source: `docs/superpowers/specs/2026-10-20-portal-contents-reader-design.md`, commit `43d7560`, following reviewed backend/editor `830e90c`.
- “No code, images, fonts or other assets from the unlicensed inspiration project may enter this repository.”
- “No new public CMS endpoint, feature flag or permission is introduced.”
- “Do not add availability to auth-shell.js snapshots, localStorage/sessionStorage, or service-worker caches.”
- “Never overwrite portalNavigation or install a second router click handler.”
- “No unknown field, block, mark, layout, version or scope is skipped.”
- “The page title is the only h1.”
- “No innerHTML, insertAdjacentHTML, srcdoc, HTML strings, executable handlers, style attributes from DTOs, or third-party rich-text runtime.”
- “No storageKey, Firebase token or secret appears in markup, URLs, logs, history, storage or error text.”
- “Do not use fetchAPIAsset, response.blob(), object URLs, base64, fetch-to-arrayBuffer or a service worker to transport assets.”
- “No deployment, running-service change or production operation is authorized.” Service-backed work below is limited to the supervising session's **existing explicit disposable-local Docker authorization**; this plan grants no additional authority.
- Preserve Node 18 compatibility in public/API code, no frameworks or new dependencies, LF for Nginx/shell files, and existing `api/`, `cron/`, `public/`, `nginx/` boundaries.
- Keep Owner News, Academy, editor, upload/publication protocols, database schemas and production deploy scripts unchanged except for the expressly listed shared-shell integration/regression coverage.
- All ten blocks support all five layouts and omitted layout. Published scope is exactly `portal-pages`, `content_version:1`, `revision.status:'published'`.
- Native session POST/DELETE are bodyless **204**; no JSON token or expiry envelope. Lifetime is **300000 ms**, renewal at **240000 ms**, issue timeout **15000 ms**, retry delays **5000/15000/30000 ms**.
- Read `README.md`, `docs/product/brief.md`, `docs/architecture/overview.md`, `docs/architecture/portal-pages-content.md` and the approved spec before implementation. Preserve the README missing-optional-container invariant.
- Each of the four tasks is one review gate and focused commit; internal RED/GREEN steps are small work units, not extra independently dispatched tasks. Task 1's navigation infrastructure is staged, not a releasable reader until Tasks 2–4 pass.

---

## File structure and ownership (lock before coding)

| File | Responsibility / first task |
| --- | --- |
| `api/routes/contents.js` | Availability handler beside existing read handlers; Task 1 only backend addition. |
| `public/js/portal-contents/availability.js` | Persistent, transport-injected gate; no auth import/circular startup; Task 1. |
| `public/contents.html` | Complete static shell skeleton, root and status region; Task 1; mounted reader in Task 2. |
| `scripts/generate-public-shell.mjs` | Navigation source of truth and new document registration; Task 1. |
| `public/js/auth.js` | Live identity notifications/gate startup, bounded auth-error decode, coordinated media clear; Tasks 1–3. |
| `public/js/sidebar.js`, `public/css/layout.css` | Hidden/inert navigation and drawer ownership; Tasks 1 and 3. |
| `public/js/portal-contents/dto.js` | Pure strict browser validator and contract constants; Task 2. |
| `public/js/portal-contents/api.js` | Bounded JSON, exact URLs, `{data,total}`, sanitized errors; Task 2. |
| `public/js/portal-contents/rich-text.js` | Fixed structured text DOM grammar; Task 2. |
| `public/js/portal-contents/catalog.js` | Catalog/list/category/pagination DOM and media descriptors; Task 2. |
| `public/js/portal-contents/reader.js` | Article header and ten blocks; inert media descriptors in Task 2, activation in Task 3. |
| `public/js/portal-contents/index.js` | `mount(page)`, query parsing, request generations, history, media binding orchestration; Task 2. |
| `public/js/portal-contents/media-session.js` | Persistent injected coordinator, leases, renewal, exit barrier; Task 3. |
| `public/js/portal-contents/media.js` | Native asset binding/recovery and embeds, separate from session policy; Task 3. |
| `public/js/portal-contents/gallery.js` | One native dialog per mounted reader; owned focus/inert/scroll/disposal; Task 3. |
| `public/css/portal-contents.css` | Scoped catalog/article/five-layout/media/lightbox CSS; Tasks 2–3. |
| `public/js/router.js` | Route registration only in Task 2; existing committed events and BFCache lifecycle reused. |
| `public/js/ui.js` | Narrow owned-native-dialog registration API; Task 3, existing dialogs retain behavior. |
| `tests/helpers/portal-contents-fixtures.mjs` | Full valid wire fixtures, normalized CMS-derived fixtures, explicit invalid mutations; Task 2. |
| `tests/helpers/portal-contents-harness.mjs` | Load real ES modules with existing DOM fixtures, controlled transport/clock/identity; Task 2, extended Task 3. |
| `tests/helpers/frontend-feedback-harness.mjs`, `tests/helpers/router-harness.mjs` | Only missing DOM/native-dialog seams and real reader module injection; Tasks 2–4. |
| `tests/unit/portal-contents-availability.test.mjs` | Gate races and generated shell; Task 1. |
| `tests/unit/portal-contents-dto.test.mjs`, `tests/unit/portal-contents-api.test.mjs`, `tests/unit/portal-contents-reader.test.mjs`, `tests/unit/portal-contents-routing.test.mjs` | Strict parity, bounded decoding, actual DOM, real router; Task 2. |
| `tests/unit/portal-contents-media.test.mjs`, `tests/unit/portal-contents-gallery.test.mjs` | Timers, recovery, cookie clearing, native binding and modal interaction; Task 3. |
| `scripts/test-portal-contents-acceptance.mjs`, `tests/unit/portal-contents-acceptance.test.mjs` | Guard/read/aggregate explicitly named service/manual evidence; Task 4. |
| `docs/operations/portal-contents-reader.md`, `docs/reviews/2026-10-20-portal-contents-reader-acceptance.md` | Reader operation, local acceptance procedure and honest result matrix; Task 4. |

No feature module imports `owner-news/`, `cms/`, Payload types or News DTOs. `media.js` is the one additional focused module beyond the spec's proposed table: native element lifecycle stays separate from persistent session lifecycle.

### Shared interface vocabulary

These are JS/JSDoc contracts, not a new compiler or runtime package. Every caller uses these names.

```js
// AuthIdentity: immutable in-memory authorization snapshot, never visual cache.
// { uid: string|null, generation: number, validated: boolean }
// auth.js exports:
// getContentsIdentity(): AuthIdentity
// subscribeContentsIdentity(listener: (identity: AuthIdentity) => void): () => void
// Notifications are synchronous on clear/account switch; validation only after /users/me.

// RouteState:
// {kind:'catalog', category:string|null, page:number, offset:number, href:string}
// | {kind:'reader', slug:string, href:string}
// | {kind:'invalid', href:null}

// ViewContext:
// { signal:AbortSignal, isCurrent:()=>boolean, onReload:()=>void }
// RenderedView:
// { heading:HTMLElement, media:MediaDescriptor[], dispose:()=>void }
// MediaDescriptor (all include dto:validated PortalPageDTO, host:HTMLElement):
// {kind:'image', dto, host, assetId, alt, caption?, eager:boolean}
// | {kind:'video'|'pdf', dto, host, assetId, title:string}
// | {kind:'gallery', dto, host, images:Array<{asset_id,alt,caption?}>, blockIndex:number}
// | {kind:'embed', dto, host, provider:'youtube'|'vimeo', url:string, title:string}
// Renderers build labels/captions/empty media hosts but assign no protected URLs.
```

### Task 1: Authenticated availability and persistent generated navigation gate

**Files:**
- Modify: `api/routes/contents.js:124-175` (handler/registration before `/:slug`).
- Create: `public/js/portal-contents/availability.js`, `public/contents.html`.
- Modify: `public/js/auth.js:113-149,318-349`, `public/js/sidebar.js:46-104`, `public/css/layout.css` (sidebar hidden rule).
- Modify: `scripts/generate-public-shell.mjs:4-28,70-86`.
- Generated modifications: `public/dashboard.html`, `public/knowledge.html`, `public/reminders.html`, `public/academy.html`, `public/benefits.html`, `public/announcements.html`, `public/news-preview.html`, `public/editorial-entry.html`, `public/profile.html`, `public/admin.html`, `public/cms.html`, `public/autocard.html`, `public/cards-pos.html`, `public/solides.html`, `public/contents.html`.
- Test: `tests/unit/portal-pages-bridge.test.mjs`, `tests/unit/portal-contents-availability.test.mjs`, `tests/unit/auth-stability.test.mjs`, `tests/unit/task-7-shell-mobile.test.mjs`.

**Interfaces:**
- Consumes existing `createContentsRouter({authenticate,payloadClient,payloadClientFactory,env})`, `portalActor(req.user)`, `strictQuery`, `rejectBody`, `createRequestSignal`, `sendError`; Payload `list({limit:1,offset:0}, actor, {signal,requestId}) -> {rows,count}` already validates wire content.
- Produces `GET /api/contents/availability -> 200 {available:boolean}` with exactly one key; authenticated/no query/no body; `private,no-store`.
- Produces auth functions `getContentsIdentity()` and `subscribeContentsIdentity(listener)` defined above. `validated` cannot come from `getCachedUserSnapshot`.
- Produces `configureContentsAvailability({request, getIdentity, subscribeIdentity, document, window}): void`, called once by auth with `request: authenticatedFetch`; `probeContentsAvailability(): Promise<void>` and `resetContentsAvailability(): void` for tests/integration. Repeated configuration does not duplicate listeners.
- States: `unknown|checking|available|empty|unavailable|denied`. `reset` increments local request generation, aborts, hides synchronously; late work cannot reveal.
- No route authorization dependency on availability. Register the actual reader module in Task 2, once the module exists; do not add a fake page module or a redirect in Task 1.

- [ ] **Step 1: Add availability HTTP RED cases to the existing real-middleware fixture.**

```js
test('availability is authenticated, exact, and independent of editorial permission', async () => {
  const state = fixture();
  assert.equal((await state.request.get('/api/contents/availability')).status, 401);
  const response = await state.withBearer(state.request.get('/api/contents/availability'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { available: true });
  assert.equal(response.headers['cache-control'], 'private,no-store');
  assert.deepEqual(state.payloadCalls[0].input, { limit: 1, offset: 0 });
  assert.equal(state.payloadCalls[0].actor.canManageKnowledge, false);
});
test('availability distinguishes empty from inconsistent and unavailable', async () => {
  const state = fixture();
  state.payloadClient.list = async () => ({ rows: [], count: 0 });
  assert.deepEqual((await state.withBearer(state.request.get('/api/contents/availability'))).body, { available: false });
  state.payloadClient.list = async () => ({ rows: [], count: 1 });
  const inconsistent = await state.withBearer(state.request.get('/api/contents/availability'));
  assert.equal(inconsistent.status, 503);
  assert.equal(inconsistent.body.reason, 'portal_pages_unavailable');
});
```

Add named cases for extra/duplicate query, GET body/transfer-encoding rejection, disabled/unapproved user, factory configuration failure, client timeout/malformed rejection, request disconnect abort and static route precedence. Assert errors never expose count/DTO/actor/private client exception. Reuse `fixture` and its actual `createAuthMiddleware`, not a permission-bypassing replacement.

- [ ] **Step 2: Run HTTP RED.**

Run: `node --test tests/unit/portal-pages-bridge.test.mjs`

Expected: new availability assertions FAIL because the request currently reaches slug detail. Save the failing names; existing bridge cases must remain intact.

- [ ] **Step 3: Add the minimal handler.**

Keep existing list/detail response shapes unchanged. A dedicated handler avoids adding an invented Payload action:

```js
router.get('/availability', authenticate, rejectBody, async (req, res) => {
  if (!strictQuery(req.query, [])) return sendError({ status: 400 }, req, res);
  const { controller, cleanup } = createRequestSignal(req, res);
  try {
    const result = await getPayloadClient().list({ limit: 1, offset: 0 }, portalActor(req.user),
      { signal: controller.signal, requestId: req.id });
    if (controller.signal.aborted) return;
    if (!result || !Array.isArray(result.rows) || !Number.isSafeInteger(result.count)
      || result.count < 0 || result.count > 100000 || result.rows.length > 1
      || (result.count === 0 && result.rows.length !== 0)
      || (result.count > 0 && result.rows.length !== 1)) throw new Error('unavailable');
    return res.json({ available: result.count > 0 });
  } catch (error) {
    if (!controller.signal.aborted) return sendError(error, req, res);
  } finally { cleanup(); }
});
```

Insert before `/categories`/`/:slug`; use existing Payload validation for DTO eligibility. Do not interpret a missing client as empty.

- [ ] **Step 4: Run HTTP GREEN.**

Run: `node --test tests/unit/portal-pages-bridge.test.mjs tests/unit/portal-pages-payload-client.test.mjs`

Expected: PASS, including existing preview/media/active-user cases.

- [ ] **Step 5: Add gate/auth/mobile/generated-shell RED cases.**

Use VM loading consistent with `auth-stability.test.mjs`; inject transport and identity, no Firebase initialization. In the new gate test define a local test setup returning `{gate,identity,requests,resolve,link,focus,dispatch}`: `identity` calls subscribed callbacks synchronously; `requests` records the pending Response promises; `dispatch` fires `portal:navigated`, visibility and online on fake EventTargets. `gate` exposes the real module's probe/reset functions. Assertions include:

```js
// Test algorithm, run with both successful and failed deferred responses:
identity({ uid: 'a', generation: 1, validated: true });
assert.equal(link.hidden, true); // checking never leaves a cached visible link
const first = requests[0];
identity({ uid: 'b', generation: 2, validated: false });
first.resolve(new Response('{"available":true}'));
await drain();
assert.equal(link.hidden, true);
identity({ uid: 'b', generation: 2, validated: true });
requests.at(-1).resolve(new Response('{"available":true}'));
await drain();
assert.equal(link.hidden, false);
```

Test exact boolean plus exact own key (`true`, `1`, arrays, `{available:true, count:1}` rejected), 401/403, 503/network, zero, coalesced triggers, no background polling, visible/online recovery, focused hidden link fallback. Extend auth harness for injected gate configuration and subscriptions; prove visual snapshot never validates identity or starts a reveal. Extend drawer harness with hidden and inert ancestors, including first/last focus wrap and no focusable item.

Run: `node --test tests/unit/portal-contents-availability.test.mjs tests/unit/auth-stability.test.mjs tests/unit/task-7-shell-mobile.test.mjs`

Expected: FAIL for missing gate/hidden nav and missing lifecycle hooks, not an unrelated VM import syntax error.

- [ ] **Step 6: Implement persistent identity/gate integration.**

In `auth.js`, store a listener Set and expose a frozen `{uid:sessionUid || null,generation:sessionEpoch,validated}` value. `clearVerifiedRole()` sets `validated=false` and notifies synchronously after incrementing epoch; `syncSession()` clears before another UID is usable; successful current `getCurrentUserDoc()` sets true and notifies after live validation. Do not add fields to `visualSnapshot` or `snapshotNavigation`.

`auth.js` imports `configureContentsAvailability` (availability imports no auth) and configures it once after function definitions. Persistent listeners use `document` for `portal:navigated` and `visibilitychange`, `window` for `online`. Identity notifications start a probe only when validated. Recovery requires a current validated identity; existing auth revalidation remains authoritative.

```js
// Gate algorithm; all response/error paths compare captured identity AND request generation.
// probeContentsAvailability():
// 1. read getIdentity(); if !validated reset/hide and return.
// 2. if a probe for this UID+generation is pending, return that promise.
// 3. hide; state='checking'; capture local generation; request with AbortSignal,
//    credentials:'same-origin', cache:'no-store'.
// 4. read at most 1024 response bytes via body.getReader(); cancel on overflow.
//    parse JSON; require Object.keys(value) exactly ['available'] and boolean.
// 5. after every await check captured UID/auth generation/local generation.
// 6. true => available/reveal; false => empty/hidden;
//    401/403 => denied/hidden; other error => unavailable/hidden.
// 7. clear only this pending promise in finally. Never persist the result.
```

When hiding a focused `.contents-link` descendant, focus visible main h1 (temporary `tabindex=-1`) unless the mobile drawer owns focus; then choose `.mobile-menu-toggle`. Hide before yielding. Do not remove previously read article text because an availability probe failed.

- [ ] **Step 7: Implement generated navigation and the complete static HTML shell.**

Create `contents.html` from the structural shell in `knowledge.html`: retain lang/meta/tokens/layout/components/auth-shell/sidebar-state/skip link/sidebar branding/footer/topbar/main/toast/sidebar.js/router-bootstrap.js. Remove knowledge styles, editor modal, search, editor actions and article DOM. Use title `Conteúdos — Portal Ownerinc`, body `contents-page`, main `page-body`, and:

```html
<section id="contents-root" class="portal-contents" aria-label="Conteúdos">
  <h1 id="contents-title" tabindex="-1">Conteúdos</h1>
  <p id="contents-status" role="status" aria-live="polite">Carregando conteúdos…</p>
</section>
```

The generator does not create files: create this document **before** adding it to `generatedPages`. Keep `router-bootstrap.js` as the module script; its replacement regex does not match nested `portal-contents/index.js`, so do not put that nested entry in HTML. Task 2 registers the real module before end-to-end route acceptance.

Add `['contents','Conteúdos','book-open']` immediately after announcements in `pages`, and `['contents.html','contents','Conteúdos']` to `generatedPages`. Extend `navItem` with final `hidden=false` argument and set it only for contents; `sidebar` supplies class `contents-link` and hidden for that item. Retain activeClass and local `book-open` sprite.

```css
.sidebar-nav > li[hidden] { display: none !important; }
```

In `sidebar.js`, filter candidates by own/ancestor hidden, inert, `.hidden`, `aria-hidden=true`, disabled and negative tabindex before initial focus and trap wrap; tolerate an empty candidate array. Do not change unrelated authorization datasets.

- [ ] **Step 8: Run shell/gate GREEN and idempotence checks.**

```sh
node scripts/generate-public-shell.mjs
node scripts/generate-public-shell.mjs --check
node --test tests/unit/portal-contents-availability.test.mjs tests/unit/auth-stability.test.mjs tests/unit/task-7-shell-mobile.test.mjs
git diff --check
```

Expected: PASS. Test all 15 generated documents for exactly one initially hidden item after News and before Profile; contents is the only document with that link active. Record hashes of generated files, run generator again, assert identical hashes. No changes to login/icon sprite should be needed because book-open exists.

- [ ] **Step 9: Review and commit Task 1.**

Acceptance: route returns only availability, zero and downtime differ, real middleware remains effective, gate is global and race-safe, snapshots cannot reveal it, drawer cannot focus hidden links, generated output is idempotent. This staged commit does not claim reader-route acceptance. Review diffs for all generated files and exclude unrelated work.

```sh
git add api/routes/contents.js public/js/portal-contents/availability.js public/js/auth.js public/js/sidebar.js public/css/layout.css scripts/generate-public-shell.mjs public/contents.html public/dashboard.html public/knowledge.html public/reminders.html public/academy.html public/benefits.html public/announcements.html public/news-preview.html public/editorial-entry.html public/profile.html public/admin.html public/cms.html public/autocard.html public/cards-pos.html public/solides.html tests/unit/portal-pages-bridge.test.mjs tests/unit/portal-contents-availability.test.mjs tests/unit/auth-stability.test.mjs tests/unit/task-7-shell-mobile.test.mjs
git commit -m "feat(contents): add authenticated availability and shell navigation gate"
```

### Task 2: Strict browser DTO/API, safe ordinary rendering, catalog and routing

**Files:**
- Create: `public/js/portal-contents/dto.js`, `public/js/portal-contents/api.js`, `public/js/portal-contents/rich-text.js`, `public/js/portal-contents/catalog.js`, `public/js/portal-contents/reader.js`, `public/js/portal-contents/index.js`, `public/css/portal-contents.css`.
- Modify: `public/contents.html` (feature stylesheet), `public/js/router.js:6-21` (route), `public/js/auth.js:214-264` (opt-in bounded auth-error body handling).
- Create: `tests/helpers/portal-contents-fixtures.mjs`, `tests/helpers/portal-contents-harness.mjs`, `tests/unit/portal-contents-dto.test.mjs`, `tests/unit/portal-contents-api.test.mjs`, `tests/unit/portal-contents-reader.test.mjs`, `tests/unit/portal-contents-routing.test.mjs`.
- Modify: `tests/helpers/frontend-feedback-harness.mjs`, `tests/helpers/router-harness.mjs`, `tests/unit/persistent-navigation.test.mjs`, `tests/unit/auth-stability.test.mjs`.
- Read-only reference: `api/portal-pages/payload-dto.js`, `cms/src/portal-pages/contracts.ts`, `cms/src/portal-pages/blocks.ts`, `cms/src/portal-pages/primitives.ts`, `cms/src/portal-pages/rich-text.ts`, `cms/src/portal-pages/validation.ts`, `cms/scripts/test.mjs`.

**Interfaces:**
- Consumes Task 1 `getContentsIdentity()`/`subscribeContentsIdentity()`, and existing `authenticatedFetch(path,options) -> Response`, `APIError`, `page.bindAPI`, `page.listen`, `page.cleanup`, `page.location`, `page.history`.
- `dto.js` exports `validatePortalPageDTO(value): PortalPageDTO`, `validateDetail(value,slug): PortalPageDTO`, `validateList(data,total,limit): {data,total}`, `validateCategories(value): CategoryCount[]`, `isCanonicalSlug(value): boolean`. Throw sanitized `Error` with `code:'invalid_contents'`; never normalize wire values. Public scope is not an argument.
- Constants in `dto.js`: `PAGE_SIZE=12`, `MAX_OFFSET=1000000`, `MAX_TOTAL=100000`, `MAX_BLOCKS=100`, `MAX_NODES=10000`, `MAX_CONTENT_BYTES=5*1024*1024`, `MAX_DETAIL_BYTES=6*1024*1024`, `MAX_COLLECTION_BYTES=16*1024*1024`, `LAYOUTS=['content','wide','full','left','right']`.
- `api.js` exports `readBoundedJSON(response,{signal,maxBytes}): Promise<unknown>`, `createContentsAPI(page): {list({category,offset},context),categories(context),detail(slug,context)}`. Each method returns Promise of validated result; context is ViewContext. `list` returns `{data,total}`, never `{rows,count}` to callers.
- `index.js` exports `parseContentsLocation(search): RouteState`, `mount(page): void`. Rendering functions: `renderCatalog(root,{data,total,category,page},context): RenderedView`, `renderCategories(root,categories,currentCategory,context): void`, `renderReader(root,dto,{returnHref},context): RenderedView`.
- `rich-text.js` exports `renderRichText(document,nodes): DocumentFragment`. All nodes are previously validated. Fixed marks order: bold/italic/underline/code (outermost to innermost).
- Media descriptors use the shared vocabulary. Task 2 assigns no media src/href, creates no iframes/dialogs/listeners for media, and does not issue a media session. Task 3 consumes the returned descriptors without changing DTO/API shapes.

- [ ] **Step 1: Write the fixture matrix and strict parity RED tests.**

Define `pageFixture(overrides={})` and `blockFixtures()` in the fixture module; clone values per test, never reuse mutated objects. Use exact UUIDs and valid canonical provider URLs:

```js
export const PAGE_ID = '018f47a2-7b3c-7a11-8a2c-1234567890ab';
export const REVISION_ID = '018f47a2-7b3c-7a11-8a2c-1234567890ac';
export const ASSET_ID = '018f47a2-7b3c-7a11-8a2c-1234567890ad';
export function blockFixtures() {
  return [
    {type:'heading',text:'Política',level:2},
    {type:'rich_text',nodes:[{type:'paragraph',children:[{type:'text',text:'Leia com atenção',marks:['bold','italic']},{type:'break'},{type:'link',url:'https://example.test/policy',new_tab:true,children:[{type:'text',text:'Documento',marks:[]}]}]}]},
    {type:'image',asset_id:ASSET_ID,alt:'Diagrama do processo',caption:'Fluxo\ncompleto'},
    {type:'gallery',images:[{asset_id:ASSET_ID,alt:'Primeira imagem'},{asset_id:ASSET_ID,alt:'Segunda imagem',caption:'Outra descrição'}]},
    {type:'video',asset_id:ASSET_ID,title:'Apresentação'},
    {type:'pdf',asset_id:ASSET_ID,title:'Manual'},
    {type:'embed',provider:'youtube',url:'https://www.youtube.com/embed/Abc123_-xyz',title:'Orientação'},
    {type:'callout',tone:'info',text:'Leia\nantes de começar',title:'Importante'},
    {type:'link',label:'Referência',url:'https://example.test/policy',new_tab:true,style:'primary'},
    {type:'divider'},
  ];
}
export function pageFixture(overrides={}) {
  return {id:PAGE_ID,slug:'published-policy',title:'Política publicada',summary:'Resumo',cover:null,
    categories:[],published_at:'2026-10-20T12:00:00.000Z',content_version:1,asset_scope:'portal-pages',
    content_blocks:blockFixtures(),revision:{id:REVISION_ID,status:'published'},...overrides};
}
```

The fixture spread is test-only; runtime validators/renderers never spread untrusted attributes. Add rich headings 2–6, ordered/unordered and empty lists/paragraphs/text, all tones/styles, Vimeo `https://player.vimeo.com/video/123`, cover/null date, 20 categories and gallery repeated references. Generate 60 valid cases (10 × five layouts plus omission), applying one layout to every block in additional whole-page fixtures.

```js
for (const layout of [undefined, 'content','wide','full','left','right']) {
  for (const block of blockFixtures()) {
    const content = layout === undefined ? block : {...block,layout};
    const dto = pageFixture({content_blocks:[content]});
    assert.deepEqual(browser.validatePortalPageDTO(dto), api.validatePortalPageDTO(dto,'portal-pages'));
  }
}
```

Load the CommonJS API validator via `createRequire`. Load browser ESM through the existing VM/source harness pattern. The CMS normalization entry is **`validatePortalPageDTO(value: unknown): PortalPageDTO`**, exported by `cms/src/portal-pages/validation.ts`; despite its name it normalizes authoring input. Execute it with the already installed `tsx` loader used by `cms/scripts/test.mjs`, in a child process with cwd `cms`, and pass fixture JSON through stdin:

```js
const result = spawnSync(process.execPath, ['--import','tsx','--input-type=module','-e',
  "import {readFileSync} from 'node:fs'; import {validatePortalPageDTO} from './src/portal-pages/validation.ts'; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(validatePortalPageDTO)));"],
  {cwd:new URL('../../cms/',import.meta.url),input:JSON.stringify(authoringFixtures),encoding:'utf8'});
assert.equal(result.status,0,result.stderr);
const normalized = JSON.parse(result.stdout);
for (const dto of normalized) {
  assert.deepEqual(browser.validatePortalPageDTO(dto),api.validatePortalPageDTO(dto,'portal-pages'));
}
```

Import `spawnSync` from `node:child_process` in the unit test. Build `authoringFixtures` from the 60 block/layout cases and explicit untrimmed authoring title/summary/provider inputs. Test normalization output acceptance while both strict validators reject the corresponding noncanonical raw wire fixture. Capture provenance in fixture comments; never import CMS code into public modules. Report a preexisting mismatch as a fixture-backed concern, not a widened acceptance rule.

Reject matrix: unknown page/revision/cover/category/block/rich/inline/gallery keys; native `blockType`, `storageKey`, relation objects, HTML, `style`, `srcdoc`, own `__proto__` from JSON and inherited required fields; preview/draft/version string; bad UUID, slug and ISO spelling; every field's min/max; duplicate/unknown marks; nested links; unsafe URL schemes, credentials, backslash/whitespace/control; fake provider subdomain/query/fragment; 101 blocks; 21 gallery entries; 21 categories; 10001 combined rich nodes; 5/6/16 MiB exact boundary and +1 byte; surrogate pairs versus Unicode code points; transport whitespace overhead; wrong request slug; missing/negative/decimal/exponent/space count header; duplicate page IDs and category IDs/slugs; total below row count and over 100000; rows over requested limit. Use the API's case-sensitive duplicate-ID check, while accepting case-insensitive UUID syntax and lowercasing only URL components. Distinguish independently reachable bounds: 5 MiB content and 16 MiB normalized collection fixtures must satisfy their other fields; the 6 MiB detail transport boundary can use JSON whitespace padding, because a structurally valid DTO may hit the smaller content/field limits before reaching 6 MiB normalized size. Never weaken field bounds to manufacture a passing boundary fixture.

- [ ] **Step 2: Run validator RED.**

Run: `node --test tests/unit/portal-contents-dto.test.mjs`

Expected: FAIL for missing browser validator; after adding exports, fixture acceptance/rejection assertions provide RED until exact validation is implemented.

- [ ] **Step 3: Implement pure strict browser validation.**

Transcribe the public-wire rules from `payload-dto.js:15-179`, deliberately replacing Buffer bytes with `new TextEncoder().encode(JSON.stringify(value)).byteLength`, and fixing scope to public. Preserve every required/optional own-key check, code-point bound, pattern, node budget and empty-array allowance.

| Block | Exact required keys beyond `type`; optional keys beyond `layout` |
| --- | --- |
| heading | `text` 1–200, `level` integer 2/3/4 |
| rich_text | `nodes` array; paragraph children, heading 2–6 children, list ordered boolean/items inline arrays |
| image | `asset_id` UUID, `alt` 1–300; optional `caption` 0–1000 multiline |
| gallery | `images` 2–20 exact `{asset_id,alt,caption?}`; preserve order/references |
| video | `asset_id` UUID, `title` 1–200 |
| pdf | `asset_id` UUID, `title` 1–200 |
| embed | `provider` youtube/vimeo, canonical `url`, `title` 1–200 |
| callout | `tone` info/warning/success, `text` 1–2000 multiline; optional `title` 0–200 |
| link | `label` 1–200, HTTPS `url` <=2048, boolean `new_tab`, `style` primary/secondary |
| divider | no additional keys |

Page exact keys: `id,slug,title,summary,cover,categories,published_at,content_version,asset_scope,content_blocks,revision`. Title 1–200; summary 0–1000 multiline; cover null or exact asset UUID/nonempty alt <=300; categories <=20 exact UUID/slug/name 1–100; timestamp null or exact `toISOString`; revision exact UUID/status published. Slug regex `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 160. UUID regex and `safeMarkup`/Unicode Cc rules must match API literally. Plain strings must already equal trim except rich text preserving whitespace; line breaks only structural in rich text. Count nodes once across all blocks, rich nodes, list items and inline nodes, not gallery entries. Mark set unique bold/italic/underline/code. Inline links contain text/break only.

```js
export function validateList(data,total,limit) {
  // assertValid is local: throws Error('Conteúdo inválido.') with code invalid_contents.
  assertValid(Array.isArray(data) && data.length <= limit);
  assertValid(Number.isSafeInteger(total) && total >= data.length && total <= MAX_TOTAL);
  data.forEach(validatePortalPageDTO);
  assertValid(new Set(data.map(row => row.id)).size === data.length);
  assertValid(new TextEncoder().encode(JSON.stringify({rows:data,count:total})).byteLength <= MAX_COLLECTION_BYTES);
  return {data,total};
}
```

`validateDetail` additionally checks exact requested slug and <=6 MiB serialization. Categories max 10000, exact four keys, positive safe integer counts and unique IDs/slugs, <=16 MiB.

- [ ] **Step 4: Run validator GREEN.**

Run: `node --test tests/unit/portal-contents-dto.test.mjs tests/unit/portal-pages-payload-client.test.mjs`

Expected: PASS; all 60 layout/block pairs and explicit invalid matrices run, not skipped.

- [ ] **Step 5: Add bounded transport RED tests.**

Use real `Response`/`ReadableStream` with counted pulls/cancel, controlled deferred chunks and abort. Assert cancellation at cap+1 before JSON parse, invalid/truncated UTF-8/JSON fail closed, dishonest Content-Length is not trusted, already-aborted request stops, delayed body after identity change cannot render, and list total isn't coerced from missing/empty values. Test categories and list independence. Spy on raw fetch options and URLs; never mock a `{rows,count}` HTTP envelope.

```js
test('bounded JSON cancels an oversized chunk before parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(17)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBoundedJSON(new Response(body), {
    signal:new AbortController().signal, maxBytes:16,
  }));
  assert.equal(cancelled, true);
});
```

Run: `node --test tests/unit/portal-contents-api.test.mjs tests/unit/auth-stability.test.mjs`

Expected: FAIL on bounded transport exports/behavior; existing auth error semantics retained.

- [ ] **Step 6: Implement bounded transport and complete-loader tracking.**

```js
export async function readBoundedJSON(response,{signal,maxBytes}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Resposta inválida.');
  const decoder = new TextDecoder('utf-8',{fatal:true});
  const parts = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort',abort,{once:true});
  try {
    if (signal?.aborted) throw new DOMException('Cancelado','AbortError');
    for (;;) {
      const {value,done} = await reader.read();
      if (signal?.aborted) throw new DOMException('Cancelado','AbortError');
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Resposta excede o limite.');
      parts.push(decoder.decode(value,{stream:true}));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join(''));
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort',abort); reader.releaseLock(); }
}
```

Use `authenticatedFetch` with `credentials:'same-origin', cache:'no-store', signal`, GET caps 6 MiB detail / 16 MiB list/categories. Parse header only with `/^(?:0|[1-9][0-9]*)$/`, safe integer and maximum checks. URLs: `/api/contents/?limit=12&offset=0`, optional category through URLSearchParams; `/api/contents/categories`; `/api/contents/${slug}` only after slug validation.

Important existing helper edge: `authenticatedFetch` currently clones and unboundedly parses 401/403 in `handleAuthenticationFailure` before returning. Add an **opt-in** option `authErrorBodyLimit:16384` for content requests, strip it before native fetch, and bound that auth-error clone with a local stream reader in auth.js. On parse/limit failure use an empty sanitized reason (401 still ends session; 403 follows existing definitive account policy). Cancel the original unauthorized body as well after handling a fatal auth failure. Preserve existing callers' semantics and include auth regression tests. Success and other error bodies are bounded in api.js; never display server body/error text. Content errors map to fixed Portuguese copy with status 400/404/503 and safe reason.

Track the **entire async load through DOM commit**, not just raw response headers. `page.bindAPI` accepts functions `(path,options)`; wrap the view job with that signature and always invoke with method GET:

```js
// In mount, loadView(path,{signal}) is a local async function that parses,
// validates, calls renderCatalog/renderReader and commits only if isCurrent().
const tracked = page.bindAPI({ loadView, loadCategories });
// Invoke synchronously in initial mount and in local popstate callback:
void tracked.loadView(state.href,{signal:viewController.signal}).catch(showLoadFailure);
```

Define `loadCategories(path,{signal})` independently; its failure updates only categories. `createContentsAPI(page)` checks `page.active` and `context.isCurrent()` after transport/parse/validation. `showLoadFailure(error)` ignores AbortError/stale generations and selects the error states below; optional targets use null guards. Do not wrap only `authenticatedFetch` and let `ready()` resolve before content DOM is ready.

- [ ] **Step 7: Run transport GREEN.**

Run: `node --test tests/unit/portal-contents-api.test.mjs tests/unit/auth-stability.test.mjs`

Expected: PASS, including abort/cancel/cap/header/identity and existing session behavior.

- [ ] **Step 8: Add actual-DOM renderer and routing RED tests.**

Create `createContentsHarness({url,request,identity,clock})` in the helper: load real reader modules with the existing `FixtureNode`/document seams; exports `{document,page,modules,mount,dispose,requests}`. `modules` contains actual module exports, `mount()` calls index.mount, `dispose()` calls page.dispose, `requests` records transport calls. Extend only necessary DOM methods (`createTextNode`, `createDocumentFragment`, fragment adoption); never stub a renderer to pass its own test.

```js
test('ordinary renderer is semantic and never activates media', async () => {
  const h = await createContentsHarness({url:'/contents.html?slug=published-policy'});
  const root = h.document.createElement('section');
  h.document.body.append(root);
  const result = h.modules.reader.renderReader(root,pageFixture(),{returnHref:'/contents.html'},
    {signal:h.page.signal,isCurrent:()=>true,onReload:()=>{}});
  assert.equal(root.querySelectorAll('h1').length,1);
  assert.equal(root.querySelectorAll('iframe[src],img[src],video[src],object').length,0);
  assert.equal(result.media.length,5); // image, gallery, video, pdf, embed; cover is null
});
```

Use a separate cover-present fixture expecting 6 descriptors. Test all ordinary block tags, marks nesting independent of input order, line break, callout tone text, multiline captions, link rel/target/cue, divider, empty rich arrays, sole h1 and safe entities as literal text. Invalid DTO must prevent **all** content DOM/media descriptors, not merely skip bad blocks. Assert no handlers/style/srcdoc/unsafe nodes from hostile input.

Add route cases with real router harness injection: initial catalog/direct slug with gate failing, same-route real anchors, Ctrl/Cmd clicks, category resets page, page 1 omission, duplicate recognized params, invalid slug/page/category, slug plus catalog canonicalization, unrelated key removal, exact slug mismatch, Back/Forward, refresh and remembered catalog return. Include deferred A→B→A, cross-area history traversal, 404 unpublish, 400 safe failure, 503/network retry, 401/definitive 403 cleanup, title/focus/scroll and missing optional containers.

Run: `node --test tests/unit/portal-contents-reader.test.mjs tests/unit/portal-contents-routing.test.mjs tests/unit/persistent-navigation.test.mjs`

Expected: FAIL for missing renderers/route; fake module mounts are not sufficient RED/GREEN evidence.

- [ ] **Step 9: Implement safe ordinary rendering and catalog states.**

Use createElement/createTextNode/textContent/append. `renderRichText` creates only p/h2–h6/ol/ul/li/br/a/strong/em/u/code; marks use fixed order. New-tab links have `_blank`, `noopener noreferrer`, visible `Abre em nova aba` cue. Callouts are labeled asides, with tone labels `Informação`, `Atenção`, `Sucesso`, not role alert. Every block gets `contents-block contents-layout-${layout || 'content'}` from the validated enum.

`renderReader` creates header h1, summary, category text and time only for non-null ISO publication; article is a normal in-shell element, not an overlay. For image/gallery/video/pdf/embed create labeled hosts/captions and descriptors; no native URL assignment yet. `renderCatalog` creates h1 `Conteúdos`, a separate categories nav labelled `Filtrar por categoria`, semantic ul/li/article cards with one h2 heading link `id=contents-card-${dto.id.toLowerCase()}`, summary/categories/time, and optional cover descriptor. No nested interactive card or invented artwork. Stable thumbnail boxes reserve space.

Pagination previous/next are real links, omit unavailable directions, show current page and total, and never navigate offset >1000000. Preserve API order. States/copy:

| State | Text/action |
| --- | --- |
| loading | `Carregando conteúdos…`; affected region aria-busy=true, static aria-hidden placeholders |
| all empty | `Nenhum conteúdo publicado no momento.` |
| category empty | `Nenhum conteúdo nesta categoria.` + `Todas` link |
| category failure | `Não foi possível carregar as categorias.` + local `Tentar novamente` |
| 503/network | `Conteúdos temporariamente indisponíveis.` + same-query `Tentar novamente` |
| invalid URL/400/invalid DTO | `Não foi possível abrir este conteúdo com segurança.` + catalog link |
| detail 404 | `Este conteúdo não está mais disponível.` + `Voltar ao catálogo` |

Use a separate polite status region for completion/error; list itself is not live. `renderCategories` does not delete successful cards on its own failure. Guard optional status/pagination/category elements before operations.

- [ ] **Step 10: Implement canonical routing/generation ownership and register the real module.**

```js
export function parseContentsLocation(search) {
  const p = new URLSearchParams(search);
  for (const key of ['slug','category','page']) if (p.getAll(key).length > 1) return {kind:'invalid',href:null};
  const slug = p.get('slug'); const category = p.get('category'); const rawPage = p.get('page');
  if (slug !== null && !isCanonicalSlug(slug)) return {kind:'invalid',href:null};
  if (category !== null && !isCanonicalSlug(category)) return {kind:'invalid',href:null};
  if (rawPage !== null && !/^[1-9][0-9]*$/.test(rawPage)) return {kind:'invalid',href:null};
  const page = rawPage === null ? 1 : Number(rawPage);
  const offset = (page-1)*PAGE_SIZE;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(offset) || offset > MAX_OFFSET) return {kind:'invalid',href:null};
  if (slug !== null) return {kind:'reader',slug,href:`/contents.html?slug=${slug}`};
  const q = new URLSearchParams();
  if (category) q.set('category',category);
  if (page !== 1) q.set('page',String(page));
  const query = q.toString();
  return {kind:'catalog',category,page,offset,href:'/contents.html'+(query ? `?${query}` : '')};
}
```

All recognized malformed values reject even if a valid slug is also present. Strip unrelated keys with `page.history.replaceState(window.history.state,'',state.href)`; `page.history` has only push/replace in the current router, so read state from `window.history.state`. Preserve metadata and perform no raw history writes. Empty category query is invalid; absent category represents empty filter.

`mount` stores generation, child controller, renderedView cleanup and last catalog href in closure. On every route event: close owned gallery through the disposal hook (Task 3), abort/dispose previous view, increment generation, clear old content, then start tracked loads synchronously. Capture UID and auth generation; `isCurrent` requires page.active, same view generation, non-aborted signal and current validated UID/auth generation. Subscribe to auth invalidation for synchronous text/descriptor cleanup.

Use `page.listen(window,'popstate',loadCurrent)` reading `page.location.search`. The router already distinguishes local clicks/traversal, closes dialogs and restores scroll/focus after `ready()`: do not install any click interception or competing popstate router. Let router restoration focus on user navigation; if an explicit page-local retry replaces content, focus its heading only when user activated that retry, never on traversal. Change title on successful detail to `${dto.title} — Conteúdos — Portal Ownerinc`; catalog sets `Conteúdos — Portal Ownerinc`. `Voltar ao catálogo` uses last catalog href from this mount, default `/contents.html`; no unconditional history.back and no catalog request required for direct slug.

Register `'/contents.html':'./portal-contents/index.js'` in routes. Leave `routeAllowed` logic unchanged: a validated active reader is admitted, irrespective of availability. Add `./css/portal-contents.css` only to contents.html; router's existing stylesheet selection disables it elsewhere.

- [ ] **Step 11: Run rendering/routing GREEN and commit.**

```sh
node --test tests/unit/portal-contents-dto.test.mjs tests/unit/portal-contents-api.test.mjs tests/unit/portal-contents-reader.test.mjs tests/unit/portal-contents-routing.test.mjs tests/unit/persistent-navigation.test.mjs tests/unit/auth-stability.test.mjs
node scripts/generate-public-shell.mjs --check
git diff --check
git add public/js/portal-contents/dto.js public/js/portal-contents/api.js public/js/portal-contents/rich-text.js public/js/portal-contents/catalog.js public/js/portal-contents/reader.js public/js/portal-contents/index.js public/css/portal-contents.css public/contents.html public/js/router.js public/js/auth.js tests/helpers/portal-contents-fixtures.mjs tests/helpers/portal-contents-harness.mjs tests/helpers/frontend-feedback-harness.mjs tests/helpers/router-harness.mjs tests/unit/portal-contents-dto.test.mjs tests/unit/portal-contents-api.test.mjs tests/unit/portal-contents-reader.test.mjs tests/unit/portal-contents-routing.test.mjs tests/unit/persistent-navigation.test.mjs tests/unit/auth-stability.test.mjs
git commit -m "feat(contents): add strict catalog and safe published reader"
```

Acceptance: full response validated before content DOM; every block/layout recognized, no activated media; bounded JSON including auth errors; direct routes ignore gate; real router owns history/restoration; no News imports. This is a text/catalog review gate, not native-media acceptance.

### Task 3: Native media session, asset recovery, accessible lightbox and layouts

**Files:**
- Create: `public/js/portal-contents/media-session.js`, `public/js/portal-contents/media.js`, `public/js/portal-contents/gallery.js`.
- Modify: `public/js/portal-contents/index.js`, `public/js/portal-contents/reader.js`, `public/js/portal-contents/catalog.js`, `public/js/auth.js:113-149,197-211`, `public/js/ui.js:193-200`, `public/js/sidebar.js:78-104`, `public/css/portal-contents.css`.
- Create: `tests/unit/portal-contents-media.test.mjs`, `tests/unit/portal-contents-gallery.test.mjs`.
- Modify: `tests/helpers/portal-contents-harness.mjs`, `tests/helpers/frontend-feedback-harness.mjs`, `tests/unit/auth-stability.test.mjs`, `tests/unit/task-7-shell-mobile.test.mjs`, `tests/unit/portal-contents-reader.test.mjs`, `tests/unit/portal-contents-routing.test.mjs`.

**Interfaces:**
- Consumes Task 2 MediaDescriptor/RenderedView/ViewContext and Task 1 AuthIdentity. `media-session.js` imports no auth.js: auth injects its authenticated transport and current identity.
- `configureContentsMediaSession({request,clearRequest,getIdentity,subscribeIdentity,invalidateIdentity,window,document,now,setTimer,clearTimer}): void` installs singleton once. Production `request=authenticatedFetch`; `clearRequest=fetch` (no bearer); `invalidateIdentity` is an auth-owned callback that marks the identity unvalidated, synchronously notifies subscribers, and starts `getCurrentUserDoc()` with a handled rejection. now=Date.now, timers native. No page mutation tracking for coordinator POSTs.
- `acquireContentsMediaLease({signal,isCurrent,onStatus}): MediaLease`; `MediaLease = {ensureFresh({force=false}={}):Promise<void>,isPrepared():boolean,setPlaying(value:boolean):void,release():void}`. `onStatus` gets `ready|renewing|unavailable|expired|denied` only, no private response.
- `clearContentsMediaSession(): Promise<void>` synchronously invalidates local leases and starts a clear barrier; repeated calls join the barrier; reject on failed DELETE so auth's existing retry UI remains in charge.
- `invalidateContentsMediaSession({broadcast=false}={}): void` cancels local issuance/timers, clears preparation and synchronously notifies leases without a DELETE. Auth invalidation uses this immediately; received cross-tab events call the injected `invalidateIdentity` after local invalidation, with broadcast false to avoid loops.
- `assetURL(dto,assetId): string` validates UUID syntax/scope/revision/reference and lowercases components; accepts assets only in cover/image/gallery/video/pdf of this DTO.
- `activateContentsMedia(descriptors,{context,gallery}): {dispose():void}` creates at most one native lease for this view if descriptors include native assets. `gallery` is the per-mount controller below. Embeds do not require the private cookie.
- `createContentsGallery({page,rootHeading}): {open({dto,images,index,opener,lease,context}):Promise<void>,close({restoreFocus=true}={}):void,dispose():void}`. `rootHeading` is a callback returning the current connected heading.
- `ui.js` exports `registerPageDialog({close:()=>void}): ()=>void` for externally owned native dialogs. `closePageDialogs()` invokes registered closers as well as its existing activeDialog; it does not call legacy `openDialog` on the native dialog. The returned unregister function removes ownership idempotently.
- `sidebar.js` handles `document` event `portal:close-drawer` by `closeDrawer(false)`; gallery dispatches it before making background inert. No fabricated exported sidebar module.

- [ ] **Step 1: Write coordinator/time/auth RED tests with an injected clock.**

Define in the contents harness `advance(ms)` that runs due timers in chronological order, `pendingIssues`, `pendingClears`, `identity(next)`, `visibility(hidden)`, and a second coordinator environment sharing a fake BroadcastChannel/storage bus. Use real module implementations and deferred Response objects.

```js
// Algorithm exercised by named tests, with helpers from the contents harness:
const lease = acquireContentsMediaLease({signal,isCurrent:()=>true,onStatus:status.push.bind(status)});
const a = lease.ensureFresh(); const b = lease.ensureFresh();
assert.equal(pendingIssues.length,1);
assert.equal(pendingIssues[0].options.method,'POST');
assert.equal(Object.hasOwn(pendingIssues[0].options,'body'),false);
pendingIssues[0].resolve(new Response(null,{status:204}));
await Promise.all([a,b]);
advance(240000); // issuance start, not response completion, defines renewal
assert.equal(pendingIssues.length,2);
assert.equal(page.busy,false); // cookie issue does not block leaving
```

Cases: slow issue reaches 15000 ms timeout; no expiresAt parse; 200 JSON is not success; two leases share issue; disposing one does not cancel another; zero leases stop timers with no DELETE; hidden paused view stops proactive issue, hidden playing video renews; visibility/focus/online recheck; 5/15/30 bounded retry, Retry-After seconds/HTTP-date on 429 as minimum delay; stop after three retries until interaction/online; known expiry pauses and removes PDF href; navigation while issuing; logout/account switch invalidation before awaiting; DELETE failure keeps content hidden and retry usable; late same-tab POST after clear demands second DELETE before new identity issue; cross-tab invalidation cancels/hides and does not echo infinitely; received old broadcast cannot reveal/issue; new identity needs own live validation and successful POST. Do not assert instantaneous global revocation.

Run: `node --test tests/unit/portal-contents-media.test.mjs tests/unit/auth-stability.test.mjs`

Expected: FAIL on missing coordinator/clear behavior.

- [ ] **Step 2: Implement lease coordination and auth-exit barrier.**

Use constants `MEDIA_TTL_MS=300000`, `MEDIA_RENEW_MS=240000`, `MEDIA_ISSUE_TIMEOUT_MS=15000`, `MEDIA_RETRY_MS=[5000,15000,30000]`. Record request-start time before calling authenticatedFetch. Response 204 only grants a lease if identity/generation/current state still match and expiry has not elapsed. No src updates on ordinary renewal success.

```js
// Coordinator state algorithm:
// live leases Set; inFlight {controller,startedAt,identity,promise}; expiresAt/renewAt;
// blockedUntilClear boolean; local generation; retryIndex; timer; playing leases Set.
// ensureFresh(force=false):
//   reject stale/released/clearing/invalid identity;
//   if !force && now < renewAt and now < expiresAt return;
//   join current same-identity issue; otherwise issue one POST with no body,
//   credentials:'same-origin',cache:'no-store', timeout controller and bounded auth errors.
//   on 204 set expiresAt=startedAt+300000, renewAt=startedAt+240000, reset retries;
//   notify only current leases; schedule renewal if visible OR any lease is playing.
//   on transient failure notify media-specific unavailable and schedule bounded retry;
//   always maintain an expiry timer that marks expired and pauses/disables actions.
// release: remove lease/listeners, clear timers and in-memory preparation when none;
// next mounted native-media view obtains its own POST, including BFCache remount; no DELETE.
```

`clearContentsMediaSession` invalidates synchronously, sets clearing barrier, cancels pending issue and retries, emits invalidation, and sends bodyless same-origin/no-store DELETE via raw fetch with timeout. Await settlement of old same-tab issuance; if it might have completed after DELETE, clear again before barrier release. Keep barrier blocked on failure and return rejection for `finishSessionExit` retry. Aborted browser requests cannot prove the server did not issue: document that residual races are bounded by server active-user/revocation checks and TTL. No lease gets ownership merely because the shared cookie might exist.

In `finishSessionExit`, start both editorial revoke and media clear and await both via `Promise.allSettled`; throw if either rejects, rather than short-circuiting and skipping the other. Existing retry UI/conditional signOut stays. Start synchronous media invalidation from auth clearing/account change, not only after the asynchronous DELETE. Pass an explicit broadcast flag internally so receiving an invalidation does not rebroadcast it.

Cross-tab channel/key `ownerinc-contents-invalidation`; payload contains only `{generation:<opaque unique invalidation string>}` (for example crypto.randomUUID), no UID/token. Deduplicate seen event IDs in a bounded in-memory set. Prefer BroadcastChannel, fallback storage set/remove for this invalidation only, not availability or credentials. Receiving tabs invalidate media and protected contents through the auth identity notification path, marking validated=false, then use existing `getCurrentUserDoc()` revalidation before subsequent media acquisition. Do not sign out a newly switched Firebase account due to an old tab's UID; revalidation determines current identity. Tests cover storage unavailable and Firebase's existing cross-tab callback as well.

- [ ] **Step 3: Run coordinator/auth GREEN.**

Run: `node --test tests/unit/portal-contents-media.test.mjs tests/unit/auth-stability.test.mjs tests/unit/portal-pages-bridge.test.mjs`

Expected: PASS, bodyless 204 and existing production/development cookie attributes remain unchanged.

- [ ] **Step 4: Add native binding/gallery DOM RED tests.**

Test exact lowercase `/api/contents/assets/${pageId}/${revisionId}/${assetId}` reference allowlist, no URL before 204, no fetch-to-bytes, stale issuance cannot assign sources, native image preserves caption/alt after failure, one retry per element failure generation, repeated gallery assets preserve position, video currentTime clamp/resume intent/rejected play, source unchanged on renewal, disposal pause/remove src/load, PDF no href until prepared and expired click prevented/no window.open, and iframe fixed policy/provider fallback.

Gallery tests use native dialog seams `showModal/close/open` and real listener dispatch, not legacy backdrop replacement. Test one dialog despite multiple galleries, order/wrap, explicit close/previous/next names and target size, status/description, image failure then next, Tab/Shift+Tab with disabled/retry controls, Escape cancel, arrows only while focus in dialog/noneditable, Enter/Space normal button activation, removed opener fallback, route close without focus restoration, pointerdown/up backdrop pair, saved inert/scroll/style restoration, drawer close event and repeated mount/dispose.

```js
test('gallery owns one dialog and releases pre-existing background state', async () => {
  const h = await createContentsHarness({url:'/contents.html?slug=published-policy'});
  const sibling = h.document.createElement('section'); sibling.inert = true;
  h.document.body.append(sibling);
  // Mount through the real index with the valid gallery fixture and successful 204.
  await h.mount(); await h.page.ready();
  const trigger = h.document.querySelector('[data-contents-gallery-trigger]');
  trigger.click(); await drain();
  assert.equal(h.document.querySelectorAll('dialog[data-page-overlay]').length,1);
  h.modules.ui.closePageDialogs();
  assert.equal(sibling.inert,true);
  h.dispose();
  assert.equal(h.document.querySelectorAll('dialog[data-page-overlay]').length,0);
});
```

Run: `node --test tests/unit/portal-contents-media.test.mjs tests/unit/portal-contents-gallery.test.mjs tests/unit/portal-contents-reader.test.mjs tests/unit/task-7-shell-mobile.test.mjs`

Expected: FAIL for native bindings/modal lifecycle not yet present.

- [ ] **Step 5: Implement native media bindings and conservative recovery.**

`activateContentsMedia` gets one lease per view containing cover/image/gallery/video/PDF, installs listeners under the view abort signal, and starts preparation without adding POST to `page.bindAPI`. After ensureFresh **and every subsequent await**, require context.isCurrent and lease ownership before setting src/href. Record cleanup for every created native element; no secret in error strings.

| Kind | Implementation and failure/recovery |
| --- | --- |
| image/cover | figure/img/figcaption, descriptive alt, decoding=async, lazy below fold; article contain/natural aspect, cover stable crop box. On error preserve text, expose `Tentar novamente`; at most one forced renewal/reload per failure generation. |
| video | controls, playsInline, preload=metadata, no autoplay/loop/poster fabrication, visible title/aria-label. On play/seeking ensure lease; if overdue pause immediately before renewal, preserve intended action. On native error save currentTime and intent, force one renewal, reload only for recovery, restore min(saved,duration) on loadedmetadata, catch play rejection and show user retry. Successful timer renewal never replaces src. |
| pdf | titled block, `Abrir PDF — <title>` anchor `_blank` + noopener noreferrer and visible new-tab cue; native download anchor with download attribute. No src/object/iframe/canvas or async popup. Prepare on initial activation/focus/pointerenter; expired ordinary click preventDefault, renew, say `PDF pronto. Clique novamente para abrir.` Modified click relies on already prepared href; expired/unprepared href is removed, aria-disabled=true and instructions remain. |
| embed | lazy titled iframe in 16:9 wrapper, fixed `sandbox="allow-scripts allow-same-origin allow-presentation"`, `allow="fullscreen; picture-in-picture; encrypted-media"`, allowfullscreen, referrerpolicy=strict-origin-when-cross-origin. Exact canonical provider URL only; ordinary approved-provider anchor/title always available. A load event is not playback proof. |

PDF copy beside actions: `A visualização em outra aba pode expirar após cinco minutos sem renovação no Portal. Volte aqui e abra o PDF novamente.` Explain browser may open instead of download and actions remain usable without an installed viewer. Native controls don't prove authored video accessibility; no invented track/transcript fields.

Persistent failure after one fresh issue shows `Recarregar conteúdo`; `context.onReload()` performs a whole validated DTO reload, disposes old assets first and never merges revisions. Transient cookie failure preserves text. Lease expired status pauses video/removes PDF href; renewing does not automatically resume playback unless captured user intent still applies. Use timer generation to ignore obsolete onerror/loadedmetadata/play callbacks. Dispose videos by pause, remove src/source children, load; clear image handlers/src; remove iframe src/node; release lease; no cookie DELETE on disposal/pagehide.

- [ ] **Step 6: Implement owned native dialog lifecycle and gallery.**

The current `ui.js.openDialog` overwrites sibling inert and only toggles CSS; do not call it for `<dialog>`. Add an independent Set of external close callbacks:

```js
const ownedPageDialogs = new Set();
export function registerPageDialog({close}) {
  ownedPageDialogs.add(close);
  return () => ownedPageDialogs.delete(close);
}
// Add to existing closePageDialogs(), after closing legacy activeDialog:
// for (const close of [...ownedPageDialogs]) close();
```

Gallery registers `close:()=>gallery.close({restoreFocus:false})` when created and unregisters on dispose. Same-route router traversal now closes the native dialog before local DOM replacement. Normal UI close calls restoreFocus=true. Do not alter existing dialog dirty/leave guards.

Render each gallery as ordered ol/li/figure with button names `Abrir imagem n de N — <alt>`, captions in both views. Create one body-child dialog with class `portal-contents-lightbox`, `data-page-overlay`, unique `contents-lightbox-*` IDs, title/aria-labelledby and aria-describedby pointing to caption/status. On open: capture opener and scroll, close drawer without restoring focus, ensure lease, check current generation, snapshot applicable sibling inert values and exact document/body overflow/padding styles, apply only owned locks, showModal, focus close. Store previous styles, not just empty strings. Compensate scrollbar width; avoid overwriting preexisting shell mobile state on restore.

Dialog shows close/previous/next (>=44px), uncropped image, caption and polite `Imagem n de N`, loading/failure/retry. Previous/next wrap only this gallery; stable controls/focus during image changes. Filter enabled visible controls on each Tab; trap both directions, focus dialog if none. Escape cancel prevents default and calls close; arrows only when dialog contains activeElement and target isn't input/textarea/select/contenteditable. Backdrop close requires matching down/up on dialog backdrop, not image drag. No global touch preventDefault, no autoplay, no history push. Normal close restores connected opener or connected gallery/reader heading; route/auth cleanup restores no departing focus. Remove image src/listeners on close/dispose and restore exactly owned inert/styles/scroll.

- [ ] **Step 7: Implement five-layout CSS and responsive media/lightbox styles.**

Use Portal tokens and typography from existing styles; every selector scoped to `.portal-contents` or `.portal-contents-lightbox`. No broad article/card/main overrides. Container sizing must use available main width, not viewport breakout:

```css
.portal-contents { container-type: inline-size; min-inline-size: 0; }
.portal-contents .contents-article { display: grid; grid-template-columns: minmax(0,1fr); min-inline-size: 0; }
.portal-contents .contents-block { grid-column: 1; min-inline-size: 0; max-inline-size: 100%; overflow-wrap: anywhere; }
.portal-contents .contents-layout-content { inline-size: min(100%,72ch); justify-self: center; }
.portal-contents .contents-layout-wide { inline-size: min(100%,1100px); justify-self: center; }
.portal-contents .contents-layout-full { inline-size: 100%; }
.portal-contents .contents-layout-left,
.portal-contents .contents-layout-right { inline-size: min(100%,72ch); }
.portal-contents .contents-layout-left { justify-self: start; margin-inline-start: max(0px,calc((100% - 1100px)/2)); }
.portal-contents .contents-layout-right { justify-self: end; margin-inline-end: max(0px,calc((100% - 1100px)/2)); }
.portal-contents .contents-gallery-list { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,180px),1fr)); }
.portal-contents .contents-multiline { white-space: pre-wrap; }
.portal-contents .contents-embed { aspect-ratio: 16 / 9; }
@container (max-width: 1100px) {
  .portal-contents .contents-block { inline-size: 100%; margin-inline: 0; justify-self: stretch; }
}
@media (max-width: 768px) {
  .portal-contents .contents-block { inline-size: 100%; margin-inline: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .portal-contents-lightbox { transition: none; animation: none; }
}
```

Apply content measure separately to title/metadata. Left/right margins are **positive wide-track alignment**, never negative breakout, and must be included in overflow tests. If margin percentage resolution produces overflow, replace with named grid tracks while preserving 72ch/1100px semantics; do not introduce floats or paired columns. Media max-inline-size:100%, img/video natural height; responsive iframe fills wrapper. Lightbox max-inline-size bounded by 100dvw minus safe-area/gutters, max-block-size by 100dvh, scrollable caption/controls, min 44px targets, visible focus and optional short opacity only. At narrow mobile galleries use one column; no pinch-zoom suppression.

- [ ] **Step 8: Run media/gallery GREEN and commit.**

```sh
node --test tests/unit/portal-contents-media.test.mjs tests/unit/portal-contents-gallery.test.mjs tests/unit/portal-contents-reader.test.mjs tests/unit/portal-contents-routing.test.mjs tests/unit/auth-stability.test.mjs tests/unit/task-7-shell-mobile.test.mjs
git diff --check
git add public/js/portal-contents/media-session.js public/js/portal-contents/media.js public/js/portal-contents/gallery.js public/js/portal-contents/index.js public/js/portal-contents/reader.js public/js/portal-contents/catalog.js public/js/auth.js public/js/ui.js public/js/sidebar.js public/css/portal-contents.css tests/helpers/portal-contents-harness.mjs tests/helpers/frontend-feedback-harness.mjs tests/unit/portal-contents-media.test.mjs tests/unit/portal-contents-gallery.test.mjs tests/unit/portal-contents-reader.test.mjs tests/unit/portal-contents-routing.test.mjs tests/unit/auth-stability.test.mjs tests/unit/task-7-shell-mobile.test.mjs
git commit -m "feat(contents): add native media leases and accessible gallery"
```

Acceptance: no protected src/href before current-identity 204; no blob buffering; renewal doesn't reset video; auth clear blocks new issuance and preserves editorial revoke; gallery is owned accessible native dialog; exact 10×5 layout classes; lifecycle cleanup doesn't leave sound/dialog/lock. Unit PASS is not native Range or provider playback evidence.

### Task 4: Whole-shell integration, CSP, local acceptance, regressions and evidence

**Files:**
- Modify: `nginx/nginx.conf:16` (Portal CSP only), `tests/helpers/router-harness.mjs`, `tests/unit/portal-contents-routing.test.mjs`, `tests/unit/portal-contents-media.test.mjs`, `tests/unit/task-7-shell-mobile.test.mjs`, `tests/unit/persistent-navigation.test.mjs`, `tests/unit/navigation-review-regressions.test.mjs`, `tests/unit/auth-stability.test.mjs`.
- Create: `scripts/test-portal-contents-acceptance.mjs`, `tests/unit/portal-contents-acceptance.test.mjs`, `docs/operations/portal-contents-reader.md`, `docs/reviews/2026-10-20-portal-contents-reader-acceptance.md`.
- Modify: `README.md`, `docs/architecture/overview.md`, `docs/architecture/portal-pages-content.md`.
- Run existing regression files: `tests/unit/owner-news-reader.test.mjs` plus the full discovered `tests/unit/owner-news*.test.mjs` set via `npm run verify`; editor/Academy regressions are included by that command. Do not alter their product implementation to satisfy this feature.

**Interfaces:**
- Consumes all previous task interfaces, existing router pagehide disposal/persisted pageshow remount and `getCurrentUserDoc` live validation.
- CSP adds only `https://player.vimeo.com` to existing Portal `frame-src`, retaining Firebase/YouTube/blob sources, object-src 'none', frame-ancestors, script/connect policy and the editorial CSP map.
- Acceptance CLI: `node scripts/test-portal-contents-acceptance.mjs --check-config` (no services, exit 2 NOT_EXECUTED), `node scripts/test-portal-contents-acceptance.mjs --aggregate` (read explicit records, exit 0 only complete PASS; exit 1 FAIL/invalid; exit 2 incomplete).
- Guard environment: `NODE_ENV=test`, `PORTAL_CONTENTS_TEST_DISPOSABLE=true`, `PORTAL_CONTENTS_TEST_BASE_URL` loopback HTTP(S), `PORTAL_CONTENTS_TEST_RUN_ID` UUIDv4, `PORTAL_CONTENTS_TEST_EVIDENCE_DIR` absolute directory outside checkout. These are dedicated test values, never `.env` runtime fallback. Browser/service operations follow the runbook manually with existing authorized tools; this dependency-free CLI does not claim to automate playback or launch Docker.
- Evidence record exact keys: `{case,commit,runId,environment,browser,viewport,scenario,status,artifact,notes}`; status `PASS|FAIL|NOT_EXECUTED`; absent artifact represented null, never fabricated. Aggregate requires each named case once, rejects extras/duplicates/invalid status and missing metadata.

- [ ] **Step 1: Add whole-router/CSP/evidence RED cases.**

Use real `router.js`, `page-lifecycle.js`, auth hooks and contents module together. Extend router harness module-map loading instead of substituting fake contents mount. Assert shell document/sidebar/topbar/main identity stays the same across Contents→News→Academy→Contents; same-route popstate starts tracked loader before restoration; direct route works with failed gate; hidden nav never affects routeAllowed; source/media work doesn't block leaving; pagehide disposes and persisted pageshow revalidates UID/availability/lease; old DOM never survives changed identity. Count listeners/dialogs and ensure no leaked locks/audio over 10 enter/leave cycles.

Add CSP assertion comparing directives before/after: Vimeo added to Portal frame-src only; no new wildcard/unsafe-eval/object/frame relaxation. Add acceptance aggregation table tests:

```js
test('an unexecuted required browser case prevents aggregate PASS', () => {
  const records = REQUIRED_CASES.map(name => evidence(name,'PASS'));
  records.find(row => row.case === 'screen-reader-gallery').status = 'NOT_EXECUTED';
  assert.equal(aggregateEvidence(records).status,'NOT_EXECUTED');
  assert.equal(aggregateEvidence(records).exitCode,2);
});
```

In this test `evidence(case,status)` returns all required exact metadata fields using fixture commit/run ID/browser/viewport; `aggregateEvidence` and `REQUIRED_CASES` are exports of the new CLI module (main execution guarded by direct invocation). Include missing/duplicate/extra named case, FAIL precedence, empty manifest, mocked evidence marked live, unsafe path/remote URL and check-only never PASS.

Run: `node --test tests/unit/portal-contents-routing.test.mjs tests/unit/portal-contents-acceptance.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/task-7-shell-mobile.test.mjs`

Expected: new CSP/integration/aggregator cases FAIL before changes; distinguish harness defects from product failures.

- [ ] **Step 2: Apply narrow integration corrections and CSP GREEN.**

Add Vimeo host once in Nginx Portal `frame-src`; do not reload Nginx outside the explicitly authorized disposable environment. Fix only integration bugs found by RED tests in their owning module, adding that exact file to this task's commit if needed and recording the reason. In particular BFCache must remount through existing router listener, not a second page boot listener. On pagehide release local media only; fresh mount needs new identity validation and an issuance even if a cookie still exists. Persistent coordinator invalidates its preparation epoch for restored documents; old DOM is never a cache of authorization.

Implement aggregator required cases from the matrix below and a runbook template that writes one record per case. `--check-config` validates explicit loopback/directory/run ID/opt-in, emits all cases NOT_EXECUTED and returns 2; does not connect, migrate, seed, delete evidence or launch services. `--aggregate` validates actual record metadata and preserves failures/omissions. Existing CMS integration check-only is not reader acceptance and must not be renamed as such.

Run: `node --test tests/unit/portal-contents-routing.test.mjs tests/unit/portal-contents-acceptance.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/task-7-shell-mobile.test.mjs`

Expected: PASS offline; `--check-config` remains NOT_EXECUTED/exit 2 by design.

- [ ] **Step 3: Establish the authorized disposable service fixture and record preflight.**

Before any Docker action, confirm the supervising session's existing authorization covers the named local project/containers/volumes and record that reference in the runbook evidence. Use only that disposable stack and loopback URLs; no production host, deploy script, Nginx production reload or migration against runtime DB. If the authorization/environment doesn't cover a required action, mark the affected cases NOT_EXECUTED and report the blocker rather than expanding authorization.

Read `docs/operations/local-development.md` and `docs/operations/portal-pages-editorial.md`. Inspect the authorized local Compose project and running endpoints; use the existing dedicated disposable Portal and CMS databases and Firebase Auth Emulator. Record exact container/image/port/browser versions and distinguish emulator from real Firebase. Keep secrets/cookies/storage state/HAR raw headers outside git under the guarded evidence directory; publish only sanitized request metadata and artifact references.

Create synthetic fixtures through the existing editorial UI/protocols in this disposable stack, not new domain routes or direct production SQL: active viewer A, active viewer B, editor with manageKnowledge, inactive viewer; zero-publication state; published catalog of at least 13 pages/two categories; one full 10-block page for each of five layouts plus omitted layout; valid image/gallery repeats and long alt/caption text; a >6-minute MP4/WebM with seekable metadata; a large PDF (at least 20 MiB, within 100 MiB ingress limit) with known size; YouTube/Vimeo canonical samples that allow embedding. Record fixture UUIDs/revisions and a local cleanup manifest. Use publication/unpublish controls to test stale revisions; no publication protocol changes. Existing native CMS integration runner can establish editorial prerequisites but its synthetic authority does not prove the Portal's real HTTP auth bridge.

- [ ] **Step 4: Execute named service/browser acceptance cases and save actual evidence.**

Every row is a REQUIRED_CASES literal in the aggregator. Run against the actual Portal/API/CMS/Nginx disposable stack, with network preservation enabled; commands and browser actions must reference the run's real fixture IDs. No new browser dependency: use existing installed browser tooling/OpenChamber or manual DevTools and record which. Unit mocks cannot satisfy these rows.

| Required case | Concrete scenario / PASS condition |
| --- | --- |
| `live-auth-gate` | Log in as active viewer without manageKnowledge. Zero publications hides link; publish reveals on fresh navigation/visible/online probe; CMS outage hides link and gives 503, not empty/denied; direct slug loads independently; inactive/unauthenticated receives actual middleware denial. Record real `/users/me` and availability statuses. |
| `catalog-routing` | Catalog 12 then next page, category resets page, category retry independent, Ctrl/Cmd/open-new-tab, Back/Forward, refresh direct slug and invalid duplicate/hostile query. Verify title/h1, return target, focus/scroll and no extra document navigation for soft routes. |
| `native-image` | After bodyless POST 204 observe native revision-bound image GET, no Authorization on native request, cookie scoped to assets, private/no-store/nosniff. No Blob/object URL or JS full-body download. Sanitize cookie values from trace. |
| `native-range` | Native video metadata + seek and PDF open produce real Range traffic. In DevTools send separate credentialed requests with `Range: bytes=0-1023`, `bytes=1024-`, `bytes=-1024`, and an out-of-file range using known fixture size; do not synthesize ranges in product code. Record 206 Content-Range/Accept-Ranges/Content-Length and 416, cancellation and streaming through actual Nginx. Inspect effective response buffering separately from request buffering; record response start/stream progress before full upstream completion. |
| `long-video-renewal` | Play >6 minutes; at ~4 minutes POST refresh succeeds with 204, no src replacement/currentTime reset; after minute 5 seek causes authorized later Range. Repeat hidden-tab playback without suspension and record renewal. |
| `media-failure-recovery` | Force renewal network failure/429 in disposable browser, record 5/15/30 retry and Retry-After, expiry pause/disabled PDF, online recovery; suspend tab past expiry and resume without promised uninterrupted playback. Force native persistent failure then whole-content reload after publishing another revision; old/new revision assets never mix. |
| `large-pdf` | Open prepared native PDF and download link; demonstrate large document opens without JS-buffering the whole file. Exercise missing viewer behavior; leave standalone tab until cookie expiry with Portal media lease released, retry later request and return/reopen instructions. Do not claim indefinite standalone renewal. |
| `auth-exit-cross-tab` | Two tabs A; logout/account switch while POST is pending and while video/gallery open; DOM/media hidden synchronously, media DELETE and editorial revoke run, failed clear exposes retry, late same-tab issuance is cleared again, B requires own POST. New asset request rejects revoked/inactive identity; already-received bytes not claimed revoked. Exercise BroadcastChannel and storage fallback. |
| `gallery-keyboard` | Keyboard-only open, close focus, Tab/Shift+Tab, wrap arrows, Escape, retry then next failed image, removed opener fallback, router Back close, backdrop drag no-close, preserved preexisting inert/style/scroll and mobile drawer exclusion. Save accessibility tree and keyboard sequence. |
| `screen-reader-gallery` | Manual screen-reader/browser/version recorded: dialog name, current caption/status/alt and image count announced, controls reachable, no background focus, close returns focus. Automated DOM/AX checks alone cannot mark PASS. |
| `embeds-effective-csp` | YouTube and Vimeo actually play under effective Nginx CSP and fixed sandbox; blocked provider retains approved link/title. Record playback and effective headers, not iframe load alone. |
| `layout-mobile` | All 10×5 plus omitted layout; widths 320,375,768 and desktop 1440, sidebar expanded/collapsed, long URLs/captions, 200% zoom, reduced motion, touch/pinch zoom. Check `document.documentElement.scrollWidth <= document.documentElement.clientWidth` and full blocks stay in main gutters; visible controls >=44px and caption scroll works. Save screenshots by viewport. |
| `bfcache-cleanup` | At least ten enter/leave cycles plus actual persisted pageshow (record persisted value); no duplicate listeners/dialogs/audio/scroll locks, fresh `/users/me`, availability and media issuance before reassignment. Browser not using BFCache means NOT_EXECUTED for this case, not simulated PASS. |
| `owner-news-regression` | Existing News catalog, overlay, links/Back, private original media route still work. News DTO/transport untouched; Academy opens, editor entry works and logout still revokes editorial session. Verify persistent shell identity and every generated page's hidden initial item. |
| `editorial-accessibility` | Inspect fixture PDFs for tagging/reading order and authored videos for meaningful captions/transcript/alternative. Record missing material as FAIL/concern, never invent DTO subtitle fields or equate native controls to full accessibility. |

If real Firebase (not emulator) verification is outside authorization, explicitly report it NOT_EXECUTED as an environment limitation; do not promote emulator results to real Firebase acceptance. The `environment` field must identify this scope for every row. Reader acceptance can only be described as the actual tested local scope, never production readiness.

- [ ] **Step 5: Write documentation/evidence and aggregate honestly.**

Update README feature/verification links; architecture overview route count and focused modules; portal-pages-content published-reader section, availability separation and cookie limits. Add operation runbook with user-visible empty/unavailable/retry behaviors, catalog/deep-link forms, all bounds, five-layout semantics, PDF standalone limitation, authored accessibility obligations, lifecycle/revocation limits and local fixture cleanup procedure. No deploy instructions changed.

Acceptance report contains commit under test, authorization reference, fixture/run ID, actual commands/exit codes, table of every required case, browser/version/viewport, artifact paths and concerns. Keep raw credentials and HAR secrets outside repo; report sanitized summaries. Screenshots only prove rendering, not transport/auth/playback.

```sh
node scripts/test-portal-contents-acceptance.mjs --aggregate
```

Expected: exit 0/PASS only when every required named record is valid PASS; exit 1 for FAIL/invalid; exit 2 for any NOT_EXECUTED/missing execution. Do not change NOT_EXECUTED to PASS to finish the task. Missing service/manual evidence is a visible acceptance blocker even if offline verification passes.

- [ ] **Step 6: Run final verification and inspect the final diff.**

```sh
npm run verify
node scripts/generate-public-shell.mjs --check
git diff --check
```

Record actual exit codes/test counts. Use a sufficiently long foreground timeout for verify (at least 10 minutes in this Windows checkout), not the default 120-second tool deadline. Approved spec baseline recorded 15 preexisting failures (14 EPERM fixture directories under C:\Users and one Git Bash spawn timeout); re-observe and name any remaining failures, do not infer today's result or fix unrelated platform behavior silently. Run focused suites after any integration correction, then verify again only if changes justify it. Inspect imports to ensure no News coupling, no schema/publication/deploy changes, no secret-bearing artifacts, and generated-shell idempotence.

- [ ] **Step 7: Review and commit Task 4 with honest acceptance status.**

Acceptance: offline whole-shell/security/regression tests pass; service/manual rows have explicit actual outcomes and no incomplete aggregate PASS; effective CSP and native streaming are proven only where executed; documentation covers limitations. If mandatory browser/service cases are NOT_EXECUTED or verify fails, commit the accurate evidence but report delivery **BLOCKED/PARTIAL**, not accepted.

```sh
git add nginx/nginx.conf tests/helpers/router-harness.mjs tests/unit/portal-contents-routing.test.mjs tests/unit/portal-contents-media.test.mjs tests/unit/task-7-shell-mobile.test.mjs tests/unit/persistent-navigation.test.mjs tests/unit/navigation-review-regressions.test.mjs tests/unit/auth-stability.test.mjs scripts/test-portal-contents-acceptance.mjs tests/unit/portal-contents-acceptance.test.mjs docs/operations/portal-contents-reader.md docs/reviews/2026-10-20-portal-contents-reader-acceptance.md README.md docs/architecture/overview.md docs/architecture/portal-pages-content.md
git commit -m "test(contents): verify shell integration and record reader acceptance"
```

Stage additional owning-module fixes from Step 2 only by exact reviewed paths; never `git add .` or commit raw test credentials. Return four commit IDs, verification results, acceptance aggregate, unresolved concerns and evidence path to the supervising session.

## Specification coverage and implementation self-review

| Approved section | Owning tasks / proof |
| --- | --- |
| 1 Decision/scope | Global constraints; Task 2 dedicated in-shell route; Task 4 domain regression. |
| 2 Architecture/ownership | File map, shared interfaces; Tasks 1–3 lifecycle/module boundaries. |
| 3 Availability/navigation | Task 1 exact route, gate/auth/sidebar/generator; Task 2 independent direct route; Task 4 live gate. |
| 4 Routes/data/catalog | Task 2 bounded array/count API, categories, canonical query/history/focus states; Task 4 live routing. |
| 5 Strict DTO/rich text | Task 2 60-case parity/reject/bytes/nodes/DOM matrix, strict API wire authority. |
| 6 Native media/session | Task 3 lease/native transport/auth exit/races; Task 4 Range, >5-minute video and PDF evidence. |
| 7 Embeds/CSP | Task 3 exact iframe provider/sandbox; Task 4 narrow CSP and real playback. |
| 8 Gallery/lightbox | Task 3 dialog ownership, keyboard/inert/scroll; Task 4 keyboard, AX and screen-reader checks. |
| 9 Layout | Task 3 five classes/containment/CSS; Task 4 10×5 viewport/sidebar/zoom tests. |
| 10 Cancellation/restoration | Task 2 full-job bindAPI/current generation; Task 3 no mutation-busy renewal; Task 4 actual BFCache/repeat cycles. |
| 11 Verification/evidence | Each RED/GREEN and commit; Task 4 strict aggregation, actual verify, named NOT_EXECUTED and regression matrix. |
| 12 Conclusions/constraints | Explicit wire-vs-source parity, no 204 JSON, native cookie TTL/standalone limits, no authorization-by-cache or hidden coupling. |

Self-review gates before each commit:

- Names agree: AuthIdentity `generation`, RouteState `page/offset`, RenderedView `media/dispose`, MediaLease `ensureFresh/isPrepared/setPlaying/release`, ViewContext `isCurrent/onReload` are identical across tasks.
- Router feasibility: `page.history` exposes pushState/replaceState, not state; read committed `page.location`; full loader is bound so ready waits for DOM; router handles modified anchors and traversal; no new top-level page boot.
- Generator feasibility: new HTML exists before generation; nested module isn't injected by generator regex; use router-bootstrap and route map; all 15 generated HTMLs are explicit commit paths; local book-open already exists.
- Auth feasibility: transport injected into persistent modules avoids import-time cycles; visual snapshot is never live identity; bounded auth-error parsing precedes content API parsing; session exit attempts both clear operations and retries failure.
- Long video: request-start TTL, proactive renewal, hidden-playing path, no successful-refresh src replacement, bounded retries and expiry pause; suspension not promised seamless.
- Cross-tab: no credential broadcast/storage; receivers clear/hide/revalidate, old events cannot authorize; late same-tab issue needs clear barrier, global Set-Cookie races remain bounded not magically eliminated.
- PDF: prepared real anchor/download, expired activation requires a new user click, no async popup/full-JS buffering, standalone viewer cannot renew itself and binary accessibility requires editorial proof.
- Dialog: native showModal and owned UI registration, no legacy openDialog inert overwrite, drawer closed before own lock, no departing-focus restore, all resources removed.
- Evidence: all required cases exist exactly once; unexecuted/manual/real-Firebase scope honestly labelled; incomplete aggregate cannot PASS. No production or deploy action follows from this plan.

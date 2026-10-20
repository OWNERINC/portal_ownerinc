# Portal Pages Editorial Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the native PortalPages editor with immutable explicit saves, CAS publication, exact editorial preview, and field-local chunked media uploads.

**Architecture:** Preserve Payload's native form, Lexical blocks, autosave and Versions; add page-local services and public admin extensions rather than a second editor. Mutation services own transactions and verify their receipts in a fresh session, while browser helpers coordinate stale form state without pretending to lock autosave. Preview uses the existing page reader and private file descriptor/stream helpers under editorial session authority.

**Tech Stack:** Payload and all @payloadcms packages 3.90.2; Next 16.3.8; React 19.3.0; TypeScript 5.9.3; PostgreSQL; Node 24 (`>=24 <25`) for CMS/checks; existing node:test/tsx and externally provisioned browser harness.

## Global Constraints

- Authority: approved `docs/superpowers/specs/2026-10-19-portal-pages-editorial-experience-design.md`, commit `aad44da`, after reviewed Task 4 `583cba5a22eae9b4ecf6f76bd2f369508c4611be`.
- Payload **3.90.2** public APIs only; retain `versions: { maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } }`.
- Editable native fields are exactly `title`, `slug`, `summary`, `cover`, `coverAlt`, `categories`, `body`; never write the projected DTO into `body`; preserve native row/block IDs; normalize relationships to IDs.
- `_status`, authors, dates, primary ID and Version metadata are server-owned. Publish sets `publishedAt`; unpublish clears it.
- Preserve Owner News controls, parser, scheduling, authority and collections; no changes to `api/`, `cron/`, `public/`, `nginx/`, deploy scripts or public Portal navigation/reader.
- No Docker, database, service or production action while writing this plan. Future disposable integration execution is subject to the existing explicit local Docker authorization already granted for this project; that does not authorize production actions.
- Shared API/cron code remains Node 18 compatible; CMS is the approved Node 24 exception. No new visual library, theme, decorative animation or editor.
- `Cache-Control: private,no-store` and `X-Content-Type-Options: nosniff` on editorial responses, including errors/assets.
- Lock order: `CMS_REFERENCE_LOCK` (`7194030`, existing `SET LOCAL lock_timeout = '5s'`) → page row `FOR UPDATE` → reference validation in the same transaction. Upload service retains `CMS_REFERENCE_LOCK` → per-upload transactional advisory → filesystem ownership; browser must not change that protocol.
- Existing public reader contract remains `GET /api/contents/preview/:pageId?version=<uuid>`, five-minute Firebase media session, `portal-pages-preview` page/revision/asset scoping and current cookie paths/TTL. Editorial preview never exchanges its cookie for Firebase identity.

---

## File map and single-responsibility boundaries (before task execution)

Read `README.md`, `docs/product/brief.md`, `docs/architecture/portal-pages-content.md`, `cms/README.md` and the approved specification first. Paths below are exact; new exports are defined in the task interface blocks. Each task is one independently reviewable commit; checkbox steps are short test/edit/check actions inside that gate.

| Task | File | Responsibility |
| --- | --- | --- |
| 1 create | `cms/src/portal-pages/editorial-contracts.ts` | Browser-safe wire types, limits and sanitized error contracts |
| 1 create | `cms/src/portal-pages/editorial-native.ts` | Native seven-field extraction, strict native validation/canonicalization and shared editable hash |
| 1 create | `cms/src/portal-pages/editorial-auth.ts` | Shared page-local verified editorial actor and GET cross-site checks |
| 1 create | `cms/src/portal-pages/editorial-service.ts` | Revision query, explicit save and snapshot-based publication orchestration |
| 1 create | `cms/src/portal-pages/editorial-confirmation.ts` | Fresh-session verification of exact persisted mutation receipt |
| 1 create | `cms/src/endpoints/portal-page-editorial.ts` | Incremental JSON ingress, HTTP errors and endpoint registration |
| 1 modify | `cms/src/endpoints/portal-page-uploads.ts` | Reuse extracted actor check, preserving its current behavior |
| 1 modify | `cms/src/portal-pages/persistence.ts` | Deterministic latest query that detects duplicate latest rows; retain CAS scope |
| 1 modify | `cms/src/payload.config.ts` | Register editorial endpoints alongside existing endpoints |
| 1 create | `cms/tests/fixtures/portal-page-editorial.ts` | Synthetic native pages, actor/request and transaction-aware fake Payload fixture |
| 1 create | `cms/tests/unit/portal-page-editorial-native.test.ts` | Native normalization/hash/body-shape tests |
| 1 create | `cms/tests/unit/portal-page-editorial-service.test.ts` | Transaction, save, CAS and receipt behavior tests |
| 1 create | `cms/tests/unit/portal-page-editorial-http.test.ts` | Auth, CSRF, limits and sanitized responses |
| 2 create | `cms/src/admin/portal-pages/editorial-state.ts` | Pure admission/generation helpers and typed same-origin requests |
| 2 create | `cms/src/admin/portal-pages/PortalPageEditorialControls.tsx` | Native form coordination, explicit save and confirmation UI |
| 2 create | `cms/src/admin/portal-pages/EmptyPortalPageControl.tsx` | Empty public slot component, PortalPages only |
| 2 create | `cms/tests/unit/portal-page-editorial-state.test.ts` | Deferred-response, admission, hash and CAS client tests |
| 2 create | `cms/tests/integration/portal-page-editorial-controls.mjs` | Real browser control/action assertions, exported for Task 4 runner |
| 3 create | `cms/src/admin/portal-pages/upload-client.ts` | Sequential protocol, closed MIME allowlist, retry/cancel and response validation |
| 3 create | `cms/src/admin/portal-pages/PortalPageUploadPanel.tsx` | Accessible field-local upload UI and lifecycle |
| 3 create | `cms/src/admin/portal-pages/PortalPageMediaField.tsx` | Public RelationshipField wrapper, destination identity and explicit selection |
| 3 create | `cms/tests/unit/portal-page-upload-client.test.ts` | Blob slicing, protocol, retry and token lifecycle tests |
| 3 create | `cms/tests/unit/portal-page-media-field.test.ts` | Pure destination/revalidation selection admission tests |
| 3 create | `cms/tests/integration/portal-page-editorial-upload.mjs` | Real browser assertions for all five field destinations |
| 4 create | `cms/src/portal-pages/editorial-preview.ts` | Authenticated exact preview model and authenticated asset lifecycle |
| 4 create | `cms/src/app/(payload)/editorial/portal-pages/preview/[pageId]/page.tsx` | Dynamic server-rendered editorial-only preview route |
| 4 create | `cms/src/admin/portal-pages/PortalPagePreview.tsx` | Safe normalized DTO renderer, no native document or storage metadata |
| 4 create | `cms/src/admin/portal-pages/portal-page-preview.scss` | Scoped layout widths/media overflow and native-compatible focus/reduced motion |
| 4 modify | `cms/src/endpoints/portal-page-editorial.ts` | Register authenticated preview asset GET |
| 4 modify | `cms/src/collections/PortalPages.ts` | Control slots and cover wrapper only; retain access/hooks/Versions |
| 4 modify | `cms/src/portal-pages/native-blocks.ts` | Wrapper on image/gallery/video/pdf asset relationships only |
| 4 generate | `cms/src/app/(payload)/editorial/admin/importMap.js` | Generated component registration preserving current entries |
| 4 generate if changed | `cms/src/payload-types.ts` | Types from unchanged native schema plus any inferred config metadata |
| 4 create | `cms/tests/unit/portal-page-editorial-preview.test.ts` | Exact version/assets, stream ownership and safe rendered output |
| 4 create | `cms/tests/unit/portal-page-editorial-config.test.ts` | Slots, all destinations and unaffected News configuration |
| 4 create | `cms/tests/unit/portal-page-editorial-integration-guard.test.ts` | Disposable runner refusal and check-only behavior |
| 4 create | `cms/tests/integration/portal-page-editorial-native.ts` | Real Payload/PostgreSQL saves/CAS/commit evidence |
| 4 create | `cms/tests/integration/portal-page-editorial-browser.mjs` | Compose control/upload/preview keyboard browser cases |
| 4 create | `cms/tests/integration/run-portal-page-editorial.mjs` | Guarded dedicated runner; separate from unfinished general acceptance |
| 4 modify | `cms/package.json` | Dedicated `test:portal-pages:integration` command only |
| 4 modify | `README.md`, `cms/README.md`, `docs/architecture/portal-pages-content.md` | Actual commands, workflow semantics, boundaries and evidence status |
| 4 create | `docs/operations/portal-pages-editorial.md` | Editor instructions, reconciliation and upload limits |
| 4 create | `docs/reviews/2026-10-19-portal-pages-editorial-acceptance.md` | Named automated/manual evidence with PASS/FAIL/NOT_EXECUTED distinctions |

No schema change is planned. Existing migrations and page hooks remain authoritative. Do not fix unrelated News/integration infrastructure as part of this plan.

## Shared wire contract (owned by Task 1; consumed unchanged by Tasks 2–4)

In `editorial-contracts.ts`, use these exact shapes (UUID/hash/ISO validation happens at runtime; branded strings are unnecessary):

```ts
import type { PortalPagePublicationInput, PortalPageRevisionStatus } from './contracts'
import type { PortalPage } from '../payload-types'

export type NativeEditable = {
  title: string
  slug: string
  summary: string
  cover: string | null
  coverAlt: string | null
  categories: string[]
  body: NonNullable<PortalPage['body']>
}
export type SaveInput =
  | { id: string; expected_latest_version_id: string; expected_snapshot_hash: string }
  | { id: null; data: NativeEditable }
export type RevisionResult = {
  id: string
  document_status: PortalPageRevisionStatus
  latest: null | {
    version_id: string; autosave: boolean; saved_at: string
    snapshot_hash: string; editable_hash: string
  }
  explicit: null | { version_id: string; saved_at: string; is_latest: boolean }
}
export type SaveResult = {
  id: string; version_id: string; saved_at: string
  editable_hash: string; document_status: PortalPageRevisionStatus
}
export type PublicationResult = {
  id: string; operation: PortalPagePublicationInput['operation']
  source_version_id: string; resulting_version_id: string
  document_status: PortalPageRevisionStatus; published_at: string | null
}
export type EditorialErrorBody = {
  error: string; message: string; fields?: Array<{ path: string; message: string }>
}
export const EDITORIAL_BASE = '/editorial/api/portal-page-editorial'
export const EXISTING_JSON_BYTES = 16 * 1024
export const CREATE_JSON_BYTES = 8 * 1024 * 1024
export const PROJECTED_CONTENT_BYTES = 5 * 1024 * 1024
export const EDITORIAL_HEADERS = {
  'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff',
}
```

`body` remains the generated native union (including `blockType`, optional native IDs and Lexical content), not `PortalPageBlock[]`. Browser helpers importing these types must use type-only imports for generated/server types.

### Task 1: Native snapshot/save/publication backend and post-commit confirmation

**Files:** All Task 1 entries in the file map. Modify `persistence.ts` at `latestPortalPageVersion`/`withExpectedPortalPageVersion`, uploads at `currentEditorUID`, and config at imports/endpoints. No collection hook bypass or Version SQL writes.

**Interfaces:**
- Consumes existing `withCmsTransaction<T>(payload, incoming, work): Promise<T>`, `requireCmsTransaction(payload, req)`, `withExpectedPortalPageVersion<T>(req, input: PortalPagePublicationInput, work): Promise<T>`, `validatePortalPagePublicationInput`, `projectPortalPageContent`, category/media reference validators, `assertEditorialOrigin`, `readPortalPublicURL`, `parseAdminActor`, `canManagePortalPages`.
- Produces shared wire types above; `extractNativeEditable(raw: unknown): NativeEditable` (select seven fields from trusted form/version), `validateNativeEditable(raw: unknown): NativeEditable` (strict ingress keys), `canonicalNativeEditable(raw: unknown): string`, `editableHash(raw: unknown): Promise<string>` (Web Crypto SHA-256, shared browser/server).
- Produces `requirePortalPageEditor(req: PayloadRequest): PortalPageReadActor`, `assertEditorialReadHeaders(headers: Headers): void` and `portalPageEditorialEndpoints: Endpoint[]`.
- Produces `readEditorialRevision(req: PayloadRequest, id: string): Promise<RevisionResult>`, `saveEditorialVersion(req: PayloadRequest, input: SaveInput): Promise<SaveResult>`, `transitionEditorialPublication(req: PayloadRequest, input: PortalPagePublicationInput): Promise<PublicationResult>`.
- Produces server-only `snapshotHash(record: Record<string, unknown>): Promise<string>` and `confirmEditorialMutation(req: PayloadRequest, receipt: MutationReceipt): Promise<void>`; `MutationReceipt = { id: string; versionID: string; editableHash: string; status: 'draft' | 'published'; publishedAt: string | null; createdBy: string; updatedBy: string; savedAt: string }` records exact resulting Version metadata inside the write transaction. Never expose authors in the HTTP receipt.
- Fixture produces `pageID = '11111111-1111-4111-8111-111111111111'`, `versionID = '22222222-2222-4222-8222-222222222222'`, `nativePage = { title: 'Guia', slug: 'guia', summary: '', cover: null, coverAlt: null, categories: [], body: [] }`; `editorialFixture(): { req: PayloadRequest; calls: Array<{ operation: string; transactionID: unknown; args: unknown }>; seedLatest(record: Record<string, unknown>): void; loseCommit(): void; addVersionAfterCommit(): void }`. Fake session commit copies staged state to committed state; `loseCommit` resolves commit without copying, matching the adapter failure risk. Native acceptance later replaces this fake with PostgreSQL.

- [ ] **Step 1: Write failing native contract/hash tests.**

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractNativeEditable, validateNativeEditable, editableHash } from '../../src/portal-pages/editorial-native'
import { nativePage, pageID } from '../fixtures/portal-page-editorial'

test('strict browser ingress rejects ownership keys; trusted extraction strips them', () => {
  assert.throws(() => validateNativeEditable({ ...nativePage, _status: 'published' }))
  assert.deepEqual(extractNativeEditable({ ...nativePage, id: pageID, _status: 'published' }), nativePage)
})
test('editable hash ignores key order and populated relationship shape, not array order', async () => {
  const a = { ...nativePage, categories: [pageID] }
  assert.equal(await editableHash(a), await editableHash({ ...nativePage, categories: [{ id: pageID }] }))
  assert.notEqual(await editableHash(nativePage), await editableHash({ ...nativePage, title: 'Outro guia' }))
})
```

Add data-driven cases for all ten native blocks, native row IDs, gallery order, null/absent optionals, empty lists, unsupported block/field, invalid Lexical schema, extra server fields, and 5 MiB projected content overflow. Required title/slug must not silently default. Normalize missing summary to `''`, cover/coverAlt to `null`, categories/body to `[]`; optional native caption/title text absent/null/empty to absent, layout absent/null/empty to absent, heading level to native string with default `'2'`, callout tone `'info'`, link `newTab: false`/style `'primary'`. Preserve real native IDs and `blockName`; do not synthesize IDs during hashing. Strictly allow each block's fields from `native-blocks.ts`, plus native `id`/`blockName`; gallery items allow `id,asset,alt,caption`. Validate projection, but retain native content for writes.

- [ ] **Step 2: Run native tests red.** From `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-native.test.ts`. Expected FAIL: new modules/exports absent. Create the fixture and contract file, then implement the pure normalizer until assertions pass; failures after imports resolve must be behavioral assertions, not syntax errors.

- [ ] **Step 3: Implement shared canonicalization and request schemas.**

```ts
// editorial-native.ts: recursive key ordering; array order is significant.
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, stable(item)]),
  )
  return value
}
export function canonicalNativeEditable(raw: unknown): string {
  return JSON.stringify(stable(extractNativeEditable(raw)))
}
export async function editableHash(raw: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNativeEditable(raw))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
}
```

Implement strict validation with the page-local primitives and block allowlists before canonicalization. `snapshotHash` uses the same stable serialization algorithm on `{parent, id, autosave, updatedAt, editable: extractNativeEditable(record.version)}`; normalize parent relation to UUID and updatedAt to ISO, reject malformed metadata, never include `latest`. No browser/server drift through two independent normalizers.

- [ ] **Step 4: Write failing service tests with the transaction-aware fixture.**

```ts
test('same UUID mutated autosave cannot be promoted using stale hash', async () => {
  const f = editorialFixture()
  f.seedLatest({ id: versionID, parent: pageID, latest: true, autosave: true,
    updatedAt: '2026-10-19T10:00:00.000Z', version: nativePage })
  const before = await readEditorialRevision(f.req, pageID)
  f.seedLatest({ id: versionID, parent: pageID, latest: true, autosave: true,
    updatedAt: '2026-10-19T10:00:01.000Z', version: { ...nativePage, title: 'Remoto' } })
  await assert.rejects(saveEditorialVersion(f.req, { id: pageID,
    expected_latest_version_id: versionID, expected_snapshot_hash: before.latest!.snapshot_hash }),
    { status: 409 })
})
test('resolved commit without persisted version returns unavailable', async () => {
  const f = editorialFixture()
  f.loseCommit()
  await assert.rejects(saveEditorialVersion(f.req, { id: null, data: nativePage }), { status: 503 })
})
```

Add cases asserting: revision GET performs zero writes; main status differs from latest draft status; duplicate latest is 503; deterministic `updatedAt DESC,id DESC`; explicit older version only informational; save writes seven native fields and creates a different non-autosave UUID even for identical content; publication source differs from current draft/main and all empty/null fields are copied; wrong parent rejected; latest autosave defeats older explicit CAS; unpublish uses draft:false/autosave:false, never `unpublishAllLocales`; already draft → 409 `portal_page_not_published`; republish returns a new Version/date; failed transaction returns no receipt; fresh confirmation reads a different session; later legitimate Version does not invalidate persisted receipt; mismatched authors/status/date/content/parent/autosave causes 503. Assert lock statements/order and same transactionID on validation, update and resulting Version read. Test direct REST `_status` and restore guards via existing collection hook tests without widening their capability scope.

- [ ] **Step 5: Run service tests red.** From `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-service.test.ts`. Expected FAIL: absent service/confirmation implementations, then receipt/CAS assertions. Do not weaken the test to accept document IDs as Version IDs.

- [ ] **Step 6: Implement revision and save in short transactional units.**

Pseudocode, with all writes through public Local API:

```text
readEditorialRevision(req,id): validate UUID and actor; withCmsTransaction
  lock portal_pages id FOR UPDATE; load principal draft:false or 404
  findVersions parent=id/latest=true, limit=2, sort=['-updatedAt','-id']
  >1 latest => 503; separately find non-autosave parent=id limit=1 same sort
  return principal status; latest snapshot+editable hashes; explicit.is_latest by identity

save existing: validate exact keys/id/version/hash; own a fresh top-level transaction
  CMS lock -> page row lock; reread unique latest; compare UUID AND snapshot hash
  mismatch => 409 portal_page_version_conflict
  native = extractNativeEditable(latest.version)
  payload.update({collection:'portal-pages',id,data:{...native,_status:'draft'},
    req:transactionReq,draft:true,autosave:false,overrideAccess:false,depth:0})
  query unique new latest in SAME transaction; require new UUID, correct parent,
    autosave:false, expected canonical content; construct MutationReceipt
save create: validate exact {id:null,data}; same transactional discipline
  payload.create({collection:'portal-pages',data:{...native,_status:'draft'},
    req:transactionReq,draft:true,autosave:false,overrideAccess:false,depth:0})
  use returned DOCUMENT id to query first Version; verify metadata and receipt
after write transaction completes: confirmEditorialMutation with transactionID removed
  only then return 201 {id,version_id,saved_at,editable_hash,document_status}
```

Ensure the endpoint owns transaction completion (do not join an unknown inherited transaction and return before it commits); clone incoming request with `transactionID: undefined` before top-level service mutation, retaining user/context. Nested hooks/helpers share its transaction request. For creation validate hooks actually run; do not manufacture authors or insert a Version manually if behavior fails. For existing save return principal status captured under lock, not the draft snapshot's status.

- [ ] **Step 7: Implement publication and receipt verification.**

```ts
// Inside withExpectedPortalPageVersion's callback, after checking main state:
const native = extractNativeEditable(versionRecord.version)
const result = await transactionReq.payload.update({
  collection: 'portal-pages', id: input.id, req: transactionReq,
  data: { ...native, _status: input.operation === 'publish' ? 'published' : 'draft' },
  draft: false, autosave: false, overrideAccess: false, depth: 0,
})
```

Validate parent before extraction; project body and validate category/media references by role, requiring complete media for publish. Preserve canonical slug via existing hooks. Read the resulting Version under the same lock, require new identity and exact expected content and status/date. Save source UUID separately from resulting UUID. Read back main content for publication inside the transaction to verify its projection equals the resulting Version's projection.

In `confirmEditorialMutation`, create `{ ...req, transactionID: undefined, context: { ...req.context } }`; `withCmsTransaction` acquires CMS lock, then page lock; use `findVersionByID({collection:'portal-pages', id:receipt.versionID, req:transactionReq, overrideAccess:true, depth:0})`. Compare parent, canonical content hash, autosave false, `updatedAt`, authors, `_status` and `publishedAt`. Do not require `latest` or current main equality here: a subsequent legitimate transition may already exist. Any absent/ambiguous/mismatched receipt is 503; no automatic mutation retry and no compensating deletion. Return publication 200 with the exact six wire keys, then client rechecks revision.

- [ ] **Step 8: Write failing ingress tests.** Build `PayloadRequest` fixtures with an actual `ReadableStream<Uint8Array>` and real `Headers`; invoke endpoint handlers rather than matching source strings.

```ts
test('existing save cannot use the create envelope budget', async () => {
  const f = editorialFixture()
  const endpoint = portalPageEditorialEndpoints.find(e => e.path.endsWith('/save'))!
  const text = JSON.stringify({ id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: 'a'.repeat(64) }) + ' '.repeat(16 * 1024)
  Object.assign(f.req, { headers: new Headers({ 'content-type': 'application/json',
    origin: 'http://localhost:8080' }), body: new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
    }) })
  const response = await endpoint.handler(f.req)
  assert.equal(response.status, 413)
})
```

Fixture environment uses configured `PORTAL_PUBLIC_URL=http://localhost:8080`. Cases: valid V2 knowledge-only editor succeeds without News permission; unauthenticated/expired → 401; UID/actor mismatch and no manageKnowledge → 403; POST missing/null/foreign Origin and cross-site → 403; authenticated GET without Origin allowed but cross-site forbidden; missing JSON/invalid UTF-8/invalid JSON/extras/mixed variants/expected_version_id in save → 400; UUID another parent → 404 or CAS conflict as appropriate; streaming limit with no Content-Length, lying Content-Length, malformed length, aborted stream; existing save/publication >16384 bytes → 413; create >8388608 bytes → 413; projected body >5242880 bytes → 413. Assert no SQL/path/token/stack reflected in errors, exact response keys, private/no-store/nosniff on every status.

- [ ] **Step 9: Run HTTP tests red and implement the endpoint/auth adapter.** From `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-http.test.ts`. Expected FAIL: missing handlers and authorization/limits. Extract upload actor validation into `editorial-auth.ts`, preserving legacy upload compatibility while new editorial handlers require revalidated V2 knowledge actor and valid UID/expiry. The shared actor result has exactly `{uid,email,name,canManageKnowledge:true}` sourced from authenticated session fields, not body values; reject absent identity data rather than fabricate an email. Session revalidation remains the existing Payload auth strategy, not a browser-provided capability.

Implement POST `assertEditorialOrigin(req.headers, readPortalPublicURL(process.env))`, same-origin JSON; GET rejects `Sec-Fetch-Site: cross-site` without requiring Origin. Register paths `/portal-page-editorial/revision`, `/portal-page-editorial/save`, `/portal-page-editorial/publication`. Revision takes only UUID query `id`, no writes. Reuse `validatePortalPagePublicationInput` unchanged.

Incremental parser signature: `readEditorialJSON(req: PayloadRequest, maxBytes: number): Promise<{ value: unknown; bytes: number }>`; count UTF-8 bytes as stream arrives, cancel/release reader on overflow/abort/parse error. Publication cap is 16384. Save stream cap is 8388608 before parsing, then the existing-document variant also requires actual bytes <=16384; oversized existing Content-Length can be rejected after discriminant parsing, never accepted under create budget. No unbounded `req.json()`. Validate schema after byte accounting; use 400/401/403/404/409/413/503 and `{error,message,fields?}` with explicit Portuguese allowlisted messages. Unknown errors become 503 `portal_page_editorial_unavailable`, not exception text. Preserve 409 `portal_page_version_conflict` and `portal_page_not_published`.

- [ ] **Step 10: Focused green checks and commit.** Run from `cms/`:

```sh
node --import tsx --test tests/unit/portal-page-editorial-native.test.ts tests/unit/portal-page-editorial-service.test.ts tests/unit/portal-page-editorial-http.test.ts tests/unit/portal-page-persistence.test.ts tests/unit/service/portal-page-uploads.test.ts
npm run typecheck
```

Expected PASS. From root:

```sh
git diff --check
git add cms/src/portal-pages/editorial-contracts.ts cms/src/portal-pages/editorial-native.ts cms/src/portal-pages/editorial-auth.ts cms/src/portal-pages/editorial-service.ts cms/src/portal-pages/editorial-confirmation.ts cms/src/endpoints/portal-page-editorial.ts cms/src/endpoints/portal-page-uploads.ts cms/src/portal-pages/persistence.ts cms/src/payload.config.ts cms/tests/fixtures/portal-page-editorial.ts cms/tests/unit/portal-page-editorial-native.test.ts cms/tests/unit/portal-page-editorial-service.test.ts cms/tests/unit/portal-page-editorial-http.test.ts
git commit -m "feat(cms): add confirmed Portal page snapshot and publication endpoints"
```

Review receipt/session evidence before Task 2.

### Task 2: React editorial controls and stale-form/CAS state helpers

**Files:** Task 2 entries in the map. UI registration intentionally belongs to Task 4 so the assembled extension/import map is reviewed together; pure state/request tests make this task independently testable.

**Interfaces:**
- Consumes Task 1 `NativeEditable`, `RevisionResult`, `SaveInput`, `SaveResult`, `PublicationResult`, `EDITORIAL_BASE`, `editableHash`, `extractNativeEditable`; existing Payload public hooks and `PortalPagePublicationInput`.
- Produces `EditorGate = { modified:boolean; processing:boolean; backgroundProcessing:boolean; initializing:boolean; disabled:boolean; locked:boolean; uploading:boolean; otherModalOpen:boolean; busy:boolean }`, `editorialBlocked(gate:EditorGate):boolean`.
- Produces `createRequestGeneration(): { begin(documentID:string): { generation:number; documentID:string; signal:AbortSignal }; invalidate():void; accepts(ticket:{generation:number;documentID:string;signal:AbortSignal}, documentID:string):boolean }`.
- Produces `confirmedVersion(revision:RevisionResult, localHash:string): null | { id:string; versionID:string; savedAt:string }`; exact latest explicit matching editable hash only.
- Produces `fetchRevision(id:string, signal:AbortSignal):Promise<RevisionResult>`, `saveVersion(input:SaveInput, signal:AbortSignal):Promise<SaveResult>`, `changePublication(input:PortalPagePublicationInput, signal:AbortSignal):Promise<PublicationResult>`; validated response bodies, `credentials:'same-origin'`, no POST retry.
- Produces `PortalPageEditorialControls(): React.JSX.Element`, `EmptyPortalPageControl(): null` and browser suite `runEditorialControlCases(page): Promise<Array<{name:string;status:'PASS'|'FAIL';detail:string}>>` (page is the externally supplied Playwright Page).

- [ ] **Step 1: Write red state tests with deferred requests.**

```ts
test('late response cannot activate a preview after invalidation', () => {
  const generation = createRequestGeneration()
  const ticket = generation.begin(pageID)
  generation.invalidate()
  assert.equal(ticket.signal.aborted, true)
  assert.equal(generation.accepts(ticket, pageID), false)
})
test('older explicit version does not authorize CAS', () => {
  const revision: RevisionResult = { id: pageID, document_status: 'published',
    latest: { version_id: versionID, autosave: true, saved_at: '2026-10-19T10:00:00.000Z',
      snapshot_hash: 'a'.repeat(64), editable_hash: 'b'.repeat(64) },
    explicit: { version_id: '33333333-3333-4333-8333-333333333333',
      saved_at: '2026-10-19T09:00:00.000Z', is_latest: false } }
  assert.equal(confirmedVersion(revision, 'b'.repeat(64)), null)
})
```

Add each gate independently, hash mismatch, document switch, field change while hashing/GET/POST awaits, upload/autosave start, unmount, duplicate click mutex, malformed response UUID/status/hash, network/503 loss and 409 field preservation. Inject fetch through node:test mocks and resolve a controlled Promise after invalidation; verify no second POST on 409/503. Save/create body contains exactly permitted fields; existing save never submits content.

- [ ] **Step 2: Run red tests.** From `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-state.test.ts`. Expected FAIL: absent helpers, then stale response admitted before guard implementation.

- [ ] **Step 3: Implement pure state and typed requests.**

```ts
export function editorialBlocked(gate: EditorGate): boolean {
  return Object.values(gate).some(Boolean)
}
export function confirmedVersion(revision: RevisionResult, localHash: string) {
  const { latest, explicit } = revision
  if (!latest || latest.autosave || !explicit?.is_latest ||
      explicit.version_id !== latest.version_id || latest.editable_hash !== localHash) return null
  return { id: revision.id, versionID: latest.version_id, savedAt: latest.saved_at }
}
```

Generation helper owns an AbortController, increments a counter on invalidate/begin, and matches counter+document+unaborted signal. Requests use fixed relative routes, JSON header only on POST, check status and validate keys/types before returning. Stable UI messages: 409 “A página mudou desde a conferência. Seus campos foram preservados. Confira e salve uma nova versão antes de publicar.”; response loss/503 “Não foi possível confirmar a operação. Consulte o estado antes de tentar novamente.” Clear confirmed version and active link; refresh revision but never adopt a new expected ID or repeat POST automatically. Ambiguous creation advises checking the native list/slug before another conscious create.

- [ ] **Step 4: Write browser control regression cases before UI.** In the exported suite use real native form fixtures and intercepted deferred editorial responses, not source-name assertions. First assertion:

```js
await page.getByRole('button', { name: 'Salvar versão', exact: true }).click()
await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor()
const preview = page.getByRole('link', { name: 'Abrir prévia desta versão em nova aba' })
if (await preview.getAttribute('target') !== '_blank') throw new Error('preview_target_invalid')
if (await preview.getAttribute('rel') !== 'noopener noreferrer') throw new Error('preview_rel_invalid')
```

Task 4 runs this suite after registration. Before implementation its first accessible button lookup must fail. Add normal UI actions for create validation/focus, save after autosave, waiting message, confirm title/UUID/time, no native publish duplicate, double click, document switch, delayed GET, delayed save, local field edit, modal/lock gates, 409 unchanged field values, session expiry, and preserved Versions/diff navigation. Use browser request interception only for deterministic error/race injection; happy path later uses the actual endpoint.

- [ ] **Step 5: Implement form coordinator with public hooks.**

```text
subscribe useDocumentInfo/useForm/useFormModified/useFormProcessing/
  useFormBackgroundProcessing/useFormInitializing/useModal/useFormFields
derive document ID + gate; track selective editable field revision, not form.fields
on page/edit/upload/background-start/unmount: invalidate generation, clear confirmation/link
save existing: if modified/backgroundProcessing show waiting message and do not POST
  claim synchronous local mutex; begin generation ticket
  getData -> editableHash -> check generation/gates -> GET revision -> check again
  compare local hash to revision.latest.editable_hash; mismatch requires reconciliation
  setProcessing(true), setDisabled(true); POST exact latest id+snapshot hash
  after await accept only same document/generation and no external form mutation
  requery revision; confirmation only if new explicit remains latest and hash matches
  finally restore prior processing/disabled only if component still owns this UI lease
save new: validateForm(); focus first native invalid field on false, no POST
  extract seven fields, precheck 8 MiB JSON/5 MiB projected content and show limits
  POST {id:null,data}; accepted receipt -> native edit URL /editorial/admin/collections/portal-pages/{id}
preview/publication: safe gate + fresh matching confirmation; recheck before opening modal
  confirm modal displays title/version UUID/savedAt; only explicit confirm POSTs
  on successful transition display receipt status, clear old authorization and GET revision
```

Use a separate operation-owner ref so the component's own processing/disabled changes do not invalidate its request; external background processing/edit/upload still must invalidate. Do not release another document's lease from an old finally. Capture previous flags before setting them and restore on failure/abort/unmount only while owned. Gates include another open modal; do not count the coordinator's own confirmation modal as an unrelated modal. Never call `setModified(false)`, reset native fields, simulate native save clicks or access inputs via DOM. Existing save changes no fields. Native uploadStatus also disables actions.

- [ ] **Step 6: Implement accessible status/confirmation markup.**

```tsx
<button type="button" disabled={blocked} onClick={save}>Salvar versão</button>
<p role="status" aria-live="polite">{message}</p>
{failure && <p role="alert">{failure}</p>}
{confirmed && <a
  href={`/editorial/portal-pages/preview/${confirmed.id}?version=${confirmed.versionID}`}
  target="_blank" rel="noopener noreferrer"
>Abrir prévia desta versão em nova aba</a>}
```

Here `blocked`, `save`, `message`, `failure`, `confirmed` are the component's gate, action, status/error state and `confirmedVersion` result. Use Payload Button and its native Modal/Drawer infrastructure in final markup for existing styling/focus behavior. States: “Aguardando salvamento automático”, “Salvando versão…”, “Versão salva”, “Conferindo versão…”, “Publicando…”, “Página publicada”, “Despublicando…”, “Página despublicada”, conflict, session expired and recoverable error. Waiting explanation is exactly “Aguarde o salvamento automático para salvar uma versão.” Confirmation buttons are “Publicar esta versão”/“Despublicar esta versão”. Preserve native Versions and diffs; no historical restore action.

- [ ] **Step 7: Focused checks and commit.** From `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-state.test.ts tests/unit/portal-page-editorial-native.test.ts`, then `npm run typecheck`; expected PASS. Browser suite is authored but NOT_EXECUTED until Task 4 boots the authorized fixture. From root:

```sh
git diff --check
git add cms/src/admin/portal-pages/editorial-state.ts cms/src/admin/portal-pages/PortalPageEditorialControls.tsx cms/src/admin/portal-pages/EmptyPortalPageControl.tsx cms/tests/unit/portal-page-editorial-state.test.ts cms/tests/integration/portal-page-editorial-controls.mjs
git commit -m "feat(cms): coordinate Portal page explicit saves and CAS controls"
```

### Task 3: Relationship-field upload wrapper/client with all five media destinations

**Files:** Task 3 entries in file map; field registration is Task 4. Reuse existing server ingress untouched apart from Task 1 auth extraction.

**Interfaces:**
- Consumes `/editorial/api/portal-page-uploads`, authenticated collection GET `/editorial/api/portal-page-media/<id>?depth=0`, public `RelationshipField`, `useField({path})`, `useDocumentInfo().setUploadStatus`, field props and native array/block IDs.
- Produces `MediaKind = 'image'|'video'|'pdf'`, `CompleteMedia = {id:string;state:'complete';mimeType:string;bytes:number;sha256:string;completedAt:string}`, `UploadProgress = {phase:'preparing'|'uploading'|'validating'|'ready'|'cancelling'|'cancelled'|'error';confirmedBytes:number;totalBytes:number;index:number;count:number}`.
- Produces `validateUploadFile(file: Pick<File,'name'|'type'|'size'>, kind:MediaKind): {mimeType:string;bytes:number}`, `createUploadClient(options:{fetch:typeof fetch;sleep:(ms:number,signal:AbortSignal)=>Promise<void>;random:()=>number;onProgress:(progress:UploadProgress)=>void}): {start(file:File,kind:MediaKind):Promise<CompleteMedia>;retry():Promise<CompleteMedia>;cancel():Promise<'cancelled'|'complete'|'pending'>;dispose():void}`, `readCompleteMedia(id:string,kind:MediaKind,signal:AbortSignal):Promise<CompleteMedia>`.
- Produces `Destination = {documentID:string;path:string;blockID:string|null;galleryItemID:string|null;generation:number}`, `sameDestination(a:Destination,b:Destination):boolean` in `upload-client.ts`; path OR ancestor-ID change invalidates destination. Cover has null ancestors. Missing required row ID is not a safe selectable target until the native form assigns one.
- Produces `PortalPageMediaField(props:RelationshipFieldClientProps & {kind:MediaKind}):React.JSX.Element`, `PortalPageUploadPanel(props:{kind:MediaKind;onComplete:(media:CompleteMedia)=>void;onClose:()=>void}):React.JSX.Element`. Import `RelationshipFieldClientProps` from Payload's public types, never an internal UI module; wrapper receives MIME kind through configured client props and preserves the original MIME filter. Panel reports completed upload; wrapper performs collection re-read and explicit selection.
- Produces `runEditorialUploadCases(page):Promise<Array<{name:string;status:'PASS'|'FAIL';detail:string}>>`, consumed by Task 4 browser suite.

- [ ] **Step 1: Write failing file and protocol tests.**

```ts
test('closed extension fallback never accepts generic MIME', () => {
  assert.deepEqual(validateUploadFile({ name:'Foto.JPG', type:'', size:1 }, 'image'),
    { mimeType:'image/jpeg', bytes:1 })
  assert.throws(() => validateUploadFile({ name:'foto.jpg', type:'application/octet-stream', size:1 }, 'image'))
  assert.throws(() => validateUploadFile({ name:'video.mov', type:'video/quicktime', size:1 }, 'video'))
})
```

Use fake File with size/name/type and instrumented `slice(start,end)` returning a real <=5 MiB Blob; never allocate a 500 MiB fixture. Mock fetch records method/path/headers and increments active requests until each controlled response resolves. Assert 500 MiB → 100 sequential slices of 5242880 bytes; partial last slice; no whole-file reads/forbidden Content-Length/FormData. Test init UUID/token/chunkSize/count/bytes/MIME mismatch, chunk ID/index/received validation, duplicate acknowledgement, confirmed-byte progress, complete validation, post-complete collection state/MIME mismatch, every terminal status, retry boundaries, and missing token after dispose.

- [ ] **Step 2: Run red protocol tests.** From `cms/`: `node --import tsx --test tests/unit/portal-page-upload-client.test.ts tests/unit/portal-page-media-field.test.ts`. Expected FAIL: module/exports absent, then protocol/concurrency assertions.

- [ ] **Step 3: Implement exact sequential protocol and validators.**

Allowlist and visible `accept` table:

| Kind | Extension → MIME | Max bytes |
| --- | --- | --- |
| image | `.jpg,.jpeg` → `image/jpeg`; `.png` → `image/png`; `.webp` → `image/webp` | 15728640 (15 MiB) |
| pdf | `.pdf` → `application/pdf` | 104857600 (100 MiB) |
| video | `.mp4` → `video/mp4`; `.webm` → `video/webm` | 524288000 (500 MiB) |

Reject zero bytes, incompatible extensions and declared MIME; infer only when File.type is empty. No MOV, SVG, GIF, HTML or generic MIME fallback. Cover/image/gallery are image kind; video and pdf cannot cross-select.

```text
POST /init {originalName:file.name,mimeType,bytes:file.size}, credentials same-origin
  validate 201 {id,token,chunkSize,chunkCount,bytes,mimeType}
  UUID strict; token matches /^[A-Za-z0-9_-]{43}$/ (32-byte base64url token)
  chunkSize===5242880; chunkCount===ceil(bytes/5242880); exact expected bytes/MIME
for index=0..chunkCount-1 (await every request):
  slice = file.slice(index*5242880,min(bytes,(index+1)*5242880))
  PUT /<id>/chunks/<index>, application/octet-stream,
    x-portal-page-upload-token: token, body:slice; do not set Content-Length
  validate {id,index,received:true,duplicate,...sha256}; advance confirmedBytes once
  duplicate=true permits omitted sha256; duplicate=false requires sha256
POST /<id>/complete {token}; keep separate 'Validando arquivo…' state
  validate {id,state:'complete',mimeType,bytes,sha256,completedAt}
  clear File/token references on success; return CompleteMedia
cancel: abort in-flight -> DELETE /<id> {token} using a NEW AbortController
  validate {id,cancelled:true}; clear refs only after acknowledged cancellation
  media_already_complete => collection read, report complete, never delete by another API
  exhausted transient cancellation => pending, never display 'Envio cancelado'
```

Validate present chunk sha256 and required complete sha256 as 64 hex characters, ISO date and exact init identity/size/MIME on complete. The chunk response's optional hash is the existing conditional spread, not an extra nested property: a duplicate acknowledgement is `{id,index,received:true,duplicate:true}`; a new chunk is `{id,index,received:true,duplicate:false,sha256}`. Existing collection records use `filesize`, not `bytes`: `readCompleteMedia` maps `filesize` into `CompleteMedia.bytes` after validating ID, complete state, MIME, hash and date. Keep tokens private to closure/ref, never return them to status callbacks or errors. Do not log raw errors/responses.

- [ ] **Step 4: Implement bounded retries and cancellation lifecycle.**

```ts
const RETRY_DELAYS = [1000, 2000, 4000] as const
// Each request: initial attempt plus at most three new attempts.
// Inject sleep/random for deterministic tests; jitter = floor(random()*100).
```

Chunk and complete retry only network error, `upload_busy`, HTTP 429 or transient 503; same ID/token, same chunk index and same Blob bytes. Cancel retries only busy/network, same three delays; other errors become visible pending/error. No retry for `chunk_conflict`, invalid token, 400, 401/403, 404, 413/415 or 507. Init is never retried automatically on lost response; report possible pending reservation and require conscious new initiation subject to quotas. Manual retry keeps token and last unacknowledged index while mounted; no invented status/resume route and no reload promise. Abort is not itself a network error eligible for retry. Retry delay is abortable. Explain `upload_limit_reached`: two active uploads per editor/eight globally.

Add beforeunload only while active, remove on settle. Close/Escape active Drawer asks “Cancelar envio?”; cancel before closing when possible. `dispose()` aborts, attempts authenticated DELETE best-effort while token exists, then clears references; never use sendBeacon. Crash/suspension cleanup is server durable queue and 24h expiry/reconciliation, not guaranteed unload execution.

- [ ] **Step 5: Write destination selection tests and browser cases.**

```ts
test('reordering a gallery invalidates the original destination even if index is reused', () => {
  const start: Destination = { documentID:pageID, path:'body.0.images.0.asset',
    blockID:'gallery-a', galleryItemID:'row-a', generation:1 }
  assert.equal(sameDestination(start, { ...start, galleryItemID:'row-b' }), false)
  assert.equal(sameDestination(start, { ...start, path:'body.0.images.1.asset' }), false)
})
```

Browser suite iterates exactly cover, image.asset, gallery.images[0].asset, video.asset, pdf.asset using native labeled inputs. For each: choose valid file, verify no relationship value changes at 100% chunks, complete, collection GET, click “Usar este arquivo”, assert native field value is returned ID. Also remove/reorder row or change document mid-upload and assert no selection; close without selecting leaves field unchanged; wrong-MIME/failed read keeps selection disabled; remount only selector preserves value/focus; native alt/title remain required and unchanged. Observe uploaded relationship selection invalidates Task 2 confirmation. This browser suite remains NOT_EXECUTED until Task 4 runner; pure destination tests run now.

- [ ] **Step 6: Implement public wrapper and upload panel.**

```tsx
const { value, setValue } = useField<string | null>({ path })
// Forward original props, filterOptions, validation and path unchanged.
<RelationshipField {...props} key={selectorRefresh} />
<button type="button" disabled={!ready || !destinationStillMatches}
  onClick={() => { if (ready && destinationStillMatches) setValue(ready.id) }}>
  Usar este arquivo
</button>
```

`ready: CompleteMedia|null` is set only after complete plus authenticated re-read; `selectorRefresh` is a local numeric counter; `destinationStillMatches` compares captured and currently observed native path/ancestor IDs/generation. Observe ancestors via selective `useFormFields`, never DOM paths or `form.fields`. Capture identities at upload start and invalidate permanently on any removal/reorder/path change, even if later moved back. Remount only `RelationshipField` after validated refresh, not its wrapper/useField or entire form. Refresh/selection are separate: “Usar este arquivo” alone sets the value. Preserve `allowCreate:false,allowEdit:false`, labels and existing filtering; no REST/GraphQL media create/edit.

Use document `uploadStatus` to block a second panel while active and mark own lifecycle through `setUploadStatus('uploading'|'idle'|'failed')`; maintain a synchronous document-scoped mutex for two same-tick starts before the status rerender, scoped by document identity and cleaned on unmount. Do not clear another panel's status. One active upload per panel. Selecting does not auto-fill alt/title with filename. Gallery stays native ordered 2–20 items.

Panel has labeled file input and format/size instructions linked by aria-describedby; progress max=totalBytes/value=confirmedBytes, role=status aria-live=polite, final error role=alert. Example “Enviando bloco 3 de 20 — 10 MiB de 100 MiB”; never claim fetch network progress. States are “Escolha um arquivo”, “Preparando envio…”, “Enviando…”, “Validando arquivo…”, “Arquivo pronto para selecionar”, “Cancelando…”, “Envio cancelado”, error. Native Drawer trap/return focus, keyboard input, visible focus and disabled explanations; no per-chunk focus movement, one announcement per chunk or percentage milestone.

- [ ] **Step 7: Focused green checks and commit.** From `cms/`: `node --import tsx --test tests/unit/portal-page-upload-client.test.ts tests/unit/portal-page-media-field.test.ts tests/unit/portal-page-editorial-state.test.ts`, then `npm run typecheck`. Expected PASS; browser acceptance remains pending. From root:

```sh
git diff --check
git add cms/src/admin/portal-pages/upload-client.ts cms/src/admin/portal-pages/PortalPageUploadPanel.tsx cms/src/admin/portal-pages/PortalPageMediaField.tsx cms/tests/unit/portal-page-upload-client.test.ts cms/tests/unit/portal-page-media-field.test.ts cms/tests/integration/portal-page-editorial-upload.mjs
git commit -m "feat(cms): add field-local sequential Portal page media uploads"
```

### Task 4: Exact CMS editorial preview, assets, Payload integration and acceptance

**Files:** All Task 4 entries in the map. Only generated import map/types may change outside explicitly named source/tests/docs files; preserve existing entries.

**Interfaces:**
- Consumes Task 1 `requirePortalPageEditor`, `assertEditorialReadHeaders`, `EDITORIAL_HEADERS`; existing `queryPortalPagePreview(req,pageID,versionID,actor):Promise<PortalPageDTO|null>`, `resolvePreviewPortalPageForAsset(req,pageID,versionID,actor):Promise<PortalPageReadResult|null>`, `openPortalPageMedia({uploadDir,media,range,signal})`; Tasks 2/3 component exports and browser suites.
- Produces `loadEditorialPreview(req:PayloadRequest,pageID:string,versionID:string):Promise<{dto:PortalPageDTO;savedAt:string}>`, `readEditorialPreviewAsset(req:PayloadRequest):Promise<Response>`, `PortalPagePreview(props:{dto:PortalPageDTO;savedAt:string}):React.JSX.Element`, and authenticated dynamic page route.
- Runner produces JSON evidence `{runId:string,status:'PASS'|'FAIL'|'NOT_EXECUTED',cases:Array<{name:string,status:'PASS'|'FAIL'|'NOT_EXECUTED',detail:string}>}` with sanitized details and no credentials. `--check-config` never connects or claims acceptance; `--execute` requires existing disposable guard configuration and explicit opt-in.
- Browser fixture handoff is exactly `PAYLOAD_TEST_EVIDENCE_DIR/portal-page-editorial-browser.json` with `{runId:string,baseURL:string,playwrightModule:string,storageStateFile:string}`. Validate runId against the guarded config, loopback-only baseURL, absolute module path and private storageStateFile under the same private evidence directory; session storage state is a private fixture credential and must never enter JSON reports or Git. Native runner prepares synthetic page/category/media fixtures and writes the handoff only for its own authorized local CMS fixture; browser entrypoint imports playwrightModule and creates a context with that private storage state. Expired/absent state is a failed or NOT_EXECUTED session setup, never a reason to weaken production auth.

- [ ] **Step 1: Write red exact-preview/asset tests.**

```ts
test('missing version is not replaced with published content', async () => {
  const f = editorialFixture()
  await assert.rejects(loadEditorialPreview(f.req, pageID, ''), { status: 400 })
  assert.equal(f.calls.some(call => call.operation === 'update'), false)
})
```

Add exact parent/version checks, unknown Version → 404, old preview remains old after publish, missing manageKnowledge/session expiry/cross-site forbidden, completed-but-unreferenced asset → 404, role MIME mismatch, strict three UUIDs, ranges 206/open/suffix/416, image full response, backpressure and cancellation. Inject open failure and transaction failure after open; verify descriptor/stream cancellation on failure before handoff. A new asset GET after revoked permission returns no bytes. Do not assert already transmitted bytes can be revoked retroactively.

Use `react-dom/server` renderToStaticMarkup to exercise every DTO block/inline variant, escaped text, links/new tabs, no raw HTML and no path/token/storageKey; TypeScript exhaustiveness check on block switch. These are renderer tests, not proof of interactive accessibility.

- [ ] **Step 2: Run red preview tests.** From `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-preview.test.ts`. Expected FAIL: absent model/renderer/endpoint and then exact-version behavior assertions.

- [ ] **Step 3: Implement authenticated preview and asset service.**

```text
loadEditorialPreview:
  assertEditorialReadHeaders; requirePortalPageEditor; strict page and version UUIDs
  withCmsTransaction: queryPortalPagePreview exact UUID + read same Version savedAt
  verify parent; not found -> error, never current publication/slug fallback
  return normalized DTO + savedAt only
asset GET /portal-page-editorial/preview-assets/:pageId/:versionId/:assetId:
  require current editor on every GET, strict UUIDs, reject cross-site
  fresh request without inherited transactionID; withCmsTransaction:
    resolvePreviewPortalPageForAsset -> media.get(assetId) or 404
    openPortalPageMedia({uploadDir,media,range:req.headers.get('range'),signal:req.signal})
  finish transaction before Response body handoff; cancel opened body in finally on failure
  return existing stream status/headers plus private,no-store/nosniff
```

Re-use existing safe file descriptors, 64 KiB backpressure, request cancellation and single Range handling for PDF/video; never duplicate storage or expose storageKey. Browser assets use HttpOnly editorial session, not media-session or Firebase exchange. Error bodies use Task 1 sanitizer and do not leak underlying fs errors.

Server page authenticates via public `getPayload`, `payload.auth({headers:await headers()})` and `createLocalReq` with the authenticated user and request headers; existing auth strategy performs V2 session revalidation. Mark dynamic/no-store, validate `params.pageId` and single `searchParams.version` (reject arrays/missing UUID); call model directly, not internal browser-forbidden POSTs. Render “Prévia editorial”, UUID, saved time and “Esta prévia não publica a página”; show reauthentication/error state without fallback. Route metadata and response caching must remain private; cover this against the running Next fixture, not merely by checking source exports.

- [ ] **Step 4: Implement normalized DTO renderer.**

```ts
function assetURL(dto: PortalPageDTO, assetID: string): string {
  return `/editorial/api/portal-page-editorial/preview-assets/${dto.id}/${dto.revision.id}/${assetID}`
}
function unreachable(value: never): never { throw new Error('invalid_preview_block') }
```

Render heading with validated level; rich text paragraph/heading/list and inline text/break/link with bold/italic/underline/code semantic elements; image figure/img/figcaption; gallery ordered figures with meaningful alt; video controls/title/preload=metadata; PDF titled private link/object with fallback link; embed only validated YouTube/Vimeo URL and accessible title (no arbitrary HTML); callout labeled aside; link with new_tab rel protection/style; divider hr. Use exhaustive `PortalPageBlock` switch and `unreachable` default. Cover uses same exact assetURL and alt. Native layout content/wide/full/left/right maps to scoped CSS classes, with responsive overflow constraints. No public Portal shell/navigation. Keep gallery preview keyboard usable without requiring the future public reader's lightbox implementation.

- [ ] **Step 5: Write red integration/config assertions and register extensions.**

```ts
test('PortalPages retains native autosave with dedicated public controls', () => {
  assert.deepEqual(PortalPages.versions, {
    maxPerDoc:0, drafts:{autosave:{interval:2000},schedulePublish:false},
  })
  assert.deepEqual(PortalPages.admin?.components?.edit?.beforeDocumentControls,
    ['/admin/portal-pages/PortalPageEditorialControls#PortalPageEditorialControls'])
})
```

Assert PublishButton/UnpublishButton/PreviewButton slots resolve to `/admin/portal-pages/EmptyPortalPageControl#EmptyPortalPageControl`, no SaveDraftButton workaround, cover and all four block locations use `/admin/portal-pages/PortalPageMediaField#PortalPageMediaField`; `allowCreate:false`, `allowEdit:false`, filters and 2–20 gallery limits preserved. Assert News config and existing import map entries remain. From `cms/` run `node --import tsx --test tests/unit/portal-page-editorial-config.test.ts`; expected FAIL before wiring, PASS after:

```ts
admin: {
  useAsTitle: 'title', defaultColumns: ['title', 'slug', '_status', 'publishedAt'],
  components: { edit: {
    beforeDocumentControls: ['/admin/portal-pages/PortalPageEditorialControls#PortalPageEditorialControls'],
    PublishButton: '/admin/portal-pages/EmptyPortalPageControl#EmptyPortalPageControl',
    UnpublishButton: '/admin/portal-pages/EmptyPortalPageControl#EmptyPortalPageControl',
    PreviewButton: '/admin/portal-pages/EmptyPortalPageControl#EmptyPortalPageControl',
  } },
}
```

Set relationship `admin.components.Field` to wrapper with explicit clientProps `{kind:'image'|'video'|'pdf'}` per location, retaining other admin settings and original filters. Use the Task 3 `RelationshipFieldClientProps & {kind:MediaKind}` interface unchanged and installed public field/slot typings rather than casting invalid config. Generate, do not hand-edit imports:

```sh
npm --prefix cms run generate:importmap
npm --prefix cms run generate:types
npm --prefix cms run typecheck
```

Run with documented offline CMS config environment when generators require it; no migration or service startup implied. Expected generated map includes three controls/field components while preserving all existing News and Lexical imports; generated types may be unchanged.

- [ ] **Step 6: Write guarded real integration runner and failing acceptance cases.**

Use `readIntegrationConfig`/`checkIntegrationDirectories` from `cms/tests/support/integration-config.mjs` before importing Payload/pg, reading `.env` or opening a network connection. Require `MIGRATION_TEST_DISPOSABLE=true`, `NODE_ENV=test`, distinct loopback `PAYLOAD_TEST_PORTAL_DATABASE_URL` and `PAYLOAD_TEST_CMS_DATABASE_URL` with test/dev database names, private separate `PAYLOAD_TEST_UPLOAD_DIR`/`PAYLOAD_TEST_EVIDENCE_DIR` outside checkout and UUIDv4 `PAYLOAD_TEST_RUN_ID`. Never fall back to runtime DATABASE_URL. Reuse already authorized disposable local resources or separately prepare a new isolated fixture within that authorization; no production stack/volumes. Runner may not silently start Docker on an ordinary test command.

Add command `"test:portal-pages:integration": "node tests/integration/run-portal-page-editorial.mjs"` to `cms/package.json`. Runner flags exactly `--check-config` and `--execute`; check-only prints NOT_EXECUTED and never initializes Payload. Execution launches the tsx native suite in Node 24 with validated URLs/upload directory and test-only secrets; it applies reviewed CMS migrations only to the validated disposable CMS DB. Provisioning and migration happen as an explicitly requested execution phase, never inside root offline verify. Preserve default `npm run test:payload` exit-2 behavior and its broader unfinished acceptance claims.

Write guard tests rejecting missing opt-in, remote DB, same DB aliases, unsafe directories and unknown arguments before any adapter import. Command from `cms/`: `node --import tsx --test tests/unit/portal-page-editorial-integration-guard.test.ts`; expected FAIL before runner, PASS after. `npm --prefix cms run test:portal-pages:integration -- --check-config` with valid prepared environment must report CONFIG_VALID/NOT_EXECUTED, not PASS.

Real native suite must instantiate `getPayload` against 3.90.2 PostgreSQL adapter with production PortalPages hooks and real Versions tables, using a test-only verified V2 actor and a narrowly test-injected actor transport; do not modify production auth. Exercise exported services and native Local API, inspecting committed results through a separately initialized request/session. Example assertion sequence:

```text
create draft -> explicit save receipt A; record immutable native snapshot A
native update draft:true autosave:true twice -> same mutable UUID/content change
save with first hash -> 409; save with current hash -> receipt B, B != autosave UUID
assert main published content remains unchanged during explicit save
Promise.allSettled(two publish requests expected=B) -> exactly one 200, one 409
read main and resulting published Version -> normalized DTOs equal chosen B
assert B content unchanged (latest marker may differ)
save latest explicit -> unpublish -> new draft Version, main draft, publishedAt null
normal reader returns null; old preview still resolves exact saved B
assert slug, category/media references, empty lists/nulls and all retained Versions preserved
```

Add direct REST publish/restore denial, initial-create author hooks, late autosave invalidation, publication with browser/main divergence, all MIME roles/complete requirement, failed transaction rollback and no false response. For hidden commit failure, wrap the real adapter's commit method only in test to roll back the active transaction and resolve successfully; assert independent confirmation returns 503. Also inject a later legitimate Version between real commit and confirmation and assert the old receipt still succeeds. Restore adapter methods in finally; evidence distinguishes simulated commit fault from ordinary real PostgreSQL success. Record all cases and fail nonzero on any failure; skipped cases must not yield overall PASS.

- [ ] **Step 7: Execute real integration only within existing local authorization.** After preparing guarded environment, run:

```sh
npm --prefix cms run test:portal-pages:integration -- --check-config
npm --prefix cms run test:portal-pages:integration -- --execute
```

Before suite implementation the new command/suite fails absent or reports NOT_EXECUTED; after implementation expected PASS requires actual PostgreSQL evidence, not mocks. No execution result is claimed by this plan. On service unavailability record NOT_EXECUTED/blocker rather than weakening CAS, disabling autosave, patching Version tables or claiming offline checks prove persistence.

- [ ] **Step 8: Run browser integration and manual accessibility acceptance.** Runner browser module consumes the existing externally installed Playwright module via the project's browser fixture conventions; do not add a UI library. Attach only to the authorized disposable CMS fixture with a real test editorial session. Run Task 2 and Task 3 suites plus exact preview/assets, native Versions/diffs, block insertion/reorder, two-second autosave and existing News control smoke cases. Browser test failure must be nonzero; absent browser fixture is NOT_EXECUTED, not success. Use a dedicated browser entrypoint invoked as `node cms/tests/integration/portal-page-editorial-browser.mjs` after the fixture's sanitized connection metadata is available in `PAYLOAD_TEST_EVIDENCE_DIR`; metadata must contain loopback URL and test session setup handles, never production credentials. Read/validate metadata against the same runId and disposable guard before navigation.

Manual checklist in acceptance doc: keyboard save/first invalid focus, publication confirmation cancel/accept, tab order, file input, Escape “Cancelar envio?”, Drawer trap and return focus, select-file action, new-tab label, 409 fields preserved, screen-reader polite statuses/final alerts, progress frequency, disabled explanations, visible focus, reduced motion; small viewport and all five upload destinations. Do not claim a screen reader or Nginx/Firebase-real check merely from browser automation. Test loss of permission/session on a new Range request denies bytes; exact preview stays fixed after a newer save/publication.

- [ ] **Step 9: Update documentation with actual evidence.** Architecture documents native snapshot versus mutable autosave, endpoint bodies/limits/CAS and fresh confirmation, editorial-cookie asset authority. Operations doc teaches explicit save, exact preview, publish/unpublish, immutable historical snapshots without restore, conflict reconciliation, ambiguous-create list/slug check, upload limits/quotas/retry/cancel and no reload resume. README/CMS README add dedicated integration command without claiming the generic exit-2 runner is now complete. Acceptance doc lists each real/offline/manual command, runId and result; unexecuted items stay NOT_EXECUTED with reason. Update Task 4 section's former “publication future” text only where this implementation now fulfills it.

- [ ] **Step 10: Final verification and focused commit.** From root:

```sh
npm run verify
git diff --check
git status --short
```

Expected offline tests/typecheck/syntax PASS and no whitespace errors. Keep integration/manual evidence separate. Stage exactly Task 4 files from the map, generated outputs only when changed, and matching docs:

```sh
git add cms/src/portal-pages/editorial-preview.ts 'cms/src/app/(payload)/editorial/portal-pages/preview/[pageId]/page.tsx' cms/src/admin/portal-pages/PortalPagePreview.tsx cms/src/admin/portal-pages/portal-page-preview.scss cms/src/endpoints/portal-page-editorial.ts cms/src/collections/PortalPages.ts cms/src/portal-pages/native-blocks.ts 'cms/src/app/(payload)/editorial/admin/importMap.js' cms/src/payload-types.ts cms/tests/unit/portal-page-editorial-preview.test.ts cms/tests/unit/portal-page-editorial-config.test.ts cms/tests/unit/portal-page-editorial-integration-guard.test.ts cms/tests/integration/portal-page-editorial-native.ts cms/tests/integration/portal-page-editorial-browser.mjs cms/tests/integration/run-portal-page-editorial.mjs cms/package.json README.md cms/README.md docs/architecture/portal-pages-content.md docs/operations/portal-pages-editorial.md docs/reviews/2026-10-19-portal-pages-editorial-acceptance.md
git commit -m "feat(cms): integrate exact Portal page editorial preview and acceptance"
```

Do not include private evidence directories, upload data, credentials or unrelated files. Fresh review must check no Owner News behavioral diff, no public Portal frontend and no deploy/service action bundled with source changes.

## Self-review against all ten specification sections

| Spec section | Coverage / review gate |
| --- | --- |
| 1 Decision/boundaries | Global constraints; native editor and no News/public/deploy changes; Tasks 2/4 |
| 2 Draft/snapshot/publication | Task 1 immutable save/new UUID, exact source copy, main status, null/empty preservation, unpublish and hooks |
| 3 Endpoints/auth/CSRF/limits/receipts | Task 1 wire types, incremental limits, deterministic queries, CAS, lock order, fresh confirmation and sanitized errors |
| 4 Form coordination | Task 2 selective subscription, live getData hashes, every-await generation checks, mutex, form lease, no setModified(false), explicit confirmations |
| 5 Exact preview/assets | Task 4 server route, session authority, exact DTO, private descriptors, Range/cancel, no Firebase exchange or fallback |
| 6 Components/Payload integration | Tasks 2/3 public hooks/RelationshipField and Task 4 collection-only slots/import map; Versions retained |
| 7 Browser upload | Task 3 all endpoints, exact sizes, sequential slices, retries/cancel, token lifetime, five destinations, quotas and durable cleanup explanation |
| 8 States/accessibility/appearance | Task 2/3 visible copy, native UI/focus/status; Task 4 keyboard/screen-reader/reduced-motion evidence |
| 9 Verification/acceptance | All tasks have red/green checks; Task 4 real guarded PostgreSQL/Payload, browser/manual gates, root verify and documentation |
| 10 Risks | Real adapter/initial hooks/late autosave tests in Task 4; selector identity/refresh/focus tests in Tasks 3/4; no weakened CAS/internal APIs |

Type review: all HTTP responses use snake_case; internal confirmation uses versionID; native body uses generated PortalPage['body']; public renderer uses PortalPageDTO.content_blocks. Media collection `filesize` is mapped once to CompleteMedia.bytes. Snapshot hash and editable hash are distinct; source and result Version IDs are distinct. Imports used in tests come from the file map/interface blocks or existing files explicitly named above.

Plan completion is documentation-only. Execute the four tasks with a fresh review gate after each focused commit; implementation evidence and approvals remain separate from this plan's creation.

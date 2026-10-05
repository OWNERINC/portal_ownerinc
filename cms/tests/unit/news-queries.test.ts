import assert from 'node:assert/strict'
import test from 'node:test'
import { APIError, type PayloadRequest } from 'payload'
import { queryPublishedNews, queryNewsCategories, queryNewsDetail, queryNewsNavigation, queryNewsPreview, queryNewsHome } from '../../src/news/queries.js'
import { hasNewsServiceAccess, newsActions, readNewsInput, readNewsActor, type NewsInputs } from '../../src/auth/service-access.js'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const actor = { uid: 'reader', email: 'reader@example.invalid', name: null, canManageNews: false }
const editor = { ...actor, canManageNews: true }
const document = (n: number, extra = {}) => ({ id: id(n), title: `Published ${n}`, category: '', editorial: null,
  body: [{ blockType: 'paragraph', text: 'Published A' }], _status: 'published', publishedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra })
function fixture() {
  const docs = [document(3), document(2, { category: 'News' }), document(1, { category: 'News' }), document(4, { body: [{ blockType: 'unknown' }], category: 'Invalid' }), document(5, { _status: 'draft' })]
  let fault = false
  const req = { transactionID: 'live' } as PayloadRequest
  const payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      assert.equal(options.req, req); assert.equal(options.overrideAccess, true); assert.equal(options.depth, 0)
      if (fault) throw new APIError('storage unavailable', 503)
      if (options.collection === 'legacy-news-revisions') return { docs: [], hasNextPage: false }
      assert.equal(options.draft, false); assert.ok(options.where)
      const requested = options.where.and?.[0]?.id.equals
      return { docs: requested ? docs.filter(row => row.id === requested) : docs, hasNextPage: false }
    },
    async findVersions(options: any) { assert.equal(options.req, req); assert.equal(options.overrideAccess, true); return { docs: [{ id: id(99), parent: id(1), version: document(1, { title: 'Draft B' }) }] } },
    async findGlobal(options: any) { assert.equal(options.draft, false); assert.equal(options.req, req); assert.equal(options.overrideAccess, true); return { _status: 'published', eyebrow: 'Owner', headline: 'Home A', summary: 'Summary' } },
  }
  req.payload = payload as unknown as PayloadRequest['payload']
  return { req, docs, fail: () => { fault = true } }
}
test('published readers validate before count/pagination/category; stable timestamp/UUID order and same req/lock', async () => {
  const { req } = fixture()
  assert.deepEqual((await queryPublishedNews(req, { limit: 1, offset: 1 }, editor)).rows.map(row => row.id), [id(2)])
  assert.deepEqual(await queryNewsCategories(req, { withCounts: true }, actor), { total: 3, categories: [{ name: 'News', count: 2 }] })
  assert.equal((await queryPublishedNews(req, { limit: 1, offset: 0, category: '' }, actor)).rows[0].id, id(3))
  assert.equal((await queryNewsDetail(req, { id: id(1) }, editor)).title, 'Published 1')
  await assert.rejects(queryNewsDetail(req, { id: id(4) }, actor), e => (e as APIError).status === 404)
  assert.deepEqual(await queryNewsNavigation(req, { id: id(1), category: 'News' }, actor), { previous: null, next: { id: id(2), title: 'Published 2' } })
  assert.equal((await queryNewsHome(req, {}, actor)).content?.headline, 'Home A')
})
test('operational failure never becomes an empty page/count; preview parent/source cannot fall back', async () => {
  const { req, fail } = fixture()
  assert.throws(() => queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'payload' }, actor), e => (e as APIError).status === 403)
  assert.equal((await queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'payload' }, editor)).title, 'Draft B')
  await assert.rejects(queryNewsPreview(req, { id: id(2), versionId: id(99), source: 'payload' }, editor), e => (e as APIError).status === 404)
  await assert.rejects(queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'legacy' }, editor), e => (e as APIError).status === 404)
  fail(); await assert.rejects(queryPublishedNews(req, { limit: 10, offset: 0 }, actor), e => (e as APIError).status === 503)
  await assert.rejects(queryNewsCategories(req, { withCounts: true }, actor), e => (e as APIError).status === 503)
})

test('preview metadata reflects the exact saved revision status, not a generic draft label', async () => {
  const { req } = fixture()
  for (const status of ['draft', 'published'] as const) {
    req.payload.findVersions = (async () => ({ docs: [{ id: id(99), parent: id(1), version: document(1, { _status: status }) }] })) as any
    const dto = await queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'payload' }, editor)
    assert.deepEqual(dto.preview_revision, { id: id(99), source: 'payload', status })
  }
  assert.equal((await queryNewsDetail(req, { id: id(1) }, editor)).preview_revision, undefined)
  req.payload.find = (async () => ({ docs: [{ legacyDocumentId: id(1), legacyRevisionId: id(99), originalStatus: 'archived',
    originalTitle: 'History', originalCategory: '', originalBody: [{ type: 'paragraph', text: 'Original' }], originalEditorial: null }] })) as any
  assert.deepEqual((await queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'legacy' }, editor)).preview_revision,
    { id: id(99), source: 'legacy', status: 'archived' })
})
test('exact service POST allowlist is separate from login and refuses browser/cross-site/other-secret requests', () => {
  const env = { PORTAL_TO_PAYLOAD_SECRET: 'synthetic-private-news-secret-32-chars', PAYLOAD_TO_PORTAL_SECRET: 'synthetic-opposite-direction-secret' }
  const request = (action: string) => ({ url: `https://cms.invalid/editorial/api/portal-news/${action}`, method: 'POST', headers: new Headers({ Authorization: `Bearer ${env.PORTAL_TO_PAYLOAD_SECRET}` }) })
  for (const action of newsActions) assert.equal(hasNewsServiceAccess(request(action), env), true)
  for (const url of ['/editorial/api/news-articles', '/editorial/admin', '/editorial/api/portal-news/list/', '/editorial/api/portal-news/list?draft=true']) assert.equal(hasNewsServiceAccess({ ...request('list'), url: `https://cms.invalid${url}` }, env), false)
  for (const name of ['origin', 'cookie', 'sec-fetch-site']) { const req = request('list'); req.headers.set(name, 'cross-site'); assert.equal(hasNewsServiceAccess(req, env), false) }
  assert.equal(hasNewsServiceAccess({ ...request('list'), method: 'PATCH' }, env), false)
  assert.equal(hasNewsServiceAccess(request('list'), { ...env, PORTAL_TO_PAYLOAD_SECRET: env.PAYLOAD_TO_PORTAL_SECRET }), false)
  assert.throws(() => readNewsActor({ ...actor, role: 'admin' }))
  assert.equal(readNewsActor({ ...actor, uid: 'original-usuário', name: 'a'.repeat(201) }).uid, 'original-usuário')
  assert.throws(() => readNewsInput('list', { limit: 101, offset: 0 }))
  assert.throws(() => readNewsInput('home', { draft: true }))
})
test('I1 enum validation accepts only primitive exact strings and never coerces objects', () => {
  for (const kind of ['article', 'edition'] as const) {
    assert.equal(readNewsInput('list', { limit: 10, offset: 0, kind }).kind, kind)
    assert.equal(readNewsInput('categories', { withCounts: true, kind }).kind, kind)
  }
  assert.deepEqual(readNewsInput('categories', { withCounts: false }), { withCounts: false })
  for (const source of ['payload', 'legacy'] as const) assert.equal(readNewsInput('preview', { id: id(1), versionId: id(99), source }).source, source)
  let coerced = 0
  const object = { toString() { coerced++; return 'article' } }
  const badKinds: unknown[] = [['article'], ['edition'], [['article']], {}, { value: 'article' }, { toString: 'article' }, new String('article'), object, null, true, 1, undefined, 'ARTICLE', 'article ']
  for (const kind of badKinds) {
    assert.throws(() => readNewsInput('list', { limit: 10, offset: 0, kind }), error => error instanceof APIError && error.status === 400)
    assert.throws(() => readNewsInput('categories', { withCounts: true, kind }), error => error instanceof APIError && error.status === 400)
  }
  const badSources: unknown[] = [['legacy'], ['payload'], [['legacy']], {}, { value: 'legacy' }, { toString: 'legacy' }, new String('legacy'), { toString() { coerced++; return 'legacy' } }, null, true, 1, undefined, 'LEGACY', 'legacy ']
  for (const source of badSources) assert.throws(() => readNewsInput('preview', { id: id(1), versionId: id(99), source }), error => error instanceof APIError && error.status === 400)
  assert.equal(coerced, 0)
})
test('I1 malformed kind/source rejects before any Payload or DB access, including either preview branch', async () => {
  let payloadAccesses = 0
  const req = Object.defineProperty({}, 'payload', { get() { payloadAccesses++; throw new Error('content queries forbidden') } }) as PayloadRequest
  const invalid = (error: unknown) => error instanceof APIError && error.status === 400
  for (const kind of [['article'], ['edition'], { value: 'article' }, { toString: 'edition' }]) {
    await assert.rejects(async () => queryPublishedNews(req, { limit: 10, offset: 0, kind } as unknown as NewsInputs['list'], actor), invalid)
    await assert.rejects(async () => queryNewsCategories(req, { withCounts: true, kind } as unknown as NewsInputs['categories'], actor), invalid)
  }
  for (const source of [['legacy'], ['payload'], { value: 'legacy' }, { toString: 'payload' }]) {
    await assert.rejects(async () => queryNewsPreview(req, { id: id(1), versionId: id(99), source } as unknown as NewsInputs['preview'], editor), invalid)
  }
  assert.equal(payloadAccesses, 0, 'invalid enums must not enter transactions, native Versions or legacy history queries')
})

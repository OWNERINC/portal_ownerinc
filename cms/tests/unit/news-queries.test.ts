import assert from 'node:assert/strict'
import test from 'node:test'
import { APIError, type PayloadRequest } from 'payload'
import { queryPublishedNews, queryNewsCategories, queryNewsDetail, queryNewsNavigation, queryNewsPreview, queryNewsHome } from '../../src/news/queries.js'
import { hasNewsServiceAccess, newsActions, readNewsInput, readNewsActor, type NewsInputs } from '../../src/auth/service-access.js'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const fullScan = { maxRawRows: 101000, maxBatches: 1000 } as const
const actor = { uid: 'reader', email: 'reader@example.invalid', name: null, canManageNews: false }
const editor = { ...actor, canManageNews: true }
const document = (n: number, extra = {}) => ({ id: id(n), title: `Published ${n}`, category: '', editorial: null,
  body: [{ blockType: 'paragraph', text: 'Published A' }], _status: 'published', publishedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra })
function fixture() {
  const docs = [document(3), document(2, { category: 'News' }), document(1, { category: 'News' }), document(4, { body: [{ blockType: 'unknown' }], category: 'Invalid' }), document(5, { _status: 'draft' })]
  let fault = false; const findCalls: any[] = []
  const req = { transactionID: 'live' } as PayloadRequest
  const payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      findCalls.push(options)
      assert.equal(options.req, req); assert.equal(options.overrideAccess, true); assert.equal(options.depth, 0)
      if (fault) throw new APIError('storage unavailable', 503)
      if (options.collection === 'legacy-news-revisions') return { docs: [], hasNextPage: false }
      assert.equal(options.draft, false); assert.ok(options.where)
      const match = (row: any, where: any): boolean => Object.entries(where).every(([field, condition]: [string, any]) => {
        if (field === 'and') return condition.every((entry: any) => match(row, entry))
        if (field === 'or') return condition.some((entry: any) => match(row, entry))
        const value = row[field]
        if ('equals' in condition && value !== condition.equals) return false
        if ('exists' in condition && condition.exists !== (value !== null && value !== undefined)) return false
        if ('less_than' in condition && !(value < condition.less_than)) return false
        if ('greater_than' in condition && !(value > condition.greater_than)) return false
        return true
      })
      const selected = docs.filter(row => match(row, options.where)).sort((a, b) => {
        if (Array.isArray(options.sort)) {
          const stamp = (value: string | null) => value === null ? -Infinity : Date.parse(value)
          const difference = stamp(b.publishedAt) - stamp(a.publishedAt)
          if (difference) return difference
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      return { docs: selected.slice(0, options.limit), hasNextPage: selected.length > options.limit }
    },
    async findVersions(options: any) { assert.equal(options.req, req); assert.equal(options.overrideAccess, true); return { docs: [{ id: id(99), parent: id(1), version: document(1, { title: 'Draft B' }) }] } },
    async findGlobal(options: any) { assert.equal(options.draft, false); assert.equal(options.req, req); assert.equal(options.overrideAccess, true); return { _status: 'published', eyebrow: 'Owner', headline: 'Home A', summary: 'Summary' } },
  }
  req.payload = payload as unknown as PayloadRequest['payload']
  return { req, docs, findCalls, fail: () => { fault = true } }
}
test('published readers validate before count/pagination/category; stable timestamp/UUID order and same req/lock', async () => {
  const { req } = fixture()
  assert.deepEqual((await queryPublishedNews(req, { limit: 1, offset: 1 }, editor)).rows.map(row => row.id), [id(2)])
  assert.deepEqual(await queryNewsCategories(req, { withCounts: true }, actor), { total: 3, categories: [{ name: 'News', count: 2 }] })
  assert.equal((await queryPublishedNews(req, { limit: 1, offset: 0, category: '' }, actor)).rows[0].id, id(3))
  assert.equal((await queryNewsDetail(req, { id: id(1) }, editor)).title, 'Published 1')
  await assert.rejects(queryNewsDetail(req, { id: id(4) }, actor), e => (e as APIError).status === 404)
  assert.deepEqual(await queryNewsNavigation(req, { id: id(1), category: 'News' }, actor), { previous: null, next: { source: 'payload', id: id(2), title: 'Published 2' } })
  assert.equal((await queryNewsHome(req, {}, actor)).content?.headline, 'Home A')
})
test('list boundary is strict, source-aware and applied before the deterministic limit', async () => {
  const { req } = fixture()
  const boundary = { published_at: '2026-10-01T00:00:00.000Z', source: 'payload' as const, id: id(1) }
  assert.deepEqual((await queryPublishedNews(req, { limit: 1, offset: 0, boundary }, actor)).rows.map(row => row.id), [id(2)])
  assert.equal((await queryPublishedNews(req, { limit: 10, offset: 0, boundary }, actor)).rows[0].source, 'payload')
  for (const value of [
    { ...boundary, source: 'other' }, { ...boundary, id: 'bad' }, { ...boundary, published_at: 'bad' },
    { ...boundary, extra: true }, { source: 'payload', id: id(1) }, null,
  ]) assert.throws(() => readNewsInput('list', { limit: 10, offset: 0, boundary: value } as unknown as NewsInputs['list']))
  assert.equal(readNewsInput('list', { limit: 101, offset: 0 }).limit, 101)
  assert.throws(() => readNewsInput('list', { limit: 102, offset: 0 }))
  assert.ok((await queryPublishedNews(req, { limit: 101, offset: 0 }, actor)).rows.length > 0)
})
test('list pushes canonical filters, keyset order and storage limit without materializing all publications', async () => {
  const calls: any[] = []
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      calls.push(options)
      const start = 2 + (calls.length - 1) * 4
      return { docs: Array.from({ length: 4 }, (_, index) => document(start + index, { category: 'News' })), hasNextPage: true }
    },
  } as unknown as PayloadRequest['payload']
  const boundary = { published_at: '2026-10-01T00:00:00.000Z', source: 'payload' as const, id: id(1) }
  const page = await queryPublishedNews(req, { limit: 101, offset: 0, category: 'News', kind: 'article', boundary, scan: fullScan }, actor)
  assert.equal(page.rows.length, 101)
  assert.equal(page.rows[0].id, id(2)); assert.equal(page.rows.at(-1)?.id, id(102))
  assert.equal(page.count, null)
  assert.deepEqual(page.scan, { rawRows: 104, batches: 26 })
  assert.equal(calls.length, 26)
  assert.ok(calls.every(call => call.limit === 4 && call.page === 1))
  assert.deepEqual(calls[0].sort, ['-publishedAt', 'id'])
  assert.deepEqual(calls[0].where, { and: [
    { _status: { equals: 'published' } },
    { category: { equals: 'News' } },
    { publishedAt: { exists: true } },
    { or: [
      { publishedAt: { less_than: boundary.published_at } },
      { and: [{ publishedAt: { equals: boundary.published_at } }, { id: { greater_than: boundary.id } }] },
    ] },
  ] })
  assert.equal(calls[0].req, req)
})
test('list scans invalid rows with moving bounded raw keysets and exact exhaustion only at completion', async () => {
  const calls: any[] = []
  const invalid = Array.from({ length: 4 }, (_, index) => document(index + 1, {
    publishedAt: null, body: [{ blockType: 'unknown' }], category: 'News',
  }))
  const final = [document(5, { publishedAt: null, category: 'News' }), document(6, { publishedAt: null, category: 'News' })]
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      calls.push(options)
      return calls.length === 1 ? { docs: invalid, hasNextPage: true } : { docs: final, hasNextPage: false }
    },
  } as unknown as PayloadRequest['payload']
  const result = await queryPublishedNews(req, { limit: 2, offset: 0, category: 'News', scan: fullScan,
    boundary: { published_at: null, source: 'legacy', id: id(999) } }, actor)
  assert.deepEqual(result.rows.map(row => row.id), [id(5), id(6)])
  assert.equal(result.count, 2)
  assert.deepEqual(result.scan, { rawRows: 6, batches: 2 })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.limit === 4 && call.page === 1 && call.sort === 'id'))
  assert.deepEqual(calls[0].where, { and: [
    { _status: { equals: 'published' } }, { category: { equals: 'News' } }, { publishedAt: { equals: null } },
  ] })
  assert.deepEqual(calls[1].where.and.at(-1), { id: { greater_than: id(4) } })
  assert.equal(new Set(result.rows.map(row => row.id)).size, 2)
})
test('list transitions from dated to null rows and honors legacy/Payload equal-timestamp boundary phases', async () => {
  const calls: any[] = []
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      calls.push(options)
      if (calls.length === 1) return { docs: [document(1)], hasNextPage: false }
      return { docs: [document(2, { publishedAt: null })], hasNextPage: false }
    },
  } as unknown as PayloadRequest['payload']
  const result = await queryPublishedNews(req, { limit: 2, offset: 0 }, actor)
  assert.deepEqual(result.rows.map(row => row.id), [id(1), id(2)])
  assert.equal(result.count, 2)
  assert.deepEqual(calls.map(call => call.sort), [['-publishedAt', 'id'], 'id'])
  assert.deepEqual(calls[1].where.and.at(-1), { publishedAt: { equals: null } })

  for (const [source, expected] of [
    ['legacy', { or: [{ publishedAt: { less_than: '2026-10-01T00:00:00.000Z' } }, { publishedAt: { equals: '2026-10-01T00:00:00.000Z' } }] }],
    ['payload', { or: [{ publishedAt: { less_than: '2026-10-01T00:00:00.000Z' } }, { and: [{ publishedAt: { equals: '2026-10-01T00:00:00.000Z' } }, { id: { greater_than: id(1) } }] }] }],
  ] as const) {
    const seen: any[] = []
    req.payload.find = (async (options: any) => { seen.push(options); return { docs: [document(2)], hasNextPage: true } }) as any
    await queryPublishedNews(req, { limit: 1, offset: 0,
      boundary: { published_at: '2026-10-01T00:00:00.000Z', source, id: id(1) } }, actor)
    assert.deepEqual(seen[0].where.and.at(-1), expected)
  }

  for (const [source, expectedLast] of [
    ['legacy', { publishedAt: { equals: null } }],
    ['payload', { id: { greater_than: id(1) } }],
  ] as const) {
    const seen: any[] = []
    req.payload.find = (async (options: any) => { seen.push(options); return { docs: [document(2, { publishedAt: null })], hasNextPage: true } }) as any
    await queryPublishedNews(req, { limit: 1, offset: 0,
      boundary: { published_at: null, source, id: id(1) } }, actor)
    assert.deepEqual(seen[0].where.and.at(-1), expectedLast)
  }
})
test('list fails closed when a storage page claims continuation without raw keyset progress', async () => {
  let calls = 0
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find() { calls++; return { docs: [], hasNextPage: true } },
  } as unknown as PayloadRequest['payload']
  await assert.rejects(queryPublishedNews(req, { limit: 1, offset: 0 }, actor),
    error => error instanceof APIError && error.status === 503)
  assert.equal(calls, 1)
})
test('list enforces the fixed aggregate DTO budget while storage reads stay at four raw documents', async () => {
  const largeBody = Array.from({ length: 100 }, () => ({ blockType: 'paragraph', text: 'x'.repeat(5000) }))
  const docs = Array.from({ length: 70 }, (_, index) => document(index + 1, { body: largeBody }))
  const calls: any[] = []
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      calls.push(options); const start = (calls.length - 1) * 4
      return { docs: docs.slice(start, start + 4), hasNextPage: start + 4 < docs.length }
    },
  } as unknown as PayloadRequest['payload']
  await assert.rejects(queryPublishedNews(req, { limit: 101, offset: 0 }, actor),
    error => error instanceof APIError && error.status === 503)
  assert.ok(calls.length > 1)
  assert.ok(calls.every(call => call.limit === 4), 'one Payload find never materializes 101 maximum-size documents')
})
test('categories stream bounded keyset chunks, discard bodies, and reject non-progress', async () => {
  const docs = Array.from({ length: 9 }, (_, index) => document(index + 1, { category: index % 2 ? 'B' : 'A' }))
  const calls: any[] = []
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      calls.push(options); const start = (calls.length - 1) * 4
      return { docs: docs.slice(start, start + 4), hasNextPage: start + 4 < docs.length }
    },
  } as unknown as PayloadRequest['payload']
  assert.deepEqual(await queryNewsCategories(req, { withCounts: true }, actor), {
    total: 9, categories: [{ name: 'A', count: 5 }, { name: 'B', count: 4 }],
  })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.limit === 4 && call.page === 1 && call.sort === 'id'))
  assert.deepEqual(calls[1].where.and.at(-1), { id: { greater_than: id(4) } })

  let stalled = 0
  req.payload.find = (async () => { stalled++; return { docs: [], hasNextPage: true } }) as any
  await assert.rejects(queryNewsCategories(req, { withCounts: true }, actor),
    error => error instanceof APIError && error.status === 503)
  assert.equal(stalled, 1)
})
test('categories fail closed at the cumulative raw-row and batch budget', async () => {
  let calls = 0
  const req = { transactionID: 'live' } as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } } },
    async find(options: any) {
      calls++
      const start = (calls - 1) * 4 + 1
      return { docs: Array.from({ length: 4 }, (_, index) => document(start + index, { category: 'A' })), hasNextPage: true }
    },
  } as unknown as PayloadRequest['payload']
  await assert.rejects(queryNewsCategories(req, { withCounts: true }, actor),
    error => error instanceof APIError && error.status === 503)
  assert.equal(calls, 1000)
})
test('private scan allowance limits storage work before the next batch or raw row', async () => {
  for (const scan of [{ maxRawRows: 1, maxBatches: 1 }, { maxRawRows: 101, maxBatches: 1 }] as const) {
    const calls: any[] = []
    const req = { transactionID: 'live' } as PayloadRequest
    req.payload = {
      db: { sessions: { live: { db: { async execute() {} } } } },
      async find(options: any) {
        calls.push(options)
        return { docs: [document(1, { body: [{ blockType: 'unknown' }] })], hasNextPage: false }
      },
    } as unknown as PayloadRequest['payload']
    await assert.rejects(queryPublishedNews(req, { limit: 1, offset: 0, scan }, actor),
      error => error instanceof APIError && error.status === 503)
    assert.equal(calls.length, 1, 'dated exhaustion cannot start the null phase after the batch allowance is consumed')
    assert.equal(calls[0].limit, Math.min(4, scan.maxRawRows))
  }
})
test('navigation confirms detail then advances through the same bounded list query', async () => {
  const { req, findCalls } = fixture()
  assert.deepEqual(await queryNewsNavigation(req, { id: id(1), category: 'News' }, actor),
    { previous: null, next: { source: 'payload', id: id(2), title: 'Published 2' } })
  assert.equal(findCalls.length, 3, 'detail plus dated/null bounded list phases; no all-publication materializer pages')
  assert.equal(findCalls[0].limit, 1)
  assert.deepEqual(findCalls[1].sort, ['-publishedAt', 'id'])
  assert.equal(findCalls[1].limit, 4)
  assert.deepEqual(findCalls[1].where.and.slice(0, 2), [
    { _status: { equals: 'published' } }, { category: { equals: 'News' } },
  ])
  assert.equal(findCalls[2].sort, 'id')
  assert.deepEqual(findCalls[2].where.and.at(-1), { publishedAt: { equals: null } })
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
    assert.equal(dto.source, 'payload')
    assert.deepEqual(dto.preview_revision, { id: id(99), source: 'payload', status })
  }
  assert.equal((await queryNewsDetail(req, { id: id(1) }, editor)).preview_revision, undefined)
  req.payload.find = (async () => ({ docs: [{ legacyDocumentId: id(1), legacyRevisionId: id(99), originalStatus: 'archived',
    originalTitle: 'History', originalCategory: '', originalBody: [{ type: 'paragraph', text: 'Original' }], originalEditorial: null }] })) as any
  assert.deepEqual((await queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'legacy' }, editor)).preview_revision,
    { id: id(99), source: 'legacy', status: 'archived' })
  assert.equal((await queryNewsPreview(req, { id: id(1), versionId: id(99), source: 'legacy' }, editor)).source, 'payload')
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
  assert.throws(() => readNewsInput('list', { limit: 102, offset: 0 }))
  assert.deepEqual(readNewsInput('list', { limit: 1, offset: 0, scan: fullScan }).scan, fullScan)
  assert.deepEqual(readNewsInput('preflight', {}), {})
  assert.throws(() => readNewsInput('preflight', { actor: 'forbidden' }))
  for (const scan of [true, false, 0, 1, 'true', null, {}, { maxRawRows: 1 }, { maxRawRows: 0, maxBatches: 1 },
    { maxRawRows: 1, maxBatches: 0 }, { maxRawRows: 101001, maxBatches: 1 }, { maxRawRows: 1, maxBatches: 1001 },
    { maxRawRows: 1, maxBatches: 1, extra: true }]) assert.throws(() => readNewsInput('list', { limit: 1, offset: 0, scan }))
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

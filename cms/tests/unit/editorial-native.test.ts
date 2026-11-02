import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createLocalReq, createPayloadRequest, getPayload, handleEndpoints, restoreVersionOperation, restoreVersionOperationGlobal, updateByIDOperation, updateOperationGlobal, type PayloadRequest } from 'payload'
import { formatAdminURL } from 'payload/shared'
import { editorialConfig } from '../helpers/editorial-config'
import { readRestoreDraft, restoreNewsDraft, restoreScope } from '../../src/publication/restore-draft'
import { assertNewsHistoryAccess } from '../../src/auth/news-history-access'
import { withEditorialBoundary } from '../../src/auth/rest-boundary'

// Real pinned native operations and field/collection hooks. Storage, transactions
// and Portal transport are doubles: this is deliberately NOT native persistence proof.
test('editorial native operation regressions with explicit DB/Portal doubles', async t => {
  const env = { ...process.env }, oldFetch = globalThis.fetch
  Object.assign(process.env, { CMS_PUBLICATION_MODE: 'manual', NODE_ENV: 'production',
    CMS_DATABASE_URL: 'postgresql://no-connection.invalid/editorial', PAYLOAD_SECRET: 'synthetic-editorial-payload-secret',
    PORTAL_PUBLIC_URL: 'https://portal.example.test', PORTAL_INTERNAL_URL: 'http://portal-api:3000',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-editorial-outbound-secret', PORTAL_TO_PAYLOAD_SECRET: 'synthetic-editorial-inbound-secret',
    CMS_UPLOAD_DIR: process.cwd() })
  const actor = { uid: 'strict-editor', email: 'editor@example.test', name: null, canManageNews: true }
  let revoked = false, unavailable = false, mode = 'payload', observed = true, auditFail = false, expireOnLock = false, discardCommit = false
  const events: string[] = []
  globalThis.fetch = async input => {
    const url = String(input); events.push(url.split('/').slice(-2).join('/'))
    if (unavailable) return Response.json({}, { status: 503 })
    if (url.endsWith('/authority')) return Response.json({ mode, epoch: 1, activationObserved: observed,
      manifestSha256: 'a'.repeat(64), sealSha256: 'b'.repeat(64), releaseDigest: `sha256:${'c'.repeat(64)}`,
      imageDigest: `sha256:${'d'.repeat(64)}`, activationRequestId: 'synthetic-test' })
    if (revoked) return Response.json({ reason: 'editorial_session_invalid' }, { status: 401 })
    return Response.json({ actor, expiresAt: new Date(Date.now() + 3600000).toISOString() })
  }
  const config = await editorialConfig('editorial-v1')
  const cacheKey = randomUUID()
  process.env.DISABLE_PAYLOAD_HMR = 'true'
  const payload = await getPayload({ config, key: cacheKey, disableDBConnect: true, disableOnInit: true })
  payload.logger = { error() {}, warn() {} } as never
  type Row = Record<string, any>
  const articleId = randomUUID(), homeId = randomUUID(), editorId = randomUUID()
  const editor = { id: editorId, portalUid: actor.uid, email: actor.email }
  let live: Row, home: Row, versions: Row[], homeVersions: Row[], audits: Row[], locks: Row[]
  const reset = () => {
    live = { id: articleId, title: 'Published B', category: 'News', body: [{ id: randomUUID(), blockType: 'paragraph', text: 'B' }],
      editorial: { version: 1, kind: 'article', summary: 'B', author: '', source_label: '', source_date: null },
      _status: 'published', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
      publicationGeneration: 8, publishedAt: '2026-01-02T00:00:00.000Z', legacyDocumentId: 'current-lineage',
      legacySourceId: null, legacyRevisionId: null, importedAt: null }
    home = { ...structuredClone(live), id: homeId, eyebrow: 'B', headline: 'Home B', summary: 'B' }
    delete home.title; delete home.category; delete home.editorial; delete home.body
    const revision = (version: Row, parent?: string) => ({ id: randomUUID(), ...(parent ? { parent } : {}), version,
      autosave: false, latest: false, createdAt: version.createdAt, updatedAt: version.updatedAt })
    versions = [revision({ ...structuredClone(live), title: 'Published A', publicationGeneration: 1,
      legacyDocumentId: 'historical-lineage', publishedAt: '2025-01-01T00:00:00.000Z' }, articleId), revision(structuredClone(live), articleId)]
    homeVersions = [revision({ ...home, headline: 'Home A', publicationGeneration: 1 }), revision({ ...home })]
    versions[1].latest = homeVersions[1].latest = true
    audits = []; locks = []; events.length = 0; revoked = unavailable = auditFail = expireOnLock = discardCommit = false; mode = 'payload'; observed = true
  }
  reset()
  const matches = (row: Row, where: Row = {}): boolean => Object.entries(where).every(([key, clause]) =>
    key === 'and' ? clause.every((q: Row) => matches(row, q)) : key === 'or' ? clause.some((q: Row) => matches(row, q)) :
      'equals' in clause ? key.split('.').reduce((v, k) => v?.[k], row) === clause.equals : true)
  const sessions: Row = {}, snapshots: Row = {}, dialect = new PgDialect()
  const session = async (req: PayloadRequest) => { assert.ok(req, 'native DB operation must carry req'); assert.ok(sessions[String(await req.transactionID)]) }
  const findVersions = (global: boolean) => async ({ req, where, limit = 10 }: Row) => {
    await session(req)
    const docs = (global ? homeVersions : versions).filter(v => matches(v, where)).slice().reverse().slice(0, limit)
    return { docs: structuredClone(docs), totalDocs: docs.length, totalPages: 1, hasNextPage: false }
  }
  const saveVersion = (global: boolean) => async ({ req, parent, versionData, autosave, createdAt, updatedAt }: Row) => {
    await session(req); events.push('version-write')
    const store = global ? homeVersions : versions
    store.forEach(v => { v.latest = false })
    const row = { id: randomUUID(), parent, version: structuredClone(versionData), autosave, latest: true, createdAt, updatedAt }
    store.push(row); return structuredClone(row)
  }
  payload.db = {
    name: 'postgres', defaultIDType: 'uuid', sessions,
    beginTransaction: async () => {
      const id = randomUUID(); snapshots[id] = structuredClone({ live, home, versions, homeVersions, audits })
      sessions[id] = { db: { execute: async (query: never) => {
        const { sql } = dialect.sqlToQuery(query); events.push(sql.includes('pg_advisory') ? 'reference-lock' : 'sql')
        if (expireOnLock && sql.includes('pg_advisory')) revoked = true
        return { rows: [] }
      } } }; return id
    },
    commitTransaction: async (id: string) => {
      if (discardCommit) ({ live, home, versions, homeVersions, audits } = snapshots[id])
      events.push('commit'); delete sessions[id]; delete snapshots[id]
    },
    rollbackTransaction: async (id: string) => {
      if (snapshots[id]) ({ live, home, versions, homeVersions, audits } = snapshots[id])
      events.push('rollback'); delete sessions[id]; delete snapshots[id]
    },
    findOne: async ({ req, collection }: Row) => { await session(req); assert.equal(collection, 'news-articles'); return structuredClone(live) },
    findGlobal: async ({ req }: Row) => { await session(req); return structuredClone(home) },
    findVersions: findVersions(false), findGlobalVersions: findVersions(true),
    createVersion: saveVersion(false), createGlobalVersion: saveVersion(true),
    updateVersion: async ({ req, id, versionData }: Row) => {
      await session(req); const row = versions.find(v => v.id === id)!; Object.assign(row, structuredClone(versionData)); return structuredClone(row)
    },
    find: async ({ req, collection, where, limit }: Row) => {
      if (collection === 'portal-editors') return { docs: [editor], totalDocs: 1 }
      // Pinned native normal update's lock helper omits req. New comparison and
      // restore checks must carry it; keep that SDK lookup distinguishable.
      if (req) await session(req)
      else assert.equal(collection, 'payload-locked-documents')
      if (collection === 'payload-locked-documents') { assert.equal(limit, 1); events.push(req ? 'editing-lock-read' : 'native-lock-read') }
      const docs = structuredClone((collection === 'news-audit' ? audits : collection === 'payload-locked-documents' ? locks : []).filter(row => matches(row, where))).reverse()
      return { docs: docs.slice(0, limit ?? 10), totalDocs: docs.length }
    },
    deleteMany: async ({ req }: Row) => { await session(req); return [] },
    create: async ({ req, collection, data }: Row) => {
      await session(req)
      events.push(collection === 'news-audit' ? 'audit-write' : 'live-write')
      if (collection === 'news-audit') { if (auditFail) throw new Error('audit_failure'); const row = { ...data, id: randomUUID() }; audits.push(row); return row }
      assert.equal(collection, 'news-articles'); live = { ...data, id: randomUUID() }; return structuredClone(live)
    },
    updateOne: async ({ req, data }: Row) => { await session(req); events.push('live-write'); live = { ...live, ...data }; return structuredClone(live) },
    updateGlobal: async ({ req, data }: Row) => { await session(req); events.push('live-write'); home = { ...home, ...data }; return structuredClone(home) },
  } as never
  const request = async () => createLocalReq({ user: { id: editorId, collection: 'portal-editors', portalUid: actor.uid,
    portalActor: actor, portalExpiresAt: new Date(Date.now() + 3600000).toISOString() } as never,
    req: new Request('https://portal.example.test/editorial/api/news-restore-draft', {
      headers: { cookie: '__Host-ownerinc-editorial=opaque-current-cookie' },
    }) }, payload)
  let dispatched = 0
  const dispatch = async (request: Request, path: string) => {
    dispatched++
    return handleEndpoints({ config, payloadInstanceCacheKey: cacheKey, request, path })
  }
  const httpRequest = (path: string, method = 'GET', body?: unknown) => new Request(`https://portal.example.test/editorial/api${path}`, {
    method, headers: { origin: 'https://portal.example.test', cookie: '__Host-ownerinc-editorial=opaque-current-cookie', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const http = (route: string, method = 'GET', body?: unknown, options: { slug?: string[]; guarded?: boolean } = {}) => {
    // Pinned Next adapter encodes the already-resolved catchall segments. Pass
    // canonical segments explicitly in encoded-URL cases, leaving req.url raw.
    const slug = options.slug ?? route.split('?')[0].slice(1).split('/')
    const path = formatAdminURL({ apiRoute: config.routes.api, path: `/${slug.map(segment => encodeURIComponent(segment)).join('/')}` })
    const request = httpRequest(route, method, body)
    return options.guarded === false ? dispatch(request, path) :
      withEditorialBoundary((request: Request) => dispatch(request, path), 'https://portal.example.test', path)(request, undefined)
  }
  const targets = [
    { route: '/news-articles', encoded: '/%6Eews-articles', method: 'POST', slug: ['news-articles'] },
    { route: `/news-articles/${articleId}`, encoded: `/%6Eews-articles/${articleId}`, method: 'PATCH', slug: ['news-articles', articleId] },
    { route: '/globals/news-home', encoded: '/%67lobals/%6Eews-home', method: 'POST', slug: ['globals', 'news-home'] },
  ]
  const writeData = (slug: string[]) => slug[0] === 'globals' ?
    { eyebrow: 'News', headline: 'REST changed', summary: 'Home', _status: 'published' } :
    { title: 'REST changed', category: live.category, editorial: live.editorial, body: live.body, _status: 'published' }
  const rootAliases = ['draft', 'autosave'].flatMap(key => [
    `%5B${key}%5D=true&%5B${key}%5D=false`, `[${key}]=true`, `[${key}]=false`,
    `%5b${key}%5d=false&%5B${key}%5D=true`, `[${key}]=true&[${key}]=true`,
    `${key}=false&[${key}]=true`, `[${key}]=false&${key}=true`, `[${key}][]=true`,
    `[${key}][0]=true`, `[${key}][bad]=false`, `[${key}]suffix=true`, `[${key}]]=true`,
    `[${key}][=true`, `[${key}=true`, `[[${key}]]=true`,
    `%5B%${key.charCodeAt(0).toString(16)}${key.slice(1)}%5D=true`, `[${key}]%FF=true`,
    `[${key}]=`, `[${key}]`, `[${key}]=TRUE`,
  ])
  const input = (target = 'news-articles') => ({ target, documentId: target === 'news-articles' ? articleId : 'news-home',
    sourceVersionId: (target === 'news-articles' ? versions : homeVersions)[0].id })
  const bound = async (target = 'news-articles') => {
    const value = input(target), comparison = await readRestoreDraft(await request(), value)
    return { ...value, sourceRevisionToken: comparison.sourceRevisionToken, expectedHeadToken: comparison.expectedHeadToken }
  }
  try {
    await t.test('pinned Payload request parser normalizes root aliases, malformed suffixes and duplicates', async () => {
      for (const key of ['draft', 'autosave']) {
        for (const [query, expected] of [
          [`[${key}]=true`, 'true'], [`[${key}]suffix=true`, 'true'], [`[${key}]]=true`, 'true'],
          [`[${key}][=true`, 'true'], [`[${key}]%FF=true`, 'true'],
          [`%5B${key}%5D=true&%5B${key}%5D=false`, ['true', 'false']],
          [`[${key}][]=true`, ['true']], [`[${key}][bad]=true`, { bad: 'true' }],
        ] as const) {
          const req = await createPayloadRequest({ config, payloadInstanceCacheKey: cacheKey,
            request: httpRequest(`/news-articles?${query}`, 'POST', writeData(['news-articles'])) })
          assert.deepEqual(req.query[key], expected, query)
        }
      }
    })
    await t.test('root-bracket controls are rejected before dispatch across article create/update and Home', async () => {
      for (const { route, method, slug } of targets) {
        for (const query of rootAliases) {
          reset(); const before = structuredClone({ live, home, versions, homeVersions, audits }), count = dispatched
          const response = await http(`${route}?${query}`, method, writeData(slug))
          assert.equal(response.status, 400, `${route}?${query}: ${await response.text()}`)
          assert.equal(response.headers.get('cache-control'), 'private,no-store')
          assert.equal(dispatched, count, 'aliases must fail before Payload parsing/dispatch')
          assert.deepEqual({ live, home, versions, homeVersions, audits }, before)
        }
      }
    })
    await t.test('resolved Next paths reject malformed controls before canonical SDK dispatch', async () => {
      for (const { encoded, method, slug } of targets) {
        for (const query of ['draft[]=true', 'autosave[0]=true', 'draft=true&draft=false', 'autosave=TRUE', ...rootAliases]) {
          reset(); const before = structuredClone({ live, home, versions, homeVersions, audits }), count = dispatched
          const response = await http(`${encoded}?${query}`, method, writeData(slug), { slug })
          assert.equal(response.status, 400, `${encoded}?${query}: ${await response.text()}`)
          assert.equal(response.headers.get('cache-control'), 'private,no-store')
          assert.equal(dispatched, count, 'resolved News paths must be checked before SDK dispatch')
          assert.deepEqual({ live, home, versions, homeVersions, audits }, before)
        }
      }
    })
    await t.test('resolved paths are encoded once and aliases beyond the parser limit still fail before dispatch', async () => {
      reset(); const count = dispatched
      const nonNews = await http('/%256Eews-articles?draft[]=true', 'POST', writeData(['news-articles']), { slug: ['%6Eews-articles'] })
      assert.equal(nonNews.status, 404, 'a literal percent-encoded slug is not decoded a second time')
      assert.equal(dispatched, count + 1)
      const padding = Array.from({ length: 1001 }, (_, index) => `ignored${index}=x`).join('&')
      for (const { encoded, method, slug } of targets) {
        reset(); const before = structuredClone({ live, home, versions, homeVersions, audits }), count = dispatched
        const response = await http(`${encoded}?${padding}&%5Bdraft%5D=true`, method, writeData(slug), { slug })
        assert.equal(response.status, 400)
        assert.equal(dispatched, count)
        assert.deepEqual({ live, home, versions, homeVersions, audits }, before)
      }
    })
    await t.test('known News operation hooks validate raw controls even without the outer boundary or a News URL', async () => {
      for (const { encoded, method, slug } of targets) {
        for (const rawPath of [encoded, '/adapter-alias']) {
          for (const query of ['draft[]=true', 'autosave[0]=true', 'draft=true&draft=false', 'autosave=TRUE', ...rootAliases]) {
            reset(); const before = structuredClone({ live, home, versions, homeVersions, audits }), count = dispatched
            const response = await http(`${rawPath}?${query}`, method, writeData(slug), { slug, guarded: false })
            assert.equal(dispatched, count + 1)
            assert.equal(response.status, 400, `${rawPath}?${query}: ${await response.text()}`)
            assert.equal(events.some(event => ['live-write', 'version-write', 'audit-write'].includes(event)), false)
            assert.deepEqual({ live, home, versions, homeVersions, audits }, before)
          }
        }
      }
    })
    await t.test('real Request prototype headers survive standalone comparison and both restore transactions', async () => {
      for (const target of ['news-articles', 'news-home']) {
        reset(); const req = await request()
        assert.ok(req instanceof Request); assert.equal(Object.hasOwn(req, 'headers'), false)
        const comparison = await readRestoreDraft(req, input(target))
        assert.equal(comparison.canRestore, true)
        const restored = await restoreNewsDraft(req, { ...input(target), sourceRevisionToken: comparison.sourceRevisionToken, expectedHeadToken: comparison.expectedHeadToken })
        assert.equal(restored._status, 'draft'); assert.equal(req.transactionID, undefined)
        assert.ok(req.headers.get('cookie'))
      }
    })
    await t.test('real REST rejects raw ambiguous draft controls before dispatch and leaves live rows and versions unchanged', async () => {
      const invalid = ['draft=true&draft=false', 'draft=false&draft=true', 'draft=true&draft=true',
        'autosave=true&autosave=false', 'autosave=false&autosave=true', 'draft[]=true', 'draft[0]=true', 'draft[x]=false',
        'autosave%5B%5D=true', 'draft=TRUE', 'draft=1', 'draft=', 'autosave=null', 'autosave',
        'draft=true&autosave[invalid]=false']
      for (const [route, method] of [['/news-articles', 'POST'], [`/news-articles/${articleId}`, 'PATCH'], ['/globals/news-home', 'POST']]) {
        for (const query of invalid) {
          reset(); const before = structuredClone({ live, home, versions, homeVersions, audits }), count = dispatched
          const data = route.includes('globals') ? { eyebrow: 'News', headline: 'Must not publish', summary: 'Private', _status: 'published' } :
            { title: 'Must not publish', category: live.category, editorial: live.editorial, body: live.body, _status: 'published' }
          const response = await http(`${route}?${query}`, method, data)
          assert.equal(response.status, 400, `${route}?${query}: ${await response.text()}`)
          assert.equal(dispatched, count, 'raw controls must fail before Payload parsing/dispatch')
          assert.deepEqual({ live, home, versions, homeVersions, audits }, before)
        }
      }
    })
    await t.test('real REST accepts native scalar draft/autosave controls and ordinary explicit publication', async () => {
      for (const { route, method, slug } of targets.flatMap(target => [target, { ...target, route: target.encoded }])) {
        for (const query of ['draft=true', 'autosave=true', 'draft=true&autosave=false', 'draft=false&autosave=false', '',
          'autosave=true&depth=0&draft=true&fallback-locale=null', 'locale=undefined&depth=0&fallback-locale=null&draft=true', 'depth=0',
          '%64raft=true', '%61utosave=true']) {
          reset(); const before = structuredClone({ live, home }), savingDraft = query.includes('=true')
          const isHome = slug[0] === 'globals', creating = method === 'POST' && !isHome
          const data = isHome ? { eyebrow: 'News', headline: 'REST changed', summary: 'Home', _status: 'published' } :
            { title: 'REST changed', category: live.category, editorial: live.editorial, body: live.body, _status: 'published' }
          const response = await http(`${route}${query ? `?${query}` : ''}`, method, data, { slug })
          assert.equal(response.status, creating ? 201 : 200, `${route}?${query}: ${await response.clone().text()}`)
          assert.equal((await response.json())[isHome ? 'result' : 'doc']._status, savingDraft ? 'draft' : 'published')
          const row = isHome ? home : live, revisions = isHome ? homeVersions : versions
          assert.equal(revisions.at(-1)?.version._status, savingDraft ? 'draft' : 'published')
          if (savingDraft && !creating) assert.deepEqual({ live, home }, before)
          else assert.equal(row._status, savingDraft ? 'draft' : 'published')
        }
      }
    })
    await t.test('native parser truncation cannot drop a valid raw draft control and publish', async () => {
      reset(); const before = structuredClone({ live, home, versions, homeVersions, audits })
      const padding = Array.from({ length: 1001 }, (_, index) => `ignored${index}=x`).join('&')
      const response = await http(`/news-articles/${articleId}?${padding}&draft=true`, 'PATCH', { title: 'Do not publish', _status: 'published' })
      assert.equal(response.status, 400, await response.text())
      assert.deepEqual({ live, home, versions, homeVersions, audits }, before)
    })
    await t.test('wrapped real REST comparison/history preserves private no-store and lock-aware restoration availability', async () => {
      for (const target of ['news-articles', 'news-home']) {
        reset()
        const query = new URLSearchParams(input(target)), route = `/news-restore-draft?${query}`
        const response = await http(route)
        assert.equal(response.status, 200, await response.clone().text())
        assert.equal(response.headers.get('cache-control'), 'private,no-store')
        assert.equal((await response.json()).canRestore, true)
        const before = structuredClone({ versions, homeVersions, audits })
        const lock = { user: { relationTo: 'portal-editors', value: randomUUID() }, updatedAt: new Date().toISOString(),
          ...(target === 'news-articles' ? { document: { relationTo: target, value: articleId } } : { globalSlug: target }) }
        locks = [lock]
        const blocked = await http(route), value = await blocked.json()
        assert.equal(blocked.status, 200); assert.equal(value.canRestore, false)
        assert.equal(JSON.stringify(value).includes(lock.user.value), false)
        assert.deepEqual(locks, [lock], 'comparison must not delete or refresh locks')
        assert.ok(events.includes('editing-lock-read')); assert.equal(events.includes('native-lock-read'), false)
        const conflict = await http('/news-restore-draft', 'POST', { ...input(target), sourceRevisionToken: value.sourceRevisionToken, expectedHeadToken: value.expectedHeadToken })
        assert.equal(conflict.status, 409)
        assert.equal((await (await http(route)).json()).canRestore, false, 'refresh after 409 keeps restore disabled')
        for (const release of ['expired', 'self', 'released']) {
          locks = release === 'released' ? [] : [{ ...lock, ...(release === 'self' ? { user: { relationTo: 'portal-editors', value: editorId } } : { updatedAt: new Date(Date.now() - 301_000).toISOString() }) }]
          assert.equal((await (await http(route)).json()).canRestore, true, release)
        }
        assert.deepEqual({ versions, homeVersions, audits }, before)
        const base = structuredClone({ live, home })
        const restored = await http('/news-restore-draft', 'POST', { ...input(target), sourceRevisionToken: value.sourceRevisionToken, expectedHeadToken: value.expectedHeadToken })
        assert.equal(restored.status, 200, await restored.clone().text())
        assert.equal(restored.headers.get('cache-control'), 'private,no-store')
        assert.equal((await restored.json())._status, 'draft')
        assert.deepEqual({ live, home }, base, 'HTTP body consumption does not lose session or publish')
      }
    })
    await t.test('native article restore creates new draft, preserves live/identity and audits source atomically', async () => {
      reset(); const base = structuredClone(live), value = await bound(), req = await request()
      const result = await restoreNewsDraft(req, value)
      assert.equal(result._status, 'draft'); assert.notEqual(result.versionId, value.sourceVersionId)
      assert.deepEqual(live, base); assert.equal(events.includes('live-write'), false)
      const saved = versions.at(-1)!
      assert.equal(saved.version.title, 'Published A'); assert.equal(saved.autosave, false)
      for (const key of ['id', 'createdAt', 'publishedAt', 'publicationGeneration', 'legacyDocumentId', 'legacySourceId', 'legacyRevisionId', 'importedAt']) assert.equal(saved.version[key], base[key], key)
      assert.equal(audits.at(-1)?.action, 'draft_saved'); assert.equal(audits.at(-1)?.versionId, result.versionId)
      assert.equal(audits.at(-1)?.details.sourceVersionId, value.sourceVersionId)
      assert.equal(audits.at(-1)?.details.sourceRevisionToken, value.sourceRevisionToken)
      assert.equal(restoreScope(req), undefined)
      await assert.rejects(restoreNewsDraft(await request(), value), /news_restore_conflict/)
    })
    await t.test('audit failure rolls back the native new version; source/head tampering refuses', async () => {
      reset(); const value = await bound(), before = structuredClone(versions)
      auditFail = true
      await assert.rejects(restoreNewsDraft(await request(), value), /audit_failure/)
      assert.deepEqual(versions, before); assert.equal(audits.length, 0)
      auditFail = false; versions[0].version.title = 'Coalesced change with same ID/time'
      await assert.rejects(restoreNewsDraft(await request(), value), /news_restore_conflict/)
      await assert.rejects(readRestoreDraft(await request(), { ...input(), documentId: randomUUID() }), /news_version_not_found/)
    })
    await t.test('ordinary article/global native restore refuses forged scope and access override', async () => {
      for (const overrideAccess of [true, false]) {
        const req = await request(); req.context = { isRestoringVersion: true, newsRestoreDraft: true }
        await assert.rejects(restoreVersionOperation({ id: versions[0].id, collection: payload.collections['news-articles'], req, overrideAccess, draft: true }), /news_version_restore_unavailable/)
        await assert.rejects(restoreVersionOperationGlobal({ id: homeVersions[0].id, globalConfig: config.globals[0], req: await request(), overrideAccess }), /news_version_restore_unavailable/)
      }
    })
    await t.test('swallowed native COMMIT failure never produces a confirmed restore response', async () => {
      reset(); const value = await bound(), before = structuredClone(versions)
      discardCommit = true
      await assert.rejects(restoreNewsDraft(await request(), value), /news_restore_unconfirmed/)
      assert.deepEqual(versions, before); assert.equal(audits.length, 0)
    })
    await t.test('strict history revokes between requests and after a reference-lock wait', async () => {
      reset(); const req = await request()
      await assertNewsHistoryAccess(req)
      revoked = true; await assert.rejects(assertNewsHistoryAccess(req))
      revoked = false; unavailable = true; await assert.rejects(assertNewsHistoryAccess(req), (e: any) => e.status === 503)
      unavailable = false
      for (mode of ['legacy', 'frozen']) { observed = false; await assert.rejects(assertNewsHistoryAccess(req)) }
      mode = 'payload_frozen'; await assertNewsHistoryAccess(req)
      mode = 'payload'; observed = true
      const value = await bound(); expireOnLock = true
      await assert.rejects(restoreNewsDraft(await request(), value))
      assert.equal(events.includes('version-write'), false)
      const generic = await request(); delete (generic.user as any).portalActor
      await assert.rejects(assertNewsHistoryAccess(generic))
    })
    await t.test('native draft PATCH and Home update cannot turn supplied published status into live writes', async () => {
      reset()
      await payload.update({ collection: 'news-articles', id: articleId, req: await request(), overrideAccess: false,
        draft: true, data: { title: 'Private C', _status: 'published' } })
      assert.equal(live.title, 'Published B'); assert.equal(versions.at(-1)?.version._status, 'draft')
      await updateOperationGlobal({ slug: 'news-home', globalConfig: config.globals[0], req: await request(), overrideAccess: false,
        autosave: true, data: { headline: 'Private C', _status: 'published' } })
      assert.equal(home.headline, 'Home B'); assert.equal(homeVersions.at(-1)?.version._status, 'draft')
      assert.equal(homeVersions.at(-1)?.autosave, true)
    })
    await t.test('native permission maps deny other-area identities but propagate dependency failures', async () => {
      reset(); const req = await request(), access = config.collections.find(c => c.slug === 'news-articles')!.access.readVersions
      assert.equal(await access({ req }), true)
      unavailable = true
      await assert.rejects(Promise.resolve(access({ req })), (e: any) => e.status === 503)
      unavailable = false; revoked = true
      assert.equal(await access({ req }), false)
      revoked = false
      delete (req.user as any).portalActor
      assert.equal(await access({ req }), false)
      const expired = await request(); (expired.user as any).portalExpiresAt = '2020-01-01T00:00:00.000Z'
      await assert.rejects(assertNewsHistoryAccess(expired), (e: any) => e.status === 401)
    })
    await t.test('article/Home restoration respects a current foreign editing lock and frozen authority', async () => {
      for (const target of ['news-articles', 'news-home']) {
        reset(); const value = await bound(target), before = structuredClone({ versions, homeVersions, audits })
        locks = [{ user: { relationTo: 'portal-editors', value: randomUUID() }, updatedAt: new Date().toISOString(),
          ...(target === 'news-articles' ? { document: { relationTo: target, value: articleId } } : { globalSlug: target }) }]
        await assert.rejects(restoreNewsDraft(await request(), value), /news_document_locked/)
        assert.deepEqual({ versions, homeVersions, audits }, before)
        locks = []; mode = 'payload_frozen'; observed = false
        assert.equal((await readRestoreDraft(await request(), input(target))).canRestore, false)
        await assert.rejects(restoreNewsDraft(await request(), value), /cms_authority_read_only/)
        assert.deepEqual({ versions, homeVersions, audits }, before)
      }
    })
    await t.test('safe Home restoration executes normal native draft update and preserves live Home', async () => {
      reset(); const before = structuredClone(home), value = await bound('news-home')
      const result = await restoreNewsDraft(await request(), value)
      assert.equal(result._status, 'draft'); assert.deepEqual(home, before)
      assert.equal(homeVersions.at(-1)?.version.headline, 'Home A')
      assert.equal(homeVersions.at(-1)?.version.publicationGeneration, 8)
      assert.equal(audits.at(-1)?.details.saveKind, 'restore')
    })
    await t.test('native create forces private draft; consecutive autosaves coalesce without rewriting checkpoints', async () => {
      reset()
      const created = await payload.create({ collection: 'news-articles', req: await request(), overrideAccess: false,
        draft: true, data: { title: 'Not published', _status: 'published' } })
      assert.equal(created._status, 'draft'); assert.equal(live._status, 'draft')
      reset(); const restored = await restoreNewsDraft(await request(), await bound())
      const checkpoint = structuredClone(versions.find(v => v.id === restored.versionId))
      const update = async (title: string) => updateByIDOperation({ id: articleId, collection: payload.collections['news-articles'],
        req: await request(), overrideAccess: false, autosave: true, data: { title, _status: 'published' } })
      await update('First autosave'); const firstId = versions.at(-1)!.id, count = versions.length
      await update('Second autosave')
      assert.equal(versions.length, count); assert.equal(versions.at(-1)!.id, firstId)
      assert.equal(versions.at(-1)!.version.title, 'Second autosave'); assert.equal(live.title, 'Published B')
      assert.deepEqual({ ...versions.find(v => v.id === restored.versionId), latest: true }, checkpoint)
    })
  } finally {
    globalThis.fetch = oldFetch
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import {
  queryPortalPageCategories,
  queryPortalPagePreview,
  queryPortalPagePublishedDetail,
  queryPortalPageAvailability,
  queryPortalPages,
  resolvePreviewPortalPageForAsset,
  resolvePublishedPortalPageForAsset,
} from '../../src/portal-pages/reader.js'

const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab'
const newerID = '018f47a2-7b3c-7a11-8a2c-1234567890ac'
const versionID = '018f47a2-7b3c-7a11-8a2c-1234567890ad'
const draftVersionID = '018f47a2-7b3c-7a11-8a2c-1234567890ae'
const otherPageVersionID = '018f47a2-7b3c-7a11-8a2c-1234567890af'
const assetID = '018f47a2-7b3c-7a11-8a2c-1234567890b0'
const categoryID = '018f47a2-7b3c-7a11-8a2c-1234567890b1'
const assetAID = '018f47a2-7b3c-7a11-8a2c-1234567890b2'
const assetBID = '018f47a2-7b3c-7a11-8a2c-1234567890b3'
const revisionBID = '018f47a2-7b3c-7a11-8a2c-1234567890b4'

const reader = { uid: 'reader-uid', email: 'reader@example.invalid', name: null, canManageKnowledge: false }
const editor = { ...reader, canManageKnowledge: true }

function page(id: string, slug: string, title: string, publishedAt: string, status = 'published') {
  return {
    id, slug, title, summary: '', cover: null, coverAlt: null,
    categories: [{ id: categoryID, slug: 'policies', name: 'Policies' }],
    publishedAt, _status: status, body: [{ blockType: 'heading', text: title, level: 2 }],
  }
}

function version(id: string, parent: string, document: Record<string, unknown>, status = 'published') {
  return { id, parent, version: { ...document, _status: status }, updatedAt: document.publishedAt }
}

function fixture() {
  const publishedAt = '2026-10-19T10:00:00.000Z'
  const newerPublishedAt = publishedAt // Equal timestamps assert the UUID descending tie-breaker.
  const published = page(pageID, 'older-policy', 'Older policy', publishedAt)
  const newer = page(newerID, 'newer-policy', 'Newer policy', newerPublishedAt)
  const draft = page('018f47a2-7b3c-7a11-8a2c-1234567890b2', 'draft-only', 'Private draft', publishedAt, 'draft')
  const pages = [published, newer, draft]
  const versions = [
    version(otherPageVersionID, newerID, newer),
    version(draftVersionID, pageID, page(pageID, 'older-policy', 'Unpublished edit', publishedAt), 'draft'),
    version(versionID, pageID, published),
  ]
  const calls: string[] = []
  const sessions: Record<string, { db: { execute: (query: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> } }> = {}
  const sessionState = new Map<string, { locked: boolean; pageReads: number }>()
  let transactionNumber = 0
  let referenceLocks = 0
  let peakReferenceLocks = 0
  let transactionBegins = 0
  let transactionCommits = 0
  let lockedPageReadMaximum = 0
  let afterCommit: (() => void) | undefined
  const media = { id: assetID, originalName: 'guide.pdf', storageKey: '018f47a2-7b3c-7a11-8a2c-1234567890b3.pdf',
    mimeType: 'application/pdf', filesize: 20, sha256: 'a'.repeat(64), state: 'complete', uploadedBy: 'editor',
    completedAt: publishedAt }

  const filterCategory = (slug: string | undefined) => pages.filter(value => value._status === 'published' &&
    (slug === undefined || value.categories.some(category => category.slug === slug)))
  const queryParts = (query: unknown) => {
    let text = ''
    const params: unknown[] = []
    const visit = (chunk: unknown) => {
      if (chunk && typeof chunk === 'object' && Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
        for (const child of (chunk as { queryChunks: unknown[] }).queryChunks) visit(child)
      } else if (chunk && typeof chunk === 'object' && (chunk as { constructor?: { name?: string } }).constructor?.name === 'StringChunk') {
        text += ((chunk as { value?: unknown }).value as string[] | undefined)?.join('') || ''
      } else {
        text += '?'
        params.push(chunk)
      }
    }
    visit(query)
    return { text, params }
  }

  const makeSession = (id: string) => {
    const state = { locked: false, pageReads: 0 }
    sessionState.set(id, state)
    return { db: { execute: async (query: unknown) => {
      const { text, params } = queryParts(query)
      calls.push(`sql:${text}`)
      if (text.includes('pg_advisory_xact_lock')) {
        calls.push('reference-lock')
        if (!state.locked) {
          state.locked = true
          referenceLocks += 1
          peakReferenceLocks = Math.max(peakReferenceLocks, referenceLocks)
        }
        return { rows: [] }
      }
      if (text.includes('SELECT count(*)::bigint AS count')) {
        assert.equal(state.locked, true, 'catalog count must acquire the reference lock first')
        calls.push('catalog-count')
        const categorySlug = text.includes('category.slug =') ? params.find(value => typeof value === 'string') as string : undefined
        return { rows: [{ count: BigInt(filterCategory(categorySlug).length) }] }
      }
      if (text.includes('SELECT page.id AS id')) {
        assert.equal(state.locked, true, 'published candidate query must acquire the reference lock first')
        calls.push(`published-query:${id}`)
        const categorySlug = text.includes('category.slug =') ? params.find(value => typeof value === 'string' && !/^[0-9a-f-]{36}$/u.test(value)) as string : undefined
        let selected = filterCategory(categorySlug)
        if (text.includes('ORDER BY page.id ASC')) {
          const cursor = params.find(value => typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value)) as string | undefined
          selected = selected.filter(value => cursor === undefined || value.id > cursor).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          const limit = params.filter((value): value is number => typeof value === 'number').at(-1) as number
          return { rows: selected.slice(0, limit).map(value => ({ id: value.id })) }
        }
        selected.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id))
        const numericParams = params.filter(value => typeof value === 'number') as number[]
        const [limit, offset] = numericParams.slice(-2)
        return { rows: selected.slice(offset, offset + limit).map(value => ({ id: value.id })) }
      }
      return { rows: [] }
    } } }
  }
  sessions.live = makeSession('live')
  const payload = {
    config: { i18n: { fallbackLanguage: 'pt' }, admin: { user: 'portal-editors' }, collections: {} },
    collections: { 'portal-pages': { config: { slug: 'portal-pages' } } },
    db: {
      sessions,
      beginTransaction: async () => {
        const id = `read-${++transactionNumber}`
        sessions[id] = makeSession(id)
        transactionBegins += 1
        return id
      },
      commitTransaction: async (id: string) => {
        transactionCommits += 1
        const state = sessionState.get(id)
        if (state?.locked) referenceLocks -= 1
        lockedPageReadMaximum = Math.max(lockedPageReadMaximum, state?.pageReads || 0)
        delete sessions[id]
        sessionState.delete(id)
        afterCommit?.()
      },
      rollbackTransaction: async (id: string) => {
        const state = sessionState.get(id)
        if (state?.locked) referenceLocks -= 1
        delete sessions[id]
        sessionState.delete(id)
      },
    },
    find: async (args: Record<string, any>) => {
      calls.push(`find:${args.collection}`)
      assert.ok(sessions[String(args.req.transactionID)], 'Payload find must use an active transaction')
      let docs = args.collection === 'portal-pages' ? [...pages] : []
      const filters = args.where?.and || [args.where || {}]
      const slug = filters.find((filter: any) => filter.slug)?.slug?.equals
      const id = filters.find((filter: any) => filter.id)?.id?.equals
      const status = filters.find((filter: any) => filter._status)?._status?.equals
      if (slug) docs = docs.filter(doc => doc.slug === slug)
      if (id) docs = docs.filter(doc => doc.id === id)
      if (status) docs = docs.filter(doc => doc._status === status)
      docs = docs.filter(doc => doc._status === 'published')
      if (Array.isArray(args.sort)) {
        docs.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id))
      }
      const limit = args.limit || 100
      const start = ((args.page || 1) - 1) * limit
      const selected = docs.slice(start, start + limit)
      return { docs: selected, hasNextPage: start + limit < docs.length, totalDocs: docs.length }
    },
    findVersions: async (args: Record<string, any>) => {
      calls.push(`findVersions:${JSON.stringify(args.sort || null)}`)
      const state = sessionState.get(String(args.req.transactionID))
      assert.ok(state, 'Payload version lookup must use an active transaction')
      if (String(args.req.transactionID).startsWith('read-')) {
        assert.equal(state.locked, true, 'published revision validation must hold the reference lock')
      }
      let docs = versions
      const filters = args.where?.and || []
      const parent = filters.find((filter: any) => filter.parent)?.parent?.equals
      const id = filters.find((filter: any) => filter.id)?.id?.equals
      const status = filters.find((filter: any) => filter['version._status'])?.['version._status']?.equals
      if (parent) docs = docs.filter(doc => doc.parent === parent)
      if (id) docs = docs.filter(doc => doc.id === id)
      if (status) docs = docs.filter(doc => doc.version._status === status)
      if (Array.isArray(args.sort) && args.sort.join(',') === '-updatedAt,-id') {
        docs = [...docs].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || b.id.localeCompare(a.id))
      }
      if (args.limit) docs = docs.slice(0, args.limit)
      return { docs, hasNextPage: false }
    },
    findByID: async (args: Record<string, any>) => {
      calls.push(`findByID:${args.collection}`)
      const state = sessionState.get(String(args.req.transactionID))
      assert.ok(state, 'Payload findByID must use an active transaction')
      if (String(args.req.transactionID).startsWith('read-')) {
        assert.equal(state.locked, true, 'published page/reference reads must hold the reference lock')
      }
      if (args.collection === 'portal-pages') state.pageReads += 1
      if (args.collection === 'portal-pages') return pages.find(doc => doc.id === args.id) || null
      if (args.collection === 'portal-page-categories' && args.id === categoryID) return { id: categoryID, slug: 'policies', name: 'Policies' }
      if (args.collection === 'portal-page-media' && args.id === assetID) return media
      return null
    },
  } as unknown as Payload
  const i18n = { t: (key: string) => key }
  const req = { payload, transactionID: 'live', context: {}, i18n, t: i18n.t } as unknown as PayloadRequest
  return {
    payload, req, published, newer, draft, versions, calls, media, pages,
    get peakReferenceLocks() { return peakReferenceLocks },
    get transactionBegins() { return transactionBegins },
    get transactionCommits() { return transactionCommits },
    get lockedPageReadMaximum() { return lockedPageReadMaximum },
    set afterCommit(callback: (() => void) | undefined) { afterCommit = callback },
    addPublished(index: number) {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const versionID = `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`
      const document = page(id, `extra-policy-${index + 1}`, `Extra policy ${index + 1}`, publishedAt)
      pages.push(document)
      versions.push(version(versionID, id, document))
    },
  }
}

test('published catalog excludes drafts, returns exact saved Version IDs, counts before pagination, and sorts publishedAt/id descending', async () => {
  const f = fixture()
  const result = await queryPortalPages(f.req, { limit: 1, offset: 0 }, reader)
  assert.equal(result.count, 2)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.id, newerID)
  assert.equal(result.rows[0]?.revision.id, otherPageVersionID)
  assert.equal(result.rows[0]?.revision.status, 'published')
  assert.equal(result.rows[0]?.asset_scope, 'portal-pages')
  assert.ok(!JSON.stringify(result).includes('Private draft'))
  assert.equal(f.calls.filter(call => call.includes("set_config('statement_timeout'")).length, 2,
    'the database statement timeout is refreshed after reference-lock acquisition')
  const second = await queryPortalPages(f.req, { limit: 1, offset: 1, category: 'policies' }, reader)
  assert.equal(second.count, 2)
  assert.equal(second.rows[0]?.id, pageID)
  assert.ok(f.calls.includes('reference-lock'))
})

test('availability uses a dedicated early-exit existence path and stops after the first eligible publication', async () => {
  const f = fixture()
  const available = await queryPortalPageAvailability(f.req, reader, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 1000,
  })
  assert.equal(available, true)
  assert.equal(f.calls.filter(call => call.startsWith('findVersions:')).length, 1,
    'only the first eligible published revision is validated')
  assert.equal(f.calls.filter(call => call.startsWith('published-query:')).length, 1,
    'availability must not count or scan the catalog')
  assert.equal(f.calls.includes('catalog-count'), false)
})

test('availability returns false only after the published cursor is exhausted', async () => {
  const f = fixture()
  f.pages.splice(0, f.pages.length)
  const available = await queryPortalPageAvailability(f.req, reader)
  assert.equal(available, false)
  assert.equal(f.calls.filter(call => call.startsWith('published-query:')).length, 1)
  assert.equal(f.calls.filter(call => call.startsWith('findVersions:')).length, 0)
  assert.equal(f.calls.includes('catalog-count'), false)
})

test('category aggregation releases the exclusive reference lock between bounded batches', async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) f.addPublished(index)
  const result = await queryPortalPageCategories(f.req, reader, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 4000,
  })
  assert.equal(result[0]?.count, 14)
  assert.equal(f.peakReferenceLocks, 1)
  assert.equal(f.lockedPageReadMaximum <= 10, true, 'one lock covers no more than one bounded batch')
  assert.equal(f.transactionCommits, 2, '14 candidate pages require two committed bounded batches')
})

test('a publication committed between category batches is observed after the cursor without holding the prior lock', async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) f.addPublished(index)
  let publishedDuringScan = false
  f.afterCommit = () => {
    if (!publishedDuringScan) {
      publishedDuringScan = true
      f.addPublished(99)
    }
  }
  const result = await queryPortalPageCategories(f.req, reader, {
    signal: new AbortController().signal, deadlineAt: Date.now() + 4000,
  })
  assert.equal(result[0]?.count, 15, 'the fresh second batch includes the publication committed after the first batch')
  assert.equal(f.transactionCommits, 2)
  assert.equal(f.peakReferenceLocks, 1)
})

test('abort after one category batch prevents opening the next lock or scan query', async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) f.addPublished(index)
  const controller = new AbortController()
  f.afterCommit = () => controller.abort()
  await assert.rejects(queryPortalPageCategories(f.req, reader, {
    signal: controller.signal, deadlineAt: Date.now() + 4000,
  }), error => (error as { status?: number }).status === 503)
  assert.equal(f.transactionCommits, 1)
  assert.equal(f.calls.filter(call => call.startsWith('published-query:')).length, 1)
})

test('category scan budget exhaustion fails with 503 instead of returning truncated counts', async () => {
  const f = fixture()
  for (let index = 0; index < 12; index++) f.addPublished(index)
  await assert.rejects(queryPortalPageCategories(f.req, reader, {
    signal: new AbortController().signal, deadlineAt: Date.now() - 1,
  }), error => (error as { status?: number }).status === 503)
  assert.equal(f.transactionBegins, 0)
})

test('published detail is canonical-slug-only and never reads the draft with the same slug', async () => {
  const f = fixture()
  const result = await queryPortalPagePublishedDetail(f.req, 'older-policy', reader)
  assert.equal(result?.id, pageID)
  assert.equal(result?.revision.id, versionID)
  assert.equal(await queryPortalPagePublishedDetail(f.req, 'draft-only', reader), null)
})

test('categories include only eligible published pages and count each page once per category', async () => {
  const f = fixture()
  const result = await queryPortalPageCategories(f.req, reader)
  assert.deepEqual(result, [{ id: categoryID, slug: 'policies', name: 'Policies', count: 2 }])
})

test('preview uses only the exact saved Version for its parent and requires editor capability', async () => {
  const f = fixture()
  const result = await queryPortalPagePreview(f.req, pageID, draftVersionID, editor)
  assert.equal(result?.title, 'Unpublished edit')
  assert.deepEqual(result?.revision, { id: draftVersionID, status: 'draft' })
  assert.equal(result?.asset_scope, 'portal-pages-preview')
  assert.equal(await queryPortalPagePreview(f.req, pageID, otherPageVersionID, editor), null)
  await assert.rejects(queryPortalPagePreview(f.req, pageID, draftVersionID, reader), /permission_denied/)
})

test('asset authorization binds the exact current published Version or the exact saved editor Version', async () => {
  const f = fixture()
  const current = await resolvePublishedPortalPageForAsset(f.req, pageID, versionID)
  assert.equal(current?.dto.revision.id, versionID)
  assert.equal(await resolvePublishedPortalPageForAsset(f.req, pageID, draftVersionID), null,
    'a stale URL does not become authorized by the same page remaining published')

  const preview = await resolvePreviewPortalPageForAsset(f.req, pageID, draftVersionID, editor)
  assert.deepEqual(preview?.dto.revision, { id: draftVersionID, status: 'draft' })
  assert.equal(await resolvePreviewPortalPageForAsset(f.req, pageID, otherPageVersionID, editor), null)
  await assert.rejects(resolvePreviewPortalPageForAsset(f.req, pageID, draftVersionID, reader), /permission_denied/)
})

test('latest published version query is explicitly ordered and publish A → B denies A asset URLs', async () => {
  const f = fixture()
  const oldPublished = f.versions.find(row => row.id === versionID)!
  const oldPage = page(pageID, 'older-policy', 'Revision A', '2026-10-19T10:00:00.000Z')
  oldPage.body = [{ blockType: 'image', asset: assetAID, alt: 'Revision A asset' }] as any
  oldPublished.version = { ...oldPage }
  oldPublished.updatedAt = '2026-10-19T10:00:00.000Z'

  const latestPage = page(pageID, 'older-policy', 'Revision B', '2026-10-19T11:00:00.000Z')
  latestPage.body = [{ blockType: 'image', asset: assetBID, alt: 'Revision B asset' }] as any
  Object.assign(f.published, latestPage)
  f.versions.push(version(revisionBID, pageID, latestPage))
  // Keep the fixture deliberately out of database order: B is appended after A and the other page.

  const media = (id: string, key: string) => ({ id, originalName: `${key}.png`, storageKey: `${id}.png`,
    mimeType: 'image/png', filesize: 20, sha256: 'b'.repeat(64), state: 'complete', uploadedBy: 'editor',
    completedAt: '2026-10-19T11:00:00.000Z' })
  ;(f.payload as unknown as { findByID: (args: Record<string, unknown>) => Promise<unknown> }).findByID = async args => {
    f.calls.push(`findByID:${String(args.collection)}`)
    assert.equal((args.req as PayloadRequest).transactionID, 'live')
    if (args.collection === 'portal-pages') return f.published
    if (args.collection === 'portal-page-categories' && args.id === categoryID) return { id: categoryID, slug: 'policies', name: 'Policies' }
    if (args.collection === 'portal-page-media' && args.id === assetAID) return media(assetAID, 'revision-a')
    if (args.collection === 'portal-page-media' && args.id === assetBID) return media(assetBID, 'revision-b')
    return null
  }

  const stale = await resolvePublishedPortalPageForAsset(f.req, pageID, versionID)
  const current = await resolvePublishedPortalPageForAsset(f.req, pageID, revisionBID)
  assert.equal(stale, null, 'a published revision A URL is denied after publishing B')
  assert.equal(current?.dto.revision.id, revisionBID)
  assert.deepEqual([...current!.media.keys()], [assetBID], 'only B media is authorized by the current published snapshot')
  assert.ok(f.calls.includes('findVersions:["-updatedAt","-id"]'), 'latest-version lookup uses updatedAt DESC then id DESC')
})

test('published reads fail closed when the saved published Version projection drifts from the main document', async () => {
  const f = fixture()
  const savedVersion = f.versions.find(row => row.id === versionID)!.version as Record<string, unknown>
  savedVersion.title = 'saved but divergent title'
  await assert.rejects(queryPortalPagePublishedDetail(f.req, 'older-policy', reader),
    error => (error as { status?: number }).status === 503)
})

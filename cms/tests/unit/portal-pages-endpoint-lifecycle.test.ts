import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { createPortalPageReadEndpoints } from '../../src/endpoints/portal-pages.js'
import { portalPageMediaResponse, type PortalPageDescriptor } from '../../src/portal-pages/read-file.js'

const apiRequire = createRequire(new URL('../../../api/package.json', import.meta.url))
const { createPortalPagesClient } = apiRequire('./portal-pages/payload-client.js') as {
  createPortalPagesClient: (options: Record<string, unknown>) => {
    asset: (input: Record<string, unknown>, actor: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>
  }
}
const express = apiRequire('express') as () => any
const supertest = apiRequire('supertest') as (app: unknown) => any

const origin = 'https://portal.example.test'
const secret = 'portal-to-payload-test-secret-'.padEnd(40, 'x')
const reverseSecret = 'payload-to-portal-test-secret-'.padEnd(40, 'y')
const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab'
const revisionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac'
const assetAID = '018f47a2-7b3c-7a11-8a2c-1234567890ae'
const assetBID = '018f47a2-7b3c-7a11-8a2c-1234567890af'
const reader = { uid: 'reader-id', email: 'reader@example.test', name: 'Reader', role: 'user', permissions: {} }
const actor = { uid: reader.uid, email: reader.email, name: reader.name, canManageKnowledge: false }
const pdf = Buffer.from('%PDF-1.7\nendpoint fixture\n%%EOF\n')

const runtimeEnv = {
  CMS_DATABASE_URL: 'postgresql://cms:secret@localhost:5432/editorial',
  PAYLOAD_SECRET: 'payload-runtime-secret-for-test-only',
  PORTAL_PUBLIC_URL: origin,
  PORTAL_INTERNAL_URL: 'https://payload.example.test',
  PAYLOAD_TO_PORTAL_SECRET: reverseSecret,
  PORTAL_TO_PAYLOAD_SECRET: secret,
  CMS_UPLOAD_DIR: path.resolve('cms/test-uploads'),
}

async function buildPayloadConfig() {
  const previousBuildOnly = process.env.CMS_BUILD_ONLY
  const previousNextPhase = process.env.NEXT_PHASE
  process.env.CMS_BUILD_ONLY = 'true'
  process.env.NEXT_PHASE = 'phase-production-build'
  try {
    const module = await import('../../src/payload.config.js')
    return await module.createCmsConfig()
  } finally {
    if (previousBuildOnly === undefined) delete process.env.CMS_BUILD_ONLY
    else process.env.CMS_BUILD_ONLY = previousBuildOnly
    if (previousNextPhase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = previousNextPhase
  }
}

function withEnvironment<T>(values: Record<string, string>, action: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  Object.assign(process.env, values)
  return action().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function pageDocument() {
  return {
    id: pageID, slug: 'current-policy', title: 'Current policy', summary: '', cover: null, coverAlt: null,
    categories: [], publishedAt: '2026-10-19T11:00:00.000Z', _status: 'published',
    body: [{ blockType: 'image', asset: assetBID, alt: 'Current cover' }],
  }
}

function mediaRecord(id: string, mimeType = 'image/png') {
  const extension = mimeType === 'application/pdf' ? 'pdf' : 'png'
  return {
    id, originalName: `asset-${id}.${extension}`, storageKey: `${id}.${extension}`, mimeType,
    filesize: pdf.length, sha256: 'a'.repeat(64), state: 'complete', uploadedBy: 'editor',
    completedAt: '2026-10-19T11:00:00.000Z',
  }
}

function descriptor(bytes = pdf) {
  let closed = 0
  const handle: PortalPageDescriptor = {
    stat: async () => ({ size: bytes.length, isFile: () => true }),
    read: async (buffer, offset, length, position) => {
      const count = Math.max(0, Math.min(length, bytes.length - position))
      bytes.copy(buffer as Buffer, offset, position, position + count)
      return { bytesRead: count }
    },
    close: async () => { closed++ },
  }
  return { handle, get closed() { return closed } }
}

async function endpointFixture(options: { commitFailure?: boolean; mediaMime?: string } = {}) {
  const config = await buildPayloadConfig()
  const calls: string[] = []
  const page = pageDocument()
  const version = { id: revisionID, parent: pageID, updatedAt: page.publishedAt, version: { ...page } }
  const media = mediaRecord(assetBID, options.mediaMime || 'image/png')
  const sessions: Record<string, unknown> = {}
  const payload = {
    config,
    collections: Object.fromEntries(config.collections.map(collection => [collection.slug, { config: collection }])),
    db: {
      sessions,
      beginTransaction: async () => { calls.push('begin'); sessions.owned = { db: { execute: async () => { calls.push('lock') } } }; return 'owned' },
      commitTransaction: async () => {
        calls.push('commit')
        delete sessions.owned
        if (options.commitFailure) throw new Error('private commit failure')
      },
      rollbackTransaction: async () => { calls.push('rollback'); delete sessions.owned },
    },
    findByID: async ({ collection, id, req }: Record<string, any>) => {
      calls.push(`findByID:${collection}:${id}`)
      assert.equal(req.transactionID, 'owned')
      if (collection === 'portal-pages' && id === pageID) return page
      if (collection === 'portal-page-media' && id === assetBID) return media
      return null
    },
    findVersions: async ({ collection, req, where }: Record<string, any>) => {
      calls.push(`findVersions:${collection}`)
      assert.equal(req.transactionID, 'owned')
      const filters = where?.and || []
      const parent = filters.find((filter: any) => filter.parent)?.parent?.equals
      const status = filters.find((filter: any) => filter['version._status'])?.['version._status']?.equals
      const docs = [version].filter(row => (!parent || row.parent === parent) &&
        (!status || (row.version as Record<string, unknown>)._status === status))
      return { docs, hasNextPage: false }
    },
  } as unknown as Payload

  const makeOpenAsset = (fixture: ReturnType<typeof descriptor>) => async ({ media: openedMedia, signal }: any) => {
    return portalPageMediaResponse({ media: openedMedia, signal, openDescriptor: async () => fixture.handle })
  }
  const request = (input: Record<string, unknown>, signal = new AbortController().signal) => {
    const webRequest = new Request('https://payload.example.test/editorial/api/portal-pages/asset', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-request-id': 'endpoint-test' },
      body: JSON.stringify({ actor, input }), signal,
    })
    Object.assign(webRequest, { payload })
    return webRequest as unknown as PayloadRequest
  }
  const endpoint = (openAsset: any): ((req: PayloadRequest) => Promise<Response>) =>
    createPortalPageReadEndpoints({ openAsset }).find(value => value.path === '/portal-pages/asset')!.handler as
      (req: PayloadRequest) => Promise<Response>
  return { payload, page, version, media, calls, request, endpoint, makeOpenAsset }
}

test('asset endpoint cancels an opened media descriptor when transaction commit fails before response handoff', async () => {
  await withEnvironment(runtimeEnv, async () => {
    const f = await endpointFixture({ commitFailure: true })
    const opened = descriptor()
    const open = f.makeOpenAsset(opened)
    const response = await f.endpoint(open)(f.request({ pageId: pageID, revisionId: revisionID, assetId: assetBID, preview: false, range: null }))
    assert.equal(response.status, 503)
    assert.equal(opened.closed, 1, 'unhanded-off body cancellation closes its descriptor once')
    assert.deepEqual(f.calls.slice(0, 2), ['begin', 'lock'])
    assert.ok(f.calls.includes('commit'))
    assert.ok(f.calls.includes('rollback'))
  })
})

test('asset endpoint hands off normally and retains abort ownership until the consumer terminates', async () => {
  await withEnvironment(runtimeEnv, async () => {
    const f = await endpointFixture()
    const opened = descriptor()
    const response = await f.endpoint(f.makeOpenAsset(opened))(f.request({
      pageId: pageID, revisionId: revisionID, assetId: assetBID, preview: false, range: null,
    }))
    assert.equal(response.status, 200)
    assert.equal(opened.closed, 0, 'the endpoint does not close a handed-off body')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf)
    assert.equal(opened.closed, 1, 'normal EOF releases the descriptor once')
    assert.equal(f.calls.filter(call => call === 'commit').length, 1)

    const abortedFixture = await endpointFixture()
    const abortedDescriptor = descriptor()
    const abort = new AbortController()
    const aborted = await abortedFixture.endpoint(abortedFixture.makeOpenAsset(abortedDescriptor))(abortedFixture.request({
      pageId: pageID, revisionId: revisionID, assetId: assetBID, preview: false, range: null,
    }, abort.signal))
    const reader = aborted.body!.getReader()
    abort.abort()
    await assert.rejects(reader.read())
    assert.equal(abortedDescriptor.closed, 1, 'request abort closes the handed-off descriptor once')
  })
})

test('actual CMS asset endpoint rejects unreferenced IDs and wrong-role MIME before opening a descriptor', async () => {
  await withEnvironment(runtimeEnv, async () => {
    const f = await endpointFixture()
    let opens = 0
    const openAsset = async () => { opens++; throw new Error('must not open') }
    const endpoint = f.endpoint(openAsset)
    const body = { pageId: pageID, revisionId: revisionID, preview: false, range: null }
    const unreferenced = await endpoint(f.request({ ...body, assetId: assetAID }))
    assert.equal(unreferenced.status, 404)
    assert.deepEqual(await unreferenced.json(), { error: 'not_found' })
    assert.equal(opens, 0)

    const wrongRole = await endpointFixture({ mediaMime: 'application/pdf' })
    const wrongRoleResponse = await wrongRole.endpoint(openAsset)(wrongRole.request({ ...body, assetId: assetBID }))
    assert.equal(wrongRoleResponse.status, 400)
    assert.deepEqual(await wrongRoleResponse.json(), { error: 'invalid_request' })
    assert.equal(opens, 0)
  })
})

test('real CMS JSON asset errors pass through the real API client and Express router without leaking details', async () => {
  await withEnvironment(runtimeEnv, async () => {
    const f = await endpointFixture()
    const cmsEndpoint = f.endpoint(async () => { throw new Error('unexpected media open') })
    const cmsHandler = async (url: string, init: RequestInit) => {
      const request = new Request(url, init)
      Object.assign(request, { payload: f.payload })
      return cmsEndpoint(request as unknown as PayloadRequest)
    }

    const directClient = createPortalPagesClient({ baseURL: 'https://payload.example.test', secret, fetchImpl: cmsHandler })
    await assert.rejects(directClient.asset({ pageId: pageID, revisionId: revisionID, assetId: assetBID, preview: true, range: null }, actor),
      (error: any) => error.status === 403 && error.code === 'forbidden')

    const filename = fileURLToPath(new URL('../../../api/routes/contents.js', import.meta.url))
    const routeModule = new Module(filename)
    const routeRequire = createRequire(filename)
    routeModule.require = (id: string) => id === '../db' ? {} : id === '../middleware/auth'
      ? { authMiddleware() {}, firebaseAuth: {} } : routeRequire(id)
    const compile = routeModule as unknown as { _compile(source: string, filename: string): unknown }
    compile._compile(await import('node:fs/promises').then(fs => fs.readFile(filename, 'utf8')), filename)
    const { createContentsRouter } = routeModule.exports as { createContentsRouter: (options: Record<string, unknown>) => unknown }
    const client = createPortalPagesClient({ baseURL: 'https://payload.example.test', secret, fetchImpl: cmsHandler })
    const firebaseAuth = {
      verifySessionCookie: async (cookie: string) => {
        assert.equal(cookie, 'reader.session.cookie')
        return { uid: reader.uid, email_verified: true }
      },
    }
    const db = { query: async () => ({ rows: [reader] }) }
    const env = { NODE_ENV: 'production', PORTAL_PUBLIC_URL: origin }
    const app = express()
    app.use('/api/contents', createContentsRouter({ db, firebaseAuth, payloadClient: client, env }))
    const response = await supertest(app).get(`/api/contents/assets/${pageID}/${revisionID}/${assetAID}`)
      .set('Cookie', `__Secure-ownerinc-content-media=reader.session.cookie`)
    assert.equal(response.status, 404)
    assert.equal(response.body.error, 'not_found')
    assert.equal(response.body.reason, 'not_found')
    assert.doesNotMatch(response.text, /private|CMS|storageKey|uploadDir|unexpected media open/i)
  })
})

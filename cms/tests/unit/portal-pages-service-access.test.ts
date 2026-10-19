import assert from 'node:assert/strict'
import test from 'node:test'
import type { PayloadRequest } from 'payload'
import {
  hasPortalPagesServiceAccess,
  isPrivatePortalPagePath,
  readPortalPageActor,
  readPortalPageInput,
  validPortalPageRequestID,
} from '../../src/auth/portal-pages-service-access.js'
import { portalPageReadEndpoints } from '../../src/endpoints/portal-pages.js'

const secret = 'p'.repeat(40)
const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab'
const versionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac'
const assetID = '018f47a2-7b3c-7a11-8a2c-1234567890ad'

test('Portal Page secret path is isolated to exact POST endpoints and rejects browser headers', () => {
  const env = { PORTAL_TO_PAYLOAD_SECRET: secret, PAYLOAD_TO_PORTAL_SECRET: 'q'.repeat(40) }
  const request = (url: string, headers = new Headers({ authorization: `Bearer ${secret}` }), method = 'POST') =>
    ({ url, method, headers })
  assert.equal(isPrivatePortalPagePath('https://cms.invalid/editorial/api/portal-pages/list', 'POST'), true)
  assert.equal(isPrivatePortalPagePath('https://cms.invalid/editorial/api/portal-pages/list?x=1', 'POST'), false)
  assert.equal(isPrivatePortalPagePath('https://cms.invalid/editorial/api/portal-pages/list-extra', 'POST'), false)
  assert.equal(isPrivatePortalPagePath('https://cms.invalid/editorial/api/portal-pages/list', 'GET'), false)
  assert.equal(hasPortalPagesServiceAccess(request('https://cms.invalid/editorial/api/portal-pages/list'), env), true)
  for (const name of ['origin', 'cookie', 'sec-fetch-site']) {
    assert.equal(hasPortalPagesServiceAccess(request('https://cms.invalid/editorial/api/portal-pages/list',
      new Headers({ authorization: `Bearer ${secret}`, [name]: '' })), env), false)
  }
  assert.equal(hasPortalPagesServiceAccess(request('https://cms.invalid/editorial/api/portal-pages/list',
    new Headers({ authorization: `Bearer ${secret}` }), 'GET'), env), false)
  assert.equal(hasPortalPagesServiceAccess(request('https://cms.invalid/editorial/api/portal-pages/list'),
    { ...env, PAYLOAD_TO_PORTAL_SECRET: secret }), false)
  assert.equal(hasPortalPagesServiceAccess(request('https://cms.invalid/editorial/api/portal-news/list'), env), false)
})

test('service actor and all action inputs are exact, bounded primitive contracts', () => {
  const actor = { uid: 'firebase-user', email: 'user@example.invalid', name: null, canManageKnowledge: true }
  assert.deepEqual(readPortalPageActor(actor), actor)
  for (const value of [null, [], { ...actor, extra: true }, { ...actor, canManageKnowledge: 'true' }]) {
    assert.throws(() => readPortalPageActor(value))
  }
  assert.deepEqual(readPortalPageInput('list', { limit: 50, offset: 1_000_000 }), { limit: 50, offset: 1_000_000 })
  assert.deepEqual(readPortalPageInput('list', { limit: 1, offset: 0, category: 'people-policy' }),
    { limit: 1, offset: 0, category: 'people-policy' })
  assert.deepEqual(readPortalPageInput('categories', {}), {})
  assert.deepEqual(readPortalPageInput('detail', { slug: 'people-policy' }), { slug: 'people-policy' })
  assert.deepEqual(readPortalPageInput('preview', { pageId: pageID, versionId: versionID }), { pageId: pageID, versionId: versionID })
  assert.deepEqual(readPortalPageInput('asset', { pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }),
    { pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null })
  for (const value of [{ limit: 51, offset: 0 }, { limit: 1, offset: -1 }, { limit: 1, offset: 0, category: 'Not Canonical' },
    { limit: '1', offset: 0 }, { slug: 'bad/slug' }, { pageId: pageID, versionId: assetID, extra: true }]) {
    assert.throws(() => readPortalPageInput(Object.hasOwn(value, 'slug') ? 'detail' : Object.hasOwn(value, 'pageId') ? 'preview' : 'list', value))
  }
})

test('request ID accepts only the bounded correlation header grammar', () => {
  assert.equal(validPortalPageRequestID('req-01:abc_xyz'), true)
  assert.equal(validPortalPageRequestID(''), false)
  assert.equal(validPortalPageRequestID('a'.repeat(129)), false)
  assert.equal(validPortalPageRequestID('bad id'), false)
})

test('CMS publishes only the five exact POST read endpoints and rejects browser headers, bad IDs, and oversized JSON before reads', async () => {
  const previousToPayload = process.env.PORTAL_TO_PAYLOAD_SECRET
  const previousToPortal = process.env.PAYLOAD_TO_PORTAL_SECRET
  process.env.PORTAL_TO_PAYLOAD_SECRET = secret
  process.env.PAYLOAD_TO_PORTAL_SECRET = 'q'.repeat(40)
  try {
    assert.deepEqual(portalPageReadEndpoints.map(endpoint => [endpoint.path, endpoint.method]), [
      ['/portal-pages/list', 'post'], ['/portal-pages/categories', 'post'], ['/portal-pages/detail', 'post'],
      ['/portal-pages/preview', 'post'], ['/portal-pages/asset', 'post'],
    ])
    const endpoint = portalPageReadEndpoints.find(value => value.path === '/portal-pages/categories')!
    const request = (headers: Headers, body?: ReadableStream<Uint8Array>) => ({
      url: 'https://cms.invalid/editorial/api/portal-pages/categories', method: 'POST', headers,
      body,
    }) as unknown as PayloadRequest
    const validHeaders = () => new Headers({ authorization: `Bearer ${secret}`, 'content-type': 'application/json',
      'x-request-id': 'request-01' })

    for (const name of ['origin', 'cookie', 'sec-fetch-site']) {
      const headers = validHeaders()
      headers.set(name, '')
      const response = await endpoint.handler(request(headers))
      assert.equal(response.status, 403, name)
    }
    const invalidID = validHeaders()
    invalidID.set('x-request-id', 'bad id')
    assert.equal((await endpoint.handler(request(invalidID))).status, 400)
    const tooLarge = validHeaders()
    tooLarge.set('content-length', '16385')
    assert.equal((await endpoint.handler(request(tooLarge))).status, 413)

    let cancelled = false
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)) },
      cancel() { cancelled = true },
    })
    const response = await endpoint.handler(request(validHeaders(), oversizedBody))
    assert.equal(response.status, 413)
    assert.equal(cancelled, true)
  } finally {
    if (previousToPayload === undefined) delete process.env.PORTAL_TO_PAYLOAD_SECRET
    else process.env.PORTAL_TO_PAYLOAD_SECRET = previousToPayload
    if (previousToPortal === undefined) delete process.env.PAYLOAD_TO_PORTAL_SECRET
    else process.env.PAYLOAD_TO_PORTAL_SECRET = previousToPortal
  }
})

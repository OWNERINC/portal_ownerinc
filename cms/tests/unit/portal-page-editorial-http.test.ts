import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PayloadRequest } from 'payload'
import { portalPageEditorialEndpoints, readEditorialJSON } from '../../src/endpoints/portal-page-editorial'
import { readEditorialRevision } from '../../src/portal-pages/editorial-service'
import { pageID, versionID, nativePage, editorialFixture } from '../fixtures/portal-page-editorial'

process.env.PORTAL_PUBLIC_URL = 'http://localhost:8080'

function stream(text: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
    cancel() { onCancel?.() },
  })
}

function request(f: ReturnType<typeof editorialFixture>, options: {
  method?: string; origin?: string | null; fetchSite?: string; contentType?: string | null; contentLength?: string;
  text?: string; body?: ReadableStream<Uint8Array> | null; signal?: AbortSignal; search?: string;
} = {}) {
  const headers = new Headers()
  if (options.origin !== null) headers.set('origin', options.origin ?? 'http://localhost:8080')
  if (options.fetchSite) headers.set('sec-fetch-site', options.fetchSite)
  if (options.contentType !== null) headers.set('content-type', options.contentType ?? 'application/json')
  if (options.contentLength !== undefined) headers.set('content-length', options.contentLength)
  Object.assign(f.req, { headers, body: options.body === undefined ? stream(options.text ?? '{}') : options.body,
    signal: options.signal, method: options.method ?? 'POST', searchParams: new URLSearchParams(options.search ?? ''),
    url: `http://localhost:3001/editorial/api/portal-page-editorial${options.search ? `?${options.search}` : ''}` })
  return f.req
}

function endpoint(suffix: 'revision' | 'save' | 'publication') {
  return portalPageEditorialEndpoints.find(value => value.path.endsWith(`/${suffix}`))!
}

function assertSafe(response: Response, status: number) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'private,no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
}

test('valid V2 knowledge-only editor saves successfully and HTTP receipt exposes no authors', async () => {
  const f = editorialFixture()
  f.seedLatest({ id: versionID, parent: pageID, latest: true, autosave: true,
    updatedAt: '2026-10-19T10:00:00.000Z', version: nativePage })
  const revision = await readEditorialRevision(f.req, pageID)
  request(f, { text: JSON.stringify({ id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: revision.latest!.snapshot_hash }) })
  const response = await endpoint('save').handler(f.req)
  assertSafe(response, 201)
  const body = await response.json() as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), ['document_status', 'editable_hash', 'id', 'saved_at', 'version_id'])
  assert.equal(body.id, pageID)
  assert.notEqual(body.version_id, pageID)
  assert.equal('createdBy' in body || 'updatedBy' in body, false)
})

test('unauthenticated and expired sessions are 401; identity mismatch and missing manageKnowledge are 403', async () => {
  const unauthenticated = editorialFixture()
  Object.assign(unauthenticated.req, { user: null })
  request(unauthenticated, { text: JSON.stringify({ id: null, data: nativePage }) })
  assertSafe(await endpoint('save').handler(unauthenticated.req), 401)

  const expired = editorialFixture()
  const user = expired.req.user as unknown as Record<string, unknown>
  Object.assign(expired.req, { user: { ...user, adminExpiresAt: '2000-01-01T00:00:00.000Z' } })
  request(expired, { search: `id=${pageID}` })
  assertSafe(await endpoint('revision').handler(expired.req), 401)

  const invalidExpiry = editorialFixture()
  Object.assign(invalidExpiry.req, { user: { ...(invalidExpiry.req.user as object), adminExpiresAt: 'not-an-expiry' } })
  request(invalidExpiry, { search: `id=${pageID}` })
  assertSafe(await endpoint('revision').handler(invalidExpiry.req), 401)

  for (const changed of [
    { ...user, adminActor: { ...(user.adminActor as object), uid: 'different-uid' } },
    { ...user, adminActor: { ...(user.adminActor as Record<string, unknown>), version: 1 } },
    { ...user, adminActor: { ...(user.adminActor as Record<string, unknown>), capabilities: {
      manageKnowledge: false, manageAcademy: true, manageBenefits: false, manageReminders: false,
    } } },
  ]) {
    const denied = editorialFixture()
    Object.assign(denied.req, { user: changed })
    request(denied, { text: JSON.stringify({ id: null, data: nativePage }) })
    assertSafe(await endpoint('save').handler(denied.req), 403)
  }
})

test('legacy or News-only actors cannot use editorial Page endpoints in any News authority mode', async () => {
  for (const authorityMode of ['legacy', 'frozen', 'payload', 'payload_frozen']) {
    const f = editorialFixture()
    const v2User = f.req.user as unknown as Record<string, unknown>
    Object.assign(f.req, {
      user: { ...v2User, adminActor: undefined, adminExpiresAt: undefined,
        portalActor: { uid: 'editor-uid', email: 'editor@example.test', name: null, canManageNews: true },
        portalExpiresAt: '2099-01-01T00:00:00.000Z' },
      context: { authorityMode },
    })
    request(f, { text: JSON.stringify({ id: null, data: nativePage }) })
    assertSafe(await endpoint('save').handler(f.req), 403)
    assert.equal(f.calls.some(call => call.operation === 'begin' || call.operation === 'create' || call.operation === 'update'), false,
      `News-only actor cannot mutate pages in ${authorityMode}`)
  }
})

test('POST origin and fetch-site checks reject absent, null, foreign and cross-site requests', async () => {
  for (const options of [{ origin: null }, { origin: 'null' }, { origin: 'https://attacker.example' },
    { origin: 'http://localhost:8080', fetchSite: 'cross-site' }]) {
    const f = editorialFixture()
    request(f, { ...options, text: JSON.stringify({ id: null, data: nativePage }) })
    assertSafe(await endpoint('save').handler(f.req), 403)
    assert.equal(f.calls.some(call => call.operation === 'begin'), false)
  }
})

test('authenticated revision GET permits absent Origin, rejects cross-site, and performs no writes', async () => {
  const f = editorialFixture()
  f.seedLatest({ id: versionID, parent: pageID, latest: true, autosave: true,
    updatedAt: '2026-10-19T10:00:00.000Z', version: nativePage })
  request(f, { method: 'GET', origin: null, contentType: null, body: null, search: `id=${pageID}` })
  const response = await endpoint('revision').handler(f.req)
  assertSafe(response, 200)
  assert.equal((await response.json() as { id: string }).id, pageID)
  assert.equal(f.calls.some(call => ['create', 'update', 'delete'].includes(call.operation)), false)

  const blocked = editorialFixture()
  request(blocked, { method: 'GET', origin: null, contentType: null, body: null, fetchSite: 'cross-site', search: `id=${pageID}` })
  assertSafe(await endpoint('revision').handler(blocked.req), 403)
})

test('malformed JSON, UTF-8, content type, mixed variants and extra keys are 400', async () => {
  const malformedInputs: Array<{ text?: string; contentType?: string | null; body?: ReadableStream<Uint8Array> | null }> = [
    { text: '{' }, { contentType: 'text/plain', text: '{}' },
    { text: JSON.stringify({ id: pageID, expected_latest_version_id: versionID, expected_snapshot_hash: 'a'.repeat(64), expected_version_id: versionID }) },
    { text: JSON.stringify({ id: null, data: nativePage, expected_latest_version_id: versionID }) },
    { body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([0xc3, 0x28])); controller.close() } }) },
  ]
  for (const malformed of malformedInputs) {
    const f = editorialFixture()
    request(f, malformed)
    const response = await endpoint('save').handler(f.req)
    assertSafe(response, 400)
    assert.equal(f.calls.some(call => call.operation === 'create' || call.operation === 'update'), false)
  }
})

test('existing save cannot use the create envelope budget, including with a lying Content-Length', async () => {
  const f = editorialFixture()
  const text = JSON.stringify({ id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: 'a'.repeat(64) }) + ' '.repeat(16 * 1024)
  request(f, { text })
  assertSafe(await endpoint('save').handler(f.req), 413)

  const lying = editorialFixture()
  request(lying, { text, contentLength: '1' })
  assertSafe(await endpoint('save').handler(lying.req), 413)

  const malformed = editorialFixture()
  request(malformed, { text: '{}', contentLength: '1e9' })
  assertSafe(await endpoint('save').handler(malformed.req), 400)
})

test('create ingress has an incremental eight MiB cap and an aborted request fails closed', async () => {
  const tooLarge = editorialFixture()
  request(tooLarge, { text: `${JSON.stringify({ id: null, data: nativePage })}${' '.repeat(8 * 1024 * 1024)}` })
  assertSafe(await endpoint('save').handler(tooLarge.req), 413)

  const controller = new AbortController()
  controller.abort()
  const aborted = editorialFixture()
  let cancelled = false
  const abortedBody = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  request(aborted, { signal: controller.signal, body: abortedBody })
  assertSafe(await endpoint('save').handler(aborted.req), 400)
  assert.equal(cancelled, true)
})

test('create ingress rejects content whose public projection exceeds five MiB', async () => {
  const f = editorialFixture()
  const longText = 'x'.repeat(5 * 1024 * 1024)
  const data = { ...nativePage, body: [{ blockType: 'rich_text', content: { root: { type: 'root', children: [
    { type: 'paragraph', children: [{ type: 'text', text: longText, format: 0 }] },
  ] } } }] }
  request(f, { text: JSON.stringify({ id: null, data }) })
  assertSafe(await endpoint('save').handler(f.req), 413)
  assert.equal(f.calls.some(call => call.operation === 'begin'), false)
})

test('publication request has the smaller body cap and all errors are sanitized', async () => {
  const f = editorialFixture()
  request(f, { text: `${JSON.stringify({ id: pageID, expected_version_id: versionID, operation: 'publish' })}${' '.repeat(16 * 1024)}` })
  const response = await endpoint('publication').handler(f.req)
  assertSafe(response, 413)
  const error = await response.json() as Record<string, unknown>
  assert.deepEqual(Object.keys(error).sort(), ['error', 'message'])
  assert.equal(JSON.stringify(error).includes('portal_pages'), false)
  assert.equal(JSON.stringify(error).includes('stack'), false)
  assert.equal(JSON.stringify(error).includes('token'), false)
})

test('stream reader counts UTF-8 bytes even without Content-Length and releases on overflow', async () => {
  const f = editorialFixture()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('ááá')) },
    cancel() { cancelled = true },
  })
  const req = request(f, { body }) as PayloadRequest
  await assert.rejects(readEditorialJSON(req, 5), { status: 413 })
  assert.equal(cancelled, true)
})

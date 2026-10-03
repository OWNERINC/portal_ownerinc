import assert from 'node:assert/strict'
import test from 'node:test'
import { executeAuthStrategies, ValidationError, type Payload, type PayloadRequest } from 'payload'
import { createPortalStrategy } from '../../src/auth/portal-strategy'
import { createPortalClient, PortalAuthError } from '../../src/auth/portal-client'
import { canManageNews, readOwnEditor } from '../../src/auth/access'
import { assertEditorialOrigin, editorialCookieSettings } from '../../src/auth/cookie'
import { withEditorialBoundary } from '../../src/auth/rest-boundary'

const actor = { uid: 'a', email: 'a@example.test', name: null, canManageNews: true }
const resolution = { actor, expiresAt: '2030-01-01T00:00:00.000Z' }
const settings = { portalInternalURL: 'http://portal-api:3000', payloadToPortalSecret: 'synthetic-bridge-secret-'.repeat(2) }
const response = (value: unknown, status = 200) => Response.json(value, { status })

test('strategy re-resolves every request and never authorizes a persisted projection after revocation', async () => {
  let calls = 0
  const strategy = createPortalStrategy({
    cookieName: '__Host-ownerinc-editorial',
    resolve: async () => {
      calls++
      if (calls > 1) throw new PortalAuthError(401)
      return { actor: { uid: 'a', email: 'a@example.test', name: null, canManageNews: true }, expiresAt: '2030-01-01T00:00:00.000Z' }
    },
  })
  const payload = { find: async () => ({ docs: [{ id: 'projection-a', portalUid: 'a' }] }) } as unknown as Payload
  const headers = new Headers({ cookie: '__Host-ownerinc-editorial=synthetic-cookie' })
  const first = await strategy.authenticate({ payload, headers })
  assert.equal(first.user?.collection, 'portal-editors')
  const revoked = await strategy.authenticate({ payload, headers })
  assert.equal(revoked.user, null)
  assert.equal(revoked.responseHeaders?.get('x-ownerinc-auth-status'), '401')
  assert.equal(calls, 2)
})

test('projection creation copies only verified identity and recovers a concurrent unique conflict by rereading', async () => {
  let finds = 0
  const projection = { id: 'a-id', portalUid: 'a' }
  const payload = {
    async find(args: unknown) {
      assert.deepEqual(args, { collection: 'portal-editors', where: { portalUid: { equals: 'a' } }, limit: 1, overrideAccess: true })
      return { docs: ++finds > 1 ? [projection] : [] }
    },
    async create(args: unknown) {
      assert.deepEqual(args, { collection: 'portal-editors', overrideAccess: true, data: { portalUid: 'a', email: 'a@example.test', displayName: null } })
      throw new ValidationError({ collection: 'portal-editors', errors: [{ path: 'portalUid', message: 'Value must be unique' }] })
    },
  } as unknown as Payload
  const strategy = createPortalStrategy({ cookieName: '__Host-ownerinc-editorial', resolve: async () => resolution })
  const result = await strategy.authenticate({ payload, headers: new Headers({ cookie: '__Host-ownerinc-editorial=a' }) })
  assert.equal(result.user?.id, 'a-id')
  assert.equal(finds, 2)
  assert.deepEqual((result.user as unknown as { portalActor: unknown }).portalActor, actor)
})

test('unknown projection errors fail closed as dependency errors without reflecting error text', async () => {
  const strategy = createPortalStrategy({ cookieName: '__Host-ownerinc-editorial', resolve: async () => resolution })
  const payload = { find: async () => { throw new Error('private connection string') } } as unknown as Payload
  const result = await strategy.authenticate({ payload, headers: new Headers({ cookie: '__Host-ownerinc-editorial=a' }) })
  assert.equal(result.user, null)
  assert.equal(result.responseHeaders?.get('x-ownerinc-auth-status'), '503')
  assert.doesNotMatch(JSON.stringify([...result.responseHeaders!]), /private/)
})

test('strategy ignores Payload JWT, bridge secret and opposite-environment cookie; duplicates fail closed', async () => {
  let resolutions = 0
  const strategy = createPortalStrategy({ cookieName: '__Host-ownerinc-editorial', resolve: async () => { resolutions++; return resolution } })
  const payload = {} as Payload
  for (const headers of [new Headers(), new Headers({ authorization: 'Bearer synthetic-service-secret' }),
    new Headers({ cookie: 'payload-token=synthetic; ownerinc-editorial-dev=a' }),
    new Headers({ cookie: '__Host-ownerinc-editorial=a; __Host-ownerinc-editorial=b' })]) {
    assert.equal((await strategy.authenticate({ payload, headers })).user, null)
  }
  assert.equal(resolutions, 0)
})

test('access requires a verified runtime actor and scopes identity reads to the same account', async () => {
  for (const user of [null, { id: 'a-id', collection: 'portal-editors', portalUid: 'a', permissions: { superAdmin: true } },
    { id: 'a-id', collection: 'portal-editors', portalUid: 'b', portalActor: actor },
    { id: 'a-id', collection: 'other', portalUid: 'a', portalActor: actor }]) {
    assert.equal(canManageNews({ req: { user } as unknown as PayloadRequest }), false)
  }
  const req = { user: { id: 'a-id', collection: 'portal-editors', portalUid: 'a', portalActor: actor } } as unknown as PayloadRequest
  assert.equal(canManageNews({ req }), true)
  assert.deepEqual(await readOwnEditor({ req }), { id: { equals: 'a-id' } })
})

test('pinned executeAuthStrategies plus REST boundary preserve 503 instead of an anonymous 200', async () => {
  const strategy = createPortalStrategy({ cookieName: '__Host-ownerinc-editorial', resolve: async () => { throw new PortalAuthError(503) } })
  const payload = { authStrategies: [strategy] } as Payload
  const handler = withEditorialBoundary(async (request: Request) => {
    const result = await executeAuthStrategies({ payload, headers: request.headers, canSetHeaders: true })
    return Response.json({ user: result.user }, { headers: result.responseHeaders })
  }, 'https://portal.example.test')
  const result = await handler(new Request('https://portal.example.test/editorial/api/portal-editors/me', {
    headers: { cookie: '__Host-ownerinc-editorial=a' },
  }), undefined)
  assert.equal(result.status, 503)
  assert.deepEqual(await result.json(), { error: 'editorial_unavailable' })
  assert.equal(result.headers.get('Cache-Control'), 'no-store')
  assert.equal(result.headers.get('x-ownerinc-auth-status'), null)
})

test('origin enforcement rejects missing/nonexact/cross-site requests before native operations', async () => {
  let operations = 0
  const origin = 'https://portal.example.test'
  const handler = withEditorialBoundary(async () => { operations++; return response({ ok: true }) }, origin)
  const invalidHeaders: Record<string, string>[] = [{}, { origin: `${origin}/` }, { origin, 'sec-fetch-site': 'cross-site' }]
  for (const headers of invalidHeaders) {
    assert.equal((await handler(new Request(`${origin}/editorial/api/portal-editors/logout`, { method: 'POST', headers }), undefined)).status, 403)
    assert.throws(() => assertEditorialOrigin(new Headers(headers), origin), { status: 403 })
  }
  assert.equal(operations, 0)
  assert.equal((await handler(new Request(`${origin}/editorial/api/portal-editors/logout`, { method: 'POST', headers: { origin } }), undefined)).status, 200)
  assert.equal(operations, 1)
})

test('cookie names use exactly the same production/development boundary', () => {
  assert.equal(editorialCookieSettings('http://localhost:8080', 'development').name, 'ownerinc-editorial-dev')
  assert.equal(editorialCookieSettings('https://portal.example.test', 'development').name, '__Host-ownerinc-editorial')
  assert.throws(() => editorialCookieSettings('http://localhost:8080', 'production'), { status: 503 })
  assert.throws(() => editorialCookieSettings('http://portal.test', 'development'), { status: 503 })
})

test('internal client uses only dedicated headers, POST body, 5s signal, no-store and rejects redirects', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const client = createPortalClient(settings, async (url, init) => {
    calls.push({ url: String(url), init: init! })
    return response(resolution)
  })
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await client.resolvePortalEditor('synthetic-cookie'), resolution)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://portal-api:3000/api/internal/editorial/session/resolve')
  assert.equal(calls[0].init.body, JSON.stringify({ cookie: 'synthetic-cookie' }))
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(calls[0].init.headers, { Authorization: `Bearer ${settings.payloadToPortalSecret}`, 'Content-Type': 'application/json' })
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.cache, 'no-store')
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

for (const [status, reason, expected] of [
  [401, 'editorial_session_invalid', 401], [403, 'account-disabled', 403],
  [401, 'editorial_service_unauthorized', 503], [500, 'private upstream text', 503], [503, 'editorial_unavailable', 503],
] as const) test(`internal client translates ${status}/${reason} to ${expected} without upstream details`, async () => {
  const client = createPortalClient(settings, async () => response({ error: 'secret-cookie-value', reason }, status))
  await assert.rejects(client.resolvePortalEditor('secret-cookie-value'), error => {
    assert.ok(error instanceof PortalAuthError)
    assert.equal(error.status, expected)
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(String(error), /secret-cookie-value|private upstream text|Bearer/)
    return true
  })
})

test('internal client rejects malformed actor/expiry, expired session, mismatched job actor and invalid authority', async () => {
  for (const [value, status] of [
    [null, 503], [{ ...resolution, expiresAt: 'invalid' }, 503], [{ ...resolution, expiresAt: '2020-01-01T00:00:00.000Z' }, 401],
    [{ ...resolution, actor: { ...actor, uid: 1 } }, 503], [{ ...resolution, actor: { ...actor, canManageNews: false } }, 403],
  ] as const) await assert.rejects(createPortalClient(settings, async () => response(value)).resolvePortalEditor('a'), { status })
  await assert.rejects(createPortalClient(settings, async () => response({ actor })).checkPortalActor('b'), { status: 503 })
  await assert.rejects(createPortalClient(settings, async () => response({ mode: 'missing', epoch: 1 })).getAuthority(), { status: 503 })
  assert.deepEqual(await createPortalClient(settings, async () => response({ mode: 'payload', epoch: 2 })).getAuthority(), { mode: 'payload', epoch: 2 })
})

test('timeout aborts dependency resolution after five seconds and never retries', async () => {
  let calls = 0
  const started = Date.now()
  const client = createPortalClient(settings, async (_url, init) => {
    calls++
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('private transport text')), { once: true }))
  })
  await assert.rejects(client.resolvePortalEditor('a'), { status: 503 })
  assert.equal(calls, 1)
  assert.ok(Date.now() - started >= 4900)
})

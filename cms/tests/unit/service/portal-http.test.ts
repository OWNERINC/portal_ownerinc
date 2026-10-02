import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import test from 'node:test'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload, handleEndpoints, type Where } from 'payload'
import { createPortalEditors } from '../../../src/collections/PortalEditors'
import { createPortalClient } from '../../../src/auth/portal-client'
import { withEditorialBoundary } from '../../../src/auth/rest-boundary'

// Native Fetch HTTP handlers and Payload operations; DB adapter and Portal HTTP are doubles.
// No connect, listener, migration, real database or real Firebase is used here.
const origin = 'https://portal.example.test'
const environment = {
  portalPublicURL: origin, portalInternalURL: 'http://portal-api:3000',
  payloadToPortalSecret: 'fixture-payload-to-portal-'.repeat(2),
  portalToPayloadSecret: 'fixture-portal-to-payload-'.repeat(2),
  payloadSecret: 'fixture-payload-secret-'.repeat(2), databaseURL: 'postgresql://no-connection.invalid/editorial_test',
  uploadDir: path.resolve('fixture-no-uploads'),
}
function matches(doc: Record<string, unknown>, where: Where = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'and') return (value as Where[]).every(item => matches(doc, item))
    if (key === 'or') return (value as Where[]).some(item => matches(doc, item))
    const operation = value as { equals?: unknown; in?: unknown[] }
    return 'equals' in operation ? doc[key] === operation.equals : operation.in ? operation.in.includes(doc[key]) : true
  })
}
async function harness() {
  process.env.DISABLE_PAYLOAD_HMR = 'true'
  process.env.PAYLOAD_DISABLE_DEPENDENCY_CHECKER = 'true'
  const state = { revoked: false, unavailable: false, revokeUnavailable: false, denied: false, resolutions: 0, revocations: 0, writes: 0 }
  const client = createPortalClient(environment, async (url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${environment.payloadToPortalSecret}`)
    if (state.unavailable) return Response.json({ reason: 'editorial_unavailable' }, { status: 503 })
    if (String(url).endsWith('/session/revoke')) {
      if (state.revokeUnavailable) return Response.json({ reason: 'editorial_unavailable' }, { status: 503 })
      state.revoked = true
      state.revocations++
      return new Response(null, { status: 204 })
    }
    state.resolutions++
    const cookie = JSON.parse(init!.body as string).cookie
    if (state.revoked || !['a', 'b'].includes(cookie)) return Response.json({ reason: 'editorial_session_invalid' }, { status: 401 })
    if (state.denied) return Response.json({ reason: 'editorial_permission_denied' }, { status: 403 })
    return Response.json({ actor: { uid: cookie, email: `${cookie}@example.test`, name: cookie, canManageNews: true }, expiresAt: '2030-01-01T00:00:00.000Z' })
  })
  const adapter = postgresAdapter({ pool: { connectionString: environment.databaseURL }, idType: 'uuid', push: false })
  const config = await buildConfig({
    secret: environment.payloadSecret, serverURL: origin, routes: { admin: '/editorial/admin', api: '/editorial/api' },
    admin: { user: 'portal-editors', importMap: { autoGenerate: false } },
    collections: [createPortalEditors(environment, client)], graphQL: { disable: true },
    typescript: { autoGenerate: false }, telemetry: false, jobs: { autoRun: [] },
    logger: { options: { level: 'silent' } },
    db: { ...adapter, init: args => {
      const db = adapter.init(args)
      db.connect = async () => { throw new Error('Real DB connection forbidden in this test') }
      return db
    } },
  })
  const key = randomUUID()
  const payload = await getPayload({ config, key, disableDBConnect: true, disableOnInit: true })
  const docs: Record<string, unknown>[] = []
  payload.db.beginTransaction = async () => null
  payload.db.find = (async ({ collection, where, limit = 10 }: Parameters<typeof payload.db.find>[0]) => {
    assert.equal(collection, 'portal-editors')
    const found = docs.filter(doc => matches(doc, where))
    return { docs: structuredClone(found.slice(0, limit)), totalDocs: found.length, limit, page: 1, totalPages: 1, pagingCounter: 1,
      hasPrevPage: false, hasNextPage: false, nextPage: null, prevPage: null }
  }) as typeof payload.db.find
  payload.db.findOne = (async ({ collection, where }: Parameters<typeof payload.db.findOne>[0]) => {
    assert.equal(collection, 'portal-editors')
    return structuredClone(docs.find(doc => matches(doc, where)) || null)
  }) as typeof payload.db.findOne
  payload.db.create = async ({ collection, data }) => {
    assert.equal(collection, 'portal-editors')
    state.writes++
    const doc = { ...data, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    docs.push(doc)
    return structuredClone(doc)
  }
  const handler = withEditorialBoundary((request: Request) => handleEndpoints({ config, payloadInstanceCacheKey: key, request }), origin)
  const call = (pathname: string, method = 'GET', cookie?: string, body?: unknown, headers: Record<string, string> = { origin }) => handler(
    new Request(`${origin}/editorial/api${pathname}`, {
      method, headers: { ...headers, ...(cookie ? { cookie: `__Host-ownerinc-editorial=${cookie}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), undefined,
  )
  return { call, state, docs, payload }
}

test('native HTTP rejects direct create/first-user/password/refresh APIs, even with a service secret or forged body actor', async () => {
  const { call, state } = await harness()
  const body = { email: 'a@example.test', password: 'synthetic-password', portalUid: 'a', portalActor: { canManageNews: true } }
  for (const pathname of ['/portal-editors', '/portal-editors/first-register', '/portal-editors/login',
    '/portal-editors/forgot-password', '/portal-editors/reset-password', '/portal-editors/unlock']) {
    const result = await call(pathname, 'POST', undefined, body, { origin, authorization: `Bearer ${environment.payloadToPortalSecret}` })
    assert.equal(result.status, 403, `${pathname}: ${await result.text()}`)
    assert.equal(result.headers.get('set-cookie'), null)
  }
  assert.equal(state.writes, 0)
  for (const pathname of ['/portal-editors', '/portal-editors/refresh-token']) {
    const result = await call(pathname, 'POST', 'a', body)
    assert.equal(result.status, 403, `${pathname}: ${await result.text()}`)
  }
  assert.equal(state.writes, 1, 'only the verified projection may be created')
})

test('native HTTP authenticates /me, scopes reads by account, denies writes and rechecks permissions on each request', async () => {
  const { call, state, docs } = await harness()
  const me = await call('/portal-editors/me', 'GET', 'a')
  assert.equal(me.status, 200, await me.clone().text())
  const result = await me.json()
  assert.equal(result.user.portalUid, 'a')
  assert.equal(result.token, undefined)
  assert.equal(result.exp, Date.parse('2030-01-01T00:00:00.000Z') / 1000)
  assert.equal(me.headers.get('cache-control'), 'no-store')
  await call('/portal-editors/me', 'GET', 'b')
  const other = docs.find(doc => doc.portalUid === 'b')!
  const own = docs.find(doc => doc.portalUid === 'a')!
  const list = await call('/portal-editors', 'GET', 'a')
  assert.deepEqual((await list.json()).docs.map((doc: { portalUid: string }) => doc.portalUid), ['a'])
  assert.equal((await call(`/portal-editors/${other.id}`, 'GET', 'a')).status, 404)
  const update = await call(`/portal-editors/${own.id}`, 'PATCH', 'a', { portalUid: 'b', portalActor: { canManageNews: true } })
  assert.equal(update.status, 403, await update.text())
  assert.equal((await call(`/portal-editors/${own.id}`, 'DELETE', 'a')).status, 403)
  state.denied = true
  assert.equal((await call('/portal-editors/me', 'GET', 'a')).status, 403)
  state.denied = false
  state.revoked = true
  assert.equal((await call('/portal-editors/me', 'GET', 'a')).status, 401)
  state.revoked = false
  state.unavailable = true
  assert.equal((await call('/portal-editors/me', 'GET', 'a')).status, 503)
  assert.equal(state.resolutions, 8)
})

test('native HTTP guards Origin, confirms logout revocation before expiring cookie, and has no GraphQL endpoint', async () => {
  const { call, state } = await harness()
  assert.equal((await call('/portal-editors/logout', 'POST', 'a', {}, {})).status, 403)
  assert.equal((await call('/portal-editors/logout', 'POST', 'a', {}, { origin: `${origin}/` })).status, 403)
  assert.equal((await call('/portal-editors/logout', 'POST', 'a', {}, { origin, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal(state.resolutions, 0)
  state.revokeUnavailable = true
  const refusedLogout = await call('/portal-editors/logout', 'POST', 'a')
  assert.equal(refusedLogout.status, 503)
  assert.equal(refusedLogout.headers.get('set-cookie'), null)
  assert.equal(state.revocations, 0)
  state.revokeUnavailable = false
  const logout = await call('/portal-editors/logout', 'POST', 'a')
  assert.equal(logout.status, 200, await logout.clone().text())
  assert.equal(state.revocations, 1)
  assert.match(logout.headers.get('set-cookie') || '', /__Host-ownerinc-editorial=; Path=\/; Max-Age=0; HttpOnly; SameSite=Lax; Secure/)
  assert.equal((await call('/portal-editors/me', 'GET', 'a')).status, 401)
  state.revoked = false
  state.unavailable = true
  const failedLogout = await call('/portal-editors/logout', 'POST', 'a')
  assert.equal(failedLogout.status, 503)
  assert.equal(failedLogout.headers.get('set-cookie'), null)
  state.unavailable = false
  for (const pathname of ['/graphql', '/graphql-playground']) {
    assert.equal((await call(pathname)).status, 404)
    assert.equal((await call(pathname, 'POST', undefined, { query: '{ __schema { types { name } } }' })).status, 404)
  }
})

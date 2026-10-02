import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server.js'
// The installed 16.3.8 public testing export still uses this name, despite the guide's rename.
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server.js'
import { config, proxy } from '../../../src/proxy'

const origin = 'https://portal.example.test'
const nativeRoot = await readFile(new URL('../../../node_modules/@payloadcms/next/dist/layouts/Root/index.js', import.meta.url), 'utf8')
const start = nativeRoot.indexOf('async function switchLanguageServerAction(')
const end = nativeRoot.indexOf('\n  const navPrefs', start)
assert.ok(start >= 0 && end > start, 'fixture must execute the installed native action, not a copied implementation')
// Extract only the pinned framework's action closure. Next's cookie-store dependency
// is supplied with real NextResponse cookies. This is an offline dispatch fixture,
// not a running Next/RSC transport or Firebase/PostgreSQL acceptance test.
const nativeAction = new Function('nextCookies', 'config', `${nativeRoot.slice(start, end)}\nreturn switchLanguageServerAction;`) as
  (cookies: () => Promise<NextResponse['cookies']>, config: { cookiePrefix: string }) => (lang: string) => Promise<void>

test('Next proxy blocks all native action dispatch paths before cookie mutation and preserves the valid action', async t => {
  const before = { origin: process.env.PORTAL_PUBLIC_URL, nodeEnv: process.env.NODE_ENV }
  Object.assign(process.env, { PORTAL_PUBLIC_URL: origin, NODE_ENV: 'production' })
  t.after(() => {
    if (before.origin === undefined) delete process.env.PORTAL_PUBLIC_URL
    else process.env.PORTAL_PUBLIC_URL = before.origin
    if (before.nodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
    else Object.assign(process.env, { NODE_ENV: before.nodeEnv })
  })
  let dispatches = 0
  async function dispatch(pathname: string, headers: Record<string, string>, fetchAction = true) {
    const request = new NextRequest(`${origin}${pathname}`, { method: 'POST', headers: {
      ...headers, ...(fetchAction ? { 'next-action': 'fixture-native-language-action' } : {}),
    } })
    assert.equal(unstable_doesMiddlewareMatch({ config, url: request.url, headers: Object.fromEntries(request.headers) }), true)
    const boundary = proxy(request)
    if (boundary.headers.get('x-middleware-next') !== '1') return boundary
    dispatches++
    const response = NextResponse.json({ language: 'pt' })
    await nativeAction(async () => response.cookies, { cookiePrefix: 'payload' })('pt')
    return response
  }

  const denied: Record<string, string>[] = [
    {}, { origin: 'http://portal.example.test' }, { origin: `${origin}/` }, { origin: 'https://other.example.test' },
    { origin, 'sec-fetch-site': 'cross-site' },
    { origin: 'http://portal.example.test', 'x-forwarded-host': 'portal.example.test', 'x-forwarded-proto': 'https' },
  ]
  for (const pathname of ['/editorial/admin', '/editorial/admin/account', '/editorial/admin/login']) {
    for (const headers of denied) {
      for (const fetchAction of [true, false]) {
        const response = await dispatch(pathname, headers, fetchAction)
        assert.equal(response.status, 403)
        assert.equal(response.headers.get('set-cookie'), null)
        assert.deepEqual(response.cookies.getAll(), [])
        assert.equal(response.headers.get('cache-control'), 'no-store')
      }
    }
  }
  assert.equal(dispatches, 0)
  for (const fetchAction of [true, false]) {
    const accepted = await dispatch('/editorial/admin/account', { origin, 'sec-fetch-site': 'same-origin' }, fetchAction)
    assert.equal(accepted.status, 200)
    assert.equal(accepted.cookies.get('payload-lng')?.value, 'pt')
    assert.match(accepted.headers.get('set-cookie') || '', /payload-lng=pt; Path=\//)
  }
  assert.equal(dispatches, 2)

  delete process.env.PORTAL_PUBLIC_URL
  const unconfigured = await dispatch('/editorial/admin', { origin })
  assert.equal(unconfigured.status, 503)
  assert.equal(unconfigured.headers.get('set-cookie'), null)
  assert.equal(dispatches, 2)
})

test('static Next matcher covers the complete editorial namespace regardless of action headers', () => {
  for (const path of ['/editorial', '/editorial/', '/editorial/admin', '/editorial/admin/account',
    '/editorial/admin/collections/portal-editors', '/editorial/api/portal-editors/logout', '/editorial/ready']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: `${origin}${path}` }), true, path)
  }
  for (const path of ['/', '/announcements.html', '/_next/static/test.js', '/api/cms/session', '/editorial-other']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: `${origin}${path}` }), false, path)
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const response = proxy(new NextRequest(`${origin}/editorial/admin`, { method }))
    assert.equal(response.headers.get('x-middleware-next'), '1')
    assert.equal(response.headers.get('set-cookie'), null)
  }
})

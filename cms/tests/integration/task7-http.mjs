// Real loopback Next proxy + Payload REST + PostgreSQL, and real Express transport.
// Firebase token verification is explicitly doubled; current Express policy is real.
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire, Module } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import net from 'node:net'
const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = process.env.TASK7_PRIVATE_DIR || ''
const cmsURL = new URL(process.env.CMS_DATABASE_URL || 'http://invalid'), portalURL = new URL(process.env.TASK7_PORTAL_DATABASE_URL || 'http://invalid')
if (process.env.TASK7_DISPOSABLE !== 'cms_task7_test' || cmsURL.hostname !== '127.0.0.1' || cmsURL.port !== '55441' || cmsURL.pathname !== '/cms_task7_test' ||
  portalURL.hostname !== '127.0.0.1' || portalURL.port !== '55441' || portalURL.pathname !== '/portal_task7_test' ||
  path.dirname(directory) !== path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode') || !path.basename(directory).startsWith('ownerinc-task7-')) throw new Error('Refusing non-disposable Task7 environment')
const fixture = JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8'))
const require = createRequire(path.join(root, 'api/package.json')), { Client, Pool } = require('pg'), express = require('express')
const { createNewsBackend } = require('./owner-news/backend'), { createPayloadNewsClient } = require('./owner-news/payload-client')
const db = new Client({ connectionString: process.env.CMS_DATABASE_URL }), pool = new Pool({ connectionString: process.env.TASK7_PORTAL_DATABASE_URL })
await db.connect()
const origin = 'http://127.0.0.1:18087'
const probe = net.createServer(); probe.listen(18087, '127.0.0.1'); await once(probe, 'listening'); await new Promise(resolve => probe.close(resolve))
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '18087'], { cwd: path.join(root, 'cms'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = '', server
child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
const actor = { ...fixture.actor, canManageNews: false }, editor = fixture.actor
const serviceHeaders = { Authorization: `Bearer ${process.env.PORTAL_TO_PAYLOAD_SECRET}`, 'Content-Type': 'application/json', 'X-Request-ID': 'task7-real-http' }
const post = (action, input, who = actor, headers = {}, suffix = '') => fetch(`${origin}/editorial/api/portal-news/${action}${suffix}`, { method: 'POST', headers: { ...serviceHeaders, ...headers }, body: JSON.stringify({ actor: who, input }), redirect: 'error' })
const okJSON = async response => { assert.equal(response.status, 200, await response.clone().text()); return response.json() }
const snapshot = async () => {
  const tables = ['news_articles', '_news_articles_v', 'news_home', '_news_home_v', 'news_media', 'legacy_news_revisions', 'news_schedules', 'news_audit', 'portal_editors', 'payload_jobs']
  const result = []
  for (const table of tables) result.push((await db.query(`SELECT coalesce(md5(string_agg(row_to_json(t)::text,',' ORDER BY id)),'empty') AS hash FROM ${table} t`)).rows[0].hash)
  return result
}
try {
  let ready = false
  for (let i = 0; i < 120; i++) { if (child.exitCode !== null) throw new Error('Task7 Next exited'); try { ready = (await fetch(`${origin}/editorial/ready`, { signal: AbortSignal.timeout(1000) })).ok } catch {}; if (ready) break; await delay(250) }
  assert.equal(ready, true)
  const before = await snapshot()
  assert.equal((await okJSON(await post('detail', { id: fixture.articleId }, editor))).title, 'Publication A')
  assert.equal((await okJSON(await post('preview', { id: fixture.articleId, versionId: fixture.versionB, source: 'payload' }, editor))).title, 'Draft B')
  assert.equal((await post('preview', { id: fixture.articleId, versionId: fixture.versionB, source: 'payload' })).status, 403)
  assert.equal((await post('preview', { id: fixture.secondId, versionId: fixture.versionB, source: 'payload' }, editor)).status, 404)
  assert.equal((await okJSON(await post('preview', { id: fixture.legacyDocumentId, versionId: fixture.legacyRevisionId, source: 'legacy' }, editor))).title, 'Legacy original')
  assert.equal((await post('preview', { id: fixture.articleId, versionId: fixture.legacyRevisionId, source: 'legacy' }, editor)).status, 404)
  assert.equal((await post('preview', { id: fixture.legacyDocumentId, versionId: fixture.legacyRevisionId, source: 'payload' }, editor)).status, 404)
  const page = await okJSON(await post('list', { limit: 1, offset: 0, category: '' }))
  assert.equal(page.count, 1); assert.equal(page.rows[0].id, fixture.secondId)
  assert.deepEqual(await okJSON(await post('categories', { withCounts: true })), { total: 3, categories: [{ name: 'Edition', count: 1 }, { name: 'News', count: 1 }] })
  assert.equal((await post('detail', { id: fixture.invalidId })).status, 404)
  assert.equal((await post('navigation', { id: fixture.invalidId })).status, 404)
  assert.deepEqual(await okJSON(await post('navigation', { id: fixture.editionId })), { previous: null, next: null })
  assert.equal((await okJSON(await post('home', {}))).content.headline, 'Home A')
  console.log('PASS actual Next POST: current published A/editor, B exact preview, legacy original IDs, invalid exclusion, total, category, navigation, home')
  const invalidEnums = [
    ...[['article'], ['edition'], [['article']], {}, { value: 'article' }, { toString: 'article' }].flatMap(kind => [
      ['list', { limit: 10, offset: 0, kind }], ['categories', { withCounts: true, kind }],
    ]),
    ...[['legacy'], ['payload'], [['legacy']], {}, { value: 'legacy' }, { toString: 'legacy' }].map(source =>
      // Valid native IDs reproduce I1: ['legacy'] must NOT select native Draft B.
      ['preview', { id: fixture.articleId, versionId: fixture.versionB, source }]),
  ]
  // First expose the original wrong-200 bug without a lock masking its result.
  for (const [action, input] of invalidEnums) {
    const response = await post(action, input, editor)
    assert.equal(response.status, 400, `I1 ${action} must reject ${JSON.stringify(input)}`)
    assert.deepEqual(await response.json(), { error: 'invalid_request' })
  }
  await db.query('BEGIN')
  try {
    await db.query("SET LOCAL lock_timeout = '1s'")
    await db.query('SELECT pg_advisory_xact_lock(7194030)')
    await db.query('LOCK TABLE news_articles, _news_articles_v, legacy_news_revisions IN ACCESS EXCLUSIVE MODE')
    // The live request cannot complete a content read from either store while
    // these locks are held. 400s must arrive without waiting for their release.
    for (const [action, input] of invalidEnums) {
      const response = await fetch(`${origin}/editorial/api/portal-news/${action}`, { method: 'POST', headers: serviceHeaders,
        body: JSON.stringify({ actor: editor, input }), redirect: 'error', signal: AbortSignal.timeout(1500) })
      assert.equal(response.status, 400, `I1 ${action} must validate before content queries`)
      assert.deepEqual(await response.json(), { error: 'invalid_request' })
    }
  } finally { await db.query('ROLLBACK') }
  console.log('PASS I1 actual Next: 18 array/object enum cases =>400; repeated with both content stores + reference lock held, before queries')
  for (const headers of [{ Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${process.env.PAYLOAD_TO_PORTAL_SECRET}` }, { Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'cross-site' }, { Cookie: 'anything=x' }, { Origin: origin }]) assert.equal((await post('home', {}, actor, headers)).status, 403)
  assert.equal((await post('home', { draft: true })).status, 400)
  assert.equal((await post('list', { limit: 101, offset: 0 })).status, 400)
  assert.equal((await post('home', {}, { ...actor, role: 'admin' })).status, 400)
  assert.equal((await post('home', {}, actor, {}, '?draft=true')).status, 403)
  const extra = await fetch(`${origin}/editorial/api/portal-news/home`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ actor, input: {}, extra: true }) })
  assert.equal(extra.status, 400)
  assert.equal((await fetch(`${origin}/editorial/api/portal-news/home`, { method: 'POST', headers: serviceHeaders, body: '{' })).status, 400)
  assert.equal((await fetch(`${origin}/editorial/api/portal-news/home`, { method: 'POST', headers: serviceHeaders, body: ' '.repeat(17000) })).status, 400)
  for (const endpoint of ['news-articles', 'legacy-news-revisions', 'portal-editors']) {
    assert.equal((await fetch(`${origin}/editorial/api/${endpoint}`, { method: 'POST', headers: serviceHeaders, body: '{}' })).status, 403)
    assert.equal([401, 403].includes((await fetch(`${origin}/editorial/api/${endpoint}`, { method: 'POST', headers: { ...serviceHeaders, Origin: origin }, body: '{}' })).status), true)
    const response = await fetch(`${origin}/editorial/api/${endpoint}`, { headers: serviceHeaders }); assert.equal([401, 403].includes(response.status), true)
  }
  assert.equal((await fetch(`${origin}/editorial/admin`, { method: 'POST', headers: serviceHeaders, body: '{}' })).status, 403)
  console.log('PASS actual Next proxy + REST: secret/opposite secret/cross-site/cookie/extras/oversized JSON denied; no generic collection/admin login bypass')
  const range = await post('asset', { id: fixture.mediaId, preview: false, range: 'bytes=0-4' })
  assert.equal(range.status, 206); assert.equal(await range.text(), '%PDF-'); assert.equal(range.headers.get('content-range'), `bytes 0-4/${fixture.mediaSize}`)
  const unsatisfied = await post('asset', { id: fixture.mediaId, preview: false, range: 'bytes=999999-' })
  assert.equal(unsatisfied.status, 416); assert.equal(unsatisfied.headers.get('content-range'), `bytes */${fixture.mediaSize}`)
  assert.equal((await post('asset', { id: fixture.mediaId, preview: true, range: null })).status, 403)
  const controller = new AbortController()
  const stream = await fetch(`${origin}/editorial/api/portal-news/asset`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ actor: editor, input: { id: fixture.largeMediaId, preview: true, range: null } }), signal: controller.signal })
  assert.equal(stream.status, 200)
  const streamReader = stream.body.getReader(), chunk = await streamReader.read()
  assert.ok(chunk.value.byteLength > 0 && chunk.value.byteLength < fixture.largeMediaSize, 'abort occurs before consuming the 8MiB file')
  controller.abort(); await streamReader.cancel().catch(() => {})
  assert.equal((await post('asset', { id: fixture.mediaId, preview: false, range: 'bytes=0-4' })).status, 206)
  console.log('PASS actual Next asset range/416/preview permission/client abort + subsequent range')
  const filename = path.join(process.env.CMS_UPLOAD_DIR, fixture.filename)
  await rename(filename, `${filename}.held`)
  try { for (const [action, input] of [['list', { limit: 24, offset: 0 }], ['categories', { withCounts: true }], ['asset', { id: fixture.mediaId, preview: false, range: null }]]) assert.equal((await post(action, input)).status, 503) }
  finally { await rename(`${filename}.held`, filename) }
  assert.deepEqual(await snapshot(), before, 'read-only POST operations must not mutate content/versions/audit/editor identity/jobs')
  console.log('PASS storage file missing =>503, no empty feed; all private POSTs nonmutating in actual DB')
  // Real Express factory and the actual HTTP client, with only Firebase middleware doubled.
  const routePath = path.join(root, 'api/routes/announcements.js'), mod = new Module(routePath), routeRequire = createRequire(routePath)
  const authenticate = (req, res, next) => {
    if (!['Bearer reader', 'Bearer editor'].includes(req.get('Authorization'))) return res.sendStatus(401)
    req.id = 'task7-real-express'; req.user = { ...actor, role: req.get('Authorization') === 'Bearer editor' ? 'admin' : 'employee', permissions: { manageKnowledge: req.get('Authorization') === 'Bearer editor' } }; next()
  }
  mod.require = name => name === '../db' ? pool : name === '../middleware/auth' ? { authMiddleware: authenticate } : name === './owner-news-polls' ? express.Router() : routeRequire(name)
  mod._compile(readFileSync(routePath, 'utf8'), routePath)
  const backend = createNewsBackend({ pool, payloadClient: createPayloadNewsClient({ baseURL: origin, secret: process.env.PORTAL_TO_PAYLOAD_SECRET }) })
  const app = express(); app.use('/api/announcements', mod.exports.createAnnouncementsRouter({ backend, authenticate }))
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const apiURL = `http://127.0.0.1:${server.address().port}/api/announcements`
  const get = (suffix, who = 'reader', headers = {}) => fetch(`${apiURL}${suffix}`, { headers: { Authorization: `Bearer ${who}`, ...headers } })
  const list = await get('?limit=1&category='); assert.equal(list.status, 200); assert.equal(list.headers.get('x-total-count'), '1')
  assert.equal((await (await get(`/${fixture.articleId}`, 'editor')).json()).title, 'Publication A')
  assert.equal((await (await get(`/preview/${fixture.articleId}?version=${fixture.versionB}`, 'editor')).json()).title, 'Draft B')
  assert.equal((await get(`/preview/${fixture.articleId}?version=${fixture.versionB}`)).status, 403)
  const asset = await get(`/assets/${fixture.mediaId}`, 'reader', { Range: 'bytes=0-4' }); assert.equal(asset.status, 206); assert.equal(await asset.text(), '%PDF-')
  await pool.query("UPDATE owner_news_authority SET mode='payload_frozen', epoch=epoch+1")
  assert.equal((await get('/home')).status, 200)
  await pool.query('DELETE FROM owner_news_authority')
  assert.equal((await get('/home')).status, 503)
  await pool.query("INSERT INTO owner_news_authority VALUES(true,'payload',3)")
  console.log('PASS real Express→HTTP→Next→CMS PostgreSQL, real Portal authority DB refreshed; Firebase middleware alone doubled')
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await pool.end(); await db.end()
  if (process.platform === 'win32' && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill()
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  for (const name of ['PAYLOAD_SECRET', 'PORTAL_TO_PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET']) log = log.split(process.env[name]).join('[redacted]')
  await writeFile(path.join(directory, 'next-http.log'), log.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]'), { mode: 0o600 })
  console.log('Task7 own loopback children stopped')
}

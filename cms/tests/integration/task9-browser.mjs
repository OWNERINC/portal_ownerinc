// Real Next/Payload/Express, original poll/session SQL and audit. ONLY Firebase
// provider identity/browser SDK and the Nginx hosting layer are local doubles.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { connect } from 'node:net'
const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = process.env.TASK9_PRIVATE_DIR || '', base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode')
for (const [key, name, role] of [['CMS_DATABASE_URL', 'cms_task9_test', 'cms_runtime'], ['TASK9_PORTAL_DATABASE_URL', 'portal_task9_test', 'portal_api']]) {
  const url = new URL(process.env[key] || 'http://invalid')
  if (url.hostname !== '127.0.0.1' || url.port !== '55441' || url.pathname !== `/${name}` || url.username !== role) throw new Error('Wrong Task9 database')
}
if (path.dirname(directory) !== base || !path.basename(directory).startsWith('ownerinc-task9-') || process.env.PORTAL_PUBLIC_URL !== 'http://127.0.0.1:19091' || process.env.PORTAL_INTERNAL_URL !== 'http://127.0.0.1:19091') throw new Error('Wrong Task9 environment')
const require = createRequire(path.join(root, 'api/package.json')), express = require('express'), { Pool } = require('pg')
const db = new Pool({ connectionString: process.env.TASK9_PORTAL_DATABASE_URL }), origin = process.env.PORTAL_PUBLIC_URL, nextOrigin = 'http://127.0.0.1:19092'
const { createEditorialInternalRouter } = require('./routes/editorial-internal'), { createEditorialSessionRouter } = require('./routes/editorial-session')
const { loadActivePortalUser } = require('./middleware/active-user')
let counter = Date.now(), deny = false, failedDelete = false
const firebaseAuth = {
  async verifyIdToken(uid) { if (uid !== 'task9-editor') throw new Error('invalid'); return { uid, email_verified: true } },
  async createSessionCookie(uid) { return `${uid}.${++counter}` },
  async verifySessionCookie(cookie, revoked) { assert.equal(revoked, true); if (!cookie.startsWith('task9-editor.')) throw new Error('invalid'); return { uid: cookie.split('.')[0], email_verified: true } },
  async getUser(uid) { return { uid, disabled: false, emailVerified: true } },
}
// Execute the existing middleware factory with a Firebase initialization double.
const filename = path.join(root, 'api/middleware/auth.js'), authModule = { exports: {} }, localRequire = createRequire(filename)
new Function('require', 'module', 'exports', await readFile(filename, 'utf8'))(name => name === 'firebase-admin/app' ? { getApps: () => [1] } : name === 'firebase-admin/auth' ? { getAuth: () => firebaseAuth } : name === '../db' ? db : localRequire(name), authModule, authModule.exports)
const app = express()
app.use((req, res, next) => { req.id = 'task9-local'; next() })
app.use('/api/cms/session', (req, res, next) => {
  if (req.method === 'DELETE' && failedDelete) return res.status(503).json({ reason: 'editorial_unavailable' })
  if (req.method === 'GET' && deny) return res.status(403).json({ reason: 'editorial_permission_denied' })
  next()
}, createEditorialSessionRouter({ db, firebaseAuth, createAuthMiddleware: authModule.exports.createAuthMiddleware }))
app.use('/api/internal/editorial', createEditorialInternalRouter({ db, firebaseAuth }))
app.get('/api/users/me', async (req, res) => res.json(await loadActivePortalUser(db, { uid: 'task9-editor', email_verified: true })))
const firebaseModule = `const listeners=new Set(); const user=()=>{const uid=localStorage.getItem('task9-uid');return uid?{uid,getIdToken:async()=>uid}:null};
export const auth={currentUser:user(),authStateReady:async()=>{},app:{name:'[DEFAULT]',options:{apiKey:'task9'}}};
export function onAuthStateChanged(_,fn){listeners.add(fn);queueMicrotask(()=>fn(auth.currentUser));return()=>listeners.delete(fn)};
globalThis.task9Account=uid=>{if(uid)localStorage.setItem('task9-uid',uid);else localStorage.removeItem('task9-uid');auth.currentUser=user();listeners.forEach(fn=>fn(auth.currentUser))};
window.addEventListener('storage',event=>{if(event.key==='task9-uid'){auth.currentUser=user();listeners.forEach(fn=>fn(auth.currentUser))}});
export async function signOut(){globalThis.task9Signs=(globalThis.task9Signs||[]).concat(auth.currentUser?.uid);task9Account(null)};export async function updateProfile(){};`
app.get('/js/firebase-config.js', (req, res) => res.type('js').send(firebaseModule))
app.use(['/editorial', '/_next', '/__nextjs_font'], async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const headers = { ...req.headers, host: '127.0.0.1:19092' }; delete headers.connection
    const response = await fetch(`${nextOrigin}${req.originalUrl}`, { method: req.method, headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}), redirect: 'manual' })
    res.status(response.status); response.headers.forEach((value, key) => { if (!['transfer-encoding', 'content-encoding', 'content-length'].includes(key)) res.set(key, value) })
    res.send(Buffer.from(await response.arrayBuffer()))
  } catch { res.sendStatus(502) }
})
app.use(express.static(path.join(root, 'public')))
let server, child, browser, log = ''
async function cleanup() {
  await browser?.close(); browser = null
  if (child && child.exitCode === null) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); else child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)) }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await db.end()
}
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)) }, process.argv[2] === '--http' ? 200000 : 155000)
try {
  server = await new Promise((resolve, reject) => { const server = app.listen(19091, '127.0.0.1', () => resolve(server)); server.once('error', reject) })
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/_next/hmr')) { socket.destroy(); return }
    const upstream = connect(19092, '127.0.0.1', () => {
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  try { await fetch(`${nextOrigin}/editorial/ready`, { signal: AbortSignal.timeout(500) }); throw new Error('Task9 Next port occupied') } catch (error) { if (error.message === 'Task9 Next port occupied') throw error }
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '19092'], { cwd: path.join(root, 'cms'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  let ready = false
  for (let i = 0; i < 120; i++) { try { ready = (await fetch(`${nextOrigin}/editorial/ready`, { signal: AbortSignal.timeout(1000) })).ok } catch {} if (ready) break; await delay(250) }
  assert.ok(ready)
  const { chromium } = createRequire(path.join(base, 'package.json'))('playwright')
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); context.setDefaultTimeout(15000)
  await context.addInitScript(() => { if (!localStorage.getItem('task9-initialized')) { localStorage.setItem('task9-initialized', '1'); localStorage.setItem('task9-uid', 'task9-editor') } })
  await context.route('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js', route => route.fulfill({ contentType: 'text/javascript', body: `export {onAuthStateChanged,signOut,updateProfile} from '${origin}/js/firebase-config.js'` }))
  const page = await context.newPage(), errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.stack) })
  page.on('console', event => { if (event.type() === 'error') console.error('Browser console:', event.text()) })
  page.on('requestfailed', request => console.error('Request failed:', new URL(request.url()).pathname, request.failure()?.errorText))
  page.on('response', response => { const pathname = new URL(response.url()).pathname; if (pathname === '/api/cms/session' || pathname === '/js/editorial-session-watch.js') console.log('Session transport:', response.status(), response.request().method(), pathname) })
  await page.goto(`${origin}/editorial-entry.html`); await page.getByRole('button', { name: 'Abrir no Payload', exact: true }).click()
  await page.waitForURL(`${origin}/editorial/admin`)
  await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor()
  if (await page.locator('.nav-toggler:not(.nav-toggler--is-open)').count()) await page.locator('.nav-toggler:not(.nav-toggler--is-open)').first().click()
  await page.getByRole('link', { name: 'Enquetes', exact: true }).click()
  await page.getByRole('button', { name: 'Nova enquete', exact: true }).waitFor()
  console.log('PASS Portal entry -> real session issuance -> native same-account watch -> polls workspace (Firebase SDK/provider doubles)')
  if (process.argv[2] === '--http') {
    const call = (method, suffix = '', data) => context.request.fetch(`${origin}/editorial/api/portal-polls${suffix}`, { method, headers: { Origin: origin }, data })
    // Preserve prior runs: close only this dedicated Task9 database's open fixture.
    await db.query("UPDATE owner_news_polls SET status='closed' WHERE status='open'")
    const draft = { title: 'Task9 HTTP', question: 'Qual opção?', description: '', closing: '', options: ['A', 'B'] }
    const first = await call('POST', '', draft), second = await call('POST', '', { ...draft, title: 'Task9 concurrent' })
    assert.equal(first.status(), 201, await first.text()); assert.equal(second.status(), 201, await second.text())
    const a = await first.json(), b = await second.json()
    const results = await Promise.all([a, b].map(poll => call('POST', `/${poll.id}/publish`, { expected_version: poll.version })))
    assert.deepEqual(results.map(response => response.status()).sort(), [200, 409]); const winnerIndex = results.findIndex(result => result.status() === 200), winner = [a, b][winnerIndex]
    assert.equal((await call('POST', `/${winner.id}/publish`, { expected_version: winner.version })).status(), 409)
    const listed = await call('GET', '?limit=20&offset=0'); assert.equal(listed.status(), 200); assert.ok(Number(listed.headers()['x-total-count']) >= 2)
    for (const suffix of ['?url=https://outside', '?limit=100', '?limit=20&limit=20', '/%2f']) assert.ok((await call('GET', suffix)).status() >= 400)
    assert.equal((await context.request.post(`${origin}/editorial/api/portal-polls`, { data: draft })).status(), 403)
    await db.query(`UPDATE users SET permissions='{}' WHERE uid='task9-editor'`)
    assert.equal((await call('GET')).status(), 403)
    await db.query(`UPDATE users SET permissions='{"manageKnowledge":true}' WHERE uid='task9-editor'`)
    const audits = await db.query("SELECT actor_uid,action FROM audit_log WHERE target_type='owner_news_poll'")
    assert.ok(audits.rows.length >= 3); assert.ok(audits.rows.every(row => row.actor_uid === 'task9-editor'))
    console.log('PASS real HTTP proxy + PostgreSQL: same-domain create, two competing publications, replay 409, total, Origin, allowlist, current permission and audit actor')
  } else {
    await page.getByRole('button', { name: 'Nova enquete', exact: true }).click()
    await page.getByLabel('Título', { exact: false }).fill('Task9 browser')
    await page.getByLabel('Pergunta', { exact: false }).fill('Escolha uma opção')
    await page.getByRole('textbox', { name: 'Opção 1', exact: false }).fill('Primeira'); await page.getByRole('textbox', { name: 'Opção 2', exact: false }).fill('Segunda')
    await page.getByRole('link', { name: 'Sair do editorial', exact: true }).click()
    await page.getByRole('button', { name: /Permanecer|Continuar nesta|Ficar nesta/ }).click()
    assert.equal(await page.getByLabel('Título', { exact: false }).inputValue(), 'Task9 browser')
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'ownerinc-editorial-dev'), true)
    let releaseSave, saveStarted
    const heldSave = new Promise(resolve => { releaseSave = resolve }), startedSave = new Promise(resolve => { saveStarted = resolve })
    await page.route('**/editorial/api/portal-polls', async route => { if (route.request().method() === 'POST') { saveStarted(); await heldSave } await route.continue() })
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await startedSave
    await page.getByRole('link', { name: 'Sair do editorial', exact: true }).click(); assert.ok(page.url().endsWith('/polls'))
    releaseSave(); await page.getByText('Rascunho salvo.', { exact: true }).waitFor(); await page.unroute('**/editorial/api/portal-polls')
    const saved = (await db.query("SELECT id,version FROM owner_news_polls WHERE title='Task9 browser' ORDER BY created_at DESC LIMIT 1")).rows[0]
    await page.getByLabel('Título', { exact: false }).fill('Task9 local unsaved')
    await db.query('UPDATE owner_news_polls SET version=version+1 WHERE id=$1', [saved.id])
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await page.getByText('A enquete mudou em outra sessão.', { exact: false }).waitFor()
    assert.equal(await page.getByLabel('Título', { exact: false }).inputValue(), 'Task9 local unsaved')
    assert.equal(await page.getByRole('button', { name: 'Publicar enquete', exact: true }).isDisabled(), true)
    await page.screenshot({ path: path.join(directory, 'native-polls-conflict.png') })
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Recarregar versão atual', exact: true }).click()
    await page.getByText('Versão atual carregada.', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Título', { exact: false }).inputValue(), 'Task9 browser')
    await db.query("UPDATE owner_news_polls SET status='closed' WHERE status='open'")
    await page.getByRole('button', { name: 'Publicar enquete', exact: true }).click(); await page.getByText('Enquete publicada.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox').count(), 0)
    await page.getByRole('button', { name: 'Encerrar enquete', exact: true }).click(); await page.getByText('Enquete encerrada.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Criar nova enquete', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Publicar enquete', exact: true }).isDisabled(), true)
    console.log('PASS native dirty/mutation exit guards, save ACK baseline, real SQL competing version -> 409 preserves input, reload/publish/frozen fields/close/unsaved copy')
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(directory, 'native-polls-mobile.png') })
    await page.setViewportSize({ width: 1440, height: 900 })
    deny = true; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.getByText('A sessão editorial expirou ou a permissão foi removida.', { exact: false }).waitFor()
    assert.equal(await page.getByLabel('Título', { exact: false }).count(), 0); deny = false
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await page.getByRole('button', { name: 'Nova enquete', exact: true }).waitFor()
    if (await page.locator('.nav-toggler:not(.nav-toggler--is-open)').count()) await page.locator('.nav-toggler:not(.nav-toggler--is-open)').first().click()
    failedDelete = true; await page.getByRole('link', { name: 'Sair do editorial', exact: true }).click()
    await page.getByText('Não foi possível confirmar o encerramento.', { exact: false }).waitFor()
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'ownerinc-editorial-dev'), true)
    failedDelete = false; await page.getByRole('button', { name: 'Tentar encerrar novamente', exact: true }).click(); await page.waitForURL(`${origin}/editorial-entry.html`)
    assert.equal((await context.cookies()).some(cookie => cookie.name === 'ownerinc-editorial-dev'), false)
    console.log('PASS native permission loss clears content; failed logout retains cookie/honest retry; confirmed DELETE removes session')
    for (const uid of ['another-account', null]) {
      await page.getByRole('button', { name: 'Abrir no Payload', exact: true }).click(); await page.waitForURL(`${origin}/editorial/admin`)
      await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor()
      const otherTab = await context.newPage(); await otherTab.goto(`${origin}/editorial/admin/polls`)
      await otherTab.getByRole('button', { name: 'Nova enquete', exact: true }).waitFor()
      await otherTab.evaluate(uid => globalThis.task9Account(uid), uid)
      await page.getByText('A conta do Portal mudou.', { exact: false }).waitFor()
      assert.equal(await page.getByRole('link', { name: 'Enquetes', exact: true }).count(), 0)
      assert.deepEqual(await otherTab.evaluate(() => globalThis.task9Signs || []), [])
      await otherTab.evaluate(() => globalThis.task9Account('task9-editor')); await otherTab.close()
      await page.goto(`${origin}/editorial-entry.html`)
    }
    console.log('PASS real browser cross-tab account mismatch AND logout clear native workspace, revoke cookie, never call signOut on the new UID (Firebase transport double)')
  }
  assert.deepEqual(errors, [])
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error('Browser failure page:', page.url(), await page.locator('body').innerText().catch(() => 'unavailable'))
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {})
  }
  throw error
} finally { clearTimeout(deadline); await cleanup(); await writeFile(path.join(directory, 'next.log'), log) }

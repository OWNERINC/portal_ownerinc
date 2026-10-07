// Real Next/Payload/Express, original poll/session SQL and audit. ONLY Firebase
// provider identity/browser SDK and the Nginx hosting layer are local doubles.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { connect } from 'node:net'
import { task9ProxyHeaders } from './task9-proxy-headers.mjs'
import { attachBrowserDiagnostics, captureOuterBrowserFailure, captureOuterBrowserObservation, captureTask9Screenshot, createTask9RunGuard, installWindowErrorCapture, runBoundedTask9Cleanup, runTask9Operation, runWithFailureCapture, safeEventMessage, shouldAbortTask9Request } from './task9-browser-observability.mjs'
import { TASK9_TIME_BUDGETS, task9ChildWorkBudget } from './task9-time-budget.mjs'
import { validateTask9Environment } from './task9-environment.mjs'
const environmentValidation = validateTask9Environment(process.env)
if (!environmentValidation.valid) throw new Error(`Task9 environment rejected (${environmentValidation.reasonCodes.join(',')})`)
const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = process.env.TASK9_PRIVATE_DIR || '', base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode')
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
app.use((req, res, next) => {
  req.id = 'task9-local'
  if (activeRunSignal?.aborted) return res.status(503).end()
  const method = req.method.toUpperCase()
  const label = `http.${['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'in-flight'}`
  activeHTTP.set(label, (activeHTTP.get(label) || 0) + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const remaining = (activeHTTP.get(label) || 1) - 1
    if (remaining) activeHTTP.set(label, remaining)
    else activeHTTP.delete(label)
  }
  res.once('finish', release)
  res.once('close', release)
  next()
})
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
    if (activeRunSignal?.aborted) { res.status(503).end(); return }
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    if (activeRunSignal?.aborted) { res.status(503).end(); return }
    const headers = task9ProxyHeaders(req.headers, origin)
    const response = await guardedUpstreamFetch(`${nextOrigin}${req.originalUrl}`, { method: req.method, headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}), redirect: 'manual' })
    if (activeRunSignal?.aborted) { res.status(503).end(); return }
    res.status(response.status); response.headers.forEach((value, key) => { if (!['transfer-encoding', 'content-encoding', 'content-length'].includes(key)) res.set(key, value) })
    res.send(Buffer.from(await response.arrayBuffer()))
  } catch { res.sendStatus(502) }
})
app.use(express.static(path.join(root, 'public')))
let server, child, browser, log = '', activeRunSignal, guardedUpstreamFetch
const activeHTTP = new Map()
async function cleanup() {
  const failures = await runBoundedTask9Cleanup([
    { name: 'next-process.stop', run: async remainingMs => {
    if (!child || child.exitCode !== null) return
    const startedAt = Date.now()
    let taskkillError
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        encoding: 'utf8', windowsHide: true, timeout: Math.min(2500, Math.max(1, remainingMs)),
      })
      taskkillError = result.error
      if (child.exitCode === null) child.kill()
    } else child.kill()
    if (child.exitCode === null) {
      let timer
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Task9 child process did not exit during bounded cleanup')),
            Math.max(1, remainingMs - (Date.now() - startedAt)))
        }),
      ]).finally(() => clearTimeout(timer))
    }
    if (taskkillError) throw taskkillError
  } },
    { name: 'browser.close', run: async () => { try { await browser?.close() } finally { browser = null } } },
    { name: 'http-server.close', run: async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  } },
    ...[...ownedCleanup].map((operation, index) => ({ name: `owned-resource.${index + 1}`, run: operation })),
    { name: 'portal-pool.end', run: () => db.end() },
    { name: 'next.log.write', run: () => writeFile(path.join(directory, 'next.log'), log) },
  ], TASK9_TIME_BUDGETS.cleanupWorkMs)
  ownedCleanup.clear()
  if (failures.length) throw new AggregateError(failures, 'Task9 cleanup failed')
}
const allowedOrigins = [origin, nextOrigin]
const diagnosticsByPage = new Map()
const ownedCleanup = new Set()
await runWithFailureCapture(async signal => {
  activeRunSignal = signal
  const guard = createTask9RunGuard(signal)
  const guardedDB = guard.wrap(db)
  const checkpoint = guard.checkpoint
  const abortFencePages = new Set()
  signal.addEventListener('abort', () => {
    for (const page of abortFencePages) {
      // Cooperative document-level stop only; keep pages open for failure capture.
      void page.evaluate(() => { window.__task9RunAborted = true }).catch(() => {})
    }
  }, { once: true })
  const guardedFetch = async (url, { timeoutMs = 0, ...options } = {}) => {
    checkpoint('fetch.before')
    const controller = new AbortController()
    const abortFromRun = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abortFromRun, { once: true })
    const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('Task9 fetch timeout')), timeoutMs) : null
    try {
      return await guard.run('fetch', () => fetch(url, { ...options, signal: controller.signal }))
    } finally {
      signal.removeEventListener('abort', abortFromRun)
      if (timer) clearTimeout(timer)
    }
  }
  guardedUpstreamFetch = guardedFetch
  guard.onPageCreated(page => {
    const rawPage = guard.unwrap(page)
    abortFencePages.add(rawPage)
    if (signal.aborted) void rawPage.evaluate(() => { window.__task9RunAborted = true }).catch(() => {})
  })
  server = app.listen(19091, '127.0.0.1')
  await guard.run('server.listen', () => new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  }))
  server.on('upgrade', (req, socket, head) => {
    try { checkpoint('http-upgrade') } catch { socket.destroy(); return }
    if (!req.url.startsWith('/_next/hmr')) { socket.destroy(); return }
    const upstream = connect(19092, '127.0.0.1', () => {
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
  })
  try { await guardedFetch(`${nextOrigin}/editorial/ready`, { timeoutMs: 500 }); throw new Error('Task9 Next port occupied') } catch (error) { if (error.message === 'Task9 Next port occupied') throw error }
  checkpoint('next.spawn')
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', ...(process.env.TASK9_WEBPACK === '1' ? ['--webpack'] : []), '--hostname', '127.0.0.1', '--port', '19092'], { cwd: path.join(root, 'cms'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  let ready = false
  for (let i = 0; i < 120; i++) {
    checkpoint('next-ready.poll')
    try { ready = (await guardedFetch(`${nextOrigin}/editorial/ready`, { timeoutMs: 1000 })).ok } catch (error) { checkpoint('next-ready.after-fetch'); if (signal.aborted) throw error }
    if (ready) break
    await guard.run('next-ready.delay', () => delay(250))
  }
  assert.ok(ready)
  if (['--entry-probe', '--metadata', '--nav-probe', '--destinations'].includes(process.argv[2])) {
    const startedAt = Date.now()
    let precompile = { status: null, elapsedMs: 0, result: 'not-completed' }
    try {
      // Anonymous local request warms only the route compile. No browser cookie,
      // Authorization header, response body, or redirect destination is used.
      const response = await guardedFetch(`${origin}/editorial/admin`, {
        redirect: 'manual',
        timeoutMs: 120000,
        headers: { 'cache-control': 'no-cache' },
      })
      precompile = {
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        result: response.status >= 200 && response.status < 400 ? response.status < 300 ? 'http-complete' : 'http-redirect-complete' : 'http-failed',
      }
      await guard.run('response-body.cancel', () => response.body?.cancel().catch(() => {}))
    } catch (error) {
      precompile = {
        status: null,
        elapsedMs: Date.now() - startedAt,
        result: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'bounded-timeout' : 'request-failed',
      }
    }
    const precompileArtifact = process.argv[2] === '--entry-probe' ? 'entry-probe-precompile.json'
      : process.argv[2] === '--nav-probe' ? 'nav-probe-precompile.json'
        : process.argv[2] === '--destinations' ? 'destination-probe-precompile.json' : 'metadata-route-precompile.json'
    await runTask9Operation(signal, 'writeFile', () => writeFile(path.join(directory, precompileArtifact), JSON.stringify({
      path: '/editorial/admin', auth: 'anonymous-local-request; no cookie or Authorization supplied',
      bodyRead: false, redirectFollowed: false, timeoutBoundMs: 120000, ...precompile,
    }, null, 2), { mode: 0o600 }))
    if (precompile.status === null || precompile.status < 200 || precompile.status >= 400) {
      throw new Error(`anonymous route precompile failed (${precompile.result}${precompile.status === null ? '' : ` ${precompile.status}`})`)
    }
  }
  checkpoint('playwright.load')
  const { chromium } = createRequire(path.join(base, 'package.json'))('playwright')
  browser = await guard.run('browser.launch', async () => {
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
    return browser
  })
  const context = guard.wrap(await guard.run('browser.newContext', () => browser.newContext({ viewport: { width: 1440, height: 900 } })))
  context.setDefaultTimeout(15000)
  await context.addInitScript(() => { if (!localStorage.getItem('task9-initialized')) { localStorage.setItem('task9-initialized', '1'); localStorage.setItem('task9-uid', 'task9-editor') } })
  await context.route('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js', route => route.fulfill({ contentType: 'text/javascript', body: `export {onAuthStateChanged,signOut,updateProfile} from '${origin}/js/firebase-config.js'` }))
  const rawContext = guard.unwrap(context)
  const abortFenceRoute = async route => {
    if (shouldAbortTask9Request(signal)) {
      await route.abort()
      return
    }
    await route.continue()
  }
  for (const [index, pattern] of [
    '**/editorial/api/**', '**/editorial/admin**', '**/api/cms/session**',
    '**/editorial-entry.html*', '**/cms.html*', '**/announcements.html*',
  ].entries()) {
    await guard.run(`context.route.install-abort-fence.${index + 1}`, () => rawContext.route(pattern, abortFenceRoute))
  }
  const page = await context.newPage()
  const rawPage = guard.unwrap(page)
  const browserEvents = attachBrowserDiagnostics(rawPage, allowedOrigins)
  diagnosticsByPage.set(page, browserEvents)
  await installWindowErrorCapture(page, browserEvents)
  assert.equal(browserEvents.windowErrorCapture, 'installed-before-navigation', 'window error collector must install before any browser navigation')
  await page.goto(`${origin}/editorial-entry.html`); await page.getByRole('button', { name: 'Abrir no Payload', exact: true }).click()
  // A cold native route compile can exceed 15s; the complete run stays bounded.
  await page.waitForURL(`${origin}/editorial/admin`, { timeout: 30000 })
  if (process.argv[2] === '--entry-probe') {
    await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor({ timeout: 15000 })
    await page.getByRole('heading', { name: 'Coleções', exact: true }).waitFor({ timeout: 15000 })
    const observation = await captureOuterBrowserObservation({
      browser, directory, allowedOrigins, events: browserEvents,
      prefix: 'entry-probe-admin-shell', outcome: 'entry-only-admin-shell-usable', signal,
    })
    const result = {
      outcome: 'PASS entry-only admin shell',
      selectorChecks: { pollsNavigationLink: true, collectionsHeading: true },
      precompile: 'see entry-probe-precompile.json',
      observation: { json: path.basename(observation.json), screenshot: path.basename(observation.screenshot) },
      sessionPOST: browserEvents.responses.filter(item => item.method === 'POST' && item.path === '/api/cms/session'),
      sessionGET: browserEvents.responses.filter(item => item.method === 'GET' && item.path === '/api/cms/session'),
      adminResponses: browserEvents.responses.filter(item => item.path === '/editorial/admin'),
      frameNavigations: browserEvents.frameNavigations,
      identityEvidence: 'Firebase/browser and local hosting doubles only; not production identity or CSP evidence',
      metadataAcceptance: 'NOT_RUN',
    }
    await runTask9Operation(signal, 'writeFile', () => writeFile(path.join(directory, 'entry-probe-result.json'), JSON.stringify(result, null, 2), { mode: 0o600 }))
    console.log('PASS bounded entry-only Payload admin shell; metadata acceptance not run')
    return
  }
  await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor()
  if (process.argv[2] === '--metadata') {
    const { checkNativeMetadata } = await guard.run('module.metadata.import', () => import('./task9-native-metadata.mjs'))
    await checkNativeMetadata({ context, origin, directory, signal, registerCleanup: operation => {
      ownedCleanup.add(operation)
      return () => ownedCleanup.delete(operation)
    } })
    console.log('PASS native editorial JSON metadata acceptance (Firebase SDK/provider + hosting doubles)')
  } else if (process.argv[2] === '--nav-probe') {
    const { probeEditorialDestinationHitTest } = await guard.run('module.navigation-probe.import', () => import('./task9-navigation-probe.mjs'))
    const result = await probeEditorialDestinationHitTest({
      page, origin, directory, documentId: '338c5db2-f620-413e-a5b3-8a7e622377ee', signal,
    })
    console.log(JSON.stringify({ probe: 'R9 read-only navigation hit-test', evidence: path.basename(result.evidence),
      screenshot: result.screenshot ? path.basename(result.screenshot) : null, conclusion: result.result.conclusion,
      clicked: false, writesObserved: result.result.network.unexpectedWriteMethodsObserved.length }))
  } else if (process.argv[2] === '--destinations') {
    const { checkNativeEditorialDestinations } = await guard.run('module.destinations.import', () => import('./task9-destination-acceptance.mjs'))
    const manifests = (await guard.run('artifact.readdir', () => readdir(directory))).filter(name => /^r\d+-manifest\.json$/iu.test(name))
    assert.equal(manifests.length, 1, 'destination evidence requires exactly one actual round manifest in its private directory')
    const manifestId = manifests[0].match(/^r\d+/iu)?.[0]?.toUpperCase()
    const manifest = JSON.parse(await guard.run('artifact.readFile', () => readFile(path.join(directory, manifests[0]), 'utf8')))
    assert.ok(manifestId && manifest.round?.startsWith(`${manifestId} `), 'manifest filename and round label must agree')
    assert.equal(manifest.existingDraftId, '338c5db2-f620-413e-a5b3-8a7e622377ee', 'only the approved existing R9 draft is allowed')
    const result = await checkNativeEditorialDestinations({
      page, origin, directory, documentId: manifest.existingDraftId, manifestId, signal,
    })
    console.log(JSON.stringify({ outcome: result.outcome, evidence: path.basename(result.evidence),
      serverActionResult: result.serverActionResult, articleMutationRequests: result.articleMutationRequests }))
  } else {
  if (await page.locator('.nav-toggler:not(.nav-toggler--is-open)').count()) await page.locator('.nav-toggler:not(.nav-toggler--is-open)').first().click()
  await page.getByRole('link', { name: 'Enquetes', exact: true }).click()
  await page.getByRole('button', { name: 'Nova enquete', exact: true }).waitFor()
  console.log('PASS Portal entry -> real session issuance -> native same-account watch -> polls workspace (Firebase SDK/provider doubles)')
  if (process.argv[2] === '--history') {
    await page.close()
    const { checkPollHistory } = await guard.run('module.history.import', () => import('./task9-history.mjs'))
      await checkPollHistory({ context, origin, directory, signal })
  } else if (process.argv[2] === '--http') {
    const call = (method, suffix = '', data) => context.request.fetch(`${origin}/editorial/api/portal-polls${suffix}`, { method, headers: { Origin: origin }, data })
    // Preserve prior runs: close only this dedicated Task9 database's open fixture.
    await guardedDB.query("UPDATE owner_news_polls SET status='closed' WHERE status='open'")
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
    await guardedDB.query(`UPDATE users SET permissions='{}' WHERE uid='task9-editor'`)
    assert.equal((await call('GET')).status(), 403)
    await guardedDB.query(`UPDATE users SET permissions='{"manageKnowledge":true}' WHERE uid='task9-editor'`)
    const audits = await guardedDB.query("SELECT actor_uid,action FROM audit_log WHERE target_type='owner_news_poll'")
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
    const saved = (await guardedDB.query("SELECT id,version FROM owner_news_polls WHERE title='Task9 browser' ORDER BY created_at DESC LIMIT 1")).rows[0]
    await page.getByLabel('Título', { exact: false }).fill('Task9 local unsaved')
    await guardedDB.query('UPDATE owner_news_polls SET version=version+1 WHERE id=$1', [saved.id])
    await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await page.getByText('A enquete mudou em outra sessão.', { exact: false }).waitFor()
    assert.equal(await page.getByLabel('Título', { exact: false }).inputValue(), 'Task9 local unsaved')
    assert.equal(await page.getByRole('button', { name: 'Publicar enquete', exact: true }).isDisabled(), true)
    await captureTask9Screenshot(signal, options => page.screenshot(options), path.join(directory, 'native-polls-conflict.png'))
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Recarregar versão atual', exact: true }).click()
    await page.getByText('Versão atual carregada.', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('Título', { exact: false }).inputValue(), 'Task9 browser')
    await guardedDB.query("UPDATE owner_news_polls SET status='closed' WHERE status='open'")
    await page.getByRole('button', { name: 'Publicar enquete', exact: true }).click(); await page.getByText('Enquete publicada.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('textbox').count(), 0)
    await page.getByRole('button', { name: 'Encerrar enquete', exact: true }).click(); await page.getByText('Enquete encerrada.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Criar nova enquete', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Publicar enquete', exact: true }).isDisabled(), true)
    console.log('PASS native dirty/mutation exit guards, save ACK baseline, real SQL competing version -> 409 preserves input, reload/publish/frozen fields/close/unsaved copy')
    await page.setViewportSize({ width: 390, height: 844 }); await captureTask9Screenshot(signal,
      options => page.screenshot(options), path.join(directory, 'native-polls-mobile.png'))
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
  }
  assert.equal(browserEvents.pageErrors.length, 0, 'browser pageerror events were observed')
  const windowErrors = await page.evaluate(() => Array.isArray(window.__task9OuterWindowErrors) ? window.__task9OuterWindowErrors : []).catch(() => [])
  assert.equal(windowErrors.length, 0, 'window.error/unhandledrejection diagnostics were observed')
}, {
  timeoutMs: task9ChildWorkBudget(process.argv[2]),
  captureTimeoutMs: TASK9_TIME_BUDGETS.captureMs,
  cleanupTimeoutMs: TASK9_TIME_BUDGETS.cleanupMs,
  settleTimeoutMs: TASK9_TIME_BUDGETS.settleMs,
  capture: async (error, captureSignal, failureContext) => {
    const result = await captureOuterBrowserFailure({
      browser,
      directory,
      allowedOrigins,
      events: [...diagnosticsByPage.values()][0],
      error,
      signal: captureSignal,
      failureContext,
    })
    console.error('Outer failure diagnostics saved:', path.basename(result.json), `screenshot=${result.screenshot === 'capture-failed' ? 'capture-failed' : path.basename(result.screenshot)}`)
  },
  onCaptureFailure: error => console.error('Outer failure capture failed:', JSON.stringify({
    name: error?.name || 'Error', message: safeEventMessage(error?.message),
    inFlightOperationCount: error?.task9InFlightOperationCount || 0,
    inFlightOperations: (error?.task9InFlightOperations || []).slice(0, 30), inFlightHTTP: error?.task9InFlightHTTP || [],
  })),
  onWorkUnsettled: error => console.error('Task9 work remained pending after cleanup:', JSON.stringify({
    name: error?.name || 'Error', inFlightOperations: (error?.task9InFlightOperations || []).slice(0, 30),
  })),
  onCleanupFailure: error => console.error('Task9 bounded cleanup reported a secondary failure:', JSON.stringify({
    name: error?.name || 'Error',
    failures: (error?.errors || []).slice(0, 20).map(failure => ({
      name: failure?.name || 'Error', message: safeEventMessage(failure?.message),
    })),
  })),
  cleanup: async () => {
    await cleanup()
  },
  getFailureContextDetails: () => ({
    inFlightHTTP: [...activeHTTP.entries()].map(([label, count]) => ({ label, count })),
  }),
})

// Real Next/Payload/PostgreSQL + Portal modules. Firebase and Portal transport are
// explicit local doubles. Only the NEW cms_task8_test database is allowed.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = process.env.TASK8_PRIVATE_DIR || ''
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode'), database = new URL(process.env.CMS_DATABASE_URL || 'http://invalid')
if (process.env.TASK8_DISPOSABLE !== 'cms_task8_test' || database.hostname !== '127.0.0.1' || database.port !== '55441'
  || database.pathname !== '/cms_task8_test' || database.username !== 'cms_runtime' || path.dirname(directory) !== base
  || !path.basename(directory).startsWith('ownerinc-task8-') || process.env.PORTAL_PUBLIC_URL !== 'http://127.0.0.1:18088'
  || process.env.PORTAL_INTERNAL_URL !== 'http://127.0.0.1:18089') throw new Error('Refusing other Task8 environment')
const actor = { uid: 'task8-editor', email: 'task8@example.invalid', name: null, canManageNews: true }
const origin = process.env.PORTAL_PUBLIC_URL
const { createPayloadNewsClient } = createRequire(path.join(root, 'api/package.json'))('./owner-news/payload-client.js')
const client = createPayloadNewsClient({ baseURL: origin, secret: process.env.PORTAL_TO_PAYLOAD_SECRET })
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.PAYLOAD_TO_PORTAL_SECRET}`) { res.writeHead(401).end(); return }
  let body = ''; for await (const chunk of req) body += chunk
  const data = body ? JSON.parse(body) : {}
  const result = req.url.endsWith('/authority') ? { mode: 'payload', epoch: 1 }
    : req.url.endsWith('/actor/check') && data.uid === actor.uid ? { actor }
      : req.url.endsWith('/session/resolve') && data.cookie === 'task8-synthetic-cookie' ? { actor, expiresAt: new Date(Date.now() + 3600000).toISOString() } : null
  res.writeHead(result ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(result || { reason: 'editorial_session_invalid' }))
})
let child, browser, log = ''
// Always close owned resources, including on the runner's bounded timeout.
const cleanup = async () => {
  await browser?.close(); browser = null
  if (child && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else child.kill()
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)) }, 150000)
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18089, '127.0.0.1', resolve) })
  try { await fetch(`${origin}/editorial/ready`, { signal: AbortSignal.timeout(500) }); throw new Error('Task8 port already in use') }
  catch (error) { if (error.message === 'Task8 port already in use') throw error }
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '18088'], { cwd: path.join(root, 'cms'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Owned Next child exited')
    try { ready = (await fetch(`${origin}/editorial/ready`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break; await delay(250)
  }
  assert.ok(ready)
  const { chromium } = createRequire(path.join(base, 'package.json'))('playwright')
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const errors = [], failures = []
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => failures.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`))
  })
  context.setDefaultTimeout(15000)
  await context.addCookies([{ name: 'ownerinc-editorial-dev', value: 'task8-synthetic-cookie', url: origin, httpOnly: true, sameSite: 'Lax' }])
  const text = (text, format = 0) => ({ type: 'text', version: 1, text, format, mode: 'normal', style: '', detail: 0 })
  const element = (type, children, extra = {}) => ({ type, version: 1, direction: 'ltr', format: '', indent: 0, children, ...extra })
  const body = [{ blockType: 'richText', content: { root: element('root', [
    element('heading', [text('Uma seção salva')], { tag: 'h2' }),
    element('paragraph', [text('Texto com destaque. ', 1), text('Leitura segura no Portal.')], { textFormat: 0, textStyle: '' }),
    element('list', [element('listitem', [text('Primeiro item')], { value: 1 })], { listType: 'bullet', tag: 'ul', start: 1 }),
  ]) } }]
  const editorial = { version: 1, kind: 'article', summary: 'Resumo editorial salvo para a prévia.', author: 'Owner News', source_label: '', source_date: null }
  const created = await context.request.post(`${origin}/editorial/api/news-articles?draft=true`, { headers: { Origin: origin }, data: { title: 'Task8 revisão inicial', category: 'Cultura', editorial, body } })
  assert.equal(created.status(), 201, await created.text())
  const { doc } = await created.json(), id = doc.id
  const page = await context.newPage()
  await page.goto(`${origin}/editorial/admin/collections/news-articles/${id}`)
  const control = page.getByRole('button', { name: 'Conferir prévia salva', exact: true })
  await control.click()
  assert.equal(await page.getByText('Something went wrong:', { exact: false }).count(), 0, 'native Lexical fixture must render without error')
  const previewLink = page.getByRole('link', { name: 'Abrir prévia editorial em nova aba' })
  await previewLink.waitFor()
  const firstURL = new URL(await previewLink.getAttribute('href'), origin)
  const saved = await context.request.get(`${origin}/editorial/api/news-schedule?target=article&documentId=${id}`)
  assert.equal(firstURL.searchParams.get('version'), (await saved.json()).versionId)
  assert.notEqual(firstURL.searchParams.get('version'), id)
  console.log('Native preview URL uses actual persisted Versions UUID, not document ID')
  let release, started
  const hold = new Promise(resolve => { release = resolve }), saving = new Promise(resolve => { started = resolve })
  await page.route(`**/editorial/api/news-articles/${id}*`, async route => {
    if (route.request().method() === 'PATCH') { started(); await hold }
    await route.continue()
  })
  const title = page.getByLabel('Title', { exact: true })
  await title.fill('Task8 revisão salva B')
  assert.equal(await control.isDisabled(), true)
  await saving; assert.equal(await control.isDisabled(), true)
  assert.equal(await previewLink.count(), 0)
  const savedResponse = page.waitForResponse(response => response.url().includes(`/news-articles/${id}`) && response.request().method() === 'PATCH')
  release(); assert.equal((await savedResponse).status(), 200)
  await page.unroute(`**/editorial/api/news-articles/${id}*`)
  await control.click(); await previewLink.waitFor()
  const previewURL = new URL(await previewLink.getAttribute('href'), origin)
  assert.notEqual(previewURL.searchParams.get('version'), firstURL.searchParams.get('version'))
  const confirmed = await context.request.get(`${origin}/editorial/api/news-schedule?target=article&documentId=${id}`)
  assert.equal(previewURL.searchParams.get('version'), (await confirmed.json()).versionId)
  console.log('Dirty form and pending native autosave disable preview; completed save resolves a new actual version')
  await page.route('**/editorial/api/news-schedule?*', route => route.fulfill({ status: 409, json: { error: 'news_schedule_conflict' } }))
  await control.click(); await page.getByText('Ainda não há uma revisão salva disponível.', { exact: false }).waitFor()
  assert.equal(await title.inputValue(), 'Task8 revisão salva B'); assert.equal(await previewLink.count(), 0)
  await page.unroute('**/editorial/api/news-schedule?*')
  await page.screenshot({ path: path.join(directory, 'native-preview-409.png') })
  console.log('Read-only 409 preserves native inputs and exposes no stale preview link')
  // Route local Portal files as the static hosting boundary. Browser auth uses real
  // auth.js with synthetic Firebase identity; bridge forwards to real CMS preview.
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' }
  await context.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/editorial/')) return route.continue()
    if (url.pathname === '/js/firebase-config.js') return route.fulfill({ contentType: 'text/javascript', body: `export const auth = { currentUser: { uid: 'task8-editor', getIdToken: async () => 'task8-browser' }, authStateReady: async () => {}, app: {name: '[DEFAULT]', options: {apiKey:'task8'}} };` })
    if (url.pathname === '/api/users/me') return route.fulfill({ json: { uid: actor.uid, role: 'admin', permissions: { manageKnowledge: true } } })
    if (url.pathname.startsWith('/api/announcements/preview/')) {
      try {
        const dto = await client.query('preview', { id: url.pathname.split('/').at(-1), versionId: url.searchParams.get('version'), source: url.searchParams.get('source') }, actor)
        return route.fulfill({ json: dto })
      } catch (error) { return route.fulfill({ status: error.status || 503, json: { error: 'preview_unavailable' } }) }
    }
    if (/^\/(news-preview\.html|js\/|css\/|assets\/)/u.test(url.pathname)) {
      const file = path.resolve(root, 'public', `.${url.pathname}`)
      if (!file.startsWith(path.join(root, 'public') + path.sep)) return route.abort()
      try { return await route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: await readFile(file) }) } catch { return route.fulfill({ status: 404, body: '' }) }
    }
    return route.fulfill({ status: 404, body: '' })
  })
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', body: 'export const onAuthStateChanged = () => () => {}; export const signOut = async () => {}; export const updateProfile = async () => {};' }))
  await control.click(); await previewLink.waitFor()
  const popupPromise = context.waitForEvent('page'); await previewLink.click(); const preview = await popupPromise
  try { await preview.getByText('Conteúdo não publicado', { exact: false }).waitFor() }
  catch (error) {
    await preview.screenshot({ path: path.join(directory, 'preview-failure.png'), fullPage: true })
    console.error({ errors, failures, text: await preview.locator('body').innerText() }); throw error
  }
  assert.equal(await preview.locator('h1').count(), 1)
  assert.equal(await preview.locator('#news-preview-title').textContent(), 'Task8 revisão salva B')
  assert.equal(await preview.locator('.news-article-body strong').textContent(), 'Texto com destaque. ')
  assert.equal(await preview.locator('.news-article-body ul li').count(), 1)
  for (const width of [1440, 390, 320]) {
    await preview.setViewportSize({ width, height: 900 })
    assert.equal(await preview.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal overflow at ${width}`)
    await preview.screenshot({ path: path.join(directory, `preview-${width}.png`), fullPage: true })
  }
  console.log('Real static preview opened in own tab; saved draft banner, strong/list DOM, single h1, no overflow at 1440/390/320')
  const publish = await context.request.patch(`${origin}/editorial/api/news-articles/${id}`, { headers: { Origin: origin }, data: { _status: 'published', title: 'Task8 publicação C' } })
  assert.equal(publish.status(), 200, await publish.text())
  const published = await context.request.get(`${origin}/editorial/api/news-schedule?target=article&documentId=${id}`)
  const publishedVersion = (await published.json()).versionId
  await preview.goto(previewURL.href)
  await preview.getByText('Conteúdo não publicado', { exact: false }).waitFor()
  assert.equal(await preview.locator('#news-preview-title').textContent(), 'Task8 revisão salva B', 'later publication does not rewrite saved preview')
  previewURL.searchParams.set('version', publishedVersion)
  await preview.goto(previewURL.href); await preview.getByText('Revisão salva como publicada', { exact: false }).waitFor()
  assert.equal(await preview.getByText('Conteúdo não publicado', { exact: false }).count(), 0)
  assert.equal(await preview.locator('#news-preview-title').textContent(), 'Task8 publicação C')
  assert.deepEqual(errors, [])
  console.log('Exact saved B survives later C publication; published revision banner is honest; no page errors')
} finally {
  clearTimeout(deadline); await cleanup()
  for (const [key, value] of Object.entries(process.env)) if (key.includes('SECRET')) log = log.split(value).join('[redacted]')
  await writeFile(path.join(directory, 'browser-server.log'), log.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]'))
  console.log(`Task8 owned Next/internal-double processes stopped; evidence: ${directory}`)
}

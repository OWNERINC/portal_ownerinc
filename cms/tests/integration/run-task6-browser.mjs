// Starts/stops ONLY its own loopback Next child. Reuses a successful dedicated Task6 DB;
// no reset, migration, Docker action or existing-process termination.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const base = path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode')
const directory = path.resolve(process.argv[2] || '')
if (process.argv.length !== 3 || path.dirname(directory) !== base || !path.basename(directory).startsWith('ownerinc-task6-')) throw new Error('Explicit private Task6 fixture directory required')
const state = JSON.parse(await readFile(path.join(base, 'ownerinc-payload-local-validation-20261002', 'state.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(directory, 'browser-fixture.json'), 'utf8'))
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata', 'comspec', 'pathext'].includes(key.toLowerCase())))
const secret = () => randomBytes(36).toString('hex')
const env = { ...inherited, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
  TASK6_DISPOSABLE: 'cms_task6_test', TASK6_PRIVATE_DIR: directory,
  PAYLOAD_SECRET: secret(), PAYLOAD_TO_PORTAL_SECRET: secret(), PORTAL_TO_PAYLOAD_SECRET: secret(),
  PORTAL_PUBLIC_URL: 'http://127.0.0.1:18086', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18086',
  CMS_UPLOAD_DIR: path.join(directory, 'uploads'),
  CMS_DATABASE_URL: `postgresql://cms_runtime:${encodeURIComponent(state.passwords.cms_runtime)}@127.0.0.1:55441/cms_task6_test` }
const origin = env.PORTAL_PUBLIC_URL
// Refuse a busy port rather than testing/modifying an unrelated running service.
try { await fetch(`${origin}/editorial/ready`, { signal: AbortSignal.timeout(500) }); throw new Error('Task6 port already in use') }
catch (error) { if (error.message === 'Task6 port already in use') throw error }
const child = spawn(process.execPath, ['--import', './tests/integration/task6-portal-double.mjs', 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '18086'],
  { cwd: path.join(root, 'cms'), env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', data => { log += data }); child.stderr.on('data', data => { log += data })
let browser
try {
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('Task6 Next child exited')
    try { ready = (await fetch(`${origin}/editorial/ready`, { signal: AbortSignal.timeout(1000) })).ok } catch {}
    if (ready) break
    await delay(250)
  }
  assert.equal(ready, true, 'Task6 native Next readiness')
  const { chromium } = createRequire(path.join(base, 'package.json'))('playwright')
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addCookies([{ name: 'ownerinc-editorial-dev', value: 'task6-synthetic-browser-cookie', url: origin, httpOnly: true, sameSite: 'Lax' }])
  const resetFixture = await context.request.patch(`${origin}/editorial/api/news-articles/${fixture.articleId}?draft=true`, {
    headers: { Origin: origin }, data: { title: 'Task6 native browser fixture', body: [{ blockType: 'paragraph', text: 'Browser body A' }] },
  })
  assert.equal(resetFixture.status(), 200, 'reset only the owned synthetic browser document')
  const homeRevision = await context.request.get(`${origin}/editorial/api/news-schedule?target=home&documentId=news-home`)
  // The review fixture includes a real saved home; ordinary Task6 fixtures do too.
  assert.equal(homeRevision.status(), 200)
  const home = await homeRevision.json()
  const homeSchedule = await context.request.post(`${origin}/editorial/api/news-schedule`, { headers: { Origin: origin }, data: {
    target: 'home', documentId: 'news-home', versionId: home.versionId, operation: 'publish',
    expectedGeneration: home.generation, scheduledAt: '2030-01-02T13:30:00.000Z',
  } })
  assert.equal(homeSchedule.status(), 200, await homeSchedule.text())
  console.log('Shared home ScheduleInput without optional hash accepted by real authenticated REST')
  const page = await context.newPage(); page.setDefaultTimeout(30000)
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/editorial/admin/collections/news-articles/${fixture.articleId}`)
  await page.getByRole('button', { name: 'Agendar revisão salva', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Agendar revisão salva', exact: true }).click()
  await page.getByText('Fuso: America/Sao_Paulo.', { exact: false }).waitFor()
  await page.screenshot({ path: path.join(directory, 'native-schedule-open.png'), fullPage: true })
  console.log('Native drawer opened; America/Sao_Paulo and saved revision shown')
  const dateInput = page.getByLabel('Data e hora (AAAA-MM-DD HH:mm)')
  const confirm = page.getByLabel('Confirmo esta revisão salva, não alterações locais ou futuras.')
  const submit = page.getByRole('button', { name: 'Confirmar agendamento', exact: true })
  const localDate = '2030-01-02 10:30'
  await dateInput.fill(localDate)
  assert.equal(await submit.isDisabled(), true, 'explicit saved revision confirmation required')
  await confirm.check()
  const currentResponse = await context.request.get(`${origin}/editorial/api/news-schedule?target=article&documentId=${fixture.articleId}`)
  assert.equal(currentResponse.status(), 200)
  const current = await currentResponse.json()
  const competing = await context.request.post(`${origin}/editorial/api/news-schedule`, { headers: { Origin: origin }, data: {
    target: 'article', documentId: fixture.articleId, versionId: current.versionId,
    expectedGeneration: current.generation, operation: 'publish', scheduledAt: '2030-01-02T13:30:00.000Z',
  } })
  assert.equal(competing.status(), 200, await competing.text())
  console.log('Shared article ScheduleInput without optional hash accepted by real authenticated REST')
  const titleBefore = await page.getByLabel('Title', { exact: true }).inputValue()
  const conflict = page.waitForResponse(response => response.url().endsWith('/news-schedule') && response.request().method() === 'POST')
  await submit.click(); assert.equal((await conflict).status(), 409)
  await page.getByText('A revisão ou a agenda mudou.', { exact: false }).waitFor()
  assert.equal(await dateInput.inputValue(), localDate)
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), titleBefore)
  assert.equal(await confirm.isChecked(), false, 'stale confirmation reset, user inputs retained')
  await page.screenshot({ path: path.join(directory, 'native-409-preserved.png') })
  await page.getByRole('button', { name: 'Conferir revisão salva novamente' }).click()
  await confirm.check()
  const success = page.waitForResponse(response => response.url().endsWith('/news-schedule') && response.request().method() === 'POST')
  await submit.click()
  const successResponse = await success
  assert.equal(successResponse.status(), 200)
  const nativeInput = successResponse.request().postDataJSON()
  assert.equal(nativeInput.target, 'article'); assert.equal(nativeInput.operation, 'publish')
  assert.match(nativeInput.snapshotHash, /^[a-f0-9]{64}$/u, 'native UI always sends its saved-content hash')
  await page.getByText('Revisão salva agendada.', { exact: false }).waitFor()
  console.log('Real REST generation conflict 409 preserved native title/date; refresh + explicit reconfirm scheduled immutable revision')
  await page.getByRole('button', { name: 'Fechar', exact: true }).click()
  let releaseSave
  const holdSave = new Promise(resolve => { releaseSave = resolve })
  let sawSave
  const saveStarted = new Promise(resolve => { sawSave = resolve })
  await page.route(`**/editorial/api/news-articles/${fixture.articleId}*`, async route => {
    if (route.request().method() === 'PATCH') { sawSave(); await holdSave }
    await route.continue()
  })
  const title = page.getByLabel('Title', { exact: true })
  const opener = page.getByRole('button', { name: 'Agendar revisão salva', exact: true })
  const savedMarker = `Task6 native pending-save marker ${Date.now()}`
  await title.fill(savedMarker)
  assert.equal(await opener.isDisabled(), true, 'unsaved native form blocks scheduling')
  await Promise.race([saveStarted, delay(15000).then(() => { throw new Error('native autosave did not start') })])
  assert.equal(await opener.isDisabled(), true, 'native pending autosave blocks scheduling')
  const saved = page.waitForResponse(response => response.url().includes(`/news-articles/${fixture.articleId}`) && response.request().method() === 'PATCH')
  releaseSave(); assert.equal((await saved).status(), 200)
  await page.unroute(`**/editorial/api/news-articles/${fixture.articleId}*`)
  await opener.click()
  await page.getByText(`${savedMarker} — revisão`, { exact: false }).waitFor()
  console.log('Native form: unsaved + in-flight autosave disabled schedule action; saved revision then updated correctly')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500) // native drawer transition, not an application readiness substitute
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile viewport has no horizontal overflow')
  await page.screenshot({ path: path.join(directory, 'native-schedule-mobile.png') })
  await page.getByRole('button', { name: 'Fechar', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Add Body', exact: true }).click()
  await page.getByRole('button', { name: 'Pdf', exact: true }).click()
  await page.getByText('Media', { exact: true }).last().waitFor()
  await page.getByRole('button', { name: 'Create New', exact: true }).click()
  await page.locator('input[type="file"]').last().waitFor({ state: 'attached' })
  assert.equal(await opener.isDisabled(), true, 'native media drawer blocks scheduling on the parent document')
  await page.locator('input[type="file"]').last().setInputFiles({ name: 'task6-browser.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nTask6 synthetic browser\nxref\n0 1\n0000000000 65535 f\n%%EOF\n') })
  let releaseUpload, sawUpload
  const holdUpload = new Promise(resolve => { releaseUpload = resolve })
  const uploadStarted = new Promise(resolve => { sawUpload = resolve })
  await page.route('**/editorial/api/news-media*', async route => {
    if (route.request().method() === 'POST') { sawUpload(); await holdUpload }
    await route.continue()
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await Promise.race([uploadStarted, delay(15000).then(() => { throw new Error('native media upload did not start') })])
  assert.equal(await opener.isDisabled(), true, 'native in-flight media upload blocks schedule action')
  await page.screenshot({ path: path.join(directory, 'native-upload-pending.png') })
  const uploaded = page.waitForResponse(response => response.url().includes('/editorial/api/news-media') && response.request().method() === 'POST')
  releaseUpload(); assert.equal((await uploaded).status(), 201)
  await page.unroute('**/editorial/api/news-media*')
  console.log('Real native media drawer/file upload: pending POST disabled parent schedule action; upload completed 201')
  await writeFile(path.join(directory, 'browser-blocks.txt'), await page.locator('body').innerText())
  await writeFile(path.join(directory, 'browser-dom.txt'), await page.locator('body').innerText())
  assert.deepEqual(errors, [])
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  if (process.platform === 'win32' && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill()
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve))
  for (const value of [...Object.values(state.passwords), ...Object.entries(env).filter(([key]) => key.includes('SECRET')).map(([, value]) => value)]) log = log.split(value).join('[redacted]')
  await writeFile(path.join(directory, 'browser-server.log'), log.replace(/postgres(?:ql)?:\/\/\S+/gu, '[redacted-db-url]'))
  console.log(`Task6 own child stopped; evidence: ${directory}`)
}

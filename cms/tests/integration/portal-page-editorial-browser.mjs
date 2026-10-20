#!/usr/bin/env node
// Explicit, disposable browser acceptance. The only CMS process this file may
// start is its own loopback Next child, backed by the guarded CMS test database
// and a local test-only V2 actor transport. No Docker or production service is
// started or contacted.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { checkIntegrationDirectories, readIntegrationConfig } from '../support/integration-config.mjs'
import { runEditorialControlCases } from './portal-page-editorial-controls.mjs'
import { runEditorialUploadCases } from './portal-page-editorial-upload.mjs'

const cmsRoot = fileURLToPath(new URL('../../', import.meta.url))
const handoffName = 'portal-page-editorial-browser.json'
const resultName = 'portal-page-editorial-browser-result.json'
const runID = process.env.PAYLOAD_TEST_RUN_ID || 'unavailable'

function safeCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' && /^[a-z0-9_]+$/u.test(error.code)
    ? error.code : 'browser_fixture_invalid'
}

function report(status, cases) {
  return { runId: runID, status, cases }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function childEnvironment(config, portalInternalURL, serviceSecret) {
  const inheritedKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME'])
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => inheritedKeys.has(key.toUpperCase())))
  const payloadToPortalSecret = serviceSecret
  let portalToPayloadSecret = randomBytes(36).toString('hex')
  if (payloadToPortalSecret === portalToPayloadSecret) portalToPayloadSecret = randomBytes(36).toString('hex')
  return {
    ...inherited,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    MIGRATION_TEST_DISPOSABLE: 'true',
    PAYLOAD_TEST_RUN_ID: config.runId,
    PAYLOAD_TEST_UPLOAD_DIR: config.uploadDir,
    PAYLOAD_TEST_EVIDENCE_DIR: config.evidenceDir,
    PAYLOAD_TEST_PORTAL_DATABASE_URL: config.portalDatabaseURL,
    PAYLOAD_TEST_CMS_DATABASE_URL: config.cmsDatabaseURL,
    CMS_DATABASE_URL: config.cmsDatabaseURL,
    CMS_UPLOAD_DIR: config.uploadDir,
    PAYLOAD_SECRET: randomBytes(36).toString('hex'),
    PAYLOAD_TO_PORTAL_SECRET: payloadToPortalSecret,
    PORTAL_TO_PAYLOAD_SECRET: portalToPayloadSecret,
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:3100',
    PORTAL_INTERNAL_URL: portalInternalURL,
    NEXT_PUBLIC_PORTAL_PAGE_EDITORIAL_TEST_FIXTURE: 'true',
  }
}

async function requireFreeLoopbackPort(port) {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function readHandoff(config) {
  const evidenceDir = await realpath(config.evidenceDir)
  const handoffPath = path.join(evidenceDir, handoffName)
  let info
  try { info = await lstat(handoffPath) } catch { return null }
  if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error(), { code: 'browser_handoff_invalid' })
  let value
  try { value = JSON.parse(await readFile(handoffPath, 'utf8')) } catch { throw Object.assign(new Error(), { code: 'browser_handoff_invalid' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'baseURL,playwrightModule,runId,storageStateFile' ||
      value.runId !== config.runId) throw Object.assign(new Error(), { code: 'browser_handoff_invalid' })

  let base
  try { base = new URL(value.baseURL) } catch { throw Object.assign(new Error(), { code: 'browser_base_url_invalid' }) }
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
      Number(base.port) !== 3100) throw Object.assign(new Error(), { code: 'browser_base_url_invalid' })

  if (typeof value.playwrightModule !== 'string' || !path.isAbsolute(value.playwrightModule) ||
      !config.playwrightModule || path.resolve(value.playwrightModule) !== path.resolve(config.playwrightModule)) {
    throw Object.assign(new Error(), { code: 'playwright_module_invalid' })
  }
  const moduleInfo = await lstat(value.playwrightModule).catch(() => null)
  if (!moduleInfo?.isFile()) throw Object.assign(new Error(), { code: 'playwright_module_invalid' })

  if (typeof value.storageStateFile !== 'string' || !path.isAbsolute(value.storageStateFile)) {
    throw Object.assign(new Error(), { code: 'browser_storage_state_invalid' })
  }
  const stateRealPath = await realpath(value.storageStateFile).catch(() => null)
  if (!stateRealPath || stateRealPath === evidenceDir ||
      !(path.relative(evidenceDir, stateRealPath) && !path.relative(evidenceDir, stateRealPath).startsWith(`..${path.sep}`) &&
        !path.isAbsolute(path.relative(evidenceDir, stateRealPath)))) {
    throw Object.assign(new Error(), { code: 'browser_storage_state_not_private' })
  }
  const stateInfo = await lstat(value.storageStateFile).catch(() => null)
  if (!stateInfo?.isFile() || stateInfo.isSymbolicLink()) throw Object.assign(new Error(), { code: 'browser_storage_state_invalid' })
  const state = JSON.parse(await readFile(value.storageStateFile, 'utf8'))
  if (!state || !Array.isArray(state.cookies) || state.cookies.length !== 1 ||
      state.cookies[0]?.name !== 'ownerinc-editorial-dev' || state.cookies[0]?.value !== config.runId) {
    throw Object.assign(new Error(), { code: 'browser_storage_state_invalid' })
  }
  return { baseURL: base.origin, playwrightModule: value.playwrightModule, storageStateFile: stateRealPath }
}

function createLocalActorTransport(config, serviceSecret) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const actor = {
    version: 2,
    uid: `portal-page-task4-${config.runId}`,
    email: `${config.runId}@example.invalid`,
    name: 'Portal Pages Task 4 synthetic editor',
    capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false },
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.headers.authorization !== `Bearer ${serviceSecret}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"reason":"editorial_session_invalid"}')
      return
    }
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/internal/editorial/authority') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"mode":"payload","epoch":1}')
      return
    }
    if (request.method === 'POST' && url.pathname.endsWith('/session/resolve')) {
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 16 * 1024) {
          response.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        response.writeHead(400).end()
        return
      }
      if (body.cookie !== config.runId) {
        response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"reason":"editorial_session_invalid"}')
        return
      }
      if (url.pathname === '/api/internal/editorial/session/resolve') {
        // The V1 strategy intentionally declines; the next strategy independently
        // revalidates this exact synthetic cookie as a V2 knowledge actor.
        response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"reason":"editorial_session_invalid"}')
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ actor, expiresAt }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/internal/editorial/actor/check') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ actor: {
        uid: actor.uid, email: actor.email, name: actor.name, canManageNews: true,
      } }))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/internal/editorial/session/revoke') {
      response.writeHead(204).end()
      return
    }
    response.writeHead(404).end()
  })
  return server
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned_next_child_stop_timeout')), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

function stopOwnedChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    })
    if (result.error) child.kill()
  } else child.kill()
  return waitForChildExit(child, 7000)
}

async function readiness(baseURL, child) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) return false
    try {
      const response = await fetch(`${baseURL}/editorial/ready`, { redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(1000) })
      await response.body?.cancel()
      if (response.ok) return true
    } catch { /* The owned Next process is compiling or binding. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

async function runExactPreview(page, context, baseURL) {
  const saveButton = page.getByRole('button', { name: 'Salvar versão', exact: true })
  await saveButton.waitFor({ state: 'visible' })
  await saveButton.click()
  await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
  const link = page.getByRole('link', { name: 'Abrir prévia desta versão em nova aba', exact: true })
  const previewURL = new URL(await link.getAttribute('href'), baseURL)
  const versionID = previewURL.searchParams.get('version')
  assert.match(versionID || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)
  assert.equal(await link.getAttribute('target'), '_blank')
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
  const oldSummary = await page.getByLabel('Resumo', { exact: true }).inputValue()
  const previewTab = await context.newPage()
  const response = await previewTab.goto(previewURL.toString(), { waitUntil: 'domcontentloaded' })
  assert.equal(response?.status(), 200)
  assert.match(response?.headers()['cache-control'] || '', /private.*no-store/u)
  assert.equal(new URL(previewTab.url()).searchParams.get('version'), versionID)
  await previewTab.getByText('Esta prévia não publica a página.', { exact: true }).waitFor({ state: 'visible' })
  await previewTab.getByText(versionID, { exact: true }).waitFor({ state: 'visible' })

  const summary = page.getByLabel('Resumo', { exact: true })
  await summary.fill(`Alteração posterior ${Date.now()}`)
  await page.getByRole('status').filter({ hasText: 'Aguardando salvamento automático' }).waitFor({ state: 'visible' })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !(await saveButton.isEnabled())) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await saveButton.isEnabled(), true)
  await saveButton.click()
  await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
  await previewTab.reload({ waitUntil: 'domcontentloaded' })
  assert.equal(new URL(previewTab.url()).searchParams.get('version'), versionID)
  assert.equal(await previewTab.getByText(oldSummary, { exact: true }).count(), oldSummary ? 1 : 0)
  await previewTab.close()
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 0) throw Object.assign(new Error(), { code: 'unknown_argument' })
  if (process.env.CMS_DATABASE_URL !== undefined || process.env.DATABASE_URL !== undefined) {
    throw Object.assign(new Error(), { code: 'runtime_database_fallback_refused' })
  }
  const checked = readIntegrationConfig(process.env)
  await checkIntegrationDirectories(checked)
  const handoff = await readHandoff(checked)
  if (!handoff) {
    output(report('NOT_EXECUTED', [{ name: 'browser fixture handoff', status: 'NOT_EXECUTED',
      detail: 'Native disposable fixture has not written the private browser handoff.' }]))
    process.exitCode = 2
    return
  }

  const base = new URL(handoff.baseURL)
  const nextPort = Number(base.port)
  await requireFreeLoopbackPort(nextPort)
  const serviceSecret = randomBytes(36).toString('hex')
  const bridge = createLocalActorTransport(checked, serviceSecret)
  await new Promise((resolve, reject) => {
    bridge.once('error', reject)
    bridge.listen(0, '127.0.0.1', resolve)
  })
  const bridgeAddress = bridge.address()
  if (!bridgeAddress || typeof bridgeAddress === 'string') throw Object.assign(new Error(), { code: 'local_actor_transport_unavailable' })
  const bridgeURL = `http://127.0.0.1:${bridgeAddress.port}`
  const env = childEnvironment(checked, bridgeURL, serviceSecret)
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1',
    '--port', String(nextPort)], { cwd: cmsRoot, env, stdio: 'ignore', windowsHide: true })
  let browser
  let result = report('NOT_EXECUTED', [{ name: 'browser fixture startup', status: 'NOT_EXECUTED', detail: 'Browser fixture did not become ready.' }])
  try {
    if (!await readiness(handoff.baseURL, child)) throw Object.assign(new Error(), { code: 'local_next_fixture_unavailable' })
    const playwright = await import(pathToFileURL(handoff.playwrightModule).href)
    const chromium = playwright.chromium || playwright.default?.chromium
    if (!chromium?.launch) throw Object.assign(new Error(), { code: 'playwright_chromium_unavailable' })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ storageState: handoff.storageStateFile, viewport: { width: 1440, height: 900 } })
    context.setDefaultTimeout(15_000)
    const page = await context.newPage()
    const slug = `task-4-${checked.runId.slice(0, 8)}`
    await page.goto(`${handoff.baseURL}/editorial/admin/collections/portal-pages`, { waitUntil: 'domcontentloaded' })
    const target = page.locator('a[href*="/editorial/admin/collections/portal-pages/"]').filter({ hasText: slug }).first()
    await target.waitFor({ state: 'visible' })
    const href = await target.getAttribute('href')
    if (!href) throw Object.assign(new Error(), { code: 'synthetic_page_not_found' })
    await page.goto(new URL(href, handoff.baseURL).toString(), { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Salvar versão', exact: true }).waitFor({ state: 'visible' })

    const cases = []
    try {
      await runExactPreview(page, context, handoff.baseURL)
      cases.push({ name: 'private dynamic exact preview stays on its immutable Version after a later save',
        status: 'PASS', detail: 'Exact Version, private response headers and historical content were verified.' })
    } catch {
      cases.push({ name: 'private dynamic exact preview stays on its immutable Version after a later save',
        status: 'FAIL', detail: 'Browser assertion failed; sensitive request details were withheld.' })
    }
    for (const suite of [
      ['editorial controls and state races', runEditorialControlCases],
      ['all five native media destinations and upload lifecycle', runEditorialUploadCases],
    ]) {
      try {
        const casesFromSuite = await suite[1](page)
        for (const item of casesFromSuite) cases.push({ name: item.name, status: item.status,
          detail: item.status === 'PASS' ? item.detail : 'Browser assertion failed; sensitive request details were withheld.' })
      } catch {
        cases.push({ name: suite[0], status: 'FAIL', detail: 'Browser suite stopped unexpectedly; sensitive request details were withheld.' })
      }
    }
    const status = cases.some(item => item.status === 'FAIL') ? 'FAIL'
      : cases.some(item => item.status === 'NOT_EXECUTED') ? 'NOT_EXECUTED' : 'PASS'
    result = report(status, cases)
    await context.close()
  } finally {
    try { await browser?.close() } finally {
      await stopOwnedChild(child).catch(() => {})
      await new Promise(resolve => bridge.close(() => resolve()))
    }
  }
  await writeFile(path.join(checked.evidenceDir, resultName), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  output(result)
  if (result.status !== 'PASS') process.exitCode = result.status === 'FAIL' ? 1 : 2
}

try {
  await main()
} catch (error) {
  const code = safeCode(error)
  const value = report('NOT_EXECUTED', [{ name: 'browser fixture setup', status: 'NOT_EXECUTED', detail: code }])
  output(value)
  process.exitCode = 2
}

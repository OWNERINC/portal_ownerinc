#!/usr/bin/env node
// Explicit, disposable browser acceptance. The only CMS process this file may
// start is its own loopback Next child, backed by the guarded CMS test database
// and a local test-only V2 actor transport. No Docker or production service is
// started or contacted.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { checkIntegrationDirectories, readIntegrationConfig } from '../support/integration-config.mjs'
import { readPrivateEvidence, writePrivateEvidence } from '../support/private-evidence.mjs'
import { runEditorialControlAndUploadSuites } from './portal-page-editorial-browser-orchestration.mjs'
import { runEditorialControlCases } from './portal-page-editorial-controls.mjs'
import { createLocalActorTransport } from './portal-page-editorial-test-actor.mjs'
import { runEditorialUploadCases } from './portal-page-editorial-upload.mjs'
import { aggregateAcceptanceCases, expectedBrowserAcceptanceCases, notExecutedAcceptanceCases } from './portal-page-editorial-cases.mjs'

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
  try { value = JSON.parse(await readPrivateEvidence(handoffPath)) } catch { throw Object.assign(new Error(), { code: 'browser_handoff_invalid' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'baseURL,historicalPageID,playwrightModule,runId,storageStateFile,structuralPageID' ||
      value.runId !== config.runId || typeof value.structuralPageID !== 'string' ||
      typeof value.historicalPageID !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.structuralPageID) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.historicalPageID)) {
    throw Object.assign(new Error(), { code: 'browser_handoff_invalid' })
  }

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
  let state
  try { state = JSON.parse(await readPrivateEvidence(value.storageStateFile)) }
  catch { throw Object.assign(new Error(), { code: 'browser_storage_state_invalid' }) }
  if (!state || !Array.isArray(state.cookies) || state.cookies.length !== 1 ||
      state.cookies[0]?.name !== 'ownerinc-editorial-dev' || state.cookies[0]?.value !== config.runId) {
    throw Object.assign(new Error(), { code: 'browser_storage_state_invalid' })
  }
  return { baseURL: base.origin, playwrightModule: value.playwrightModule,
    storageStateFile: stateRealPath, structuralPageID: value.structuralPageID, historicalPageID: value.historicalPageID }
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

async function readBrowserRange(page, assetURL) {
  return page.evaluate(async href => {
    const response = await fetch(href, { headers: { Range: 'bytes=0-4' }, cache: 'no-store' })
    return { status: response.status, contentRange: response.headers.get('content-range'), body: await response.text() }
  }, assetURL)
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
  assert.match(previewURL.pathname,
    /^\/editorial\/portal-pages\/preview\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)
  assert.equal(await link.getAttribute('target'), '_blank')
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer')
  const oldSummary = await page.getByLabel('Resumo', { exact: true }).inputValue()
  const previewTab = await context.newPage()
  let keepOpenForRevocationProbe = false
  try {
    const response = await previewTab.goto(previewURL.toString(), { waitUntil: 'domcontentloaded' })
    assert.equal(response?.status(), 200)
    assert.match(response?.headers()['cache-control'] || '', /private.*no-store/u)
    assert.equal(new URL(previewTab.url()).searchParams.get('version'), versionID)
    await previewTab.getByText('Esta prévia não publica a página.', { exact: true }).waitFor({ state: 'visible' })
    await previewTab.getByText(versionID, { exact: true }).waitFor({ state: 'visible' })
    await previewTab.getByText(oldSummary, { exact: true }).waitFor({ state: 'visible' })

    const pdfLink = previewTab.locator('.portal-page-preview__pdf a').first()
    await pdfLink.waitFor({ state: 'visible' })
    const oldAssetURL = new URL(await pdfLink.getAttribute('href'), baseURL)
    assert.ok(oldAssetURL.pathname.includes(`/${versionID}/`), 'old_pdf_url_not_bound_to_exact_version')
    const firstRange = await readBrowserRange(previewTab, oldAssetURL.toString())
    assert.equal(firstRange.status, 206)
    assert.equal(firstRange.contentRange, 'bytes 0-4/16')
    assert.equal(firstRange.body, 'synth')

    const summary = page.getByLabel('Resumo', { exact: true })
    const newerSummary = `Alteração posterior ${Date.now()}`
    await summary.fill(newerSummary)
    await page.getByRole('status').filter({ hasText: 'Aguardando salvamento automático' }).waitFor({ state: 'visible' })
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !(await saveButton.isEnabled())) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(await saveButton.isEnabled(), true)
    await saveButton.click()
    await page.getByRole('status').filter({ hasText: 'Versão salva' }).waitFor({ state: 'visible' })
    const newerLink = page.getByRole('link', { name: 'Abrir prévia desta versão em nova aba', exact: true })
    const newerURL = new URL(await newerLink.getAttribute('href'), baseURL)
    const newerVersionID = newerURL.searchParams.get('version')
    assert.match(newerVersionID || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)
    assert.notEqual(newerVersionID, versionID, 'subsequent_save_reused_old_version_id')

    const publish = page.getByRole('button', { name: 'Publicar versão salva', exact: true })
    await publish.waitFor({ state: 'visible' })
    await publish.click()
    const confirmation = page.getByRole('dialog')
    await confirmation.waitFor({ state: 'visible' })
    await confirmation.getByRole('button', { name: 'Publicar esta versão', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Página publicada' }).waitFor({ state: 'visible' })

    await previewTab.reload({ waitUntil: 'domcontentloaded' })
    assert.equal(new URL(previewTab.url()).searchParams.get('version'), versionID)
    await previewTab.getByText(oldSummary, { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await previewTab.getByText(newerSummary, { exact: true }).count(), 0)
    const reloadedPdfURL = new URL(await previewTab.locator('.portal-page-preview__pdf a').first().getAttribute('href'), baseURL)
    assert.equal(reloadedPdfURL.toString(), oldAssetURL.toString())
    const secondRange = await readBrowserRange(previewTab, oldAssetURL.toString())
    assert.equal(secondRange.status, 206)
    assert.equal(secondRange.contentRange, firstRange.contentRange)
    assert.equal(secondRange.body, firstRange.body)
    keepOpenForRevocationProbe = true
    return { versionID, previewURL: previewURL.toString(), assetURL: oldAssetURL.toString(), previewTab }
  } finally { if (!keepOpenForRevocationProbe) await previewTab.close() }
}

async function revokeAndProbeOldAsset(page, context, { assetURL, baseURL, bridgeURL, serviceSecret, runId }) {
  const cookieName = 'ownerinc-editorial-dev'
  const beforeCookies = await context.cookies(baseURL)
  const fixtureCookie = beforeCookies.find(cookie => cookie.name === cookieName && cookie.value === runId)
  assert.ok(fixtureCookie, 'active_disposable_editorial_cookie_missing_before_revocation')

  const before = await readBrowserRange(page, assetURL)
  assert.equal(before.status, 206, 'fresh_editorial_range_failed_before_server_session_revocation')
  assert.ok(before.body.length > 0, 'pre_revocation_range_returned_no_media_bytes')

  const revokeResponse = await fetch(`${bridgeURL}/api/internal/editorial/session/revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie: runId }),
    redirect: 'error', cache: 'no-store',
  })
  if (revokeResponse.status === 404) {
    await revokeResponse.body?.cancel()
    throw Object.assign(new Error('synthetic_bridge_session_revoke_unsupported'), { code: 'synthetic_bridge_session_revoke_unsupported' })
  }
  assert.equal(revokeResponse.status, 204, 'disposable_authority_did_not_confirm_session_revocation')
  await revokeResponse.body?.cancel()

  const retainedCookies = await context.cookies(baseURL)
  assert.ok(retainedCookies.some(cookie => cookie.name === cookieName && cookie.value === runId),
    'browser_did_not_retain_the_stale_cookie_for_the_fresh_post_revocation_request')
  const response = await readBrowserRange(page, assetURL)
  assert.ok([401, 403].includes(response.status), `post_revocation_range_status:${response.status}`)
  assert.equal(response.contentRange, null, 'revoked_asset_response_advertised_media_range')
  const body = response.body
  assert.equal(body.includes(before.body), false, 'post_revocation_response_included_previous_media_bytes')
  assert.equal(body.includes('synthetic-pdf-00'), false, 'post_revocation_response_disclosed_pdf_bytes')
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
    const aggregate = aggregateAcceptanceCases(expectedBrowserAcceptanceCases,
      notExecutedAcceptanceCases(expectedBrowserAcceptanceCases, 'Native fixture handoff is unavailable.'))
    output(report(aggregate.status, aggregate.cases))
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
    const structuralPage = await context.newPage()
    const structuralEditorURL = new URL(
      `/editorial/admin/collections/portal-pages/${handoff.structuralPageID}`, handoff.baseURL).toString()
    await structuralPage.goto(structuralEditorURL, { waitUntil: 'domcontentloaded' })
    await structuralPage.getByRole('button', { name: 'Salvar versão', exact: true }).waitFor({ state: 'visible' })

    const cases = [{ name: 'browser fixture starts with an authenticated Portal Pages editor', status: 'PASS',
      detail: 'The guarded local editor session and synthetic Portal Pages document loaded.' }]
    try {
      const suiteCases = await runEditorialControlAndUploadSuites({
        page,
        structuralPage,
        runControls: runEditorialControlCases,
        runUploads: runEditorialUploadCases,
      })
      cases.push(...suiteCases.map(item => ({ ...item,
        detail: item.status === 'PASS' || item.status === 'NOT_EXECUTED'
          ? item.detail : 'Browser assertion failed; sensitive request details were withheld.' })))
    } catch {
      cases.push({ name: 'editorial controls and upload orchestration completed', status: 'FAIL',
        detail: 'Browser suites stopped unexpectedly; sensitive request details were withheld.' })
    }
    try {
      await page.goto(`${handoff.baseURL}/editorial/admin/collections/news-articles/create`, { waitUntil: 'domcontentloaded' })
      await page.waitForURL(/\/editorial\/admin\/collections\/news-articles\/[0-9a-f-]{36}/iu)
      await page.getByRole('button', { name: 'Conferir prévia salva', exact: true }).waitFor({ state: 'visible' })
      await page.getByRole('button', { name: 'Agendar revisão salva', exact: true }).waitFor({ state: 'visible' })
      await page.getByText('Histórico anterior à migração', { exact: true }).waitFor({ state: 'visible' })
      cases.push({ name: 'existing News controls smoke: preview, scheduling and legacy history render',
        status: 'PASS', detail: 'A disposable News draft loaded all existing editorial control slots.' })
    } catch {
      cases.push({ name: 'existing News controls smoke: preview, scheduling and legacy history render',
        status: 'FAIL', detail: 'Existing News control slots did not render in the disposable editor.' })
    }

    let historicalPreview
    const historicalCaseName = 'exact old preview remains fixed after a subsequent save and publication, including its Range asset'
    try {
      const historicalPage = await context.newPage()
      await historicalPage.goto(new URL(
        `/editorial/admin/collections/portal-pages/${handoff.historicalPageID}`, handoff.baseURL).toString(),
      { waitUntil: 'domcontentloaded' })
      await historicalPage.getByRole('button', { name: 'Salvar versão', exact: true }).waitFor({ state: 'visible' })
      historicalPreview = await runExactPreview(historicalPage, context, handoff.baseURL)
      cases.push({ name: historicalCaseName, status: 'PASS',
        detail: 'The exact old Version URL retained its summary and PDF Range bytes after a newer Version was published.' })
    } catch {
      cases.push({ name: historicalCaseName, status: 'FAIL',
        detail: 'Exact old-Version content or asset changed after a newer publication; sensitive details were withheld.' })
    }

    const revocationCaseName = 'fresh preview asset Range is denied after actual disposable editorial session revocation'
    if (!historicalPreview?.assetURL) {
      cases.push({ name: revocationCaseName, status: 'NOT_EXECUTED',
        detail: 'The historical-preview case did not produce an exact asset URL, so no revocation probe was issued.' })
    } else {
      try {
        await revokeAndProbeOldAsset(historicalPreview.previewTab, context, {
          assetURL: historicalPreview.assetURL,
          baseURL: handoff.baseURL,
          bridgeURL,
          serviceSecret,
          runId: checked.runId,
        })
        cases.push({ name: revocationCaseName, status: 'PASS',
          detail: 'The disposable authority revoked the cookie over HTTP; a fresh browser Range request with that retained cookie returned 401/403 and no media bytes.' })
      } catch (error) {
        if (error?.code === 'synthetic_bridge_session_revoke_unsupported') {
          cases.push({ name: revocationCaseName, status: 'NOT_EXECUTED',
            detail: 'The disposable authority does not implement the session-revocation HTTP contract required for this browser probe.' })
        } else {
          cases.push({ name: revocationCaseName, status: 'FAIL',
            detail: 'Fresh post-revocation asset request did not fail closed; sensitive request details were withheld.' })
        }
      } finally { await historicalPreview.previewTab.close().catch(() => {}) }
    }
    const aggregate = aggregateAcceptanceCases(expectedBrowserAcceptanceCases, cases)
    result = report(aggregate.status, aggregate.cases)
    await context.close()
  } finally {
    try { await browser?.close() } finally {
      await stopOwnedChild(child).catch(() => {})
      await new Promise(resolve => bridge.close(() => resolve()))
    }
  }
  await writePrivateEvidence(path.join(checked.evidenceDir, resultName), `${JSON.stringify(result, null, 2)}\n`)
  output(result)
  if (result.status !== 'PASS') process.exitCode = result.status === 'FAIL' ? 1 : 2
}

try {
  await main()
} catch (error) {
  const code = safeCode(error)
  const aggregate = aggregateAcceptanceCases(expectedBrowserAcceptanceCases,
    notExecutedAcceptanceCases(expectedBrowserAcceptanceCases, code))
  const value = report(aggregate.status, aggregate.cases)
  output(value)
  process.exitCode = 2
}

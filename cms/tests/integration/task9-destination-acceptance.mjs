import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  captureWithTemporaryDOMMask,
  captureTask9Screenshot,
  safeEventMessage,
  safePublicAccessibleName,
  safeBrowserPath,
  readTask9ReaderBootstrapState,
  safeTask9ReaderResourcePath,
  task9ResponseContentType,
  runTask9Operation,
} from './task9-browser-observability.mjs'

const routes = {
  cms: { label: 'Voltar à central editorial', path: '/cms.html' },
  reader: { label: 'Ler Owner News', path: '/announcements.html' },
}
const allowedClasses = new Set(['nav', 'nav-toggler', 'portal-navigation', 'template-default', 'template-default__wrap'])

/** Destination-only acceptance reuses the existing R9 draft and never edits/saves/publishes it. */
export async function checkNativeEditorialDestinations({ page, origin, directory, documentId, manifestId, signal }) {
  assert.match(documentId, /^[0-9a-f-]{36}$/iu, 'only the existing synthetic R9 draft is permitted')
  assert.match(manifestId || '', /^R\d+$/u, 'destination evidence must be scoped to its actual manifest ID')
  const runId = `${manifestId}-T9DEST-${randomUUID()}`
  const evidencePath = path.join(directory, `native-destinations-${runId}.json`)
  const failureJSON = path.join(directory, `${manifestId.toLowerCase()}-failure-${runId}.json`)
  const failurePNG = path.join(directory, `${manifestId.toLowerCase()}-failure-${runId}.png`)
  const screenshotPath = phase => path.join(directory, `${manifestId.toLowerCase()}-${phase}-${runId}.png`)
  const requestAudit = createEditorialRequestAudit(origin)
  const onRequest = requestAudit.onRequest
  const onResponse = requestAudit.onResponse
  page.on('request', onRequest)
  page.on('response', onResponse)

  const evidence = {
    scenario: `${manifestId} native-sidebar destination acceptance; not metadata acceptance`,
    manifestId,
    runId,
    documentId: '[existing-synthetic-R9-draft]',
    actions: { fieldEdits: 0, articleSaves: 0, publish: 0, forcedClicks: 0, directDestinationNavigation: 0 },
    stages: [],
  }
  let stage = 'open-existing-editor-document'
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${origin}/editorial/admin/collections/news-articles/${documentId}`)
    await page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    const clean = await waitForCleanDocument(page)
    assert.equal(clean.saveDraftDisabled, true, 'existing draft must be clean before sidebar navigation')
    assert.equal(clean.pending, false, 'editor must have no visible pending/busy state')
    assert.equal(requestAudit.snapshot().articleMutationViolation, false, 'no article POST/PATCH/PUT/DELETE may occur during this navigation-only run')
    evidence.stages.push({ stage, status: 'PASS', cleanDocument: clean })

    stage = 'open-native-payload-menu-before-cms'
    const cmsMenu = await openNativeMenu(page, origin, 'cms', observation => {
      evidence.stages.push({ stage: 'native-sidebar-public-control-observation', status: 'OBSERVED', ...observation })
    })
    evidence.stages.push({ stage, status: 'PASS', nativeButtonBefore: cmsMenu.before.button,
      nativeButtonAfter: cmsMenu.after.button, nativeStateBefore: cmsMenu.before.state,
      nativeStateAfter: cmsMenu.after.state, target: cmsMenu.target })
    await captureAllowed(page, screenshotPath('native-sidebar-open'), 'native-menu', signal)

    stage = 'cms-destination-normal-link-click'
    await clickAllowedDestination(page, origin, 'cms')
    await page.waitForURL(url => url.origin === origin && url.pathname === routes.cms.path, { timeout: 15000 })
    await page.getByRole('heading', { name: 'Editor CMS', exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(safeBrowserPath(page.url(), [origin]), routes.cms.path)
    evidence.stages.push({ stage, status: 'PASS', path: routes.cms.path,
      destinationDOM: { heading: 'Editor CMS', portalCMSPage: await page.locator('body.cms-page').count() === 1 } })
    await captureAllowed(page, screenshotPath('cms-destination'), 'cms', signal)
    assert.equal(requestAudit.snapshot().articleMutationViolation, false, 'CMS destination must not cause article mutations')

    stage = 'return-to-existing-editor'
    const returnLink = page.getByRole('link', { name: 'Abrir no Payload', exact: true })
    let returnMethod
    if (await returnLink.count() && await returnLink.isVisible()) {
      returnMethod = 'existing-CMS-user-link'
      await returnLink.click()
      await page.waitForURL(url => url.origin === origin && url.pathname === '/editorial-entry.html', { timeout: 15000 })
      await page.getByRole('button', { name: 'Abrir no Payload', exact: true }).click()
      await page.waitForURL(`${origin}/editorial/admin`, { timeout: 30000 })
      await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor({ state: 'visible' })
      await page.goto(`${origin}/editorial/admin/collections/news-articles/${documentId}`)
    } else {
      returnMethod = await reenterPayloadFromFreshEntry(page, origin, documentId)
    }
    await page.getByLabel('Data da fonte (AAAA-MM-DD)', { exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    const cleanAfterReturn = await waitForCleanDocument(page)
    assert.equal(safeBrowserPath(page.url(), [origin]), `/editorial/admin/collections/news-articles/[id]`)
    assert.equal(cleanAfterReturn.saveDraftDisabled, true)
    assert.equal(cleanAfterReturn.pending, false)
    assert.equal(requestAudit.snapshot().articleMutationViolation, false)
    evidence.stages.push({ stage, status: 'PASS', method: returnMethod, cleanDocument: cleanAfterReturn })

    stage = 'open-native-payload-menu-before-reader'
    const readerMenu = await openNativeMenu(page, origin, 'reader', observation => {
      evidence.stages.push({ stage: 'native-sidebar-public-control-observation-reader', status: 'OBSERVED', ...observation })
    })
    evidence.stages.push({ stage, status: 'PASS', nativeButtonBefore: readerMenu.before.button,
      nativeButtonAfter: readerMenu.after.button, nativeStateBefore: readerMenu.before.state,
      nativeStateAfter: readerMenu.after.state, target: readerMenu.target })

    stage = 'reader-destination-normal-link-click'
    await clickAllowedDestination(page, origin, 'reader')
    await page.waitForURL(url => url.origin === origin && url.pathname === routes.reader.path, { timeout: 15000 })
    evidence.stages.push({ stage: 'reader-bootstrap-before-heading-wait', status: 'OBSERVED',
      observation: await captureTask9ReaderBootstrap(page, signal) })
    try {
      await page.getByRole('heading', { name: 'Owner News', exact: true }).waitFor({ state: 'visible', timeout: 20000 })
    } catch (error) {
      evidence.readerBootstrapAtHeadingFailure = await captureTask9ReaderBootstrap(page, signal)
      throw error
    }
    assert.equal(safeBrowserPath(page.url(), [origin]), routes.reader.path)
    evidence.stages.push({ stage, status: 'PASS', path: routes.reader.path,
      destinationDOM: { heading: 'Owner News', readerIndex: await page.locator('#news-index').count() === 1 } })
    await captureAllowed(page, screenshotPath('reader-destination'), 'reader', signal)
    assert.equal(requestAudit.snapshot().articleMutationViolation, false, 'reader destination must not cause article mutations')

    const audit = requestAudit.snapshot()
    const unmatchedServerActions = audit.serverActionRequestCount - audit.serverActionResponseCount
    assert.equal(unmatchedServerActions, 0, 'every observed collection form-state POST must have a response')
    assert.equal(audit.serverActionNon200ResponseCount, 0, 'every observed form-state Server Action POST must return HTTP 200')
    evidence.serverActionPOSTs = audit.serverActionRequestCount
    evidence.serverActionPOSTStatuses = audit.serverActionResponseStatuses
    evidence.serverActionPOSTNon200Count = audit.serverActionNon200ResponseCount
    evidence.serverActionResult = audit.serverActionRequestCount ? 'PASS; all observed POST responses were HTTP 200' : 'NOT_EXERCISED; no form-state POST observed (not a vacuous pass)'
    evidence.articleMutationRequests = audit.articleMutationEvidence
    evidence.articleMutationCount = audit.articleMutationCount
    evidence.articleMutationViolation = audit.articleMutationViolation
    evidence.requestAudit = audit.requestLog
    evidence.responseAudit = audit.responseLog
    evidence.readerResponseAudit = audit.readerResponseLog
    evidence.outcome = 'PASS native-sidebar CMS and reader destinations; destination-only, no metadata retest'
    await runTask9Operation(signal, 'writeFile', () => writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' }))
    return { evidence: evidencePath, outcome: evidence.outcome, serverActionResult: evidence.serverActionResult,
      articleMutationRequests: audit.articleMutationCount }
  } catch (error) {
    if (signal?.aborted) throw error
    if (stage === 'reader-destination-normal-link-click' && !evidence.readerBootstrapAtHeadingFailure) {
      evidence.readerBootstrapAtFailure = await captureTask9ReaderBootstrap(page, signal)
    }
    evidence.outcome = 'FAIL; stopped at first failure'
    evidence.failure = { stage, name: safeName(error), message: safeEventMessage(error?.message) }
    const audit = requestAudit.snapshot()
    evidence.articleMutationRequests = audit.articleMutationEvidence
    evidence.articleMutationCount = audit.articleMutationCount
    evidence.articleMutationViolation = audit.articleMutationViolation
    evidence.serverActionPOSTs = audit.serverActionRequestCount
    evidence.serverActionPOSTStatuses = audit.serverActionResponseStatuses
    evidence.serverActionPOSTNon200Count = audit.serverActionNon200ResponseCount
    evidence.requestAudit = audit.requestLog
    evidence.responseAudit = audit.responseLog
    evidence.readerResponseAudit = audit.readerResponseLog
    try { await captureAllowed(page, failurePNG, 'failure', signal) } catch { /* preserve primary failure */ }
    await runTask9Operation(signal, 'writeFile', () => writeFile(failureJSON, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: 'wx' }))
    throw error
  } finally {
    if (!signal?.aborted) {
      page.off('request', onRequest)
      page.off('response', onResponse)
    }
  }
}

export async function captureTask9ReaderBootstrap(page, signal) {
  try {
    return await runTask9Operation(signal, 'reader.bootstrap.observe', () => page.evaluate(readTask9ReaderBootstrapState))
  } catch {
    // Diagnostics are secondary and must never replace the navigation's primary failure.
    return { available: false }
  }
}

/** Explicit fallback: normal user entry, then direct setup of only the existing editor document. */
export async function reenterPayloadFromFreshEntry(page, origin, documentId) {
  await page.goto(`${origin}/editorial-entry.html`)
  await page.getByRole('button', { name: 'Abrir no Payload', exact: true }).click()
  await page.waitForURL(`${origin}/editorial/admin`, { timeout: 30000 })
  await page.getByRole('link', { name: 'Enquetes', exact: true }).waitFor({ state: 'visible' })
  await page.goto(`${origin}/editorial/admin/collections/news-articles/${documentId}`)
  return 'fresh-normal-entry; direct-existing-editor-setup'
}

async function waitForCleanDocument(page) {
  await page.waitForFunction(() => {
    const saveDraft = document.querySelector('#action-save-draft, button.save-draft')
    const visiblePending = [...document.querySelectorAll('[aria-busy="true"]')].some(element => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
    return Boolean(saveDraft?.disabled) && !visiblePending
  }, null, { timeout: 15000 })
  return page.evaluate(() => ({
    saveDraftDisabled: Boolean(document.querySelector('#action-save-draft, button.save-draft')?.disabled),
    pending: [...document.querySelectorAll('[aria-busy="true"]')].some(element => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }),
    busyFormCount: document.querySelectorAll('form[aria-busy="true"]').length,
  }))
}

async function openNativeMenu(page, origin, targetKey, onObservation = () => {}) {
  const before = await inspectNativeSidebar(page, origin)
  onObservation({ phase: 'before-toggle-decision', button: before.button, state: before.state })
  assert.equal(before.button.visible, true, 'native Payload menu button must be visible')
  assert.ok(['Abrir Cardápio', 'Fechar Cardápio', 'Open menu', 'Close menu'].includes(before.button.label),
  'native menu must expose its translated public accessible label')
  if (!before.state.isOpen) {
    assert.ok(before.button.label === 'Abrir Cardápio' || before.button.label === 'Open menu', 'closed menu label must indicate opening')
    const preClickSampledAtMs = before.state.sampledAtMs
    await clickNativeMenuControl(page, before.button.label)
    const nativeClickCompletedAtMs = await page.evaluate(() => performance.now())
    onObservation({ phase: 'native-control-ordinary-click-completed', preClickSampledAtMs, nativeClickCompletedAtMs })
    await page.waitForFunction(() => {
      const shells = [...document.querySelectorAll('.template-default')]
      const shell = shells.length === 1 ? shells[0] : null
      const navs = shell ? [...shell.children].filter(node => node.matches('aside.nav')) : []
      const nav = navs.length === 1 ? navs[0] : null
      return nav?.classList.contains('nav--nav-open') && shell?.classList.contains('template-default--nav-open')
    }, null, { timeout: 10000 })
    onObservation({ phase: 'open-classes-observed', preClickSampledAtMs, nativeClickCompletedAtMs,
      classesObservedAtMs: await page.evaluate(() => performance.now()) })
  }
  const after = await inspectNativeSidebar(page, origin)
  onObservation({ phase: 'after-native-open', button: after.button, state: after.state })
  assert.equal(after.state.isOpen, true, 'Payload public nav-open DOM state must be active after native toggle')
  assert.ok(after.button.label === 'Fechar Cardápio' || after.button.label === 'Close menu', 'open native menu label must indicate closing')
  let target
  try {
    const readiness = await waitForDestinationReadiness(page, { origin, ...routes[targetKey] })
    target = await inspectDestinationLink(page, origin, targetKey)
    onObservation({ phase: 'destination-readiness-confirmed', target, readiness })
  } catch (error) {
    try {
      target = await inspectDestinationLink(page, origin, targetKey)
      onObservation({ phase: 'destination-readiness-timeout', target, readiness: error.readiness || null })
    } catch { /* retain the readiness error if the page is no longer inspectable */ }
    throw error
  }
  assert.equal(target.visible, true, 'target link in the named Payload sidebar must be visible')
  assert.equal(target.ready, true, 'Payload sidebar must be visibly open and the link hit-test actionable')
  return { before: { button: before.button, state: before.state }, after: { button: after.button, state: after.state }, target }
}

/** Scope the ordinary click to the visible main-template toggler; AppHeader renders a duplicate name. */
export async function clickNativeMenuControl(page, label) {
  const control = page.locator('.template-default__nav-toggler-wrapper').getByRole('button', { name: label, exact: true })
  assert.equal(await control.count(), 1, 'main Payload template must expose exactly one matching menu button')
  assert.equal(await control.isVisible(), true, 'main Payload menu button must be visible')
  await control.click()
}

/** Count every same-origin request while bounding only the diagnostic samples. */
export function createEditorialRequestAudit(origin, diagnosticLimit = 180, mutationEvidenceLimit = 20) {
  const requestLog = []
  const responseLog = []
  const readerResponseLog = []
  const articleMutationEvidence = []
  const serverActionRequests = new WeakSet()
  const serverActionResponseStatuses = []
  let articleMutationCount = 0
  let serverActionRequestCount = 0
  let serverActionResponseCount = 0
  let serverActionNon200ResponseCount = 0
  const onRequest = request => {
    let url
    try { url = new URL(request.url()) } catch { return }
    if (url.origin !== origin) return
    const pathname = safeBrowserPath(request.url(), [origin])
    const method = request.method()
    if (requestLog.length < diagnosticLimit) requestLog.push({ method, path: pathname })
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
      && (pathname === '/editorial/api/news-articles' || pathname === '/editorial/api/news-articles/[id]')) {
      articleMutationCount++
      if (articleMutationEvidence.length < mutationEvidenceLimit) articleMutationEvidence.push({ method, path: pathname })
    }
    if (method === 'POST' && pathname === '/editorial/admin/collections/news-articles/[id]') {
      serverActionRequestCount++
      serverActionRequests.add(request)
    }
  }
  const onResponse = response => {
    let url
    try { url = new URL(response.url()) } catch { return }
    if (url.origin !== origin) return
    const request = response.request()
    const pathname = safeBrowserPath(response.url(), [origin])
    const method = request.method()
    if (responseLog.length < diagnosticLimit) responseLog.push({ method, path: pathname, status: response.status() })
    const readerPath = safeTask9ReaderResourcePath(response.url(), [origin])
    if (readerPath && readerResponseLog.length < 100) {
      let contentType = 'other'
      try { contentType = task9ResponseContentType(response.headers()['content-type']) } catch { /* do not retain raw response headers */ }
      readerResponseLog.push({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'OTHER',
        path: readerPath, status: Number.isInteger(response.status()) ? response.status() : 0, contentType })
    }
    if (serverActionRequests.has(request)) {
      serverActionResponseCount++
      if (response.status() !== 200) serverActionNon200ResponseCount++
      if (serverActionResponseStatuses.length < mutationEvidenceLimit) serverActionResponseStatuses.push({ status: response.status() })
    }
  }
  return {
    onRequest,
    onResponse,
    snapshot: () => ({ articleMutationCount, articleMutationViolation: articleMutationCount > 0,
      articleMutationEvidence: [...articleMutationEvidence],
      serverActionRequestCount, serverActionResponseCount, serverActionNon200ResponseCount,
      serverActionResponseStatuses: [...serverActionResponseStatuses],
      requestLog: [...requestLog], responseLog: [...responseLog], readerResponseLog: [...readerResponseLog] }),
  }
}

async function inspectNativeSidebar(page, origin) {
  const raw = await page.evaluate(readNativeSidebarPublicState)
  return { button: { ...raw.button, label: safePublicAccessibleName(raw.button.label) }, state: raw.state }
}

/** Serializable read of Payload's public DOM contract; no React internals. */
export function readNativeSidebarPublicState() {
  // Payload also renders a hidden, tabIndex=-1 AppHeader toggler; bind to the main template control.
  const buttons = [...document.querySelectorAll('.template-default__nav-toggler-wrapper button.nav-toggler')]
  const button = buttons.length === 1 ? buttons[0] : null
  const shells = [...document.querySelectorAll('.template-default')]
  const shell = shells.length === 1 ? shells[0] : null
  const navs = shell ? [...shell.children].filter(node => node.matches('aside.nav')) : []
  const nav = navs.length === 1 ? navs[0] : null
  const buttonStyle = button ? getComputedStyle(button) : null
  const navStyle = nav ? getComputedStyle(nav) : null
  const rawExpanded = button?.getAttribute('aria-expanded') ?? null
  return {
    button: {
      label: button?.getAttribute('aria-label') || '',
      ariaExpanded: rawExpanded === null || rawExpanded === 'true' || rawExpanded === 'false' ? rawExpanded : '[other]',
      classOpen: Boolean(button?.classList.contains('nav-toggler--is-open')),
      visible: Boolean(button && button.getClientRects().length && buttonStyle?.visibility !== 'hidden' && buttonStyle?.display !== 'none'),
      count: buttons.length,
      sampledAtMs: typeof performance === 'undefined' ? null : performance.now(),
    },
    state: {
      isOpen: Boolean(nav?.classList.contains('nav--nav-open') && shell?.classList.contains('template-default--nav-open')),
      navClassOpen: Boolean(nav?.classList.contains('nav--nav-open')),
      shellClassOpen: Boolean(shell?.classList.contains('template-default--nav-open')),
      shellHydrated: Boolean(shell?.classList.contains('template-default--nav-hydrated')),
      shellAnimate: Boolean(shell?.classList.contains('template-default--nav-animate')),
      navAnimate: Boolean(nav?.classList.contains('nav--nav-animate')),
      shellCount: shells.length,
      navCount: navs.length,
      sampledAtMs: typeof performance === 'undefined' ? null : performance.now(),
      navOpacity: navStyle?.opacity || '', navVisibility: navStyle?.visibility || '',
      navPointerEvents: navStyle?.pointerEvents || '',
    },
  }
}

async function inspectDestinationLink(page, origin, targetKey) {
  const target = routes[targetKey]
  return page.evaluate(readDestinationObservation, { ...target, origin })
}

/** Playwright's RAF polling waits for actual visual/actionable readiness, not just React's open classes. */
export async function waitForDestinationReadiness(page, expected, timeout = 6000) {
  const timelineKey = '__task9DestinationReadinessTimeline'
  const captured = await page.evaluate(key => {
    if (Object.prototype.hasOwnProperty.call(window, key)) return false
    Object.defineProperty(window, key, { configurable: true, value: [] })
    return true
  }, timelineKey)
  let failure
  try {
    await page.waitForFunction(destinationIsActionable, { ...expected, timelineKey }, { timeout, polling: 'raf' })
  } catch (error) {
    failure = error
  }
  let samples = []
  try {
    if (captured) samples = await page.evaluate(key => Array.isArray(window[key]) ? window[key].slice(0, 60) : [], timelineKey)
  } catch { /* retain the click-readiness result if optional timeline evidence cannot be read */
  } finally {
    if (captured) {
      try { await page.evaluate(key => { delete window[key] }, timelineKey) } catch { /* retain the readiness result */ }
    }
  }
  const readiness = { captured, samples }
  if (failure) {
    failure.readiness = readiness
    throw failure
  }
  return readiness
}

async function clickAllowedDestination(page, origin, targetKey) {
  const target = routes[targetKey]
  const sidebar = page.locator('.template-default > aside.nav')
  const link = sidebar.getByRole('link', { name: target.label, exact: true })
  const measured = await inspectDestinationLink(page, origin, targetKey)
  assert.equal(measured.path, target.path, 'same-origin target path must match the allowlist')
  // Keep a normal locator click: Playwright's native actionability check is the final guard.
  await link.click()
}

async function captureAllowed(page, screenshotPath, kind, signal) {
  const prepare = mode => {
    const allow = new Set(mode === 'cms' ? ['Editor CMS'] : mode === 'reader' ? ['Owner News']
      : mode === 'failure' ? ['Editor CMS', 'Owner News'] : [])
    const originals = []
    const shells = [...document.querySelectorAll('.template-default')]
    const shell = shells.length === 1 ? shells[0] : null
    const navs = shell ? [...shell.children].filter(node => node.matches('aside.nav')) : []
    const nav = navs.length === 1 ? navs[0] : null
    const navStyle = nav ? getComputedStyle(nav) : null
    const navBounds = nav?.getBoundingClientRect()
    const navOpenAndVisible = Boolean(nav?.classList.contains('nav--nav-open')
      && shell?.classList.contains('template-default--nav-open')
      && Number.parseFloat(navStyle?.opacity || '0') >= 0.99
      && navStyle?.visibility !== 'hidden' && navStyle?.display !== 'none'
      && navBounds?.width && navBounds?.height)
    const destinationHeadingPresent = [...document.querySelectorAll('h1,h2')].some(heading => allow.has(heading.textContent?.trim() || ''))
    if (mode === 'failure' && !navOpenAndVisible && !destinationHeadingPresent) {
      Object.defineProperty(window, '__task9DestinationScreenshotOriginals', { configurable: true, value: originals })
      return false
    }
    const mark = element => {
      originals.push([element, element.getAttribute('data-task9-observable')])
      element.setAttribute('data-task9-observable', 'allow')
    }
    if (mode === 'native-menu' || (mode === 'failure' && navOpenAndVisible)) {
      for (const link of nav?.querySelectorAll('.portal-navigation a') || []) {
        if (['Voltar à central editorial', 'Ler Owner News'].includes(link.textContent?.trim() || '')) mark(link)
      }
      const buttons = [...document.querySelectorAll('.template-default__nav-toggler-wrapper button.nav-toggler')]
      const button = buttons.length === 1 ? buttons[0] : null
      if (button) mark(button)
    }
    for (const heading of document.querySelectorAll('h1,h2')) if (allow.has(heading.textContent?.trim() || '')) mark(heading)
    Object.defineProperty(window, '__task9DestinationScreenshotOriginals', { configurable: true, value: originals })
    return originals.length > 0
  }
  const restore = () => {
    for (const [element, previous] of window.__task9DestinationScreenshotOriginals || []) {
      if (previous === null) element.removeAttribute('data-task9-observable')
      else element.setAttribute('data-task9-observable', previous)
    }
    delete window.__task9DestinationScreenshotOriginals
  }
  await captureWithTemporaryDOMMask({
    page, prepare, prepareArgs: kind, restore, signal,
    capture: () => captureTask9Screenshot(signal, options => page.screenshot(options), screenshotPath,
      { fullPage: false, animations: 'disabled', timeout: 5000 }),
  })
}

/** Serializable public-DOM observation shared by the bounded wait and failure evidence. */
export function readDestinationObservation(expected) {
  const shells = [...document.querySelectorAll('.template-default')]
  const shell = shells.length === 1 ? shells[0] : null
  const navs = shell ? [...shell.children].filter(node => node.matches('aside.nav')) : []
  const nav = navs.length === 1 ? navs[0] : null
  const link = nav && [...nav.querySelectorAll('.portal-navigation a')]
    .find(anchor => anchor.textContent?.trim() === expected.label)
  if (!shell || !nav || !link) {
    return { found: Boolean(link), ready: false, visible: false, centerHitInsideLink: false,
      path: '[unlisted-destination]', shellCount: shells.length, navCount: navs.length,
      sampledAtMs: typeof performance === 'undefined' ? null : performance.now() }
  }

  const navStyle = getComputedStyle(nav)
  const linkStyle = getComputedStyle(link)
  const navBounds = nav.getBoundingClientRect()
  const bounds = link.getBoundingClientRect()
  const visible = Boolean(bounds.width && bounds.height && linkStyle.visibility !== 'hidden'
    && linkStyle.display !== 'none' && Number.parseFloat(navStyle.opacity) > 0)
  const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2
  const hit = visible && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
    ? document.elementFromPoint(x, y) : null
  const centerHitInsideLink = Boolean(hit && (hit === link || link.contains(hit)))
  const url = new URL(link.href)
  const path = url.origin === expected.origin && url.pathname === expected.path
    ? url.pathname : '[unlisted-destination]'
  const navOpacity = Number.parseFloat(navStyle.opacity)
  const inResponsiveLayout = innerWidth > 1440 || shell.classList.contains('template-default--nav-hydrated')
  const ready = Boolean(path === expected.path && shell.classList.contains('template-default--nav-open')
    && nav.classList.contains('nav--nav-open') && inResponsiveLayout
    && navStyle.display !== 'none' && navStyle.visibility !== 'hidden'
    && navStyle.pointerEvents !== 'none' && navOpacity >= 0.99
    && navBounds.width > 0 && navBounds.height > 0 && visible && centerHitInsideLink)
  return {
    found: true,
    ready,
    visible,
    path,
    shellCount: shells.length,
    navCount: navs.length,
    shellHydrated: shell.classList.contains('template-default--nav-hydrated'),
    shellOpen: shell.classList.contains('template-default--nav-open'),
    shellAnimate: shell.classList.contains('template-default--nav-animate'),
    navOpen: nav.classList.contains('nav--nav-open'),
    navAnimate: nav.classList.contains('nav--nav-animate'),
    responsiveLayout: inResponsiveLayout,
    navOpacity: Number.isFinite(navOpacity) ? navOpacity : null,
    navTransitionProperty: navStyle.transitionProperty,
    navTransitionDuration: navStyle.transitionDuration,
    navTransitionDelay: navStyle.transitionDelay,
    navVisibility: navStyle.visibility,
    navDisplay: navStyle.display,
    navPointerEvents: navStyle.pointerEvents,
    navRect: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(navBounds[key] * 100) / 100])),
    rect: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(bounds[key] * 100) / 100])),
    hitTag: hit?.tagName?.toLowerCase() || null,
    hitLabel: centerHitInsideLink ? expected.label
      : hit?.tagName === 'LABEL' && hit.textContent?.trim() === 'Category' ? 'Category' : '[other-or-none]',
    centerHitInsideLink,
    sampledAtMs: typeof performance === 'undefined' ? null : performance.now(),
  }
}

/** Serializable Playwright predicate; descendants inside the link count as receiving the click. */
export function destinationIsActionable(expected) {
  if (window.__task9RunAborted) throw new Error('task9_run_aborted')
  const shells = [...document.querySelectorAll('.template-default')]
  if (shells.length !== 1) return false
  const shell = shells[0]
  const navs = [...shell.children].filter(node => node.matches('aside.nav'))
  if (navs.length !== 1) return false
  const nav = navs[0]
  const link = [...nav.querySelectorAll('.portal-navigation a')]
    .find(anchor => anchor.textContent?.trim() === expected.label)
  if (!link) return false
  const url = new URL(link.href)
  const navStyle = getComputedStyle(nav)
  const linkStyle = getComputedStyle(link)
  const navRect = nav.getBoundingClientRect()
  const linkRect = link.getBoundingClientRect()
  const opacity = Number.parseFloat(navStyle.opacity)
  const x = linkRect.left + linkRect.width / 2
  const y = linkRect.top + linkRect.height / 2
  const hasLinkGeometry = linkRect.width > 0 && linkRect.height > 0
  const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
  const hit = hasLinkGeometry && inViewport ? document.elementFromPoint(x, y) : null
  const centerHitInsideLink = Boolean(hit && (hit === link || link.contains(hit)))
  const shellOpen = shell.classList.contains('template-default--nav-open')
  const navOpen = nav.classList.contains('nav--nav-open')
  const shellHydrated = shell.classList.contains('template-default--nav-hydrated')
  const ready = Boolean(url.origin === expected.origin && url.pathname === expected.path
    && shellOpen && navOpen && (innerWidth > 1440 || shellHydrated)
    && navStyle.display !== 'none' && navStyle.visibility !== 'hidden' && navStyle.pointerEvents !== 'none'
    && Number.isFinite(opacity) && opacity >= 0.99
    && navRect.width > 0 && navRect.height > 0 && hasLinkGeometry && inViewport
    && linkStyle.display !== 'none' && linkStyle.visibility !== 'hidden' && centerHitInsideLink)

  if (expected.timelineKey && typeof window !== 'undefined') {
    const timeline = window[expected.timelineKey]
    if (Array.isArray(timeline) && timeline.length < 60) timeline.push({
      sampledAtMs: typeof performance === 'undefined' ? null : Math.round(performance.now() * 100) / 100,
      shellOpen, shellHydrated, shellAnimate: shell.classList.contains('template-default--nav-animate'),
      navOpen, navAnimate: nav.classList.contains('nav--nav-animate'),
      responsiveLayout: innerWidth > 1440 || shellHydrated,
      navOpacity: Number.isFinite(opacity) ? Math.round(opacity * 1000) / 1000 : null,
      transitionProperty: navStyle.transitionProperty,
      transitionDuration: navStyle.transitionDuration,
      transitionDelay: navStyle.transitionDelay,
      navRect: { width: Math.round(navRect.width * 100) / 100, height: Math.round(navRect.height * 100) / 100 },
      hitTag: hit?.tagName?.toLowerCase() || null,
      centerHitInsideLink,
    })
  }
  return ready
}

function safeName(error) {
  return ['TimeoutError', 'AssertionError', 'Error'].includes(error?.name) ? error.name : 'Error'
}

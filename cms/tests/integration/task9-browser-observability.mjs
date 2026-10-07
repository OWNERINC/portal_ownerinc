import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const allowedHeadings = new Set([
  'Owner News', 'Sessão editorial', 'Coleções', 'News Articles', 'News Medias',
  'News Schedules', 'News Audits', 'Globais', 'News Home', 'Painel de Controle',
])
const allowedStatus = new Set([
  'Abrindo o painel editorial…',
  'Não foi possível abrir o painel. Verifique sua permissão e tente novamente.',
  'Validando a mesma conta do Portal…',
  'A sessão editorial expirou ou a permissão foi removida. Entre novamente pelo Portal.',
  'A conta do Portal não corresponde à sessão editorial. Entre novamente pelo Portal.',
  'Não foi possível validar ou encerrar a sessão editorial. O conteúdo foi ocultado. Tente novamente.',
])
const allowedTitles = new Set([
  'Painel editorial — Portal Ownerinc', 'Sessão editorial', 'Coleções', 'Coleções - Payload',
  'Collections', 'Collections - Payload', 'News Articles - Payload', 'Editando - News Article - Payload',
])
const task9ReaderResources = new Set([
  '/announcements.html', '/api/users/me', '/api/cms/session',
  '/api/announcements', '/api/announcements/categories', '/api/announcements/home',
  '/api/announcements/polls/current',
  '/css/tokens.css', '/css/layout.css', '/css/components.css', '/css/cms.css', '/css/owner-news.css',
  '/js/auth-shell.js', '/js/sidebar-state.js', '/js/sidebar.js', '/js/router-bootstrap.js',
  '/js/router.js', '/js/auth.js', '/js/firebase-config.js', '/js/editorial-session-watch.js',
  '/js/page-lifecycle.js', '/js/ui.js', '/js/announcements.js', '/js/pagination.js',
  '/js/cms-block-renderer.js', '/js/owner-news/catalog.js', '/js/owner-news/poll.js',
  '/js/owner-news/model.js', '/js/owner-news/reader-view.js', '/js/owner-news/navigation.js',
  '/js/owner-news/content-contract.js', '/js/owner-news/rich-content.js',
  '/js/owner-news/asset-path.mjs',
])
const task9ReaderAssetPaths = new Set([...task9ReaderResources].filter(value => value.startsWith('/js/') || value.startsWith('/css/')))

export function safeTask9ReaderResourcePath(value, allowedOrigins = []) {
  let url
  try { url = new URL(value) } catch { return null }
  if (url.username || url.password || !allowedOrigins.includes(url.origin)) return null
  const pathname = url.pathname
  if (task9ReaderResources.has(pathname)) return pathname
  if (/^\/api\/announcements\/[\da-f-]{36}(?:\/navigation)?$/iu.test(pathname)) {
    return pathname.endsWith('/navigation') ? '/api/announcements/[id]/navigation' : '/api/announcements/[id]'
  }
  return null
}

export function task9ResponseContentType(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase()
  if (mime === 'text/html') return 'text/html'
  if (['application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript'].includes(mime)) return 'js'
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  return 'other'
}

/** Classify locally; the input is never included in a diagnostic record. */
export function task9BrowserErrorCategory(value) {
  const message = String(value || '').slice(0, 2000)
  if (/does not provide an export named|export .* not found|requested module .* has no exported member/iu.test(message)) return 'undefined-export'
  if (/strict mime|mime type|content-type.*(?:javascript|module)|module script.*mime/iu.test(message)) return 'mime'
  if (/content security policy|\bcsp\b|refused to (?:load|connect|execute).*policy/iu.test(message)) return 'csp'
  if (/auth(?:entication)?(?:state| initialization| initialize)|initialize(?:d)? auth|firebase.*(?:auth|initialize)/iu.test(message)) return 'auth-initialization'
  if (/dynamically imported module|module import|importing a module script|failed to load module/iu.test(message)) return 'module-import'
  if (/failed to fetch|networkerror|net::err_|network request failed|loading chunk/iu.test(message)) return 'network'
  if (/failed to load resource|script error|error loading/iu.test(message)) return 'script-load'
  return 'other'
}

export function task9PageErrorName(value) {
  return new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'])
    .has(value) ? value : 'OtherError'
}

export function safeTask9PageErrorSource(stack, allowedOrigins = []) {
  const lines = String(stack || '').slice(0, 8000).split(/\r?\n/u)
  for (const line of lines) {
    const match = /(https?:\/\/[^\s)]+):(\d+):(\d+)/u.exec(line)
    if (!match) continue
    const resourcePath = safeTask9ReaderResourcePath(match[1], allowedOrigins)
    if (!resourcePath?.startsWith('/js/')) continue
    const lineNumber = Number(match[2]), columnNumber = Number(match[3])
    if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(columnNumber)
      || lineNumber < 1 || columnNumber < 1 || lineNumber > 10000000 || columnNumber > 10000000) continue
    return { path: resourcePath, line: lineNumber, column: columnNumber }
  }
  return null
}

export function sanitizeTask9WindowErrorCapture(captured, allowedOrigins = []) {
  const samples = Array.isArray(captured?.samples) ? captured.samples.slice(0, 30) : []
  const counts = captured?.counts
  const count = Number.isSafeInteger(counts?.count) && counts.count >= samples.length ? counts.count : samples.length
  const unknownCount = Number.isSafeInteger(counts?.unknownCount) && counts.unknownCount >= 0 && counts.unknownCount <= count
    ? counts.unknownCount : samples.filter(entry => entry.category === 'other').length
  const categories = new Set(['undefined-export', 'mime', 'csp', 'auth-initialization', 'module-import', 'network', 'script-load', 'other'])
  const windowErrors = samples.map(entry => ({
    type: entry.type === 'window.error' ? 'window.error' : 'unhandledrejection',
    name: task9PageErrorName(entry.name),
    category: categories.has(entry.category) ? entry.category : 'other',
    source: safeTask9PageErrorSource(entry.stack, allowedOrigins),
  }))
  return { windowErrors, windowErrorCount: count, windowErrorUnknownCount: unknownCount }
}

/** Serialized into the browser realm; only public DOM state and fixed enums leave it. */
export function readTask9ReaderBootstrapState() {
  const root = document.documentElement
  const main = document.getElementById('main-content')
  const heading = main?.querySelector('h1') || null
  const visibility = node => {
    if (!node) return { display: 'other', visibility: 'other', visible: false, rectPositive: false }
    const style = window.getComputedStyle(node)
    const display = style.display === 'none' ? 'none' : style.display === 'block' ? 'block' : 'other'
    const visibleStyle = style.visibility === 'visible'
    const visibilityValue = visibleStyle ? 'visible' : style.visibility === 'hidden' || style.visibility === 'collapse' ? 'hidden' : 'other'
    const rect = node.getBoundingClientRect()
    const rectPositive = rect.width > 0 && rect.height > 0
    return {
      display,
      visibility: visibilityValue,
      visible: display !== 'none' && visibleStyle && Number(style.opacity) > 0 && rectPositive,
      rectPositive,
    }
  }
  const mainVisibility = visibility(main)
  const headingVisibility = visibility(heading)
  const authState = root?.dataset?.authState
  const authStatus = authState === 'pending' ? 'loading'
    : authState === 'ready' && root?.dataset?.authSnapshot === 'true' ? 'signed-in'
      : ['signed-out', 'unauthenticated'].includes(authState) ? 'signed-out' : 'unknown'
  return {
    documentReadyState: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unknown',
    mainExists: Boolean(main),
    mainRoutePending: Boolean(main?.hasAttribute('data-route-pending')),
    mainDisplay: mainVisibility.display,
    mainVisibility: mainVisibility.visibility,
    mainVisible: mainVisibility.visible,
    mainRectPositive: mainVisibility.rectPositive,
    headingExists: Boolean(heading),
    headingTextMatchesOwnerNews: heading?.textContent?.trim() === 'Owner News',
    headingDisplay: headingVisibility.display,
    headingVisibility: headingVisibility.visibility,
    headingVisible: headingVisibility.visible,
    headingRectPositive: headingVisibility.rectPositive,
    authStatus,
    routeBootstrapState: 'not-exposed',
  }
}

export function redactMessage(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[url]')
    .replace(/\b(Bearer|token|cookie|authorization|secret|password)\b\s*[:=]?\s*[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/giu, '[id]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, '[redacted]')
    .slice(0, 500)
}

export function safeEventMessage(value) {
  const message = redactMessage(value)
  if (/^(?:TimeoutError: )?Timeout \d+ms exceeded$/u.test(message)) return message
  if (/^(?:TypeError: )?Failed to fetch$/u.test(message)) return message
  if (/^net::ERR_[A-Z_]+$/u.test(message)) return message
  if (/^Failed to load resource: the server responded with a status of \d+$/u.test(message)) return message
  return message ? '[redacted]' : ''
}

function safeFailureSummary(error) {
  const message = String(error?.message || '')
  const timeout = /(?:page\.waitForURL|locator\.waitFor|waitForURL):?\s*Timeout (\d+)ms exceeded/iu.exec(message)
  if (timeout) return `browser wait timed out after ${timeout[1]}ms`
  if (/timeout/iu.test(error?.name || '')) return 'browser operation timed out'
  return '[redacted failure details]'
}

export function safeBrowserPath(value, allowedOrigins = []) {
  let url
  try { url = new URL(value) } catch { return '[invalid-url]' }
  if (!allowedOrigins.includes(url.origin)) return '[external-url]'
  const pathname = url.pathname
  if (pathname === '/editorial-entry.html') return pathname
  if (pathname === '/cms.html' || pathname === '/announcements.html') return pathname
  if (pathname === '/editorial/admin' || pathname === '/editorial/admin/') return '/editorial/admin'
  if (/^\/editorial\/admin\/collections\/news-articles\/[\da-f-]{36}$/iu.test(pathname)) {
    return '/editorial/admin/collections/news-articles/[id]'
  }
  if (pathname === '/editorial/admin/collections/news-articles') return pathname
  if (pathname.startsWith('/editorial/admin/')) return '/editorial/admin/[route]'
  if (pathname === '/editorial/api/portal-polls') return pathname
  if (pathname.startsWith('/editorial/api/portal-polls/')) return '/editorial/api/portal-polls/[id]'
  if (pathname === '/api/cms/session' || pathname === '/editorial/api/portal-editors/me' || pathname === '/js/editorial-session-watch.js' || pathname === '/editorial/ready') return pathname
  if (pathname.startsWith('/editorial/api/news-articles/')) return '/editorial/api/news-articles/[id]'
  if (pathname === '/editorial/api/news-articles') return pathname
  if (pathname.startsWith('/_next/static/chunks/') && pathname.endsWith('.js')) return '/_next/static/chunks/[js]'
  if (pathname.startsWith('/_next/static/css/') && pathname.endsWith('.css')) return '/_next/static/css/[css]'
  if (pathname.startsWith('/_next/static/media/')) return '/_next/static/media/[asset]'
  if (pathname.startsWith('/_next/static/')) return '/_next/static/[other]'
  return '[unlisted-local-path]'
}

/** Keep only the two explicitly approved same-origin editorial destinations. */
export function safeEditorialDestination(value, allowedOrigins = []) {
  try {
    const url = new URL(value)
    if (url.username || url.password || !allowedOrigins.includes(url.origin)) return '[external-url]'
    if (url.pathname === '/cms.html') return '/cms.html'
    if (url.pathname === '/announcements.html') return '/announcements.html'
    return '[unlisted-destination]'
  } catch {
    return '[invalid-url]'
  }
}

/** Preserve only short human-readable control labels for diagnostics, never arbitrary attributes. */
export function safePublicAccessibleName(value) {
  const label = String(value || '').trim()
  return label.length <= 64 && /^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+){0,5}$/u.test(label)
    ? label
    : '[unlisted-accessible-name]'
}

export function isTask9MutatingRequest(method, pathname) {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(String(method || '').toUpperCase())
    && new Set([
      '/editorial/api/news-articles', '/editorial/api/news-articles/[id]',
      '/editorial/admin/collections/news-articles/[id]',
      '/editorial/api/portal-polls', '/editorial/api/portal-polls/[id]', '/api/cms/session',
    ]).has(pathname)
}

// This callback is serialized into the browser realm; deliberately no Node helpers/closures.
export function readRawEditorialNavigation() {
  return [...document.querySelectorAll('.portal-navigation a')].map(anchor => ({
    label: anchor.textContent?.trim() || '',
    href: anchor.href,
  }))
}

export async function readSanitizedEditorialNavigation(page, allowedOrigins = []) {
  const rawLinks = await page.evaluate(readRawEditorialNavigation)
  return rawLinks.map(link => ({
    label: ['Voltar à central editorial', 'Ler Owner News', 'Sair do editorial'].includes(link.label) ? link.label : '[unlisted-link]',
    path: safeEditorialDestination(link.href, allowedOrigins),
  }))
}

/** Apply a screenshot-only DOM mask and restore the injected style/markers on every exit path. */
export async function captureWithTemporaryDOMMask({ page, prepare, prepareArgs, capture, restore, restoreArgs, signal }) {
  let styleHandle
  let prepared = false
  let result
  let primaryError
  const checkpoint = label => {
    if (!signal?.aborted) return
    throw signal.reason instanceof Error ? signal.reason : new Error(`Task9 capture aborted at ${label}`)
  }
  try {
    checkpoint('prepare')
    const shouldCapture = await page.evaluate(prepare, prepareArgs)
    checkpoint('after-prepare')
    prepared = true
    if (shouldCapture === false) result = false
    else {
      styleHandle = await page.addStyleTag({ content: `
        html, body { background: #fff !important; }
        body * { visibility: hidden !important; }
        [data-task9-observable="allow"] { visibility: visible !important; }
        *::before, *::after { content: none !important; }
      ` })
      checkpoint('after-mask')
      result = await capture()
      checkpoint('after-screenshot')
    }
  } catch (error) {
    primaryError = error
  }
  let cleanupError
  if (!signal?.aborted) {
    try { await styleHandle?.evaluate(element => element.remove()) } catch (error) { cleanupError = error }
  }
  if (prepared && !signal?.aborted) {
    try { await page.evaluate(restore, restoreArgs) } catch (error) { cleanupError ||= error }
  }
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
  return result
}

export function attachBrowserDiagnostics(page, allowedOrigins) {
  const attachedAt = Date.now()
  const events = {
    console: [], requestFailed: [], responses: [], pageErrors: [], windowErrors: [], frameNavigations: [],
    readerResponses: [], consoleErrorCount: 0, consoleErrorUnknownCount: 0,
    pageErrorCount: 0, pageErrorUnknownCount: 0, requestFailedCount: 0, requestFailedUnknownCount: 0,
    articleMutationRequests: { count: 0, samples: [] },
    articleMutationResponses: { count: 0, samples: [] },
  }
  page.on('framenavigated', frame => {
    if (events.frameNavigations.length >= 50) return
    let mainFrame = false
    try { mainFrame = frame === page.mainFrame() } catch { /* page may be closing */ }
    events.frameNavigations.push({
      elapsedMs: Math.max(0, Date.now() - attachedAt),
      frame: mainFrame ? 'main' : 'child',
      path: safeBrowserPath(frame.url(), allowedOrigins),
    })
  })
  page.on('pageerror', error => {
    const category = task9BrowserErrorCategory(error?.message)
    events.pageErrorCount++
    if (category === 'other') events.pageErrorUnknownCount++
    if (events.pageErrors.length < 30) events.pageErrors.push({
      elapsedMs: Math.max(0, Date.now() - attachedAt),
      name: task9PageErrorName(error?.name), category,
      source: safeTask9PageErrorSource(error?.stack, allowedOrigins),
    })
  })
  page.on('console', message => {
    if (message.type() !== 'error') return
    const category = task9BrowserErrorCategory(message.text())
    events.consoleErrorCount++
    if (category === 'other') events.consoleErrorUnknownCount++
    if (events.console.length < 30) events.console.push({ elapsedMs: Math.max(0, Date.now() - attachedAt), type: 'error', category })
  })
  page.on('requestfailed', request => {
    const category = task9BrowserErrorCategory(request.failure()?.errorText)
    events.requestFailedCount++
    if (category === 'other') events.requestFailedUnknownCount++
    if (events.requestFailed.length < 30) events.requestFailed.push({
      elapsedMs: Math.max(0, Date.now() - attachedAt),
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) ? request.method() : 'OTHER',
      path: safeTask9ReaderResourcePath(request.url(), allowedOrigins) || safeBrowserPath(request.url(), allowedOrigins),
      category,
    })
  })
  page.on('request', request => {
    const safePath = safeBrowserPath(request.url(), allowedOrigins)
    if (!isTask9MutatingRequest(request.method(), safePath)) return
    events.articleMutationRequests.count++
    if (events.articleMutationRequests.samples.length < 20) {
      events.articleMutationRequests.samples.push({ method: request.method(), path: safePath })
    }
  })
  page.on('response', response => {
    const request = response.request()
    const safePath = safeBrowserPath(response.url(), allowedOrigins)
    const readerPath = safeTask9ReaderResourcePath(response.url(), allowedOrigins)
    if (readerPath && events.readerResponses.length < 100) {
      let contentType = 'other'
      try { contentType = task9ResponseContentType(response.headers()['content-type']) } catch { /* no raw header values in artifacts */ }
      events.readerResponses.push({
        elapsedMs: Math.max(0, Date.now() - attachedAt),
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) ? request.method() : 'OTHER',
        path: readerPath,
        status: Number.isInteger(response.status()) ? response.status() : 0,
        contentType,
      })
    }
    if (isTask9MutatingRequest(request.method(), safePath)) {
      events.articleMutationResponses.count++
      if (events.articleMutationResponses.samples.length < 20) {
        events.articleMutationResponses.samples.push({ method: request.method(), path: safePath, status: response.status() })
      }
    }
    if (events.responses.length >= 100) return
    if (safePath.startsWith('/_next/static/') || [
      '/api/cms/session', '/editorial/api/portal-editors/me', '/js/editorial-session-watch.js',
      '/editorial/ready', '/editorial/admin', '/editorial/admin/collections/news-articles',
      '/editorial/api/portal-polls', '/editorial/api/portal-polls/[id]',
      '/editorial/api/news-articles', '/editorial/api/news-articles/[id]',
    ].includes(safePath)) {
      events.responses.push({ elapsedMs: Math.max(0, Date.now() - attachedAt), method: redactMessage(request.method()), path: safePath, status: response.status() })
    }
  })
  return events
}

export async function installWindowErrorCapture(page, events) {
  try {
    await page.addInitScript(() => {
      const captured = []
      let eventCount = 0
      let unknownCount = 0
      Object.defineProperty(window, '__task9OuterWindowErrors', {
        get: () => captured.map(entry => ({ ...entry })), configurable: false,
      })
      Object.defineProperty(window, '__task9OuterWindowErrorCounts', {
        get: () => ({ count: eventCount, unknownCount }), configurable: false,
      })
      const classify = value => {
        const message = String(value || '').slice(0, 2000)
        if (/does not provide an export named|export .* not found|requested module .* has no exported member/iu.test(message)) return 'undefined-export'
        if (/strict mime|mime type|content-type.*(?:javascript|module)|module script.*mime/iu.test(message)) return 'mime'
        if (/content security policy|\bcsp\b|refused to (?:load|connect|execute).*policy/iu.test(message)) return 'csp'
        if (/auth(?:entication)?(?:state| initialization| initialize)|initialize(?:d)? auth|firebase.*(?:auth|initialize)/iu.test(message)) return 'auth-initialization'
        if (/dynamically imported module|module import|importing a module script|failed to load module/iu.test(message)) return 'module-import'
        if (/failed to fetch|networkerror|net::err_|network request failed|loading chunk/iu.test(message)) return 'network'
        if (/failed to load resource|script error|error loading/iu.test(message)) return 'script-load'
        return 'other'
      }
      const record = (type, error, message) => {
        eventCount++
        const errorMessage = error instanceof Error ? error.message : typeof message === 'string' ? message : ''
        const category = classify(errorMessage)
        if (category === 'other') unknownCount++
        if (captured.length >= 30) return
        const rawName = error instanceof Error ? error.name : type === 'window.error' ? 'ErrorEvent' : 'UnhandledRejection'
        const name = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'AbortError'])
          .has(rawName) ? rawName : 'OtherError'
        captured.push({
          type: type === 'window.error' ? 'window.error' : 'unhandledrejection',
          name,
          category,
          stack: error instanceof Error ? String(error.stack || '').slice(0, 8000) : '',
        })
      }
      window.addEventListener('error', event => record('window.error', event.error, event.message), true)
      window.addEventListener('unhandledrejection', event => record('unhandledrejection', event.reason, ''), true)
    })
    events.windowErrorCapture = 'installed-before-navigation'
  } catch (error) {
    events.windowErrorCapture = 'installation-failed-before-navigation'
    throw error
  }
}

async function readAllowlistedPageState(page, allowedOrigins) {
  let pageURL = '[unavailable]'
  try { pageURL = safeBrowserPath(page.url(), allowedOrigins) } catch { /* page may already be closing */ }
  let frames = []
  try { frames = page.frames().map(frame => safeBrowserPath(frame.url(), allowedOrigins)) } catch { /* page may already be closing */ }
  let title = '[unlisted-title]'
  let headings = []
  let statuses = []
  try {
    const state = await page.evaluate(() => ({
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2')].map(node => node.textContent?.trim() || ''),
      statuses: [...document.querySelectorAll('#editorial-entry-status,[role="status"],[role="alert"],.portal-session-status p')]
        .map(node => node.textContent?.trim() || ''),
    }))
    if (allowedTitles.has(state.title)) title = state.title
    headings = state.headings.filter(value => allowedHeadings.has(value))
    statuses = state.statuses.filter(value => allowedStatus.has(value))
  } catch {
    // Preserve a useful record when the page closed or evaluation was blocked.
  }
  let readerBootstrap
  if (pageURL === '/announcements.html') {
    try { readerBootstrap = await page.evaluate(readTask9ReaderBootstrapState) }
    catch { readerBootstrap = { available: false } }
  }
  return { url: pageURL, frameCount: frames.length, frames, title, headings, statuses,
    ...(readerBootstrap ? { readerBootstrap } : {}) }
}

async function captureAllowlistedScreenshot(page, capture, signal) {
  return captureWithTemporaryDOMMask({
    page,
    signal,
    prepare: () => {
      const headings = new Set([
        'Owner News', 'Sessão editorial', 'Coleções', 'News Articles', 'News Medias',
        'News Schedules', 'News Audits', 'Globais', 'News Home', 'Painel de Controle',
      ])
      const statuses = new Set([
        'Abrindo o painel editorial…',
        'Não foi possível abrir o painel. Verifique sua permissão e tente novamente.',
        'Validando a mesma conta do Portal…',
        'A sessão editorial expirou ou a permissão foi removida. Entre novamente pelo Portal.',
        'A conta do Portal não corresponde à sessão editorial. Entre novamente pelo Portal.',
        'Não foi possível validar ou encerrar a sessão editorial. O conteúdo foi ocultado. Tente novamente.',
      ])
      const key = '__task9OuterMaskOriginals'
      const originals = []
      for (const node of document.querySelectorAll('h1,h2,#editorial-entry-status,[role="status"],[role="alert"],.portal-session-status p')) {
        const value = node.textContent?.trim() || ''
        if (headings.has(value) || statuses.has(value)) {
          originals.push([node, node.getAttribute('data-task9-observable')])
          node.setAttribute('data-task9-observable', 'allow')
        }
      }
      Object.defineProperty(window, key, { configurable: true, value: originals })
      return originals.length > 0
    },
    capture,
    restore: () => {
      for (const [node, previous] of window.__task9OuterMaskOriginals || []) {
        if (previous === null) node.removeAttribute('data-task9-observable')
        else node.setAttribute('data-task9-observable', previous)
      }
      delete window.__task9OuterMaskOriginals
    },
  })
}

export async function captureOuterBrowserObservation({
  browser, directory, allowedOrigins, events, prefix = 'outer-browser-failure', outcome = 'failure', error, signal, failureContext,
}) {
  const observedMutatingResponses = events?.articleMutationResponses || { count: 0, samples: [] }
  const legacyFailureContext = outcome === 'failure' ? {
    terminalKind: 'legacy-failure',
    abortReason: { source: 'legacy-caller', reasonType: error == null ? String(error) : error instanceof Error ? 'Error' : typeof error },
    inFlightOperationCount: error?.task9InFlightOperationCount || 0,
    inFlightOperations: error?.task9InFlightOperations || [],
    inFlightHTTP: error?.task9InFlightHTTP || [],
  } : undefined
  const artifactFailureContext = failureContext ?? legacyFailureContext
  const dataOutcome = task9AmbiguousOutcomeWarning(error, observedMutatingResponses.count, artifactFailureContext)
  const pathJSON = path.join(directory, `${prefix}.json`)
  const pathPNG = path.join(directory, `${prefix}.png`)
  const pages = []
  let screenshot = 'not-captured'
  let contexts = []
  try { contexts = browser?.contexts?.() || [] } catch { /* browser may already be closing */ }
  const openPages = []
  for (const context of contexts) {
    try { openPages.push(...context.pages()) } catch { /* context may already be closing */ }
  }
  for (const page of openPages) {
      if (signal?.aborted) throw signal.reason
      const state = await readAllowlistedPageState(page, allowedOrigins)
      pages.push(state)
      if (screenshot !== 'not-captured') continue
      try {
        const captured = await captureAllowlistedScreenshot(page, async () => {
          const image = await runTask9Operation(signal, 'capture.screenshot', () => page.screenshot({ fullPage: false, animations: 'disabled' }))
          await writeTask9ScreenshotArtifact(signal, image, pathPNG)
          return true
        }, signal)
        if (captured) screenshot = pathPNG
      } catch {
        if (signal?.aborted) throw signal.reason
        screenshot = 'capture-failed'
      }
  }
  if (screenshot === 'not-captured') screenshot = 'not-captured-no-allowlisted-content'
  const windowErrors = []
  let windowErrorCount = 0
  let windowErrorUnknownCount = 0
  for (const page of openPages) {
    try {
      if (signal?.aborted) throw signal.reason
      const captured = await page.evaluate(() => ({
        samples: Array.isArray(window.__task9OuterWindowErrors) ? window.__task9OuterWindowErrors : [],
        counts: window.__task9OuterWindowErrorCounts || null,
      }))
      const sanitized = sanitizeTask9WindowErrorCapture(captured, allowedOrigins)
      windowErrorCount += sanitized.windowErrorCount
      windowErrorUnknownCount += sanitized.windowErrorUnknownCount
      windowErrors.push(...sanitized.windowErrors.slice(0, Math.max(0, 30 - windowErrors.length)))
    } catch {
      // The init script may not have run (or the page may already be closed).
    }
  }
  await runTask9Operation(signal, 'capture.mkdir', () => mkdir(directory, { recursive: true }))
  await runTask9Operation(signal, 'capture.writeFile', () => writeFile(pathJSON, JSON.stringify({
    capture: 'before-cleanup',
    runner: 'outer-runner',
    outcome,
    ...(artifactFailureContext ? { failure: {
      name: redactMessage(error?.name || 'Error'),
      message: safeFailureSummary(error),
      terminalKind: artifactFailureContext.terminalKind,
      abortReason: artifactFailureContext.abortReason,
      inFlightOperationCountAtFailure: artifactFailureContext.inFlightOperationCount || 0,
      ...(Array.isArray(artifactFailureContext.inFlightOperations)
        ? { inFlightOperationsAtDeadline: artifactFailureContext.inFlightOperations.slice(0, 30).map(item => ({
          label: redactMessage(item.label), count: item.count,
        })) }
        : {}),
      ...(dataOutcome ? { dataOutcome } : {}),
      inFlightHTTPCountAtFailure: artifactFailureContext.inFlightHTTPCount || 0,
      ...(artifactFailureContext.inFlightHTTP?.length ? { inFlightHTTPAtDeadline: artifactFailureContext.inFlightHTTP.slice(0, 30) } : {}),
      ...(observedMutatingResponses.count ? { observedMutatingResponses } : {}),
      ...(artifactFailureContext.abortedAt ? { abortedAt: redactMessage(artifactFailureContext.abortedAt) } : {}),
    } } : {}),
    windowErrorCapture: events?.windowErrorCapture || 'not-installed',
    pages,
    screenshot,
    events: {
      console: (events?.console || []).slice(0, 30),
      consoleErrorCount: events?.consoleErrorCount || 0,
      consoleErrorUnknownCount: events?.consoleErrorUnknownCount || 0,
      pageErrors: (events?.pageErrors || []).slice(0, 30),
      pageErrorCount: events?.pageErrorCount || 0,
      pageErrorUnknownCount: events?.pageErrorUnknownCount || 0,
      requestFailed: (events?.requestFailed || []).slice(0, 30),
      requestFailedCount: events?.requestFailedCount || 0,
      requestFailedUnknownCount: events?.requestFailedUnknownCount || 0,
      responses: (events?.responses || []).slice(0, 100),
      readerResponses: (events?.readerResponses || []).slice(0, 100),
      windowErrors,
      windowErrorCount,
      windowErrorUnknownCount,
      frameNavigations: (events?.frameNavigations || []).slice(0, 50),
    },
  }, null, 2), { mode: 0o600, flag: 'wx' }))
  return { json: pathJSON, screenshot }
}

export async function captureOuterBrowserFailure(options) {
  return captureOuterBrowserObservation({ ...options, prefix: 'outer-browser-failure', outcome: 'failure' })
}

const ambiguousInFlightMethods = new Set([
  'goto', 'reload', 'click', 'dblclick', 'fill', 'press', 'check', 'uncheck', 'selectOption',
  'evaluate', 'evaluateHandle', 'fetch', 'get', 'post', 'put', 'patch', 'delete', 'fulfill', 'continue', 'route',
  'screenshot', 'newPage', 'newContext', 'launch', 'listen', 'spawn', 'addInitScript',
  'writeFile', 'publish', 'rename', 'unlink', 'query', 'prepare',
])
const task9SignalStates = new WeakMap()
const MAX_IN_FLIGHT_DIAGNOSTIC_LABELS = 30

function snapshotTask9State(state) {
  const entries = [...state.activeOperations.entries()]
  return {
    count: entries.reduce((total, [, count]) => total + count, 0),
    operations: entries.slice(0, MAX_IN_FLIGHT_DIAGNOSTIC_LABELS).map(([label, count]) => ({ label, count })),
  }
}

function attachTask9Snapshot(error, state) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error
  try { if (Object.hasOwn(error, 'task9InFlightOperationCount')) return error } catch { return error }
  const snapshot = snapshotTask9State(state)
  try {
    error.task9InFlightOperations = snapshot.operations
    error.task9InFlightOperationCount = snapshot.count
  } catch { /* frozen primary errors retain their identity; failureContext carries the snapshot */ }
  return error
}

function getTask9SignalState(signal) {
  let state = signal ? task9SignalStates.get(signal) : null
  if (state) return state
  state = { activeOperations: new Map(), abortListenerRegistered: false }
  if (signal && typeof signal === 'object') {
    task9SignalStates.set(signal, state)
    if (typeof signal.addEventListener === 'function') {
      state.abortListenerRegistered = true
      signal.addEventListener('abort', () => {
        const error = signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Task9 run aborted'), { name: 'AbortError' })
        attachTask9Snapshot(error, state)
      }, { once: true })
    }
  }
  return state
}

export function snapshotTask9InFlightOperations(signal) {
  const state = signal ? task9SignalStates.get(signal) : null
  return state ? snapshotTask9State(state) : { count: 0, operations: [] }
}

export function hasAmbiguousTask9Outcome(error, observedMutationCount = 0, failureContext) {
  return Boolean(error?.task9InFlightOperationCount > 0 || error?.task9InFlightOperations?.length
    || (error?.task9InFlightHTTP || []).some(item => item.count > 0)
    || failureContext?.inFlightOperationCount > 0 || failureContext?.inFlightHTTPCount > 0 || failureContext?.inFlightOperations?.length
    || (failureContext?.inFlightHTTP || []).some(item => item.count > 0) || observedMutationCount > 0)
}

export function task9AmbiguousOutcomeWarning(error, observedMutationCount = 0, failureContext) {
  return hasAmbiguousTask9Outcome(error, observedMutationCount, failureContext)
    ? 'AMBIGUOUS — an already-dispatched operation may have completed; no automatic retry; external effects cannot be undone by this harness'
    : null
}

export function shouldAbortTask9Request(signal) {
  return Boolean(signal?.aborted)
}

/**
 * Abort checkpoints around awaited Playwright operations. No unsupported Playwright cancellation
 * option is assumed: already-dispatched APIRequestContext/server effects remain ambiguous and
 * are recorded, while post-deadline continuations are blocked and contexts close after capture.
 * Labels contain no URLs, bodies, or user data.
 */
export function createTask9RunGuard(signal) {
  const proxies = new WeakMap()
  const originals = new WeakMap()
  const state = getTask9SignalState(signal)
  const pageCreatedListeners = new Set()
  const reason = () => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Task9 run aborted'), { name: 'AbortError' })
  const checkpoint = label => {
    if (signal?.aborted) {
      const error = reason()
      attachTask9Snapshot(error, state)
      error.task9AbortedAt = String(label || 'checkpoint').slice(0, 80)
      throw error
    }
  }
  const activeLabel = label => String(label).slice(0, 80)
  const begin = label => {
    const key = String(label).split('.').at(-1)
    const tracked = ambiguousInFlightMethods.has(key)
    const name = activeLabel(label)
    if (tracked) state.activeOperations.set(name, (state.activeOperations.get(name) || 0) + 1)
    return () => {
      if (!tracked) return
      const remaining = (state.activeOperations.get(name) || 1) - 1
      if (remaining > 0) state.activeOperations.set(name, remaining)
      else state.activeOperations.delete(name)
    }
  }

  const run = async (label, operation) => {
    checkpoint(label)
    const finish = begin(label)
    try {
      const value = await operation()
      checkpoint(label)
      return value
    } finally {
      finish()
    }
  }

  const wrap = (value, label = 'browser') => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
    if (value instanceof Promise) return value
    // Binary payloads are values, not browser API objects: proxying Buffer breaks
    // identity/brand checks used by Node's filesystem APIs.
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    if (proxies.has(value)) return proxies.get(value)
    const proxy = new Proxy(value, {
      get(target, property) {
        const member = Reflect.get(target, property, target)
        if (typeof member !== 'function') return wrap(member, `${label}.${String(property)}`)
        return (...args) => {
          const methodLabel = `${label}.${String(property)}`
          const guardedArgs = (property === 'on' || property === 'once' || property === 'addListener' || property === 'route')
            ? args.map(argument => typeof argument === 'function' ? (...eventArgs) => {
              try { checkpoint(`${methodLabel}.callback`) } catch { return undefined }
              try {
                const result = argument(...eventArgs.map(item => wrap(item, `${methodLabel}.event`)))
                if (result && typeof result.then === 'function') return result.catch(() => undefined)
                return result
              } catch { return undefined }
            } : argument)
            : args
          checkpoint(methodLabel)
          const result = Reflect.apply(member, target, guardedArgs)
          if (result && typeof result.then === 'function') {
            return run(methodLabel, () => result).then(value => {
              if (property === 'newPage') for (const listener of pageCreatedListeners) listener(value)
              return wrap(value, methodLabel)
            })
          }
          checkpoint(methodLabel)
          return wrap(result, methodLabel)
        }
      },
    })
    proxies.set(value, proxy)
    originals.set(proxy, value)
    return proxy
  }

  return {
    checkpoint,
    run,
    wrap,
    unwrap: value => originals.get(value) || value,
    inFlightOperations: () => snapshotTask9State(state),
    onPageCreated: listener => { pageCreatedListeners.add(listener); return () => pageCreatedListeners.delete(listener) },
  }
}

export function runTask9Operation(signal, label, operation) {
  const state = getTask9SignalState(signal)
  const checkpoint = () => {
    if (!signal?.aborted) return
    const error = signal.reason instanceof Error ? signal.reason : new Error('Task9 run aborted')
    attachTask9Snapshot(error, state)
    throw error
  }
  checkpoint()
  const name = String(label).slice(0, 80)
  const method = String(label).split('.').at(-1)
  const tracked = ambiguousInFlightMethods.has(method)
  if (tracked) state.activeOperations.set(name, (state.activeOperations.get(name) || 0) + 1)
  return Promise.resolve().then(operation).then(value => { checkpoint(); return value }).finally(() => {
    if (!tracked) return
    const remaining = (state.activeOperations.get(name) || 1) - 1
    if (remaining > 0) state.activeOperations.set(name, remaining)
    else state.activeOperations.delete(name)
  })
}

/** Write complete binary screenshot bytes to a no-overwrite PNG artifact. */
export async function writeTask9ScreenshotArtifact(signal, image, filePath, {
  write = writeFile, publish = link, remove = rm,
} = {}) {
  if (!Buffer.isBuffer(image) && !ArrayBuffer.isView(image) && !(image instanceof ArrayBuffer)) {
    throw new TypeError('Screenshot must be Buffer, ArrayBufferView, or ArrayBuffer bytes')
  }
  const bytes = image instanceof ArrayBuffer ? new Uint8Array(image) : image
  const incompletePath = `${filePath}.${randomUUID()}.incomplete`
  await runTask9Operation(signal, 'writeFile', () => write(incompletePath, bytes, { mode: 0o600, flag: 'wx' }))
  await runTask9Operation(signal, 'publish', () => publish(incompletePath, filePath))
  // The final name is only created after the completed staging file has been
  // linked. A cleanup failure must not invalidate the complete published PNG.
  try {
    await runTask9Operation(signal, 'unlink', () => remove(incompletePath, { force: true }))
  } catch (error) {
    if (signal?.aborted) throw error
    // A cleanup failure leaves a complete final artifact and a clearly marked staged sibling.
  }
  return filePath
}

/** Buffer screenshots in memory and write only after the post-await abort checkpoint. */
export async function captureTask9Screenshot(signal, screenshot, filePath, options = {}, write = writeFile) {
  const image = await runTask9Operation(signal, 'screenshot', () => screenshot(options))
  await writeTask9ScreenshotArtifact(signal, image, filePath, { write })
  return filePath
}

/** Run cleanup phases within one finite deadline, recording every timeout/failure. */
export async function runBoundedTask9Cleanup(steps, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  const failures = []
  for (const step of steps) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      failures.push(Object.assign(new Error(`Task9 cleanup budget exhausted before ${step.name}`), { name: 'TimeoutError' }))
      continue
    }
    let timer
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run(remaining)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Task9 cleanup step timed out: ${step.name}`)
            error.name = 'TimeoutError'
            reject(error)
          }, remaining)
        }),
      ])
    } catch (error) { failures.push(error) } finally { clearTimeout(timer) }
  }
  return failures
}

/** Capture before cleanup; deadlines reject the runner, abort work, and never replace its primary error. */
export async function runWithFailureCapture(work, {
  capture, cleanup, onCaptureFailure = () => {}, onWorkUnsettled = () => {}, onCleanupFailure = () => {},
  timeoutMs = 0, captureTimeoutMs = 10000, cleanupTimeoutMs = 15000, settleTimeoutMs = 2000,
  getFailureContextDetails = () => ({}),
}) {
  let value
  let failed = false
  let primaryError
  let failureContext
  let cleanupError
  const controller = new AbortController()
  let deadlineTimer
  let cleanupTimer
  let workSettled = true
  let workPromise
  let terminalFailureContext
  const snapshotFailure = (terminalKind, error) => {
    if (terminalFailureContext) return terminalFailureContext
    const state = getTask9SignalState(controller.signal)
    const operationSnapshot = snapshotTask9State(state)
    let details = {}
    try { details = getFailureContextDetails() || {} } catch { /* supplemental diagnostics cannot replace the primary failure */ }
    const rawHTTP = Array.isArray(details.inFlightHTTP) ? details.inFlightHTTP : []
    const inFlightHTTPCount = rawHTTP.reduce((total, item) => total + Math.max(0, Number(item?.count) || 0), 0)
    const inFlightHTTP = rawHTTP.slice(0, MAX_IN_FLIGHT_DIAGNOSTIC_LABELS).map(item => Object.freeze({
      label: redactMessage(item?.label || 'http.in-flight'), count: Math.max(0, Number(item?.count) || 0),
    }))
    terminalFailureContext = Object.freeze({
      terminalKind,
      abortReason: Object.freeze({
        source: terminalKind,
        reasonType: error instanceof Error ? 'Error' : error === null ? 'null' : typeof error,
      }),
      inFlightOperationCount: operationSnapshot.count,
      inFlightOperations: Object.freeze(operationSnapshot.operations.map(item => Object.freeze({
        label: redactMessage(item.label), count: item.count,
      }))),
      inFlightHTTPCount,
      inFlightHTTP: Object.freeze(inFlightHTTP),
    })
    if (error instanceof Error) attachTask9Snapshot(error, state)
    if (!controller.signal.aborted) controller.abort(error)
    return terminalFailureContext
  }
  try {
    workSettled = false
    workPromise = Promise.resolve().then(() => work(controller.signal)).then(
      result => ({ status: 'fulfilled', result }),
      error => {
        // Snapshot before abort dispatches listeners or pending invocations can settle.
        // Keep the original rejection object as both the signal reason and primary error.
        const failureContext = snapshotFailure('ordinary-work-rejection', error)
        return { status: 'rejected', error, failureContext }
      },
    )
    const result = timeoutMs > 0
      ? await Promise.race([
        workPromise,
        new Promise(resolve => {
          deadlineTimer = setTimeout(() => {
            const error = new Error(`Task9 run deadline exceeded after ${timeoutMs}ms`)
            error.name = 'TimeoutError'
            const failureContext = snapshotFailure('work-deadline', error)
            resolve({ status: 'deadline', error, failureContext })
          }, timeoutMs)
        }),
      ])
      : await workPromise
    if (result.status === 'rejected' || result.status === 'deadline') {
      failureContext = result.failureContext
      throw result.error
    }
    value = result.result
  } catch (error) {
    failed = true
    primaryError = error
    failureContext ||= snapshotFailure('terminal-work-failure', error)
    try {
      if (captureTimeoutMs > 0) {
        let timer
        const captureController = new AbortController()
        try {
          await Promise.race([
            Promise.resolve().then(() => capture(error, captureController.signal, failureContext)),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const timeout = new Error(`Task9 failure capture exceeded ${captureTimeoutMs}ms`)
                timeout.name = 'TimeoutError'
                const captureState = task9SignalStates.get(captureController.signal)
                if (captureState) attachTask9Snapshot(timeout, captureState)
                captureController.abort(timeout)
                reject(timeout)
              }, captureTimeoutMs)
            }),
          ])
        } finally { clearTimeout(timer) }
      } else await capture(error, new AbortController().signal, failureContext)
    } catch (captureError) {
      try { onCaptureFailure(captureError) } catch { /* diagnostics must not mask the primary failure */ }
    }
  } finally {
    clearTimeout(deadlineTimer)
    try {
      if (cleanupTimeoutMs > 0) {
        await Promise.race([
          Promise.resolve().then(() => cleanup()),
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(() => {
              const error = new Error(`Task9 cleanup exceeded ${cleanupTimeoutMs}ms`)
              error.name = 'TimeoutError'
              reject(error)
            }, cleanupTimeoutMs)
          }),
        ])
      } else await cleanup()
    } catch (error) {
      cleanupError = error
      try { onCleanupFailure(error) } catch { /* secondary cleanup reporting must not mask the primary error */ }
    } finally { clearTimeout(cleanupTimer) }
    if (failed && workPromise) {
      const settled = await Promise.race([
        workPromise.then(() => true),
        new Promise(resolve => {
          const timer = setTimeout(() => resolve(false), settleTimeoutMs)
          timer.unref?.()
        }),
      ])
      workSettled = settled
      if (!workSettled) {
        const error = new Error('Task9 work did not settle after cleanup')
        error.name = 'TimeoutError'
        error.task9InFlightOperations = (primaryError?.task9InFlightOperations || []).slice(0, MAX_IN_FLIGHT_DIAGNOSTIC_LABELS)
        error.task9InFlightOperationCount = primaryError?.task9InFlightOperationCount || 0
        try { onWorkUnsettled(error) } catch { /* keep primary error */ }
      }
    }
  }
  if (failed) throw primaryError
  if (cleanupError) throw cleanupError
  return value
}

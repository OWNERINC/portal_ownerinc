import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const MAX_INITIATOR_FRAMES = 16
const CORRELATION_WINDOW_MS = 1200

export function classifyAllowedUrl(rawUrl, origin, sdkOrigin, sdkPaths) {
  try {
    const url = new URL(rawUrl)
    if (url.origin === origin) return { scope: 'local', path: url.pathname }
    if (url.origin === sdkOrigin && sdkPaths.has(url.pathname)) return { scope: 'pinned-sdk', path: url.pathname }
    return null
  } catch {
    return null
  }
}

export function sanitizedErrorText(rawError) {
  const text = String(rawError || '').split(/\r?\n/, 1)[0]
  if (!text) return null
  if (/^net::ERR_[A-Z0-9_]+$/.test(text)) return text
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try {
        const url = new URL(value)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url-redacted]'
      }
    })
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/__Host-ownerinc-editorial=[^;\s,]+/gi, '__Host-ownerinc-editorial=[redacted]')
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}(?:\.[a-zA-Z0-9_-]+)?\b/g, '[token-redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email-redacted]')
}

export function prefetchHeaderFlags(headers = {}) {
  const normalized = Object.create(null)
  for (const [name, value] of Object.entries(headers || {})) normalized[name.toLowerCase()] = String(value)
  const saysPrefetch = value => /(?:^|[,;\s])prefetch(?:$|[,;\s])/i.test(value || '')
  return {
    purposePrefetch: saysPrefetch(normalized.purpose),
    secPurposePrefetch: saysPrefetch(normalized['sec-purpose']),
    nextRouterPrefetch: normalized['next-router-prefetch'] === '1' || saysPrefetch(normalized['next-router-prefetch']),
    rscHeaderPresent: Object.hasOwn(normalized, 'rsc'),
  }
}

export function correlateSanitizedRequests(playwrightRequests, cdpRequests, windowMs = CORRELATION_WINDOW_MS) {
  const pwCandidates = new Map()
  const cdpCandidates = new Map()
  for (const pw of playwrightRequests) {
    const candidates = cdpRequests
      .filter(cdp => cdp.method === pw.method && cdp.path === pw.path && cdp.scope === pw.scope &&
        cdp.phase === pw.phase && Number.isFinite(cdp.wallTime) && Number.isFinite(pw.wallTime) &&
        Math.abs(cdp.wallTime - pw.wallTime) * 1000 <= windowMs)
      .map(cdp => ({
        cdpEventId: cdp.eventId,
        requestId: cdp.requestId,
        deltaMs: Math.round(Math.abs(cdp.wallTime - pw.wallTime) * 1000),
      }))
    pwCandidates.set(pw.id, candidates)
  }
  for (const cdp of cdpRequests) {
    const candidates = playwrightRequests
      .filter(pw => pw.method === cdp.method && pw.path === cdp.path && pw.scope === cdp.scope &&
        pw.phase === cdp.phase && Number.isFinite(cdp.wallTime) && Number.isFinite(pw.wallTime) &&
        Math.abs(cdp.wallTime - pw.wallTime) * 1000 <= windowMs)
    cdpCandidates.set(cdp.eventId, candidates)
  }

  const pairs = []
  for (const pw of playwrightRequests) {
    const candidates = pwCandidates.get(pw.id) || []
    const unique = candidates.length === 1 && (cdpCandidates.get(candidates[0].cdpEventId) || []).length === 1
    const pair = {
      playwrightObjectId: pw.id,
      status: unique ? 'unique-method-path-phase-walltime' : candidates.length ? 'ambiguous' : 'unmatched',
      candidateCdpRequestIds: candidates.map(candidate => candidate.requestId),
      candidateCdpEventIds: candidates.map(candidate => candidate.cdpEventId),
      wallTimeDeltasMs: candidates.map(candidate => candidate.deltaMs),
      cdpRequestId: unique ? candidates[0].requestId : null,
      cdpEventId: unique ? candidates[0].cdpEventId : null,
    }
    pw.correlation = pair
    if (unique) {
      const cdp = cdpRequests.find(candidate => candidate.eventId === pair.cdpEventId)
      if (cdp) cdp.correlatedPlaywrightObjectId = pw.id
    }
    pairs.push(pair)
  }
  return pairs
}

function finite(value) {
  return Number.isFinite(value) ? value : null
}

function safeEnum(value, fallback = 'unknown') {
  const text = String(value || '')
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(text) ? text : fallback
}



export function pendingLifecycleAtCapture(snapshot) {
  const requestCorrelations = Array.isArray(snapshot?.requestCorrelations) ? snapshot.requestCorrelations : []
  const playwrightRequests = Array.isArray(snapshot?.playwrightRequests) ? snapshot.playwrightRequests : []
  const cdpRequests = Array.isArray(snapshot?.cdpRequests) ? snapshot.cdpRequests : []
  const pairByPlaywrightId = new Map(requestCorrelations.map(pair => [pair.playwrightObjectId, pair]))
  const playwrightPending = playwrightRequests
    .filter(request => !request.requestFinished && !request.requestFailed)
    .map(request => {
      const correlation = pairByPlaywrightId.get(request.id) || request.correlation || null
      return {
        playwrightObjectId: request.id,
        phase: request.phase,
        operation: request.operation,
        method: request.method,
        path: request.path,
        resourceType: request.resourceType,
        responseStatus: Number.isInteger(request.response?.status) ? request.response.status : null,
        requestStatus: request.response ? 'response-received-awaiting-terminal-event' : 'no-response-awaiting-terminal-event',
        correlationStatus: correlation?.status || 'unavailable',
        cdpRequestId: correlation?.cdpRequestId || null,
        candidateCdpRequestIds: Array.isArray(correlation?.candidateCdpRequestIds) ? correlation.candidateCdpRequestIds : [],
        candidateCdpEventIds: Array.isArray(correlation?.candidateCdpEventIds) ? correlation.candidateCdpEventIds : [],
      }
    })
  const playwrightCandidatesByCdpEventId = new Map()
  for (const correlation of requestCorrelations) {
    for (const eventId of correlation.candidateCdpEventIds || []) {
      const candidates = playwrightCandidatesByCdpEventId.get(eventId) || []
      candidates.push({ playwrightObjectId: correlation.playwrightObjectId, status: correlation.status })
      playwrightCandidatesByCdpEventId.set(eventId, candidates)
    }
  }
  const cdpPending = cdpRequests
    .filter(request => !request.loadingFinished && !request.loadingFailed && request.lifecycle !== 'redirected')
    .map(request => {
      const candidates = playwrightCandidatesByCdpEventId.get(request.eventId) || []
      return {
        cdpEventId: request.eventId,
        cdpRequestId: request.requestId,
        phase: request.phase,
        operation: request.operation,
        method: request.method,
        path: request.path,
        resourceType: request.resourceType,
        responseStatus: Number.isInteger(request.responseStatus) ? request.responseStatus : null,
        requestStatus: Number.isInteger(request.responseStatus) ? 'response-received-awaiting-terminal-event' : 'no-response-awaiting-terminal-event',
        correlationStatus: candidates.length === 0 ? 'unmatched' : candidates.length === 1 && candidates[0].status === 'unique-method-path-phase-walltime' ? 'unique-method-path-phase-walltime' : 'ambiguous',
        candidatePlaywrightObjectIds: candidates.map(candidate => candidate.playwrightObjectId),
      }
    })
  return {
    captureSequence: Number.isSafeInteger(snapshot?.sequence) ? snapshot.sequence : null,
    playwrightPendingCount: playwrightPending.length,
    cdpPendingCount: cdpPending.length,
    playwrightPending,
    cdpPending,
  }
}

export class HistoryLifecycleCollector {
  constructor({ origin, sdkOrigin, sdkPaths, getPhase, getOperation = () => null, onUpdate = () => {} }) {
    this.origin = origin
    this.sdkOrigin = sdkOrigin
    this.sdkPaths = new Set(sdkPaths)
    this.getPhase = getPhase
    this.getOperation = getOperation
    this.onUpdate = onUpdate
    this.sequence = 0
    this.playwrightSequence = 0
    this.cdpSequence = 0
    this.playwrightRequests = []
    this.cdpRequests = []
    this.navigationEvents = []
    this.actionEvents = []
    this.pageErrors = []
    this.consoleErrors = []
    this.requestObjects = new WeakMap()
    this.latestCdpByRequestId = new Map()
    this.session = null
    this.page = null
  }

  nextSequence() {
    this.sequence += 1
    return this.sequence
  }

  phaseEvent(action, timing = {}) {
    const record = {
      sequence: this.nextSequence(),
      phase: this.getPhase(),
      operation: this.getOperation(),
      action,
      at: new Date().toISOString(),
      ...timing,
    }
    this.actionEvents.push(record)
    this.onUpdate()
    return record
  }

  requestAddress(rawUrl) {
    return classifyAllowedUrl(rawUrl, this.origin, this.sdkOrigin, this.sdkPaths)
  }

  sourceAddress(rawUrl) {
    return this.requestAddress(rawUrl)?.path || '[external-redacted]'
  }

  initiatorFrames(stack, depth = 0) {
    if (!stack || depth > 2) return []
    const frames = Array.isArray(stack.callFrames) ? stack.callFrames.slice(0, 8).map(frame => ({
      filePath: this.sourceAddress(frame.url || ''),
      functionName: safeEnum(frame.functionName, '[anonymous]'),
      line: Number.isInteger(frame.lineNumber) ? frame.lineNumber : null,
      column: Number.isInteger(frame.columnNumber) ? frame.columnNumber : null,
    })) : []
    return frames.concat(this.initiatorFrames(stack.parent, depth + 1)).slice(0, MAX_INITIATOR_FRAMES)
  }

  recordNavigation(source, rawUrl, details = {}) {
    const address = this.requestAddress(rawUrl)
    const record = {
      eventId: `nav-${String(this.navigationEvents.length + 1).padStart(4, '0')}`,
      sequence: this.nextSequence(),
      phase: this.getPhase(),
      operation: this.getOperation(),
      source,
      scope: address?.scope || 'external-redacted',
      path: address?.path || '[external-redacted]',
      observedAt: new Date().toISOString(),
      ...details,
    }
    this.navigationEvents.push(record)
    this.onUpdate()
    return record
  }

  async attach(page) {
    if (this.session) throw new Error('collector-already-attached')
    this.page = page
    this.session = await page.context().newCDPSession(page)
    await this.session.send('Network.enable')
    await this.session.send('Page.enable')
    this.attachCdpListeners()
    this.attachPlaywrightListeners()
    this.phaseEvent('collector-attached-before-first-navigation')
  }

  attachCdpListeners() {
    this.session.on('Network.requestWillBeSent', event => {
      const address = this.requestAddress(event.request?.url || '')
      if (!address) return
      const previous = this.latestCdpByRequestId.get(event.requestId)
      if (previous && event.redirectResponse) {
        previous.redirectedWithStatus = Number.isInteger(event.redirectResponse.status) ? event.redirectResponse.status : null
        previous.redirectSequence = this.nextSequence()
        previous.redirectPhase = this.getPhase()
        previous.redirectOperation = this.getOperation()
        previous.redirectObservedAt = new Date().toISOString()
        previous.lifecycle = 'redirected'
      }
      const record = {
        eventId: `cdp-${String(++this.cdpSequence).padStart(5, '0')}`,
        requestId: event.requestId,
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
        method: String(event.request?.method || '').toUpperCase(),
        path: address.path,
        scope: address.scope,
        documentPath: event.documentURL ? this.sourceAddress(event.documentURL) : null,
        frameId: String(event.frameId || ''),
        loaderId: String(event.loaderId || ''),
        resourceType: safeEnum(event.type),
        timestamp: finite(event.timestamp),
        wallTime: finite(event.wallTime),
        initiatorType: safeEnum(event.initiator?.type),
        initiatorPath: event.initiator?.url ? this.sourceAddress(event.initiator.url) : null,
        initiatorStack: this.initiatorFrames(event.initiator?.stack),
        hasUserGesture: event.hasUserGesture === true,
        isLinkPreload: event.isLinkPreload === true,
        redirectResponseStatus: null,
        responseStatus: null,
        responsePhase: null,
        responseSequence: null,
        responseTimestamp: null,
        loadingFinished: null,
        loadingFailed: null,
        lifecycle: 'requestWillBeSent',
      }
      this.cdpRequests.push(record)
      this.latestCdpByRequestId.set(event.requestId, record)
      this.onUpdate()
    })

    this.session.on('Network.responseReceived', event => {
      const record = this.latestCdpByRequestId.get(event.requestId)
      if (!record) return
      record.responseStatus = Number.isInteger(event.response?.status) ? event.response.status : null
      record.responsePhase = this.getPhase()
      record.responseOperation = this.getOperation()
      record.responseSequence = this.nextSequence()
      record.responseTimestamp = finite(event.timestamp)
      record.responseObservedAt = new Date().toISOString()
      record.lifecycle = 'responseReceived'
      this.onUpdate()
    })

    this.session.on('Network.loadingFinished', event => {
      const record = this.latestCdpByRequestId.get(event.requestId)
      if (!record) return
      record.loadingFinished = {
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        timestamp: finite(event.timestamp),
        observedAt: new Date().toISOString(),
      }
      record.lifecycle = 'loadingFinished'
      this.onUpdate()
    })

    this.session.on('Network.loadingFailed', event => {
      const record = this.latestCdpByRequestId.get(event.requestId)
      if (!record) return
      record.loadingFailed = {
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        timestamp: finite(event.timestamp),
        observedAt: new Date().toISOString(),
        errorText: sanitizedErrorText(event.errorText),
        canceled: typeof event.canceled === 'boolean' ? event.canceled : null,
        blockedReason: event.blockedReason ? safeEnum(event.blockedReason) : null,
      }
      record.lifecycle = 'loadingFailed'
      this.onUpdate()
    })

    this.session.on('Page.frameRequestedNavigation', event => {
      this.recordNavigation('cdp-frameRequestedNavigation', event.url || '', {
        frameId: String(event.frameId || ''),
        reason: safeEnum(event.reason),
        disposition: safeEnum(event.disposition),
      })
    })

    this.session.on('Page.frameScheduledNavigation', event => {
      this.recordNavigation('cdp-frameScheduledNavigation', event.url || '', {
        frameId: String(event.frameId || ''),
        reason: safeEnum(event.reason),
        delaySeconds: finite(event.delay),
      })
    })

    this.session.on('Page.frameClearedScheduledNavigation', event => {
      this.recordNavigation('cdp-frameClearedScheduledNavigation', '', {
        frameId: String(event.frameId || ''),
      })
    })

    this.session.on('Page.frameNavigated', event => {
      if (event.frame?.parentId) return
      this.recordNavigation('cdp-main-frameNavigated', event.frame?.url || '', {
        frameId: String(event.frame?.id || ''),
        loaderId: String(event.frame?.loaderId || ''),
        frameNamePresent: !!event.frame?.name,
      })
    })

    this.session.on('Page.navigatedWithinDocument', event => {
      this.recordNavigation('cdp-navigatedWithinDocument', event.url || '', {
        frameId: String(event.frameId || ''),
        navigationType: safeEnum(event.navigationType),
      })
    })

    this.session.on('Page.backForwardCacheNotUsed', event => {
      const reasons = (event.notRestoredExplanations || []).slice(0, 20).map(item => safeEnum(item.reason))
      this.recordNavigation('cdp-backForwardCacheNotUsed', '', {
        frameId: String(event.frameId || ''),
        loaderId: String(event.loaderId || ''),
        notRestoredReasons: reasons,
      })
    })
  }

  attachPlaywrightListeners() {
    this.page.on('request', request => {
      const address = this.requestAddress(request.url())
      if (!address) return
      let flags = {}
      try {
        flags = prefetchHeaderFlags(request.headers())
      } catch {}
      const record = {
        id: `pw-${String(++this.playwrightSequence).padStart(5, '0')}`,
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
        wallTime: Date.now() / 1000,
        method: request.method().toUpperCase(),
        path: address.path,
        scope: address.scope,
        resourceType: safeEnum(request.resourceType()),
        isNavigationRequest: request.isNavigationRequest(),
        prefetchHeaders: flags,
        response: null,
        requestFinished: null,
        requestFailed: null,
        correlation: null,
      }
      this.requestObjects.set(request, record)
      this.playwrightRequests.push(record)
      this.onUpdate()
    })

    this.page.on('response', response => {
      const record = this.requestObjects.get(response.request())
      if (!record) return
      record.response = {
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
        status: response.status(),
      }
      this.onUpdate()
    })

    this.page.on('requestfinished', request => {
      const record = this.requestObjects.get(request)
      if (!record) return
      record.requestFinished = {
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
      }
      this.onUpdate()
    })

    this.page.on('requestfailed', request => {
      const record = this.requestObjects.get(request)
      if (!record) return
      record.requestFailed = {
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
        errorText: sanitizedErrorText(request.failure()?.errorText),
      }
      this.onUpdate()
    })

    this.page.on('framenavigated', frame => {
      if (frame !== this.page.mainFrame()) return
      this.recordNavigation('playwright-main-frameNavigated', frame.url())
    })

    this.page.on('pageerror', error => {
      this.pageErrors.push({
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
        name: safeEnum(error?.name, 'Error'),
        message: sanitizedErrorText(error?.message || error),
      })
      this.onUpdate()
    })

    this.page.on('console', message => {
      if (message.type() !== 'error') return
      const location = message.location() || {}
      this.consoleErrors.push({
        phase: this.getPhase(),
        operation: this.getOperation(),
        sequence: this.nextSequence(),
        observedAt: new Date().toISOString(),
        message: sanitizedErrorText(message.text()),
        sourcePath: location.url ? this.sourceAddress(location.url) : null,
        line: Number.isInteger(location.lineNumber) ? location.lineNumber : null,
        column: Number.isInteger(location.columnNumber) ? location.columnNumber : null,
      })
      this.onUpdate()
    })
  }

  snapshot() {
    const correlations = correlateSanitizedRequests(this.playwrightRequests, this.cdpRequests)
    return {
      sequence: this.sequence,
      playwrightRequests: this.playwrightRequests,
      cdpRequests: this.cdpRequests,
      navigationEvents: this.navigationEvents,
      actionEvents: this.actionEvents,
      pageErrors: this.pageErrors,
      consoleErrors: this.consoleErrors,
      requestCorrelations: correlations,
      correlationPolicy: `Only assign a CDP request ID for mutual unique method/path/scope/phase matches within ${CORRELATION_WINDOW_MS}ms; ambiguous and unmatched Playwright objects retain null IDs and candidate IDs only.`,
    }
  }

  async detach() {
    try {
      await this.session?.detach()
    } catch {}
    this.session = null
  }
}

function runOfflineTests() {
  const sdkPaths = new Set(['/firebasejs/10.12.0/firebase-app.js', '/firebasejs/10.12.0/firebase-auth.js'])
  assert.deepEqual(classifyAllowedUrl('https://127.0.0.1:19443/editorial/admin?secret=hidden', 'https://127.0.0.1:19443', 'https://www.gstatic.com', sdkPaths), {
    scope: 'local', path: '/editorial/admin',
  })
  assert.deepEqual(classifyAllowedUrl('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js?x=hidden', 'https://127.0.0.1:19443', 'https://www.gstatic.com', sdkPaths), {
    scope: 'pinned-sdk', path: '/firebasejs/10.12.0/firebase-auth.js',
  })
  assert.equal(classifyAllowedUrl('https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js', 'https://127.0.0.1:19443', 'https://www.gstatic.com', sdkPaths), null)
  assert.equal(classifyAllowedUrl('https://example.test/sensitive?q=hidden', 'https://127.0.0.1:19443', 'https://www.gstatic.com', sdkPaths), null)
  assert.deepEqual(prefetchHeaderFlags({ Purpose: 'prefetch', 'Next-Router-Prefetch': '1', RSC: '1', Cookie: 'private' }), {
    purposePrefetch: true, secPurposePrefetch: false, nextRouterPrefetch: true, rscHeaderPresent: true,
  })
  assert.equal(sanitizedErrorText('net::ERR_ABORTED'), 'net::ERR_ABORTED')
  assert.doesNotMatch(sanitizedErrorText('Failed https://example.test/path?token=secret me@example.test'), /token=secret|me@example\.test/)
  const cdp = { eventId: 'cdp-00001', requestId: 'real-id-1', method: 'GET', path: '/editorial/admin', scope: 'local', phase: 'history-back', wallTime: 10 }
  const pw = { id: 'pw-00001', method: 'GET', path: '/editorial/admin', scope: 'local', phase: 'history-back', wallTime: 10.1 }
  assert.equal(correlateSanitizedRequests([pw], [cdp])[0].cdpRequestId, 'real-id-1')
  const pwA = { id: 'pw-a', method: 'GET', path: '/editorial/admin', scope: 'local', phase: 'history-back', wallTime: 10.1 }
  const pwB = { id: 'pw-b', method: 'GET', path: '/editorial/admin', scope: 'local', phase: 'history-back', wallTime: 10.2 }
  const ambiguous = correlateSanitizedRequests([pwA, pwB], [cdp])
  assert.equal(ambiguous.every(pair => pair.cdpRequestId === null && pair.status === 'ambiguous'), true)
  const inventory = pendingLifecycleAtCapture({
    sequence: 20,
    playwrightRequests: [{ id: 'pw-pending', phase: 'login', operation: 'profile', method: 'GET', path: '/api/users/me', resourceType: 'xhr', response: { status: 200 }, requestFinished: null, requestFailed: null }],
    cdpRequests: [{ eventId: 'cdp-pending', requestId: 'candidate-request-id', phase: 'login', operation: 'profile', method: 'GET', path: '/api/users/me', resourceType: 'XHR', responseStatus: 200, loadingFinished: null, loadingFailed: null, lifecycle: 'responseReceived' }],
    requestCorrelations: [{ playwrightObjectId: 'pw-pending', status: 'ambiguous', cdpRequestId: null, candidateCdpRequestIds: ['candidate-request-id'], candidateCdpEventIds: ['cdp-pending'] }],
  })
  assert.equal(inventory.captureSequence, 20)
  assert.equal(inventory.playwrightPendingCount, 1)
  assert.equal(inventory.playwrightPending[0].requestStatus, 'response-received-awaiting-terminal-event')
  assert.equal(inventory.playwrightPending[0].correlationStatus, 'ambiguous')
  assert.equal(inventory.cdpPendingCount, 1)
  assert.equal(inventory.cdpPending[0].correlationStatus, 'ambiguous')
  process.stdout.write('RUN10_HISTORY_COLLECTOR_FIXTURES PASS (8/8)\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--test')) runOfflineTests()

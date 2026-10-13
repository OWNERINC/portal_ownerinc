import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const UI_PHASE = 'ui-logout'
const DELETE_PATH = '/api/cms/session'
const HUB_PATH = '/cms.html'

export function classifyPostSuccessNavigationAbort(evidence) {
  const reject = reason => ({ accepted: false, reason })
  if (!evidence || typeof evidence !== 'object') return reject('missing-evidence')

  const click = evidence.uiClick
  if (click?.phase !== UI_PHASE || click?.method !== 'native-anchor-click' || click?.path !== '/editorial/admin/logout' ||
      click?.clickCount !== 1 || click?.completed !== true || click?.visible !== true ||
      click?.exactLabel !== true || click?.anchor !== true) return reject('missing-native-ui-click-proof')

  const playwright = Array.isArray(evidence.playwrightDeletes) ? evidence.playwrightDeletes : []
  const cdp = Array.isArray(evidence.cdpDeletes) ? evidence.cdpDeletes : []
  if (playwright.length !== 1 || cdp.length !== 1) return reject('delete-request-count-not-one-to-one')
  const pw = playwright[0]
  const network = cdp[0]
  if (pw.method !== 'DELETE' || pw.path !== DELETE_PATH || pw.phase !== UI_PHASE ||
      network.method !== 'DELETE' || network.path !== DELETE_PATH || network.phase !== UI_PHASE) {
    return reject('delete-method-path-or-phase-mismatch')
  }
  if (!pw.id || !network.requestId || network.hasUserGesture !== true || pw.correlation !== 'unique-method-path-one-to-one' ||
      pw.cdpRequestId !== network.requestId || pw.cdpMatchCount !== 1) return reject('request-object-cdp-id-not-uniquely-correlated')
  const failureRecord = evidence.browserFailureRecord
  if (evidence.failureRecordCount !== 1 || failureRecord?.playwrightRequestObjectId !== pw.id ||
      failureRecord?.failurePhase !== UI_PHASE || failureRecord?.errorText !== 'net::ERR_ABORTED') {
    return reject('matching-browser-failure-record-count-not-one')
  }

  const failure = evidence.playwrightFailure
  const cdpFailure = network.loadingFailed
  if (!pw.requestFailure || !failure || failure.playwrightRequestObjectId !== pw.id || failure.phase !== UI_PHASE ||
      failure.errorText !== 'net::ERR_ABORTED' || !cdpFailure || cdpFailure.phase !== UI_PHASE ||
      cdpFailure.errorText !== 'net::ERR_ABORTED' || cdpFailure.canceled !== true) {
    return reject('same-request-abort-evidence-missing')
  }
  if (pw.responseStatus !== 204 || network.responseStatus !== 204 ||
      pw.responsePhase !== UI_PHASE || network.responsePhase !== UI_PHASE ||
      !Number.isSafeInteger(network.sequence) || !Number.isSafeInteger(network.responseSequence) || !(network.sequence < network.responseSequence) ||
      !Number.isSafeInteger(cdpFailure.sequence) || !Number.isSafeInteger(pw.requestSequence) ||
      !(pw.requestSequence < network.responseSequence && network.responseSequence < cdpFailure.sequence)) {
    return reject('204-header-or-event-order-not-proven')
  }

  const navigations = Array.isArray(evidence.scriptNavigations) ? evidence.scriptNavigations : []
  if (navigations.length !== 1) return reject('script-navigation-count-not-one')
  const navigation = navigations[0]
  if (navigation.phase !== UI_PHASE || navigation.path !== HUB_PATH || navigation.reason !== 'scriptInitiated' ||
      !Number.isSafeInteger(navigation.sequence) ||
      !(network.responseSequence < navigation.sequence && navigation.sequence < cdpFailure.sequence)) {
    return reject('script-navigation-path-reason-or-order-mismatch')
  }

  const logout = evidence.logoutProof
  if (logout?.returnedToHub !== true || logout?.cookieCleared !== true || logout?.http204Count !== 1 ||
      logout?.settled !== true || logout?.nativeErrorVisible !== false || logout?.uiDeleteRequests !== 1 ||
      logout?.path !== HUB_PATH) return reject('logout-revocation-proof-incomplete')
  if (evidence.staleCookieProof?.v2Status !== 401 || evidence.staleCookieProof?.payloadMeStatus !== 401) {
    return reject('stale-cookie-401-proof-incomplete')
  }
  if (evidence.cleanupOnly?.status !== 'NOT_NEEDED' ||
      failure.phase === 'context-close' || cdpFailure.phase === 'context-close' ||
      failure.phase === 'cleanup-only-direct-api-not-ui-proof' || cdpFailure.phase === 'cleanup-only-direct-api-not-ui-proof') {
    return reject('cleanup-or-context-close-event')
  }
  return {
    accepted: true,
    reason: '204-revocation-confirmed-before-script-navigation; same-request-net-err-aborted',
    playwrightRequestObjectId: pw.id,
    cdpRequestId: network.requestId,
    requestSequence: pw.requestSequence,
    responseSequence: network.responseSequence,
    navigationSequence: navigation.sequence,
    loadingFailedSequence: cdpFailure.sequence,
  }
}

function validFixture() {
  return {
    uiClick: {
      phase: UI_PHASE, method: 'native-anchor-click', path: '/editorial/admin/logout',
      clickCount: 1, completed: true, visible: true, exactLabel: true, anchor: true,
    },
    playwrightDeletes: [{
      id: 'pw-22', phase: UI_PHASE, method: 'DELETE', path: DELETE_PATH,
      requestSequence: 134, responseStatus: 204, responsePhase: UI_PHASE,
      cdpRequestId: '37996.207', cdpMatchCount: 1, correlation: 'unique-method-path-one-to-one',
      requestFailure: { phase: UI_PHASE, sequence: 140, errorText: 'net::ERR_ABORTED' },
    }],
    cdpDeletes: [{
      requestId: '37996.207', phase: UI_PHASE, method: 'DELETE', path: DELETE_PATH, hasUserGesture: true,
      sequence: 134, responseStatus: 204, responseSequence: 137, responsePhase: UI_PHASE,
      loadingFailed: { phase: UI_PHASE, sequence: 140, errorText: 'net::ERR_ABORTED', canceled: true },
    }],
    scriptNavigations: [{ phase: UI_PHASE, sequence: 138, path: HUB_PATH, reason: 'scriptInitiated' }],
    playwrightFailure: { phase: UI_PHASE, playwrightRequestObjectId: 'pw-22', errorText: 'net::ERR_ABORTED' },
    failureRecordCount: 1,
    browserFailureRecord: {
      playwrightRequestObjectId: 'pw-22', failurePhase: UI_PHASE, errorText: 'net::ERR_ABORTED',
    },
    logoutProof: {
      returnedToHub: true, path: HUB_PATH, cookieCleared: true, http204Count: 1,
      settled: true, nativeErrorVisible: false, uiDeleteRequests: 1,
    },
    staleCookieProof: { v2Status: 401, payloadMeStatus: 401 },
    cleanupOnly: { status: 'NOT_NEEDED' },
  }
}

function rejectFixture(name, mutate) {
  const fixture = validFixture()
  mutate(fixture)
  assert.equal(classifyPostSuccessNavigationAbort(fixture).accepted, false, `${name} must reject`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assert.equal(classifyPostSuccessNavigationAbort(validFixture()).accepted, true, 'approved sequence must accept')
  rejectFixture('missing-204', fixture => {
    fixture.playwrightDeletes[0].responseStatus = 0
    fixture.cdpDeletes[0].responseStatus = 0
  })
  rejectFixture('different-cdp-id', fixture => { fixture.playwrightDeletes[0].cdpRequestId = 'different-request' })
  rejectFixture('multiple-delete-requests', fixture => {
    fixture.playwrightDeletes.push({ ...fixture.playwrightDeletes[0], id: 'pw-extra', cdpRequestId: 'extra-request' })
  })
  rejectFixture('multiple-matching-failure-events', fixture => { fixture.failureRecordCount = 2 })
  rejectFixture('abort-before-headers', fixture => {
    fixture.cdpDeletes[0].responseStatus = null
    fixture.cdpDeletes[0].responseSequence = null
    fixture.playwrightDeletes[0].responseStatus = null
  })
  rejectFixture('no-ui-click', fixture => { fixture.uiClick = null })
  rejectFixture('wrong-navigation', fixture => { fixture.scriptNavigations[0].path = '/login.html' })
  rejectFixture('missing-stale-v2-401', fixture => { fixture.staleCookieProof.v2Status = 200 })
  rejectFixture('missing-stale-payload-401', fixture => { fixture.staleCookieProof.payloadMeStatus = 200 })
  rejectFixture('context-close-abort', fixture => {
    fixture.cdpDeletes[0].loadingFailed.phase = 'context-close'
    fixture.playwrightFailure.phase = 'context-close'
  })
  rejectFixture('direct-cleanup', fixture => { fixture.cleanupOnly.status = 'DIRECT_API_DELETE_204_CLEANUP_ONLY' })
  rejectFixture('abort-before-navigation', fixture => { fixture.cdpDeletes[0].loadingFailed.sequence = 137 })
  rejectFixture('non-canceled-or-different-error', fixture => { fixture.cdpDeletes[0].loadingFailed.canceled = false })
  process.stdout.write('RUN10_ABORT_CLASSIFIER_FIXTURES PASS (13/13)\n')
}

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

type BrowserCase = { name: string; status: 'PASS' | 'FAIL' | 'NOT_EXECUTED'; detail: string }
type BrowserAssertions = {
  assertEqual(actual: unknown, expected: unknown, detail: string): void
  assertNotEqual(actual: unknown, expected: unknown, detail: string): void
  assertMatch(actual: unknown, pattern: RegExp, detail: string): void
}
type BrowserOrchestration = {
  expectedUploadDestinationPositions: Readonly<Record<'image' | 'gallery' | 'video' | 'pdf', string>>
  uploadPositionAcceptanceName: string
  runEditorialControlAndUploadSuites(input: {
    page: unknown
    structuralPage: unknown
    runControls: (page: unknown, structuralPage: unknown) => Promise<BrowserCase[]>
    runUploads: (page: unknown, positions: Readonly<Record<string, string | null>>) => Promise<BrowserCase[]>
  }): Promise<BrowserCase[]>
}
type TestActorTransport = {
  createLocalActorTransport(config: { runId: string }, serviceSecret: string): import('node:http').Server
}
type AcceptanceRegistry = {
  expectedBrowserAcceptanceCases: readonly string[]
  aggregateAcceptanceCases(expected: readonly string[], actual: Array<Record<string, unknown>>): { status: string }
  notExecutedAcceptanceCases(expected: readonly string[], detail: string): BrowserCase[]
}

test('editorial control assertion paths use their exported boolean-backed helpers', async () => {
  const controls = await import('../integration/portal-page-editorial-controls.mjs') as unknown as BrowserAssertions

  assert.doesNotThrow(() => controls.assertEqual('saved', 'saved', 'equal'))
  assert.throws(() => controls.assertEqual('saved', 'draft', 'version_mismatch'), /version_mismatch/u)
  assert.doesNotThrow(() => controls.assertNotEqual('old', 'new', 'same_version'))
  assert.throws(() => controls.assertNotEqual('same', 'same', 'versions_should_differ'), /versions_should_differ/u)
  assert.doesNotThrow(() => controls.assertMatch('body.0.text', /body\.\d+\.text/u, 'path_missing'))
  assert.throws(() => controls.assertMatch('body.asset', /body\.\d+\.asset/u, 'path_invalid'), /path_invalid/u)
})

test('browser orchestration keeps block edits separate and passes original media positions to uploads', async () => {
  const orchestration = await import('../integration/portal-page-editorial-browser-orchestration.mjs') as unknown as BrowserOrchestration
  const originalPositions = orchestration.expectedUploadDestinationPositions
  const makePage = (paths: string[]) => ({
    paths,
    locator(selector: string) {
      assert.equal(selector, '.portal-page-media-field')
      return { evaluateAll: async (callback: (nodes: Array<{ getAttribute(name: string): string | null }>) => unknown) =>
        callback(paths.map(value => ({ getAttribute: name => name === 'data-portal-page-media-path' ? value : null }))) }
    },
  })
  const editorPage = makePage(Object.values(originalPositions))
  const structuralPage = makePage(['body.0.text', 'body.1.text'])
  let uploadedPositions: Readonly<Record<string, string | null>> | undefined
  const callOrder: string[] = []

  const controlCases: BrowserCase[] = [{ name: 'structural edit ran on its dedicated page', status: 'PASS', detail: 'separate fixture' }]
  const uploadCases: BrowserCase[] = [{ name: 'image destination upload result', status: 'PASS', detail: 'received verified paths' }]
  const results = await orchestration.runEditorialControlAndUploadSuites({
    page: editorPage,
    structuralPage,
    runControls: async (page, structure) => {
      callOrder.push('controls')
      assert.equal(page, editorPage)
      assert.equal(structure, structuralPage)
      assert.notEqual(page, structure)
      structure.paths.reverse()
      return controlCases
    },
    runUploads: async (page, positions) => {
      callOrder.push('uploads')
      assert.equal(page, editorPage)
      uploadedPositions = positions
      return uploadCases
    },
  })

  assert.deepEqual(callOrder, ['controls', 'uploads'])
  assert.deepEqual(uploadedPositions, originalPositions)
  assert.equal(results.find(item => item.name === orchestration.uploadPositionAcceptanceName)?.status, 'PASS')
  assert.ok(results.includes(uploadCases[0]!))
})

test('changed positional media destinations fail the invariant and skip the upload suite', async () => {
  const orchestration = await import('../integration/portal-page-editorial-browser-orchestration.mjs') as unknown as BrowserOrchestration
  const paths = Object.values(orchestration.expectedUploadDestinationPositions)
  let reads = 0
  let uploadCalled = false
  const page = {
    locator: () => ({ evaluateAll: async (callback: (nodes: Array<{ getAttribute(name: string): string | null }>) => unknown) => {
      reads++
      const current = reads === 1 ? paths : ['body.99.asset', ...paths.slice(1)]
      return callback(current.map(value => ({ getAttribute: () => value })))
    } }),
  }
  const controls: BrowserCase[] = [{ name: 'controls completed', status: 'PASS', detail: '' }]
  const results = await orchestration.runEditorialControlAndUploadSuites({
    page,
    structuralPage: {},
    runControls: async () => controls,
    runUploads: async () => { uploadCalled = true; return [] },
  })

  assert.equal(uploadCalled, false)
  assert.equal(results.find(item => item.name === orchestration.uploadPositionAcceptanceName)?.status, 'FAIL')
  assert.ok(results.some(item => item.status === 'NOT_EXECUTED' && item.detail.includes('position')))
})

test('browser acceptance registry requires historical preview and revocation; source executes both after uploads', async () => {
  const registry = await import('../integration/portal-page-editorial-cases.mjs') as unknown as AcceptanceRegistry
  const controls = await readFile(new URL('../integration/portal-page-editorial-controls.mjs', import.meta.url), 'utf8')
  const browser = await readFile(new URL('../integration/portal-page-editorial-browser.mjs', import.meta.url), 'utf8')
  const browserCases = registry.expectedBrowserAcceptanceCases
  const historicalName = 'exact old preview remains fixed after a subsequent save and publication, including its Range asset'
  const revocationName = 'fresh preview asset Range is denied after actual disposable editorial session revocation'
  const positionsName = 'original image/gallery/video/PDF positions reach the upload suite unchanged'

  assert.ok(browserCases.includes(historicalName))
  assert.ok(browserCases.includes(revocationName))
  assert.ok(browserCases.includes(positionsName))
  assert.doesNotMatch(controls, /assert\.(?:equal|notEqual|match)\s*\(/u,
    'browser cases must not call unavailable Node assert methods')
  assert.match(controls, /assert\(page\s*&&\s*structuralPage\s*&&\s*page\s*!==\s*structuralPage/u)
  assert.match(controls, /const structuralURL = structuralPage\.url\(\)/u)
  assert.match(controls, /await reset\(structuralPage, structuralURL\)/u)
  assert.match(controls, /const body = structuralPage\.locator\('\[data-field-path="body"\]'\)/u)
  assert.match(browser, /runEditorialControlAndUploadSuites\(/u)
  assert.match(browser, /historicalPreview = await runExactPreview\(historicalPage, context, handoff\.baseURL\)/u)
  assert.match(browser, /await revokeAndProbeOldAsset\(/u)
  assert.match(browser, /notExecutedAcceptanceCases\(expectedBrowserAcceptanceCases/u)
  assert.ok(browser.indexOf('runEditorialControlAndUploadSuites(') < browser.indexOf('historicalPreview = await runExactPreview('))
  assert.ok(browser.indexOf('existing News controls smoke: preview, scheduling and legacy history render') <
    browser.indexOf('historicalPreview = await runExactPreview('))
  assert.ok(browser.indexOf('historicalPreview = await runExactPreview(') < browser.indexOf('await revokeAndProbeOldAsset('))

  const allPass = browserCases.map(name => ({ name, status: 'PASS', detail: '' }))
  assert.equal(registry.aggregateAcceptanceCases(browserCases, allPass).status, 'PASS')
  const missingHistorical = allPass.filter(item => item.name !== historicalName)
  assert.equal(registry.aggregateAcceptanceCases(browserCases, missingHistorical).status, 'FAIL')
  const unexecutedRevocation = allPass.map(item => item.name === revocationName
    ? { ...item, status: 'NOT_EXECUTED' } : item)
  assert.equal(registry.aggregateAcceptanceCases(browserCases, unexecutedRevocation).status, 'NOT_EXECUTED')
  const unavailable = registry.notExecutedAcceptanceCases(browserCases, 'browser_fixture_unavailable')
  assert.equal(unavailable.find(item => item.name === historicalName)?.status, 'NOT_EXECUTED')
  assert.equal(unavailable.find(item => item.name === revocationName)?.status, 'NOT_EXECUTED')
  assert.equal(registry.aggregateAcceptanceCases(browserCases, unavailable).status, 'NOT_EXECUTED')
})

test('disposable V2 bridge revokes an exact cookie through HTTP and rejects fresh resolutions', async () => {
  const fixture = await import('../integration/portal-page-editorial-test-actor.mjs') as unknown as TestActorTransport
  const runId = 'f1fdcf87-48ef-4b79-8146-ff8bbd9ef212'
  const serviceSecret = 'task4-fixture-only-secret'
  const server = fixture.createLocalActorTransport({ runId }, serviceSecret)
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const baseURL = `http://127.0.0.1:${address.port}`
  const post = (route: string, cookie: string, secret = serviceSecret) => fetch(`${baseURL}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  })

  try {
    const before = await post('/api/internal/editorial/admin/session/resolve', runId)
    assert.equal(before.status, 200)
    assert.equal((await before.json() as { actor?: { capabilities?: { manageKnowledge?: boolean } } }).actor?.capabilities?.manageKnowledge, true)
    const wrongSecret = await post('/api/internal/editorial/session/revoke', runId, 'wrong-secret')
    assert.equal(wrongSecret.status, 401)
    const otherCookie = `${runId}-other-fixture-cookie`
    const otherBefore = await post('/api/internal/editorial/admin/session/resolve', otherCookie)
    assert.equal(otherBefore.status, 200)
    const revoked = await post('/api/internal/editorial/session/revoke', runId)
    assert.equal(revoked.status, 204)
    const after = await post('/api/internal/editorial/admin/session/resolve', runId)
    assert.equal(after.status, 401)
    assert.equal((await after.json() as { reason?: string }).reason, 'editorial_session_invalid')
    const otherAfter = await post('/api/internal/editorial/admin/session/resolve', otherCookie)
    assert.equal(otherAfter.status, 200)
  } finally {
    const closed = once(server, 'close')
    server.close()
    await closed
  }
})

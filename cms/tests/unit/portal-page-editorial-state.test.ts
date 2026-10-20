import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { acceptsEditableRequest, changePublication, confirmedVersion, createRequestGeneration, editorialBlocked,
  fetchRevision, saveVersion } from '../../src/admin/portal-pages/editorial-state'
import type { EditorGate } from '../../src/admin/portal-pages/editorial-state'
import type { NativeEditable, PublicationResult, RevisionResult, SaveResult } from '../../src/portal-pages/editorial-contracts'

const pageID = '11111111-1111-4111-8111-111111111111'
const versionID = '22222222-2222-4222-8222-222222222222'
const olderVersionID = '33333333-3333-4333-8333-333333333333'
const hash = 'a'.repeat(64)
const savedAt = '2026-10-19T10:00:00.000Z'

const revision: RevisionResult = {
  id: pageID,
  document_status: 'draft',
  latest: { version_id: versionID, autosave: false, saved_at: savedAt,
    snapshot_hash: hash, editable_hash: hash },
  explicit: { version_id: versionID, saved_at: savedAt, is_latest: true },
}

const nativePage: NativeEditable = {
  title: 'Guia', slug: 'guia', summary: '', cover: null, coverAlt: null, categories: [], body: [],
}

const saveReceipt: SaveResult = {
  id: pageID, version_id: versionID, saved_at: savedAt, editable_hash: hash, document_status: 'draft',
}

const publicationReceipt: PublicationResult = {
  id: pageID, operation: 'publish', source_version_id: versionID,
  resulting_version_id: olderVersionID, document_status: 'published', published_at: savedAt,
}

afterEach(() => mock.restoreAll())

function mockFetch(responseOrFetch: Response | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return typeof responseOrFetch === 'function' ? responseOrFetch(input, init) : responseOrFetch
  })
  return calls
}

test('editorialBlocked is the OR of every independent Payload gate', () => {
  const keys: Array<keyof EditorGate> = ['modified', 'processing', 'backgroundProcessing', 'initializing',
    'disabled', 'locked', 'uploading', 'otherModalOpen', 'busy']
  const clear = Object.fromEntries(keys.map(key => [key, false])) as EditorGate
  assert.equal(editorialBlocked(clear), false)
  for (const key of keys) assert.equal(editorialBlocked({ ...clear, [key]: true }), true, `${key} blocks`)
})

test('late response cannot activate a preview after invalidation', () => {
  const generation = createRequestGeneration()
  const ticket = generation.begin(pageID)
  generation.invalidate()
  assert.equal(ticket.signal.aborted, true)
  assert.equal(generation.accepts(ticket, pageID), false)
})

test('a deferred revision response resolving after invalidation stays unauthorized', async () => {
  let resolveResponse: ((response: Response) => void) | undefined
  const calls = mockFetch(() => new Promise<Response>(resolve => { resolveResponse = resolve }))
  const generation = createRequestGeneration()
  const ticket = generation.begin(pageID)
  const pending = fetchRevision(pageID, ticket.signal)
  generation.invalidate()
  resolveResponse!(Response.json(revision))
  const received = await pending
  assert.equal(calls.length, 1)
  assert.equal(generation.accepts(ticket, pageID), false)
  assert.equal(generation.accepts(ticket, olderVersionID), false)
  assert.equal(confirmedVersion(received, hash) !== null && generation.accepts(ticket, pageID), false)
})

test('field revision changes reject deferred hash, GET, and POST continuations', async () => {
  for (const phase of ['hashing', 'GET', 'POST'] as const) {
    let resolvePhase: (() => void) | undefined
    const deferredPhase = new Promise<void>(resolve => { resolvePhase = resolve })
    const generation = createRequestGeneration()
    const ticket = generation.begin(pageID)
    const capturedFieldRevision = 'title:original'
    let acceptedPost = 0
    let acceptedReceipt = 0
    const pending = (async () => {
      await deferredPhase
      const isCurrent = acceptsEditableRequest(generation, ticket, pageID, capturedFieldRevision, 'title:changed')
      if (!isCurrent) return
      if (phase === 'POST') acceptedReceipt += 1
      else acceptedPost += 1
    })()
    resolvePhase!()
    await pending
    assert.equal(acceptedPost, 0, `${phase} must not authorize a stale POST`)
    assert.equal(acceptedReceipt, 0, `${phase} must not adopt a stale POST receipt`)
  }
})

test('begin invalidates older document requests and accepts only the active document ticket', () => {
  const generation = createRequestGeneration()
  const first = generation.begin(pageID)
  const second = generation.begin(olderVersionID)
  assert.equal(first.signal.aborted, true)
  assert.equal(generation.accepts(first, pageID), false)
  assert.equal(generation.accepts(second, pageID), false)
  assert.equal(generation.accepts(second, olderVersionID), true)
})

test('confirmedVersion authorizes only the latest explicit version with an exact editable hash', () => {
  assert.deepEqual(confirmedVersion(revision, hash), { id: pageID, versionID, savedAt })
  assert.equal(confirmedVersion({ ...revision, latest: null }, hash), null)
  assert.equal(confirmedVersion({ ...revision, latest: { ...revision.latest!, autosave: true } }, hash), null)
  assert.equal(confirmedVersion({ ...revision, explicit: null }, hash), null)
  assert.equal(confirmedVersion({ ...revision, explicit: { ...revision.explicit!, is_latest: false } }, hash), null)
  assert.equal(confirmedVersion({ ...revision, explicit: { ...revision.explicit!, version_id: olderVersionID } }, hash), null)
  assert.equal(confirmedVersion({ ...revision, latest: { ...revision.latest!, editable_hash: 'b'.repeat(64) } }, hash), null)
})

test('revision GET uses its fixed same-origin endpoint and validates the response', async () => {
  const calls = mockFetch(Response.json(revision))
  const signal = new AbortController().signal
  assert.deepEqual(await fetchRevision(pageID, signal), revision)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.input, `/editorial/api/portal-page-editorial/revision?id=${pageID}`)
  assert.equal(calls[0]!.init?.method, undefined)
  assert.equal(calls[0]!.init?.credentials, 'same-origin')
  assert.equal(calls[0]!.init?.cache, 'no-store')
  assert.equal(calls[0]!.init?.headers, undefined)
  assert.equal(calls[0]!.init?.signal, signal)
})

test('revision GET rejects malformed UUIDs, status, hashes, dates, and unexpected response fields', async () => {
  for (const body of [
    { ...revision, id: 'not-a-uuid' },
    { ...revision, document_status: 'archived' },
    { ...revision, latest: { ...revision.latest!, snapshot_hash: 'x'.repeat(64) } },
    { ...revision, latest: { ...revision.latest!, saved_at: 'not-a-date' } },
    { ...revision, server_secret: 'unexpected' },
  ]) {
    mock.restoreAll()
    mockFetch(Response.json(body))
    await assert.rejects(fetchRevision(pageID, new AbortController().signal), /revisão|resposta|inválid/iu)
  }
})

test('existing save sends only the CAS tuple; creation sends only id and seven editable fields', async () => {
  const calls = mockFetch(Response.json(saveReceipt, { status: 201 }))
  const signal = new AbortController().signal
  await saveVersion({ id: pageID, expected_latest_version_id: versionID, expected_snapshot_hash: hash }, signal)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.input, '/editorial/api/portal-page-editorial/save')
  assert.equal(calls[0]!.init?.method, 'POST')
  assert.equal(calls[0]!.init?.credentials, 'same-origin')
  assert.deepEqual(calls[0]!.init?.headers, { 'Content-Type': 'application/json' })
  assert.equal(calls[0]!.init?.signal, signal)
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    id: pageID, expected_latest_version_id: versionID, expected_snapshot_hash: hash,
  })

  mock.restoreAll()
  const createCalls = mockFetch(Response.json(saveReceipt, { status: 201 }))
  await saveVersion({ id: null, data: nativePage }, new AbortController().signal)
  const body = JSON.parse(String(createCalls[0]!.init?.body))
  assert.deepEqual(Object.keys(body).sort(), ['data', 'id'])
  assert.deepEqual(Object.keys(body.data).sort(), ['body', 'categories', 'cover', 'coverAlt', 'slug', 'summary', 'title'])
})

test('publication sends only the explicit confirmation request and validates the receipt', async () => {
  const calls = mockFetch(Response.json(publicationReceipt))
  const signal = new AbortController().signal
  assert.deepEqual(await changePublication({ id: pageID, expected_version_id: versionID, operation: 'publish' },
    signal), publicationReceipt)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.input, '/editorial/api/portal-page-editorial/publication')
  assert.equal(calls[0]!.init?.method, 'POST')
  assert.equal(calls[0]!.init?.credentials, 'same-origin')
  assert.deepEqual(calls[0]!.init?.headers, { 'Content-Type': 'application/json' })
  assert.equal(calls[0]!.init?.signal, signal)
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    id: pageID, expected_version_id: versionID, operation: 'publish',
  })
})

test('malformed mutation receipts are rejected and are never retried', async () => {
  const calls = mockFetch(Response.json({ ...saveReceipt, version_id: 'not-a-uuid' }, { status: 201 }))
  await assert.rejects(saveVersion({ id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: hash }, new AbortController().signal), /Não foi possível confirmar a operação/u)
  assert.equal(calls.length, 1)

  mock.restoreAll()
  const publicationCalls = mockFetch(Response.json({ ...publicationReceipt, operation: 'unpublish' }))
  await assert.rejects(changePublication({ id: pageID, expected_version_id: versionID, operation: 'publish' },
    new AbortController().signal), /Não foi possível confirmar a operação/u)
  assert.equal(publicationCalls.length, 1)
})

test('409 preserves local save fields through a stable CAS conflict error and is not retried', async () => {
  const calls = mockFetch(Response.json({ error: 'portal_page_version_conflict', message: 'conflict' }, { status: 409 }))
  const before = structuredClone(nativePage)
  await assert.rejects(saveVersion({ id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: hash }, new AbortController().signal), /A página mudou desde a conferência\. Seus campos foram preservados\./u)
  assert.deepEqual(nativePage, before)
  assert.equal(calls.length, 1)
})

test('network loss and 503 are ambiguous, carry no retry, and session expiry has a stable message', async () => {
  const unavailableCalls = mockFetch(Response.json({ error: 'portal_page_editorial_unavailable', message: 'unavailable' }, { status: 503 }))
  await assert.rejects(saveVersion({ id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: hash }, new AbortController().signal), /Não foi possível confirmar a operação\. Consulte o estado antes de tentar novamente\./u)
  assert.equal(unavailableCalls.length, 1)

  mock.restoreAll()
  const lostCalls = mockFetch(async () => { throw new TypeError('connection lost') })
  await assert.rejects(changePublication({ id: pageID, expected_version_id: versionID, operation: 'publish' },
    new AbortController().signal), /Não foi possível confirmar a operação\. Consulte o estado antes de tentar novamente\./u)
  assert.equal(lostCalls.length, 1)

  mock.restoreAll()
  const expiredCalls = mockFetch(Response.json({ error: 'editorial_session_invalid', message: 'expired' }, { status: 401 }))
  await assert.rejects(fetchRevision(pageID, new AbortController().signal), /A sessão editorial expirou\. Entre novamente\./u)
  assert.equal(expiredCalls.length, 1)
})

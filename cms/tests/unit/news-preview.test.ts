import assert from 'node:assert/strict'
import test from 'node:test'
import { savedPreview, previewConflictMessage } from '../../src/admin/preview-state.js'
import { createNewsScheduleEndpoints } from '../../src/endpoints/news-schedule.js'
import { createNewsAreaAccess } from '../../src/auth/news-area-access.js'
import type { PayloadRequest } from 'payload'

const documentId = '11111111-1111-4111-8111-111111111111', versionId = '22222222-2222-4222-8222-222222222222'
test('native preview looks up a persisted version, not document ID, date or draft write', async () => {
  const signal = new AbortController().signal
  const result = await savedPreview(documentId, signal, (async (path, options) => {
    assert.equal(path, `/editorial/api/news-schedule?target=article&documentId=${documentId}`)
    assert.equal(options?.method, undefined); assert.equal(options?.credentials, 'same-origin'); assert.equal(options?.signal, signal)
    return Response.json({ versionId, savedAt: '2026-10-01T12:00:00.000Z' })
  }) as typeof fetch)
  assert.equal(result.href, `/news-preview.html?id=${documentId}&version=${versionId}&source=payload`)
  assert.doesNotMatch(result.href, /token|cookie|secret/)
  await assert.rejects(savedPreview(documentId, signal, (async () => new Response(null, { status: 409 })) as typeof fetch), { message: previewConflictMessage })
  for (const revision of [{}, { versionId: 'today', savedAt: '2026-10-01' }, { versionId, savedAt: 'invalid' }]) {
    await assert.rejects(savedPreview(documentId, signal, (async () => Response.json(revision)) as typeof fetch), /Revisão salva inválida/)
  }
})
test('native preview rejects body decoded after disposal', async () => {
  const controller = new AbortController()
  await assert.rejects(savedPreview(documentId, controller.signal, (async () => ({ ok: true, async json() {
    controller.abort(); return { versionId, savedAt: '2026-10-01' }
  } })) as unknown as typeof fetch), { name: 'AbortError' })
})
test('saved revision endpoint reads actual latest Versions without mutating, and missing revision is 409', async () => {
  let hasVersion = true
  const access = createNewsAreaAccess(() => ({ getAuthority: async () => ({ mode: 'payload_frozen', epoch: 1 }) }))
  const req = { transactionID: 'live', user: { collection: 'portal-editors', portalUid: 'editor', portalActor: { uid: 'editor', canManageNews: true } },
    searchParams: new URLSearchParams({ target: 'article', documentId }) } as unknown as PayloadRequest
  req.payload = {
    db: { sessions: { live: { db: { async execute() {} } } }, async findOne() { return { id: documentId, publicationGeneration: 1 } } },
    async findVersions(options: any) {
      assert.deepEqual(options.where, { and: [{ parent: { equals: documentId } }, { latest: { equals: true } }] })
      assert.equal(options.req, req)
      return { docs: hasVersion ? [{ id: versionId, version: { title: 'Saved', category: '', editorial: null, body: [] }, updatedAt: '2026-10-01T12:00:00.000Z' }] : [] }
    },
    async find() { return { docs: [] } },
  } as unknown as PayloadRequest['payload']
  const endpoint = createNewsScheduleEndpoints(access.canRead).find(e => e.method === 'get')!
  const response = await endpoint.handler(req)
  assert.equal(response.status, 200); assert.equal((await response.json()).versionId, versionId)
  hasVersion = false
  assert.equal((await endpoint.handler(req)).status, 409)
})

test('native schedule GET denies legacy/frozen before opening a CMS transaction', async () => {
  for (const mode of ['legacy', 'frozen']) {
    let calls = 0
    const access = createNewsAreaAccess(() => ({ getAuthority: async () => ({ mode, epoch: 2 }) }))
    const req = { transactionID: 'live', user: { collection: 'portal-editors', portalUid: 'editor',
      portalActor: { uid: 'editor', canManageNews: true } }, searchParams: new URLSearchParams({ target: 'article', documentId }) } as unknown as PayloadRequest
    const payload = { db: { sessions: { live: { db: { execute: async () => { calls++ } } } } } } as unknown as PayloadRequest['payload']
    req.payload = payload
    const endpoint = createNewsScheduleEndpoints(access.canRead).find(e => e.method === 'get')!
    const response = await endpoint.handler(req)
    assert.equal(response.status, 403, mode)
    assert.equal(calls, 0, `${mode} must be denied before lock or native reads`)
  }
})

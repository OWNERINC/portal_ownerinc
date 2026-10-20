import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editableHash } from '../../src/portal-pages/editorial-native'
import type { NativeEditable } from '../../src/portal-pages/editorial-contracts'
import { readEditorialRevision, saveEditorialVersion, transitionEditorialPublication } from '../../src/portal-pages/editorial-service'
import { pageID, versionID, nativePage, editorialFixture } from '../fixtures/portal-page-editorial'

const savedAt = '2026-10-19T10:00:00.000Z'
const categoryID = '77777777-7777-4777-8777-777777777777'
function version(overrides: Record<string, unknown> = {}) {
  return { id: versionID, parent: pageID, latest: true, autosave: true, updatedAt: savedAt,
    createdAt: savedAt, createdBy: 'creator', updatedBy: 'editor-uid', version: { ...nativePage, _status: 'draft' }, ...overrides }
}

function queryText(value: unknown): string {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { queryChunks?: unknown }).queryChunks)) return ''
  return ((value as { queryChunks: unknown[] }).queryChunks).map(chunk => {
    if (typeof chunk === 'string') return chunk
    if (!chunk || typeof chunk !== 'object') return ''
    const part = (chunk as { value?: unknown }).value
    return Array.isArray(part) ? part.join('') : ''
  }).join('')
}

test('revision reads are write-free and report principal status apart from the latest draft status', async () => {
  const f = editorialFixture()
  f.seedLatest(version())
  const result = await readEditorialRevision(f.req, pageID)
  assert.equal(result.document_status, 'published')
  assert.equal(result.latest?.autosave, true)
  assert.equal(result.latest?.version_id, versionID)
  assert.equal(result.explicit, null)
  assert.equal(f.calls.some(call => ['create', 'update', 'delete'].includes(call.operation)), false)
  const sqlStatements = f.calls.filter(call => call.operation === 'sql').map(call => queryText(call.args))
  assert.match(sqlStatements[0], /SET LOCAL lock_timeout/u)
  assert.match(sqlStatements[1], /pg_advisory_xact_lock/u)
  assert.match(sqlStatements[2], /portal_pages.+FOR UPDATE/u)
})

test('same UUID mutated autosave cannot be promoted using a stale snapshot hash', async () => {
  const f = editorialFixture()
  f.seedLatest(version())
  const before = await readEditorialRevision(f.req, pageID)
  f.seedLatest(version({ updatedAt: '2026-10-19T10:00:01.000Z', version: { ...nativePage, title: 'Remoto' } }))
  await assert.rejects(saveEditorialVersion(f.req, { id: pageID,
    expected_latest_version_id: versionID, expected_snapshot_hash: before.latest!.snapshot_hash }), { status: 409 })
  assert.equal(f.calls.some(call => call.operation === 'update'), false)
})

test('duplicate latest versions fail closed and explicit older version is informational only', async () => {
  const f = editorialFixture()
  f.seedLatest(version({ updatedAt: '2026-10-19T10:00:02.000Z' }))
  f.seedVersion({ ...version({ id: '33333333-3333-4333-8333-333333333333', updatedAt: '2026-10-19T10:00:03.000Z' }) })
  await assert.rejects(readEditorialRevision(f.req, pageID), { status: 503 })

  const g = editorialFixture()
  g.seedVersion({ ...version({ id: '44444444-4444-4444-8444-444444444444', latest: false, autosave: false,
    updatedAt: '2026-10-19T09:00:00.000Z' }) })
  g.seedLatest(version({ id: '55555555-5555-4555-8555-555555555555', autosave: true,
    updatedAt: '2026-10-19T10:00:00.000Z' }))
  const revision = await readEditorialRevision(g.req, pageID)
  assert.equal(revision.explicit?.is_latest, false)
  assert.equal(revision.explicit?.version_id, '44444444-4444-4444-8444-444444444444')
  await assert.rejects(saveEditorialVersion(g.req, { id: pageID,
    expected_latest_version_id: revision.explicit!.version_id, expected_snapshot_hash: revision.latest!.snapshot_hash }), { status: 409 })
})

test('latest selection is deterministic by updatedAt DESC then id DESC', async () => {
  const f = editorialFixture()
  const olderID = '33333333-3333-4333-8333-333333333333'
  const newerID = '44444444-4444-4444-8444-444444444444'
  f.seedVersion({ ...version({ id: olderID, latest: false, autosave: false, updatedAt: savedAt }) })
  f.seedVersion({ ...version({ id: newerID, latest: false, autosave: false, updatedAt: savedAt }) })
  f.seedLatest(version({ id: '55555555-5555-4555-8555-555555555555', updatedAt: '2026-10-19T10:00:01.000Z' }))
  const result = await readEditorialRevision(f.req, pageID)
  assert.equal(result.explicit?.version_id, newerID)
})

test('explicit save writes the seven native fields and creates a new non-autosave Version', async () => {
  const f = editorialFixture()
  f.seedLatest(version())
  const before = await readEditorialRevision(f.req, pageID)
  const result = await saveEditorialVersion(f.req, { id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: before.latest!.snapshot_hash })
  assert.equal(result.id, pageID)
  assert.notEqual(result.version_id, versionID)
  assert.equal(result.document_status, 'published')
  assert.equal(result.editable_hash, await editableHash(nativePage))
  const write = f.calls.find(call => call.operation === 'update')!.args as Record<string, unknown>
  assert.deepEqual(Object.keys(write.data as object).sort(), ['_status', 'body', 'categories', 'cover', 'coverAlt', 'slug', 'summary', 'title'])
  assert.equal(write.draft, true)
  assert.equal(write.autosave, false)
  assert.equal(write.overrideAccess, false)
  assert.equal(write.depth, 0)
  assert.notEqual(write.id, result.version_id, 'update returns/uses the page document ID, not a Version ID')
  const writerTx = f.calls.find(call => call.operation === 'update')!.transactionID
  const matching = f.calls.filter(call => call.transactionID === writerTx && ['findVersions', 'update'].includes(call.operation))
  const txIDs = matching.map(call => call.transactionID)
  assert.equal(new Set(txIDs).size, 1)
  assert.equal(txIDs[0], writerTx)
})

test('same-content save still creates a fresh Version and resolved lost commit is unavailable', async () => {
  const f = editorialFixture()
  f.seedLatest(version({ autosave: false }))
  const before = await readEditorialRevision(f.req, pageID)
  const result = await saveEditorialVersion(f.req, { id: pageID, expected_latest_version_id: versionID,
    expected_snapshot_hash: before.latest!.snapshot_hash })
  assert.notEqual(result.version_id, versionID)
  assert.equal(result.editable_hash, await editableHash(nativePage))

  const lost = editorialFixture()
  lost.loseCommit()
  await assert.rejects(saveEditorialVersion(lost.req, { id: null, data: nativePage }), { status: 503 })
})

test('create saves a draft, resolves the actual Version ID, and confirms it after commit', async () => {
  const f = editorialFixture()
  const result = await saveEditorialVersion(f.req, { id: null, data: nativePage })
  assert.notEqual(result.id, result.version_id)
  assert.equal(result.document_status, 'draft')
  assert.equal(result.editable_hash, await editableHash(nativePage))
  const writerTx = f.calls.find(call => call.operation === 'create')!.transactionID
  const confirmation = f.calls.find(call => call.operation === 'findVersionByID')
  assert.ok(confirmation?.transactionID !== undefined)
  assert.notEqual(confirmation?.transactionID, writerTx, 'fresh transaction confirms receipt')
})

test('first save accepts generated block/gallery ObjectIds and returns the exact persisted editable hash', async () => {
  const input = { ...nativePage, body: [
    { blockType: 'heading', blockName: 'Introdução', text: 'Bem-vindo', level: '2' },
    { blockType: 'gallery', images: [
      { asset: '77777777-7777-4777-8777-777777777777', alt: 'Primeira' },
      { asset: '88888888-8888-4888-8888-888888888888', alt: 'Segunda', caption: 'Legenda' },
    ] },
  ] } satisfies NativeEditable
  const f = editorialFixture()
  const result = await saveEditorialVersion(f.req, { id: null, data: input })
  const persisted = f.committedVersion(result.version_id)!
  const content = persisted.version as Record<string, unknown>
  const body = content.body as Array<Record<string, unknown>>
  const gallery = body[1].images as Array<Record<string, unknown>>
  assert.match(body[0].id as string, /^[0-9a-f]{24}$/u)
  assert.match(gallery[0].id as string, /^[0-9a-f]{24}$/u)
  assert.match(gallery[1].id as string, /^[0-9a-f]{24}$/u)
  assert.equal(persisted.autosave, false)
  assert.equal(result.editable_hash, await editableHash(content))
  assert.notEqual(result.editable_hash, await editableHash(input), 'response hash includes the exact persisted row IDs')

  const writerTx = f.calls.find(call => call.operation === 'create')!.transactionID
  const confirmation = f.calls.find(call => call.operation === 'findVersionByID' &&
    (call.args as Record<string, unknown>).id === result.version_id)
  assert.ok(confirmation)
  assert.notEqual(confirmation.transactionID, writerTx, 'the exact persisted receipt is confirmed after commit')
})

test('first save rejects Payload-altered blockName even when Payload generated the row ID', async () => {
  const input = ({ ...nativePage,
    body: [{ blockType: 'heading', blockName: 'Original', text: 'Conteúdo', level: '2' }] } satisfies NativeEditable)
  const f = editorialFixture()
  f.alterCreatedBlockName()
  await assert.rejects(saveEditorialVersion(f.req, { id: null, data: input }), { status: 503 })
  assert.equal(f.calls.some(call => call.operation === 'commit'), false)
  assert.equal(f.calls.some(call => call.operation === 'rollback'), true)
  assert.equal(f.calls.some(call => call.operation === 'findVersionByID'), false,
    'writer-session content equivalence rejects before constructing a receipt')
})

test('publication copies the confirmed native source, including empty/null values, then returns a distinct Version receipt', async () => {
  const f = editorialFixture()
  const source = { ...nativePage, summary: '', cover: null, coverAlt: null, categories: [categoryID], body: [] }
  f.seedLatest(version({ autosave: false, version: { ...source, _status: 'draft' } }))
  const result = await transitionEditorialPublication(f.req, { id: pageID, expected_version_id: versionID, operation: 'publish' })
  assert.deepEqual(Object.keys(result).sort(), ['document_status', 'id', 'operation', 'published_at',
    'resulting_version_id', 'source_version_id'].sort())
  assert.equal(result.id, pageID)
  assert.equal(result.operation, 'publish')
  assert.equal(result.source_version_id, versionID)
  assert.equal(result.document_status, 'published')
  assert.notEqual(result.resulting_version_id, versionID)
  assert.ok(result.published_at)
  const update = f.calls.find(call => call.operation === 'update')!.args as Record<string, unknown>
  assert.deepEqual(update.data, { ...source, _status: 'published' })
  assert.equal(update.draft, false)
  assert.equal(update.autosave, false)
  assert.equal('unpublishAllLocales' in update, false)
  const writerTx = f.calls.find(call => call.operation === 'update')!.transactionID
  const inWriter = f.calls.filter(call => call.transactionID === writerTx)
  assert.ok(inWriter.some(call => call.operation === 'findByID' &&
    (call.args as Record<string, unknown>).collection === 'portal-page-categories'), 'reference validation shares the mutation session')
  assert.ok(inWriter.some(call => call.operation === 'findVersions'), 'resulting Version read shares the mutation session')
  assert.ok(inWriter.some(call => call.operation === 'update'), 'native update shares the mutation session')
})

test('unpublish uses the chosen explicit source, never rewrites source, and rejects an already-draft principal', async () => {
  const f = editorialFixture()
  f.seedLatest(version({ autosave: false }))
  const result = await transitionEditorialPublication(f.req, { id: pageID, expected_version_id: versionID, operation: 'unpublish' })
  assert.equal(result.source_version_id, versionID)
  assert.notEqual(result.resulting_version_id, versionID)
  assert.equal(result.document_status, 'draft')
  assert.equal(result.published_at, null)
  const update = f.calls.find(call => call.operation === 'update')!.args as Record<string, unknown>
  assert.equal((update.data as Record<string, unknown>)._status, 'draft')
  assert.equal(update.draft, false)
  assert.equal(update.autosave, false)
  assert.equal('unpublishAllLocales' in update, false)

  const draft = editorialFixture()
  draft.seedLatest(version({ autosave: false }))
  draft.seedPage({ id: pageID, _status: 'draft', title: 'Guia', slug: 'guia', summary: '', cover: null,
    coverAlt: null, categories: [], body: [], publishedAt: null, createdBy: 'creator', updatedBy: 'editor-uid' })
  await assert.rejects(transitionEditorialPublication(draft.req, { id: pageID, expected_version_id: versionID,
    operation: 'unpublish' }), /portal_page_not_published/)
})

test('publication CAS rejects wrong parents and a newer autosave; republish creates a new date/version', async () => {
  const wrong = editorialFixture()
  wrong.seedLatest(version({ parent: '33333333-3333-4333-8333-333333333333' }))
  await assert.rejects(transitionEditorialPublication(wrong.req, { id: pageID, expected_version_id: versionID, operation: 'publish' }), { status: 404 })

  const stale = editorialFixture()
  stale.seedVersion(version({ id: versionID, latest: false, autosave: false }))
  stale.seedLatest(version({ id: '33333333-3333-4333-8333-333333333333', autosave: true,
    updatedAt: '2026-10-19T10:01:00.000Z' }))
  await assert.rejects(transitionEditorialPublication(stale.req, { id: pageID, expected_version_id: versionID, operation: 'publish' }), { status: 409 })

  const republish = editorialFixture()
  republish.seedLatest(version({ autosave: false, version: { ...nativePage, _status: 'published' } }))
  const republished = await transitionEditorialPublication(republish.req, { id: pageID, expected_version_id: versionID, operation: 'publish' })
  assert.notEqual(republished.resulting_version_id, versionID)
  assert.equal(republished.document_status, 'published')
  assert.ok(republished.published_at)
})

test('a later legitimate Version does not invalidate a persisted mutation receipt', async () => {
  const f = editorialFixture()
  f.addVersionAfterCommit()
  const result = await saveEditorialVersion(f.req, { id: null, data: nativePage })
  assert.ok(result.version_id)
  assert.ok(f.calls.some(call => call.operation === 'findVersionByID'), 'receipt lookup uses exact Version in a fresh session')
})

test('fresh receipt confirmation rejects every mismatched persisted Version field', async () => {
  for (const field of ['parent', 'autosave', 'updatedAt', 'createdBy', 'updatedBy', 'status', 'publishedAt', 'content'] as const) {
    const f = editorialFixture()
    f.corruptReceipt(field)
    await assert.rejects(saveEditorialVersion(f.req, { id: null, data: nativePage }), { status: 503 }, field)
    const confirmation = f.calls.find(call => call.operation === 'findVersionByID')
    assert.ok(confirmation, `${field} mismatch is detected in a fresh session`)
  }
})

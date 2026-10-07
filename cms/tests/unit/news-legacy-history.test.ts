import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LegacyHistoryList, readHistoryPage, type LegacyHistoryRow } from '../../src/admin/LegacyHistoryList'
import { validateHistoryMetadataBasis, historyHashes } from '../../src/collections/LegacyNewsRevisions'
import { legacyToPayloadBlocks } from '../../src/news/legacy-blocks'
import { normalizeNewsDocument } from '../../src/news/validation'
import { convertLegacyRevision } from '../../../scripts/owner-news-payload/legacy-converter.mjs'
import { everyLegacyBlock, ids, mediaFixture, sourceFixture } from '../../../tests/fixtures/owner-news-payload.mjs'
import type { LegacyNewsRevisionInput } from '../../src/contracts/news'

const row: LegacyHistoryRow = { legacyDocumentId: '11111111-1111-4111-8111-111111111111', legacyRevisionId: '22222222-2222-4222-8222-222222222222',
  originalVersion: 7, originalCreatedAt: '2026-09-01T12:00:00.123456Z', originalActorUid: null, originalStatus: 'archived', originalTitle: '<script>synthetic</script>',
  originalCategory: '', originalPublishedAt: null, metadataBasis: { title: 'document_snapshot', category: 'document_snapshot', publishedAt: 'unknown' } }
test('history view labels snapshot/unknown honestly and links exact protected legacy identity', () => {
  const html = renderToStaticMarkup(React.createElement(LegacyHistoryList, { rows: [row] }))
  assert.ok(html.includes('fotografia do documento'))
  assert.ok(html.includes('Desconhecida para esta revisão'))
  assert.ok(html.includes('Não registrada'))
  assert.ok(html.includes('2026-09-01T12:00:00.123456Z'))
  assert.ok(html.includes(`id=${row.legacyDocumentId}&amp;version=${row.legacyRevisionId}&amp;source=legacy`))
  assert.ok(html.includes('rel="noopener noreferrer"'))
  assert.ok(html.includes('&lt;script&gt;synthetic&lt;/script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('Restaurar'))
})
test('old rows without metadata basis stay unspecified; empty history is explicit', () => {
  assert.ok(renderToStaticMarkup(React.createElement(LegacyHistoryList, { rows: [{ ...row, metadataBasis: undefined }] })).includes('Base histórica de título e categoria não informada'))
  assert.ok(renderToStaticMarkup(React.createElement(LegacyHistoryList, { rows: [] })).includes('Nenhuma revisão anterior'))
})
test('history response rejects foreign document, duplicate revisions and unknown status; strips bodies', () => {
  const parsed = readHistoryPage({ docs: [{ ...row, originalBody: ['private sentinel'] }], hasNextPage: false }, row.legacyDocumentId)
  assert.ok(!JSON.stringify(parsed).includes('sentinel'))
  for (const docs of [[{ ...row, legacyDocumentId: row.legacyRevisionId }], [row, row], [{ ...row, originalStatus: 'unknown' }],
    [{ ...row, legacyRevisionId: [row.legacyRevisionId] }], [{ ...row, originalStatus: ['archived'] }]]) {
    assert.throws(() => readHistoryPage({ docs, hasNextPage: false }, row.legacyDocumentId), /invalid_history_page/)
  }
})
test('metadata basis extension validates source honesty without rewriting Task7 hash formulas', () => {
  assert.doesNotThrow(() => validateHistoryMetadataBasis(undefined, null))
  assert.doesNotThrow(() => validateHistoryMetadataBasis(row.metadataBasis, null))
  assert.throws(() => validateHistoryMetadataBasis({ ...row.metadataBasis, publishedAt: 'published_pointer' }, null))
  assert.throws(() => validateHistoryMetadataBasis({ ...row.metadataBasis, invented: true }, null))
  const original = { ...row, originalBody: [{ type: 'paragraph' as const, text: 'Synthetic' }], originalEditorial: null }
  assert.deepEqual(historyHashes(original), historyHashes({ ...original, metadataBasis: undefined }))
})
test('producer conversion round-trips all eleven types through the actual native CMS adapters', () => {
  const fixture = sourceFixture()
  const revision = { ...fixture.revisions[0], blocks: everyLegacyBlock() }
  const assets = new Map([mediaFixture(ids.image, 'image/png'), mediaFixture(ids.pdf, 'application/pdf'), mediaFixture(ids.video, 'video/mp4')].map(asset => [asset.id, asset]))
  const converted = convertLegacyRevision({ document: fixture.documents[0], revision, assets })
  const native = { ...converted.content, body: legacyToPayloadBlocks(converted.content.body) }
  assert.deepEqual(normalizeNewsDocument(native, true).blocks, revision.blocks)
  const importedHistory: LegacyNewsRevisionInput = { ...converted.history,
    metadataBasis: { title: 'document_snapshot', category: 'document_snapshot', publishedAt: 'unknown' } }
  assert.deepEqual(historyHashes(importedHistory), { contentHash: importedHistory.contentHash, provenanceHash: importedHistory.provenanceHash })
})

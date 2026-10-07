import assert from 'node:assert/strict'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { NewsMigrationItems } from '../../src/collections/NewsMigrationItems.js'
import { NewsMigrationRuns } from '../../src/collections/NewsMigrationRuns.js'
import { NewsSchedules } from '../../src/collections/NewsSchedules.js'
import { assertMediaOrphan } from '../../src/media/references.js'

const mediaId = 'a0000000-0000-4000-8000-000000000001'
const otherId = 'b0000000-0000-4000-8000-000000000002'
const legacyBody = [{ type: 'image', asset_id: mediaId, alt: 'source image' }]
const nativeBody = [{ blockType: 'image', media: { id: mediaId }, alt: 'native image', caption: '' }]

function fields(names: string[]) { return names.map(name => ({ name, type: 'text' })) }

function fixture(options: { schedules?: Record<string, unknown>[]; items?: Record<string, unknown>[]; itemPages?: number;
  failFind?: Error; extraItemField?: boolean; extraStore?: boolean; omitRuns?: boolean; omitItems?: boolean } = {}) {
  const calls: string[] = []
  const articleFields = fields(['id', 'createdAt', 'updatedAt', '_status', 'publishedAt', 'publicationGeneration', 'legacyDocumentId',
    'legacySourceId', 'legacyRevisionId', 'importedAt', 'title', 'category', 'editorial', 'body'])
  const payload = {
    db: { sessions: { live: { db: { execute: async () => { calls.push('sql') } } } } },
    collections: {
      'news-articles': { config: { fields: articleFields, versions: { maxPerDoc: 0 } } },
      'news-schedules': { config: { ...NewsSchedules, fields: options.extraItemField
        ? [...NewsSchedules.fields, { name: 'futureScheduleData', type: 'json' as const }] : NewsSchedules.fields } },
      ...(!options.omitRuns ? { 'news-migration-runs': { config: NewsMigrationRuns } } : {}),
      ...(!options.omitItems ? { 'news-migration-items': { config: { ...NewsMigrationItems, fields: options.extraItemField
        ? [...NewsMigrationItems.fields, { name: 'futureReservationData', type: 'json' as const }] : NewsMigrationItems.fields } } } : {}),
      ...(options.extraStore ? { 'future-retention-store': { config: { fields: [] } } } : {}),
    },
    config: { globals: [{ slug: 'news-home', fields: fields(['id', 'createdAt', 'updatedAt', '_status', 'publishedAt', 'publicationGeneration',
      'legacyDocumentId', 'legacySourceId', 'legacyRevisionId', 'importedAt', 'eyebrow', 'headline', 'summary']) }], jobs: { tasks: [] } },
    find: async ({ req, collection, page }: { req: PayloadRequest; collection: string; page: number }) => {
      assert.equal(req.transactionID, 'live')
      calls.push(`find:${collection}:${page}`)
      if (options.failFind) throw options.failFind
      if (collection === 'news-schedules') return { docs: options.schedules || [], hasNextPage: false }
      if (collection === 'news-migration-items') return { docs: page === (options.itemPages || 1) ? options.items || [] : [], hasNextPage: page < (options.itemPages || 1) }
      return { docs: [], hasNextPage: false }
    },
    findVersions: async ({ req }: { req: PayloadRequest }) => { assert.equal(req.transactionID, 'live'); return { docs: [], hasNextPage: false } },
  } as unknown as Payload
  const req = { transactionID: 'live', payload } as PayloadRequest
  return { payload, req, calls }
}

const schedule = (state: string, snapshot: unknown, sourceSnapshot?: unknown) => ({ target: 'news-articles', state,
  snapshot, ...(sourceSnapshot === undefined ? {} : { sourceSnapshot }) })

test('migration asset reservations protect source/destination UUIDs in every state', async () => {
  for (const item of [
    { entityKind: 'asset', sourceId: mediaId, destinationId: otherId, state: 'planned', commitOutcome: 'acknowledged' },
    { entityKind: 'asset', sourceId: otherId, destinationId: mediaId, state: 'conflict', commitOutcome: 'unknown' },
    { entityKind: 'asset', sourceId: mediaId, destinationId: null, state: 'applied', commitOutcome: 'unknown' },
  ]) {
    const f = fixture({ items: [item] })
    await assert.rejects(assertMediaOrphan(f.payload, mediaId, f.req), /media_is_referenced/)
    assert.equal(f.calls[0], 'sql', 'reference lock precedes collection scans')
  }
})

test('imported suspended schedules retain both original and native snapshots', async () => {
  for (const [state, native, source] of [
    ['suspended', nativeBody, [{ ...legacyBody[0], asset_id: otherId }]],
    ['suspended', [{ ...nativeBody[0], media: { id: otherId } }], legacyBody],
    ['published', nativeBody, legacyBody],
    ['cancelled', [{ ...nativeBody[0], media: { id: otherId } }], legacyBody],
  ] as const) {
    const f = fixture({ schedules: [schedule(state, { body: native }, { body: source })] })
    await assert.rejects(assertMediaOrphan(f.payload, mediaId, f.req), /media_is_referenced/)
  }
  const nativeOnly = fixture({ schedules: [schedule('suspended', { body: nativeBody })] })
  await assert.rejects(assertMediaOrphan(nativeOnly.payload, mediaId, nativeOnly.req), /media_is_referenced/)
  const sourceOnly = fixture({ schedules: [schedule('suspended', { body: [{ ...nativeBody[0], media: { id: otherId } }] }, { body: legacyBody })] })
  await assert.rejects(assertMediaOrphan(sourceOnly.payload, mediaId, sourceOnly.req), /media_is_referenced/)

  const legacySchedule = fixture({ schedules: [schedule('pending', { body: [{ ...nativeBody[0], media: { id: otherId } }] })] })
  await assert.doesNotReject(assertMediaOrphan(legacySchedule.payload, mediaId, legacySchedule.req),
    'native legacy schedules may have no import source snapshot')
})

test('imported schedules with missing or invalid original source snapshots fail closed', async () => {
  const marker = { sourceScheduleKey: 'imported-schedule-key', importRunId: 'run-id' }
  for (const row of [
    { ...schedule('suspended', { body: [{ ...nativeBody[0], media: { id: otherId } }] }), ...marker },
    { ...schedule('suspended', { body: [{ ...nativeBody[0], media: { id: otherId } }] }, null), ...marker },
    { ...schedule('suspended', { body: [{ ...nativeBody[0], media: { id: otherId } }] }, { body: { malformed: true } }), ...marker },
  ]) {
    const f = fixture({ schedules: [row] })
    await assert.rejects(assertMediaOrphan(f.payload, mediaId, f.req), /media_reference_store_not_covered/)
  }
})

test('both migration reference stores are required even when scans would find no rows', async () => {
  for (const options of [{ omitRuns: true }, { omitItems: true }]) {
    const f = fixture(options)
    await assert.rejects(assertMediaOrphan(f.payload, mediaId, f.req), /media_reference_store_not_covered/)
  }
})

test('unknown/corrupt schedule content and unknown future retention schema fail closed', async () => {
  const corrupt = fixture({ schedules: [schedule('suspended', { body: [{ blockType: 'futureBlock', media: mediaId }] }, { body: legacyBody })] })
  await assert.rejects(assertMediaOrphan(corrupt.payload, mediaId, corrupt.req))

  const field = fixture({ extraItemField: true })
  await assert.rejects(assertMediaOrphan(field.payload, mediaId, field.req), /media_reference_store_not_covered/)
  const store = fixture({ extraStore: true })
  await assert.rejects(assertMediaOrphan(store.payload, mediaId, store.req), /media_reference_store_not_covered/)
})

test('reservation scan follows all bounded pages and propagates database errors', async () => {
  const paged = fixture({ itemPages: 2, items: [{ entityKind: 'asset', sourceId: mediaId, destinationId: null, state: 'planned' }] })
  await assert.rejects(assertMediaOrphan(paged.payload, mediaId, paged.req), /media_is_referenced/)
  assert.ok(paged.calls.includes('find:news-migration-items:2'))

  const dbFailure = new Error('synthetic database failure')
  const broken = fixture({ failFind: dbFailure })
  await assert.rejects(assertMediaOrphan(broken.payload, mediaId, broken.req), error => error === dbFailure)
})

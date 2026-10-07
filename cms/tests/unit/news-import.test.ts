import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectionBeforeOperationHook, Payload, PayloadRequest } from 'payload'
import { legacyNewsImportContext, protectNewsIdentity } from '../../src/news/validation'
import { createLegacyNewsArticle } from '../../src/news/import-article'
import { articleID } from '../fixtures/news'

test('identity is server-only at create, immutable at update, and JSON cannot forge the capability', async () => {
  const call = (operation: string, data: object, context: object = {}, id?: string) => protectNewsIdentity({
    operation, args: { data, id }, req: { context },
  } as unknown as Parameters<CollectionBeforeOperationHook>[0])
  for (const context of [{}, { legacyImport: true }, JSON.parse(JSON.stringify(legacyNewsImportContext))]) {
    await assert.rejects(async () => call('create', { id: articleID }, context), /news_identity_server_only/)
  }
  await call('create', {})
  await call('create', { id: articleID }, legacyNewsImportContext)
  await assert.rejects(async () => call('create', { id: 'bad' }, legacyNewsImportContext))
  await call('update', { id: articleID }, {}, articleID)
  await assert.rejects(async () => call('update', { id: articleID }, {}, 'another-id'), /news_identity_immutable/)
})

test('import requires isolated adapter and rolls back a returned or persisted identity mismatch', async () => {
  const data = { id: articleID, title: 'Synthetic import', editorial: null, body: [], _status: 'draft' as const }
  await assert.rejects(createLegacyNewsArticle({ db: {} } as Payload, data), /separate_import_config/)
  await assert.rejects(createLegacyNewsArticle({ db: { allowIDOnCreate: true } } as unknown as Payload, data), /legacy_import_actor_required/)
  const req = { context: {}, i18n: { t: () => '' }, payloadDataLoader: {}, user: { collection: 'portal-editors', portalUid: 'import-requester',
    portalActor: { uid: 'import-requester', canManageNews: true } } } as unknown as PayloadRequest
  for (const mismatch of ['returned', 'persisted', 'collision']) {
    const calls: string[] = []
    const payload = {
      db: { allowIDOnCreate: true, sessions: { transaction: { db: { execute: async () => {} } } }, beginTransaction: async () => 'transaction',
        commitTransaction: async () => { calls.push('commit') }, rollbackTransaction: async () => { calls.push('rollback') } },
      create: async (args: { req: { transactionID: string }, context: unknown }) => {
        assert.equal(args.req.transactionID, 'transaction')
        assert.equal(args.context, legacyNewsImportContext)
        if (mismatch === 'collision') throw new Error('duplicate key')
        return { id: mismatch === 'returned' ? 'wrong' : articleID }
      },
      findByID: async () => ({ id: articleID, legacyDocumentId: 'wrong' }),
    } as unknown as Payload
    await assert.rejects(createLegacyNewsArticle(payload, data, req))
    assert.deepEqual(calls, ['rollback'])
  }
})

test('article helper composes the caller transaction and preserves capability context', async () => {
  const data = { id: articleID, title: 'Synthetic import', editorial: null, body: [], _status: 'draft' as const }
  const binding = Symbol('synthetic-preparation-binding')
  const calls: string[] = []
  const payload = {
    db: { allowIDOnCreate: true, sessions: { caller: { db: { execute: async () => {} } } },
      beginTransaction: async () => { assert.fail('must not open nested transaction') },
      commitTransaction: async () => { assert.fail('caller owns commit') },
      rollbackTransaction: async () => { assert.fail('caller owns rollback') } },
    create: async (options: { req: PayloadRequest }) => {
      assert.equal(options.req, req)
      assert.equal(options.req.context[binding as unknown as string], 'bound')
      calls.push('create')
      return { id: articleID }
    },
    findByID: async (options: { req: PayloadRequest }) => {
      assert.equal(options.req, req)
      return { id: articleID, legacyDocumentId: articleID }
    },
  } as unknown as Payload
  const req = { payload, transactionID: 'caller', context: { protocol: true, [binding]: 'bound' },
    user: { collection: 'portal-editors', portalUid: 'import-requester', portalActor: { uid: 'import-requester', canManageNews: true } } } as unknown as PayloadRequest
  await createLegacyNewsArticle(payload, data, req)
  assert.deepEqual(calls, ['create'])
  payload.findByID = async () => { throw new Error('synthetic_validation_failure') }
  await assert.rejects(createLegacyNewsArticle(payload, data, req), /synthetic_validation_failure/)
  assert.equal(req.transactionID, 'caller')
})

test('standalone article requires fresh persisted confirmation, not a fulfilled commit promise', async () => {
  const data = { id: articleID, title: 'Synthetic import', editorial: null, body: [], _status: 'draft' as const }
  const row = { ...data, legacyDocumentId: articleID }
  for (const outcome of ['acknowledged', 'absent', 'changed']) {
    let reads = 0
    const events: string[] = []
    const payload = {
      db: { allowIDOnCreate: true, sessions: { owned: { db: { execute: async () => {} } } },
        beginTransaction: async () => 'owned', commitTransaction: async () => { events.push('commit') },
        rollbackTransaction: async () => { events.push('rollback') } },
      create: async () => row,
      findByID: async ({ req: readReq }: { req: PayloadRequest }) => {
        reads++
        if (reads === 1) { assert.equal(readReq.transactionID, 'owned'); return row }
        assert.equal(readReq.transactionID, undefined)
        assert.notEqual(readReq.payloadDataLoader, req.payloadDataLoader)
        return outcome === 'absent' ? null : outcome === 'changed' ? { ...row, title: 'Later edit' } : row
      },
    } as unknown as Payload
    const req = { payload, context: {}, i18n: { t: () => '' }, payloadDataLoader: {},
      user: { collection: 'portal-editors', portalUid: 'import-requester', portalActor: { uid: 'import-requester', canManageNews: true } } } as unknown as PayloadRequest
    if (outcome === 'acknowledged') assert.deepEqual(await createLegacyNewsArticle(payload, data, req), row)
    else await assert.rejects(createLegacyNewsArticle(payload, data, req), /commit_outcome_unknown/)
    assert.deepEqual(events, ['commit'])
    assert.equal(reads, 2)
  }
})

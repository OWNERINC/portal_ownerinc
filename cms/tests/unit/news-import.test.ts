import assert from 'node:assert/strict'
import test from 'node:test'
import type { CollectionBeforeOperationHook, Payload } from 'payload'
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
  for (const mismatch of ['returned', 'persisted', 'collision']) {
    const calls: string[] = []
    const payload = {
      db: { allowIDOnCreate: true, beginTransaction: async () => 'transaction',
        commitTransaction: async () => { calls.push('commit') }, rollbackTransaction: async () => { calls.push('rollback') } },
      create: async (args: { req: { transactionID: string }, context: unknown }) => {
        assert.equal(args.req.transactionID, 'transaction')
        assert.equal(args.context, legacyNewsImportContext)
        if (mismatch === 'collision') throw new Error('duplicate key')
        return { id: mismatch === 'returned' ? 'wrong' : articleID }
      },
      findByID: async () => ({ id: articleID, legacyDocumentId: 'wrong' }),
    } as unknown as Payload
    await assert.rejects(createLegacyNewsArticle(payload, data))
    assert.deepEqual(calls, ['rollback'])
  }
})

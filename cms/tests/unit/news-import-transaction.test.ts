import assert from 'node:assert/strict'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { commitTransaction as nativeCommitTransaction } from '@payloadcms/drizzle'
import { withImportTransaction } from '../../src/migration/transaction'

function fixture() {
  const events: string[] = []
  const sessions: Record<string, { db: { execute: () => Promise<void> } }> = {}
  const session = { db: { execute: async () => { events.push('lock') } } }
  const payload = { db: {
    sessions,
    beginTransaction: async () => { events.push('begin'); sessions.owned = session; return 'owned' },
    commitTransaction: async () => { events.push('commit'); delete sessions.owned },
    rollbackTransaction: async () => { events.push('rollback'); delete sessions.owned },
  } } as unknown as Payload
  const req = { payload, context: {}, i18n: { t: () => '' }, payloadDataLoader: {} } as unknown as PayloadRequest
  return { payload, req, events, sessions, session }
}

test('nested import preserves exact req and leaves successful commit to caller', async () => {
  const { payload, req, events, sessions, session } = fixture()
  sessions.caller = session; req.transactionID = 'caller'
  const result = await withImportTransaction(payload, req, async inner => {
    assert.equal(inner, req); assert.equal(inner.transactionID, 'caller'); return 42
  })
  assert.equal(result, 42)
  assert.deepEqual(events, ['lock', 'lock'])
  assert.equal(req.transactionID, 'caller')
})

test('nested import failure never independently commits or rolls back caller unit', async () => {
  const { payload, req, events, sessions, session } = fixture()
  sessions.caller = session; req.transactionID = Promise.resolve('caller')
  const failure = new Error('synthetic_failure')
  await assert.rejects(withImportTransaction(payload, req, async () => { throw failure }), error => error === failure)
  assert.deepEqual(events, ['lock', 'lock'])
  assert.ok(sessions.caller)
  assert.equal(await req.transactionID, 'caller')
})

test('stale or foreign caller transaction never falls back to standalone/pool', async () => {
  const { payload, req, events, sessions, session } = fixture()
  req.transactionID = 'missing'
  await assert.rejects(withImportTransaction(payload, req, async () => assert.fail()), /cms_transaction_required/)
  sessions.missing = session; req.payload = {} as Payload
  await assert.rejects(withImportTransaction(payload, req, async () => assert.fail()), /cms_transaction_required/)
  assert.deepEqual(events, [])
})

test('standalone import commits once and does not attach its transaction to incoming req', async () => {
  const { payload, req, events } = fixture()
  await withImportTransaction(payload, req, async inner => {
    assert.notEqual(inner, req); assert.equal(inner.transactionID, 'owned')
  }, { confirmCommitted: async () => true })
  assert.deepEqual(events, ['begin', 'lock', 'lock', 'commit'])
  assert.equal(req.transactionID, undefined)
})

test('standalone pre-commit failure rolls back, including loss of live transaction', async () => {
  const { payload, req, events, sessions } = fixture()
  await assert.rejects(withImportTransaction(payload, req, async () => { delete sessions.owned }, { confirmCommitted: async () => true }), /cms_transaction_required/)
  assert.deepEqual(events, ['begin', 'lock', 'lock', 'rollback'])
})

test('lost COMMIT response is unknown and never followed by rollback or replay', async () => {
  const { payload, req, events, sessions } = fixture()
  payload.db.commitTransaction = async () => { events.push('commit'); delete sessions.owned; throw new Error('private transport detail') }
  let applied = 0
  await assert.rejects(withImportTransaction(payload, req, async () => { applied++ }, { confirmCommitted: async () => true }), error => {
    assert.equal((error as Error).message, 'commit_outcome_unknown')
    assert.equal((error as { code: string }).code, 'commit_outcome_unknown')
    return true
  })
  assert.equal(applied, 1)
  assert.deepEqual(events, ['begin', 'lock', 'lock', 'commit'])
})

test('rollback error is controlled and never masks failure as success', async () => {
  const { payload, req } = fixture()
  payload.db.rollbackTransaction = async () => { throw new Error('private connection') }
  await assert.rejects(withImportTransaction(payload, req, async () => { throw new Error('write failed') }, { confirmCommitted: async () => true }), /import_rollback_failed/)
})

test('standalone requires receipt before writing and cannot trust fulfilled adapter COMMIT', async () => {
  const { payload, req, events } = fixture()
  await assert.rejects(withImportTransaction(payload, req, async () => assert.fail()), /import_commit_confirmation_required/)
  assert.deepEqual(events, [])
  await assert.rejects(withImportTransaction(payload, req, async () => 1, { confirmCommitted: async () => false }), /commit_outcome_unknown/)
  assert.deepEqual(events, ['begin', 'lock', 'lock', 'commit'])
})

test('post-commit receipt read failure is unknown, without rollback or sensitive error', async () => {
  const { payload, req, events } = fixture()
  await assert.rejects(withImportTransaction(payload, req, async () => 1,
    { confirmCommitted: async () => { throw new Error('private receipt connection') } }), error => (error as Error).message === 'commit_outcome_unknown')
  assert.deepEqual(events, ['begin', 'lock', 'lock', 'commit'])
})

test('installed adapter swallowed commit failure cannot produce an import success', async () => {
  const { payload, req, session } = fixture()
  const nativeEvents: string[] = []
  Object.assign(session, {
    resolve: async () => { nativeEvents.push('resolve'); throw new Error('synthetic_commit_loss') },
    reject: async () => { nativeEvents.push('reject') },
  })
  payload.db.commitTransaction = nativeCommitTransaction
  await assert.rejects(withImportTransaction(payload, req, async () => 1,
    { confirmCommitted: async () => false }), /commit_outcome_unknown/)
  assert.deepEqual(nativeEvents, ['resolve', 'reject'])
})

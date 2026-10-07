import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'
import type { Payload, PayloadRequest } from 'payload'
import { assertPreparationRun } from '../../src/migration/preparation-run'
import { NewsMigrationRuns } from '../../src/collections/NewsMigrationRuns'
import { NewsMigrationItems } from '../../src/collections/NewsMigrationItems'

const identity = { runId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), expectedEpoch: 2 }
const open = { id: identity.runId, manifest_sha256: identity.manifestSha256, source_fingerprint: 'b'.repeat(64),
  authority_epoch: 2, progress_state: 'preparing', admission_state: 'open', commit_outcome: 'acknowledged' }

function fixture(row: object | null) {
  let calls = 0
  const payload = { db: { sessions: { caller: { db: { execute: async () => { calls++; return { rows: row ? [row] : [] } } } } } } } as unknown as Payload
  const req = { payload, transactionID: 'caller', context: {} } as unknown as PayloadRequest
  return { req, calls: () => calls }
}

test('durable run reader uses live caller transaction and locked identity', async () => {
  const { req, calls } = fixture(open)
  assert.deepEqual(await assertPreparationRun(req, identity), { ...identity, sourceFingerprint: open.source_fingerprint, progressState: 'preparing' })
  assert.equal(calls(), 3)
  assert.equal(req.transactionID, 'caller')
})

test('installed pg NUMERIC text decoder produces a valid string epoch for the locked run', async () => {
  const epoch = pg.types.getTypeParser(1700, 'text')('2')
  assert.equal(epoch, '2')
  const { req } = fixture({ ...open, authority_epoch: epoch })
  assert.equal((await assertPreparationRun(req, identity)).expectedEpoch, 2)
  for (const raw of ['2', '2.0', '2.000000']) {
    const { req } = fixture({ ...open, authority_epoch: raw })
    assert.equal((await assertPreparationRun(req, identity)).expectedEpoch, 2)
  }
})

test('stored epochs reject mismatch, fraction, unsafe precision and coercible junk', async () => {
  for (const authority_epoch of ['3', '2.1', '2.000001', '9007199254740993', '9007199254740992.0',
    '0', '-2', '+2', '02', ' 2', '2 ', '2e0', '0x2', '', 'NaN', 'Infinity', '2.0junk', null, true, {}, 2.5, NaN]) {
    const { req } = fixture({ ...open, authority_epoch })
    await assert.rejects(assertPreparationRun(req, identity), /migration_preparation_run_closed/)
  }
})

test('sealed, conflicted, unknown, absent or mismatched run denies preparation', async () => {
  for (const row of [null, { ...open, admission_state: 'sealed' }, { ...open, progress_state: 'reconciled' },
    { ...open, progress_state: 'conflict' }, { ...open, commit_outcome: 'unknown' }, { ...open, authority_epoch: 3 },
    { ...open, manifest_sha256: 'c'.repeat(64) }, { ...open, id: 'other' }]) {
    const { req } = fixture(row)
    await assert.rejects(assertPreparationRun(req, identity), /migration_preparation_run_closed/)
  }
  const { req, calls } = fixture(open); req.transactionID = 'stale'
  await assert.rejects(assertPreparationRun(req, identity), /cms_transaction_required/)
  assert.equal(calls(), 0)
})

test('ledger schemas remain fail-closed even under override until preparation hook integration', async () => {
  for (const collection of [NewsMigrationRuns, NewsMigrationItems]) {
    for (const operation of ['create', 'update', 'delete', 'restoreVersion'] as const) {
      const hook = collection.hooks!.beforeOperation![0]
      await assert.rejects(async () => hook({ operation, req: { context: { legacyImport: true } }, args: { overrideAccess: true } } as unknown as Parameters<typeof hook>[0]), /migration_preparation_context_required/)
    }
  }
  assert.ok(NewsMigrationRuns.fields.some(field => 'name' in field && field.name === 'manifestSha256' && 'unique' in field && field.unique))
  assert.deepEqual(NewsMigrationItems.indexes, [{ fields: ['manifestSha256', 'entityKind', 'sourceId'], unique: true }])
})

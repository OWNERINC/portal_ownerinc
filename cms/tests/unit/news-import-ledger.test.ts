import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyImportedItem, reconcileImportItems } from '../../src/migration/reconcile'
import { assertMigrationItem, nextMigrationItemState } from '../../src/migration/ledger'
import { assertImportApplyReady, parseImportArguments } from '../../src/migration/preflight'
import path from 'node:path'

const id = '11111111-1111-4111-8111-111111111111'
const expected = { entityKind: 'document' as const, sourceId: id, expectedHash: 'a'.repeat(64), destinationId: id }
const observed = { entityKind: 'document' as const, sourceId: id, contentHash: 'a'.repeat(64), destinationId: id, identityMatches: true }

test('reconciliation distinguishes absent/current/divergent content without trusting ledger state', () => {
  assert.equal(classifyImportedItem(expected.expectedHash, null), 'create')
  assert.equal(classifyImportedItem(expected.expectedHash, observed.contentHash), 'existing')
  assert.equal(classifyImportedItem(expected.expectedHash, 'b'.repeat(64)), 'conflict')
  assert.equal(reconcileImportItems([expected], []).ok, false)
  assert.equal(reconcileImportItems([expected], [observed]).ok, true)
  const result = reconcileImportItems([expected], [{ ...observed, contentHash: 'b'.repeat(64) }])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].code, 'content_changed')
  assert.equal(result.counts.verified, 0)
})

test('identity collision, destination drift, duplicate and unexpected entries fail closed', () => {
  for (const change of [{ identityMatches: false }, { destinationId: '22222222-2222-4222-8222-222222222222' }]) {
    assert.equal(reconcileImportItems([expected], [{ ...observed, ...change }]).ok, false)
  }
  assert.throws(() => reconcileImportItems([expected, expected], [observed]), /duplicate_import_identity/)
  assert.throws(() => reconcileImportItems([expected], [observed, observed]), /duplicate_import_identity/)
  assert.equal(reconcileImportItems([], [observed]).conflicts[0].code, 'unexpected_destination')
})

test('asset metadata equality without actual verified bytes cannot reconcile', () => {
  const asset = { ...expected, entityKind: 'asset' as const }
  const current = { ...observed, entityKind: 'asset' as const }
  assert.equal(reconcileImportItems([asset], [current]).conflicts[0].code, 'asset_bytes_unverified')
  assert.equal(reconcileImportItems([asset], [{ ...current, bytesVerified: true }]).ok, true)
})

test('ledger cannot promote planned/unknown/edited content to verified from counts or previous status', () => {
  const item = { ...expected, manifestSha256: 'c'.repeat(64), runId: id, state: 'planned' as const,
    commitOutcome: 'acknowledged' as const, observedHash: null }
  assertMigrationItem(item)
  assert.equal(nextMigrationItemState(item, null), 'planned')
  assert.equal(nextMigrationItemState({ ...item, state: 'verified' }, 'b'.repeat(64)), 'conflict')
  assert.equal(nextMigrationItemState({ ...item, commitOutcome: 'unknown' }, expected.expectedHash), 'applied')
  assert.equal(nextMigrationItemState({ ...item, state: 'applied' }, expected.expectedHash), 'verified')
  assert.throws(() => assertMigrationItem({ ...item, sourceId: 'title-not-identity' }), /invalid_import_identity/)
  assert.throws(() => assertMigrationItem({ ...item, expectedHash: 'bad' }), /invalid_import_ledger/)
})

test('CLI argument preflight defaults to dry-run and rejects ambiguous/unknown flags', () => {
  const bundle = path.resolve('synthetic-private-bundle.json')
  assert.deepEqual(parseImportArguments(['--bundle', bundle]), { bundlePath: bundle, apply: false })
  assert.equal(parseImportArguments(['--bundle', bundle, '--apply']).apply, true)
  for (const args of [[], ['--bundle', 'relative.json'], ['--bundle', bundle, '--force'],
    ['--bundle', bundle, '--apply', '--dry-run'], ['--bundle', bundle, '--apply', '--apply'], ['--bundle', bundle, '--bundle', bundle]]) {
    assert.throws(() => parseImportArguments(args), /invalid_import_arguments/)
  }
})

test('apply is explicitly held until preparation, destination reconcile and schedule/media integration', () => {
  assert.throws(() => assertImportApplyReady({} as never), /import_apply_not_ready/)
})

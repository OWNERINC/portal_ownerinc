import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreauthorityNativeCatalogInventory,
  preauthorityExpectedNativeCatalogInventory,
} from '../../scripts/finalize-news-protocol'
import { assertPreauthorityCatalogState } from '../../scripts/verify-preauthority-catalog'

test('preauthority catalog accepts only an absent protocol with no native News rows', () => {
  assert.doesNotThrow(() => assertPreauthorityCatalogState('absent', 0n))
  assert.throws(() => assertPreauthorityCatalogState('v1', 0n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('v2', 0n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('partial', 0n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('absent', 1n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('absent', '0'), /preauthority_catalog_verification_failed/)
})

test('preauthority native inventory is exact while the protocol finalizer remains outside its allowlist', () => {
  const expected = preauthorityExpectedNativeCatalogInventory()
  const migrationNames = [
    '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
    '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
    '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
  ]
  const fingerprint = assertPreauthorityNativeCatalogInventory(expected, migrationNames)
  assert.match(fingerprint, /^[0-9a-f]{64}$/u)

  const unexpectedMaterializedView = structuredClone(expected)
  unexpectedMaterializedView.relations.push({ schema: 'public', name: 'fixture_summary', kind: 'm' })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedMaterializedView, migrationNames),
    /preauthority_native_relation_inventory_mismatch/u)

  const unexpectedCompositeRelation = structuredClone(expected)
  unexpectedCompositeRelation.relations.push({ schema: 'public', name: 'fixture_payload', kind: 'c' })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedCompositeRelation, migrationNames),
    /preauthority_native_relation_inventory_mismatch/u)

  const unexpectedView = structuredClone(expected)
  unexpectedView.relations.push({ schema: 'public', name: 'fixture_summary', kind: 'v' })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedView, migrationNames),
    /preauthority_native_relation_inventory_mismatch/u)

  const unexpectedColumn = structuredClone(expected)
  unexpectedColumn.columns.push({
    ...unexpectedColumn.columns[0]!, table: 'news_articles', name: 'fixture_unreviewed_column',
  })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedColumn, migrationNames),
    /preauthority_native_column_inventory_mismatch/u)

  const mismatchedDefault = structuredClone(expected)
  mismatchedDefault.columns[0]!.defaultVerified = false
  assert.throws(() => assertPreauthorityNativeCatalogInventory(mismatchedDefault, migrationNames),
    /preauthority_native_column_inventory_mismatch/u)

  const unexpectedIndex = structuredClone(expected)
  unexpectedIndex.indexes.push({
    ...unexpectedIndex.indexes[0]!, name: 'fixture_unreviewed_idx', definition: 'CREATE INDEX fixture_unreviewed_idx',
  })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedIndex, migrationNames),
    /preauthority_native_index_inventory_mismatch/u)

  const unexpectedConstraint = structuredClone(expected)
  unexpectedConstraint.constraints.push({
    ...unexpectedConstraint.constraints[0]!, name: 'fixture_unreviewed_check', kind: 'c',
    definition: 'CHECK (true)',
  })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedConstraint, migrationNames),
    /preauthority_native_constraint_inventory_mismatch/u)

  const unexpectedCompositeType = structuredClone(expected)
  unexpectedCompositeType.types.push({ schema: 'public', name: 'fixture_payload', kind: 'c', labels: [] })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedCompositeType, migrationNames),
    /preauthority_native_type_inventory_mismatch/u)
  assert.ok(expected.relations.every(relation => relation.kind !== 'c'), 'automatic table rowtypes are not standalone relations')
  assert.ok(expected.types.every(type => type.kind !== 'c'), 'automatic table rowtypes and their arrays are not custom standalone types')

  const requiredChecks = expected.constraints.filter(constraint => constraint.kind === 'c')
  assert.equal(requiredChecks.length, 24, 'every CHECK added by the native migration has a canonical definition')
  for (const constraint of requiredChecks) {
    const weakenedCheck = structuredClone(expected)
    const sameNameCheck = weakenedCheck.constraints.find(candidate => candidate.name === constraint.name)
    assert.ok(sameNameCheck)
    sameNameCheck.definition = 'CHECK (true)'
    assert.throws(() => assertPreauthorityNativeCatalogInventory(weakenedCheck, migrationNames),
      /preauthority_native_constraint_inventory_mismatch/u, `weakened same-name check ${constraint.name} is rejected`)
  }

  const pgRenderedCheck = structuredClone(expected)
  const pgCheck = pgRenderedCheck.constraints.find(constraint => constraint.name === 'news_migration_runs_manifest_sha256_check')
  assert.ok(pgCheck)
  pgCheck.definition = "CHECK (((manifest_sha256)::text ~ '^[0-9a-f]{64}$'::text))"
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedCheck, migrationNames),
    'canonical check comparison accepts PostgreSQL-added casts and grouping without accepting changed predicates')

  const primaryKeys = expected.constraints.filter(constraint => constraint.kind === 'p')
  assert.ok(primaryKeys.length > 0)
  for (const constraint of primaryKeys) {
    const changedPrimaryKey = structuredClone(expected)
    const sameNamePrimaryKey = changedPrimaryKey.constraints.find(candidate => candidate.name === constraint.name)
    assert.ok(sameNamePrimaryKey)
    sameNamePrimaryKey.definition = 'PRIMARY KEY (wrong_id)'
    assert.throws(() => assertPreauthorityNativeCatalogInventory(changedPrimaryKey, migrationNames),
      /preauthority_native_constraint_inventory_mismatch/u, `changed same-name primary key ${constraint.name} is rejected`)
  }

  const foreignKeys = expected.constraints.filter(constraint => constraint.kind === 'f')
  assert.ok(foreignKeys.length > 0)
  for (const constraint of foreignKeys) {
    const changedForeignKey = structuredClone(expected)
    const sameNameForeignKey = changedForeignKey.constraints.find(candidate => candidate.name === constraint.name)
    assert.ok(sameNameForeignKey)
    sameNameForeignKey.definition = 'FOREIGN KEY (wrong_id) REFERENCES public.wrong_table(id)'
    assert.throws(() => assertPreauthorityNativeCatalogInventory(changedForeignKey, migrationNames),
      /preauthority_native_constraint_inventory_mismatch/u, `changed same-name foreign key ${constraint.name} is rejected`)
  }

  const pgRenderedForeignKey = structuredClone(expected)
  const pgForeignKey = pgRenderedForeignKey.constraints.find(constraint => constraint.kind === 'f'
    && /ON DELETE CASCADE/iu.test(constraint.definition))
  assert.ok(pgForeignKey)
  pgForeignKey.definition = `${pgForeignKey.definition.replaceAll('"', '').replace('public.', '')} ON UPDATE NO ACTION MATCH SIMPLE`
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedForeignKey, migrationNames),
    'canonical FK comparison accepts PostgreSQL schema/quote/default-action rendering')

  const uniqueIndexes = expected.indexes.filter(index => index.unique)
  assert.ok(uniqueIndexes.length > 0)
  for (const index of uniqueIndexes) {
    const changedUniqueIndex = structuredClone(expected)
    const sameNameIndex = changedUniqueIndex.indexes.find(candidate => candidate.name === index.name)
    assert.ok(sameNameIndex)
    sameNameIndex.definition = `CREATE UNIQUE INDEX ${index.name} ON public.wrong_table (wrong_id)`
    assert.throws(() => assertPreauthorityNativeCatalogInventory(changedUniqueIndex, migrationNames),
      /preauthority_native_index_inventory_mismatch/u, `changed same-name unique index ${index.name} is rejected`)
  }

  const pgRenderedUniqueIndex = structuredClone(expected)
  const renderedUniqueIndex = pgRenderedUniqueIndex.indexes.find(index => index.unique)
  assert.ok(renderedUniqueIndex)
  renderedUniqueIndex.definition = `CREATE UNIQUE INDEX ${renderedUniqueIndex.name} ON public.${renderedUniqueIndex.table} USING ${renderedUniqueIndex.method} (${renderedUniqueIndex.columns.map(column => column.expression).join(', ')})`
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedUniqueIndex, migrationNames),
    'canonical unique-index comparison accepts PostgreSQL identifier dequoting')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCmsRuntimeCatalog, assertCmsRuntimeIdentity, assertCmsSchemaCatalog, assertCmsStorageReady } from '../../src/config/readiness.js'
import { migrations } from '../../src/migrations/index.js'
import { NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger.js'
import { buildNewsMutationTriggersDDL, expectedNewsMutationTriggerFunctionBodies } from '../../src/publication/mutation-triggers.js'
import { extractCanonicalFunctionBodies } from '../../scripts/finalize-news-protocol.js'
import { GET as health } from '../../src/app/editorial/health/route.js'

test('health is liveness-only and never initializes database or storage', async () => {
  const response = await health()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'alive' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('readiness writes, fsyncs and removes a private probe in the configured storage', async () => {
  const calls: string[] = []
  const file = {
    async sync() { calls.push('sync') },
    async close() { calls.push('close') },
  }
  const fs = {
    async open(filename: string, flags: string, mode: number) {
      assert.match(filename, /\.ownerinc-ready-[0-9a-f-]+$/u)
      assert.equal(flags, 'wx'); assert.equal(mode, 0o600); calls.push('open'); return file
    },
    async unlink() { calls.push('unlink') },
  }
  await assertCmsStorageReady('/private/media', fs as never, () => '00000000-0000-4000-8000-000000000001')
  assert.deepEqual(calls, ['open', 'sync', 'close', 'unlink'])
})

test('readiness fails when storage is not writable and still closes/removes a created probe', async () => {
  await assert.rejects(assertCmsStorageReady('/private/media', { open: async () => { throw new Error('readonly') } } as never), /readonly/)
  const calls: string[] = []
  await assert.rejects(assertCmsStorageReady('/private/media', {
    open: async () => ({ sync: async () => { throw new Error('fsync') }, close: async () => { calls.push('close') } }),
    unlink: async () => { calls.push('unlink') },
  } as never), /fsync/)
  assert.deepEqual(calls, ['close', 'unlink'])
  await assert.rejects(assertCmsStorageReady('/private/media', {
    open: async () => ({ sync: async () => {}, close: async () => {} }),
    unlink: async () => { throw new Error('cannot-remove') },
  } as never), /cannot-remove/)
})

test('readiness rejects every partial schema catalog', () => {
  const complete = Object.fromEntries(['payload_migrations', 'portal_editors', 'news_articles', '_news_articles_v',
    'news_media', 'news_home', '_news_home_v', 'news_schedules', 'owner_news_mutation_head', 'owner_news_mutation_events'].map(name => [name, name]))
  assert.doesNotThrow(() => assertCmsSchemaCatalog(complete))
  for (const name of Object.keys(complete)) assert.throws(() => assertCmsSchemaCatalog({ ...complete, [name]: null }), /cms_readiness_schema_incomplete/)
  assert.throws(() => assertCmsSchemaCatalog({ ...complete, extra: 'unsafe' }), /cms_readiness_schema_incomplete/)
})

test('readiness binds the runtime to the exact shared-cluster database and least-privilege role', () => {
  assert.doesNotThrow(() => assertCmsRuntimeIdentity({ database_name: 'ownerinc_cms', role_name: 'cms_runtime' }))
  assert.throws(() => assertCmsRuntimeIdentity({ database_name: 'portal', role_name: 'cms_runtime' }), /identity_mismatch/)
  assert.throws(() => assertCmsRuntimeIdentity({ database_name: 'ownerinc_cms', role_name: 'cms_admin' }), /identity_mismatch/)
})

test('readiness requires exact migrations, essential columns and canonical enabled mutation triggers', () => {
  const functionNames = ['owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row']
  const canonicalBodies = extractCanonicalFunctionBodies(buildNewsMutationTriggersDDL(),
    [...functionNames, 'owner_news_seal_run'])
  for (const [name, body] of expectedNewsMutationTriggerFunctionBodies()) {
    assert.equal(body, canonicalBodies.get(name))
    assert.ok(body.startsWith('\n') && body.endsWith('\n'), `${name} preserves delimiter-adjacent bytes`)
  }
  const columnNames = {
    payload_migrations: ['id', 'name', 'batch'], portal_editors: ['id', 'portal_uid', 'email'],
    news_articles: ['id', 'title', 'category', 'publication_generation', '_status'],
    _news_articles_v: ['id', 'parent_id', 'version__status'], news_media: ['id', 'sha256', 'filename'],
    news_home: ['id', 'publication_generation', '_status'], _news_home_v: ['id', 'latest', 'version__status'],
    news_schedules: ['id', 'target', 'scheduled_at', 'state'],
    owner_news_mutation_head: ['singleton', 'sequence', 'chain_sha256', 'coverage_version', 'write_barrier'],
    owner_news_mutation_events: ['sequence', 'event_sha256'],
  }
  const catalog = {
    migrations: migrations.map(migration => ({ name: migration.name })),
    columns: Object.entries(columnNames).flatMap(([table_name, names]) => names.map(column_name => ({ table_name, column_name }))),
    functions: [...expectedNewsMutationTriggerFunctionBodies()].map(([function_name, source]) => ({ function_name, source,
      security_definer: function_name === 'owner_news_mutation_capture_row' ? 'true' : 'false', owner: 'cms_control',
      config: 'search_path=pg_catalog, public', identity_arguments: '', result: 'trigger' })),
    triggers: NEWS_MUTATION_TABLES.flatMap(table_name => [
      { table_name, trigger_name: 'owner_news_mutation_guard_stmt', function_name: 'owner_news_mutation_guard_stmt', function_schema: 'public', trigger_type: '62', enabled: 'A',
        attribute_count: '0', argument_count: '0', argument_bytes: '0', no_condition: 'true' },
      { table_name, trigger_name: 'owner_news_mutation_capture_row', function_name: 'owner_news_mutation_capture_row', function_schema: 'public', trigger_type: '29', enabled: 'A',
        attribute_count: '0', argument_count: '0', argument_bytes: '0', no_condition: 'true' },
    ]),
  }
  assert.doesNotThrow(() => assertCmsRuntimeCatalog(catalog))
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, migrations: catalog.migrations.slice(1) }), /cms_readiness_migrations_incompatible/)
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, columns: catalog.columns.slice(1) }), /cms_readiness_columns_incompatible/)
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, functions: catalog.functions.map((row, index) => index ? row : { ...row, source: 'BEGIN RETURN NULL; END;' }) }), /cms_readiness_functions_incompatible/)
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, triggers: catalog.triggers.slice(1) }), /cms_readiness_triggers_incompatible/)
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, triggers: [...catalog.triggers,
    { ...catalog.triggers[0], trigger_name: 'unexpected_mutation_trigger' }] }), /cms_readiness_triggers_incompatible/)
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, triggers: catalog.triggers.map((row, index) => index ? row : { ...row, enabled: 'O' }) }), /cms_readiness_triggers_incompatible/)
  assert.throws(() => assertCmsRuntimeCatalog({ ...catalog, triggers: catalog.triggers.map((row, index) => index ? row : { ...row, function_schema: 'attacker' }) }), /cms_readiness_triggers_incompatible/)
})

test('readiness SQL scopes the inventory to ledger triggers without rejecting independent integrity guards', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../../src/config/readiness.ts', import.meta.url), 'utf8'))
  assert.match(source, /trigger\.tgname IN \('owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row'\)/u)
})

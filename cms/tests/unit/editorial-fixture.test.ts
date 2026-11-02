import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapEditorialFixture } from '../integration/functional-editorial-bootstrap'

const env = { PAYLOAD_FUNCTIONAL_RUN_ID: '134cfd81-7f0d-47ca-a4fb-c9cabd069c0f', CMS_PORTAL_DATABASE_NAME: 'postgres',
  CMS_DATABASE_URL: 'postgresql://cms_cluster:synthetic@cms-db:5432/postgres',
  CMS_ADMIN_DATABASE_URL: 'postgresql://cms_admin:synthetic-owner@cms-db:5432/ownerinc_cms', CMS_POSTGRES_PASSWORD: 'synthetic-owner' }
function fixture() {
  const calls: string[] = []
  const state = { existing: 0, baseline: { sequence: '0', chain_sha256: '0'.repeat(64), coverage_version: 0, write_barrier: 'open', articles: 0, media: 0, home: 0 }, failFinalizer: false }
  const dependencies = {
    client: () => ({ connect: async () => { calls.push('connect') }, end: async () => { calls.push('end') }, query: async (sql: string) => {
      calls.push(sql)
      return { rows: sql.startsWith('SELECT count(*)') ? [{ n: state.existing }] : sql.startsWith('SELECT sequence') ? [state.baseline] : [] }
    } }),
    provision: async (mode: string, config: typeof env) => { calls.push(mode); assert.equal(new URL(config.CMS_DATABASE_URL).hostname, 'cms-db') },
    finalize: async () => { calls.push('finalize'); if (state.failFinalizer) throw new Error('invalid_protocol'); return { installed: true, ready: false, coverageVersion: 0 } },
  } as unknown as NonNullable<Parameters<typeof bootstrapEditorialFixture>[2]>
  return { calls, state, dependencies }
}

test('editorial bootstrap rejects wrong phase, target and URL overrides before connecting or provisioning', async () => {
  for (const [action, changed] of [['wrong', {}], ['provision', { PAYLOAD_FUNCTIONAL_RUN_ID: 'invalid' }],
    ['provision', { CMS_DATABASE_URL: 'postgresql://cms_cluster:synthetic@outside.invalid:5432/postgres' }],
    ['provision', { CMS_DATABASE_URL: env.CMS_DATABASE_URL + '?options=unsafe' }],
    ['protocol', { CMS_ADMIN_DATABASE_URL: env.CMS_DATABASE_URL }], ['protocol', { CMS_PORTAL_DATABASE_NAME: 'portal' }]] as const) {
    const f = fixture()
    await assert.rejects(bootstrapEditorialFixture(action, { ...env, ...changed }, f.dependencies))
    assert.deepEqual(f.calls, [])
  }
})

test('fixture-only owner preparation precedes official bootstrap; preexisting owner fails closed', async () => {
  const f = fixture()
  await bootstrapEditorialFixture('provision', env, f.dependencies)
  assert.deepEqual(f.calls.slice(-3), ['--bootstrap-database', '--provision', '--bootstrap-control'])
  assert.ok(f.calls.indexOf('ALTER DATABASE ownerinc_cms OWNER TO cms_admin') < f.calls.indexOf('--bootstrap-database'))
  const reused = fixture(); reused.state.existing = 1
  await assert.rejects(bootstrapEditorialFixture('provision', env, reused.dependencies))
  assert.equal(reused.calls.some(call => /^(CREATE|ALTER|--)/u.test(call)), false)
})

test('fixture coverage baseline requires successful canonical finalizer and empty exact head; failures roll back', async () => {
  const f = fixture()
  await bootstrapEditorialFixture('protocol', env, f.dependencies)
  assert.equal(f.calls[0], 'finalize'); assert.ok(f.calls.includes('COMMIT'))
  for (const changed of [{ coverage_version: 1 }, { sequence: '1' }, { articles: 1 }, { media: 1 }, { home: 1 }, { write_barrier: 'frozen' }]) {
    const bad = fixture(); Object.assign(bad.state.baseline, changed)
    await assert.rejects(bootstrapEditorialFixture('protocol', env, bad.dependencies))
    assert.ok(bad.calls.includes('ROLLBACK')); assert.equal(bad.calls.includes('COMMIT'), false)
    assert.equal(bad.calls.some(call => call.startsWith('UPDATE')), false)
  }
  const bad = fixture(); bad.state.failFinalizer = true
  await assert.rejects(bootstrapEditorialFixture('protocol', env, bad.dependencies), /invalid_protocol/)
  assert.deepEqual(bad.calls, ['finalize'])
})

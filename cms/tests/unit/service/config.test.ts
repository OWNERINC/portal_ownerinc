import assert from 'node:assert/strict'
import test from 'node:test'
import { registerFirstUserOperation } from 'payload'
import type { DatabaseAdapter, Payload, PayloadRequest } from 'payload'
import nextConfig from '../../../next.config.mjs'

async function loadConfig() {
  const before = { buildOnly: process.env.CMS_BUILD_ONLY, phase: process.env.NEXT_PHASE }
  try {
    process.env.CMS_BUILD_ONLY = 'true'
    process.env.NEXT_PHASE = 'phase-production-build'
    return await (await import('../../../src/payload.config.js')).default
  } finally {
    if (before.buildOnly === undefined) delete process.env.CMS_BUILD_ONLY
    else process.env.CMS_BUILD_ONLY = before.buildOnly
    if (before.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = before.phase
  }
}

test('configuração sanitizada preserva a fronteira REST e não inicia o banco', async () => {
  const config = await loadConfig()
  assert.equal(config.routes.admin, '/editorial/admin')
  assert.equal(config.routes.api, '/editorial/api')
  assert.equal(config.serverURL, 'https://portal-build.invalid')
  assert.equal(config.graphQL.disable, true)
  assert.deepEqual(config.jobs.autoRun, [])

  // Adapter construction only; connect/init are deliberately never invoked.
  const adapter = config.db.init({ payload: {} as Payload }) as DatabaseAdapter
  assert.equal(adapter.idType, 'uuid')
  assert.equal(adapter.push, false)
  assert.equal(adapter.disableCreateDatabase, true)
  assert.deepEqual(adapter.prodMigrations, [])
  assert.equal(adapter.pool, undefined)
})

test('admin e CRUD permanecem bloqueados; primeiro usuário nativo falha antes do banco', async () => {
  const config = await loadConfig()
  const editors = config.collections.find(collection => collection.slug === 'portal-editors')!
  assert.equal(editors.auth.disableLocalStrategy, true)
  const req = {
    payload: new Proxy({}, { get() { throw new Error('Unexpected database or runtime access') } }),
    t: () => 'Forbidden',
  } as unknown as PayloadRequest
  for (const operation of ['admin', 'create', 'read', 'update', 'delete'] as const) {
    const access = editors.access[operation]!
    assert.equal(await access({ req }), false)
  }
  assert.ok(!editors.fields.some(field => 'name' in field && ['email', 'hash', 'salt', 'password'].includes(field.name)))

  await assert.rejects(registerFirstUserOperation({
    collection: { config: editors, customIDType: 'text' },
    data: { email: 'fixture@example.test', password: 'fixture-not-a-real-password' },
    req,
  }), error => error instanceof Error && 'status' in error && error.status === 403)
})

test('next start recusa inclusive sinal de fase de build fornecido externamente', () => {
  const before = { buildOnly: process.env.CMS_BUILD_ONLY, phase: process.env.NEXT_PHASE }
  try {
    delete process.env.CMS_BUILD_ONLY
    delete process.env.NEXT_PHASE
    const config = nextConfig('phase-production-server')
    assert.equal(config.poweredByHeader, false)
    assert.equal(config.basePath, undefined)
    nextConfig('phase-production-build')
    assert.equal(process.env.CMS_BUILD_ONLY, 'true')
    assert.throws(() => nextConfig('phase-production-server'), /CMS_BUILD_ONLY/)
    delete process.env.CMS_BUILD_ONLY
    process.env.NEXT_PHASE = 'phase-production-build'
    assert.throws(() => nextConfig('phase-production-server'), /CMS_BUILD_ONLY/)
  } finally {
    if (before.buildOnly === undefined) delete process.env.CMS_BUILD_ONLY
    else process.env.CMS_BUILD_ONLY = before.buildOnly
    if (before.phase === undefined) delete process.env.NEXT_PHASE
    else process.env.NEXT_PHASE = before.phase
  }
})

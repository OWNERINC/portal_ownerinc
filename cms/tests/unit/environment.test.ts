import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { readCmsConfigEnvironment, readCmsEnvironment } from '../../src/config/environment.js'

const valid = () => ({
  CMS_DATABASE_URL: 'postgresql://cms:fixture-password@localhost:5432/editorial_test',
  PAYLOAD_SECRET: 'fixture-payload-secret-'.repeat(2),
  PORTAL_PUBLIC_URL: 'https://portal.example.test',
  PORTAL_INTERNAL_URL: 'http://portal-api:3000',
  PAYLOAD_TO_PORTAL_SECRET: 'fixture-payload-to-portal-'.repeat(2),
  PORTAL_TO_PAYLOAD_SECRET: 'fixture-portal-to-payload-'.repeat(2),
  CMS_UPLOAD_DIR: path.resolve('private-test-uploads'),
})

test('não aceita segredo ausente nem publica seu valor no erro', () => {
  assert.throws(() => readCmsEnvironment({}), /CMS_DATABASE_URL/)
  assert.throws(() => readCmsEnvironment({ CMS_DATABASE_URL: 'invalid-private-value' }),
    error => error instanceof Error && !error.message.includes('invalid-private-value'))
})

test('normaliza URLs e storage sem alterar os segredos', () => {
  const env = valid()
  const result = readCmsEnvironment({
    ...env,
    PORTAL_PUBLIC_URL: 'https://PORTAL.example.test:443/',
    PORTAL_INTERNAL_URL: 'http://PORTAL-api:3000/internal/',
    CMS_UPLOAD_DIR: path.join(env.CMS_UPLOAD_DIR, '..', 'private-test-uploads'),
  })
  assert.deepEqual(result, {
    databaseURL: env.CMS_DATABASE_URL,
    payloadSecret: env.PAYLOAD_SECRET,
    portalPublicURL: 'https://portal.example.test',
    portalInternalURL: 'http://portal-api:3000/internal',
    payloadToPortalSecret: env.PAYLOAD_TO_PORTAL_SECRET,
    portalToPayloadSecret: env.PORTAL_TO_PAYLOAD_SECRET,
    uploadDir: env.CMS_UPLOAD_DIR,
  })
})

for (const key of Object.keys(valid())) {
  test(`exige ${key}`, () => {
    for (const value of [undefined, '', '   ']) {
      assert.throws(() => readCmsEnvironment({ ...valid(), [key]: value }),
        error => error instanceof Error && error.message.includes(key))
    }
  })
}

const invalidValues = {
  CMS_DATABASE_URL: ['invalid-private-value', 'https://db.test/private', 'postgresql:///private', 'postgresql://db.test', 'postgresql://db.test/private#secret', 'postgresql://cms:private%GG@db.test/editorial'],
  PORTAL_PUBLIC_URL: ['invalid-private-value', 'ftp://portal.test', 'https://private:secret@portal.test', 'https://portal.test/private', 'https://portal.test/?private=secret', 'https://portal.test/#private', 'https://portal.test/?', 'https://portal.test/#'],
  PORTAL_INTERNAL_URL: ['invalid-private-value', 'file:///private', 'http://private:secret@portal-api:3000', 'http://portal-api:3000/?private=secret', 'http://portal-api:3000/#private'],
  CMS_UPLOAD_DIR: ['relative/private', 'private', ''],
  PAYLOAD_SECRET: ['private-too-short', 'x'.repeat(31)],
  PAYLOAD_TO_PORTAL_SECRET: ['private-too-short', 'x'.repeat(31)],
  PORTAL_TO_PAYLOAD_SECRET: ['private-too-short', 'x'.repeat(31)],
}

for (const [key, values] of Object.entries(invalidValues)) {
  test(`rejeita ${key} inválida sem revelar o valor ou causa`, () => {
    for (const value of values) {
      assert.throws(() => readCmsEnvironment({ ...valid(), [key]: value }), error => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(key))
        if (value) assert.ok(!String(error).includes(value))
        assert.equal(error.cause, undefined)
        return true
      })
    }
  })
}

test('aceita postgres e opções TLS, e segredos com exatamente 32 caracteres', () => {
  const env = valid()
  env.CMS_DATABASE_URL = 'postgres://cms:fixture@db.test:5432/editorial?sslmode=require'
  env.PAYLOAD_SECRET = 'p'.repeat(32)
  env.PAYLOAD_TO_PORTAL_SECRET = 'a'.repeat(32)
  env.PORTAL_TO_PAYLOAD_SECRET = 'b'.repeat(32)
  assert.equal(readCmsEnvironment(env).databaseURL, env.CMS_DATABASE_URL)
})

test('exige segredos distintos para as duas direções', () => {
  const env = valid()
  env.PORTAL_TO_PAYLOAD_SECRET = env.PAYLOAD_TO_PORTAL_SECRET
  assert.throws(() => readCmsEnvironment(env), /PORTAL_TO_PAYLOAD_SECRET/)
})

test('build exige sinal explícito e usa somente entradas sintéticas', () => {
  assert.throws(() => readCmsConfigEnvironment({ NEXT_PHASE: 'phase-production-build' }), /CMS_DATABASE_URL/)
  const env = { CMS_BUILD_ONLY: 'true', NEXT_PHASE: 'phase-production-build' }
  assert.deepEqual(readCmsConfigEnvironment({ ...valid(), ...env }), readCmsConfigEnvironment(env))
  assert.equal(new URL(readCmsConfigEnvironment(env).databaseURL).hostname, 'cms-build.invalid')
})

test('runtime nunca aceita o sinal de build como fallback', () => {
  for (const phase of [undefined, 'phase-production-server', 'phase-development-server']) {
    assert.throws(() => readCmsConfigEnvironment({ ...valid(), CMS_BUILD_ONLY: 'true', NEXT_PHASE: phase }), /CMS_BUILD_ONLY/)
  }
  assert.throws(() => readCmsConfigEnvironment({ CMS_BUILD_ONLY: 'false', NEXT_PHASE: 'phase-production-build' }), /CMS_BUILD_ONLY/)
  assert.throws(() => readCmsConfigEnvironment({}), /CMS_DATABASE_URL/)
})

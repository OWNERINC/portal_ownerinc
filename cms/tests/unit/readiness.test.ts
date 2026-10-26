import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCmsSchemaCatalog, assertCmsStorageReady } from '../../src/config/readiness.js'
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
    'news_media', 'news_home', '_news_home_v', 'news_schedules', 'owner_news_mutation_head'].map(name => [name, name]))
  assert.doesNotThrow(() => assertCmsSchemaCatalog(complete))
  for (const name of Object.keys(complete)) assert.throws(() => assertCmsSchemaCatalog({ ...complete, [name]: null }), /cms_readiness_schema_incomplete/)
  assert.throws(() => assertCmsSchemaCatalog({ ...complete, extra: 'unsafe' }), /cms_readiness_schema_incomplete/)
})

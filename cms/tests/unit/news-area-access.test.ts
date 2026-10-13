import assert from 'node:assert/strict'
import test from 'node:test'
import { APIError, type PayloadRequest } from 'payload'
import { NewsArticles } from '../../src/collections/NewsArticles.js'
import { NewsAudit } from '../../src/collections/NewsAudit.js'
import { NewsMigrationItems } from '../../src/collections/NewsMigrationItems.js'
import { NewsMigrationRuns } from '../../src/collections/NewsMigrationRuns.js'
import { createNewsMedia } from '../../src/collections/NewsMedia.js'
import { NewsSchedules } from '../../src/collections/NewsSchedules.js'
import { LegacyNewsRevisions } from '../../src/collections/LegacyNewsRevisions.js'
import { NewsHome } from '../../src/globals/NewsHome.js'
import type { Authority } from '../../src/contracts/news.js'
import { createNewsAreaAccess, newsAreaReadAccess } from '../../src/auth/news-area-access.js'

const editor = { collection: 'portal-editors', portalUid: 'news-editor',
  portalActor: { uid: 'news-editor', email: 'editor@example.invalid', name: null, canManageNews: true } }
const request = (user: unknown = editor) => ({ user } as unknown as PayloadRequest)
const stub = (getAuthority: () => Promise<unknown>) => () => ({ getAuthority: getAuthority as () => Promise<Authority> })

test('native News read modes allow Payload and Payload-frozen, deny legacy/frozen, and fail closed on invalid or unavailable authority', async () => {
  for (const [mode, allowed] of [['payload', true], ['payload_frozen', true], ['legacy', false], ['frozen', false]] as const) {
    const access = createNewsAreaAccess(stub(async () => ({ mode, epoch: 1 })))
    assert.equal(await access.canRead(request()), allowed, `${mode} read policy`)
  }

  for (const load of [
    async () => ({ mode: 'unknown', epoch: 1 }),
    async () => { throw new Error('synthetic upstream address and credential') },
  ]) {
    const access = createNewsAreaAccess(stub(load))
    await assert.rejects(access.canRead(request()), error => {
      assert.ok(error instanceof APIError)
      assert.equal(error.status, 503)
      assert.equal(error.message, 'editorial_unavailable')
      assert.doesNotMatch(error.message, /synthetic upstream|credential/)
      return true
    })
  }
})

test('permission denial and mismatched projected identity do not call Portal authority', async () => {
  let clients = 0, calls = 0
  const access = createNewsAreaAccess(() => {
    clients++
    return { getAuthority: async () => { calls++; return { mode: 'payload', epoch: 1 } as Authority } }
  })
  assert.equal(await access.canRead(request(null)), false)
  assert.equal(await access.canRead(request({ ...editor, portalActor: { ...editor.portalActor, canManageNews: false } })), false)
  assert.equal(await access.canRead(request({ ...editor, portalUid: 'another-user' })), false)
  assert.equal(clients, 0)
  assert.equal(calls, 0)
})

test('authority is deduplicated only for the exact request and refreshed for a later request', async () => {
  let mode = 'payload', calls = 0
  const access = createNewsAreaAccess(stub(async () => { calls++; return { mode, epoch: calls } }))
  const first = request(), later = request()
  assert.equal(await access.canRead(first), true)
  mode = 'legacy'
  assert.equal(await access.canRead(first), true, 'the same request shares its authority promise')
  assert.equal(await access.canRead(later), false, 'a separate request gets a fresh authority value')
  assert.equal(calls, 2)
})

test('create presentation requires writable Payload mode while native reads include payload_frozen', async () => {
  for (const [mode, readable, creatable] of [['payload', true, true], ['payload_frozen', true, false],
    ['frozen', false, false], ['legacy', false, false]] as const) {
    const access = createNewsAreaAccess(stub(async () => ({ mode, epoch: 2 })))
    const req = request()
    assert.equal(await access.canRead(req), readable, `${mode} read`)
    assert.equal(await access.canCreate(req), creatable, `${mode} create presentation`)
  }
})

test('every native News collection/global read and both Versions stores use the dedicated gate', () => {
  for (const collection of [NewsArticles, NewsSchedules, NewsAudit, LegacyNewsRevisions, NewsMigrationRuns, NewsMigrationItems]) {
    assert.strictEqual(collection.access?.read, newsAreaReadAccess, `${collection.slug} read`)
  }
  assert.strictEqual(NewsHome.access?.read, newsAreaReadAccess, 'news-home read')
  assert.strictEqual(NewsArticles.access?.readVersions, newsAreaReadAccess, 'news-articles Versions')
  assert.strictEqual(NewsHome.access?.readVersions, newsAreaReadAccess, 'news-home Versions')

  const media = createNewsMedia({ uploadDir: 'unused-test-upload-dir' })
  assert.equal(typeof media.access?.read, 'function', 'native media collection has an async read gate')
})

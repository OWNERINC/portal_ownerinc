import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { APIError } from 'payload'
import { runScheduledRevision } from '../../src/publication/schedule.js'

const scheduleId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'

function fixture(t: TestContext, overrides: Record<string, unknown> = {}) {
  const state = {
    schedule: {
      id: scheduleId, target: 'news-articles', documentId, action: 'publish',
      state: 'pending', generation: 1, snapshot: { title: 'Pending', category: 'News', editorial: {}, body: [] },
      snapshotHash: 'a'.repeat(64), scheduledAt: '2000-01-01T00:00:00.000Z', actorUid: 'legacy-actor',
      versionId: '33333333-3333-4333-8333-333333333333', ...overrides,
    },
    statements: [] as string[], portalPaths: [] as string[], documentReads: 0, documentWrites: 0, jobQueues: 0,
  }
  const session = { execute: async (query?: unknown) => { state.statements.push(String(query)); return { rows: [] } } }
  const payload = {
    db: {
      sessions: { live: { db: session } },
      findOne: async () => { state.documentReads++; return { id: documentId, publicationGeneration: 1 } },
    },
    findByID: async () => state.schedule,
    create: async () => { state.documentWrites++; return { id: 'created' } },
    update: async () => { state.documentWrites++; return { id: documentId } },
    updateGlobal: async () => { state.documentWrites++; return {} },
    jobs: { queue: async () => { state.jobQueues++; return { id: 'job' } } },
  } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {}, user: null } as unknown as PayloadRequest

  const env = {
    CMS_DATABASE_URL: 'postgres://cms.invalid/synthetic',
    PAYLOAD_SECRET: 'synthetic-payload-secret-not-production-32chars',
    PORTAL_PUBLIC_URL: 'https://portal.invalid',
    PORTAL_INTERNAL_URL: 'https://portal-internal.invalid',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-payload-to-portal-not-production-32chars',
    PORTAL_TO_PAYLOAD_SECRET: 'synthetic-portal-to-payload-not-production-32chars',
    CMS_UPLOAD_DIR: 'C:\\synthetic-private-media',
  }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    state.portalPaths.push(url)
    if (url.endsWith('/authority')) return Response.json({ mode: 'payload', epoch: 4 })
    throw new Error('unexpected_portal_actor_check')
  })
  return { req, state }
}

test('suspended imported schedule is already processed without actor, document, write or enqueue work', async t => {
  const { req, state } = fixture(t, { state: 'suspended', actorUid: null, versionId: null })

  assert.deepEqual(await runScheduledRevision(req, { scheduleId }), { state: 'already_processed' })
  assert.deepEqual(state.portalPaths, ['https://portal-internal.invalid/api/internal/editorial/authority'])
  assert.equal(state.documentReads, 0)
  assert.equal(state.documentWrites, 0)
  assert.equal(state.jobQueues, 0)
  assert.equal(state.schedule.actorUid, null, 'unknown source actor remains unchanged')
  assert.equal(state.schedule.state, 'suspended')
})

test('pending schedule with missing actor or missing/malformed version fails before document reads/writes', async t => {
  for (const [overrides, expectedCode] of [
    [{ actorUid: null }, 'news_schedule_actor_unknown'],
    [{ versionId: null }, 'news_schedule_version_missing'],
    [{ versionId: 'not-a-uuid' }, 'news_schedule_version_invalid'],
  ] as const) {
    const { req, state } = fixture(t, overrides)
    await assert.rejects(runScheduledRevision(req, { scheduleId }), (error: unknown) =>
      error instanceof APIError && error.message === expectedCode)
    assert.deepEqual(state.portalPaths, ['https://portal-internal.invalid/api/internal/editorial/authority'])
    assert.equal(state.documentReads, 0)
    assert.equal(state.documentWrites, 0)
    assert.equal(state.jobQueues, 0)
    assert.equal(state.schedule.state, 'pending', 'malformed pending row remains untouched for operator review')
  }
})

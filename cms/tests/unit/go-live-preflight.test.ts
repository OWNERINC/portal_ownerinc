import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Payload, PayloadRequest } from 'payload'
import { queryGoLivePreflight } from '../../src/publication/go-live-preflight.js'

const zero = '0'.repeat(64)

function fixture() {
  const dialect = new PgDialect()
  const state = {
    authority: { mode: 'frozen', epoch: 7 } as { mode: string; epoch: number },
    publicationMode: 'manual' as string,
    head: { sequence: '0', chain_sha256: zero, coverage_version: 1, write_barrier: 'open',
      barrier_run_id: null, barrier_epoch: null, barrier_receipt_sha256: null } as Record<string, unknown>,
    counts: { articles: '0', media: '0', home_published: '0', schedules: '0' } as Record<string, unknown>,
    failCounts: false,
  }
  const execute = async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const { sql } = dialect.sqlToQuery(query)
    if (sql.includes('FROM owner_news_mutation_head')) return { rows: [{ ...state.head }] }
    if (sql.includes('COUNT(*)') && sql.includes('news_articles')) {
      if (state.failCounts) throw new Error('private database detail')
      return { rows: [{ ...state.counts }] }
    }
    return { rows: [] }
  }
  const payload = { db: { sessions: { live: { db: { execute } } } } } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {} } as unknown as PayloadRequest
  const run = () => queryGoLivePreflight(req, {
    publicationMode: state.publicationMode,
    getAuthority: async () => state.authority,
  })
  return { state, run }
}

test('empty manual frozen state returns only exact safe activation evidence', async () => {
  const { run } = fixture()
  assert.deepEqual(await run(), {
    ready: true,
    publicationMode: 'manual',
    authority: { mode: 'frozen', epoch: 7 },
    newsEmpty: true,
    mutation: { sequence: '0', chainSha256: zero, writeBarrier: 'open' },
    counts: { articles: 0, media: 0, homePublished: 0, schedules: 0 },
  })
})

test('preflight fails closed outside manual and frozen authority states', async () => {
  const { state, run } = fixture()
  state.publicationMode = 'scheduled'
  await assert.rejects(run(), /go_live_preflight_unavailable/)
  state.publicationMode = 'manual'
  for (const mode of ['legacy', 'payload', 'unknown']) {
    state.authority = { mode, epoch: 7 }
    await assert.rejects(run(), /go_live_preflight_unavailable/)
  }
  state.authority = { mode: 'frozen', epoch: 0 }
  await assert.rejects(run(), /go_live_preflight_unavailable/)
})

test('any article, draft, media, published home or schedule denies instead of claiming empty', async () => {
  for (const key of ['articles', 'media', 'home_published', 'schedules']) {
    const { state, run } = fixture()
    state.counts[key] = '1'
    await assert.rejects(run(), /go_live_preflight_not_empty/)
  }
})

test('missing, partial, mutated or closed ledger and database errors stay unavailable', async () => {
  const { state, run } = fixture()
  for (const change of [
    { coverage_version: 0 }, { sequence: '1' }, { sequence: '01' },
    { chain_sha256: 'a'.repeat(64) }, { write_barrier: 'sealed' },
  ]) {
    state.head = { sequence: '0', chain_sha256: zero, coverage_version: 1, write_barrier: 'open',
      barrier_run_id: null, barrier_epoch: null, barrier_receipt_sha256: null, ...change }
    await assert.rejects(run(), /go_live_preflight_unavailable|news_mutation_ledger_unavailable/)
  }
  state.head = {}
  await assert.rejects(run(), /news_mutation_ledger_unavailable/)
  state.head = { sequence: '0', chain_sha256: zero, coverage_version: 1, write_barrier: 'open',
    barrier_run_id: null, barrier_epoch: null, barrier_receipt_sha256: null }
  state.failCounts = true
  await assert.rejects(run(), /go_live_preflight_unavailable/)
})

test('count parser rejects malformed and unsafe database values', async () => {
  for (const value of [-1, 0, 1, '01', '-1', '9007199254740992', null]) {
    const { state, run } = fixture()
    state.counts.articles = value
    await assert.rejects(run(), /go_live_preflight_unavailable/)
  }
})

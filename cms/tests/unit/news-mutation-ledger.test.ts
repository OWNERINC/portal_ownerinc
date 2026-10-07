import assert from 'node:assert/strict'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { PgDialect } from 'drizzle-orm/pg-core'
import { assertNoNewsMutationsSince, readNewsMutationHead, NEWS_MUTATION_TABLES,
  type NewsMutationHead } from '../../src/publication/mutation-ledger'

const zero = '0'.repeat(64)
type FixtureHead = {
  sequence: string; chain_sha256: string; coverage_version: number; write_barrier: string
  barrier_run_id: string | null; barrier_epoch: number | null; barrier_receipt_sha256: string | null
}
function fixture(coverage = 1) {
  const dialect = new PgDialect()
  const state: { head: FixtureHead; events: { sequence: string }[]; calls: string[] } = { head: { sequence: '0', chain_sha256: zero, coverage_version: coverage, write_barrier: 'open',
    barrier_run_id: null, barrier_epoch: null, barrier_receipt_sha256: null },
    events: [] as { sequence: string }[], calls: [] as string[] }
  const execute = async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const { sql, params } = dialect.sqlToQuery(query); state.calls.push(sql)
    if (sql.includes('FROM owner_news_mutation_head')) return { rows: [{ ...state.head }] }
    if (sql.includes('FROM owner_news_mutation_events')) return { rows: state.events.filter(row => BigInt(row.sequence) > BigInt(params[0] as string)) }
    return { rows: [] }
  }
  const payload = { db: { sessions: { live: { db: { execute } } } } } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {} } as unknown as PayloadRequest
  return { req, state }
}

test('ledger reader uses caller session/advisory lock; bigint stays exact; runtime needs SELECT only', async () => {
  const { req, state } = fixture()
  state.head.sequence = '9007199254740993'
  const result = await readNewsMutationHead(req)
  assert.equal(result.sequence, '9007199254740993')
  assert.match(state.calls[1], /7194030/)
  assert.match(state.calls[2], /FROM owner_news_mutation_head/)
  assert.doesNotMatch(state.calls[2], /FOR UPDATE/)
  assert.equal(state.calls.some(sql => /^(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE)/.test(sql)), false)
  assert.equal(req.transactionID, 'live')
  assert.ok(NEWS_MUTATION_TABLES.includes('payload_jobs'))
  assert.ok(NEWS_MUTATION_TABLES.includes('payload_jobs_log'))
  assert.ok(NEWS_MUTATION_TABLES.includes('_news_articles_v_blocks_list_items'))
})

test('comparison refuses incomplete coverage and detects edit-undo/native finalization independently of content hashes', async () => {
  const { req, state } = fixture(0)
  const baseline: NewsMutationHead = { sequence: '0', chainSha256: zero, coverageVersion: 1, writeBarrier: 'open',
    barrierRunId: null, barrierEpoch: null, barrierReceiptSha256: null }
  await assert.rejects(assertNoNewsMutationsSince(req, baseline), /news_mutation_coverage_incomplete/)
  state.head.coverage_version = 1
  assert.equal((await assertNoNewsMutationsSince(req, baseline)).sequence, baseline.sequence)
  state.head.sequence = '2'; state.head.chain_sha256 = 'a'.repeat(64)
  state.events.push({ sequence: '1' }, { sequence: '2' })
  await assert.rejects(assertNoNewsMutationsSince(req, baseline), /news_mutations_after_baseline/)
  state.head.sequence = '0'; state.head.chain_sha256 = zero
  await assert.rejects(assertNoNewsMutationsSince(req, baseline), /news_mutations_after_baseline/)
})

test('missing session, malformed head and caller hash without covered baseline deny', async () => {
  const { req, state } = fixture()
  req.transactionID = 'missing'
  await assert.rejects(readNewsMutationHead(req), /cms_transaction_required/)
  assert.equal(state.calls.length, 0)
  req.transactionID = 'live'; state.head.sequence = '9223372036854775808'
  await assert.rejects(readNewsMutationHead(req), /news_mutation_ledger_unavailable/)
  state.head.sequence = '0'; state.head.write_barrier = 'unknown'
  await assert.rejects(readNewsMutationHead(req), /news_mutation_ledger_unavailable/)
  state.head.write_barrier = 'sealed'; state.head.barrier_run_id = '22222222-2222-4222-8222-222222222222'
  await assert.rejects(readNewsMutationHead(req), /news_mutation_ledger_unavailable/)
  await assert.rejects(assertNoNewsMutationsSince(req, { sequence: '0', chainSha256: zero } as NewsMutationHead), /news_mutation_coverage_incomplete/)
})

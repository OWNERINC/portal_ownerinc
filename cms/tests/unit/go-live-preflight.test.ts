import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Payload, PayloadRequest } from 'payload'
import { queryGoLivePreflight } from '../../src/publication/go-live-preflight.js'

const zero = '0'.repeat(64)
const deadline = () => new Date(Date.now() + 30 * 60 * 1000).toISOString()

function fixture() {
  const dialect = new PgDialect()
  const state = {
    authority: { mode: 'legacy', epoch: 7, activationObserved: false, manifestSha256: null, sealSha256: null,
      releaseDigest: null, imageDigest: null, activationRequestId: null } as Record<string, unknown>,
    publicationMode: 'manual' as string,
    head: { sequence: '0', chain_sha256: zero, coverage_version: 1, write_barrier: 'open',
      barrier_run_id: null, barrier_epoch: null, barrier_receipt_sha256: null } as Record<string, unknown>,
    counts: { articles: '0', media: '0', home_published: '0', schedules: '0', migrations: true,
      catalog: true, grants: true, readiness: true } as Record<string, unknown>,
    failCounts: false,
    missingSealed: false,
    sealed: [{ id: '11111111-1111-4111-8111-111111111111', manifest_sha256: 'a'.repeat(64),
      authority_epoch: '7', drain_receipt_sha256: 'b'.repeat(64),
      reconciliation_sequence: '0', reconciliation_chain_sha256: zero, reconciliation_sha256: 'c'.repeat(64),
      destination_fingerprint: 'd'.repeat(64), sealed_sequence: '0', sealed_chain_sha256: zero,
      sealed_at: '2026-10-27T12:00:00.000Z', activation_epoch: '8', unresolved_exceptions: [] }] as Record<string, unknown>[],
  }
  const execute = async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
    const { sql } = dialect.sqlToQuery(query)
    if (sql.includes('FROM owner_news_mutation_head')) return { rows: [{ ...state.head }] }
    if (sql.includes('COUNT(*)') && sql.includes('news_articles')) {
      if (state.failCounts) throw new Error('private database detail')
      return { rows: [{ ...state.counts }] }
    }
    if (sql.includes('FROM news_migration_runs')) return { rows: state.missingSealed ? [] : state.sealed.map(row => ({ ...row })) }
    return { rows: [] }
  }
  const payload = { db: { sessions: { live: { db: { execute } } } } } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {} } as unknown as PayloadRequest
  const run = () => queryGoLivePreflight(req, { mode: 'legacy', epoch: 7, requestId: 'request-7', deadline: deadline() }, {
    publicationMode: state.publicationMode, getAuthority: async () => state.authority })
  const runManifest = (manifest = 'a'.repeat(64)) => {
    const sealed = state.sealed[0]
    state.head = { sequence: String(sealed.sealed_sequence), chain_sha256: String(sealed.sealed_chain_sha256),
      coverage_version: 1, write_barrier: 'sealed', barrier_run_id: String(sealed.id), barrier_epoch: 7,
      barrier_receipt_sha256: String(sealed.drain_receipt_sha256) }
    state.authority = { mode: 'frozen', epoch: 7, activationObserved: false, manifestSha256: null,
      sealSha256: null, releaseDigest: null, imageDigest: null, activationRequestId: null }
    const sealMaterial = { runId: sealed.id, manifestSha256: manifest, authorityEpoch: sealed.authority_epoch,
      drainReceiptSha256: sealed.drain_receipt_sha256, reconciliationSequence: sealed.reconciliation_sequence,
      reconciliationChainSha256: sealed.reconciliation_chain_sha256, reconciliationSha256: sealed.reconciliation_sha256,
      destinationFingerprint: sealed.destination_fingerprint, sealedSequence: sealed.sealed_sequence,
      sealedChainSha256: sealed.sealed_chain_sha256, sealedAt: sealed.sealed_at, activationEpoch: sealed.activation_epoch }
    const sealSha256 = createHash('sha256').update(JSON.stringify(sealMaterial)).digest('hex')
    return queryGoLivePreflight(req, { mode: 'frozen', epoch: 7, requestId: 'request-7', deadline: deadline(),
      manifestSha256: manifest, sealSha256, releaseDigest: `sha256:${'d'.repeat(64)}`,
      imageDigest: `sha256:${'e'.repeat(64)}` }, {
      publicationMode: state.publicationMode, getAuthority: async () => state.authority })
  }
  const runResume = (overrides: { authority?: Record<string, unknown>; head?: Record<string, unknown> } = {}) => {
    const sealed = state.sealed[0], manifestSha256 = String(sealed.manifest_sha256)
    const sealMaterial = { runId: sealed.id, manifestSha256, authorityEpoch: sealed.authority_epoch,
      drainReceiptSha256: sealed.drain_receipt_sha256, reconciliationSequence: sealed.reconciliation_sequence,
      reconciliationChainSha256: sealed.reconciliation_chain_sha256, reconciliationSha256: sealed.reconciliation_sha256,
      destinationFingerprint: sealed.destination_fingerprint, sealedSequence: sealed.sealed_sequence,
      sealedChainSha256: sealed.sealed_chain_sha256, sealedAt: sealed.sealed_at, activationEpoch: sealed.activation_epoch }
    const sealSha256 = createHash('sha256').update(JSON.stringify(sealMaterial)).digest('hex')
    const releaseDigest = `sha256:${'d'.repeat(64)}`, imageDigest = `sha256:${'e'.repeat(64)}`
    state.authority = { mode: 'payload_frozen', epoch: 10, activationObserved: false, manifestSha256,
      sealSha256, releaseDigest, imageDigest, activationRequestId: 'original-activation', ...overrides.authority }
    state.head = { sequence: '14', chain_sha256: 'f'.repeat(64), coverage_version: 1, write_barrier: 'sealed',
      barrier_run_id: String(sealed.id), barrier_epoch: 7, barrier_receipt_sha256: String(sealed.drain_receipt_sha256),
      ...overrides.head }
    state.counts.articles = '2'
    return queryGoLivePreflight(req, { mode: 'payload_frozen', epoch: 10, requestId: 'resume-10', deadline: deadline(),
      manifestSha256, sealSha256, releaseDigest, imageDigest }, {
      publicationMode: state.publicationMode, getAuthority: async () => state.authority })
  }
  return { state, run, runManifest, runResume }
}

test('empty manual legacy state returns only exact safe activation evidence', async () => {
  const { run } = fixture()
  const result = await run()
  assert.deepEqual(result, {
    ready: true,
    publicationMode: 'manual',
    request: { id: 'request-7', deadline: result.request.deadline },
    authority: { mode: 'legacy', epoch: 7 },
    activation: null,
    newsEmpty: true,
    mutation: { sequence: '0', chainSha256: zero, writeBarrier: 'open', barrierRunId: null,
      barrierEpoch: null, barrierReceiptSha256: null },
    counts: { articles: 0, media: 0, homePublished: 0, schedules: 0 },
    runtime: { worker: false, schedules: false, autosave: false, versions: false },
    database: { migrations: true, catalog: true, grants: true, readiness: true },
    migration: null,
  })
})

test('sealed migration evidence is database-derived, manifest-bound and exact', async () => {
  const { state, runManifest } = fixture()
  const result = await runManifest()
  assert.equal(result.migration?.manifestSha256, 'a'.repeat(64))
  assert.equal(result.migration?.authorityEpoch, 7)
  assert.equal(result.migration?.drainReceiptSha256, 'b'.repeat(64))
  assert.match(result.migration?.sealSha256 || '', /^[0-9a-f]{64}$/u)
  state.sealed.push({ ...state.sealed[0] })
  await assert.rejects(runManifest(), /go_live_preflight_unavailable/)
})

test('preflight requires the exact requested authority and fails closed outside manual mode', async () => {
  const { state, run } = fixture()
  state.publicationMode = 'scheduled'
  await assert.rejects(run(), /go_live_preflight_unavailable/)
  state.publicationMode = 'manual'
  state.authority = { mode: 'legacy', epoch: 7, activationObserved: false, manifestSha256: null,
    sealSha256: null, releaseDigest: null, imageDigest: null, activationRequestId: null }
  assert.equal((await run()).authority.mode, 'legacy')
  for (const mode of ['payload', 'payload_frozen', 'unknown']) {
    state.authority = { ...state.authority, mode }
    await assert.rejects(run(), /go_live_preflight_unavailable/)
  }
  state.authority = { ...state.authority, mode: 'legacy', epoch: 0 }
  await assert.rejects(run(), /go_live_preflight_unavailable/)
})

test('any article, draft, media, published home or schedule denies instead of claiming empty', async () => {
  for (const key of ['articles', 'media', 'home_published', 'schedules']) {
    const { state, run, runManifest } = fixture()
    state.counts[key] = '1'
    await assert.rejects(run(), /go_live_preflight_not_empty/)
    await assert.rejects(runManifest(), /go_live_preflight_not_empty/)
  }
})

test('first cutover rejects missing and mismatched manifest proofs', async () => {
  const { state, runManifest } = fixture()
  await assert.rejects(runManifest('f'.repeat(64)), /go_live_preflight_unavailable/)
  state.missingSealed = true
  await assert.rejects(runManifest(), /go_live_preflight_unavailable/)
})

test('resume accepts fresh nonempty frozen content only with exact existing activation and safe ledger', async () => {
  const { state, runResume } = fixture()
  const result = await runResume()
  assert.equal(result.authority.mode, 'payload_frozen')
  assert.equal(result.newsEmpty, false)
  assert.equal(result.request.id, 'resume-10')
  assert.equal(result.activation?.requestId, 'original-activation')
  await assert.rejects(runResume({ authority: { imageDigest: `sha256:${'9'.repeat(64)}` } }), /go_live_preflight_unavailable/)
  const unsafe = fixture()
  await assert.rejects(unsafe.runResume({ head: { coverage_version: 0 } }), /news_mutation_ledger_unavailable|go_live_preflight_unavailable/)
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

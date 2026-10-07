import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import path from 'node:path'
import type { Payload, PayloadRequest } from 'payload'
import { PgDialect } from 'drizzle-orm/pg-core'
import { assertCmsWriteAuthority, assertFrozenPreparationActor, assertPreparationIdentity, withPreparationAuthority } from '../../src/publication/authority'
import { legacyNewsImportContext } from '../../src/news/validation'
import { sealNewsPreparation } from '../../src/publication/seal'

const identity = { runId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), expectedEpoch: 2 }
const actor = { uid: 'synthetic-editor', email: 'synthetic@example.invalid', name: null, canManageNews: true }
function fixture(t: TestContext) {
  const env = { CMS_DATABASE_URL: 'postgres://cms.invalid/synthetic', PAYLOAD_SECRET: 'synthetic-payload-secret-not-production',
    PORTAL_PUBLIC_URL: 'https://portal.invalid', PORTAL_INTERNAL_URL: 'https://portal-internal.invalid',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-payload-to-portal-not-production', PORTAL_TO_PAYLOAD_SECRET: 'synthetic-portal-to-payload-not-production',
    CMS_UPLOAD_DIR: path.resolve('synthetic-unused-storage') }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]; process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const state = { mode: 'frozen', epoch: 2, denied: false, calls: [] as string[],
    run: { id: identity.runId, manifest_sha256: identity.manifestSha256, authority_epoch: 2,
      source_fingerprint: 'b'.repeat(64), progress_state: 'preparing', admission_state: 'open', commit_outcome: 'acknowledged' } }
  const session = { execute: async (_query?: unknown): Promise<{ rows: Record<string, unknown>[] }> => { state.calls.push('sql'); return { rows: [state.run] } } }
  const payload = { db: { sessions: { live: { db: session } } } } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {}, user: { id: identity.runId, collection: 'portal-editors',
    portalUid: actor.uid, portalActor: actor, portalExpiresAt: '2000-01-01T00:00:00.000Z' } } as unknown as PayloadRequest
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.ok(state.calls.length >= 2, 'lock precedes Portal calls')
    const authority = input.endsWith('/authority'); state.calls.push(authority ? 'authority' : 'actor')
    if (authority) return Response.json({ mode: state.mode, epoch: state.epoch })
    assert.equal(JSON.parse(init.body as string).uid, actor.uid)
    return state.denied ? Response.json({ reason: 'editorial_permission_denied' }, { status: 403 }) : Response.json({ actor })
  })
  return { req, state, session }
}

test('private bound scope uses real durable reader and rechecks each write; expiry exemption only in scope', async t => {
  const { req, state } = fixture(t)
  await withPreparationAuthority(req, identity, async same => {
    assert.equal(same, req)
    req.context = { ...legacyNewsImportContext }
    assert.deepEqual(await assertCmsWriteAuthority(req), { mode: 'frozen', epoch: 2 })
    const stagedBinding = await assertPreparationIdentity(req)
    assert.deepEqual(stagedBinding, identity)
    assert.equal(Object.isFrozen(stagedBinding), true)
    assert.notEqual(stagedBinding.runId, '22222222-2222-4222-8222-222222222222', 'media from runB cannot match scopeA')
    state.run.admission_state = 'sealed'
    await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_run_closed/)
  })
  assert.equal(req.transactionID, 'live')
  await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_context_required/)
  await assert.rejects(assertPreparationIdentity(req), /migration_preparation_context_required/)
})

test('HTTP-shaped context, legacy symbol alone and cloned req cannot carry capability', async t => {
  const { req } = fixture(t)
  req.context = { preparation: identity, legacyImport: true }
  await assert.rejects(assertCmsWriteAuthority(req), /editorial_session_expired/)
  req.context = { ...legacyNewsImportContext }
  await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_context_required/)
  await withPreparationAuthority(req, identity, async () => {
    await assert.rejects(assertCmsWriteAuthority({ ...req } as PayloadRequest), /migration_preparation_context_required/)
    await assert.rejects(withPreparationAuthority(req, identity, async () => undefined), /migration_preparation_scope_active/)
  })
})

test('mint refuses wrong Portal mode/epoch, revoked actor and mismatched or closed durable run', async t => {
  const { req, state } = fixture(t)
  for (const mode of ['legacy', 'payload', 'payload_frozen']) {
    state.mode = mode
    await assert.rejects(withPreparationAuthority(req, identity, async () => assert.fail('must not run')), /cms_preparation_authority_conflict/)
  }
  state.mode = 'frozen'; state.epoch = 3
  await assert.rejects(withPreparationAuthority(req, identity, async () => undefined), /cms_preparation_authority_conflict/)
  state.epoch = 2; state.denied = true
  await assert.rejects(withPreparationAuthority(req, identity, async () => undefined), /editorial_permission_denied/)
  state.denied = false
  for (const [key, value] of [['manifest_sha256', 'c'.repeat(64)], ['commit_outcome', 'unknown'], ['progress_state', 'conflict'], ['admission_state', 'sealed']] as const) {
    const previous = state.run[key]; state.run[key] = value
    await assert.rejects(withPreparationAuthority(req, identity, async () => assert.fail('must not run')), /migration_preparation_run_closed/)
    state.run[key] = previous
  }
})

test('scope immutable binding, tx/actor replacement and failed callback cannot extend authorization', async t => {
  const { req, state } = fixture(t)
  const supplied = { ...identity }
  const failure = new Error('caller failed')
  await assert.rejects(withPreparationAuthority(req, supplied, async () => {
    supplied.expectedEpoch = 99
    assert.deepEqual(await assertCmsWriteAuthority(req), { mode: 'frozen', epoch: 2 })
    state.epoch = 3
    await assert.rejects(assertCmsWriteAuthority(req), /cms_authority_read_only/)
    state.epoch = 2
    const previousUser = req.user
    req.user = { ...req.user, portalUid: 'other', portalActor: { ...actor, uid: 'other' } } as typeof req.user
    await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_scope_mismatch/)
    req.user = previousUser
    req.transactionID = 'missing'
    await assert.rejects(assertCmsWriteAuthority(req), /cms_transaction_required/)
    req.transactionID = 'live'
    throw failure
  }), error => error === failure)
  req.context = { ...legacyNewsImportContext }
  await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_context_required/)
})

test('bootstrap actor guard does not mint a content capability or tolerate a lost transaction', async t => {
  const { req, state } = fixture(t)
  assert.deepEqual(await assertFrozenPreparationActor(req, 2), { authority: { mode: 'frozen', epoch: 2 }, actorUid: actor.uid })
  req.context = { ...legacyNewsImportContext }
  await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_context_required/)
  await assert.rejects(withPreparationAuthority(req, identity, async () => { req.transactionID = 'missing' }), /cms_transaction_required/)
  req.transactionID = 'live'
  await assert.rejects(assertCmsWriteAuthority(req), /migration_preparation_context_required/)
  state.epoch = 2147483647
  await assert.rejects(assertFrozenPreparationActor(req, state.epoch), /cms_preparation_authority_conflict/)
})

test('seal fails closed without operational verifier and delegates atomic barrier to migration-owned function', async t => {
  const { req, state, session } = fixture(t)
  await assert.rejects(sealNewsPreparation(req, identity), /news_native_drain_verifier_required/)
  assert.equal(state.calls.length, 0)
  const dialect = new PgDialect()
  const zero = '0'.repeat(64)
  const head = { sequence: '0', chain_sha256: zero, coverage_version: 1, write_barrier: 'open',
    barrier_run_id: null as string | null, barrier_epoch: null as number | null, barrier_receipt_sha256: null as string | null }
  Object.assign(state.run, { progress_state: 'reconciled', destination_fingerprint: 'c'.repeat(64),
    reconciliation_sha256: 'd'.repeat(64), reconciliation_sequence: '0', reconciliation_chain_sha256: zero,
    unresolved_exceptions: [] })
  let sealCalls = 0
  session.execute = async query => {
    state.calls.push('sql')
    const rendered = dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql
    if (rendered.includes('FROM news_migration_runs')) return { rows: [state.run] }
    if (rendered.includes('FROM owner_news_mutation_head')) return { rows: [head] }
    if (rendered.includes('owner_news_seal_run(')) {
      sealCalls++; head.sequence = '1'; head.chain_sha256 = 'e'.repeat(64); head.write_barrier = 'sealed'
      head.barrier_run_id = identity.runId; head.barrier_epoch = identity.expectedEpoch; head.barrier_receipt_sha256 = 'a'.repeat(64)
      return { rows: [{ id: identity.runId }] }
    }
    assert.doesNotMatch(rendered, /^(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT)/)
    return { rows: [] }
  }
  const receipt = { version: 1 as const, runId: identity.runId, authorityEpoch: 2, manifestSha256: identity.manifestSha256,
    operationalBarrierId: '22222222-2222-4222-8222-222222222222', runtimeDigest: `sha256:${'f'.repeat(64)}`, receiptSha256: 'a'.repeat(64) }
  await assert.rejects(sealNewsPreparation(req, identity, async () => ({ ...receipt, authorityEpoch: 3 })), /news_native_drain_unverified/)
  assert.equal(sealCalls, 0)
  head.coverage_version = 0
  await assert.rejects(sealNewsPreparation(req, identity, async () => receipt), /news_mutation_coverage_incomplete/)
  head.coverage_version = 1
  Object.assign(state.run, { unresolved_exceptions: ['unknown_actor'] })
  await assert.rejects(sealNewsPreparation(req, identity, async () => receipt), /migration_seal_not_reconciled/)
  Object.assign(state.run, { unresolved_exceptions: [] })
  Object.assign(state.run, { authority_epoch: '2' }) // pg NUMERIC decoder returns exact decimal text
  const sealed = await sealNewsPreparation(req, identity, async () => receipt)
  assert.equal(sealed.baseline.writeBarrier, 'sealed')
  assert.equal(sealed.baseline.sequence, '1')
  assert.equal(sealed.activationEpoch, 3)
  assert.equal(sealCalls, 1)
  assert.equal(req.transactionID, 'live')
})

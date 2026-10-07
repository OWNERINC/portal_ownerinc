import { sql } from '@payloadcms/db-postgres'
import { APIError, type PayloadRequest } from 'payload'
import type { PreparationRunIdentity } from '../migration/preparation-run'
import { isSha256, isUUID } from '../migration/identity'
import { assertFrozenPreparationActor } from './authority'
import { requireCmsTransaction } from './transaction'
import { assertNoNewsMutationsSince, readNewsMutationHead, type NewsMutationHead } from './mutation-ledger'
import type { VerifyNativeDrain } from './control-schema'

const refuse = (reason: string): never => { throw new APIError(reason, 409, undefined, true) }

/** Trusted control composition, no browser endpoint/default verifier. The
 * integrator must provide a LIVE operational-barrier verifier, never a callback
 * that just parses a receipt supplied by CLI. Without it this fails closed.
 * Caller owns CMS tx and operational lock for the whole prepare/activate phase. */
export async function sealNewsPreparation(req: PayloadRequest, identity: PreparationRunIdentity,
  verifyNativeDrain?: VerifyNativeDrain) {
  if (typeof verifyNativeDrain !== 'function') refuse('news_native_drain_verifier_required')
  const { actorUid } = await assertFrozenPreparationActor(req, identity.expectedEpoch)
  if (!isUUID(identity.runId) || !isSha256(identity.manifestSha256)) refuse('migration_seal_identity_invalid')
  const db = await requireCmsTransaction(req.payload, req)
  const result = await db.execute(sql`SELECT id, manifest_sha256, authority_epoch, admission_state, progress_state,
    commit_outcome, source_fingerprint, destination_fingerprint, reconciliation_sha256,
    reconciliation_sequence::text AS reconciliation_sequence, reconciliation_chain_sha256, unresolved_exceptions
    FROM news_migration_runs WHERE id=${identity.runId}::uuid FOR UPDATE`)
  const row = result.rows[0]
  if (!row || row.id !== identity.runId || row.manifest_sha256 !== identity.manifestSha256
    || (row.authority_epoch !== identity.expectedEpoch && row.authority_epoch !== String(identity.expectedEpoch))
    || row.admission_state !== 'open' || row.progress_state !== 'reconciled' || row.commit_outcome !== 'acknowledged'
    || !isSha256(row.source_fingerprint) || !isSha256(row.destination_fingerprint) || !isSha256(row.reconciliation_sha256)
    || !Array.isArray(row.unresolved_exceptions) || row.unresolved_exceptions.length) refuse('migration_seal_not_reconciled')
  const baseline: NewsMutationHead = { sequence: row.reconciliation_sequence as string,
    chainSha256: row.reconciliation_chain_sha256 as string, coverageVersion: 1, writeBarrier: 'open',
    barrierRunId: null, barrierEpoch: null, barrierReceiptSha256: null }
  await assertNoNewsMutationsSince(req, baseline)
  const receipt = await verifyNativeDrain!({ ...identity })
  if (!receipt || receipt.version !== 1 || receipt.runId !== identity.runId || receipt.authorityEpoch !== identity.expectedEpoch
    || receipt.manifestSha256 !== identity.manifestSha256 || !isUUID(receipt.operationalBarrierId)
    || !/^sha256:[0-9a-f]{64}$/u.test(receipt.runtimeDigest) || !isSha256(receipt.receiptSha256)) refuse('news_native_drain_unverified')
  // External check may have taken time; recheck Portal/actor and SAME live CMS
  // session, never keep a Portal tx open or substitute another adapter session.
  await assertFrozenPreparationActor(req, identity.expectedEpoch)
  if (db !== await requireCmsTransaction(req.payload, req)) refuse('migration_seal_transaction_changed')
  await assertNoNewsMutationsSince(req, baseline)
  // Migration-owned SECURITY DEFINER function: updates run (trigger logs it),
  // closes DB write barrier and stores the resulting baseline. No hook-based
  // append: adapter.updateJobs bypasses hooks and MUST be captured by triggers.
  const updated = await db.execute(sql`SELECT * FROM owner_news_seal_run(
    ${identity.runId}::uuid,${identity.manifestSha256},${identity.expectedEpoch},
    ${baseline.sequence}::bigint,${baseline.chainSha256},${receipt.receiptSha256},${actorUid})`)
  if (updated.rows[0]?.id !== identity.runId) refuse('migration_seal_conflict')
  const head = await readNewsMutationHead(req)
  if (head.coverageVersion !== 1 || head.writeBarrier !== 'sealed'
    || head.barrierRunId !== identity.runId || head.barrierEpoch !== identity.expectedEpoch
    || head.barrierReceiptSha256 !== receipt.receiptSha256) refuse('migration_seal_barrier_unverified')
  return { runId: identity.runId, manifestSha256: identity.manifestSha256, epoch: identity.expectedEpoch,
    activationEpoch: identity.expectedEpoch + 1, baseline: head, drainReceiptSha256: receipt.receiptSha256 }
}

import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'
import { lockCmsReferences, requireCmsTransaction } from '../publication/transaction'
import { assertImportBinding, isSha256 } from './identity'

export type PreparationRunIdentity = { runId: string; manifestSha256: string; expectedEpoch: number }
export type PreparationRun = PreparationRunIdentity & { sourceFingerprint: string; progressState: 'preparing' }

/** pg's default NUMERIC parser returns text. Accept exact positive integers only,
 * including an all-zero decimal scale, without Number's coercion/rounding rules. */
function storedEpoch(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !/^[1-9]\d*(?:\.0+)?$/u.test(value)) return null
  const integer = value.split('.')[0]
  if (integer.length > 16 || BigInt(integer) > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(integer)
}

/** Durable admission check consumed by Task12 AFTER it verifies Portal frozen +
 * epoch + requesting actor. This function grants no authority on its own and
 * never opens, commits or retries a transaction. Table comes from the run config.
 * Run bootstrap and sealing are Task12's protected operations on this same row. */
export async function assertPreparationRun(req: PayloadRequest, identity: PreparationRunIdentity): Promise<PreparationRun> {
  assertImportBinding({ runId: identity.runId, manifestSha256: identity.manifestSha256, authorityEpoch: identity.expectedEpoch })
  await lockCmsReferences(req.payload, req)
  const db = await requireCmsTransaction(req.payload, req)
  const result = await db.execute(sql`SELECT id, manifest_sha256, source_fingerprint, authority_epoch,
    progress_state, admission_state, commit_outcome FROM news_migration_runs
    WHERE id = ${identity.runId}::uuid FOR UPDATE`)
  const row = result.rows[0]
  if (!row || row.id !== identity.runId || row.manifest_sha256 !== identity.manifestSha256 ||
    storedEpoch(row.authority_epoch) !== identity.expectedEpoch || row.progress_state !== 'preparing' ||
    row.admission_state !== 'open' || row.commit_outcome !== 'acknowledged' || !isSha256(row.source_fingerprint)) {
    throw new Error('migration_preparation_run_closed')
  }
  return { ...identity, sourceFingerprint: row.source_fingerprint, progressState: 'preparing' }
}

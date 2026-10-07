import { APIError, type PayloadRequest } from 'payload'
import { assertFrozenPreparationActor } from '../publication/authority'
import { requireCmsTransaction } from '../publication/transaction'
import { isSha256, isUUID } from './identity'

export type PreparationBootstrapIdentity = { runId: string; manifestSha256: string; expectedEpoch: number }
type BootstrapScope = { identity: Readonly<PreparationBootstrapIdentity>; session: unknown; actorUid: string }
const scopes = new WeakMap<PayloadRequest, BootstrapScope>()

/** Initial-run-only exact-request capability. It is independent of data/context
 * flags and exists only while the caller-owned transaction is live. */
export async function withPreparationBootstrap<T>(req: PayloadRequest, identity: PreparationBootstrapIdentity,
  operation: (req: PayloadRequest, actorUid: string) => Promise<T>): Promise<T> {
  if (scopes.has(req) || !isUUID(identity.runId) || !isSha256(identity.manifestSha256) ||
    !Number.isSafeInteger(identity.expectedEpoch) || identity.expectedEpoch < 1) {
    throw new APIError('migration_preparation_bootstrap_invalid', 409, undefined, true)
  }
  const { actorUid } = await assertFrozenPreparationActor(req, identity.expectedEpoch)
  const session = await requireCmsTransaction(req.payload, req)
  const binding = Object.freeze({ ...identity })
  scopes.set(req, { identity: binding, session, actorUid })
  try {
    const result = await operation(req, actorUid)
    if (scopes.get(req)?.session !== await requireCmsTransaction(req.payload, req)) {
      throw new APIError('migration_preparation_bootstrap_mismatch', 403, undefined, true)
    }
    return result
  } finally { scopes.delete(req) }
}

/** Collection-hook guard. Rechecks fresh Portal authority/actor and validates
 * immutable create fields; copying context or request data cannot mint scope. */
export async function assertPreparationBootstrap(req: PayloadRequest, data: Record<string, unknown>) {
  const scope = scopes.get(req)
  if (!scope || scope.session !== await requireCmsTransaction(req.payload, req)) {
    throw new APIError('migration_preparation_bootstrap_required', 403, undefined, true)
  }
  const identity = scope.identity
  if (data.id !== identity.runId || data.manifestSha256 !== identity.manifestSha256 ||
    data.authorityEpoch !== identity.expectedEpoch || data.commitOutcome !== 'acknowledged' ||
    data.admissionState !== 'open' || data.progressState !== 'preparing' ||
    typeof data.sourceInstance !== 'string' || typeof data.sourceFingerprint !== 'string') {
    throw new APIError('migration_preparation_bootstrap_mismatch', 409, undefined, true)
  }
  const { actorUid } = await assertFrozenPreparationActor(req, identity.expectedEpoch)
  if (actorUid !== scope.actorUid || scope.session !== await requireCmsTransaction(req.payload, req)) {
    throw new APIError('migration_preparation_bootstrap_mismatch', 403, undefined, true)
  }
  return identity
}

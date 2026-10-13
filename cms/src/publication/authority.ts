import { APIError, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'
import { canWriteNews, type PortalRuntimeUser } from '../auth/access'
import { createPortalClient } from '../auth/portal-client'
import { readCmsEnvironment } from '../config/environment'
import { isLegacyNewsImport } from '../news/validation'
import { lockCmsReferences, requireCmsTransaction } from './transaction'
import { workerActor } from './internal'
import { assertPreparationRun, type PreparationRunIdentity } from '../migration/preparation-run'

type PreparationCapability = { identity: Readonly<PreparationRunIdentity>; session: unknown; actorUid: string }
const preparations = new WeakMap<PayloadRequest, PreparationCapability>()

/** Bootstrap guard for thread3's run-row creation in an already live CMS tx.
 * This grants no article/media write capability and returns no HTTP token. */
export async function assertFrozenPreparationActor(req: PayloadRequest, expectedEpoch: number) {
  await lockCmsReferences(req.payload, req)
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || expectedEpoch >= 2147483647) {
    throw new APIError('cms_preparation_authority_conflict', 409, undefined, true)
  }
  if (!canWriteNews({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
  const actorUid = (req.user as PortalRuntimeUser).portalActor!.uid
  const client = createPortalClient(readCmsEnvironment(process.env))
  const authority = await client.getAuthority()
  if (authority.mode !== 'frozen' || authority.epoch !== expectedEpoch) {
    throw new APIError('cms_preparation_authority_conflict', 409, undefined, true)
  }
  await client.checkPortalActor(actorUid)
  await requireCmsTransaction(req.payload, req)
  return { authority, actorUid }
}

/** Trusted CLI/Local API scope, never a context field or an HTTP endpoint.
 * Caller must start its transaction first and propagate this EXACT req. */
export async function withPreparationAuthority<T>(req: PayloadRequest, identity: PreparationRunIdentity,
  operation: (req: PayloadRequest) => Promise<T>): Promise<T> {
  if (preparations.has(req)) throw new APIError('migration_preparation_scope_active', 409, undefined, true)
  const binding = Object.freeze({ runId: identity.runId, manifestSha256: identity.manifestSha256, expectedEpoch: identity.expectedEpoch })
  const { actorUid } = await assertFrozenPreparationActor(req, binding.expectedEpoch)
  await assertPreparationRun(req, binding)
  const session = await requireCmsTransaction(req.payload, req)
  // Recheck after awaits: concurrent scopes on one request are unsupported.
  if (preparations.has(req)) throw new APIError('migration_preparation_scope_active', 409, undefined, true)
  preparations.set(req, { identity: binding, session, actorUid })
  try {
    const result = await operation(req)
    if (session !== await requireCmsTransaction(req.payload, req)) throw new APIError('migration_preparation_scope_mismatch', 403, undefined, true)
    return result
  }
  finally { preparations.delete(req) }
}

/** Exact live capability binding for staged-media / suspended-agenda consumers.
 * Always rechecks authority, actor and durable run; a copied context is not enough. */
export async function assertPreparationIdentity(req: PayloadRequest): Promise<Readonly<PreparationRunIdentity>> {
  if (!preparations.has(req)) throw new APIError('migration_preparation_context_required', 403, undefined, true)
  await assertCmsWriteAuthority(req)
  const preparation = preparations.get(req)
  if (!preparation || preparation.session !== await requireCmsTransaction(req.payload, req)) {
    throw new APIError('migration_preparation_scope_mismatch', 403, undefined, true)
  }
  return Object.freeze({ ...preparation.identity })
}

export async function assertCmsWriteAuthority(req: PayloadRequest) {
  await lockCmsReferences(req.payload, req)
  const preparation = preparations.get(req)
  const preparationImport = Boolean(preparation)
  if (preparation && (preparation.session !== await requireCmsTransaction(req.payload, req)
    || preparation.actorUid !== (req.user as PortalRuntimeUser | null)?.portalActor?.uid)) {
    throw new APIError('migration_preparation_scope_mismatch', 403, undefined, true)
  }
  if (isLegacyNewsImport(req.context) && !preparation) {
    throw new APIError('migration_preparation_context_required', 403, undefined, true)
  }
  const requestingWorker = workerActor(req)
  if (preparation && requestingWorker) throw new APIError('migration_preparation_scope_mismatch', 403, undefined, true)
  if (!requestingWorker && !canWriteNews({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
  // Only the private worker/import capabilities are session-independent. Browser
  // requests must retain verified, canonical expiry metadata AFTER the lock wait.
  const assertInteractiveSession = () => {
    if (requestingWorker || preparationImport) return
    const expiresAt = (req.user as PortalRuntimeUser).portalExpiresAt
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) ||
      new Date(expiresAt).toISOString() !== expiresAt || Date.parse(expiresAt) <= Date.now()) {
      throw new APIError('editorial_session_expired', 403, undefined, true)
    }
  }
  assertInteractiveSession()
  const client = createPortalClient(readCmsEnvironment(process.env))
  const authority = await client.getAuthority()
  if (preparation ? authority.mode !== 'frozen' || authority.epoch !== preparation.identity.expectedEpoch : authority.mode !== 'payload') {
    throw new APIError('cms_authority_read_only', 409, undefined, true)
  }
  await client.checkPortalActor(requestingWorker || (req.user as PortalRuntimeUser).portalActor!.uid)
  if (preparation) await assertPreparationRun(req, preparation.identity)
  assertInteractiveSession()
  return authority
}

export const protectArticleReferences: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
  await assertCmsWriteAuthority(req)
  // Payload bulk updates run document promises concurrently on a shared session.
  // A failed sibling may roll it back while another falls back to the pool adapter.
  if (operation === 'update' && (!('id' in args) || !args.id)) {
    throw new APIError('news_update_requires_single_id', 400, undefined, true)
  }
  // Native delete removes ALL versions. Until historical archival is installed, retain them.
  if (operation === 'delete') throw new APIError('news_history_retention_required', 409, undefined, true)
}

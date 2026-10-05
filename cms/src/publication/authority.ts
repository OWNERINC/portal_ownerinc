import { APIError, type CollectionBeforeOperationHook, type PayloadRequest } from 'payload'
import { canManageNews, type PortalRuntimeUser } from '../auth/access'
import { createPortalClient } from '../auth/portal-client'
import { readCmsEnvironment } from '../config/environment'
import { isLegacyNewsImport } from '../news/validation'
import { lockCmsReferences } from './transaction'
import { workerActor } from './internal'

export async function assertCmsWriteAuthority(req: PayloadRequest) {
  await lockCmsReferences(req.payload, req)
  const preparationImport = isLegacyNewsImport(req.context)
  const requestingWorker = workerActor(req)
  if (!requestingWorker && !canManageNews({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
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
  // Capability is in-process only. A frozen cutover still refuses preparation writes.
  if (authority.mode !== 'payload' && !(preparationImport && authority.mode === 'legacy')) {
    throw new APIError('cms_authority_read_only', 409, undefined, true)
  }
  await client.checkPortalActor(requestingWorker || (req.user as PortalRuntimeUser).portalActor!.uid)
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

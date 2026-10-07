import type { Access, Payload, PayloadRequest } from 'payload'
import { isVerifiedNewsActor, type PortalRuntimeUser } from './access'
import { canReadNewsArea } from './news-area-access'

export const LOCKED_DOCUMENTS_SLUG = 'payload-locked-documents'
const lockOperations = ['create', 'read', 'update', 'delete'] as const

type NewsReadGate = (req: PayloadRequest) => Promise<boolean>

/** Keep Payload's native lock UI for a live News session, not a general admin actor. */
export function createNativeNewsLockAccess(readNews: NewsReadGate = canReadNewsArea): Access {
  return async ({ req }) => {
    const user = req.user as PortalRuntimeUser | null
    if (user?.collection !== 'portal-editors' || !isVerifiedNewsActor(user)) return false
    return readNews(req)
  }
}

/**
 * Payload 3.90.2 generates this internal collection after sanitizing user config.
 * Its supported onInit hook runs after the collection map is built and before the
 * runtime accepts requests; the map and config list share this exact object.
 */
export function scopePayloadLockAccess(payload: Payload, access: Access = createNativeNewsLockAccess()): void {
  const runtimeCollection = payload.collections[LOCKED_DOCUMENTS_SLUG]
  const config = runtimeCollection?.config
  if (!config || config.slug !== LOCKED_DOCUMENTS_SLUG || config.lockDocuments !== false ||
    !payload.config.collections.includes(config) || !config.access ||
    lockOperations.some(operation => typeof config.access[operation] !== 'function')) {
    throw new Error('Payload native lock collection configuration is not supported')
  }

  // Payload's defaultAccess remains in force for valid News actors. Other Portal
  // admins cannot list, inspect, create, update, or delete native News locks.
  config.access = {
    ...config.access,
    create: access,
    read: access,
    update: access,
    delete: access,
  }
}

import type { Access, Payload, PayloadRequest, Where } from 'payload'
import { isVerifiedNewsActor, type PortalRuntimeUser } from './access'
import { canReadNewsArea } from './news-area-access'

export const LOCKED_DOCUMENTS_SLUG = 'payload-locked-documents'
const lockOperations = ['create', 'read', 'update', 'delete'] as const

type NewsReadGate = (req: PayloadRequest) => Promise<boolean>

function noLockRowsWhere(): Where {
  // Payload 3.90.2's DashboardView always calls find on locked global rows,
  // even for a custom dashboard. A false read result makes that required find
  // throw 403. The conjunction cannot match any single lock document ID.
  return { and: [
    { id: { equals: '00000000-0000-0000-0000-000000000001' } },
    { id: { equals: '00000000-0000-0000-0000-000000000002' } },
  ] }
}

/** Keep native lock mutations exclusive to a current strict News actor. */
export function createNativeNewsLockAccess(readNews: NewsReadGate = canReadNewsArea): Access {
  return async ({ req }) => {
    const user = req.user as PortalRuntimeUser | null
    if (user?.collection !== 'portal-editors' || !isVerifiedNewsActor(user)) return false
    return readNews(req)
  }
}

/**
 * DashboardView's built-in global-lock query must succeed before a custom home
 * component renders. Return an empty result scope instead of a blanket 403 for
 * actors without current native-News authority; no lock rows or editor identity
 * can match this predicate. Real reads remain available to a current v1 News actor.
 */
export function createNativeNewsLockReadAccess(readNews: NewsReadGate = canReadNewsArea): Access {
  return async ({ req }) => {
    const user = req.user as PortalRuntimeUser | null
    if (user?.collection !== 'portal-editors' || !isVerifiedNewsActor(user)) return noLockRowsWhere()
    return await readNews(req) ? true : noLockRowsWhere()
  }
}

/**
 * Payload 3.90.2 generates this internal collection after sanitizing user config.
 * Its supported onInit hook runs after the collection map is built and before the
 * runtime accepts requests; the map and config list share this exact object.
 */
export function scopePayloadLockAccess(
  payload: Payload,
  mutationAccess: Access = createNativeNewsLockAccess(),
  readAccess: Access = createNativeNewsLockReadAccess(),
): void {
  const runtimeCollection = payload.collections[LOCKED_DOCUMENTS_SLUG]
  const config = runtimeCollection?.config
  if (!config || config.slug !== LOCKED_DOCUMENTS_SLUG || config.lockDocuments !== false ||
    !payload.config.collections.includes(config) || !config.access ||
    lockOperations.some(operation => typeof config.access[operation] !== 'function')) {
    throw new Error('Payload native lock collection configuration is not supported')
  }

  // Payload's defaultAccess remains in force for valid News actors. Other Portal
  // admins can complete Payload's required lock query, but receive no matching
  // rows; they still cannot create, update, or delete native News locks.
  config.access = {
    ...config.access,
    create: mutationAccess,
    read: readAccess,
    update: mutationAccess,
    delete: mutationAccess,
  }
}

import type { PayloadRequest } from 'payload'
import { assertPortalDependency, type PortalRuntimeUser } from './access'
import { parseAdminActor, validAdminExpiry } from '../contracts/admin'

/**
 * Portal Pages require the live V2 knowledge capability and matching Portal UID.
 * Owner News authority and its legacy editor actor do not grant page access.
 */
export function canManagePortalPages({ req }: { req: PayloadRequest }): boolean {
  assertPortalDependency(req)
  const user = req.user as PortalRuntimeUser | null
  if (user?.collection !== 'portal-editors' || typeof user.portalUid !== 'string' ||
    !user.portalUid.trim() || user.portalUid.length > 128) return false
  const actor = parseAdminActor(user.adminActor)
  return actor?.capabilities.manageKnowledge === true && actor.uid === user.portalUid &&
    validAdminExpiry(user.adminExpiresAt) && Date.parse(user.adminExpiresAt) > Date.now()
}

export const portalPageEditorAccess = ({ req }: { req: PayloadRequest }) => canManagePortalPages({ req })

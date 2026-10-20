import { APIError, type PayloadRequest } from 'payload'
import { assertPortalDependency } from '../auth/access'
import { canManagePortalPages } from '../auth/portal-pages-access'
import { PortalAuthError } from '../auth/portal-client'
import { parseAdminActor, validAdminExpiry } from '../contracts/admin'

export type PortalPageReadActor = {
  uid: string
  email: string
  name: string | null
  canManageKnowledge: true
}

type EditorialUser = NonNullable<PayloadRequest['user']> & {
  portalUid?: unknown
  adminActor?: unknown
  adminExpiresAt?: string
}

const forbidden = () => new APIError('editorial_permission_denied', 403, undefined, true)

function userOf(req: PayloadRequest): EditorialUser | null {
  return req.user as EditorialUser | null
}

/** New editorial endpoints require the revalidated V2 knowledge actor, not the News grant. */
export function requirePortalPageEditor(req: PayloadRequest): PortalPageReadActor {
  assertPortalDependency(req)
  const user = userOf(req)
  if (!user) throw new PortalAuthError(401)
  if (user.collection !== 'portal-editors' || typeof user.portalUid !== 'string' ||
    !user.portalUid.trim() || user.portalUid.length > 128) throw forbidden()
  const actor = parseAdminActor(user.adminActor)
  if (!actor || actor.capabilities.manageKnowledge !== true || actor.uid !== user.portalUid) throw forbidden()
  if (!validAdminExpiry(user.adminExpiresAt) || Date.parse(user.adminExpiresAt) <= Date.now()) {
    throw new PortalAuthError(401)
  }
  if (!canManagePortalPages({ req })) throw forbidden()
  // No identity is synthesized from the Payload user or request body.
  if (!actor.email || !(actor.name === null || typeof actor.name === 'string')) throw forbidden()
  return { uid: actor.uid, email: actor.email, name: actor.name, canManageKnowledge: true }
}

/** Upload operations use the same live V2 knowledge authority as page editing. */
export function requirePortalPageUploadUID(req: PayloadRequest): string {
  assertPortalDependency(req)
  const user = userOf(req)
  if (!user || user.collection !== 'portal-editors' || typeof user.portalUid !== 'string' || !user.portalUid.trim()) {
    throw forbidden()
  }
  const actor = parseAdminActor(user.adminActor)
  if (!actor || actor.capabilities.manageKnowledge !== true || actor.uid !== user.portalUid) throw forbidden()
  if (!validAdminExpiry(user.adminExpiresAt) || Date.parse(user.adminExpiresAt) <= Date.now()) throw new PortalAuthError(401)
  if (!canManagePortalPages({ req })) throw forbidden()
  return actor.uid
}

export function assertEditorialReadHeaders(headers: Headers): void {
  if (headers.get('sec-fetch-site') === 'cross-site') throw new PortalAuthError(403)
}

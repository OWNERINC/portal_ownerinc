import { APIError, type PayloadRequest } from 'payload'
import { isVerifiedNewsActor } from '../auth/access'
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
  portalActor?: { uid: string; canManageNews: boolean }
  portalExpiresAt?: string
  adminActor?: unknown
  adminExpiresAt?: string
}

const forbidden = () => new APIError('editorial_permission_denied', 403, undefined, true)

function userOf(req: PayloadRequest): EditorialUser | null {
  return req.user as EditorialUser | null
}

/** New editorial endpoints require the revalidated V2 knowledge actor, not the News grant. */
export function requirePortalPageEditor(req: PayloadRequest): PortalPageReadActor {
  const user = userOf(req)
  if (!user) throw new PortalAuthError(401)
  if (user.collection !== 'portal-editors' || typeof user.portalUid !== 'string' ||
    !user.portalUid.trim() || user.portalUid.length > 128) throw forbidden()
  const actor = parseAdminActor(user.adminActor)
  if (!actor || actor.capabilities.manageKnowledge !== true || actor.uid !== user.portalUid ||
    !canManagePortalPages({ req })) throw forbidden()
  if (!validAdminExpiry(user.adminExpiresAt) || Date.parse(user.adminExpiresAt) <= Date.now()) {
    throw new PortalAuthError(401)
  }
  // No identity is synthesized from the Payload user or request body.
  if (!actor.email || !(actor.name === null || typeof actor.name === 'string')) throw forbidden()
  return { uid: actor.uid, email: actor.email, name: actor.name, canManageKnowledge: true }
}

/** Retains both approved upload authorities while sharing UID/expiry checks. */
export function requirePortalPageUploadUID(req: PayloadRequest): string {
  if (!canManagePortalPages({ req })) throw forbidden()
  const user = userOf(req)
  if (!user || user.collection !== 'portal-editors' || typeof user.portalUid !== 'string' || !user.portalUid.trim()) {
    throw forbidden()
  }
  const actor = parseAdminActor(user.adminActor)
  if (actor?.capabilities.manageKnowledge === true && actor.uid === user.portalUid) {
    if (!Number.isFinite(Date.parse(user.adminExpiresAt || '')) || Date.parse(user.adminExpiresAt || '') <= Date.now()) {
      throw new PortalAuthError(401)
    }
    return actor.uid
  }
  if (isVerifiedNewsActor(user as never)) {
    if (!Number.isFinite(Date.parse(user.portalExpiresAt || '')) || Date.parse(user.portalExpiresAt || '') <= Date.now()) {
      throw new PortalAuthError(401)
    }
    return user.portalActor!.uid
  }
  throw forbidden()
}

export function assertEditorialReadHeaders(headers: Headers): void {
  if (headers.get('sec-fetch-site') === 'cross-site') throw new PortalAuthError(403)
}

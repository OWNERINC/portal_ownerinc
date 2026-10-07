import { APIError, type Access, type PayloadRequest } from 'payload'
import { parseAdminActor, type VerifiedAdminActor } from '../contracts/admin'
import type { VerifiedPortalActor } from '../contracts/news'
import { AUTH_STATUS_HEADER, AUTH_REASON_HEADER } from './portal-strategy'

export type PortalRuntimeUser = NonNullable<PayloadRequest['user']> & {
  portalActor?: VerifiedPortalActor
  portalExpiresAt?: string
  adminActor?: VerifiedAdminActor
  adminExpiresAt?: string
}
export function assertPortalDependency(req: PayloadRequest) {
  if (req.responseHeaders?.get(AUTH_STATUS_HEADER) === '503') {
    throw new APIError(req.responseHeaders.get(AUTH_REASON_HEADER) || 'editorial_unavailable', 503, undefined, true)
  }
}
export const canManageNews = ({ req }: { req: PayloadRequest }): boolean => {
  assertPortalDependency(req)
  const user = req.user as PortalRuntimeUser | null
  if (user?.collection !== 'portal-editors') return false
  if (isVerifiedNewsActor(user)) return true
  const adminActor = parseAdminActor(user.adminActor)
  return adminActor?.capabilities.manageKnowledge === true && adminActor.uid === user.portalUid
}

/** Mutations continue to require the original strict News service actor. */
export const canWriteNews = ({ req }: { req: PayloadRequest }): boolean => {
  assertPortalDependency(req)
  const user = req.user as PortalRuntimeUser | null
  return user?.collection === 'portal-editors' && isVerifiedNewsActor(user)
}

export function isVerifiedNewsActor(user: PortalRuntimeUser | null | undefined): user is PortalRuntimeUser & { portalActor: VerifiedPortalActor } {
  return user?.portalActor?.canManageNews === true && typeof user.portalActor.uid === 'string' &&
    user.portalActor.uid.length > 0 && user.portalActor.uid === user.portalUid
}

export function canAccessPortalAdmin({ req }: { req: PayloadRequest }): boolean {
  assertPortalDependency(req)
  const user = req.user as PortalRuntimeUser | null
  if (user?.collection !== 'portal-editors') return false
  if (isVerifiedNewsActor(user)) return true
  const actor = parseAdminActor(user.adminActor)
  return actor !== null && actor.uid === user.portalUid
}

export const denyEditorMutation: Access = () => false
export const readOwnEditor: Access = args => canAccessPortalAdmin(args) ? { id: { equals: args.req.user!.id } } : false

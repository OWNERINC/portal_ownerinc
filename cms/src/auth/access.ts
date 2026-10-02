import { APIError, type Access, type PayloadRequest } from 'payload'
import type { VerifiedPortalActor } from '../contracts/news'
import { AUTH_STATUS_HEADER, AUTH_REASON_HEADER } from './portal-strategy'

export type PortalRuntimeUser = NonNullable<PayloadRequest['user']> & {
  portalActor?: VerifiedPortalActor
  portalExpiresAt?: string
}
export function assertPortalDependency(req: PayloadRequest) {
  if (req.responseHeaders?.get(AUTH_STATUS_HEADER) === '503') {
    throw new APIError(req.responseHeaders.get(AUTH_REASON_HEADER) || 'editorial_unavailable', 503, undefined, true)
  }
}
export const canManageNews = ({ req }: { req: PayloadRequest }): boolean => {
  assertPortalDependency(req)
  const user = req.user as PortalRuntimeUser | null
  return user?.collection === 'portal-editors' && user.portalActor?.canManageNews === true && user.portalActor.uid === user.portalUid
}
export const denyEditorMutation: Access = () => false
export const readOwnEditor: Access = args => canManageNews(args) ? { id: { equals: args.req.user!.id } } : false

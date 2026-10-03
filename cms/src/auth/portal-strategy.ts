import type { AuthStrategy, Payload } from 'payload'
import { PortalAuthError, type PortalResolution } from './portal-client'
import { readEditorialCookie } from './cookie'

export const AUTH_STATUS_HEADER = 'x-ownerinc-auth-status'
export const AUTH_REASON_HEADER = 'x-ownerinc-auth-reason'

function projectionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  // The pinned Drizzle adapter turns 23505 into Payload ValidationError.
  const candidate = error as { code?: string; cause?: { code?: string }; name?: string; data?: { errors?: { path?: string }[] } }
  return candidate.code === '23505' || candidate.cause?.code === '23505' ||
    (candidate.name === 'ValidationError' && candidate.data?.errors?.some(item => item.path === 'portalUid' || item.path === 'portal_uid') === true)
}
async function projectEditor(payload: Payload, actor: PortalResolution['actor']) {
  const find = () => payload.find({ collection: 'portal-editors', where: { portalUid: { equals: actor.uid } }, limit: 1, overrideAccess: true })
  const existing = (await find()).docs[0]
  if (existing) return existing
  try {
    return await payload.create({ collection: 'portal-editors', overrideAccess: true,
      data: { portalUid: actor.uid, email: actor.email, displayName: actor.name } })
  } catch (error) {
    if (!projectionConflict(error)) throw error
    const winner = (await find()).docs[0]
    if (!winner) throw error
    return winner
  }
}
export function createPortalStrategy({ cookieName, resolve }: {
  cookieName: string; resolve: (cookie: string) => Promise<PortalResolution>
}): AuthStrategy {
  return {
    name: 'portal',
    async authenticate({ headers, payload }) {
      try {
        const cookie = readEditorialCookie(headers, cookieName)
        if (!cookie) return { user: null }
        const { actor, expiresAt } = await resolve(cookie)
        if (actor.canManageNews !== true) throw new PortalAuthError(403)
        const editor = await projectEditor(payload, actor)
        // Runtime-only metadata is never read from or written to the identity projection.
        return { user: { ...editor, collection: 'portal-editors', portalActor: actor, portalExpiresAt: expiresAt } }
      } catch (error) {
        const safe = error instanceof PortalAuthError ? error : new PortalAuthError(503)
        // executeAuthStrategies catches thrown errors. Return a marker for the native boundary instead.
        return { user: null, responseHeaders: new Headers({ [AUTH_STATUS_HEADER]: String(safe.status), [AUTH_REASON_HEADER]: safe.reason }) }
      }
    },
  }
}

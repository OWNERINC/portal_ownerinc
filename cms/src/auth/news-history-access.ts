import { APIError, type Access, type PayloadRequest } from 'payload'
import { canWriteNews, type PortalRuntimeUser } from './access'
import { editorialCookieSettings, readEditorialCookie } from './cookie'
import { createPortalClient, PortalAuthError } from './portal-client'
import { readCmsEnvironment } from '../config/environment'
import { configuredEditorialProfile, editorialBoundary, type EditorialProfile } from '../config/editorial-profile'

/** No projection/cache can establish that a cookie is still live after a lock wait. */
export async function assertCurrentNewsSession(req: PayloadRequest) {
  if (!canWriteNews({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
  const user = req.user as PortalRuntimeUser
  const expiry = user.portalExpiresAt
  if (!expiry || !Number.isFinite(Date.parse(expiry)) || new Date(expiry).toISOString() !== expiry || Date.parse(expiry) <= Date.now()) {
    throw new PortalAuthError(401)
  }
  const environment = readCmsEnvironment(process.env)
  const cookie = readEditorialCookie(req.headers, editorialCookieSettings(environment.portalPublicURL).name)
  if (!cookie) throw new PortalAuthError(401)
  const client = createPortalClient(environment)
  const resolved = await client.resolvePortalEditor(cookie)
  if (resolved.actor.uid !== user.portalUid || resolved.actor.uid !== user.portalActor?.uid) throw new PortalAuthError(403)
  await client.checkPortalActor(resolved.actor.uid)
  if (Date.parse(expiry) <= Date.now() || Date.parse(resolved.expiresAt) <= Date.now()) throw new PortalAuthError(401)
  return { actor: resolved.actor, client }
}

export async function assertNewsHistoryAccess(req: PayloadRequest) {
  if (configuredEditorialProfile(req.payload.config) !== 'editorial-v1') throw new APIError('news_versions_unavailable', 403, undefined, true)
  const { client } = await assertCurrentNewsSession(req)
  const authority = await client.getAuthority()
  const activation = /^[0-9a-f]{64}$/u.test(authority.manifestSha256 || '') && /^[0-9a-f]{64}$/u.test(authority.sealSha256 || '') &&
    /^sha256:[0-9a-f]{64}$/u.test(authority.releaseDigest || '') && /^sha256:[0-9a-f]{64}$/u.test(authority.imageDigest || '') &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(authority.activationRequestId || '')
  if (!(authority.mode === 'payload' && authority.activationObserved === true || authority.mode === 'payload_frozen' && activation)) {
    throw new APIError('news_versions_unavailable', 403, undefined, true)
  }
  req.responseHeaders ??= new Headers()
  req.responseHeaders.set('Cache-Control', 'private,no-store')
  return authority
}

export function createNewsHistoryAccess(profile: EditorialProfile): Access {
  return editorialBoundary(async ({ req }) => {
    if (profile === 'held-v1') return false
    try { await assertNewsHistoryAccess(req); return true }
    catch (error) {
      // Native permission-map construction visits News even for other-area admins.
      // A denied capability is false; dependency failures must still propagate.
      if ((error instanceof APIError || error instanceof PortalAuthError) && [401, 403].includes(error.status)) return false
      throw error
    }
  }, profile, 'history')
}

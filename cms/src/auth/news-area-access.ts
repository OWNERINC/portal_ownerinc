import { APIError, type Access, type PayloadRequest } from 'payload'
import type { Authority } from '../contracts/news'
import { readCmsEnvironment } from '../config/environment'
import { createPortalClient } from './portal-client'
import { canManageNews } from './access'

type AuthorityClientFactory = () => { getAuthority(): Promise<unknown> }
export type NewsAreaReadGate = (req: PayloadRequest) => Promise<boolean>

const validModes = new Set(['legacy', 'frozen', 'payload', 'payload_frozen'])
const unavailable = () => new APIError('editorial_unavailable', 503, undefined, true)

function validAuthority(value: unknown): value is Authority {
  if (!value || typeof value !== 'object') return false
  const authority = value as Record<string, unknown>
  return typeof authority.mode === 'string' && validModes.has(authority.mode) &&
    Number.isSafeInteger(authority.epoch) && Number(authority.epoch) >= 1
}

/** Native News read policy. The only cache is an in-flight authority resolution
 * keyed by the exact Payload request; a later request always re-reads Portal. */
export function createNewsAreaAccess(clientFactory: AuthorityClientFactory = () =>
  createPortalClient(readCmsEnvironment(process.env))) {
  const authorities = new WeakMap<PayloadRequest, Promise<Authority>>()

  function authorityFor(req: PayloadRequest): Promise<Authority> {
    const current = authorities.get(req)
    if (current) return current

    const pending = Promise.resolve().then(async () => {
      const authority = await clientFactory().getAuthority()
      if (!validAuthority(authority)) throw unavailable()
      return authority
    }).catch(() => { throw unavailable() })
    authorities.set(req, pending)
    return pending
  }

  async function authorizedAuthority(req: PayloadRequest): Promise<Authority | null> {
    // Do not call Portal (or parse service configuration) for a non-News actor.
    if (!canManageNews({ req })) return null
    return authorityFor(req)
  }

  const canRead: NewsAreaReadGate = async req => {
    const authority = await authorizedAuthority(req)
    return authority !== null && (authority.mode === 'payload' || authority.mode === 'payload_frozen')
  }

  /** Presentation-only create-view check. Actual writes still use
   * assertCmsWriteAuthority, including its transaction lock and post-lock checks. */
  const canCreate: NewsAreaReadGate = async req => {
    const authority = await authorizedAuthority(req)
    return authority?.mode === 'payload'
  }

  const access: Access = ({ req }) => canRead(req)
  return { canRead, canCreate, access }
}

const newsAreaAccess = createNewsAreaAccess()
export const canReadNewsArea = newsAreaAccess.canRead
export const canCreateNewsArticle = newsAreaAccess.canCreate
export const newsAreaReadAccess = newsAreaAccess.access

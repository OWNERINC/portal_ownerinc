import { readCmsEnvironment, type CmsEnvironment } from '../config/environment'
import type { Authority, VerifiedPortalActor } from '../contracts/news'

export class PortalAuthError extends Error {
  readonly reason: string
  constructor(readonly status: 401 | 403 | 503) {
    const reason = status === 401 ? 'editorial_session_invalid' : status === 403 ? 'editorial_permission_denied' : 'editorial_unavailable'
    super(reason)
    this.reason = reason
  }
}
export type PortalResolution = { actor: VerifiedPortalActor; expiresAt: string }
function actor(value: unknown): VerifiedPortalActor {
  if (!value || typeof value !== 'object') throw new PortalAuthError(503)
  const input = value as Record<string, unknown>
  if (typeof input.uid !== 'string' || !input.uid || input.uid.length > 128 ||
    typeof input.email !== 'string' || !input.email || input.email.length > 320 ||
    !(input.name === null || typeof input.name === 'string') || typeof input.canManageNews !== 'boolean') throw new PortalAuthError(503)
  if (input.canManageNews !== true) throw new PortalAuthError(403)
  return { uid: input.uid, email: input.email, name: input.name, canManageNews: true }
}
export function createPortalClient(
  environment: Pick<CmsEnvironment, 'portalInternalURL' | 'payloadToPortalSecret'>,
  fetchImpl: typeof fetch = fetch,
) {
  async function request(path: string, body?: Record<string, string>): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetchImpl(`${environment.portalInternalURL}/api/internal/editorial${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${environment.payloadToPortalSecret}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      })
      // A bridge credential/configuration failure must not be reported as session revocation.
      if (response.status === 401 || response.status === 403) {
        const denied = await response.json() as { reason?: string }
        if (response.status === 401 && denied.reason === 'editorial_session_invalid') throw new PortalAuthError(401)
        if (response.status === 403 && ['email-not-verified', 'pending-approval', 'account-inactive', 'account-disabled',
          'enable-pending', 'editorial_permission_denied'].includes(denied.reason || '')) throw new PortalAuthError(403)
        throw new PortalAuthError(503)
      }
      if (!response.ok) throw new PortalAuthError(503)
      return response.status === 204 ? undefined : await response.json()
    } catch (error) {
      // Do not retain causes, request URLs, headers, tokens or upstream error bodies.
      throw error instanceof PortalAuthError ? error : new PortalAuthError(503)
    } finally { clearTimeout(timeout) }
  }
  return {
    async resolvePortalEditor(cookie: string): Promise<PortalResolution> {
      const result = await request('/session/resolve', { cookie }) as Partial<PortalResolution> | null
      if (!result || typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)) ||
        new Date(result.expiresAt).toISOString() !== result.expiresAt) throw new PortalAuthError(503)
      if (Date.parse(result.expiresAt) <= Date.now()) throw new PortalAuthError(401)
      return { actor: actor(result.actor), expiresAt: result.expiresAt }
    },
    async revokePortalEditor(cookie: string): Promise<void> { await request('/session/revoke', { cookie }) },
    async checkPortalActor(uid: string): Promise<VerifiedPortalActor> {
      const result = await request('/actor/check', { uid }) as { actor?: unknown } | null
      const verified = actor(result?.actor)
      if (verified.uid !== uid) throw new PortalAuthError(503)
      return verified
    },
    async getAuthority(): Promise<Authority> {
      const value = await request('/authority') as Partial<Authority> | null
      if (!value || !['legacy', 'frozen', 'payload', 'payload_frozen'].includes(value.mode || '') ||
        !Number.isSafeInteger(value.epoch) || value.epoch! < 1) throw new PortalAuthError(503)
      return { mode: value.mode!, epoch: value.epoch! }
    },
  }
}
export async function resolvePortalEditor(cookie: string): Promise<PortalResolution> {
  return createPortalClient(readCmsEnvironment(process.env)).resolvePortalEditor(cookie)
}

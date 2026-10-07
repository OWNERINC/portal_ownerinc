import { PortalAuthError } from './portal-client'
import { assertEditorialOrigin } from './cookie'
import { AUTH_STATUS_HEADER, AUTH_REASON_HEADER } from './portal-strategy'
import { hasNewsServiceAccess } from './service-access'

type Handler<T> = (request: Request, args: T) => Promise<Response>
export function withEditorialBoundary<T>(handler: Handler<T>, origin: string): Handler<T> {
  return async (request, args) => {
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !hasNewsServiceAccess(request)) assertEditorialOrigin(request.headers, origin)
      const response = await handler(request, args)
      // Payload appends response headers from every failed strategy. With the
      // strict News resolver followed by the generic v2 resolver, the same
      // marker can therefore arrive as "401, 401" / "403, 403". Never let that
      // malformed-as-a-scalar value turn an auth failure into an anonymous 200.
      const rawStatuses = response.headers.get(AUTH_STATUS_HEADER)
      if (rawStatuses !== null) {
        const statuses = rawStatuses.split(',').map(value => value.trim())
        const validStatuses = new Set(['401', '403', '503'])
        if (!statuses.length || statuses.some(status => !validStatuses.has(status))) throw new PortalAuthError(503)
        const status = statuses.includes('503') ? 503 : statuses.includes('401') ? 401 : 403
        throw new PortalAuthError(status)
      }
      response.headers.delete(AUTH_STATUS_HEADER)
      response.headers.delete(AUTH_REASON_HEADER)
      response.headers.set('Cache-Control', 'no-store')
      return response
    } catch (error) {
      const safe = error instanceof PortalAuthError ? error : new PortalAuthError(503)
      return Response.json({ error: safe.reason }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } })
    }
  }
}

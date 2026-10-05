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
      // The native framework catches strategy exceptions; preserve the Portal's failure class.
      const status = Number(response.headers.get(AUTH_STATUS_HEADER))
      if ([401, 403, 503].includes(status)) throw new PortalAuthError(status as 401 | 403 | 503)
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

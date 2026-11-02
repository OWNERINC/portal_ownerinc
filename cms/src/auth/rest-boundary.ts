import { PortalAuthError } from './portal-client'
import { assertEditorialOrigin } from './cookie'
import { AUTH_STATUS_HEADER, AUTH_REASON_HEADER } from './portal-strategy'
import { hasNewsServiceAccess } from './service-access'
import { APIError } from 'payload'
import { assertRawNewsDraftControls } from '../publication/draft-intent'

type Handler<T> = (request: Request, args: T) => Promise<Response>
// resolvedPath is the server adapter's dispatch path, never a client query hint.
export function withEditorialBoundary<T>(handler: Handler<T>, origin: string, resolvedPath?: string): Handler<T> {
  return async (request, args) => {
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !hasNewsServiceAccess(request)) assertEditorialOrigin(request.headers, origin)
      if (['POST', 'PATCH', 'PUT'].includes(request.method) &&
        /^\/editorial\/api\/(?:news-articles(?:\/|$)|globals\/news-home(?:\/|$))/u.test(resolvedPath ?? new URL(request.url).pathname)) {
        assertRawNewsDraftControls(request)
      }
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
      response.headers.set('Cache-Control', 'private,no-store')
      return response
    } catch (error) {
      if (error instanceof APIError && error.status === 400 && error.message === 'news_draft_intent_invalid') {
        return Response.json({ error: 'news_draft_intent_invalid' }, { status: 400, headers: { 'Cache-Control': 'private,no-store' } })
      }
      const safe = error instanceof PortalAuthError ? error : new PortalAuthError(503)
      return Response.json({ error: safe.reason }, { status: safe.status, headers: { 'Cache-Control': 'private,no-store' } })
    }
  }
}

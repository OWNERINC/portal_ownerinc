import type { Endpoint } from 'payload'
import { validPollPath, validPollBody, POLLS_ENDPOINT } from '../admin/polls-client'
import { assertEditorialOrigin, editorialCookieSettings, readEditorialCookie } from '../auth/cookie'
import { PortalAuthError } from '../auth/portal-client'
import { readCmsEnvironment, type CmsEnvironment } from '../config/environment'

const reasons = new Set(['invalid_request', 'invalid_poll', 'poll_not_found', 'invalid_option', 'already_voted', 'poll_closed',
  'active_poll_exists', 'version_conflict', 'poll_frozen', 'poll_not_open', 'forbidden', 'editorial_session_invalid',
  'editorial_permission_denied', 'email-not-verified', 'pending-approval', 'account-inactive', 'account-disabled', 'enable-pending'])
const responseHeaders = { 'Cache-Control': 'private,no-store' }
const pollMessages: Record<string, string> = {
  invalid_request: 'Requisição inválida.', invalid_poll: 'A enquete é inválida.', poll_not_found: 'Enquete não encontrada.',
  invalid_option: 'Opção inválida.', already_voted: 'Você já votou em outra opção. Recarregue para consultar sua escolha.',
  poll_closed: 'Esta enquete está encerrada.', active_poll_exists: 'Já existe uma enquete aberta.',
  version_conflict: 'A enquete foi alterada. Recarregue antes de continuar.',
  poll_frozen: 'Uma enquete publicada não pode ser alterada ou reaberta.', poll_not_open: 'Somente uma enquete aberta pode ser encerrada.', forbidden: 'Permissão negada.',
}
// Exported for real HTTP boundary tests; production environment is server-only.
export async function proxyPortalPolls(req: Pick<Request, 'url' | 'method' | 'headers' | 'text'>,
  environment: CmsEnvironment = readCmsEnvironment(process.env), fetchImpl: typeof fetch = fetch): Promise<Response> {
  const fail = (status: number, reason: string) => Response.json({ error: reason, reason }, { status, headers: responseHeaders })
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const settings = editorialCookieSettings(environment.portalPublicURL)
    if (req.method !== 'GET') assertEditorialOrigin(req.headers, settings.origin)
    const url = new URL(req.url)
    const suffix = url.pathname === POLLS_ENDPOINT ? '/' : url.pathname.startsWith(`${POLLS_ENDPOINT}/`) ? url.pathname.slice(POLLS_ENDPOINT.length) : ''
    const path = suffix + url.search
    if (!validPollPath(req.method, path)) return fail(400, 'invalid_request')
    const cookie = readEditorialCookie(req.headers, settings.name)
    if (!cookie) throw new PortalAuthError(401)
    let body: string | undefined
    if (req.method !== 'GET') {
      if (!req.headers.get('content-type')?.startsWith('application/json') || Number(req.headers.get('content-length')) > 16384) return fail(400, 'invalid_request')
      body = await req.text()
      if (Buffer.byteLength(body) > 16384) return fail(413, 'invalid_request')
      try { if (!validPollBody(req.method, suffix, JSON.parse(body))) return fail(400, 'invalid_request') } catch { return fail(400, 'invalid_request') }
    }
    const list = new URLSearchParams(url.search)
    if (req.method === 'GET') { list.set('limit', '20'); if (!list.has('offset')) list.set('offset', '0') }
    const upstream = await fetchImpl(`${environment.portalInternalURL}/api/internal/editorial/polls${suffix === '/' ? '' : suffix}${req.method === 'GET' ? `?${list}` : ''}`, {
      method: req.method, body, redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { Authorization: `Bearer ${environment.payloadToPortalSecret}`, Cookie: `${settings.name}=${cookie}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    })
    const data = await upstream.json()
    if (!upstream.ok) {
      if (![400, 401, 403, 404, 409].includes(upstream.status) || !reasons.has(data?.reason)) return fail(503, 'editorial_unavailable')
      return Response.json({ error: pollMessages[data.reason] || data.reason, reason: data.reason }, { status: upstream.status, headers: responseHeaders })
    }
    if (![200, 201].includes(upstream.status)) return fail(503, 'editorial_unavailable')
    const total = upstream.headers.get('X-Total-Count')
    return Response.json(data, { status: upstream.status, headers: { ...responseHeaders, ...(total !== null ? { 'X-Total-Count': total } : {}) } })
  } catch (error) {
    const safe = error instanceof PortalAuthError ? error : new PortalAuthError(503)
    return fail(safe.status, safe.reason)
  } finally { clearTimeout(timeout) }
}
export const portalPollEndpoints: Endpoint[] = [
  { path: '/portal-polls', method: 'get', handler: req => proxyPortalPolls(req as Request) },
  { path: '/portal-polls', method: 'post', handler: req => proxyPortalPolls(req as Request) },
  { path: '/portal-polls/:id/draft', method: 'put', handler: req => proxyPortalPolls(req as Request) },
  ...(['publish', 'close'] as const).map(action => ({ path: `/portal-polls/:id/${action}`, method: 'post' as const, handler: (req: Parameters<Endpoint['handler']>[0]) => proxyPortalPolls(req as Request) })),
]

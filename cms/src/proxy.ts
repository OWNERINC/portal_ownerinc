import { NextResponse, type NextRequest } from 'next/server'
import { assertEditorialOrigin, editorialCookieSettings } from './auth/cookie'
import { PortalAuthError } from './auth/portal-client'
import { readPortalPublicURL } from './config/environment'
import { hasNewsServiceAccess } from './auth/service-access'
import { randomBytes } from 'node:crypto'

export function editorialPolicy(nonce: string, development = false) {
  if (!/^[A-Za-z0-9+/]{32}$/.test(nonce)) throw new Error('Invalid CSP nonce')
  return ["default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", `script-src 'self' 'nonce-${nonce}' https://www.gstatic.com${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'", "font-src 'self' data:", "img-src 'self' data: blob:",
    "media-src 'self' blob:", `connect-src 'self' https://*.googleapis.com https://*.firebaseio.com${development ? ' http://localhost:9099 http://127.0.0.1:9099 ws://localhost:* ws://127.0.0.1:*' : ''}`,
    "frame-src https://*.firebaseapp.com", "worker-src 'self' blob:"].join('; ')
}

// Native Payload layout actions do not all pass through our serverFunction.
// Guard the complete editorial namespace before Next dispatches any action,
// including form POSTs without a next-action header. Authorization stays per request.
export function proxy(request: NextRequest) {
  // Never trust a nonce/CSP forwarded by a client. Next extracts this nonce from
  // the REQUEST CSP for its own HTML/RSC scripts; repeat exactly it on response.
  const nonce = randomBytes(24).toString('base64')
  const policy = editorialPolicy(nonce, process.env.NODE_ENV === 'development')
  const headers = new Headers(request.headers)
  headers.set('x-nonce', nonce)
  headers.set('Content-Security-Policy', policy)
  const finish = (response: NextResponse) => {
    response.headers.set('Content-Security-Policy', policy)
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
  const next = () => finish(NextResponse.next({ request: { headers } }))
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
  if (hasNewsServiceAccess(request)) return next()
  try {
    const { origin } = editorialCookieSettings(readPortalPublicURL(process.env))
    assertEditorialOrigin(request.headers, origin)
    return next()
  } catch (error) {
    const safe = error instanceof PortalAuthError ? error : new PortalAuthError(503)
    return finish(NextResponse.json({ error: safe.reason }, { status: safe.status }))
  }
}

export const config = { matcher: '/editorial/:path*' }

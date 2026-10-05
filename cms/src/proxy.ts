import { NextResponse, type NextRequest } from 'next/server'
import { assertEditorialOrigin, editorialCookieSettings } from './auth/cookie'
import { PortalAuthError } from './auth/portal-client'
import { readPortalPublicURL } from './config/environment'

// Native Payload layout actions do not all pass through our serverFunction.
// Guard the complete editorial namespace before Next dispatches any action,
// including form POSTs without a next-action header. Authorization stays per request.
export function proxy(request: NextRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return NextResponse.next()
  try {
    const { origin } = editorialCookieSettings(readPortalPublicURL(process.env))
    assertEditorialOrigin(request.headers, origin)
    return NextResponse.next()
  } catch (error) {
    const safe = error instanceof PortalAuthError ? error : new PortalAuthError(503)
    return NextResponse.json({ error: safe.reason }, { status: safe.status, headers: { 'Cache-Control': 'no-store' } })
  }
}

export const config = { matcher: '/editorial/:path*' }

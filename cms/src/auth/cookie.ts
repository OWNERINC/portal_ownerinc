import { PortalAuthError } from './portal-client'

export function editorialCookieSettings(portalPublicURL: string, nodeEnv = process.env.NODE_ENV) {
  const url = new URL(portalPublicURL)
  const development = nodeEnv === 'development' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !development) throw new PortalAuthError(503)
  return { name: development ? 'ownerinc-editorial-dev' : '__Host-ownerinc-editorial', origin: url.origin, secure: !development }
}
export function readEditorialCookie(headers: Headers, name: string): string | undefined {
  const entries = (headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (entries.length > 1) throw new PortalAuthError(401)
  const cookie = entries[0]?.slice(name.length + 1)
  if (cookie !== undefined && (!cookie || cookie.length > 12000 || /[\s;,\x00-\x1f\x7f]/.test(cookie))) throw new PortalAuthError(401)
  return cookie
}
export function assertEditorialOrigin(headers: Headers, origin: string) {
  if (headers.get('origin') !== origin || headers.get('sec-fetch-site') === 'cross-site') throw new PortalAuthError(403)
}

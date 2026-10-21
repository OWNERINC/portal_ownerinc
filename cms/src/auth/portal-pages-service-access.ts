import { createHash, timingSafeEqual } from 'node:crypto'
import { APIError } from 'payload'
import { uuid } from '../portal-pages/primitives'
import type { PortalPageReadActor } from '../portal-pages/reader'

export const portalPageActions = ['list', 'categories', 'availability', 'detail', 'preview', 'asset'] as const
export type PortalPageAction = typeof portalPageActions[number]

const invalid = () => { throw new APIError('invalid_request', 400, undefined, true) }
const forbidden = () => { throw new APIError('forbidden', 403, undefined, true) }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, exact: readonly string[]) {
  if (Object.keys(value).length !== exact.length || Object.keys(value).some(key => !exact.includes(key))) invalid()
}
function allowed(value: Record<string, unknown>, names: readonly string[], required: readonly string[]) {
  if (Object.keys(value).some(key => !names.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid()
}

export function isPrivatePortalPagePath(url: string, method: string): boolean {
  try {
    const parsed = new URL(url)
    return method === 'POST' && !parsed.search && !parsed.hash &&
      portalPageActions.some(action => parsed.pathname === `/editorial/api/portal-pages/${action}`)
  } catch { return false }
}

/** Separate exact allowlist; it never adds paths to the Owner News service exception. */
export function hasPortalPagesServiceAccess(request: { url?: string; method?: string; headers: Headers },
  env: Record<string, string | undefined> = process.env): boolean {
  if (!request.url || !isPrivatePortalPagePath(request.url, request.method || '') ||
    request.headers.has('origin') || request.headers.has('cookie') || request.headers.has('sec-fetch-site')) return false
  const secret = env.PORTAL_TO_PAYLOAD_SECRET
  if (!secret || secret.length < 32 || secret === env.PAYLOAD_TO_PORTAL_SECRET) return false
  const received = request.headers.get('authorization') || ''
  if (received.length > 1024) return false
  const hash = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(hash(received), hash(`Bearer ${secret}`))
}

export function readPortalPageActor(value: unknown): PortalPageReadActor {
  if (!record(value)) return invalid()
  keys(value, ['uid', 'email', 'name', 'canManageKnowledge'])
  if (typeof value.uid !== 'string' || !value.uid || value.uid.length > 128 || typeof value.email !== 'string' || !value.email ||
    value.email.length > 320 || !(value.name === null || typeof value.name === 'string') || typeof value.canManageKnowledge !== 'boolean') invalid()
  return { uid: value.uid as string, email: value.email as string, name: value.name as string | null,
    canManageKnowledge: value.canManageKnowledge as boolean }
}

export function readPortalPageInput(action: PortalPageAction, value: unknown): Record<string, unknown> {
  if (!record(value)) return invalid()
  switch (action) {
    case 'list':
      allowed(value, ['limit', 'offset', 'category'], ['limit', 'offset'])
      if (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 50 ||
        !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) > 1_000_000 ||
        (Object.hasOwn(value, 'category') && (typeof value.category !== 'string' || value.category.length > 160 ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.category)))) invalid()
      break
    case 'categories': keys(value, []); break
    case 'availability': keys(value, []); break
    case 'detail':
      keys(value, ['slug'])
      if (typeof value.slug !== 'string' || value.slug.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.slug)) invalid()
      break
    case 'preview':
      keys(value, ['pageId', 'versionId'])
      value.pageId = uuid(value.pageId)
      value.versionId = uuid(value.versionId)
      break
    case 'asset':
      keys(value, ['pageId', 'revisionId', 'assetId', 'preview', 'range'])
      value.pageId = uuid(value.pageId)
      value.revisionId = uuid(value.revisionId)
      value.assetId = uuid(value.assetId)
      if (typeof value.preview !== 'boolean' || !(value.range === null || (typeof value.range === 'string' && value.range.length <= 200))) invalid()
      break
  }
  return value
}

export function validPortalPageRequestID(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
}

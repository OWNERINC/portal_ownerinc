import { createHash, timingSafeEqual } from 'node:crypto'
import { APIError } from 'payload'
import type { NewsQuery, PreviewQuery, VerifiedPortalActor } from '../contracts/news'
import { keys, oneOf, record, uuid } from '../news/primitives'

export const newsActions = ['list', 'detail', 'categories', 'navigation', 'home', 'preview', 'asset'] as const
export type NewsAction = typeof newsActions[number]
export type NewsInputs = {
  list: NewsQuery; detail: { id: string }; categories: { kind?: 'article' | 'edition'; withCounts: boolean }
  navigation: { id: string; category?: string }; home: Record<string, never>; preview: PreviewQuery
  asset: { id: string; preview: boolean; range: string | null }
}
const fail = (status = 400): never => { throw new APIError(status === 400 ? 'invalid_request' : 'forbidden', status, undefined, true) }
export function isPrivateNewsPath(url: string, method: string) {
  const parsed = new URL(url)
  return method === 'POST' && !parsed.search && newsActions.some(action => parsed.pathname === `/editorial/api/portal-news/${action}`)
}
/** Service-only exception, NEVER a generic Payload auth strategy or browser Origin bypass. */
export function hasNewsServiceAccess(request: { url?: string; method?: string; headers: Headers }, env: Record<string, string | undefined> = process.env): boolean {
  if (!request.url || !isPrivateNewsPath(request.url, request.method || '') || request.headers.has('origin') || request.headers.has('cookie') || request.headers.has('sec-fetch-site')) return false
  const secret = env.PORTAL_TO_PAYLOAD_SECRET
  if (!secret || secret.length < 32 || secret === env.PAYLOAD_TO_PORTAL_SECRET) return false
  const received = request.headers.get('authorization') || ''
  if (received.length > 1024) return false
  const hash = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(hash(received), hash(`Bearer ${secret}`))
}
export function readNewsActor(value: unknown): VerifiedPortalActor {
  const actor = record(value); keys(actor, ['uid', 'email', 'name', 'canManageNews'])
  // Match the existing Portal bridge actor contract; identity is verified by the
  // Portal, not reinterpreted as a new local account or narrowed to ASCII UIDs.
  if (typeof actor.uid !== 'string' || !actor.uid || actor.uid.length > 128 || typeof actor.email !== 'string' || !actor.email || actor.email.length > 320 ||
    !(actor.name === null || typeof actor.name === 'string') || typeof actor.canManageNews !== 'boolean') fail()
  return actor as VerifiedPortalActor
}
export function readNewsInput<A extends NewsAction>(action: A, value: unknown): NewsInputs[A] {
  const input = record(value)
  const category = () => { if (Object.hasOwn(input, 'category') && (typeof input.category !== 'string' || input.category.length > 100)) fail() }
  const kind = () => { if (Object.hasOwn(input, 'kind')) oneOf(input.kind, ['article', 'edition']) }
  switch (action) {
    case 'list':
      keys(input, ['limit', 'offset', 'category', 'kind']); category(); kind()
      if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100 || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0 || Number(input.offset) > 1000000) fail()
      break
    case 'detail': keys(input, ['id']); input.id = uuid(input.id); break
    case 'navigation': keys(input, ['id', 'category']); input.id = uuid(input.id); category(); break
    case 'categories': keys(input, ['kind', 'withCounts']); kind(); if (typeof input.withCounts !== 'boolean') fail(); break
    case 'home': keys(input, []); break
    case 'preview':
      keys(input, ['id', 'versionId', 'source']); input.id = uuid(input.id); input.versionId = uuid(input.versionId)
      oneOf(input.source, ['payload', 'legacy'])
      break
    case 'asset':
      keys(input, ['id', 'preview', 'range']); input.id = uuid(input.id)
      if (typeof input.preview !== 'boolean' || !(input.range === null || (typeof input.range === 'string' && input.range.length <= 200))) fail()
      break
    default: fail()
  }
  return input as NewsInputs[A]
}

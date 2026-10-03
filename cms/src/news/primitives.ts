import { APIError } from 'payload'

export const MAX_CONTENT_BYTES = 5 * 1024 * 1024
export const layouts = ['content', 'wide', 'full', 'left', 'right'] as const
export const typographies = ['serif', 'sans'] as const
export const imageMimes = ['image/jpeg', 'image/png', 'image/webp']
export const videoMimes = ['video/mp4', 'video/webm', 'video/quicktime']
export const mediaMimes = [...imageMimes, 'application/pdf', ...videoMimes]
export function invalid(code = 'invalid_news_content'): never {
  throw new APIError(code, 400, undefined, true)
}
export function record(value: unknown, code?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code)
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: readonly string[], code?: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(code)
}
export function plain(value: unknown, max: number, required = true, multiline = true): string {
  if (typeof value !== 'string') invalid()
  const text = value.trim()
  if ((required && !text) || text.length > max || (!multiline && /[\r\n]/u.test(text)) ||
    /<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/iu.test(text)) invalid()
  return text
}
export function httpsURL(value: unknown, code?: string): string {
  if (typeof value !== 'string' || value.trim().length > 2048) invalid(code)
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) invalid(code)
    return parsed.href
  } catch { invalid(code) }
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) invalid()
  return value.toLowerCase()
}
export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid()
  return value as T
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid()
  return value
}
export function bytes(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CONTENT_BYTES) invalid('news_content_too_large')
}

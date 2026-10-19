import { APIError } from 'payload'

export const MAX_PORTAL_PAGE_CONTENT_BYTES = 5 * 1024 * 1024
export const PORTAL_PAGE_LAYOUTS = ['content', 'wide', 'full', 'left', 'right'] as const
export const PORTAL_PAGE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const PORTAL_PAGE_MEDIA_MIMES = [
  ...PORTAL_PAGE_IMAGE_MIMES,
  'application/pdf',
  'video/mp4',
  'video/webm',
] as const

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const markupPattern = /<\s*\/?\s*[a-z][\w:-]*(?:\s|\/?>|$)|<\s*!\s*(?:--|doctype)|\bon[a-z0-9_-]+\s*=|javascript\s*:/iu

export function invalid(code = 'invalid_portal_page_content'): never {
  throw new APIError(code, 400, undefined, true)
}

export function record(value: unknown, code?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code)
  return value as Record<string, unknown>
}

export function array(value: unknown, code?: string): unknown[] {
  if (!Array.isArray(value)) invalid(code)
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) invalid(code)
  }
  return value
}

export function keys(value: Record<string, unknown>, allowed: readonly string[], code?: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(code)
}

function hasUnsafeMarkupOrControls(value: string, multiline: boolean): boolean {
  if (markupPattern.test(value)) return true
  return Array.from(value).some(character => {
    if (!/\p{Cc}/u.test(character)) return false
    return !(multiline && (character === '\n' || character === '\r'))
  })
}

export function plainText(
  value: unknown,
  options: { min?: number; max?: number; multiline?: boolean; code?: string } = {},
): string {
  const { min = 0, max = Number.POSITIVE_INFINITY, multiline = false, code } = options
  if (typeof value !== 'string' || hasUnsafeMarkupOrControls(value, multiline) || (!multiline && /[\r\n]/u.test(value))) {
    invalid(code)
  }
  const text = value.trim()
  const length = Array.from(text).length
  if (length < min || length > max) invalid(code)
  return text
}

/** Rich text nodes preserve authored whitespace; they are still text, never markup. */
export function safeRichText(value: unknown, code = 'invalid_portal_page_rich_text'): string {
  if (typeof value !== 'string' || hasUnsafeMarkupOrControls(value, false)) invalid(code)
  return value
}

export function uuid(value: unknown, code?: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) invalid(code)
  return value.toLowerCase()
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], code?: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(code)
  return value as T
}

export function boolean(value: unknown, code?: string): boolean {
  if (typeof value !== 'boolean') invalid(code)
  return value
}

export function httpsURL(value: unknown, code = 'invalid_portal_page_url'): string {
  if (typeof value !== 'string') invalid(code)
  const raw = value.trim()
  if (/[\p{Cc}\s\\]/u.test(raw)) invalid(code)
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) invalid(code)
    return parsed.href
  } catch {
    invalid(code)
  }
}

export function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

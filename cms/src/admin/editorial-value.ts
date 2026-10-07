import type { NewsEditorial } from '../contracts/news'

export type EditorialValue = Exclude<NewsEditorial, null>
export type EditorialKey = Exclude<keyof EditorialValue, 'version'>
export const newEditorialValue = (): EditorialValue => ({
  version: 1, kind: 'article', summary: '', author: '', source_label: '', source_date: null,
})

// UI shape guard only. Publication/date/content validation remains server-owned.
export function isEditorialValue(value: unknown): value is EditorialValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return Object.keys(item).length === 6 && ['version', 'kind', 'summary', 'author', 'source_label', 'source_date'].every(key => Object.hasOwn(item, key))
    && item.version === 1 && (item.kind === 'article' || item.kind === 'edition')
    && ['summary', 'author', 'source_label'].every(key => typeof item[key] === 'string')
    && (item.source_date === null || typeof item.source_date === 'string')
}

export function editEditorialValue(value: EditorialValue, key: EditorialKey, text: string): EditorialValue {
  if (key === 'kind' && text !== 'article' && text !== 'edition') throw new Error('invalid_editorial_kind')
  // Civil date remains the exact input string: no Date, UTC or timezone conversion.
  return { ...value, [key]: key === 'source_date' && text === '' ? null : text }
}

/** Client feedback only; server validation remains authoritative for persistence. */
export function isValidEditorialSourceDate(value: string | null): boolean {
  if (value === null || value === '') return true
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1]
}

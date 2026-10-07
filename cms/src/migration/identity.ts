export const importEntityKinds = ['asset', 'history', 'document', 'home', 'schedule'] as const
export type ImportEntityKind = typeof importEntityKinds[number]
export type ImportBinding = { runId: string; manifestSha256: string; authorityEpoch: number }
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
export const isUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
export function assertImportBinding(value: ImportBinding) {
  if (!isUUID(value.runId) || !isSha256(value.manifestSha256) || !Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) {
    throw new Error('invalid_import_binding')
  }
}
export function assertSourceIdentity(kind: ImportEntityKind, sourceId: string) {
  const parts = typeof sourceId === 'string' ? sourceId.split('/') : []
  const valid = kind === 'home' ? sourceId === 'news-home' : kind === 'history'
    ? parts.length === 2 && parts.every(isUUID) : kind === 'schedule'
      ? parts.length === 3 && parts.slice(0, 2).every(isUUID) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(parts[2]) && Number.isFinite(Date.parse(parts[2]))
      : ['asset', 'document'].includes(kind) && isUUID(sourceId)
  if (!valid) throw new Error('invalid_import_identity')
}

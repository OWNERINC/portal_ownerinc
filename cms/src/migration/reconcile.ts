import { assertSourceIdentity, isSha256, type ImportEntityKind } from './identity'

export type ExpectedImportItem = {
  entityKind: ImportEntityKind; sourceId: string; expectedHash: string; destinationId: string | null
  sourceDocumentSourceId?: string | null
  /** Imported schedules carry source and native snapshot domains independently. */
  sourceSnapshotHash?: string
  nativeSnapshotHash?: string
}
/** Observations must be freshly read under the reference lock by the consumer.
 * identityMatches covers provenance plus entity-specific integrity checks. */
export type ObservedImportItem = {
  entityKind: ImportEntityKind; sourceId: string; contentHash: string; destinationId: string
  identityMatches: boolean; bytesVerified?: boolean
  sourceSnapshotHashMatches?: boolean
  nativeSnapshotHashMatches?: boolean
}
export type ImportConflictCode = 'content_changed' | 'identity_collision' | 'destination_changed' |
  'asset_bytes_unverified' | 'unexpected_destination' | 'source_snapshot_changed' | 'native_snapshot_changed'
export type ImportConflict = { entityKind: ImportEntityKind; sourceId: string; code: ImportConflictCode }

export function classifyImportedItem(expected: string, current: string | null) {
  return current === null ? 'create' as const : current === expected ? 'existing' as const : 'conflict' as const
}

function key(item: { entityKind: ImportEntityKind; sourceId: string }) {
  assertSourceIdentity(item.entityKind, item.sourceId)
  return `${item.entityKind}:${item.sourceId}`
}
function unique<T extends { entityKind: ImportEntityKind; sourceId: string }>(items: readonly T[]) {
  const result = new Map<string, T>()
  for (const item of items) {
    const identity = key(item)
    if (result.has(identity)) throw new Error('duplicate_import_identity')
    result.set(identity, item)
  }
  return result
}

/** Pure item comparison. It does not claim to have read DB/files or parse a bundle. */
export function reconcileImportItems(expectedItems: readonly ExpectedImportItem[], observedItems: readonly ObservedImportItem[]) {
  const expected = unique(expectedItems), observed = unique(observedItems)
  const conflicts: ImportConflict[] = []
  const actions: { entityKind: ImportEntityKind; sourceId: string; action: 'create' | 'existing' | 'conflict' }[] = []
  for (const item of observed.values()) {
    if (!isSha256(item.contentHash) || typeof item.destinationId !== 'string' || !item.destinationId || typeof item.identityMatches !== 'boolean') throw new Error('invalid_import_observation')
    if (!expected.has(key(item))) conflicts.push({ entityKind: item.entityKind, sourceId: item.sourceId, code: 'unexpected_destination' })
  }
  for (const item of expected.values()) {
    if (!isSha256(item.expectedHash) || !(item.destinationId === null || typeof item.destinationId === 'string' && item.destinationId.length > 0)) throw new Error('invalid_import_expectation')
    if (item.entityKind === 'schedule' && (!isSha256(item.sourceSnapshotHash) || !isSha256(item.nativeSnapshotHash))) {
      throw new Error('invalid_import_schedule_expectation')
    }
    const current = observed.get(key(item))
    let code: ImportConflictCode | undefined
    if (current) {
      if (item.entityKind === 'schedule' && current.sourceSnapshotHashMatches !== true) code = 'source_snapshot_changed'
      else if (item.entityKind === 'schedule' && current.nativeSnapshotHashMatches !== true) code = 'native_snapshot_changed'
      else if (!current.identityMatches) code = 'identity_collision'
      else if (item.destinationId !== null && current.destinationId !== item.destinationId) code = 'destination_changed'
      else if (current.contentHash !== item.expectedHash) code = 'content_changed'
      else if (item.entityKind === 'asset' && current.bytesVerified !== true) code = 'asset_bytes_unverified'
    }
    if (code) conflicts.push({ entityKind: item.entityKind, sourceId: item.sourceId, code })
    actions.push({ entityKind: item.entityKind, sourceId: item.sourceId, action: code ? 'conflict' : current ? 'existing' : 'create' })
  }
  const counts = { expected: expected.size, observed: observed.size,
    create: actions.filter(item => item.action === 'create').length,
    verified: actions.filter(item => item.action === 'existing').length, conflicts: conflicts.length }
  return { ok: counts.create === 0 && conflicts.length === 0, actions, conflicts, counts }
}

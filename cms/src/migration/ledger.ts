import { assertSourceIdentity, isSha256, isUUID } from './identity'
import { classifyImportedItem, type ExpectedImportItem } from './reconcile'

export const migrationItemStates = ['planned', 'applied', 'verified', 'conflict'] as const
export type MigrationItemState = typeof migrationItemStates[number]
export type MigrationItem = ExpectedImportItem & {
  runId: string; manifestSha256: string; state: MigrationItemState; commitOutcome: 'acknowledged' | 'unknown'
  observedHash: string | null
}

export function assertMigrationItem(item: MigrationItem) {
  assertSourceIdentity(item.entityKind, item.sourceId)
  if (!isUUID(item.runId) || !isSha256(item.manifestSha256) || !isSha256(item.expectedHash) ||
    !migrationItemStates.includes(item.state) || !['acknowledged', 'unknown'].includes(item.commitOutcome) ||
    !(item.destinationId === null || typeof item.destinationId === 'string' && item.destinationId.length > 0 && item.destinationId.length <= 128) ||
    !(item.observedHash === null || isSha256(item.observedHash))) {
    throw new Error('invalid_import_ledger')
  }
}

/** A missing previously applied item is drift, not permission to recreate it.
 * Unknown COMMIT cannot become verified until a fresh transaction reconciles
 * durable rows and explicitly acknowledges the outcome. */
export function nextMigrationItemState(item: MigrationItem, actualHash: string | null): MigrationItemState {
  assertMigrationItem(item)
  if (actualHash !== null && !isSha256(actualHash)) throw new Error('invalid_import_observation')
  const classification = classifyImportedItem(item.expectedHash, actualHash)
  if (classification === 'conflict') return 'conflict'
  if (classification === 'create') return item.state === 'planned' ? 'planned' : 'conflict'
  return item.commitOutcome === 'unknown' ? 'applied' : 'verified'
}

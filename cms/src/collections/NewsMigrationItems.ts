import { APIError, type CollectionConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { importEntityKinds } from '../migration/identity'
import { migrationItemStates } from '../migration/ledger'
import { assertPreparationIdentity } from '../publication/authority'
import { assertMigrationItem } from '../migration/ledger'

/** Every writer must carry the exact live preparation capability and identity. */
export const NewsMigrationItems: CollectionConfig = {
  slug: 'news-migration-items',
  admin: { hidden: true },
  access: { read: canManageNews, create: () => false, update: () => false, delete: () => false },
  indexes: [{ fields: ['manifestSha256', 'entityKind', 'sourceId'], unique: true }],
  hooks: { beforeOperation: [async ({ operation, req, args }) => {
    if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
    if (operation === 'delete' || operation === 'restoreVersion' || !('data' in args)) {
      throw new APIError('migration_preparation_context_required', 403, undefined, true)
    }
    const identity = await assertPreparationIdentity(req)
    const data = args.data as Record<string, unknown>
    if (operation === 'create' && (data.runId !== identity.runId || data.manifestSha256 !== identity.manifestSha256)) {
      throw new APIError('migration_item_identity_mismatch', 409, undefined, true)
    }
    if (operation === 'update') {
      if (!('id' in args) || Object.keys(data).some(key => !['state', 'observedHash', 'destinationId'].includes(key))) {
        throw new APIError('migration_item_identity_mismatch', 409, undefined, true)
      }
      const current = await (req.payload as unknown as { findByID(args: Record<string, unknown>): Promise<Record<string, unknown>> }).findByID({
        collection: 'news-migration-items', id: args.id, req, overrideAccess: true, depth: 0 })
      if (current.runId !== identity.runId || current.manifestSha256 !== identity.manifestSha256) {
        throw new APIError('migration_item_identity_mismatch', 409, undefined, true)
      }
    }
  }], beforeChange: [({ data, originalDoc, operation }) => {
    if (operation !== 'create' && originalDoc) for (const field of ['runId', 'manifestSha256', 'entityKind', 'sourceId', 'expectedHash']) {
      if (data[field] !== undefined && data[field] !== originalDoc[field]) throw new APIError('migration_item_identity_immutable', 403, undefined, true)
    }
    const item = { ...(originalDoc as Record<string, unknown> | undefined), ...(data as Record<string, unknown>) }
    if (operation !== 'create' && originalDoc && data.destinationId !== undefined && data.destinationId !== originalDoc.destinationId &&
      !(originalDoc.destinationId == null && originalDoc.state === 'planned' && originalDoc.observedHash == null &&
        data.state === 'verified' && typeof data.observedHash === 'string')) {
      throw new APIError('migration_item_destination_immutable', 403, undefined, true)
    }
    if (item.destinationId === undefined) item.destinationId = null
    if (item.observedHash === undefined) item.observedHash = null
    assertMigrationItem(item as unknown as Parameters<typeof assertMigrationItem>[0])
    if (item.state === 'verified' && item.observedHash !== item.expectedHash) {
      throw new APIError('migration_item_observation_mismatch', 409, undefined, true)
    }
    if (operation !== 'create' && originalDoc) {
      if (['verified', 'conflict'].includes(String(originalDoc.state)) && data.state !== undefined && data.state !== originalDoc.state) {
        throw new APIError('migration_item_state_regression', 409, undefined, true)
      }
      if (originalDoc.state === 'verified' && data.observedHash !== undefined && data.observedHash !== originalDoc.observedHash) {
        throw new APIError('migration_item_observation_immutable', 409, undefined, true)
      }
      if (item.state === 'verified' && item.commitOutcome !== 'acknowledged') {
        throw new APIError('migration_item_commit_unacknowledged', 409, undefined, true)
      }
    }
    return data
  }] },
  fields: [
    { name: 'runId', type: 'text', required: true, index: true, minLength: 36, maxLength: 36 },
    { name: 'manifestSha256', type: 'text', required: true, index: true, minLength: 64, maxLength: 64 },
    { name: 'entityKind', type: 'select', required: true, options: [...importEntityKinds] },
    { name: 'sourceId', type: 'text', required: true, maxLength: 128 },
    { name: 'expectedHash', type: 'text', required: true, minLength: 64, maxLength: 64 },
    { name: 'destinationId', type: 'text', maxLength: 128 },
    { name: 'observedHash', type: 'text', minLength: 64, maxLength: 64 },
    { name: 'state', type: 'select', required: true, defaultValue: 'planned', options: [...migrationItemStates] },
    { name: 'commitOutcome', type: 'select', required: true, defaultValue: 'acknowledged', options: ['acknowledged', 'unknown'] },
  ],
}

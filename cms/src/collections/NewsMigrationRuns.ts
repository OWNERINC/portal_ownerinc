import { APIError, type CollectionConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { assertPreparationIdentity } from '../publication/authority'
import { assertPreparationBootstrap } from '../migration/preparation-bootstrap'

/** One durable run store shared by importer and Task12. Bootstrap and subsequent
 * writes require private in-process capabilities bound to the exact live req. */
export const NewsMigrationRuns: CollectionConfig = {
  slug: 'news-migration-runs',
  admin: { hidden: true },
  access: { read: canManageNews, create: () => false, update: () => false, delete: () => false },
  hooks: { beforeOperation: [async ({ operation, req, args }) => {
    if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
    if (operation === 'create' && 'data' in args) { await assertPreparationBootstrap(req, args.data as Record<string, unknown>); return }
    if (operation === 'update' && 'data' in args) {
      const identity = await assertPreparationIdentity(req)
      if (('id' in args && args.id !== identity.runId) || Object.keys(args.data || {}).some(key =>
        !['progressState', 'commitOutcome', 'reconciliationSha256', 'destinationFingerprint', 'unresolvedExceptions'].includes(key))) {
        throw new APIError('migration_preparation_update_invalid', 403, undefined, true)
      }
      return
    }
    throw new APIError('migration_preparation_context_required', 403, undefined, true)
  }], beforeChange: [({ data, originalDoc, operation }) => {
    if (operation !== 'create' && originalDoc && (data.manifestSha256 !== undefined && data.manifestSha256 !== originalDoc.manifestSha256 ||
      data.sourceInstance !== undefined && data.sourceInstance !== originalDoc.sourceInstance ||
      data.sourceFingerprint !== undefined && data.sourceFingerprint !== originalDoc.sourceFingerprint ||
      data.authorityEpoch !== undefined && data.authorityEpoch !== originalDoc.authorityEpoch ||
      data.admissionState !== undefined && data.admissionState !== originalDoc.admissionState)) {
      throw new APIError('migration_run_identity_immutable', 403, undefined, true)
    }
    return data
  }] },
  fields: [
    { name: 'manifestSha256', type: 'text', required: true, unique: true, minLength: 64, maxLength: 64 },
    { name: 'sourceInstance', type: 'text', required: true, maxLength: 128 },
    { name: 'sourceFingerprint', type: 'text', required: true, minLength: 64, maxLength: 64 },
    { name: 'authorityEpoch', type: 'number', required: true, min: 1 },
    { name: 'progressState', type: 'select', required: true, defaultValue: 'preparing', options: ['preparing', 'reconciled', 'conflict'] },
    { name: 'admissionState', type: 'select', required: true, defaultValue: 'open', options: ['open', 'sealed'] },
    { name: 'commitOutcome', type: 'select', required: true, defaultValue: 'acknowledged', options: ['acknowledged', 'unknown'] },
    // Integration migration maps sequence consumers as decimal strings over
    // PostgreSQL BIGINT; never coerce these through JS Number.
    { name: 'reconciliationSequence', type: 'text', maxLength: 19, admin: { hidden: true } },
    { name: 'reconciliationChainSha256', type: 'text', minLength: 64, maxLength: 64, admin: { hidden: true } },
    { name: 'reconciliationSha256', type: 'text', minLength: 64, maxLength: 64, admin: { hidden: true } },
    { name: 'destinationFingerprint', type: 'text', minLength: 64, maxLength: 64, admin: { hidden: true } },
    { name: 'unresolvedExceptions', type: 'json', defaultValue: [], admin: { hidden: true } },
    { name: 'sealedSequence', type: 'text', maxLength: 19, admin: { hidden: true } },
    { name: 'sealedChainSha256', type: 'text', minLength: 64, maxLength: 64, admin: { hidden: true } },
    { name: 'sealedAt', type: 'date', admin: { hidden: true } },
    { name: 'activationEpoch', type: 'number', min: 1, admin: { hidden: true } },
    { name: 'drainReceiptSha256', type: 'text', minLength: 64, maxLength: 64, admin: { hidden: true } },
  ],
}

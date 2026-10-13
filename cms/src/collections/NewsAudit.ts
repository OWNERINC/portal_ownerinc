import { APIError, type CollectionConfig } from 'payload'
import { newsAreaReadAccess } from '../auth/news-area-access'
import { isPublicationMutation } from '../publication/internal'
import { requireCmsTransaction } from '../publication/transaction'

export const NewsAudit: CollectionConfig = {
  slug: 'news-audit',
  admin: { useAsTitle: 'action', defaultColumns: ['action', 'documentId', 'actorUid', 'createdAt'] },
  access: { read: newsAreaReadAccess, create: () => false, update: () => false, delete: () => false },
  hooks: { beforeOperation: [async ({ operation, req }) => {
    if (['update', 'delete'].includes(operation) || (operation === 'create' && !isPublicationMutation(req))) {
      throw new APIError('news_audit_append_only', 403, undefined, true)
    }
    if (operation === 'create') await requireCmsTransaction(req.payload, req)
  }] },
  fields: [
    { name: 'action', type: 'select', required: true, options: ['draft_saved', 'published', 'unpublished', 'scheduled', 'schedule_cancelled', 'schedule_rejected'] },
    { name: 'documentId', type: 'text', required: true, index: true },
    { name: 'versionId', type: 'text' },
    { name: 'actorUid', type: 'text', required: true },
    { name: 'requestedByUid', type: 'text', required: true },
    { name: 'details', type: 'json', required: true },
  ],
}

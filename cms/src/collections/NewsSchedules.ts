import { APIError, type CollectionConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { isPublicationMutation } from '../publication/internal'
import { requireCmsTransaction } from '../publication/transaction'

export const NewsSchedules: CollectionConfig = {
  slug: 'news-schedules',
  admin: { useAsTitle: 'scheduledAt', defaultColumns: ['documentId', 'action', 'scheduledAt', 'state', 'generation'] },
  access: { read: canManageNews, create: () => false, update: () => false, delete: () => false },
  hooks: { beforeOperation: [async ({ operation, req, args }) => {
    if (!['create', 'update', 'delete'].includes(operation)) return
    if (operation === 'delete' || !isPublicationMutation(req)) throw new APIError('news_schedule_server_only', 403, undefined, true)
    await requireCmsTransaction(req.payload, req)
    if (operation === 'update' && 'data' in args && Object.keys(args.data || {}).some(key => !['state', 'jobId', 'updatedAt'].includes(key))) {
      throw new APIError('news_snapshot_immutable', 403, undefined, true)
    }
  }] },
  fields: [
    { name: 'target', type: 'select', required: true, options: ['news-articles', 'news-home'] },
    { name: 'documentId', type: 'text', required: true, index: true },
    { name: 'action', type: 'select', required: true, options: ['publish', 'unpublish'] },
    { name: 'versionId', type: 'text', required: true },
    { name: 'snapshot', type: 'json', required: true },
    { name: 'snapshotHash', type: 'text', required: true },
    { name: 'scheduledAt', type: 'date', required: true, index: true },
    { name: 'actorUid', type: 'text', required: true },
    { name: 'generation', type: 'number', required: true, min: 1 },
    { name: 'state', type: 'select', required: true, defaultValue: 'pending', options: ['pending', 'published', 'unpublished', 'cancelled', 'rejected'] },
    { name: 'jobId', type: 'text', unique: true },
  ],
}

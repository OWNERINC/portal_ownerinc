import type { CollectionConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { newsFields } from '../news/fields'
import { validateNewsBeforeChange } from '../news/validation'

export const NewsArticles: CollectionConfig = {
  slug: 'news-articles',
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'category', '_status', 'publishedAt'] },
  access: { create: canManageNews, read: canManageNews, update: canManageNews, delete: canManageNews, readVersions: canManageNews },
  versions: { maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },
  fields: newsFields,
  hooks: { beforeChange: [validateNewsBeforeChange] },
}

import type { CollectionConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { newsFields } from '../news/fields'
import { protectNewsIdentity, validateNewsBeforeChange, validateNewsPublicationMedia } from '../news/validation'
import { protectArticleReferences } from '../publication/authority'

export const NewsArticles: CollectionConfig = {
  slug: 'news-articles',
  disableBulkEdit: true,
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'category', '_status', 'publishedAt'],
    components: { views: { create: { Component: '/news/CreateArticleView#CreateArticleView', path: '/create', exact: true } } },
  },
  access: { create: canManageNews, read: canManageNews, update: canManageNews, delete: canManageNews, readVersions: canManageNews },
  versions: { maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },
  fields: newsFields,
  hooks: { beforeOperation: [protectArticleReferences, protectNewsIdentity], beforeChange: [validateNewsBeforeChange, validateNewsPublicationMedia] },
}

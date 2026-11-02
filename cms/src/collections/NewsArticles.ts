import { deepCopyObject, type CollectionConfig } from 'payload'
import { canWriteNews } from '../auth/access'
import { newsAreaReadAccess } from '../auth/news-area-access'
import { newsFields } from '../news/fields'
import { protectNewsIdentity, validateNewsBeforeChange, validateNewsPublicationMedia } from '../news/validation'
import { protectArticleReferences } from '../publication/authority'
import { beforeArticlePublication, prepareArticlePublication, afterArticlePublication } from '../publication/hooks'
import { createNewsHistoryAccess } from '../auth/news-history-access'
import { createArticleDraftIntent } from '../publication/draft-intent'
import { createArticleRestoreGuard } from '../publication/restore-draft'
import { registerEditorialSafety, type EditorialProfile } from '../config/editorial-profile'

export const createNewsArticles = (profile: EditorialProfile = 'held-v1'): CollectionConfig => registerEditorialSafety<CollectionConfig>({
  slug: 'news-articles',
  labels: { singular: 'Publicação', plural: 'Publicações' },
  disableBulkEdit: true,
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'category', '_status', 'publishedAt'],
    components: { edit: { beforeDocumentControls: ['/admin/SaveDraftCheckpoint#SaveDraftCheckpoint', '/admin/SavedPreview#SavedPreview', '/admin/LegacyHistory#LegacyHistory'] },
      views: { edit: { version: { Component: '/admin/NewsVersionView#NewsVersionView' } },
        create: { Component: '/news/CreateArticleView#CreateArticleView', path: '/create', exact: true } } },
  },
  access: { create: canWriteNews, read: newsAreaReadAccess, update: canWriteNews, delete: canWriteNews, readVersions: createNewsHistoryAccess(profile) },
  versions: { maxPerDoc: 0, drafts: { autosave: profile === 'editorial-v1' ? { interval: 1500 } : false, schedulePublish: false } },
  fields: deepCopyObject(newsFields),
  hooks: { beforeOperation: [createArticleRestoreGuard(profile), createArticleDraftIntent(profile), protectArticleReferences, protectNewsIdentity, beforeArticlePublication],
    beforeChange: [prepareArticlePublication, validateNewsBeforeChange, validateNewsPublicationMedia], afterChange: [afterArticlePublication] },
})
export const NewsArticles = createNewsArticles()

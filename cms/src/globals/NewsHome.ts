import { deepCopyObject, type GlobalConfig } from 'payload'
import { canWriteNews } from '../auth/access'
import { newsAreaReadAccess } from '../auth/news-area-access'
import { publicationFields } from '../news/fields'
import { validateNewsHomeBeforeChange } from '../news/validation'
import { beforeHomePublication, prepareHomePublication, afterHomePublication } from '../publication/hooks'
import { createNewsHistoryAccess } from '../auth/news-history-access'
import { createHomeDraftIntent } from '../publication/draft-intent'
import { createHomeRestoreGuard } from '../publication/restore-draft'
import { registerEditorialSafety, type EditorialProfile } from '../config/editorial-profile'

export const createNewsHome = (profile: EditorialProfile = 'held-v1'): GlobalConfig => registerEditorialSafety<GlobalConfig>({
  slug: 'news-home',
  label: 'Abertura da Owner News',
  admin: { components: { elements: { beforeDocumentControls: ['/admin/SaveDraftCheckpoint#SaveDraftCheckpoint'] },
    views: { edit: { version: { Component: '/admin/NewsVersionView#NewsVersionView' } } } } },
  access: { read: newsAreaReadAccess, update: canWriteNews, readVersions: createNewsHistoryAccess(profile) },
  versions: { max: 0, drafts: { autosave: profile === 'editorial-v1' ? { interval: 1500 } : false, schedulePublish: false } },
  fields: [
    { name: 'eyebrow', label: 'Chamada', type: 'text', maxLength: 80, defaultValue: '' },
    { name: 'headline', label: 'Título de abertura', type: 'textarea', maxLength: 160, defaultValue: '' },
    { name: 'summary', label: 'Resumo', type: 'text', maxLength: 600, defaultValue: '' },
    ...deepCopyObject(publicationFields),
  ],
  hooks: { beforeOperation: [createHomeRestoreGuard(profile), createHomeDraftIntent(profile), beforeHomePublication], beforeChange: [prepareHomePublication, validateNewsHomeBeforeChange], afterChange: [afterHomePublication] },
})
export const NewsHome = createNewsHome()

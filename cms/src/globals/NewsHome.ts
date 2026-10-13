import type { GlobalConfig } from 'payload'
import { canWriteNews } from '../auth/access'
import { newsAreaReadAccess } from '../auth/news-area-access'
import { publicationFields } from '../news/fields'
import { validateNewsHomeBeforeChange } from '../news/validation'
import { beforeHomePublication, prepareHomePublication, afterHomePublication } from '../publication/hooks'

export const NewsHome: GlobalConfig = {
  slug: 'news-home',
  label: 'Abertura da Owner News',
  admin: { components: { elements: { beforeDocumentControls: ['/admin/ScheduleRevision#ScheduleRevision'] } } },
  access: { read: newsAreaReadAccess, update: canWriteNews, readVersions: newsAreaReadAccess },
  versions: { max: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },
  fields: [
    { name: 'eyebrow', label: 'Chamada', type: 'text', maxLength: 80, defaultValue: '' },
    { name: 'headline', label: 'Título de abertura', type: 'textarea', maxLength: 160, defaultValue: '' },
    { name: 'summary', label: 'Resumo', type: 'text', maxLength: 600, defaultValue: '' },
    ...publicationFields,
  ],
  hooks: { beforeOperation: [beforeHomePublication], beforeChange: [prepareHomePublication, validateNewsHomeBeforeChange], afterChange: [afterHomePublication] },
}

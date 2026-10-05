import type { GlobalConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { publicationFields } from '../news/fields'
import { validateNewsHomeBeforeChange } from '../news/validation'
import { beforeHomePublication, prepareHomePublication, afterHomePublication } from '../publication/hooks'

export const NewsHome: GlobalConfig = {
  slug: 'news-home',
  admin: { components: { elements: { beforeDocumentControls: ['/admin/ScheduleRevision#ScheduleRevision'] } } },
  access: { read: canManageNews, update: canManageNews, readVersions: canManageNews },
  versions: { max: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },
  fields: [
    { name: 'eyebrow', type: 'text', maxLength: 80, defaultValue: '' },
    { name: 'headline', type: 'textarea', maxLength: 160, defaultValue: '' },
    { name: 'summary', type: 'text', maxLength: 600, defaultValue: '' },
    ...publicationFields,
  ],
  hooks: { beforeOperation: [beforeHomePublication], beforeChange: [prepareHomePublication, validateNewsHomeBeforeChange], afterChange: [afterHomePublication] },
}

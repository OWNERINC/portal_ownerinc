import type { GlobalConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { publicationFields } from '../news/fields'
import { validateNewsHomeBeforeChange } from '../news/validation'

export const NewsHome: GlobalConfig = {
  slug: 'news-home',
  access: { read: canManageNews, update: canManageNews, readVersions: canManageNews },
  versions: { max: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },
  fields: [
    { name: 'eyebrow', type: 'text', maxLength: 80, defaultValue: '' },
    { name: 'headline', type: 'textarea', maxLength: 160, defaultValue: '' },
    { name: 'summary', type: 'text', maxLength: 600, defaultValue: '' },
    ...publicationFields,
  ],
  hooks: { beforeChange: [validateNewsHomeBeforeChange] },
}

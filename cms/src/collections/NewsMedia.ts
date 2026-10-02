import type { CollectionConfig } from 'payload'
import type { CmsEnvironment } from '../config/environment'
import { mediaMimes } from '../news/primitives'

/** Schema dependency only. Task 5 must install private-media safeguards before opening access. */
export function createNewsMedia(environment: Pick<CmsEnvironment, 'uploadDir'>): CollectionConfig {
  const deny = () => false
  return {
    slug: 'news-media',
    admin: { hidden: true, useAsTitle: 'filename' },
    access: { create: deny, read: deny, update: deny, delete: deny },
    upload: { staticDir: environment.uploadDir, mimeTypes: mediaMimes, crop: false, focalPoint: false, },
    fields: [
      { name: 'sha256', type: 'text', minLength: 64, maxLength: 64, index: true, admin: { readOnly: true } },
      { name: 'legacyAssetId', type: 'text', index: true, admin: { readOnly: true } },
      { name: 'importedAt', type: 'date', admin: { readOnly: true } },
    ],
  }
}

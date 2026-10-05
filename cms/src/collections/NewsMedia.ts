import type { CollectionConfig } from 'payload'
import type { CmsEnvironment } from '../config/environment'
import { mediaMimes } from '../news/primitives'
import { canManageNews } from '../auth/access'
import { persistMediaIdentity, protectMediaDelete, protectMediaOperation } from '../media/lifecycle'
import { openNativeNewsMedia } from '../media/read-file'

export function createNewsMedia(environment: Pick<CmsEnvironment, 'uploadDir'>): CollectionConfig {
  const deny = () => false
  return {
    slug: 'news-media',
    admin: { useAsTitle: 'filename', description: 'Immutable assets. To replace or crop, upload a new asset and change the article reference.' },
    disableDuplicate: true,
    disableBulkDelete: true,
    access: { create: canManageNews, read: canManageNews, update: deny, delete: canManageNews },
    hooks: { beforeOperation: [protectMediaOperation], beforeChange: [persistMediaIdentity], beforeDelete: [protectMediaDelete] },
    upload: {
      staticDir: environment.uploadDir, mimeTypes: mediaMimes, crop: false, focalPoint: false, pasteURL: false,
      // Always answer: never fall through to native path/redirect serving.
      handlers: [async (req, { params }) => {
        const result = await openNativeNewsMedia(req, params.filename)
        return new Response(result.body, { status: result.status, headers: result.headers })
      }],
    },
    fields: [
      { name: 'sha256', type: 'text', required: true, minLength: 64, maxLength: 64, index: true, admin: { readOnly: true } },
      { name: 'legacyAssetId', type: 'text', index: true, admin: { readOnly: true } },
      { name: 'importedAt', type: 'date', admin: { readOnly: true } },
    ],
  }
}

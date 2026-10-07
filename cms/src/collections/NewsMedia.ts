import type { CollectionConfig } from 'payload'
import type { CmsEnvironment } from '../config/environment'
import { mediaMimes } from '../news/primitives'
import { canManageNews } from '../auth/access'
import { canReadNewsArea, type NewsAreaReadGate } from '../auth/news-area-access'
import { persistMediaIdentity, protectMediaDelete, protectMediaOperation } from '../media/lifecycle'
import { openNativeNewsMedia } from '../media/read-file'
import { isLegacyNewsImport } from '../news/validation'

export function createNewsMedia(environment: Pick<CmsEnvironment, 'uploadDir'>, importContext?: unknown,
  readNewsArea: NewsAreaReadGate = canReadNewsArea): CollectionConfig {
  const deny = () => false
  const stagedImportConfig = isLegacyNewsImport(importContext)
  return {
    slug: 'news-media',
    labels: { singular: 'Arquivo', plural: 'Mídias' },
    admin: { useAsTitle: 'filename', description: 'Arquivos imutáveis. Para substituir ou recortar, envie um novo arquivo e altere a referência na publicação.' },
    disableDuplicate: true,
    disableBulkDelete: true,
    access: { create: canManageNews, read: ({ req }) => readNewsArea(req), update: deny, delete: canManageNews },
    hooks: { beforeOperation: [protectMediaOperation], beforeChange: [persistMediaIdentity], beforeDelete: [protectMediaDelete] },
    upload: {
      staticDir: environment.uploadDir, mimeTypes: mediaMimes, crop: false, focalPoint: false, pasteURL: false,
      ...(stagedImportConfig ? { filesRequiredOnCreate: false, disableLocalStorage: true } : {}),
      // Always answer: never fall through to native path/redirect serving.
      handlers: [async (req, { params }) => {
        const result = await openNativeNewsMedia(req, params.filename, readNewsArea)
        return new Response(result.body, { status: result.status, headers: result.headers })
      }],
    },
    fields: [
      { name: 'sha256', label: 'Integridade SHA-256', type: 'text', required: true, minLength: 64, maxLength: 64, index: true, admin: { readOnly: true } },
      { name: 'legacyAssetId', label: 'Arquivo anterior', type: 'text', index: true, admin: { readOnly: true } },
      { name: 'importedAt', label: 'Importado em', type: 'date', admin: { readOnly: true } },
    ],
  }
}

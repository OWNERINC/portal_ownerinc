import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeOperationHook, type CollectionConfig, type PayloadRequest } from 'payload'
import { canManagePortalPages } from '../auth/portal-pages-access'
import { requireCmsTransaction } from '../publication/transaction'
import {
  assertPortalPageMediaOrphan,
  isPortalPageMediaMutation,
  portalPageMediaMutationActor,
} from '../portal-pages/persistence'
import { createPortalPageStorageKey, validatePortalPageMediaMetadata } from '../portal-pages/validation'

export const portalPageMediaReadAccess = ({ req }: { req: PayloadRequest }) =>
  canManagePortalPages({ req }) ? { state: { equals: 'complete' as const } } : false
const portalPageMediaAdminAccess = ({ req }: { req: PayloadRequest }) => canManagePortalPages({ req })

const protectPortalPageMediaOperation: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['create', 'update', 'delete'].includes(operation)) return
  if (!isPortalPageMediaMutation(req, operation as 'create' | 'update' | 'delete')) {
    throw new APIError('portal_page_media_server_only', 403, undefined, true)
  }
  await requireCmsTransaction(req.payload, req)
  if (operation === 'update') {
    if (!('data' in args) || !args.data || Object.keys(args.data).some(field => !['state', 'completedAt'].includes(field))) {
      throw new APIError('portal_page_media_metadata_immutable', 403, undefined, true)
    }
  }
  if (operation === 'delete') {
    if (!('id' in args) || !args.id) throw new APIError('portal_page_media_delete_requires_single_id', 400, undefined, true)
    await assertPortalPageMediaOrphan(req.payload, String(args.id), req)
  }
}

const validatePortalPageMediaBeforeChange: CollectionBeforeChangeHook = ({ data, originalDoc, operation, req }) => {
  if (!isPortalPageMediaMutation(req, operation === 'create' ? 'create' : 'update')) {
    throw new APIError('portal_page_media_server_only', 403, undefined, true)
  }
  const actorUid = portalPageMediaMutationActor(req)
  if (!actorUid) throw new APIError('portal_page_media_actor_required', 403, undefined, true)
  const candidate = { ...(originalDoc as Record<string, unknown> | undefined), ...(data as Record<string, unknown>) }
  if (operation === 'create') {
    candidate.uploadedBy = actorUid
    candidate.storageKey = createPortalPageStorageKey(candidate.mimeType)
  }
  else {
    if (!originalDoc || originalDoc.uploadedBy !== actorUid || originalDoc.state !== 'uploading' || candidate.state !== 'complete') {
      throw new APIError('portal_page_media_metadata_immutable', 403, undefined, true)
    }
    candidate.uploadedBy = originalDoc.uploadedBy
  }
  const normalized = validatePortalPageMediaMetadata(candidate)
  Object.assign(data, normalized)
  return data
}

export const PortalPageMedia: CollectionConfig = {
  slug: 'portal-page-media',
  labels: { singular: 'Mídia de página', plural: 'Mídias de páginas' },
  lockDocuments: false,
  disableDuplicate: true,
  disableBulkDelete: true,
  admin: { useAsTitle: 'originalName', defaultColumns: ['originalName', 'mimeType', 'filesize', 'state'] },
  access: {
    admin: portalPageMediaAdminAccess,
    create: () => false,
    read: portalPageMediaReadAccess,
    update: () => false,
    delete: () => false,
  },
  hooks: {
    beforeOperation: [protectPortalPageMediaOperation],
    beforeChange: [validatePortalPageMediaBeforeChange],
  },
  fields: [
    { name: 'originalName', label: 'Nome original', type: 'text', required: true, maxLength: 255, admin: { readOnly: true } },
    { name: 'storageKey', label: 'Chave de armazenamento', type: 'text', required: true, maxLength: 80, unique: true, admin: { readOnly: true } },
    { name: 'mimeType', label: 'Tipo de arquivo', type: 'select', required: true, options: [
      { label: 'JPEG', value: 'image/jpeg' }, { label: 'PNG', value: 'image/png' }, { label: 'WebP', value: 'image/webp' },
      { label: 'PDF', value: 'application/pdf' }, { label: 'MP4', value: 'video/mp4' }, { label: 'WebM', value: 'video/webm' },
    ], admin: { readOnly: true } },
    { name: 'filesize', label: 'Tamanho em bytes', type: 'number', required: true, min: 1, admin: { readOnly: true } },
    { name: 'sha256', label: 'Integridade SHA-256', type: 'text', required: true, minLength: 64, maxLength: 64, admin: { readOnly: true } },
    { name: 'state', label: 'Estado', type: 'select', required: true, options: [
      { label: 'Em envio', value: 'uploading' }, { label: 'Concluído', value: 'complete' },
    ], admin: { readOnly: true } },
    { name: 'uploadedBy', label: 'Enviado por', type: 'text', required: true, maxLength: 128, admin: { readOnly: true } },
    { name: 'completedAt', label: 'Concluído em', type: 'date', admin: { readOnly: true } },
  ],
}

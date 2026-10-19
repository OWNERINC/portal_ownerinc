import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeOperationHook, type CollectionBeforeValidateHook,
  type CollectionConfig, type PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { PORTAL_PAGE_IMAGE_MIMES } from '../portal-pages/primitives'
import { canManagePortalPages, portalPageEditorAccess } from '../auth/portal-pages-access'
import { lockCmsReferences, requireCmsTransaction } from '../publication/transaction'
import {
  assertPortalPageCategoryReferences,
  assertPortalPageMediaReferences,
  isPortalPagePublication,
  portalPagePublicationOperation,
  projectPortalPageContent,
} from '../portal-pages/persistence'
import { plainText, uuid } from '../portal-pages/primitives'
import {
  normalizeSlug,
  validatePortalPageSlugChange,
  validatePortalPageStatusTransition,
} from '../portal-pages/validation'
import { portalPageBlocks } from '../portal-pages/native-blocks'

const portalPageSaveModes = new WeakMap<PayloadRequest, { draftSave: boolean }>()
const noDirectFieldWrite = { create: () => false, update: () => false }

function requestPortalUID(req: PayloadRequest): string {
  const user = req.user as (typeof req.user & { portalUid?: unknown }) | null
  if (user?.collection !== 'portal-editors' || typeof user.portalUid !== 'string' || !user.portalUid.trim() ||
    user.portalUid.length > 128) throw new APIError('editorial_permission_denied', 403, undefined, true)
  return user.portalUid
}

function relationID(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const id = typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).id : null
  if (typeof id !== 'string') throw new APIError('invalid_portal_page_media_reference', 400, undefined, true)
  return uuid(id, 'invalid_portal_page_media_reference')
}

const stampPortalPageAuthors: CollectionBeforeValidateHook = ({ data, originalDoc, req }) => {
  const actorUID = requestPortalUID(req)
  const input = data as Record<string, unknown>
  const original = (originalDoc || {}) as Record<string, unknown>
  input.createdBy = original.createdBy ?? actorUID
  input.updatedBy = actorUID
  return input
}

const protectPortalPageOperation: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
  if (!canManagePortalPages({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
  const hasPublicationScope = isPortalPagePublication(req, 'id' in args ? String(args.id) : undefined)
  if (operation === 'restoreVersion' && !hasPublicationScope) {
    throw new APIError('portal_page_restore_requires_publication_helper', 403, undefined, true)
  }
  await requireCmsTransaction(req.payload, req)
  await lockCmsReferences(req.payload, req)
  if (operation === 'create' || operation === 'update') {
    const data = 'data' in args ? args.data as Record<string, unknown> : {}
    if (data._status === 'published' && !hasPublicationScope) {
      throw new APIError('portal_page_publication_context_required', 403, undefined, true)
    }
    if (operation === 'update') {
      if (!('id' in args) || !args.id) throw new APIError('portal_page_update_requires_single_id', 400, undefined, true)
      await (await requireCmsTransaction(req.payload, req)).execute(
        sql`SELECT id FROM portal_pages WHERE id = ${String(args.id)}::uuid FOR UPDATE`,
      )
    }
    portalPageSaveModes.set(req, { draftSave: 'draft' in args && args.draft === true })
  } else if (operation === 'delete') {
    if (!('id' in args) || !args.id) throw new APIError('portal_page_delete_requires_single_id', 400, undefined, true)
    await (await requireCmsTransaction(req.payload, req)).execute(
      sql`SELECT id FROM portal_pages WHERE id = ${String(args.id)}::uuid FOR UPDATE`,
    )
  }
}

const normalizePortalPageBeforeChange: CollectionBeforeChangeHook = async ({ data, originalDoc, operation, req }) => {
  await requireCmsTransaction(req.payload, req)
  const input = data as Record<string, unknown>
  const original = (originalDoc || {}) as Record<string, unknown>
  const row = { ...original, ...input }
  const pageID = String(original.id ?? input.id ?? '')
  const publicationScope = isPortalPagePublication(req, pageID || undefined)
  const publicationOperation = publicationScope ? portalPagePublicationOperation(req) : null
  const currentStatus = original._status ?? 'draft'
  const nextStatus = publicationOperation === 'publish' ? 'published'
    : publicationOperation === 'unpublish' ? 'draft' : row._status ?? currentStatus
  validatePortalPageStatusTransition(nextStatus, currentStatus, publicationScope, portalPageSaveModes.get(req)?.draftSave === true)

  row.title = plainText(row.title, { min: 1, max: 200, code: 'invalid_portal_page_title' })
  row.slug = validatePortalPageSlugChange(row.slug, original.slug, currentStatus)
  row.summary = plainText(row.summary ?? '', { max: 1000, multiline: true, code: 'invalid_portal_page_summary' })
  const coverID = relationID(row.cover)
  const cover = coverID === null ? null : {
    asset_id: coverID,
    alt: plainText(row.coverAlt, { min: 1, max: 300, code: 'invalid_portal_page_cover_alt' }),
  }
  const body = projectPortalPageContent(row.body ?? [])
  await assertPortalPageCategoryReferences(req.payload, row.categories ?? [], req)
  await assertPortalPageMediaReferences(req.payload, { cover, body }, req, { requireComplete: nextStatus === 'published' })

  const actorUID = requestPortalUID(req)
  const originalPublishedAt = original.publishedAt ?? null
  if (publicationOperation === 'publish') {
    input._status = 'published'
    input.publishedAt = new Date().toISOString()
  } else if (publicationOperation === 'unpublish') {
    input._status = 'draft'
    input.publishedAt = null
  } else {
    if (Object.hasOwn(input, 'publishedAt') && input.publishedAt !== originalPublishedAt) {
      throw new APIError('portal_page_published_at_server_owned', 403, undefined, true)
    }
    input.publishedAt = originalPublishedAt
  }
  input.title = row.title
  input.slug = row.slug
  input.summary = row.summary
  input.coverAlt = cover?.alt ?? null
  input.createdBy = original.createdBy ?? actorUID
  input.updatedBy = actorUID
  portalPageSaveModes.delete(req)
  return input
}

export const PortalPages: CollectionConfig = {
  slug: 'portal-pages',
  labels: { singular: 'Página modular', plural: 'Páginas modulares' },
  lockDocuments: false,
  disableBulkDelete: true,
  admin: { useAsTitle: 'title', defaultColumns: ['title', 'slug', '_status', 'publishedAt'] },
  access: {
    admin: portalPageEditorAccess,
    create: portalPageEditorAccess,
    read: portalPageEditorAccess,
    update: portalPageEditorAccess,
    delete: portalPageEditorAccess,
    readVersions: portalPageEditorAccess,
  },
  versions: { maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } },
  hooks: { beforeOperation: [protectPortalPageOperation], beforeValidate: [stampPortalPageAuthors], beforeChange: [normalizePortalPageBeforeChange] },
  fields: [
    { name: 'title', label: 'Título', type: 'text', required: true, maxLength: 200 },
    { name: 'slug', label: 'Endereço canônico', type: 'text', required: true, maxLength: 160, unique: true, index: true,
      hooks: { beforeValidate: [({ value }) => value === undefined ? value : normalizeSlug(value)] } },
    { name: 'summary', label: 'Resumo', type: 'textarea', maxLength: 1000 },
    { name: 'cover', label: 'Capa', type: 'relationship', relationTo: 'portal-page-media',
      filterOptions: { state: { equals: 'complete' }, mimeType: { in: [...PORTAL_PAGE_IMAGE_MIMES] } },
      admin: { allowCreate: false, allowEdit: false } },
    { name: 'coverAlt', label: 'Texto alternativo da capa', type: 'text', maxLength: 300 },
    { name: 'categories', label: 'Categorias', type: 'relationship', relationTo: 'portal-page-categories', hasMany: true, maxRows: 20,
      admin: { allowCreate: false, allowEdit: false } },
    { name: 'body', label: 'Conteúdo da página', type: 'blocks', blocks: portalPageBlocks, maxRows: 100, defaultValue: [] },
    { name: 'publishedAt', label: 'Publicado em', type: 'date', admin: { readOnly: true }, access: noDirectFieldWrite },
    { name: 'createdBy', label: 'Criado por (UID do Portal)', type: 'text', maxLength: 128,
      admin: { readOnly: true }, access: noDirectFieldWrite },
    { name: 'updatedBy', label: 'Atualizado por (UID do Portal)', type: 'text', maxLength: 128,
      admin: { readOnly: true }, access: noDirectFieldWrite },
  ],
}

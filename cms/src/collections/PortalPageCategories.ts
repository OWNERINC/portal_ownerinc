import { APIError, type CollectionBeforeChangeHook, type CollectionBeforeOperationHook, type CollectionConfig } from 'payload'
import { canManagePortalPages, portalPageEditorAccess } from '../auth/portal-pages-access'
import { lockCmsReferences, requireCmsTransaction } from '../publication/transaction'
import { assertPortalPageCategoryOrphan } from '../portal-pages/persistence'
import { normalizePortalPageCategory } from '../portal-pages/validation'

const protectCategoryOperation: CollectionBeforeOperationHook = async ({ operation, req, args }) => {
  if (!['create', 'update', 'delete'].includes(operation)) return
  if (!canManagePortalPages({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
  await requireCmsTransaction(req.payload, req)
  await lockCmsReferences(req.payload, req)
  if (operation === 'delete') {
    if (!('id' in args) || !args.id) throw new APIError('portal_page_category_delete_requires_single_id', 400, undefined, true)
    await assertPortalPageCategoryOrphan(req.payload, String(args.id), req)
  }
}

const normalizeCategoryBeforeChange: CollectionBeforeChangeHook = ({ data, originalDoc }) => {
  const input = data as Record<string, unknown>
  const original = (originalDoc || {}) as Record<string, unknown>
  const normalized = normalizePortalPageCategory({
    name: input.name ?? original.name,
    slug: input.slug ?? original.slug,
    description: Object.hasOwn(input, 'description') ? input.description : original.description,
  })
  return { ...data, ...normalized }
}

export const PortalPageCategories: CollectionConfig = {
  slug: 'portal-page-categories',
  labels: { singular: 'Categoria de página', plural: 'Categorias de páginas' },
  lockDocuments: false,
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'slug'] },
  access: {
    admin: portalPageEditorAccess,
    create: portalPageEditorAccess,
    read: portalPageEditorAccess,
    update: portalPageEditorAccess,
    delete: portalPageEditorAccess,
  },
  hooks: { beforeOperation: [protectCategoryOperation], beforeChange: [normalizeCategoryBeforeChange] },
  fields: [
    { name: 'name', label: 'Nome', type: 'text', required: true, maxLength: 100 },
    { name: 'slug', label: 'Endereço canônico', type: 'text', required: true, maxLength: 160, unique: true, index: true },
    { name: 'description', label: 'Descrição', type: 'textarea', maxLength: 1000 },
  ],
}

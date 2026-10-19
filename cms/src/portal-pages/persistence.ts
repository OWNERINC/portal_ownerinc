import { APIError, type Payload, type PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { canManagePortalPages } from '../auth/portal-pages-access'
import type { PortalPageBlock } from './blocks'
import type { PortalPagePublicationInput } from './contracts'
import { assertReferenceStoreCoverage } from '../media/references'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { array, record, uuid } from './primitives'
import { PORTAL_PAGE_IMAGE_MIMES, PORTAL_PAGE_MEDIA_MIMES } from './primitives'
import {
  validatePortalPageMediaMetadata,
  validatePortalPagePublicationInput,
  normalizePortalPageContent,
} from './validation'

export { projectPortalPageContent } from './projection'

type PortalPageRefInput = { cover: null | { asset_id: string; alt: string }; body: unknown }
type PortalPagePublicationScope = {
  id: string
  expectedVersionID: string
  operation: PortalPagePublicationInput['operation']
  session: unknown
}
type PortalPageMediaMutationScope = {
  actorUid: string
  operation: 'create' | 'update' | 'delete'
  session: unknown
}

const pagePublicationScopes = new WeakMap<PayloadRequest, PortalPagePublicationScope>()
const pageMediaMutationScopes = new WeakMap<PayloadRequest, PortalPageMediaMutationScope>()

const unavailable = (code = 'portal_page_reference_store_not_covered') => new APIError(code, 503, undefined, true)
const conflict = (code: string) => new APIError(code, 409, undefined, true)
const denied = (code: string) => new APIError(code, 403, undefined, true)

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable()
  return value as Record<string, unknown>
}

function relationID(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  const raw = typeof value === 'string' ? value : asRecord(value).id
  if (typeof raw !== 'string') throw unavailable()
  try { return uuid(raw, 'portal_page_reference_store_not_covered') }
  catch { throw unavailable() }
}

function addRelation(target: Set<string>, value: unknown): void {
  const id = relationID(value)
  if (id) target.add(id)
}

/** Collect known page-media fields from persisted Payload shapes; unknown blocks fail closed. */
export function collectPortalPageMediaIds(document: unknown): Set<string> {
  const page = asRecord(document)
  const ids = new Set<string>()
  addRelation(ids, page.cover)
  const body = page.body == null ? [] : array(page.body, 'portal_page_reference_store_not_covered')
  for (const rawBlock of body) {
    const block = asRecord(rawBlock)
    const type = block.blockType ?? block.type
    if (type === 'image' || type === 'video' || type === 'pdf') addRelation(ids, block.asset ?? block.media)
    else if (type === 'gallery') {
      const images = block.images == null ? [] : array(block.images, 'portal_page_reference_store_not_covered')
      for (const rawImage of images) addRelation(ids, asRecord(rawImage).asset)
    } else if (!['heading', 'rich_text', 'embed', 'callout', 'link', 'divider'].includes(String(type))) {
      throw unavailable()
    }
  }
  return ids
}

/** Collect category relationships from current documents and retained Payload Versions. */
export function collectPortalPageCategoryIds(document: unknown): Set<string> {
  const page = asRecord(document)
  const ids = new Set<string>()
  const categories = page.categories == null ? [] : Array.isArray(page.categories) ? page.categories : [page.categories]
  for (const category of categories) addRelation(ids, category)
  return ids
}

function expectedMimes(block: PortalPageBlock): Array<typeof PORTAL_PAGE_MEDIA_MIMES[number]> {
  switch (block.type) {
    case 'image': return [...PORTAL_PAGE_IMAGE_MIMES]
    case 'gallery': return [...PORTAL_PAGE_IMAGE_MIMES]
    case 'video': return ['video/mp4', 'video/webm']
    case 'pdf': return ['application/pdf']
    default: return []
  }
}

type PortalPageMediaUsage = { id: string; allowedMimes: ReadonlySet<string> }

function mediaMimeRequirements(page: PortalPageRefInput): PortalPageMediaUsage[] {
  const requirements: PortalPageMediaUsage[] = []
  const add = (idValue: unknown, accepted: readonly string[]) => {
    const id = relationID(idValue)
    if (!id) return
    requirements.push({ id, allowedMimes: new Set(accepted) })
  }
  if (page.cover !== null) add(page.cover.asset_id, PORTAL_PAGE_IMAGE_MIMES)
  const blocks = normalizePortalPageContent(page.body)
  for (const block of blocks) {
    if (block.type === 'image' || block.type === 'video' || block.type === 'pdf') add(block.asset_id, expectedMimes(block))
    else if (block.type === 'gallery') for (const image of block.images) add(image.asset_id, expectedMimes(block))
  }
  return requirements
}

/** Validate all selected categories under row locks while the shared CMS lock is held. */
export async function assertPortalPageCategoryReferences(payload: Payload, values: unknown, req: PayloadRequest): Promise<string[]> {
  const categories = values == null ? [] : Array.isArray(values) ? values : [values]
  const ids = [...new Set(categories.map(value => {
    const id = relationID(value)
    if (!id) throw new APIError('invalid_portal_page_category_reference', 400, undefined, true)
    return id
  }))]
  if (ids.length > 20) throw new APIError('invalid_portal_page_category_reference', 400, undefined, true)
  return withCmsTransaction(payload, req, async transactionReq => {
    const db = await requireCmsTransaction(payload, transactionReq)
    for (const id of ids) {
      await db.execute(sql`SELECT id FROM portal_page_categories WHERE id = ${id}::uuid FOR SHARE`)
      const category = await payload.findByID({ collection: 'portal-page-categories', id, req: transactionReq,
        overrideAccess: true, depth: 0, disableErrors: true })
      if (!category) throw new APIError('invalid_portal_page_category_reference', 400, undefined, true)
    }
    return ids
  })
}

/** Validate existence, completeness (when required), and block-specific MIME under row locks. */
export async function assertPortalPageMediaReferences(payload: Payload, page: PortalPageRefInput, req: PayloadRequest,
  options: { requireComplete?: boolean } = {}): Promise<string[]> {
  return withCmsTransaction(payload, req, async transactionReq => {
    const db = await requireCmsTransaction(payload, transactionReq)
    const requirements = mediaMimeRequirements(page)
    const checked = new Map<string, ReturnType<typeof validatePortalPageMediaMetadata>>()
    for (const { id, allowedMimes } of requirements) {
      let metadata = checked.get(id)
      if (!metadata) {
        await db.execute(sql`SELECT id FROM portal_page_media WHERE id = ${id}::uuid FOR SHARE`)
        const media = await payload.findByID({ collection: 'portal-page-media', id, req: transactionReq,
          overrideAccess: true, depth: 0, disableErrors: true }) as Record<string, unknown> | null
        if (!media) throw new APIError('invalid_portal_page_media_reference', 400, undefined, true)
        try {
          metadata = validatePortalPageMediaMetadata({
            originalName: media.originalName, storageKey: media.storageKey, mimeType: media.mimeType,
            filesize: media.filesize, sha256: media.sha256, state: media.state,
            uploadedBy: media.uploadedBy, completedAt: media.completedAt ?? null,
          })
        } catch {
          throw new APIError('invalid_portal_page_media_reference', 400, undefined, true)
        }
        checked.set(id, metadata)
      }
      if (!allowedMimes.has(metadata.mimeType) || (options.requireComplete !== false && metadata.state !== 'complete')) {
        throw new APIError('invalid_portal_page_media_reference', 400, undefined, true)
      }
    }
    return [...new Set(requirements.map(({ id }) => id))]
  })
}

async function scanPortalPageReferences(payload: Payload, req: PayloadRequest,
  visit: (document: Record<string, unknown>) => boolean | Promise<boolean>): Promise<boolean> {
  const scan = async (kind: 'current' | 'versions', draft?: boolean): Promise<boolean> => {
    for (let page = 1; page <= 1000; page++) {
      await requireCmsTransaction(payload, req)
      if (kind === 'versions') {
        const result = await payload.findVersions({ collection: 'portal-pages', req, depth: 0, overrideAccess: true,
          limit: 100, page, sort: 'id' })
        for (const row of result.docs) if (await visit(asRecord(row.version))) return true
        if (!result.hasNextPage) return false
      } else {
        const result = await payload.find({ collection: 'portal-pages', req, draft, depth: 0, overrideAccess: true,
          limit: 100, page, sort: 'id' })
        for (const row of result.docs) if (await visit(asRecord(row))) return true
        if (!result.hasNextPage) return false
      }
    }
    throw new APIError('portal_page_reference_scan_limit', 503, undefined, true)
  }
  if (await scan('current', true)) return true
  if (await scan('current', false)) return true
  return scan('versions')
}

/** Reject deletion while any saved current draft or retained version refers to a page media row. */
export async function assertPortalPageMediaOrphan(payload: Payload, rawID: string, req: PayloadRequest): Promise<void> {
  const id = uuid(rawID)
  await withCmsTransaction(payload, req, async transactionReq => {
    assertReferenceStoreCoverage(payload)
    const db = await requireCmsTransaction(payload, transactionReq)
    await db.execute(sql`SELECT id FROM portal_page_media WHERE id = ${id}::uuid FOR UPDATE`)
    const referenced = await scanPortalPageReferences(payload, transactionReq, document => collectPortalPageMediaIds(document).has(id))
    if (referenced) throw conflict('portal_page_media_is_referenced')
  })
}

/** Reject category deletion while any current page/draft or retained version references it. */
export async function assertPortalPageCategoryOrphan(payload: Payload, rawID: string, req: PayloadRequest): Promise<void> {
  const id = uuid(rawID)
  await withCmsTransaction(payload, req, async transactionReq => {
    assertReferenceStoreCoverage(payload)
    const db = await requireCmsTransaction(payload, transactionReq)
    await db.execute(sql`SELECT id FROM portal_page_categories WHERE id = ${id}::uuid FOR UPDATE`)
    const referenced = await scanPortalPageReferences(payload, transactionReq, document => collectPortalPageCategoryIds(document).has(id))
    if (referenced) throw conflict('portal_page_category_is_referenced')
  })
}

async function latestPortalPageVersion(req: PayloadRequest, id: string) {
  await requireCmsTransaction(req.payload, req)
  const result = await req.payload.findVersions({ collection: 'portal-pages', req,
    where: { and: [{ parent: { equals: id } }, { latest: { equals: true } }] },
    depth: 0, overrideAccess: true, limit: 1, sort: '-updatedAt' })
  return result.docs[0]
}

export function isPortalPagePublication(req: PayloadRequest, pageID?: string): boolean {
  const scope = pagePublicationScopes.get(req)
  if (!scope || (pageID && scope.id !== pageID)) return false
  return true
}

/**
 * Server-only expected-version scope for the later publish/unpublish endpoint.
 * It owns/joins a transaction, takes the shared CMS lock then the page row lock,
 * and exposes no publication capability unless the exact latest saved Version ID matches.
 */
export async function withExpectedPortalPageVersion<T>(req: PayloadRequest, input: PortalPagePublicationInput,
  work: (req: PayloadRequest, version: Record<string, unknown>) => Promise<T>): Promise<T> {
  if (!canManagePortalPages({ req })) throw denied('editorial_permission_denied')
  const parsed = validatePortalPagePublicationInput(input)
  return withCmsTransaction(req.payload, req, async transactionReq => {
    const db = await requireCmsTransaction(req.payload, transactionReq)
    await db.execute(sql`SELECT id FROM portal_pages WHERE id = ${parsed.id}::uuid FOR UPDATE`)
    const current = await req.payload.findByID({ collection: 'portal-pages', id: parsed.id, req: transactionReq,
      overrideAccess: true, depth: 0, disableErrors: true })
    if (!current) throw new APIError('portal_page_not_found', 404, undefined, true)
    const version = await latestPortalPageVersion(transactionReq, parsed.id)
    const versionRecord = version as unknown as Record<string, unknown> | undefined
    if (!versionRecord || String(versionRecord.id) !== parsed.expected_version_id ||
      versionRecord.latest !== true || versionRecord.autosave !== false) {
      throw conflict('portal_page_version_conflict')
    }
    if (pagePublicationScopes.has(transactionReq)) throw conflict('portal_page_publication_scope_active')
    const session = await requireCmsTransaction(req.payload, transactionReq)
    pagePublicationScopes.set(transactionReq, { id: parsed.id, expectedVersionID: parsed.expected_version_id,
      operation: parsed.operation, session })
    try { return await work(transactionReq, versionRecord) }
    finally { pagePublicationScopes.delete(transactionReq) }
  })
}

export function portalPagePublicationOperation(req: PayloadRequest): PortalPagePublicationInput['operation'] | null {
  return isPortalPagePublication(req) ? pagePublicationScopes.get(req)?.operation || null : null
}

export function portalPagePublicationPageID(req: PayloadRequest): string | null {
  return isPortalPagePublication(req) ? pagePublicationScopes.get(req)?.id || null : null
}

export function isPortalPageMediaMutation(req: PayloadRequest, operation?: PortalPageMediaMutationScope['operation']): boolean {
  const scope = pageMediaMutationScopes.get(req)
  if (!scope || (operation && scope.operation !== operation)) return false
  return true
}

export function portalPageMediaMutationActor(req: PayloadRequest): string | null {
  return isPortalPageMediaMutation(req) ? pageMediaMutationScopes.get(req)?.actorUid || null : null
}

/** Explicit trusted Local API scope for future metadata ingress and lifecycle operations. */
export async function withPortalPageMediaMutation<T>(req: PayloadRequest, actorUid: string,
  operation: PortalPageMediaMutationScope['operation'], work: (req: PayloadRequest) => Promise<T>): Promise<T> {
  const actor = typeof actorUid === 'string' ? actorUid.trim() : ''
  if (!actor || actor.length > 128 || /[\p{Cc}]/u.test(actor)) throw denied('portal_page_media_actor_required')
  return withCmsTransaction(req.payload, req, async transactionReq => {
    if (pageMediaMutationScopes.has(transactionReq)) throw conflict('portal_page_media_mutation_scope_active')
    const session = await requireCmsTransaction(req.payload, transactionReq)
    pageMediaMutationScopes.set(transactionReq, { actorUid: actor, operation, session })
    try { return await work(transactionReq) }
    finally { pageMediaMutationScopes.delete(transactionReq) }
  })
}

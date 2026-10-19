import { APIError, type Payload, type PayloadRequest } from 'payload'
import { withCmsTransaction } from '../publication/transaction'
import {
  assertPortalPageCategoryReferences,
  loadPortalPageMediaReferences,
  type PortalPageMediaReadRecord,
} from './persistence'
import type { PortalPageDTO } from './contracts'
import { record, uuid } from './primitives'
import { projectPortalPageContent } from './projection'
import { normalizeSlug, validatePortalPageDTO } from './validation'

const PAGE_BATCH_SIZE = 100
const PAGE_SCAN_MAX = 1000
const PAGE_JSON_MAX_BYTES = 16 * 1024 * 1024
const INVALID_PUBLISHED_PAGE = new APIError('portal_page_projection_invalid', 400, undefined, true)
const NOT_FOUND = () => new APIError('not_found', 404, undefined, true)
const UNAVAILABLE = () => new APIError('portal_pages_unavailable', 503, undefined, true)

export type PortalPageReadActor = {
  uid: string
  email: string
  name: string | null
  canManageKnowledge: boolean
}
export type PortalPageListInput = { limit: number; offset: number; category?: string }
export type PortalPagePageResult = { rows: PortalPageDTO[]; count: number }
export type PortalPageCategoryDTO = { id: string; slug: string; name: string; count: number }
export type PortalPageReadResult = { dto: PortalPageDTO; media: Map<string, PortalPageMediaReadRecord> }

function fail(status: number, code: string): never {
  throw new APIError(code, status, undefined, true)
}

function actorIsValid(actor: unknown): actor is PortalPageReadActor {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return false
  const value = actor as Record<string, unknown>
  return Object.keys(value).length === 4 && typeof value.uid === 'string' && value.uid.length > 0 && value.uid.length <= 128 &&
    typeof value.email === 'string' && value.email.length > 0 && value.email.length <= 320 &&
    (value.name === null || typeof value.name === 'string') && typeof value.canManageKnowledge === 'boolean'
}

function canonicalSlug(value: unknown): string {
  if (typeof value !== 'string') fail(400, 'invalid_request')
  let normalized: string
  try { normalized = normalizeSlug(value) } catch { fail(400, 'invalid_request') }
  if (normalized !== value) fail(400, 'invalid_request')
  return normalized
}

function relationID(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const raw = typeof value === 'string' ? value : record(value, 'invalid_portal_page_reference').id
  return uuid(raw, 'invalid_portal_page_reference')
}

function relationList(value: unknown): unknown[] {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const source = value instanceof Date ? value.toISOString() : value
  if (typeof source !== 'string' || !Number.isFinite(Date.parse(source))) throw INVALID_PUBLISHED_PAGE
  return new Date(source).toISOString()
}

async function resolveCategories(payload: Payload, req: PayloadRequest, page: Record<string, unknown>) {
  const raw = relationList(page.categories)
  const ids = await assertPortalPageCategoryReferences(payload, raw, req)
  const categories = await Promise.all(ids.map(async id => {
    const value = await payload.findByID({ collection: 'portal-page-categories', id, req, overrideAccess: true, depth: 0, disableErrors: true }) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw INVALID_PUBLISHED_PAGE
    const category = value as Record<string, unknown>
    if (category.id !== id || typeof category.slug !== 'string' || typeof category.name !== 'string') throw INVALID_PUBLISHED_PAGE
    return { id, slug: category.slug, name: category.name }
  }))
  return categories
}

async function projectPage(payload: Payload, req: PayloadRequest, pageID: string, source: Record<string, unknown>,
  assetScope: PortalPageDTO['asset_scope'], revision: PortalPageDTO['revision']): Promise<PortalPageDTO> {
  try {
    const coverID = relationID(source.cover)
    const cover = coverID === null ? null : {
      asset_id: coverID,
      alt: source.coverAlt,
    }
    const dto = {
      id: pageID,
      slug: source.slug,
      title: source.title,
      summary: source.summary ?? '',
      cover,
      categories: await resolveCategories(payload, req, source),
      published_at: isoDate(source.publishedAt),
      content_version: 1,
      asset_scope: assetScope,
      content_blocks: projectPortalPageContent(source.body ?? []),
      revision,
    }
    return validatePortalPageDTO(dto)
  } catch (error) {
    if (error instanceof APIError && error.status === 503) throw error
    throw INVALID_PUBLISHED_PAGE
  }
}

async function resolveMedia(payload: Payload, req: PayloadRequest, dto: PortalPageDTO, requireComplete: boolean) {
  try {
    return await loadPortalPageMediaReferences(payload, { cover: dto.cover, body: dto.content_blocks }, req, { requireComplete })
  } catch (error) {
    if (error instanceof APIError && error.status === 503) throw error
    throw INVALID_PUBLISHED_PAGE
  }
}

function publicFields(dto: PortalPageDTO) {
  const { asset_scope: _scope, revision: _revision, ...fields } = dto
  return fields
}

async function currentPublishedVersion(payload: Payload, req: PayloadRequest, pageID: string) {
  const result = await payload.findVersions({
    collection: 'portal-pages', req, depth: 1, overrideAccess: true, pagination: false, limit: 1,
    sort: ['-updatedAt', '-id'],
    where: { and: [{ parent: { equals: pageID } }, { 'version._status': { equals: 'published' } }] },
  })
  const saved = result.docs[0] as unknown as Record<string, unknown> | undefined
  if (!saved || uuid(saved.parent, 'invalid_portal_page_version') !== pageID || typeof saved.id !== 'string') return null
  const versionID = uuid(saved.id, 'invalid_portal_page_version')
  const source = record(saved.version, 'invalid_portal_page_version')
  if (source._status !== 'published') return null
  return { versionID, source }
}

/** Resolve only the latest saved published Version that exactly matches the published main document. */
async function publishedPage(payload: Payload, req: PayloadRequest, input: Record<string, unknown>): Promise<PortalPageReadResult | null> {
  const pageID = uuid(input.id, 'invalid_request')
  const page = record(input.page, 'invalid_portal_page_document')
  if (page.id !== pageID || page._status !== 'published') return null
  const saved = await currentPublishedVersion(payload, req, pageID)
  if (!saved) throw UNAVAILABLE()
  const current = await projectPage(payload, req, pageID, page, 'portal-pages', { id: saved.versionID, status: 'published' })
  const snapshot = await projectPage(payload, req, pageID, saved.source, 'portal-pages', { id: saved.versionID, status: 'published' })
  if (JSON.stringify(publicFields(current)) !== JSON.stringify(publicFields(snapshot))) throw UNAVAILABLE()
  const media = await resolveMedia(payload, req, current, true)
  return { dto: current, media }
}

async function findPublishedByID(payload: Payload, req: PayloadRequest, id: string) {
  const page = await payload.findByID({ collection: 'portal-pages', id, req, overrideAccess: true, depth: 1, draft: false, disableErrors: true }) as unknown
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null
  const value = page as Record<string, unknown>
  if (value._status !== 'published') return null
  return publishedPage(payload, req, { id, page: value })
}

async function findPublishedBySlug(payload: Payload, req: PayloadRequest, slug: string) {
  const result = await payload.find({ collection: 'portal-pages', req, depth: 1, draft: false, overrideAccess: true,
    limit: 2, pagination: false, sort: ['-publishedAt', '-id'],
    where: { and: [{ slug: { equals: slug } }, { _status: { equals: 'published' } }] } })
  if (result.docs.length > 1) throw UNAVAILABLE()
  const page = result.docs[0] as unknown as Record<string, unknown> | undefined
  if (!page || page._status !== 'published' || typeof page.id !== 'string') return null
  return publishedPage(payload, req, { id: page.id, page })
}

async function scanPublished(payload: Payload, req: PayloadRequest, visit: (page: PortalPageReadResult) => void | Promise<void>) {
  for (let pageNumber = 1; pageNumber <= PAGE_SCAN_MAX; pageNumber++) {
    const result = await payload.find({ collection: 'portal-pages', req, depth: 1, draft: false, overrideAccess: true,
      limit: PAGE_BATCH_SIZE, page: pageNumber, sort: ['-publishedAt', '-id'],
      where: { _status: { equals: 'published' } } })
    for (const row of result.docs) {
      const value = row as unknown as Record<string, unknown>
      if (value._status !== 'published' || typeof value.id !== 'string') continue
      try {
        const eligible = await publishedPage(payload, req, { id: value.id, page: value })
        if (eligible) await visit(eligible)
      } catch (error) {
        // Invalid editorial snapshots are not catalog entries; operational failures remain visible.
        if (error instanceof APIError && error.status === 400) continue
        throw error
      }
    }
    if (!result.hasNextPage) return
  }
  throw UNAVAILABLE()
}

function checkListInput(input: PortalPageListInput): PortalPageListInput {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50 ||
    !Number.isSafeInteger(input.offset) || input.offset < 0 || input.offset > 1_000_000 ||
    Object.keys(input).some(key => !['limit', 'offset', 'category'].includes(key))) fail(400, 'invalid_request')
  if (Object.hasOwn(input, 'category')) canonicalSlug(input.category)
  return input
}

export function queryPortalPages(req: PayloadRequest, rawInput: PortalPageListInput, actor: PortalPageReadActor): Promise<PortalPagePageResult> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  const input = checkListInput(rawInput)
  return withCmsTransaction(req.payload, req, async transactionReq => {
    let count = 0
    const rows: PortalPageDTO[] = []
    await scanPublished(req.payload, transactionReq, page => {
      if (input.category && !page.dto.categories.some(category => category.slug === input.category)) return
      const index = count++
      if (index >= input.offset && index < input.offset + input.limit) rows.push(page.dto)
    })
    const result = { rows, count }
    if (rows.length > input.limit || Buffer.byteLength(JSON.stringify(result), 'utf8') > PAGE_JSON_MAX_BYTES) throw UNAVAILABLE()
    return result
  })
}

export function queryPortalPagePublishedDetail(req: PayloadRequest, rawSlug: string, actor: PortalPageReadActor): Promise<PortalPageDTO | null> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  const slug = canonicalSlug(rawSlug)
  return withCmsTransaction(req.payload, req, async transactionReq => (await findPublishedBySlug(req.payload, transactionReq, slug))?.dto ?? null)
}

export function queryPortalPageCategories(req: PayloadRequest, actor: PortalPageReadActor): Promise<PortalPageCategoryDTO[]> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  return withCmsTransaction(req.payload, req, async transactionReq => {
    const counts = new Map<string, PortalPageCategoryDTO>()
    await scanPublished(req.payload, transactionReq, page => {
      for (const category of page.dto.categories) {
        const value = counts.get(category.id)
        if (value) value.count++
        else counts.set(category.id, { ...category, count: 1 })
      }
    })
    const result = [...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    if (result.length > 10_000 || Buffer.byteLength(JSON.stringify(result), 'utf8') > PAGE_JSON_MAX_BYTES) throw UNAVAILABLE()
    return result
  })
}

export function queryPortalPagePreview(req: PayloadRequest, rawPageID: string, rawVersionID: string,
  actor: PortalPageReadActor): Promise<PortalPageDTO | null> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  if (!actor.canManageKnowledge) return Promise.reject(new APIError('permission_denied', 403, undefined, true))
  const pageID = uuid(rawPageID, 'invalid_request'), versionID = uuid(rawVersionID, 'invalid_request')
  return withCmsTransaction(req.payload, req, async transactionReq => {
    const result = await req.payload.findVersions({ collection: 'portal-pages', req: transactionReq, depth: 1, overrideAccess: true,
      pagination: false, limit: 2, where: { and: [{ id: { equals: versionID } }, { parent: { equals: pageID } }] } })
    if (result.docs.length === 0) return null
    if (result.docs.length !== 1) throw UNAVAILABLE()
    const saved = result.docs[0] as unknown as Record<string, unknown>
    if (saved.id !== versionID || saved.parent !== pageID) return null
    const source = record(saved.version, 'invalid_portal_page_version')
    if (!['draft', 'published'].includes(String(source._status))) return null
    const dto = await projectPage(req.payload, transactionReq, pageID, source, 'portal-pages-preview',
      { id: versionID, status: source._status as 'draft' | 'published' })
    await resolveMedia(req.payload, transactionReq, dto, false)
    if (Buffer.byteLength(JSON.stringify(dto), 'utf8') > 6 * 1024 * 1024) throw UNAVAILABLE()
    return dto
  })
}

export async function resolvePublishedPortalPageForAsset(req: PayloadRequest, pageID: string, revisionID: string): Promise<PortalPageReadResult | null> {
  const page = await findPublishedByID(req.payload, req, uuid(pageID, 'invalid_request'))
  if (!page || page.dto.revision.id !== uuid(revisionID, 'invalid_request')) return null
  return page
}

export async function resolvePreviewPortalPageForAsset(req: PayloadRequest, pageID: string, versionID: string,
  actor: PortalPageReadActor): Promise<PortalPageReadResult | null> {
  if (!actorIsValid(actor) || !actor.canManageKnowledge) fail(403, 'permission_denied')
  const parsedPageID = uuid(pageID, 'invalid_request'), parsedVersionID = uuid(versionID, 'invalid_request')
  const result = await req.payload.findVersions({ collection: 'portal-pages', req, depth: 1, overrideAccess: true, pagination: false,
    limit: 2, where: { and: [{ id: { equals: parsedVersionID } }, { parent: { equals: parsedPageID } }] } })
  if (result.docs.length === 0) return null
  if (result.docs.length !== 1) throw UNAVAILABLE()
  const saved = result.docs[0] as unknown as Record<string, unknown>
  if (saved.id !== parsedVersionID || saved.parent !== parsedPageID) return null
  const source = record(saved.version, 'invalid_portal_page_version')
  if (!['draft', 'published'].includes(String(source._status))) return null
  const dto = await projectPage(req.payload, req, parsedPageID, source, 'portal-pages-preview',
    { id: parsedVersionID, status: source._status as 'draft' | 'published' })
  const media = await resolveMedia(req.payload, req, dto, true)
  return { dto, media }
}

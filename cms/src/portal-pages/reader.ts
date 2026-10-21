import { APIError, type Payload, type PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import {
  requireCmsTransaction,
  withCmsReadOperation,
  withCmsReadSnapshot,
  withCmsTransaction,
  type CmsTransactionOptions,
} from '../publication/transaction'
import {
  assertPortalPageCategoryReferences,
  loadPortalPageMediaReferences,
  type PortalPageMediaReadRecord,
} from './persistence'
import type { PortalPageDTO } from './contracts'
import { record, uuid } from './primitives'
import { projectPortalPageContent } from './projection'
import { normalizeSlug, validatePortalPageDTO } from './validation'

const PAGE_BATCH_SIZE = 10
const PAGE_SCAN_MAX = Math.ceil(100_000 / PAGE_BATCH_SIZE) + 1
const PAGE_SCAN_MAX_ROWS = 100_000
const DEFAULT_READ_BUDGET_MS = 4_000
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
export type PortalPageReadOptions = { signal?: AbortSignal; deadlineAt?: number; now?: () => number }

function effectiveReadOptions(options: PortalPageReadOptions = {}): CmsTransactionOptions & { deadlineAt: number } {
  const now = options.now ?? Date.now
  return { signal: options.signal, now, deadlineAt: options.deadlineAt ?? now() + DEFAULT_READ_BUDGET_MS }
}

function assertReadBudget(options: CmsTransactionOptions & { deadlineAt: number }): void {
  if (options.signal?.aborted || (options.now?.() ?? Date.now()) >= options.deadlineAt) throw UNAVAILABLE()
}

async function withReadBatch<T>(req: PayloadRequest, options: CmsTransactionOptions & { deadlineAt: number },
  work: (transactionReq: PayloadRequest) => Promise<T>): Promise<T> {
  assertReadBudget(options)
  // Read batches own short transactions even when Payload supplied an outer request transaction.
  const isolatedRequest = { ...req, transactionID: undefined } as PayloadRequest
  return withCmsTransaction(req.payload, isolatedRequest, async transactionReq => {
    assertReadBudget(options)
    const result = await work(transactionReq)
    assertReadBudget(options)
    return result
  }, options)
}

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

async function resolveCategories(payload: Payload, req: PayloadRequest, page: Record<string, unknown>,
  options: CmsTransactionOptions) {
  const raw = relationList(page.categories)
  const ids = await assertPortalPageCategoryReferences(payload, raw, req, options)
  const categories = []
  for (const id of ids) {
    const value = await withCmsReadOperation(options, () => payload.findByID({ collection: 'portal-page-categories', id, req,
      overrideAccess: true, depth: 0, disableErrors: true })) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw INVALID_PUBLISHED_PAGE
    const category = value as Record<string, unknown>
    if (category.id !== id || typeof category.slug !== 'string' || typeof category.name !== 'string') throw INVALID_PUBLISHED_PAGE
    categories.push({ id, slug: category.slug, name: category.name })
  }
  return categories
}

async function projectPage(payload: Payload, req: PayloadRequest, pageID: string, source: Record<string, unknown>,
  assetScope: PortalPageDTO['asset_scope'], revision: PortalPageDTO['revision'],
  options: CmsTransactionOptions = {}): Promise<PortalPageDTO> {
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
      categories: await resolveCategories(payload, req, source, options),
      published_at: isoDate(source.publishedAt),
      content_version: 1,
      asset_scope: assetScope,
      content_blocks: projectPortalPageContent(source.body ?? []),
      revision,
    }
    return validatePortalPageDTO(dto)
  } catch (error) {
    if (error instanceof APIError && error.status === 503) throw error
    if (error instanceof APIError && error.status === 400) throw INVALID_PUBLISHED_PAGE
    throw error
  }
}

async function resolveMedia(payload: Payload, req: PayloadRequest, dto: PortalPageDTO, requireComplete: boolean,
  options: CmsTransactionOptions = {}) {
  try {
    return await loadPortalPageMediaReferences(payload, { cover: dto.cover, body: dto.content_blocks }, req,
      { requireComplete, readOptions: options })
  } catch (error) {
    if (error instanceof APIError && error.status === 503) throw error
    if (error instanceof APIError && error.status === 400) throw INVALID_PUBLISHED_PAGE
    throw error
  }
}

function publicFields(dto: PortalPageDTO) {
  const { asset_scope: _scope, revision: _revision, ...fields } = dto
  return fields
}

async function currentPublishedVersion(payload: Payload, req: PayloadRequest, pageID: string, options: CmsTransactionOptions) {
  const result = await withCmsReadOperation(options, () => payload.findVersions({
    collection: 'portal-pages', req, depth: 1, overrideAccess: true, pagination: false, limit: 1,
    sort: ['-updatedAt', '-id'],
    where: { and: [{ parent: { equals: pageID } }, { 'version._status': { equals: 'published' } }] },
  }))
  const saved = result.docs[0] as unknown as Record<string, unknown> | undefined
  if (!saved || uuid(saved.parent, 'invalid_portal_page_version') !== pageID || typeof saved.id !== 'string') return null
  const versionID = uuid(saved.id, 'invalid_portal_page_version')
  const source = record(saved.version, 'invalid_portal_page_version')
  if (source._status !== 'published') return null
  return { versionID, source }
}

/** Resolve only the latest saved published Version that exactly matches the published main document. */
async function publishedPage(payload: Payload, req: PayloadRequest, input: Record<string, unknown>,
  options: CmsTransactionOptions = {}, ineligibleInsteadOfUnavailable = false): Promise<PortalPageReadResult | null> {
  let pageID: string
  let page: Record<string, unknown>
  try {
    pageID = uuid(input.id, 'invalid_request')
    page = record(input.page, 'invalid_portal_page_document')
  } catch { return null }
  if (page.id !== pageID || page._status !== 'published') return null
  try {
    const saved = await currentPublishedVersion(payload, req, pageID, options)
    if (!saved) {
      if (ineligibleInsteadOfUnavailable) return null
      throw UNAVAILABLE()
    }
    const current = await projectPage(payload, req, pageID, page, 'portal-pages', { id: saved.versionID, status: 'published' }, options)
    const snapshot = await projectPage(payload, req, pageID, saved.source, 'portal-pages', { id: saved.versionID, status: 'published' }, options)
    if (JSON.stringify(publicFields(current)) !== JSON.stringify(publicFields(snapshot))) {
      if (ineligibleInsteadOfUnavailable) return null
      throw UNAVAILABLE()
    }
    const media = await resolveMedia(payload, req, current, true, options)
    return { dto: current, media }
  } catch (error) {
    if (error instanceof APIError && error.status === 400) {
      if (ineligibleInsteadOfUnavailable) return null
      throw error
    }
    throw error
  }
}

async function findPublishedByID(payload: Payload, req: PayloadRequest, id: string, options: CmsTransactionOptions = {}) {
  const page = await withCmsReadOperation(options, () => payload.findByID({ collection: 'portal-pages', id, req,
    overrideAccess: true, depth: 1, draft: false, disableErrors: true })) as unknown
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null
  const value = page as Record<string, unknown>
  if (value._status !== 'published') return null
  return publishedPage(payload, req, { id, page: value }, options)
}

async function findPublishedBySlug(payload: Payload, req: PayloadRequest, slug: string, options: CmsTransactionOptions = {}) {
  const result = await withCmsReadOperation(options, () => payload.find({ collection: 'portal-pages', req, depth: 1, draft: false, overrideAccess: true,
    limit: 2, pagination: false, sort: ['-publishedAt', '-id'],
    where: { and: [{ slug: { equals: slug } }, { _status: { equals: 'published' } }] } }))
  if (result.docs.length > 1) throw UNAVAILABLE()
  const page = result.docs[0] as unknown as Record<string, unknown> | undefined
  if (!page || page._status !== 'published' || typeof page.id !== 'string') return null
  return publishedPage(payload, req, { id: page.id, page }, options)
}

function publishedPageFilter(category?: string) {
  if (category === undefined) return sql`page._status = 'published'`
  return sql`page._status = 'published' AND EXISTS (
    SELECT 1 FROM portal_pages_rels AS relation
    INNER JOIN portal_page_categories AS category ON category.id = relation.portal_page_categories_id
    WHERE relation.parent_id = page.id AND relation.path = 'categories' AND category.slug = ${category}
  )`
}

function databaseRows(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { rows?: unknown }).rows)) throw UNAVAILABLE()
  return (result as { rows: Array<Record<string, unknown>> }).rows
}

type PublishedPageCandidate = { id: string; publishedAt: string | null }
type PublishedPageCursor = PublishedPageCandidate

function pageCandidatesFromRows(rows: Array<Record<string, unknown>>): PublishedPageCandidate[] {
  try {
    return rows.map(row => {
      const id = uuid(row.id, 'invalid_portal_page_reference')
      const rawDate = row.published_at
      if (rawDate === null || rawDate === undefined) return { id, publishedAt: null }
      const source = rawDate instanceof Date
        ? rawDate.toISOString().replace(/\.(\d{3})Z$/u, (_match, fraction: string) => `.${fraction}000Z`)
        : rawDate
      if (typeof source !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(source) ||
        !Number.isFinite(Date.parse(source))) throw UNAVAILABLE()
      return { id, publishedAt: source }
    })
  } catch { throw UNAVAILABLE() }
}

function followsCatalogCursor(candidate: PublishedPageCandidate, cursor: PublishedPageCursor): boolean {
  if (cursor.publishedAt === null) {
    return candidate.publishedAt !== null || candidate.id < cursor.id
  }
  if (candidate.publishedAt === null) return false
  return candidate.publishedAt < cursor.publishedAt ||
    (candidate.publishedAt === cursor.publishedAt && candidate.id < cursor.id)
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }

async function selectNextPublishedCandidates(payload: Payload, req: PayloadRequest, cursor: PublishedPageCursor | null,
  limit: number, category?: string) {
  const db = await requireCmsTransaction(payload, req)
  const base = publishedPageFilter(category)
  let after = sql`TRUE`
  if (cursor?.publishedAt === null) {
    after = sql`(page.published_at IS NOT NULL OR (page.published_at IS NULL AND page.id < ${cursor.id}::uuid))`
  } else if (cursor) {
    after = sql`page.published_at IS NOT NULL AND
      (page.published_at < ${cursor.publishedAt}::timestamptz OR
       (page.published_at = ${cursor.publishedAt}::timestamptz AND page.id < ${cursor.id}::uuid))`
  }
  const result = await db.execute(sql`SELECT page.id AS id,
    CASE WHEN page.published_at IS NULL THEN NULL ELSE
      to_char(page.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    END AS published_at
    FROM portal_pages AS page WHERE ${base} AND ${after}
    ORDER BY page.published_at DESC NULLS FIRST, page.id DESC LIMIT ${limit}`)
  return pageCandidatesFromRows(databaseRows(result))
}

async function readPublishedPageByID(payload: Payload, req: PayloadRequest, id: string,
  options: CmsTransactionOptions): Promise<PortalPageReadResult | null> {
  const raw = await withCmsReadOperation(options, () => payload.findByID({ collection: 'portal-pages', id, req,
    overrideAccess: true, depth: 1, draft: false, disableErrors: true })) as unknown
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const page = raw as Record<string, unknown>
  if (page.id !== id || page._status !== 'published') return null
  return publishedPage(payload, req, { id, page }, options, true)
}

async function scanEligiblePublished(req: PayloadRequest, options: CmsTransactionOptions & { deadlineAt: number },
  visit: (page: PortalPageReadResult, eligibleIndex: number) => boolean | void | Promise<boolean | void>, category?: string): Promise<number> {
  let cursor: PublishedPageCursor | null = null
  let scanned = 0
  let eligibleCount = 0
  for (let pageNumber = 0; pageNumber < PAGE_SCAN_MAX; pageNumber++) {
    assertReadBudget(options)
    const batch = await withReadBatch(req, options, async transactionReq => {
      const candidates = await selectNextPublishedCandidates(req.payload, transactionReq, cursor, PAGE_BATCH_SIZE, category)
      assertReadBudget(options)
      if (candidates.length > PAGE_BATCH_SIZE || (candidates.length && cursor &&
        !followsCatalogCursor(candidates[0]!, cursor))) throw UNAVAILABLE()
      for (let index = 1; index < candidates.length; index++) {
        if (!followsCatalogCursor(candidates[index]!, candidates[index - 1]!)) throw UNAVAILABLE()
      }
      if (scanned + candidates.length > PAGE_SCAN_MAX_ROWS) throw UNAVAILABLE()
      let stop = false
      for (const candidate of candidates) {
        assertReadBudget(options)
        try {
          const eligible = await readPublishedPageByID(req.payload, transactionReq, candidate.id, options)
          if (eligible) {
            const continueScan = await visit(eligible, eligibleCount)
            eligibleCount++
            if (continueScan === false) { stop = true; break }
          }
        } catch (error) {
          // Malformed, drifted, or broken references are not eligible public rows.
          if (error instanceof APIError && error.status === 400) continue
          throw error
        }
      }
      return { candidates, stop }
    })
    if (batch.candidates.length === 0 || batch.stop) return eligibleCount
    scanned += batch.candidates.length
    cursor = batch.candidates.at(-1)!
    if (batch.candidates.length < PAGE_BATCH_SIZE) return eligibleCount
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

export function queryPortalPages(req: PayloadRequest, rawInput: PortalPageListInput, actor: PortalPageReadActor,
  rawOptions: PortalPageReadOptions = {}): Promise<PortalPagePageResult> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  const input = checkListInput(rawInput)
  const options = effectiveReadOptions(rawOptions)
  return withCmsReadSnapshot(req.payload, req, options, async snapshotID => {
    const scanOptions = { ...options, snapshotID }
    const rows: PortalPageDTO[] = []
    let selectedBytes = 0
    const count = await scanEligiblePublished(req, scanOptions, (page, eligibleIndex) => {
      if (eligibleIndex >= input.offset && rows.length < input.limit) {
        selectedBytes += Buffer.byteLength(JSON.stringify(page.dto), 'utf8')
        if (selectedBytes > PAGE_JSON_MAX_BYTES) throw UNAVAILABLE()
        rows.push(page.dto)
      }
    }, input.category)
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw UNAVAILABLE()
    const result = { rows, count }
    if (rows.length > input.limit || Buffer.byteLength(JSON.stringify(result), 'utf8') > PAGE_JSON_MAX_BYTES) throw UNAVAILABLE()
    return result
  })
}

export async function queryPortalPageAvailability(req: PayloadRequest, actor: PortalPageReadActor,
  rawOptions: PortalPageReadOptions = {}): Promise<boolean> {
  if (!actorIsValid(actor)) throw new APIError('invalid_request', 400, undefined, true)
  const options = effectiveReadOptions(rawOptions)
  return withCmsReadSnapshot(req.payload, req, options, async snapshotID => {
    let available = false
    await scanEligiblePublished(req, { ...options, snapshotID }, () => { available = true; return false })
    return available
  })
}

export function queryPortalPagePublishedDetail(req: PayloadRequest, rawSlug: string, actor: PortalPageReadActor,
  rawOptions: PortalPageReadOptions = {}): Promise<PortalPageDTO | null> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  const slug = canonicalSlug(rawSlug)
  const options = effectiveReadOptions(rawOptions)
  return withCmsTransaction(req.payload, req, async transactionReq => {
    assertReadBudget(options)
    const result = await findPublishedBySlug(req.payload, transactionReq, slug, options)
    assertReadBudget(options)
    return result?.dto ?? null
  }, options)
}

export function queryPortalPageCategories(req: PayloadRequest, actor: PortalPageReadActor,
  rawOptions: PortalPageReadOptions = {}): Promise<PortalPageCategoryDTO[]> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  const options = effectiveReadOptions(rawOptions)
  return withCmsReadSnapshot(req.payload, req, options, async snapshotID => {
    const scanOptions = { ...options, snapshotID }
    const counts = new Map<string, PortalPageCategoryDTO>()
    await scanEligiblePublished(req, scanOptions, page => {
      for (const category of page.dto.categories) {
        const value = counts.get(category.id)
        if (value) value.count++
        else counts.set(category.id, { ...category, count: 1 })
      }
    })
    assertReadBudget(options)
    const result = [...counts.values()].sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
    assertReadBudget(options)
    if (result.length > 10_000 || Buffer.byteLength(JSON.stringify(result), 'utf8') > PAGE_JSON_MAX_BYTES) throw UNAVAILABLE()
    return result
  })
}

export function queryPortalPagePreview(req: PayloadRequest, rawPageID: string, rawVersionID: string,
  actor: PortalPageReadActor, rawOptions: PortalPageReadOptions = {}): Promise<PortalPageDTO | null> {
  if (!actorIsValid(actor)) return Promise.reject(new APIError('invalid_request', 400, undefined, true))
  if (!actor.canManageKnowledge) return Promise.reject(new APIError('permission_denied', 403, undefined, true))
  const pageID = uuid(rawPageID, 'invalid_request'), versionID = uuid(rawVersionID, 'invalid_request')
  const options = effectiveReadOptions(rawOptions)
  return withCmsTransaction(req.payload, req, async transactionReq => {
    assertReadBudget(options)
    const result = await withCmsReadOperation(options, () => req.payload.findVersions({ collection: 'portal-pages', req: transactionReq, depth: 1, overrideAccess: true,
      pagination: false, limit: 2, where: { and: [{ id: { equals: versionID } }, { parent: { equals: pageID } }] } })
    )
    if (result.docs.length === 0) return null
    if (result.docs.length !== 1) throw UNAVAILABLE()
    const saved = result.docs[0] as unknown as Record<string, unknown>
    if (saved.id !== versionID || saved.parent !== pageID) return null
    const source = record(saved.version, 'invalid_portal_page_version')
    if (!['draft', 'published'].includes(String(source._status))) return null
    const dto = await projectPage(req.payload, transactionReq, pageID, source, 'portal-pages-preview',
      { id: versionID, status: source._status as 'draft' | 'published' }, options)
    await resolveMedia(req.payload, transactionReq, dto, false, options)
    assertReadBudget(options)
    if (Buffer.byteLength(JSON.stringify(dto), 'utf8') > 6 * 1024 * 1024) throw UNAVAILABLE()
    return dto
  }, options)
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

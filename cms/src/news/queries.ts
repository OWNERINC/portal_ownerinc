import { APIError, type PayloadRequest, type Where } from 'payload'
import type { NewsDTO, NewsPage, NewsNavigation, VerifiedPortalActor } from '../contracts/news'
import { readNewsActor, readNewsInput, type NewsInputs } from '../auth/service-access'
import { withCmsTransaction, requireCmsTransaction } from '../publication/transaction'
import { assertMediaReferences, InvalidMediaReferenceError } from '../media/references'
import { toNewsDTO } from './to-dto'
import { normalizeNewsHome } from './validation'
import { historyDocument } from '../collections/LegacyNewsRevisions'

const notFound = (): never => { throw new APIError('not_found', 404, undefined, true) }
const unavailable = (): never => { throw new APIError('news_unavailable', 503, undefined, true) }
const LIST_CHUNK_SIZE = 101
const LIST_MAX_BATCHES = 1000
const LIST_MAX_RAW_ROWS = LIST_CHUNK_SIZE * LIST_MAX_BATCHES
const kind = (dto: NewsDTO) => dto.editorial?.kind || (dto.content_blocks.some(block => block.type === 'pdf') ? 'edition' : 'article')
/** Only malformed content/reference SHAPES are excluded. DB/file/storage failures propagate. */
async function visible(req: PayloadRequest, document: unknown, preview = false): Promise<NewsDTO | null> {
  let dto: NewsDTO
  try { dto = toNewsDTO(document, { preview }) }
  catch (error) { if (error instanceof APIError && error.status === 400) return null; throw error }
  try { await assertMediaReferences(req.payload, dto.content_blocks, req) }
  catch (error) { if (error instanceof InvalidMediaReferenceError) return null; throw error }
  return dto
}
/** Authenticated private bridge only: explicit bypass with current-publication filter.
 * Every candidate and media check shares lock 7194030 + the same live req/session. */
async function published(req: PayloadRequest, signal?: AbortSignal): Promise<NewsDTO[]> {
  const candidates: NewsDTO[] = []
  for (let page = 1; page <= 1000; page++) {
    if (signal?.aborted) throw new APIError('news_unavailable', 503, undefined, true)
    await requireCmsTransaction(req.payload, req)
    const result = await req.payload.find({ collection: 'news-articles', req, overrideAccess: true, draft: false, depth: 0,
      limit: 100, page, sort: 'id', where: { _status: { equals: 'published' } } })
    for (const document of result.docs) {
      if (signal?.aborted) throw new APIError('news_unavailable', 503, undefined, true)
      if (document._status !== 'published') continue
      const dto = await visible(req, document)
      if (dto) candidates.push(dto)
    }
    if (!result.hasNextPage) {
      const stamp = (v: string | null) => v === null ? -Infinity : Date.parse(v)
      return candidates.sort((a, b) => {
        const aStamp = stamp(a.published_at), bStamp = stamp(b.published_at)
        return aStamp !== bStamp ? (bStamp > aStamp ? 1 : -1) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      })
    }
  }
  throw new APIError('news_unavailable', 503, undefined, true)
}
function select(rows: NewsDTO[], input: { category?: string; kind?: string }) {
  return rows.filter(row => (input.category === undefined || row.category === input.category) && (input.kind === undefined || kind(row) === input.kind))
}
type PayloadBoundary = NonNullable<NewsInputs['list']['boundary']>
type ScanPhase = 'dated' | 'null'
type ScanBudget = { batches: number; rawRows: number }
const canonicalDate = (value: string) => new Date(value).toISOString()
function rawBoundary(document: unknown, phase: ScanPhase): PayloadBoundary {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return unavailable()
  const value = document as Record<string, unknown>
  if (typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id)) return unavailable()
  if (phase === 'null') {
    if (value.publishedAt !== null && value.publishedAt !== undefined) return unavailable()
    return { published_at: null, source: 'payload', id: value.id.toLowerCase() }
  }
  if (typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) return unavailable()
  return { published_at: canonicalDate(value.publishedAt), source: 'payload', id: value.id.toLowerCase() }
}
function afterPayloadBoundary(point: PayloadBoundary, boundary: PayloadBoundary | null) {
  if (!boundary) return true
  if (boundary.published_at === null) return point.published_at === null && (boundary.source === 'legacy' || point.id > boundary.id)
  if (point.published_at === null) return true
  const pointStamp = Date.parse(point.published_at), boundaryStamp = Date.parse(boundary.published_at)
  return pointStamp < boundaryStamp || (pointStamp === boundaryStamp && (boundary.source === 'legacy' || point.id > boundary.id))
}
function listWhere(input: NewsInputs['list'], phase: ScanPhase, boundary: PayloadBoundary | null): Where {
  const and: Where[] = [{ _status: { equals: 'published' } }]
  if (input.category !== undefined) and.push({ category: { equals: input.category } })
  if (phase === 'null') {
    and.push({ publishedAt: { equals: null } })
    if (boundary?.published_at === null && boundary.source === 'payload') and.push({ id: { greater_than: boundary.id } })
  } else {
    and.push({ publishedAt: { exists: true } })
    if (boundary && boundary.published_at !== null) {
      const publishedAt = canonicalDate(boundary.published_at)
      const equal: Where = boundary.source === 'legacy'
        ? { publishedAt: { equals: publishedAt } }
        : { and: [{ publishedAt: { equals: publishedAt } }, { id: { greater_than: boundary.id } }] }
      and.push({ or: [{ publishedAt: { less_than: publishedAt } }, equal] })
    }
  }
  return { and }
}
async function boundedPublishedPage(req: PayloadRequest, input: NewsInputs['list'], signal?: AbortSignal,
  budget: ScanBudget = { batches: 0, rawRows: 0 }): Promise<NewsPage> {
  const target = input.offset + input.limit
  if (!Number.isSafeInteger(target) || target < 1) return unavailable()
  const initial = { batches: budget.batches, rawRows: budget.rawRows }
  const maximum = input.scan
    ? { batches: initial.batches + input.scan.maxBatches, rawRows: initial.rawRows + input.scan.maxRawRows }
    : { batches: LIST_MAX_BATCHES, rawRows: LIST_MAX_RAW_ROWS }
  const finish = (rows: NewsDTO[], count: number | null): NewsPage => ({ rows, count,
    ...(input.scan ? { scan: { batches: budget.batches - initial.batches, rawRows: budget.rawRows - initial.rawRows } } : {}) })
  const retained: NewsDTO[] = []
  let validCount = 0
  let phase: ScanPhase = input.boundary?.published_at === null ? 'null' : 'dated'
  let boundary: PayloadBoundary | null = input.boundary
    ? { ...input.boundary, published_at: input.boundary.published_at === null ? null : canonicalDate(input.boundary.published_at) }
    : null
  while (budget.batches < maximum.batches && budget.rawRows < maximum.rawRows) {
    if (signal?.aborted) return unavailable()
    const storageLimit = Math.min(LIST_CHUNK_SIZE, maximum.rawRows - budget.rawRows)
    if (storageLimit < 1) return unavailable()
    budget.batches++
    await requireCmsTransaction(req.payload, req)
    const result = await req.payload.find({ collection: 'news-articles', req, overrideAccess: true, draft: false, depth: 0,
      limit: storageLimit, page: 1, sort: phase === 'dated' ? ['-publishedAt', 'id'] : 'id', where: listWhere(input, phase, boundary) })
    if (!Array.isArray(result.docs) || result.docs.length > storageLimit || typeof result.hasNextPage !== 'boolean') return unavailable()
    budget.rawRows += result.docs.length
    if (budget.rawRows > maximum.rawRows || (!result.docs.length && result.hasNextPage)) return unavailable()
    let previous = boundary
    for (const document of result.docs) {
      if (signal?.aborted) return unavailable()
      const point = rawBoundary(document, phase)
      if (!afterPayloadBoundary(point, previous)) return unavailable()
      previous = point
      if (document._status !== 'published') continue
      const dto = await visible(req, document)
      if (!dto || (input.kind !== undefined && kind(dto) !== input.kind)) continue
      validCount++
      if (retained.length < target) retained.push(dto)
    }
    if (result.docs.length) boundary = rawBoundary(result.docs.at(-1), phase)
    const targetReached = retained.length >= target
    if (result.hasNextPage) {
      if (targetReached) return finish(retained.slice(input.offset, target), null)
      continue
    }
    if (phase === 'dated') {
      if (targetReached) return finish(retained.slice(input.offset, target), null)
      phase = 'null'; boundary = null
      continue
    }
    return finish(retained.slice(input.offset, target), validCount)
  }
  return unavailable()
}
function guard(actor: VerifiedPortalActor) { readNewsActor(actor) }
export function queryPublishedNews(req: PayloadRequest, input: NewsInputs['list'], actor: VerifiedPortalActor): Promise<NewsPage> {
  guard(actor); input = readNewsInput('list', input)
  const signal = req.signal
  return withCmsTransaction(req.payload, req, async req => {
    return boundedPublishedPage(req, input, signal)
  })
}
export function queryNewsDetail(req: PayloadRequest, input: NewsInputs['detail'], actor: VerifiedPortalActor): Promise<NewsDTO> {
  guard(actor); input = readNewsInput('detail', input)
  return withCmsTransaction(req.payload, req, async req => {
    const rows = await req.payload.find({ collection: 'news-articles', req, overrideAccess: true, draft: false, depth: 0, limit: 1,
      where: { and: [{ id: { equals: input.id } }, { _status: { equals: 'published' } }] } })
    const row = rows.docs[0]; return row?._status === 'published' ? (await visible(req, row)) || notFound() : notFound()
  })
}
export function queryNewsCategories(req: PayloadRequest, input: NewsInputs['categories'], actor: VerifiedPortalActor) {
  guard(actor); input = readNewsInput('categories', input)
  const signal = req.signal
  return withCmsTransaction(req.payload, req, async req => {
    const rows = select(await published(req, signal), input), counts = new Map<string, number>()
    for (const row of rows) if (row.category.trim()) counts.set(row.category, (counts.get(row.category) || 0) + 1)
    if (counts.size > 10000) throw new APIError('news_unavailable', 503, undefined, true)
    const names = [...counts.keys()].sort()
    return input.withCounts ? { total: rows.length, categories: names.map(name => ({ name, count: counts.get(name)! })) } : names
  })
}
export function queryNewsNavigation(req: PayloadRequest, input: NewsInputs['navigation'], actor: VerifiedPortalActor): Promise<NewsNavigation> {
  guard(actor); input = readNewsInput('navigation', input)
  const signal = req.signal
  return withCmsTransaction(req.payload, req, async req => {
    const found = await req.payload.find({ collection: 'news-articles', req, overrideAccess: true, draft: false, depth: 0, limit: 1,
      where: { and: [{ id: { equals: input.id } }, { _status: { equals: 'published' } }] } })
    const current = found.docs[0]?._status === 'published' ? await visible(req, found.docs[0]) : null
    if (!current) return notFound()
    if (kind(current) === 'edition') return { previous: null, next: null }
    const item = (row?: NewsDTO) => row ? { source: 'payload' as const, id: row.id, title: row.title } : null
    let boundary: PayloadBoundary | undefined, previous: NewsDTO | undefined, before: NewsDTO | undefined, sawCurrent = false
    const budget: ScanBudget = { batches: 0, rawRows: 0 }
    for (let batch = 0; batch < LIST_MAX_BATCHES; batch++) {
      const page = await boundedPublishedPage(req, { limit: LIST_CHUNK_SIZE, offset: 0, category: input.category, kind: 'article',
        ...(boundary ? { boundary } : {}) }, signal, budget)
      for (const row of page.rows) {
        if (sawCurrent) return { previous: item(before), next: item(row) }
        if (row.id === input.id) { sawCurrent = true; before = previous } else previous = row
      }
      if (page.count !== null) return sawCurrent ? { previous: item(before), next: null } : notFound()
      const last = page.rows.at(-1)
      if (!last) return unavailable()
      boundary = { published_at: last.published_at, source: 'payload', id: last.id }
    }
    return unavailable()
  })
}
export function queryNewsHome(req: PayloadRequest, input: NewsInputs['home'], actor: VerifiedPortalActor) {
  guard(actor); readNewsInput('home', input)
  return withCmsTransaction(req.payload, req, async req => {
    const document = await req.payload.findGlobal({ slug: 'news-home', req, overrideAccess: true, draft: false, depth: 0 })
    if (document._status !== 'published') return { content: null }
    try { return { content: normalizeNewsHome(document, true) } }
    catch (error) { if (error instanceof APIError && error.status === 400) return { content: null }; throw error }
  })
}
export function queryNewsPreview(req: PayloadRequest, input: NewsInputs['preview'], actor: VerifiedPortalActor): Promise<NewsDTO> {
  guard(actor); input = readNewsInput('preview', input)
  if (!actor.canManageNews) throw new APIError('forbidden', 403, undefined, true)
  return withCmsTransaction(req.payload, req, async req => {
    if (input.source === 'legacy') {
      const rows = await req.payload.find({ collection: 'legacy-news-revisions', req, overrideAccess: true, depth: 0, limit: 1,
        where: { and: [{ legacyDocumentId: { equals: input.id } }, { legacyRevisionId: { equals: input.versionId } }] } })
      if (!rows.docs[0]) notFound()
      const dto = (await visible(req, historyDocument(rows.docs[0]), true)) || notFound()
      return { ...dto, preview_revision: { id: input.versionId, source: 'legacy', status: rows.docs[0].originalStatus } }
    }
    const rows = await req.payload.findVersions({ collection: 'news-articles', req, overrideAccess: true, depth: 0, limit: 1,
      where: { and: [{ id: { equals: input.versionId } }, { parent: { equals: input.id } }] } })
    const row = rows.docs[0]
    if (!row || row.parent !== input.id) return notFound()
    const dto = (await visible(req, { ...row.version, id: input.id }, true)) || notFound()
    if (row.version._status !== 'draft' && row.version._status !== 'published') return notFound()
    return { ...dto, preview_revision: { id: input.versionId, source: 'payload', status: row.version._status } }
  })
}

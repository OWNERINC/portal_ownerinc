import { APIError, type PayloadRequest } from 'payload'
import type { NewsDTO, NewsPage, NewsNavigation, VerifiedPortalActor } from '../contracts/news'
import { readNewsActor, readNewsInput, type NewsInputs } from '../auth/service-access'
import { withCmsTransaction, requireCmsTransaction } from '../publication/transaction'
import { assertMediaReferences, InvalidMediaReferenceError } from '../media/references'
import { toNewsDTO } from './to-dto'
import { normalizeNewsHome } from './validation'
import { historyDocument } from '../collections/LegacyNewsRevisions'

const notFound = (): never => { throw new APIError('not_found', 404, undefined, true) }
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
  const candidates: { dto: NewsDTO; updatedAt: string }[] = []
  for (let page = 1; page <= 1000; page++) {
    if (signal?.aborted) throw new APIError('news_unavailable', 503, undefined, true)
    await requireCmsTransaction(req.payload, req)
    const result = await req.payload.find({ collection: 'news-articles', req, overrideAccess: true, draft: false, depth: 0,
      limit: 100, page, sort: 'id', where: { _status: { equals: 'published' } } })
    for (const document of result.docs) {
      if (signal?.aborted) throw new APIError('news_unavailable', 503, undefined, true)
      if (document._status !== 'published') continue
      const dto = await visible(req, document)
      if (dto) candidates.push({ dto, updatedAt: document.updatedAt })
    }
    if (!result.hasNextPage) {
      const stamp = (v: string | null) => v === null ? -Infinity : Date.parse(v)
      return candidates.sort((a, b) => (stamp(b.dto.published_at) - stamp(a.dto.published_at) || stamp(b.updatedAt) - stamp(a.updatedAt) || (a.dto.id < b.dto.id ? -1 : a.dto.id > b.dto.id ? 1 : 0))).map(item => item.dto)
    }
  }
  throw new APIError('news_unavailable', 503, undefined, true)
}
function select(rows: NewsDTO[], input: { category?: string; kind?: string }) {
  return rows.filter(row => (input.category === undefined || row.category === input.category) && (input.kind === undefined || kind(row) === input.kind))
}
function guard(actor: VerifiedPortalActor) { readNewsActor(actor) }
export function queryPublishedNews(req: PayloadRequest, input: NewsInputs['list'], actor: VerifiedPortalActor): Promise<NewsPage> {
  guard(actor); input = readNewsInput('list', input)
  const signal = req.signal
  return withCmsTransaction(req.payload, req, async req => {
    const rows = select(await published(req, signal), input); return { rows: rows.slice(input.offset, input.offset + input.limit), count: rows.length }
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
    const rows = await published(req, signal), current = rows.find(row => row.id === input.id)
    if (!current) return notFound()
    if (kind(current) === 'edition') return { previous: null, next: null }
    const articles = select(rows, { ...input, kind: 'article' }), index = articles.findIndex(row => row.id === input.id)
    if (index < 0) notFound()
    const item = (row?: NewsDTO) => row ? { id: row.id, title: row.title } : null
    return { previous: item(articles[index - 1]), next: item(articles[index + 1]) }
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
      return (await visible(req, historyDocument(rows.docs[0]), true)) || notFound()
    }
    const rows = await req.payload.findVersions({ collection: 'news-articles', req, overrideAccess: true, depth: 0, limit: 1,
      where: { and: [{ id: { equals: input.versionId } }, { parent: { equals: input.id } }] } })
    const row = rows.docs[0]
    if (!row || row.parent !== input.id) return notFound()
    return (await visible(req, { ...row.version, id: input.id }, true)) || notFound()
  })
}

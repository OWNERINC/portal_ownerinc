import { APIError, type Field, type Payload, type PayloadRequest } from 'payload'
import type { NewsContent } from '../contracts/news'
import { uuid } from '../news/primitives'
import { normalizeNewsDocument, normalizeNewsDraftReferences, validateNewsMediaShapes } from '../news/validation'
import { lockCmsReferences, requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { openStoredMedia } from './storage'

/** Input is the normalized FLAT boundary, never arbitrary JSON or native relations. */
export function collectMediaIds(content: NewsContent): Set<string> {
  return new Set(content.flatMap(block => 'asset_id' in block && typeof block.asset_id === 'string' ? [uuid(block.asset_id)] : []))
}

export async function assertMediaReferences(payload: Payload, content: NewsContent, req: PayloadRequest) {
  return withCmsTransaction(payload, req, async req => {
    const media = []
    for (const id of collectMediaIds(content)) {
      await requireCmsTransaction(payload, req)
      const asset = await payload.findByID({ collection: 'news-media', id, req, overrideAccess: true, depth: 0, disableErrors: true })
      if (!asset) throw new APIError('invalid_media_reference', 400, undefined, true)
      media.push(asset)
      const handle = await openStoredMedia(payload, asset)
      await handle.close()
    }
    validateNewsMediaShapes(content, media)
  })
}

// Deliberately exhaustive bounded scans for the pilot. Reaching the bound fails closed.
async function scanArticles(payload: Payload, req: PayloadRequest, versions: boolean,
  visit: (document: Record<string, unknown>) => Promise<boolean>): Promise<boolean> {
  for (let page = 1; page <= 1000; page++) {
    await requireCmsTransaction(payload, req)
    if (versions) {
      const result = await payload.findVersions({ collection: 'news-articles', req, depth: 0, overrideAccess: true, limit: 100, page, sort: 'id' })
      for (const row of result.docs) if (await visit(row.version as unknown as Record<string, unknown>)) return true
      if (!result.hasNextPage) return false
    } else {
      const result = await payload.find({ collection: 'news-articles', req, draft: false, depth: 0, overrideAccess: true, limit: 100, page, sort: 'id' })
      for (const row of result.docs) if (await visit(row as unknown as Record<string, unknown>)) return true
      if (!result.hasNextPage) return false
    }
  }
  throw new APIError('media_reference_scan_limit', 503, undefined, true)
}

export async function canReadPublishedMedia(payload: Payload, id: string, req: PayloadRequest): Promise<boolean> {
  id = uuid(id)
  return withCmsTransaction(payload, req, req => scanArticles(payload, req, false, async document => {
    if (document._status !== 'published') return false
    let content: NewsContent
    try { content = normalizeNewsDocument(document, true).blocks } catch { return false }
    if (!collectMediaIds(content).has(id)) return false
    // A malformed, dangling or MIME-incompatible publication is not a reader grant.
    try { await assertMediaReferences(payload, content, req) }
    catch (error) { if (error instanceof APIError && error.status === 400) return false; throw error }
    return true
  }))
}

/** Explicit inventory: new schedule/snapshot/history stores MUST extend this protection. */
export function assertReferenceStoreCoverage(payload: Payload) {
  const covered = new Set(['portal-editors', 'news-articles', 'news-media', 'payload-preferences',
    'payload-locked-documents', 'payload-migrations', 'payload-jobs', 'payload-kv'])
  const internal = ['id', 'createdAt', 'updatedAt', '_status']
  const publication = ['publishedAt', 'publicationGeneration', 'legacyDocumentId', 'legacySourceId', 'legacyRevisionId', 'importedAt']
  const onlyFields = (fields: Field[], names: string[]) => fields.every(field => 'name' in field && names.includes(field.name))
  const articles = payload.collections['news-articles'].config
  const home = payload.config.globals.find(global => global.slug === 'news-home')
  if (Object.keys(payload.collections).some(slug => !covered.has(slug)) ||
    payload.config.globals.some(global => global.slug !== 'news-home') || payload.config.jobs.tasks?.length ||
    !onlyFields(articles.fields, [...internal, ...publication, 'title', 'category', 'editorial', 'body']) ||
    (home && !onlyFields(home.fields, [...internal, ...publication, 'eyebrow', 'headline', 'summary'])) ||
    !articles.versions || articles.versions.maxPerDoc !== 0 ||
    (articles.versions.drafts && articles.versions.drafts.schedulePublish)) {
    throw new APIError('media_reference_store_not_covered', 503, undefined, true)
  }
}

export async function assertMediaOrphan(payload: Payload, id: string, req: PayloadRequest) {
  await lockCmsReferences(payload, req)
  assertReferenceStoreCoverage(payload)
  id = uuid(id)
  const references = async (document: Record<string, unknown>) => collectMediaIds(normalizeNewsDraftReferences(document.body)).has(id)
  if (await scanArticles(payload, req, false, references) || await scanArticles(payload, req, true, references)) {
    throw new APIError('media_is_referenced', 409, undefined, true)
  }
}

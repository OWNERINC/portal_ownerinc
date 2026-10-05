import { createHash } from 'node:crypto'
import { APIError, type PayloadRequest, type Where } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { requireCmsTransaction, type PublicationTarget } from './transaction'

export type NewsSnapshot = Record<string, unknown>
export function snapshotDocument(target: PublicationTarget, source: object): NewsSnapshot {
  const document = source as NewsSnapshot
  const fields = target === 'news-articles' ? ['title', 'category', 'editorial', 'body'] : ['eyebrow', 'headline', 'summary']
  return JSON.parse(JSON.stringify(Object.fromEntries(fields.map(key => [key, document[key]]))))
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export const snapshotHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
export async function currentDocument(req: PayloadRequest, target: PublicationTarget, id: string): Promise<NewsSnapshot> {
  await requireCmsTransaction(req.payload, req)
  const doc = target === 'news-articles'
    ? await req.payload.db.findOne({ collection: target, where: { id: { equals: id } }, req })
    : await req.payload.db.findGlobal({ slug: target, req })
  if (!doc?.id) throw new APIError('news_document_not_found', 404, undefined, true)
  return doc
}
export async function latestRevision(req: PayloadRequest, target: PublicationTarget, id: string) {
  await requireCmsTransaction(req.payload, req)
  const where: Where = target === 'news-articles'
    ? { and: [{ parent: { equals: id } }, { latest: { equals: true } }] } : { latest: { equals: true } }
  const options = { req, where, depth: 0, overrideAccess: true, limit: 1, sort: '-updatedAt' }
  const result = target === 'news-articles'
    ? await req.payload.findVersions({ collection: target, ...options })
    : await req.payload.findGlobalVersions({ slug: target, ...options })
  return result.docs[0]
}
export async function setGeneration(req: PayloadRequest, target: PublicationTarget, id: string, generation: number) {
  const db = await requireCmsTransaction(req.payload, req)
  if (target === 'news-articles') await db.execute(sql`UPDATE news_articles SET publication_generation = ${generation} WHERE id = ${id}::uuid`)
  else await db.execute(sql`UPDATE news_home SET publication_generation = ${generation}`)
}

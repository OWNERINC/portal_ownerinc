import { sql } from '@payloadcms/db-postgres'
import { APIError, type PayloadRequest } from 'payload'
import type { Authority } from '../contracts/news'
import { readCmsEnvironment } from '../config/environment'
import { createPortalClient } from '../auth/portal-client'
import { readNewsMutationHead } from './mutation-ledger'
import { requireCmsTransaction, withCmsTransaction } from './transaction'

const ZERO_CHAIN = '0'.repeat(64)
const fail = (reason = 'go_live_preflight_unavailable'): never => {
  throw new APIError(reason, 503, undefined, true)
}

export type GoLivePreflight = {
  ready: true
  publicationMode: 'manual'
  authority: { mode: 'frozen' | 'payload_frozen'; epoch: number }
  newsEmpty: true
  mutation: { sequence: string; chainSha256: string; writeBarrier: 'open' }
  counts: { articles: number; media: number; homePublished: number; schedules: number }
}

type Dependencies = {
  publicationMode?: string
  getAuthority?: () => Promise<unknown>
}

function count(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) fail()
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail()
  return parsed
}

function authority(value: unknown): GoLivePreflight['authority'] {
  if (!value || typeof value !== 'object') fail()
  const candidate = value as Partial<Authority>
  if (!['frozen', 'payload_frozen'].includes(candidate.mode || '') ||
    !Number.isSafeInteger(candidate.epoch) || candidate.epoch! < 1) fail()
  return { mode: candidate.mode as 'frozen' | 'payload_frozen', epoch: candidate.epoch! }
}

/** Read-only activation gate. It owns no authority transition and returns no
 * content, identity, path, SQL, URL or credential data. */
export async function queryGoLivePreflight(req: PayloadRequest, dependencies: Dependencies = {}): Promise<GoLivePreflight> {
  try {
    const environment = dependencies.publicationMode === undefined ? readCmsEnvironment(process.env) : null
    const publicationMode = dependencies.publicationMode ?? environment!.publicationMode
    if (publicationMode !== 'manual') fail()
    const getAuthority = dependencies.getAuthority ?? createPortalClient(environment!).getAuthority

    return await withCmsTransaction(req.payload, req, async transactionReq => {
      const frozenAuthority = authority(await getAuthority())
      const mutation = await readNewsMutationHead(transactionReq)
      if (mutation.coverageVersion !== 1 || mutation.sequence !== '0' || mutation.chainSha256 !== ZERO_CHAIN || mutation.writeBarrier !== 'open') fail()

      const db = await requireCmsTransaction(transactionReq.payload, transactionReq)
      const result = await db.execute(sql`SELECT
        (SELECT COUNT(*)::text FROM news_articles) AS articles,
        (SELECT COUNT(*)::text FROM news_media) AS media,
        (SELECT COUNT(*)::text FROM news_home WHERE _status = 'published') AS home_published,
        (SELECT COUNT(*)::text FROM news_schedules) AS schedules`)
      if (result.rows.length !== 1) fail()
      const row = result.rows[0] as Record<string, unknown>
      const counts = { articles: count(row.articles), media: count(row.media),
        homePublished: count(row.home_published), schedules: count(row.schedules) }
      if (Object.values(counts).some(value => value !== 0)) fail('go_live_preflight_not_empty')

      return { ready: true, publicationMode: 'manual', authority: frozenAuthority, newsEmpty: true,
        mutation: { sequence: mutation.sequence, chainSha256: mutation.chainSha256, writeBarrier: 'open' }, counts }
    })
  } catch (error) {
    if (error instanceof APIError && ['go_live_preflight_unavailable', 'go_live_preflight_not_empty',
      'news_mutation_ledger_unavailable', 'cms_transaction_required'].includes(error.message)) throw error
    return fail()
  }
}

import { APIError, type PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { editableHash } from './editorial-native'
import { uuid } from './primitives'

export type MutationReceipt = {
  id: string
  versionID: string
  editableHash: string
  status: 'draft' | 'published'
  publishedAt: string | null
  createdBy: string
  updatedBy: string
  savedAt: string
}

const unavailable = () => new APIError('portal_page_editorial_unavailable', 503, undefined, true)

function normalizedDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw unavailable()
  return new Date(value).toISOString()
}

/** Verify the exact Version receipt from a new adapter session, not the writer's session. */
export async function confirmEditorialMutation(req: PayloadRequest, receipt: MutationReceipt): Promise<void> {
  const isolated = { ...req, transactionID: undefined, context: { ...req.context } } as PayloadRequest
  try {
    await withCmsTransaction(req.payload, isolated, async transactionReq => {
      const db = await requireCmsTransaction(req.payload, transactionReq)
      await db.execute(sql`SELECT id FROM portal_pages WHERE id = ${receipt.id}::uuid FOR UPDATE`)
      const found = await transactionReq.payload.findVersionByID({ collection: 'portal-pages', id: receipt.versionID,
        req: transactionReq, overrideAccess: true, depth: 0 })
      if (!found) throw unavailable()
      const row = found as unknown as Record<string, unknown>
      const content = row.version && typeof row.version === 'object' && !Array.isArray(row.version)
        ? row.version as Record<string, unknown> : null
      const rawParent = typeof row.parent === 'string' ? row.parent
        : row.parent && typeof row.parent === 'object' && !Array.isArray(row.parent)
          ? (row.parent as Record<string, unknown>).id : null
      const parent = uuid(rawParent, 'portal_page_editorial_unavailable')
      const versionID = uuid(row.id, 'portal_page_editorial_unavailable')
      if (!content || parent !== receipt.id || versionID !== receipt.versionID || row.autosave !== false ||
        normalizedDate(row.updatedAt) !== receipt.savedAt || content._status !== receipt.status ||
        content.createdBy !== receipt.createdBy || content.updatedBy !== receipt.updatedBy ||
        normalizedDate(content.publishedAt) !== receipt.publishedAt || await editableHash(content) !== receipt.editableHash) {
        throw unavailable()
      }
    })
  } catch {
    throw unavailable()
  }
}

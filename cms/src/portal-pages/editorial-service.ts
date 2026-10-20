import { APIError, type PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { canManagePortalPages } from '../auth/portal-pages-access'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import type { PortalPagePublicationInput, PortalPageRevisionStatus } from './contracts'
import { assertPortalPageCategoryReferences, assertPortalPageMediaReferences, projectPortalPageContent,
  withExpectedPortalPageVersion } from './persistence'
import { record, uuid } from './primitives'
import { validatePortalPagePublicationInput } from './validation'
import type { NativeEditable, PublicationResult, RevisionResult, SaveInput, SaveResult } from './editorial-contracts'
import { creationEquivalenceHash, editableHash, extractNativeEditable, stableValue, validateNativeEditable } from './editorial-native'
import { confirmEditorialMutation, type MutationReceipt } from './editorial-confirmation'
import { requirePortalPageEditor } from './editorial-auth'

const conflict = (code = 'portal_page_version_conflict') => new APIError(code, 409, undefined, true)
const notFound = () => new APIError('portal_page_not_found', 404, undefined, true)
const unavailable = () => new APIError('portal_page_editorial_unavailable', 503, undefined, true)
const denied = () => new APIError('editorial_permission_denied', 403, undefined, true)

function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(value)))
  return globalThis.crypto.subtle.digest('SHA-256', bytes).then(hash =>
    Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''))
}

function iso(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw unavailable()
  return new Date(value).toISOString()
}

function parentID(value: unknown): string {
  try {
    const raw = typeof value === 'string' ? value : record(value).id
    return uuid(raw, 'portal_page_editorial_unavailable')
  } catch { throw unavailable() }
}

function versionContent(row: Record<string, unknown>): Record<string, unknown> {
  if (!row.version || typeof row.version !== 'object' || Array.isArray(row.version)) throw unavailable()
  return row.version as Record<string, unknown>
}

function pageStatus(page: unknown): PortalPageRevisionStatus {
  const status = record(page)._status
  if (status !== 'draft' && status !== 'published') throw unavailable()
  return status
}

async function pageByID(req: PayloadRequest, id: string) {
  const page = await req.payload.findByID({ collection: 'portal-pages', id, req, overrideAccess: true, depth: 0,
    draft: false, disableErrors: true })
  if (!page) throw notFound()
  return page as unknown as Record<string, unknown>
}

async function versions(req: PayloadRequest, id: string, whereExtra: Record<string, unknown>[] = [], limit = 2) {
  const result = await req.payload.findVersions({ collection: 'portal-pages', req,
    where: { and: [{ parent: { equals: id } }, ...whereExtra] } as never,
    depth: 0, overrideAccess: true, limit, sort: ['-updatedAt', '-id'] })
  return result.docs as unknown as Record<string, unknown>[]
}

async function latestVersion(req: PayloadRequest, id: string): Promise<Record<string, unknown> | null> {
  const docs = await versions(req, id, [{ latest: { equals: true } }], 2)
  if (docs.length > 1) throw unavailable()
  if (!docs.length) return null
  const row = docs[0]
  if (row.latest !== true || parentID(row.parent) !== id || typeof row.autosave !== 'boolean') throw unavailable()
  return row
}

async function explicitVersion(req: PayloadRequest, id: string): Promise<Record<string, unknown> | null> {
  const docs = await versions(req, id, [{ autosave: { equals: false } }], 1)
  if (!docs.length) return null
  const row = docs[0]
  if (row.autosave !== false || parentID(row.parent) !== id) throw unavailable()
  return row
}

export async function snapshotHash(row: Record<string, unknown>): Promise<string> {
  try {
    if (typeof row.id !== 'string' || typeof row.autosave !== 'boolean') throw unavailable()
    const id = uuid(row.id, 'portal_page_editorial_unavailable')
    const parent = parentID(row.parent)
    const updatedAt = iso(row.updatedAt)
    const editable = extractNativeEditable(versionContent(row))
    return await sha256({ parent, id, autosave: row.autosave, updatedAt, editable })
  } catch { throw unavailable() }
}

function freshRequest(req: PayloadRequest): PayloadRequest {
  return { ...req, transactionID: undefined, context: { ...req.context } } as PayloadRequest
}

function requireManager(req: PayloadRequest): void {
  if (!canManagePortalPages({ req })) throw denied()
}

export async function readEditorialRevision(req: PayloadRequest, rawID: string): Promise<RevisionResult> {
  const id = uuid(rawID)
  requirePortalPageEditor(req)
  return withCmsTransaction(req.payload, freshRequest(req), async transactionReq => {
    const db = await requireCmsTransaction(req.payload, transactionReq)
    await db.execute(sql`SELECT id FROM portal_pages WHERE id = ${id}::uuid FOR UPDATE`)
    const page = await pageByID(transactionReq, id)
    const documentStatus = pageStatus(page)
    const latest = await latestVersion(transactionReq, id)
    const explicit = await explicitVersion(transactionReq, id)
    let latestResult: RevisionResult['latest'] = null
    if (latest) {
      const content = versionContent(latest)
      latestResult = {
        version_id: uuid(latest.id, 'portal_page_editorial_unavailable'),
        autosave: latest.autosave as boolean,
        saved_at: iso(latest.updatedAt),
        snapshot_hash: await snapshotHash(latest),
        editable_hash: await editableHash(content),
      }
    }
    let explicitResult: RevisionResult['explicit'] = null
    if (explicit) explicitResult = {
      version_id: uuid(explicit.id, 'portal_page_editorial_unavailable'),
      saved_at: iso(explicit.updatedAt),
      is_latest: latest?.id === explicit.id,
    }
    return { id, document_status: documentStatus, latest: latestResult, explicit: explicitResult }
  })
}

function validateSaveInput(raw: SaveInput): SaveInput {
  const input = record(raw, 'invalid_portal_page_editorial_request')
  if (input.id === null) {
    if (Object.keys(input).sort().join(',') !== 'data,id') throw new APIError('invalid_portal_page_editorial_request', 400, undefined, true)
    return { id: null, data: validateNativeEditable(input.data) }
  }
  if (Object.keys(input).sort().join(',') !== 'expected_latest_version_id,expected_snapshot_hash,id') {
    throw new APIError('invalid_portal_page_editorial_request', 400, undefined, true)
  }
  const id = uuid(input.id, 'invalid_portal_page_editorial_request')
  const expectedVersionID = uuid(input.expected_latest_version_id, 'invalid_portal_page_editorial_request')
  if (typeof input.expected_snapshot_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(input.expected_snapshot_hash)) {
    throw new APIError('invalid_portal_page_editorial_request', 400, undefined, true)
  }
  return { id, expected_latest_version_id: expectedVersionID, expected_snapshot_hash: input.expected_snapshot_hash }
}

type ReceiptExpectation = { mode: 'exact' | 'creation'; editable: NativeEditable }

function normalizePublishedAt(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return iso(value)
}

async function createReceipt(id: string, row: Record<string, unknown>, expected: ReceiptExpectation): Promise<MutationReceipt> {
  const content = versionContent(row)
  const createdBy = content.createdBy
  const updatedBy = content.updatedBy
  if (typeof createdBy !== 'string' || !createdBy || typeof updatedBy !== 'string' || !updatedBy ||
    row.autosave !== false || parentID(row.parent) !== id) throw unavailable()
  const hash = await editableHash(content)
  const expectedHash = await editableHash(expected.editable)
  const comparisonHash = expected.mode === 'creation'
    ? await creationEquivalenceHash(expected.editable, content) : hash
  if (comparisonHash !== expectedHash) throw unavailable()
  const status = content._status
  if (status !== 'draft' && status !== 'published') throw unavailable()
  return { id, versionID: uuid(row.id, 'portal_page_editorial_unavailable'), editableHash: hash,
    status, publishedAt: normalizePublishedAt(content.publishedAt), createdBy, updatedBy, savedAt: iso(row.updatedAt) }
}

async function requireResultingVersion(req: PayloadRequest, id: string, sourceID: string | null,
  expected: ReceiptExpectation): Promise<MutationReceipt> {
  const row = await latestVersion(req, id)
  if (!row || row.autosave !== false || row.id === sourceID || row.id === id) throw unavailable()
  return createReceipt(id, row, expected)
}

export async function saveEditorialVersion(req: PayloadRequest, rawInput: SaveInput): Promise<SaveResult> {
  requirePortalPageEditor(req)
  const input = validateSaveInput(rawInput)
  const isolated = freshRequest(req)
  const { receipt, result } = await withCmsTransaction(req.payload, isolated, async transactionReq => {
    const db = await requireCmsTransaction(req.payload, transactionReq)
    let id: string
    let sourceID: string | null = null
    let principalStatus: PortalPageRevisionStatus
    let expected: NativeEditable
    let receiptExpectation: ReceiptExpectation

    if (input.id === null) {
      expected = input.data
      receiptExpectation = { mode: 'creation', editable: expected }
      const created = await transactionReq.payload.create({ collection: 'portal-pages', data: { ...expected, _status: 'draft' },
        req: transactionReq, draft: true, autosave: false, overrideAccess: false, depth: 0 } as never)
      id = uuid((created as unknown as Record<string, unknown>).id, 'portal_page_editorial_unavailable')
      principalStatus = 'draft'
    } else {
      id = input.id
      await db.execute(sql`SELECT id FROM portal_pages WHERE id = ${id}::uuid FOR UPDATE`)
      const page = await pageByID(transactionReq, id)
      principalStatus = pageStatus(page)
      const current = await latestVersion(transactionReq, id)
      if (!current || current.id !== input.expected_latest_version_id ||
        await snapshotHash(current) !== input.expected_snapshot_hash) throw conflict()
      sourceID = String(current.id)
      expected = extractNativeEditable(versionContent(current))
      receiptExpectation = { mode: 'exact', editable: expected }
      await transactionReq.payload.update({ collection: 'portal-pages', id,
        data: { ...expected, _status: 'draft' }, req: transactionReq, draft: true, autosave: false,
        overrideAccess: false, depth: 0 } as never)
    }

    // Create/update hooks must create a new persisted non-autosave Version through the public API.
    const mutation = await requireResultingVersion(transactionReq, id, sourceID, receiptExpectation)
    if (mutation.status !== 'draft') throw unavailable()
    return { receipt: mutation, result: { id, version_id: mutation.versionID, saved_at: mutation.savedAt,
      editable_hash: mutation.editableHash, document_status: principalStatus } }
  })
  await confirmEditorialMutation(req, receipt)
  return result
}

export async function transitionEditorialPublication(req: PayloadRequest,
  rawInput: PortalPagePublicationInput): Promise<PublicationResult> {
  requirePortalPageEditor(req)
  const input = validatePortalPagePublicationInput(rawInput)
  requireManager(req)
  const isolated = freshRequest(req)
  const receipt = await withExpectedPortalPageVersion(isolated, input, async (transactionReq, source) => {
    if (parentID(source.parent) !== input.id) throw conflict()
    const sourceID = uuid(source.id, 'portal_page_editorial_unavailable')
    const current = await pageByID(transactionReq, input.id)
    const currentStatus = pageStatus(current)
    if (input.operation === 'unpublish' && currentStatus !== 'published') {
      throw conflict('portal_page_not_published')
    }
    const expected = extractNativeEditable(versionContent(source))
    const body = projectPortalPageContent(expected.body)
    await assertPortalPageCategoryReferences(transactionReq.payload, expected.categories, transactionReq)
    const cover = expected.cover === null ? null : { asset_id: expected.cover, alt: expected.coverAlt as string }
    await assertPortalPageMediaReferences(transactionReq.payload, { cover, body }, transactionReq,
      { requireComplete: input.operation === 'publish' })
    const status = input.operation === 'publish' ? 'published' : 'draft'
    await transactionReq.payload.update({ collection: 'portal-pages', id: input.id, req: transactionReq,
      data: { ...expected, _status: status }, draft: false, autosave: false, overrideAccess: false, depth: 0 })
    const mutation = await requireResultingVersion(transactionReq, input.id, sourceID, { mode: 'exact', editable: expected })
    if (mutation.status !== status || (status === 'published' && mutation.publishedAt === null) ||
      (status === 'draft' && mutation.publishedAt !== null)) throw unavailable()
    const principal = await pageByID(transactionReq, input.id)
    if (pageStatus(principal) !== status || await editableHash(principal) !== mutation.editableHash) throw unavailable()
    return mutation
  })
  await confirmEditorialMutation(req, receipt)
  return { id: input.id, operation: input.operation, source_version_id: input.expected_version_id,
    resulting_version_id: receipt.versionID, document_status: receipt.status, published_at: receipt.publishedAt }
}

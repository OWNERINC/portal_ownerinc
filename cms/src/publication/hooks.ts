import { APIError, type CollectionBeforeOperationHook, type CollectionBeforeChangeHook, type CollectionAfterChangeHook,
  type GlobalBeforeOperationHook, type GlobalBeforeChangeHook, type GlobalAfterChangeHook, type PayloadRequest } from 'payload'
import { assertCmsWriteAuthority } from './authority'
import { lockPublicationDocument, requireCmsTransaction, type PublicationTarget } from './transaction'
import { currentDocument, latestRevision, type NewsSnapshot } from './document'
import { appendNewsAudit, publicationActor, type AuditAction } from './audit'
import { cancelPendingSchedules } from './schedule'
import { isLegacyNewsImport } from '../news/validation'

const operationState = Symbol('news-publication-operation')
type State = { target: PublicationTarget; id: string; base: NewsSnapshot; draft: boolean; creating: boolean; action?: AuditAction }
const state = (req: PayloadRequest): State => {
  const value = Object.getOwnPropertyDescriptor(req.context, operationState)?.value
  if (!value) throw new APIError('news_publication_protocol_required', 503, undefined, true)
  return value
}
async function begin(req: PayloadRequest, target: PublicationTarget, id: string, draft: boolean, creating = false) {
  // Article beforeOperation's preceding protectArticleReferences has already
  // locked and freshly checked authority/actor, before any native snapshot.
  await requireCmsTransaction(req.payload, req)
  if (!creating) await lockPublicationDocument(req, target, id)
  const base = creating ? {} : await currentDocument(req, target, id)
  req.context = { ...req.context, newsPublicationProtocol: true }
  Object.defineProperty(req.context, operationState, { value: { target, id, base, draft, creating }, configurable: true, enumerable: true })
}
export const beforeArticlePublication: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['create', 'update', 'restoreVersion'].includes(operation)) return
  await begin(req, 'news-articles', operation !== 'create' && 'id' in args ? String(args.id) : '', Boolean('draft' in args && args.draft), operation === 'create')
}
export const refuseArticleVersionRestore: CollectionBeforeOperationHook = ({ operation }) => {
  if (operation === 'restoreVersion') throw new APIError('news_version_restore_unavailable', 403, undefined, true)
}
export const beforeHomePublication: GlobalBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation === 'restoreVersion') throw new APIError('news_version_restore_unavailable', 403, undefined, true)
  if (!['update', 'restoreVersion'].includes(operation)) return
  await assertCmsWriteAuthority(req)
  await lockPublicationDocument(req, 'news-home', 'news-home')
  // Native globals can otherwise save a first draft with no base row to lock/generate against.
  let base = await req.payload.db.findGlobal({ slug: 'news-home', req })
  const creating = !base?.id
  if (!base?.id) base = await req.payload.db.createGlobal({ slug: 'news-home', req,
    data: { eyebrow: '', headline: '', summary: '', _status: 'draft', publicationGeneration: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
  req.context = { ...req.context, newsPublicationProtocol: true }
  Object.defineProperty(req.context, operationState, { value: { target: 'news-home', id: 'news-home', base, draft: Boolean(args.draft), creating }, configurable: true, enumerable: true })
}
function prepare(req: PayloadRequest, data: NewsSnapshot, originalDoc: NewsSnapshot = {}) {
  const current = state(req)
  data._status ??= originalDoc._status || 'draft'
  if (current.draft && data._status !== 'published') data._status = 'draft'
  const publishing = data._status === 'published'
  const withdrawing = data._status === 'draft' && !current.draft && !current.creating
  current.action = publishing ? 'published' : withdrawing ? 'unpublished' : 'draft_saved'
  data.publicationGeneration = Number(current.base.publicationGeneration || 0) + (withdrawing ? 1 : 0)
  data.publishedAt = current.base.publishedAt || (isLegacyNewsImport(req.context) ? data.publishedAt : null) || (publishing ? new Date().toISOString() : null)
  return data
}
export const prepareArticlePublication: CollectionBeforeChangeHook = ({ data, req, originalDoc }) => prepare(req, data, originalDoc)
export const prepareHomePublication: GlobalBeforeChangeHook = ({ data, req, originalDoc }) => prepare(req, data, originalDoc)

async function finish(req: PayloadRequest, doc: NewsSnapshot) {
  const current = state(req)
  await requireCmsTransaction(req.payload, req)
  const id = current.target === 'news-home' ? 'news-home' : current.id || String(doc.id)
  // Caller `select` must not erase authoritative audit metadata from afterChange.
  const generation = Number(current.base.publicationGeneration || 0) + (current.action === 'unpublished' ? 1 : 0)
  if (current.action === 'unpublished') await cancelPendingSchedules(req, current.target, id, 'withdrawn')
  const revision = await latestRevision(req, current.target, id)
  if (!revision || !current.action) throw new APIError('news_audit_version_required', 503, undefined, true)
  await appendNewsAudit(req, { action: current.action, documentId: id, versionId: revision.id,
    actorUid: publicationActor(req), details: { target: current.target, generation } })
  return doc
}
export const afterArticlePublication: CollectionAfterChangeHook = ({ req, doc }) => finish(req, doc)
export const afterHomePublication: GlobalAfterChangeHook = ({ req, doc }) => finish(req, doc)

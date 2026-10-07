import { APIError, type CollectionBeforeOperationHook, type CollectionBeforeChangeHook, type CollectionAfterChangeHook,
  type GlobalBeforeOperationHook, type GlobalBeforeChangeHook, type GlobalAfterChangeHook, type PayloadRequest } from 'payload'
import { assertCmsWriteAuthority } from './authority'
import { lockPublicationDocument, requireCmsTransaction, type PublicationTarget } from './transaction'
import { currentDocument, latestRevision, type NewsSnapshot } from './document'
import { appendNewsAudit, publicationActor, type AuditAction } from './audit'
import { cancelPendingSchedules } from './schedule'
import { isLegacyNewsImport, normalizeNewsHome } from '../news/validation'

const operationState = Symbol('news-publication-operation')
type State = { target: PublicationTarget; id: string; base: NewsSnapshot; draft: boolean; creating: boolean; restore?: NewsSnapshot; action?: AuditAction }
const state = (req: PayloadRequest): State => {
  const value = Object.getOwnPropertyDescriptor(req.context, operationState)?.value
  if (!value) throw new APIError('news_publication_protocol_required', 503, undefined, true)
  return value
}
async function begin(req: PayloadRequest, target: PublicationTarget, id: string, draft: boolean, creating = false, restore?: NewsSnapshot) {
  // Article beforeOperation's preceding protectArticleReferences has already
  // locked and freshly checked authority/actor, before any native snapshot.
  await requireCmsTransaction(req.payload, req)
  if (!creating) await lockPublicationDocument(req, target, id)
  const base = creating ? {} : await currentDocument(req, target, id)
  req.context = { ...req.context, newsPublicationProtocol: true }
  Object.defineProperty(req.context, operationState, { value: { target, id, base, draft, creating, restore }, configurable: true, enumerable: true })
}
export const beforeArticlePublication: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['create', 'update', 'restoreVersion'].includes(operation)) return
  if (operation === 'restoreVersion' && 'id' in args) {
    // Authority/lock must precede even the source-version lookup.
    await requireCmsTransaction(req.payload, req)
    const version = await req.payload.findVersionByID({ collection: 'news-articles', id: String(args.id), req, overrideAccess: true, depth: 0 })
    const parent = version.parent
    if (!parent) throw new APIError('news_document_not_found', 404, undefined, true)
    await begin(req, 'news-articles', String(parent), Boolean('draft' in args && args.draft), false, version.version as unknown as NewsSnapshot)
  } else await begin(req, 'news-articles', operation !== 'create' && 'id' in args ? String(args.id) : '', Boolean('draft' in args && args.draft), operation === 'create')
}
export const beforeHomePublication: GlobalBeforeOperationHook = async ({ args, operation, req }) => {
  if (!['update', 'restoreVersion'].includes(operation)) return
  await assertCmsWriteAuthority(req)
  await lockPublicationDocument(req, 'news-home', 'news-home')
  // Native globals can otherwise save a first draft with no base row to lock/generate against.
  let base = await req.payload.db.findGlobal({ slug: 'news-home', req })
  const creating = !base?.id
  if (!base?.id) base = await req.payload.db.createGlobal({ slug: 'news-home', req,
    data: { eyebrow: '', headline: '', summary: '', _status: 'draft', publicationGeneration: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } })
  let restore: NewsSnapshot | undefined
  if (operation === 'restoreVersion') {
    const source = await req.payload.findGlobalVersionByID({ slug: 'news-home', id: args.id, req, overrideAccess: true, depth: 0 })
    restore = { ...source.version, _status: args.draft ? 'draft' : source.version._status }
    // The pinned native GLOBAL restore skips beforeChange entirely.
    normalizeNewsHome(restore, restore._status === 'published')
  }
  req.context = { ...req.context, newsPublicationProtocol: true }
  Object.defineProperty(req.context, operationState, { value: { target: 'news-home', id: 'news-home', base, draft: Boolean(args.draft), creating, restore }, configurable: true, enumerable: true })
}
function prepare(req: PayloadRequest, data: NewsSnapshot, originalDoc: NewsSnapshot = {}) {
  const current = state(req)
  data._status ??= originalDoc._status || 'draft'
  if (current.draft && (current.restore || data._status !== 'published')) data._status = 'draft'
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
export const afterHomePublication: GlobalAfterChangeHook = async ({ req, doc }) => {
  const current = state(req)
  if (current.restore) {
    // Public adapter methods inside the native transaction correct its restore semantics:
    // restore-as-draft must NOT overwrite the published global; old generations never return.
    const restored = prepare(req, { ...current.restore })
    restored.id = current.base.id
    restored.updatedAt = new Date().toISOString()
    const revision = await latestRevision(req, 'news-home', 'news-home')
    if (!revision) throw new APIError('news_restore_version_missing', 503, undefined, true)
    await req.payload.db.updateGlobalVersion({ global: 'news-home', id: revision.id, req, versionData: { version: restored } })
    await req.payload.db.updateGlobal({ slug: 'news-home', req, data: current.draft ? current.base : restored })
    return finish(req, restored)
  }
  return finish(req, doc)
}

import { APIError, restoreVersionOperation, updateOperationGlobal, type CollectionBeforeOperationHook, type GlobalBeforeOperationHook, type PayloadRequest, type Where } from 'payload'
import { assertNewsHistoryAccess } from '../auth/news-history-access'
import { configuredEditorialProfile, editorialBoundary, type EditorialProfile } from '../config/editorial-profile'
import { assertCmsWriteAuthority } from './authority'
import { currentDocument, latestRevision, snapshotDocument, snapshotHash, type NewsSnapshot } from './document'
import { lockPublicationDocument, requireCmsTransaction, withCmsTransaction, type PublicationTarget } from './transaction'
import { keys, record, uuid } from '../news/primitives'
import { publicationActor } from './audit'

export type RestoreTarget = { target: PublicationTarget; documentId: string; sourceVersionId: string }
export type RestoreDraftInput = RestoreTarget & { sourceRevisionToken: string; expectedHeadToken: string }
type Revision = { id: string; parent?: unknown; updatedAt: string; autosave?: boolean; version: NewsSnapshot }
type Scope = RestoreDraftInput & { session: unknown; actorUid: string; base: NewsSnapshot; sourceStatus: 'draft' | 'published' }
const scopeKey = Symbol('news-restore-draft')
const liveScopes = new WeakSet<Scope>()
const unavailable = (): never => { throw new APIError('news_version_restore_unavailable', 403, undefined, true) }
const conflict = (): never => { throw new APIError('news_restore_conflict', 409, undefined, true) }
const notFound = (): never => { throw new APIError('news_version_not_found', 404, undefined, true) }
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)

export function readRestoreTarget(value: unknown, mutation = false): RestoreDraftInput | RestoreTarget {
  const input = record(value)
  keys(input, ['target', 'documentId', 'sourceVersionId', ...(mutation ? ['sourceRevisionToken', 'expectedHeadToken'] : [])])
  if (typeof input.target !== 'string' || !['news-articles', 'news-home'].includes(input.target)) throw new APIError('invalid_restore_request', 400)
  const target = input.target as PublicationTarget
  const documentId = target === 'news-home' ? input.documentId === 'news-home' ? 'news-home' : notFound() : uuid(input.documentId)
  const result = { target, documentId, sourceVersionId: uuid(input.sourceVersionId) }
  if (!mutation) return result
  if (!digest(input.sourceRevisionToken) || !digest(input.expectedHeadToken)) throw new APIError('invalid_restore_request', 400)
  return { ...result, sourceRevisionToken: input.sourceRevisionToken, expectedHeadToken: input.expectedHeadToken }
}

/** Token covers coalesced autosave bytes, never just its reusable ID or latest bit. */
export function revisionToken(target: PublicationTarget, documentId: string, revision: Revision): string {
  uuid(revision.id)
  if (!Number.isFinite(Date.parse(revision.updatedAt))) return conflict()
  return snapshotHash({ tokenVersion: 1, target, documentId, versionId: revision.id, savedAt: revision.updatedAt,
    autosave: revision.autosave === true, status: revision.version._status, version: revision.version })
}

export function restoreScope(req: PayloadRequest): Scope | undefined {
  const value = Object.getOwnPropertyDescriptor(req.context, scopeKey)?.value as Scope | undefined
  return value && liveScopes.has(value) ? value : undefined
}
export async function assertRestoreScope(req: PayloadRequest): Promise<Scope> {
  const scope = restoreScope(req)
  if (!scope || scope.session !== await requireCmsTransaction(req.payload, req) || scope.actorUid !== publicationActor(req) ||
    configuredEditorialProfile(req.payload.config) !== 'editorial-v1') return unavailable()
  return scope
}

export function createArticleRestoreGuard(profile: EditorialProfile): CollectionBeforeOperationHook {
  return editorialBoundary(async ({ operation, args, req }) => {
    if (operation !== 'restoreVersion') return
    if (profile !== 'editorial-v1' || !restoreScope(req) || !('draft' in args) || args.draft !== true) return unavailable()
    const scope = await assertRestoreScope(req)
    if (scope.target !== 'news-articles' || !('id' in args) || args.id !== scope.sourceVersionId) return unavailable()
  }, profile, 'restore')
}
export function createHomeRestoreGuard(profile: EditorialProfile): GlobalBeforeOperationHook {
  return editorialBoundary(({ operation }) => { if (operation === 'restoreVersion') return unavailable() }, profile, 'restore')
}

async function sourceRevision(req: PayloadRequest, input: RestoreTarget): Promise<Revision> {
  await requireCmsTransaction(req.payload, req)
  const revision = input.target === 'news-articles'
    ? await req.payload.findVersionByID({ collection: 'news-articles', id: input.sourceVersionId, req, overrideAccess: false, depth: 0 })
    : await req.payload.findGlobalVersionByID({ slug: 'news-home', id: input.sourceVersionId, req, overrideAccess: false, depth: 0 })
  if (!revision || !revision.version || !['draft', 'published'].includes(String(revision.version._status))) return notFound()
  if (input.target === 'news-articles') {
    const parent = 'parent' in revision ? revision.parent : undefined
    if (typeof parent !== 'string' || uuid(parent) !== input.documentId) return notFound()
  }
  return revision as unknown as Revision
}

async function readState(req: PayloadRequest, input: RestoreTarget) {
  await sourceRevision(req, input)
  await lockPublicationDocument(req, input.target, input.documentId)
  const source = await sourceRevision(req, input)
  const base = await currentDocument(req, input.target, input.documentId)
  const head = await latestRevision(req, input.target, input.documentId, false) as unknown as Revision | undefined
  if (!head) return conflict()
  if (input.target === 'news-articles' && head.parent !== input.documentId) return notFound()
  return { source, base, head, sourceRevisionToken: revisionToken(input.target, input.documentId, source),
    expectedHeadToken: revisionToken(input.target, input.documentId, head) }
}

/** Read-only comparison endpoint; never creates a draft, audit row or global base. */
export async function readRestoreDraft(req: PayloadRequest, value: unknown) {
  const input = readRestoreTarget(value)
  return withCmsTransaction(req.payload, req, async request => {
    const authority = await assertNewsHistoryAccess(request)
    const state = await readState(request, input)
    const locked = await hasForeignEditingLock(request, input)
    const audits = await request.payload.find({ collection: 'news-audit', req: request, overrideAccess: true, depth: 0, limit: 1,
      sort: '-createdAt', where: { and: [{ documentId: { equals: input.documentId } }, { versionId: { equals: state.head.id } }] } })
    const details = audits.docs[0]?.details as Record<string, unknown> | undefined
    return { ...input, sourceRevisionToken: state.sourceRevisionToken, expectedHeadToken: state.expectedHeadToken,
      source: { id: state.source.id, savedAt: state.source.updatedAt, status: state.source.version._status,
        content: snapshotDocument(input.target, state.source.version) },
      head: { id: state.head.id, savedAt: state.head.updatedAt, status: state.head.version._status,
        content: snapshotDocument(input.target, state.head.version),
        restoredFrom: details?.saveKind === 'restore' && typeof details.sourceVersionId === 'string' ? details.sourceVersionId : null },
      canRestore: authority.mode === 'payload' && authority.activationObserved === true && !locked }
  })
}

async function hasForeignEditingLock(req: PayloadRequest, input: RestoreTarget): Promise<boolean> {
  // Match 3.90.2's target query, newest lock and duration, but NEVER call its
  // checkDocumentLockStatus on a read: that helper also deletes matching locks.
  // Both comparison and the mutation recheck use the authenticated actor and tx.
  await requireCmsTransaction(req.payload, req)
  const entity = input.target === 'news-articles' ? req.payload.collections[input.target].config : req.payload.config.globals.find(g => g.slug === input.target)!
  if (entity.lockDocuments === false || !req.payload.collections['payload-locked-documents']) return false
  const where: Where = input.target === 'news-articles'
    ? { and: [{ 'document.relationTo': { equals: input.target } }, { 'document.value': { equals: input.documentId } }] }
    : { globalSlug: { equals: input.target } }
  const locks = await req.payload.db.find({ collection: 'payload-locked-documents', req, where, limit: 1, pagination: false, sort: '-updatedAt' })
  const lock = locks.docs[0] as unknown as { user?: { relationTo?: string; value?: string }; updatedAt: string } | undefined
  if (!lock) return false
  const duration = typeof entity.lockDocuments === 'object' ? entity.lockDocuments.duration : 300
  const ownLock = lock.user?.value === req.user?.id && lock.user?.relationTo === req.user?.collection
  return !ownLock && (!Number.isFinite(Date.parse(lock.updatedAt)) || Date.now() - Date.parse(lock.updatedAt) <= duration * 1000)
}

/** 3.90.2 checkDocumentLockStatus omits req on its find. Bind that one lookup
 * through a per-call facade, never mutate the shared adapter or use its pool. */
function homeRestoreRequest(req: PayloadRequest): PayloadRequest {
  const scoped = { ...req, headers: req.headers, url: req.url, method: req.method, signal: req.signal } as PayloadRequest
  const db = new Proxy(req.payload.db, { get(adapter, key, receiver) {
    if (key !== 'find') return Reflect.get(adapter, key, receiver)
    return async (args: Parameters<typeof adapter.find>[0]) => {
      await assertRestoreScope(scoped)
      if (!args.req && args.collection !== 'payload-locked-documents') return unavailable()
      return adapter.find({ ...args, req: args.req || scoped })
    }
  } })
  scoped.payload = new Proxy(req.payload, { get(payload, key, receiver) {
    return key === 'db' ? db : Reflect.get(payload, key, receiver)
  } })
  return scoped
}

export async function restoreNewsDraft(req: PayloadRequest, value: unknown) {
  const input = readRestoreTarget(value, true) as RestoreDraftInput
  if (configuredEditorialProfile(req.payload.config) !== 'editorial-v1') return unavailable()
  const callerOwnsTransaction = Boolean(req.transactionID)
  const result = await withCmsTransaction(req.payload, req, async request => {
    await assertCmsWriteAuthority(request)
    await assertNewsHistoryAccess(request)
    const state = await readState(request, input)
    if (state.sourceRevisionToken !== input.sourceRevisionToken || state.expectedHeadToken !== input.expectedHeadToken) return conflict()
    if (await hasForeignEditingLock(request, input)) throw new APIError('news_document_locked', 409, undefined, true)
    const scope: Scope = { ...input, base: state.base, sourceStatus: state.source.version._status as Scope['sourceStatus'],
      session: await requireCmsTransaction(req.payload, request), actorUid: publicationActor(request) }
    if (restoreScope(request)) return conflict()
    liveScopes.add(scope)
    Object.defineProperty(request.context, scopeKey, { value: scope, configurable: true, enumerable: true })
    try {
      if (input.target === 'news-articles') {
        // 3.90.2's Local API restoreVersion silently drops draft. Use the public operation.
        await restoreVersionOperation({ collection: request.payload.collections['news-articles'], id: input.sourceVersionId,
          draft: true, req: request, overrideAccess: false, depth: 0 })
      } else {
        // Local updateGlobal omits autosave; public normal update accepts an explicit false.
        await updateOperationGlobal({ slug: 'news-home', globalConfig: request.payload.config.globals.find(g => g.slug === 'news-home')!,
          data: { ...snapshotDocument('news-home', state.source.version), _status: 'draft' },
          draft: true, autosave: false, req: homeRestoreRequest(request), overrideAccess: false, overrideLock: false, depth: 0 })
      }
      const result = await latestRevision(request, input.target, input.documentId)
      if (!result || result.id === state.head.id || result.id === input.sourceVersionId || result.version._status !== 'draft' || result.autosave === true ||
        snapshotHash(await currentDocument(request, input.target, input.documentId)) !== snapshotHash(state.base)) return conflict()
      return { target: input.target, documentId: input.documentId, sourceVersionId: input.sourceVersionId,
        versionId: result.id, savedAt: result.updatedAt, _status: 'draft' as const }
    } finally {
      liveScopes.delete(scope)
      delete request.context[scopeKey as unknown as string]
    }
  })
  if (!callerOwnsTransaction) {
    // The pinned adapter may swallow COMMIT failures. A fulfilled promise alone
    // is not a saved receipt: independently read the checkpoint and atomic audit.
    try {
      await withCmsTransaction(req.payload, req, async request => {
        const saved = await sourceRevision(request, { ...input, sourceVersionId: result.versionId })
        const audits = await request.payload.find({ collection: 'news-audit', req: request, overrideAccess: true, depth: 0, limit: 2,
          where: { and: [{ documentId: { equals: input.documentId } }, { versionId: { equals: result.versionId } }] } })
        const audit = audits.docs[0], details = audit?.details as Record<string, unknown> | undefined
        if (saved.version._status !== 'draft' || saved.autosave === true || audits.docs.length !== 1 ||
          audit.action !== 'draft_saved' || audit.actorUid !== publicationActor(request) || details?.saveKind !== 'restore' ||
          details.sourceVersionId !== input.sourceVersionId || details.sourceRevisionToken !== input.sourceRevisionToken ||
          details.snapshotHash !== snapshotHash(snapshotDocument(input.target, saved.version))) return conflict()
      })
    } catch { throw new APIError('news_restore_unconfirmed', 503, undefined, true) }
  }
  return result
}

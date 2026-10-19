import { APIError, type Field, type Payload, type PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import type { NewsContent } from '../contracts/news'
import { uuid } from '../news/primitives'
import { normalizeNewsDocument, normalizeNewsDraftReferences, validateNewsMediaShapes } from '../news/validation'
import { lockCmsReferences, requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { MediaFileUnavailableError, openStoredMedia } from './storage'
import { historyFields } from '../collections/LegacyNewsRevisions'

export class InvalidMediaReferenceError extends APIError {
  constructor() { super('invalid_media_reference', 400, undefined, true) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Input is the normalized FLAT boundary, never arbitrary JSON or native relations. */
export function collectMediaIds(content: NewsContent): Set<string> {
  return new Set(content.flatMap(block => 'asset_id' in block && typeof block.asset_id === 'string' ? [uuid(block.asset_id)] : []))
}

export async function assertMediaReferences(payload: Payload, content: NewsContent, req: PayloadRequest) {
  return withCmsTransaction(payload, req, async req => {
    const media = []
    for (const id of collectMediaIds(content)) {
      const db = await requireCmsTransaction(payload, req)
      await db.execute(sql`SELECT id FROM news_media WHERE id = ${id}::uuid FOR SHARE`)
      const asset = await payload.findByID({ collection: 'news-media', id, req, overrideAccess: true, depth: 0, disableErrors: true })
      if (!asset) throw new InvalidMediaReferenceError()
      media.push(asset)
      const handle = await openStoredMedia(payload, asset)
      await handle.close()
    }
    try { validateNewsMediaShapes(content, media) }
    catch (error) {
      if (error instanceof APIError && error.status === 400) throw new InvalidMediaReferenceError()
      throw error
    }
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
  return withCmsTransaction(payload, req, async req => {
    let damagedFile: MediaFileUnavailableError | undefined
    const authorized = await scanArticles(payload, req, false, async document => {
      if (document._status !== 'published') return false
      let content: NewsContent
      try { content = normalizeNewsDocument(document, true).blocks } catch { return false }
      if (!collectMediaIds(content).has(id)) return false
      try { await assertMediaReferences(payload, content, req) }
      catch (error) {
        if (error instanceof InvalidMediaReferenceError) return false
        // A damaged sibling file invalidates this publication, not another valid
        // grant. Remember 503 if the whole scan finds none. Never catch by status
        // or message here: DB/transaction/root-storage failures must propagate.
        if (error instanceof MediaFileUnavailableError) { damagedFile = error; return false }
        throw error
      }
      return true
    })
    if (!authorized && damagedFile) throw damagedFile
    return authorized
  })
}

/** Explicit inventory: new schedule/snapshot/history stores MUST extend this protection. */
export function assertReferenceStoreCoverage(payload: Payload) {
  const covered = new Set(['portal-editors', 'news-articles', 'news-media', 'news-schedules', 'news-audit', 'legacy-news-revisions', 'payload-preferences',
    'news-migration-runs', 'news-migration-items', 'portal-pages', 'portal-page-categories', 'portal-page-media',
    'payload-locked-documents', 'payload-migrations', 'payload-jobs', 'payload-kv'])
  const internal = ['id', 'createdAt', 'updatedAt', '_status']
  const publication = ['publishedAt', 'publicationGeneration', 'legacyDocumentId', 'legacySourceId', 'legacyRevisionId', 'importedAt']
  const onlyFields = (fields: Field[], names: string[]) => fields.every(field => 'name' in field && names.includes(field.name))
  const articles = payload.collections['news-articles'].config
  const home = payload.config.globals.find(global => global.slug === 'news-home')
  const schedules = payload.collections['news-schedules']?.config
  const audit = payload.collections['news-audit']?.config
  const history = payload.collections['legacy-news-revisions']?.config
  const migrationRuns = payload.collections['news-migration-runs']?.config
  const migrationItems = payload.collections['news-migration-items']?.config
  const portalPages = payload.collections['portal-pages']?.config
  const portalPageCategories = payload.collections['portal-page-categories']?.config
  const portalPageMedia = payload.collections['portal-page-media']?.config
  const tasks = payload.config.jobs.tasks || []
  if (Object.keys(payload.collections).some(slug => !covered.has(slug)) ||
    !migrationRuns || !migrationItems ||
    !portalPages || !portalPageCategories || !portalPageMedia ||
    payload.config.globals.some(global => global.slug !== 'news-home') || payload.config.jobs.workflows?.length ||
    tasks.some(task => task.slug !== 'publish-news-snapshot' || !onlyFields(task.inputSchema || [], ['scheduleId']) || !onlyFields(task.outputSchema || [], ['state'])) ||
     (schedules && !onlyFields(schedules.fields, [...internal, 'target', 'documentId', 'action', 'versionId', 'snapshot', 'snapshotHash', 'scheduledAt', 'actorUid', 'generation', 'state', 'jobId',
       'sourceScheduleKey', 'sourceRevisionId', 'importRunId', 'importManifestSha256', 'importAuthorityEpoch', 'originalScheduledAt', 'originalActorEvidence',
       'sourceSnapshot', 'sourceSnapshotHash', 'nativeSnapshotHash'])) ||
     (audit && !onlyFields(audit.fields, [...internal, 'action', 'documentId', 'versionId', 'actorUid', 'requestedByUid', 'details'])) ||
     (history && !onlyFields(history.fields, [...internal, ...historyFields])) ||
     (migrationRuns && !onlyFields(migrationRuns.fields, [...internal, 'manifestSha256', 'sourceInstance', 'sourceFingerprint', 'authorityEpoch', 'progressState', 'admissionState',
       'commitOutcome', 'reconciliationSequence', 'reconciliationChainSha256', 'reconciliationSha256', 'destinationFingerprint', 'unresolvedExceptions',
       'sealedSequence', 'sealedChainSha256', 'sealedAt', 'activationEpoch', 'drainReceiptSha256'])) ||
     (migrationItems && !onlyFields(migrationItems.fields, [...internal, 'runId', 'manifestSha256', 'entityKind', 'sourceId', 'expectedHash', 'destinationId', 'observedHash', 'state', 'commitOutcome'])) ||
     !onlyFields(articles.fields, [...internal, ...publication, 'title', 'category', 'editorial', 'body']) ||
     !onlyFields(portalPages.fields, [...internal, 'title', 'slug', 'summary', 'cover', 'coverAlt', 'categories', 'body', 'publishedAt', 'createdBy', 'updatedBy']) ||
     !onlyFields(portalPageCategories.fields, [...internal, 'name', 'slug', 'description']) ||
     !onlyFields(portalPageMedia.fields, [...internal, 'originalName', 'storageKey', 'mimeType', 'filesize', 'sha256', 'state', 'uploadedBy', 'completedAt']) ||
     !portalPageCollectionsAvoidNewsMedia(portalPages, portalPageCategories, portalPageMedia) ||
     (home && !onlyFields(home.fields, [...internal, ...publication, 'eyebrow', 'headline', 'summary'])) ||
    !articles.versions || articles.versions.maxPerDoc !== 0 ||
    (articles.versions.drafts && articles.versions.drafts.schedulePublish)) {
    throw new APIError('media_reference_store_not_covered', 503, undefined, true)
  }
}

/**
 * The page collection names are covered only after a structural walk proves that
 * every nested Payload relation targets page-local media/categories. This is
 * intentionally not a slug-only allowlist: a new block-level relationship to
 * news-media (or any other collection) invalidates the News deletion invariant.
 */
function portalPageCollectionsAvoidNewsMedia(...collections: Array<{ slug: string; fields: Field[] }>): boolean {
  const allowedTargets = new Set(['portal-page-media', 'portal-page-categories'])
  const relationTargets: string[] = []
  let hasNativeUpload = false

  const visit = (fields: unknown[]) => {
    for (const raw of fields) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
      const field = raw as Record<string, unknown>
      if (field.type === 'upload') hasNativeUpload = true
      if (field.type === 'relationship' || field.type === 'upload') {
        const relationTo = field.relationTo
        const targets = Array.isArray(relationTo) ? relationTo : typeof relationTo === 'string' ? [relationTo] : []
        if (targets.length === 0 || targets.some(target => typeof target !== 'string' || !allowedTargets.has(target))) return false
        relationTargets.push(...targets as string[])
      }
      if ('fields' in field) {
        if (!Array.isArray(field.fields) || !visit(field.fields)) return false
      }
      if ('blocks' in field) {
        if (!Array.isArray(field.blocks)) return false
        for (const block of field.blocks) {
          if (!block || typeof block !== 'object' || Array.isArray(block) ||
            !Array.isArray((block as Record<string, unknown>).fields) || !visit((block as Record<string, unknown>).fields as unknown[])) return false
        }
      }
      if (field.type === 'tabs') {
        if (!Array.isArray(field.tabs)) return false
        for (const tab of field.tabs) {
          if (!tab || typeof tab !== 'object' || Array.isArray(tab) ||
            !Array.isArray((tab as Record<string, unknown>).fields) || !visit((tab as Record<string, unknown>).fields as unknown[])) return false
        }
      }
    }
    return true
  }

  for (const collection of collections) if (!visit(collection.fields)) return false
  if (hasNativeUpload || relationTargets.includes('news-media')) return false

  const pageTargets = relationTargetsFrom(collections[0]!.fields)
  const categoryTargets = relationTargetsFrom(collections[1]!.fields)
  const mediaTargets = relationTargetsFrom(collections[2]!.fields)
  return pageTargets.every(target => allowedTargets.has(target)) && categoryTargets.length === 0 && mediaTargets.length === 0
}

function relationTargetsFrom(fields: unknown[]): string[] {
  const targets: string[] = []
  const visit = (items: unknown[]) => {
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const field = raw as Record<string, unknown>
      if (field.type === 'relationship') {
        const relationTo = field.relationTo
        if (typeof relationTo === 'string') targets.push(relationTo)
        else if (Array.isArray(relationTo)) targets.push(...relationTo.filter((target): target is string => typeof target === 'string'))
      }
      if (Array.isArray(field.fields)) visit(field.fields)
      if (Array.isArray(field.blocks)) for (const block of field.blocks) {
        if (block && typeof block === 'object' && Array.isArray((block as Record<string, unknown>).fields)) {
          visit((block as Record<string, unknown>).fields as unknown[])
        }
      }
      if (Array.isArray(field.tabs)) for (const tab of field.tabs) {
        if (tab && typeof tab === 'object' && Array.isArray((tab as Record<string, unknown>).fields)) {
          visit((tab as Record<string, unknown>).fields as unknown[])
        }
      }
    }
  }
  visit(fields)
  return targets
}

export async function assertMediaOrphan(payload: Payload, id: string, req: PayloadRequest) {
  await lockCmsReferences(payload, req)
  assertReferenceStoreCoverage(payload)
  id = uuid(id)
  await (await requireCmsTransaction(payload, req)).execute(sql`SELECT id FROM news_media WHERE id = ${id}::uuid FOR UPDATE`)
  const references = async (document: Record<string, unknown>) => collectMediaIds(normalizeNewsDraftReferences(document.body)).has(id)
  if (await scanArticles(payload, req, false, references) || await scanArticles(payload, req, true, references)) {
    throw new APIError('media_is_referenced', 409, undefined, true)
  }
  if (payload.collections['legacy-news-revisions']) {
    for (let page = 1; page <= 1000; page++) {
      await requireCmsTransaction(payload, req)
      const result = await payload.find({ collection: 'legacy-news-revisions', req, overrideAccess: true, depth: 0, limit: 100, page, sort: 'id' })
      for (const row of result.docs) {
        // Protect both independently: even a stale relation inventory cannot allow
        // deleting a raw original-body reference. Unknown blocks fail closed.
        const related = (row.mediaReferences || []).some(value => (typeof value === 'string' ? value : value.id) === id)
        if (related || collectMediaIds(normalizeNewsDraftReferences(row.originalBody)).has(id)) throw new APIError('media_is_referenced', 409, undefined, true)
      }
      if (!result.hasNextPage) break
      if (page === 1000) throw new APIError('media_reference_scan_limit', 503, undefined, true)
    }
  }
  if (payload.collections['news-schedules']) {
    for (let page = 1; page <= 1000; page++) {
      await requireCmsTransaction(payload, req)
      const result = await payload.find({ collection: 'news-schedules', req, overrideAccess: true, depth: 0, limit: 100, page, sort: 'id' })
      for (const schedule of result.docs) {
        if (schedule.target === 'news-articles') {
          const importProvenanceFields = ['sourceScheduleKey', 'sourceRevisionId', 'importRunId', 'importManifestSha256', 'importAuthorityEpoch',
            'originalScheduledAt', 'originalActorEvidence', 'sourceSnapshot', 'sourceSnapshotHash', 'nativeSnapshotHash']
          const isImported = importProvenanceFields.some(field => Object.hasOwn(schedule, field))
          const snapshot = schedule.snapshot
          if (!isRecord(snapshot) || !Array.isArray(snapshot.body)) {
            throw new APIError('media_reference_store_not_covered', 503, undefined, true)
          }
          // Imported suspended schedules retain two independent representations.
          // Neither state nor one valid snapshot may erase a reference in the other.
          if (await references(snapshot)) throw new APIError('media_is_referenced', 409, undefined, true)
          if (isImported) {
            const sourceSnapshot = schedule.sourceSnapshot
            if (!isRecord(sourceSnapshot) || !Array.isArray(sourceSnapshot.body)) {
              throw new APIError('media_reference_store_not_covered', 503, undefined, true)
            }
            if (await references(sourceSnapshot)) throw new APIError('media_is_referenced', 409, undefined, true)
          }
        } else if (schedule.target !== 'news-home') {
          throw new APIError('media_reference_store_not_covered', 503, undefined, true)
        }
      }
      if (!result.hasNextPage) break
      if (page === 1000) throw new APIError('media_reference_scan_limit', 503, undefined, true)
    }
  }
  for (let page = 1; page <= 1000; page++) {
    await requireCmsTransaction(payload, req)
    const result = await payload.find({ collection: 'news-migration-items', req, overrideAccess: true, depth: 0, limit: 100, page, sort: 'id' })
    for (const item of result.docs) {
      if (item.entityKind !== 'asset') continue
      // Keep reservations in every ledger state (including planned and unknown
      // COMMIT). A row is released only by deleting its durable reference, never
      // by interpreting a progress label as proof that its bytes are unused.
      const ids = [item.sourceId, item.destinationId].filter(value => value != null)
      if (ids.some(value => uuid(value) === id)) throw new APIError('media_is_referenced', 409, undefined, true)
    }
    if (!result.hasNextPage) break
    if (page === 1000) throw new APIError('media_reference_scan_limit', 503, undefined, true)
  }
}

import type { Payload, PayloadRequest } from 'payload'
import { snapshotHash } from '../publication/document'
import { historyFields } from '../collections/LegacyNewsRevisions'
import { payloadToLegacyBlock } from '../news/legacy-blocks'
import type { ExpectedImportItem, ObservedImportItem } from './reconcile'
import type { StagedImportAsset } from './staging'
import { verifyImportPromotion } from './staging'

type API = {
  find(args: Record<string, unknown>): Promise<{ docs: Record<string, unknown>[] }>
  findByID(args: Record<string, unknown>): Promise<Record<string, unknown> | null>
  findGlobal(args: Record<string, unknown>): Promise<Record<string, unknown> | null>
  findGlobalVersions(args: Record<string, unknown>): Promise<{ docs: Record<string, unknown>[] }>
  findVersions(args: Record<string, unknown>): Promise<{ docs: Record<string, unknown>[] }>
}
const api = (payload: Payload) => payload as unknown as API
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const time = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const relationId = (value: unknown): string => typeof value === 'string' ? value : String(asRecord(value).id ?? '')

function historyProjection(doc: Record<string, unknown>) {
  return Object.fromEntries(historyFields.map(field => {
    const value = doc[field]
    if (field === 'mediaReferences') return [field, Array.isArray(value) ? value.map(relationId).sort() : []]
    return [field, value ?? (field === 'originalPublishedAt' || field === 'originalActorUid' || field === 'originalEditorial' || field === 'metadataBasis' ? null : value)]
  }))
}

function nativeArticleVersion(value: Record<string, unknown> | undefined) {
  if (!value) return null
  const body = Array.isArray(value.body) ? value.body.map(payloadToLegacyBlock) : []
  return { title: value.title, category: value.category, body, editorial: value.editorial ?? null, publishedAt: time(value.publishedAt) }
}

async function articleObservation(payload: Payload, req: PayloadRequest, expected: ExpectedImportItem): Promise<ObservedImportItem | null> {
  const id = expected.sourceId
  const document = await api(payload).findByID({ collection: 'news-articles', id, req, overrideAccess: true, depth: 0, draft: false, disableErrors: true })
  const [draftDoc, versions] = await Promise.all([
    api(payload).findByID({ collection: 'news-articles', id, req, overrideAccess: true, depth: 0, draft: true, disableErrors: true }),
    api(payload).findVersions({ collection: 'news-articles', req, overrideAccess: true, depth: 0, limit: 1000,
      where: { parent: { equals: id } }, sort: '-updatedAt' }),
  ])
  if (!document?.id && !draftDoc?.id && !versions.docs.length) return null
  const sourceVersions = versions.docs.map(row => asRecord(row.version))
  const published = sourceVersions.find(row => row._status === 'published')
  const draft = sourceVersions.find(row => row._status === 'draft')
  const publishedAt = time(document?.publishedAt ?? draftDoc?.publishedAt)
  const actual = { id, sourceId: document?.legacySourceId ?? draftDoc?.legacySourceId ?? null,
    title: document?.title ?? draftDoc?.title, category: document?.category ?? draftDoc?.category,
    publishedAt, published: nativeArticleVersion(published), draft: nativeArticleVersion(draft) }
  // History is separately observed by its immutable document/revision identity.
  const actualHash = snapshotHash(actual)
  return { entityKind: 'document', sourceId: id, contentHash: actualHash,
    destinationId: String(document?.id ?? draftDoc?.id ?? id),
    identityMatches: (document?.legacyDocumentId ?? draftDoc?.legacyDocumentId) === id &&
      (document?.legacySourceId ?? draftDoc?.legacySourceId ?? null) === (expected.sourceDocumentSourceId ?? null) }
}

async function homeObservation(payload: Payload, req: PayloadRequest): Promise<ObservedImportItem> {
  const [publishedDoc, draftDoc, versions] = await Promise.all([
    api(payload).findGlobal({ slug: 'news-home', req, overrideAccess: true, depth: 0, draft: false }),
    api(payload).findGlobal({ slug: 'news-home', req, overrideAccess: true, depth: 0, draft: true }),
    api(payload).findGlobalVersions({ slug: 'news-home', req, overrideAccess: true, depth: 0, limit: 1000, sort: '-updatedAt' }),
  ])
  const rows = versions.docs.map(row => asRecord(row.version))
  const published = rows.find(row => row._status === 'published')
  const draft = rows.find(row => row._status === 'draft')
  const content = (value: Record<string, unknown> | undefined) => value ? { version: 1,
    eyebrow: value.eyebrow, headline: value.headline, summary: value.summary } : null
  const actual = { published: content(published), draft: content(draft), publishedAt: time(publishedDoc?.publishedAt ?? draftDoc?.publishedAt) }
  return { entityKind: 'home', sourceId: 'news-home', contentHash: snapshotHash(actual), destinationId: 'news-home', identityMatches: true }
}

async function itemObservation(payload: Payload, req: PayloadRequest, expected: ExpectedImportItem,
  staged: ReadonlyMap<string, StagedImportAsset>): Promise<ObservedImportItem | null> {
  const cms = api(payload)
  switch (expected.entityKind) {
    case 'asset': {
      const media = await cms.findByID({ collection: 'news-media', id: expected.sourceId, req,
        overrideAccess: true, depth: 0, disableErrors: true })
      if (!media?.id) return null
      const verified = staged.get(expected.sourceId)
      // Reconcile the native CMS media row and promoted bytes independently of
      // the producer metadata fingerprint; the latter remains in the validated
      // manifest sourceFingerprint and is not recalculated from CMS JSON.
      if (!verified) return { entityKind: 'asset', sourceId: expected.sourceId,
        contentHash: snapshotHash({ id: media.id, sha256: media.sha256, mime: media.mimeType, size: media.filesize }),
        destinationId: String(media.id), identityMatches: media.legacyAssetId === expected.sourceId, bytesVerified: false }
      await verifyImportPromotion(verified)
      return { entityKind: 'asset', sourceId: expected.sourceId,
        contentHash: snapshotHash({ id: media.id, sha256: media.sha256, mime: media.mimeType, size: media.filesize }),
        destinationId: String(media.id), identityMatches: media.legacyAssetId === expected.sourceId &&
          media.filename === verified.intent.filename && media.sha256 === verified.intent.sha256 &&
          media.mimeType === verified.intent.mime && media.filesize === verified.intent.size, bytesVerified: true }
    }
    case 'history': {
      const [documentId, revisionId] = expected.sourceId.split('/')
      const rows = (await cms.find({ collection: 'legacy-news-revisions', req, overrideAccess: true, depth: 0, limit: 2,
        where: { and: [{ legacyDocumentId: { equals: documentId } }, { legacyRevisionId: { equals: revisionId } }] } })).docs
      const row = rows[0]
      if (!row) return null
      return { entityKind: 'history', sourceId: expected.sourceId, contentHash: snapshotHash(historyProjection(row)),
        destinationId: String(row.id), identityMatches: row.legacyDocumentId === documentId && row.legacyRevisionId === revisionId }
    }
    case 'document': return articleObservation(payload, req, expected)
    case 'home': return homeObservation(payload, req)
    case 'schedule': {
      const rows = (await cms.find({ collection: 'news-schedules', req, overrideAccess: true, depth: 0, limit: 2,
        where: { sourceScheduleKey: { equals: expected.sourceId } } })).docs
      const row = rows[0]
      if (!row) return null
      const sourceSnapshotValid = isRecord(row.sourceSnapshot)
      const nativeSnapshotValid = isRecord(row.snapshot)
      const computedSourceSnapshotHash = sourceSnapshotValid ? snapshotHash(row.sourceSnapshot) : null
      const computedNativeSnapshotHash = nativeSnapshotValid ? snapshotHash(row.snapshot) : null
      const sourceSnapshotHashMatches = sourceSnapshotValid && computedSourceSnapshotHash === row.sourceSnapshotHash &&
        row.sourceSnapshotHash === expected.sourceSnapshotHash
      const nativeSnapshotHashMatches = nativeSnapshotValid && computedNativeSnapshotHash === row.snapshotHash &&
        row.snapshotHash === row.nativeSnapshotHash && row.nativeSnapshotHash === expected.nativeSnapshotHash
      const actual = { documentId: row.documentId, revisionId: row.sourceRevisionId,
        scheduledAt: row.originalScheduledAt, operation: row.action, actorUid: row.actorUid,
        actorEvidence: row.originalActorEvidence, snapshotHash: row.sourceSnapshotHash,
        executionState: row.state, exceptions: ['actor_unknown'], snapshot: row.sourceSnapshot }
      return { entityKind: 'schedule', sourceId: expected.sourceId, contentHash: snapshotHash(actual),
        destinationId: String(row.id), identityMatches: row.sourceScheduleKey === expected.sourceId && row.state === 'suspended' &&
          row.actorUid === null && row.jobId == null && row.originalActorEvidence === 'not_recorded' &&
          sourceSnapshotHashMatches && nativeSnapshotHashMatches,
        sourceSnapshotHashMatches, nativeSnapshotHashMatches }
    }
  }
}

export async function readImportDestination(payload: Payload, req: PayloadRequest,
  expected: readonly ExpectedImportItem[], stagedAssets: ReadonlyMap<string, StagedImportAsset>): Promise<ObservedImportItem[]> {
  const observations = await Promise.all(expected.map(item => itemObservation(payload, req, item, stagedAssets)))
  return observations.filter((item): item is ObservedImportItem => item !== null)
}

export async function verifyStagedImportPromotions(stagedAssets: ReadonlyMap<string, StagedImportAsset>) {
  for (const staged of stagedAssets.values()) await verifyImportPromotion(staged)
}

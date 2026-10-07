import { revisionKey, scheduleKey, snapshotHash } from '../../../scripts/owner-news-payload/contract.mjs'
import { legacyToPayloadBlocks } from '../news/legacy-blocks'
import { validateImportBundleParts, type ConvertedImportRevision, type ImportBundleManifest } from './bundle'
import { reconcileImportItems, type ExpectedImportItem, type ObservedImportItem } from './reconcile'

export type ImportException = { entityKind: 'schedule' | 'document' | 'home'; sourceId: string; code: 'actor_unknown' | 'schedule_expired' | 'native_timestamp_precision' }
const hasSubmillisecond = (value: string | null) => value !== null && /\.\d{3}\d*[1-9]\d*Z$/u.test(value)

/** Plans only, no storage, jobs or mutation. All executable content originates in
 * Task10's validated revision files. Native historical IDs are never fabricated. */
export function planNewsImport(bundle: { manifest: unknown; revisionFiles: ReadonlyMap<string, Buffer> },
  destination: readonly ObservedImportItem[], now: Date = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_import_clock')
  const { manifest, revisions } = validateImportBundleParts(bundle.manifest, bundle.revisionFiles)
  return planValidatedNewsImport(manifest, revisions, destination, now)
}

/** Consume loadBundle's already-authenticated revision files without rebuilding
 * bytes or introducing a second serialized revision representation. */
export function planLoadedNewsImport(bundle: { manifest: ImportBundleManifest; revisionById: ReadonlyMap<string, { converted: ConvertedImportRevision }> },
  destination: readonly ObservedImportItem[], now: Date = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_import_clock')
  if (bundle.revisionById.size !== bundle.manifest.revisions.length) throw new Error('import_revision_inventory_mismatch')
  const revisions = new Map<string, ConvertedImportRevision>()
  for (const row of bundle.manifest.revisions) {
    const loaded = bundle.revisionById.get(row.id)
    if (!loaded || loaded.converted.id !== row.document_id) throw new Error('import_revision_inventory_mismatch')
    revisions.set(row.id, loaded.converted)
  }
  return planValidatedNewsImport(bundle.manifest, revisions, destination, now)
}

function planValidatedNewsImport(manifest: ImportBundleManifest, revisions: ReadonlyMap<string, ConvertedImportRevision>,
  destination: readonly ObservedImportItem[], now: Date) {
  const expectedItems: ExpectedImportItem[] = []
  const exceptions: ImportException[] = []
  const add = (entityKind: ExpectedImportItem['entityKind'], sourceId: string, content: unknown, destinationId: string | null,
    sourceDocumentSourceId?: string | null) => {
    expectedItems.push({ entityKind, sourceId, expectedHash: snapshotHash(content), destinationId,
      ...(entityKind === 'document' ? { sourceDocumentSourceId: sourceDocumentSourceId ?? null } : {}) })
  }
  // This is the destination media-row reconciliation hash, not the producer's
  // asset-metadata source hash. The verified manifest sourceFingerprint already
  // commits metadataHash/storedSha256 in the producer's exact v1 domain; never
  // parse or reserialize source JSON metadata here.
  for (const asset of manifest.assets) add('asset', asset.id, { id: asset.id, sha256: asset.sha256, mime: asset.mime, size: asset.size }, asset.id)
  for (const entry of manifest.revisions) add('history', revisionKey(entry.document_id, entry.id), revisions.get(entry.id)!.history, null)
  const resolve = (id: string | null): ConvertedImportRevision | null => id === null ? null : revisions.get(id)!
  const documents = manifest.documents.map(document => {
    const published = resolve(document.published_revision_id), draft = resolve(document.draft_revision_id)
    const scheduled = resolve(document.scheduled_revision_id)
    const native = (revision: ConvertedImportRevision | null) => revision && { ...revision.content,
      body: legacyToPayloadBlocks(revision.content.body), publishedAt: nativeTime(document.published_at) }
    const content = { id: document.id, sourceId: document.source_id, title: document.title, category: document.category,
      publishedAt: nativeTime(document.published_at), published: native(published), draft: native(draft) }
    add('document', document.id, content, document.id, document.source_id)
    if (hasSubmillisecond(document.published_at)) exceptions.push({ entityKind: 'document', sourceId: document.id, code: 'native_timestamp_precision' })
    return { id: document.id, sourceId: document.source_id, content, published: native(published), draft: native(draft),
      snapshot: native(scheduled), history: manifest.revisions.filter(row => row.document_id === document.id).map(row => revisions.get(row.id)!.history) }
  })
  const schedules = manifest.schedules.map(schedule => {
    const sourceId = scheduleKey(schedule)
    const revision = revisions.get(schedule.revisionId)!
    const snapshot = { title: revision.history.originalTitle, category: revision.history.originalCategory,
      body: revision.history.originalBody, editorial: revision.history.originalEditorial }
    if (snapshotHash(snapshot) !== schedule.snapshotHash) throw new Error('import_schedule_hash_mismatch')
    const nativeSnapshot = { title: revision.content.title, category: revision.content.category,
      body: legacyToPayloadBlocks(revision.content.body), editorial: revision.content.editorial }
    const nativeSnapshotHash = snapshotHash(nativeSnapshot)
    expectedItems.push({ entityKind: 'schedule', sourceId, expectedHash: snapshotHash({ ...schedule, snapshot }),
      destinationId: null, sourceSnapshotHash: schedule.snapshotHash, nativeSnapshotHash })
    exceptions.push({ entityKind: 'schedule', sourceId, code: 'actor_unknown' })
    if (Date.parse(schedule.scheduledAt) <= now.getTime()) exceptions.push({ entityKind: 'schedule', sourceId, code: 'schedule_expired' })
    return { ...schedule, sourceId, snapshot, nativeSnapshot, nativeSnapshotHash }
  })
  const home = { published: manifest.home.published, draft: manifest.home.draft, publishedAt: nativeTime(manifest.home.published_at) }
  add('home', 'news-home', home, 'news-home')
  if (hasSubmillisecond(home.publishedAt)) exceptions.push({ entityKind: 'home', sourceId: 'news-home', code: 'native_timestamp_precision' })
  const reconciliation = reconcileImportItems(expectedItems, destination)
  return { ...reconciliation, expectedItems, documents, home, schedules, exceptions,
    authority: manifest.source.authority, sourceInstance: manifest.source.instanceId, sourceFingerprint: manifest.sourceFingerprint,
    // Exceptions preserve current publication/draft import but block cutover proof.
    contentReadyForSeal: reconciliation.ok && exceptions.length === 0 }
}

function nativeTime(value: string | null): string | null {
  if (value === null) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('invalid_import_timestamp')
  return new Date(milliseconds).toISOString()
}

/** CLI/report boundary: never serialize the full plan (it contains private bodies). */
export function summarizeImportPlan(plan: ReturnType<typeof planNewsImport>) {
  return { version: 1 as const, phase: 'planned' as const, counts: plan.counts,
    conflicts: plan.conflicts.map(({ entityKind, sourceId, code }) => ({ entityKind, sourceId, code })),
    exceptions: plan.exceptions.map(({ entityKind, sourceId, code }) => ({ entityKind, sourceId, code })),
    contentReadyForSeal: plan.contentReadyForSeal }
}

import { validateBundle, validateRevisionFile } from '../../../scripts/owner-news-payload/bundle.mjs'
import type { LegacyNewsRevisionInput, NewsEditorial } from '../contracts/news'

// Consumer views of Task10's validated output, not a second validator/manifest.
export type BundleDocument = {
  id: string; source_id: string | null; title: string; category: string; published_at: string | null
  published_revision_id: string | null; draft_revision_id: string | null; scheduled_revision_id: string | null
}
export type BundleRevision = {
  id: string; document_id: string; relativePath: string; contentHash: string; provenanceHash: string
  byteSize: number; sha256: string; sourceRowHash: string
}
export type BundleAsset = {
  id: string; storageKey: string; originalName: string; mime: string; size: number; uploadedBy: string | null
  createdAt: string; updatedAt: string; deletingAt: null; metadataHash: string; storedSha256: string | null
  sha256: string; relativePath: string; sharedWithContentTypes: string[]
}
export type BundleSchedule = {
  documentId: string; revisionId: string; scheduledAt: string; operation: 'publish'; actorUid: null
  actorEvidence: 'not_recorded'; snapshotHash: string; executionState: 'suspended'; exceptions: ['actor_unknown']
}
type HomeContent = { version: 1; eyebrow: string; headline: string; summary: string }
export type ImportBundleManifest = {
  source: { instanceId: string; authority: { mode: string; epoch: number } }; sourceFingerprint: string
  documents: BundleDocument[]; revisions: BundleRevision[]; assets: BundleAsset[]; schedules: BundleSchedule[]
  home: { singleton: true; version: number; published: HomeContent | null; draft: HomeContent | null; published_at: string | null }
}
export type ConvertedImportRevision = {
  id: string
  content: { title: string; category: string; body: Record<string, unknown>[]; editorial: NewsEditorial; publishedAt: string | null }
  history: LegacyNewsRevisionInput & { metadataBasis: { title: 'document_snapshot'; category: 'document_snapshot'; publishedAt: 'published_pointer' | 'unknown' } }
  mediaIds: string[]
}

/** Pure complete revision preflight using the producer's validators. Asset bytes
 * are separately verified by loadBundle/staging; this never claims they were read. */
export function validateImportBundleParts(input: unknown, revisionFiles: ReadonlyMap<string, Buffer>) {
  const manifest = validateBundle(input) as ImportBundleManifest
  if (revisionFiles.size !== manifest.revisions.length) throw new Error('import_revision_inventory_mismatch')
  const revisions = new Map<string, ConvertedImportRevision>()
  for (const entry of manifest.revisions) {
    const bytes = revisionFiles.get(entry.relativePath)
    if (!bytes) throw new Error('import_revision_file_missing')
    const parsed = validateRevisionFile(manifest, entry, bytes)
    revisions.set(entry.id, parsed.converted as ConvertedImportRevision)
  }
  return { manifest, revisions }
}

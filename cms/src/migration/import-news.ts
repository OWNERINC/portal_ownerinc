import { createLocalReq, type Payload, type PayloadRequest } from 'payload'
import path from 'node:path'
import { loadBundle } from '../../../scripts/owner-news-payload/bundle.mjs'
import type { ConvertedImportRevision, ImportBundleManifest } from './bundle'
import { assertFrozenPreparationActor, assertPreparationIdentity, withPreparationAuthority } from '../publication/authority'
import { snapshotHash } from '../publication/document'
import { withCmsTransaction } from '../publication/transaction'
import { createLegacyNewsArticle } from '../news/import-article'
import { legacyNewsImportContext } from '../news/validation'
import type { LegacyNewsRevisionInput } from '../contracts/news'
import { createSuspendedImportSchedule } from './import-schedules'
import { planLoadedNewsImport } from './plan'
import { reconcileImportItems, type ExpectedImportItem, type ObservedImportItem } from './reconcile'
import { assertImportBinding } from './identity'
import { ImportCommitOutcomeUnknown, withImportTransaction } from './transaction'
import { withPreparationBootstrap } from './preparation-bootstrap'
import { assertPreparationRun } from './preparation-run'
import { readImportDestination } from './destination'
import { assertDurablePromotion, promoteImportAsset, recordAssetCommitOutcome, stageImportAsset, type StagedImportAsset } from './staging'
import { withStagedImportMedia } from '../media/import-staged'
import { activateOperatorImportCapability, assertOperatorImportActive, assertOperatorImportPending,
  type ImportOperatorIdentity } from './target-binding'

export type LoadedNewsImportBundle = {
  manifest: ImportBundleManifest
  manifestSha256: string
  revisionById: ReadonlyMap<string, { converted: ConvertedImportRevision }>
  assetPaths: ReadonlyMap<string, string>
}

function isLoadedBundle(value: unknown): value is LoadedNewsImportBundle {
  if (!value || typeof value !== 'object') return false
  const bundle = value as Record<string, unknown>
  return !!bundle.manifest && typeof bundle.manifest === 'object' &&
    typeof bundle.manifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(bundle.manifestSha256) &&
    bundle.revisionById instanceof Map && bundle.assetPaths instanceof Map
}

function requireLoadedBundle(value: unknown): LoadedNewsImportBundle {
  if (!isLoadedBundle(value)) throw new Error('import_bundle_load_failed')
  return value
}
type PayloadAPI = {
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>
  find(args: Record<string, unknown>): Promise<{ docs: Record<string, unknown>[] }>
  findByID(args: Record<string, unknown>): Promise<Record<string, unknown> | null>
  updateGlobal(args: Record<string, unknown>): Promise<Record<string, unknown>>
  db: Payload['db']
}
const cmsAPI = (payload: Payload) => payload as unknown as PayloadAPI
const safeRow = (row: Record<string, unknown> | undefined) => row || null

export type ApplyNewsImportOptions = {
  payload: Payload; req: PayloadRequest; bundle: LoadedNewsImportBundle; manifestSha256: string
  sourceFingerprint: string; uploadDir: string; expectedEpoch: number; runId: string; actorUid: string; now?: Date
}

async function readRun(payload: Payload, req: PayloadRequest, manifestSha256: string) {
  const result = await cmsAPI(payload).find({ collection: 'news-migration-runs', req, overrideAccess: true,
    depth: 0, limit: 2, where: { manifestSha256: { equals: manifestSha256 } } })
  if (result.docs.length > 1) throw new Error('migration_run_identity_collision')
  return result.docs[0] || null
}

async function readItems(payload: Payload, req: PayloadRequest, runId: string) {
  return (await cmsAPI(payload).find({ collection: 'news-migration-items', req, overrideAccess: true,
    depth: 0, limit: 10000, where: { runId: { equals: runId } }, sort: 'entityKind,sourceId' })).docs
}

async function ensurePreparationRun(payload: Payload, req: PayloadRequest, input: {
  runId: string; manifestSha256: string; expectedEpoch: number; sourceInstance: string; sourceFingerprint: string
}) {
  let row = await readRun(payload, req, input.manifestSha256)
  if (!row) {
    const bootstrap = { runId: input.runId, manifestSha256: input.manifestSha256, expectedEpoch: input.expectedEpoch }
    await withPreparationBootstrap(req, bootstrap, async (bootstrapReq) => {
      row = await cmsAPI(payload).create({ collection: 'news-migration-runs', overrideAccess: true, req: bootstrapReq,
        depth: 0, data: { id: bootstrap.runId, manifestSha256: input.manifestSha256, sourceInstance: input.sourceInstance,
          sourceFingerprint: input.sourceFingerprint, authorityEpoch: input.expectedEpoch,
          progressState: 'preparing', admissionState: 'open', commitOutcome: 'acknowledged', unresolvedExceptions: [] } })
    })
  }
  if (!row || row.id !== input.runId || row.manifestSha256 !== input.manifestSha256 || row.sourceInstance !== input.sourceInstance ||
    row.sourceFingerprint !== input.sourceFingerprint ||
    (row.authorityEpoch !== input.expectedEpoch && row.authorityEpoch !== String(input.expectedEpoch))) {
    throw new Error('migration_run_identity_conflict')
  }
  return row
}

async function stageBundleAssets(options: ApplyNewsImportOptions, binding: { runId: string; manifestSha256: string; authorityEpoch: number }) {
  const staged = new Map<string, StagedImportAsset>()
  for (const asset of options.bundle.manifest.assets) {
    const file = options.bundle.assetPaths.get(asset.id)
    if (!file) throw new Error('import_asset_file_missing')
    const entry = await stageImportAsset({ sourceRoot: path.dirname(file), storageRoot: options.uploadDir, binding,
      asset: { ...asset, relativePath: path.basename(file) } })
    const promoted = await promoteImportAsset(entry)
    assertDurablePromotion(promoted)
    staged.set(asset.id, promoted)
  }
  return staged
}

async function findItem(payload: Payload, req: PayloadRequest, runId: string, item: ExpectedImportItem) {
  const identity = await assertPreparationIdentity(req)
  const result = await cmsAPI(payload).find({ collection: 'news-migration-items', req, overrideAccess: true,
    depth: 0, limit: 2, where: { and: [{ manifestSha256: { equals: identity.manifestSha256 } },
      { entityKind: { equals: item.entityKind } }, { sourceId: { equals: item.sourceId } }] } })
  if (result.docs.length > 1) throw new Error('migration_item_identity_collision')
  if (result.docs[0] && (result.docs[0].runId !== runId || result.docs[0].manifestSha256 !== identity.manifestSha256)) {
    throw new Error('migration_item_run_mismatch')
  }
  return result.docs[0] || null
}

async function ensurePlannedItems(payload: Payload, req: PayloadRequest, runId: string, items: readonly ExpectedImportItem[]) {
  const api = cmsAPI(payload), identity = await assertPreparationIdentity(req)
  for (const item of items) {
    const current = await findItem(payload, req, runId, item)
    if (current) {
      if (current.expectedHash !== item.expectedHash || current.destinationId !== item.destinationId || current.state === 'conflict') {
        throw new Error('migration_item_expectation_conflict')
      }
      continue
    }
    await api.create({ collection: 'news-migration-items', overrideAccess: true, req, depth: 0,
      data: { runId, manifestSha256: identity.manifestSha256, entityKind: item.entityKind, sourceId: item.sourceId,
        expectedHash: item.expectedHash, destinationId: item.destinationId, state: 'planned',
        commitOutcome: 'acknowledged', observedHash: null } })
  }
}

async function createMediaMetadata(payload: Payload, req: PayloadRequest, staged: StagedImportAsset) {
  const importedAt = new Date().toISOString()
  const media = await withStagedImportMedia(req, staged, () => cmsAPI(payload).create({ collection: 'news-media',
    overrideAccess: true, req, depth: 0, data: { id: staged.intent.assetId, filename: staged.intent.filename,
      mimeType: staged.intent.mime, filesize: staged.intent.size, sha256: staged.intent.sha256,
      legacyAssetId: staged.intent.assetId, importedAt } }))
  if (media.id !== staged.intent.assetId || media.filename !== staged.intent.filename || media.sha256 !== staged.intent.sha256 ||
    media.mimeType !== staged.intent.mime || media.filesize !== staged.intent.size || media.legacyAssetId !== staged.intent.assetId) {
    throw new Error('import_media_persistence_mismatch')
  }
}

async function writeHistory(payload: Payload, req: PayloadRequest, history: LegacyNewsRevisionInput) {
  const api = cmsAPI(payload)
  const result = await api.find({ collection: 'legacy-news-revisions', req, overrideAccess: true, depth: 0, limit: 2,
    where: { and: [{ legacyDocumentId: { equals: history.legacyDocumentId } },
      { legacyRevisionId: { equals: history.legacyRevisionId } }] } })
  if (result.docs.length > 1) throw new Error('legacy_history_identity_collision')
  if (result.docs[0]) return result.docs[0]
  const created = await api.create({ collection: 'legacy-news-revisions', overrideAccess: true, req,
    context: legacyNewsImportContext, depth: 0, data: history as unknown as Record<string, unknown> })
  if (created.legacyDocumentId !== history.legacyDocumentId || created.legacyRevisionId !== history.legacyRevisionId) {
    throw new Error('legacy_history_persistence_mismatch')
  }
  return created
}

async function writeArticle(payload: Payload, req: PayloadRequest, planned: Record<string, unknown>, source: Record<string, unknown>) {
  const id = String(planned.id), published = planned.published as Record<string, unknown> | null,
    draft = planned.draft as Record<string, unknown> | null
  if (!published && !draft) throw new Error('import_document_has_no_current_revision')
  const common = { id, legacyDocumentId: id, legacySourceId: planned.sourceId ?? null,
    importedAt: new Date().toISOString(), publishedAt: planned.publishedAt ?? null }
  if (published) {
    await createLegacyNewsArticle(payload, { ...published, ...common,
      legacyRevisionId: source.published_revision_id, _status: 'published' } as never, req)
  } else {
    await createLegacyNewsArticle(payload, { ...draft, ...common,
      legacyRevisionId: source.draft_revision_id, _status: 'draft' } as never, req)
  }
  if (published && draft) {
    await cmsAPI(payload).update({ collection: 'news-articles', id, req, overrideAccess: true, depth: 0, draft: true,
      context: legacyNewsImportContext, data: { ...draft, ...common, legacyRevisionId: source.draft_revision_id, _status: 'draft' } })
  }
}

async function writeHome(payload: Payload, req: PayloadRequest, home: Record<string, unknown>) {
  const published = home.published as Record<string, unknown> | null, draft = home.draft as Record<string, unknown> | null
  if (!published && !draft) return // Both-null singleton is a valid absent native global.
  const data = (value: Record<string, unknown>, status: 'draft' | 'published') => ({ eyebrow: value.eyebrow,
    headline: value.headline, summary: value.summary, publishedAt: home.publishedAt ?? null, _status: status })
  if (published) await cmsAPI(payload).updateGlobal({ slug: 'news-home', req, overrideAccess: true, depth: 0,
    context: legacyNewsImportContext, data: data(published, 'published') })
  if (draft) await cmsAPI(payload).updateGlobal({ slug: 'news-home', req, overrideAccess: true, depth: 0, draft: true,
    context: legacyNewsImportContext, data: data(draft, 'draft') })
}

async function setItemsVerified(payload: Payload, req: PayloadRequest, runId: string, expected: readonly ExpectedImportItem[],
  observed: readonly ObservedImportItem[]) {
  const api = cmsAPI(payload), byKey = new Map(observed.map(row => [`${row.entityKind}:${row.sourceId}`, row]))
  for (const item of expected) {
    const actual = byKey.get(`${item.entityKind}:${item.sourceId}`)
    if (!actual || actual.contentHash !== item.expectedHash || !actual.identityMatches ||
      (item.entityKind === 'asset' && actual.bytesVerified !== true)) throw new Error('import_destination_reconciliation_conflict')
    const current = await findItem(payload, req, runId, item)
    if (!current) throw new Error('migration_item_missing')
    await api.update({ collection: 'news-migration-items', id: current.id, overrideAccess: true, req, depth: 0,
      data: { state: 'verified', observedHash: actual.contentHash, destinationId: item.destinationId ?? actual.destinationId } })
  }
}

function unitReceipt(runId: string, manifestSha256: string, items: readonly ExpectedImportItem[], observed: readonly ObservedImportItem[],
  exceptions: readonly unknown[]) {
  const persisted = items.map(item => {
    const value = observed.find(row => row.entityKind === item.entityKind && row.sourceId === item.sourceId)
    return { entityKind: item.entityKind, sourceId: item.sourceId, expectedHash: item.expectedHash,
      observedHash: value?.contentHash ?? null, destinationId: value?.destinationId ?? null, identityMatches: value?.identityMatches === true,
      bytesVerified: item.entityKind !== 'asset' || value?.bytesVerified === true }
  }).sort((a, b) => `${a.entityKind}:${a.sourceId}`.localeCompare(`${b.entityKind}:${b.sourceId}`))
  return { digest: snapshotHash({ runId, manifestSha256, items: persisted, exceptions }),
    destinationFingerprint: snapshotHash(persisted), itemCount: persisted.length,
    verifiedCount: persisted.filter(row => row.identityMatches && row.bytesVerified && row.observedHash === row.expectedHash).length }
}

async function freshUnitConfirmation(payload: Payload, incoming: PayloadRequest, runId: string, manifestSha256: string,
  plan: ReturnType<typeof planLoadedNewsImport>, staged: ReadonlyMap<string, StagedImportAsset>, receipt: string) {
  const fresh = await createLocalReq({ req: { ...incoming, transactionID: undefined, payloadDataLoader: undefined,
    context: { ...incoming.context } } }, payload)
  return withCmsTransaction(payload, fresh, async req => {
    const run = safeRow(await readRun(payload, req, manifestSha256))
    if (!run || run.id !== runId || run.progressState !== 'reconciled' || run.admissionState !== 'open' || run.commitOutcome !== 'acknowledged') return false
    if (run.sourceFingerprint !== plan.sourceFingerprint || JSON.stringify(run.unresolvedExceptions) !== JSON.stringify(plan.exceptions)) return false
    const observed = await readImportDestination(payload, req, plan.expectedItems, staged)
    const classified = reconcileImportItems(plan.expectedItems, observed)
    const unit = unitReceipt(runId, manifestSha256, plan.expectedItems, observed, plan.exceptions)
    const rows = await readItems(payload, req, runId)
    if (!classified.ok || rows.length !== unit.itemCount || unit.verifiedCount !== unit.itemCount || unit.digest !== receipt ||
      run.reconciliationSha256 !== receipt || run.destinationFingerprint !== unit.destinationFingerprint) return false
    return plan.expectedItems.every(expected => rows.some(row => row.entityKind === expected.entityKind && row.sourceId === expected.sourceId &&
      row.expectedHash === expected.expectedHash && row.observedHash === expected.expectedHash && row.state === 'verified' &&
      row.commitOutcome === 'acknowledged'))
  })
}

/** Read actual Payload/history/media/suspended-schedule state under the caller's
 * live request and capability. Does not bless a previous ledger receipt alone. */
export async function reconcileNewsImport(input: { payload: Payload; req: PayloadRequest; bundle: LoadedNewsImportBundle;
  manifestSha256: string; runId: string; expectedEpoch: number; stagedAssets: ReadonlyMap<string, StagedImportAsset>; now?: Date }) {
  const plan = planLoadedNewsImport(input.bundle, [], input.now)
  assertImportBinding({ runId: input.runId, manifestSha256: input.manifestSha256, authorityEpoch: input.expectedEpoch })
  const binding = { runId: input.runId, manifestSha256: input.manifestSha256, expectedEpoch: input.expectedEpoch }
  const row = await readRun(input.payload, input.req, input.manifestSha256)
  if (row?.id === input.runId && row.progressState === 'reconciled' && row.admissionState === 'open' && row.commitOutcome === 'acknowledged') {
    await assertFrozenPreparationActor(input.req, input.expectedEpoch)
    const observed = await readImportDestination(input.payload, input.req, plan.expectedItems, input.stagedAssets)
    const result = reconcileImportItems(plan.expectedItems, observed)
    const unit = unitReceipt(input.runId, input.manifestSha256, plan.expectedItems, observed, plan.exceptions)
    return { ...result, exceptions: plan.exceptions, sourceFingerprint: plan.sourceFingerprint,
      destinationFingerprint: unit.destinationFingerprint, receiptSha256: unit.digest,
      persistedReceiptMatches: row.reconciliationSha256 === unit.digest && row.destinationFingerprint === unit.destinationFingerprint,
      readyForSeal: result.ok && plan.exceptions.length === 0 && row.reconciliationSha256 === unit.digest }
  }
  return withPreparationAuthority(input.req, binding, async req => {
    const observed = await readImportDestination(input.payload, req, plan.expectedItems, input.stagedAssets)
    const result = reconcileImportItems(plan.expectedItems, observed)
    const unit = unitReceipt(input.runId, input.manifestSha256, plan.expectedItems, observed, plan.exceptions)
    return { ...result, exceptions: plan.exceptions, sourceFingerprint: plan.sourceFingerprint,
      destinationFingerprint: unit.destinationFingerprint, receiptSha256: unit.digest,
      readyForSeal: result.ok && plan.exceptions.length === 0 }
  })
}

/** One transactional application unit: bootstrap -> capability -> ledger + assets
 * + history + published/draft + home + suspended schedule -> fresh whole-unit
 * receipt after COMMIT. It never seals or enqueues imported schedules. */
export async function applyNewsImport(options: ApplyNewsImportOptions) {
  const scope: ImportOperatorIdentity = { actorUid: options.actorUid, runId: options.runId,
    manifestSha256: options.manifestSha256, expectedEpoch: options.expectedEpoch }
  assertOperatorImportPending(options.req, options.payload, options.bundle, scope)
  if ((options.payload.db as typeof options.payload.db & { allowIDOnCreate?: boolean }).allowIDOnCreate !== true) {
    throw new Error('legacy_import_requires_separate_import_config')
  }
  const bundle = requireLoadedBundle(options.bundle)
  const { manifest } = bundle
  if (options.manifestSha256 !== bundle.manifestSha256 || manifest.source.authority.mode !== 'frozen' ||
    manifest.source.authority.epoch !== options.expectedEpoch || manifest.source.instanceId === '') {
    throw new Error('import_bundle_identity_mismatch')
  }
  const plan = planLoadedNewsImport(bundle, [], options.now)
  if (plan.sourceFingerprint !== options.sourceFingerprint) throw new Error('import_bundle_identity_mismatch')
  let runId = '', resultReceipt = '', stagedAssets = new Map<string, StagedImportAsset>()
  let report: { runId: string; manifestSha256: string; receipt: string; counts: unknown;
    exceptions: unknown[]; alreadyApplied: boolean }
  try {
  report = await withImportTransaction(options.payload, options.req, async req => {
    await activateOperatorImportCapability(options.req, req, options.payload, bundle, scope)
    await assertFrozenPreparationActor(req, options.expectedEpoch)
    const run = await ensurePreparationRun(options.payload, req, { runId: options.runId, manifestSha256: options.manifestSha256,
      expectedEpoch: options.expectedEpoch, sourceInstance: plan.sourceInstance, sourceFingerprint: plan.sourceFingerprint })
    runId = String(run.id)
    if (runId !== options.runId) throw new Error('migration_run_identity_conflict')
    const binding = { runId, manifestSha256: options.manifestSha256, authorityEpoch: options.expectedEpoch }
    const alreadyReconciled = run.progressState === 'reconciled' && run.admissionState === 'open' &&
      run.commitOutcome === 'acknowledged'
    const canPrepare = run.progressState === 'preparing' && run.admissionState === 'open' &&
      run.commitOutcome === 'acknowledged'
    if (!alreadyReconciled && !canPrepare) throw new Error('migration_preparation_run_conflict')
    if (canPrepare) await assertPreparationRun(req, { runId, manifestSha256: options.manifestSha256,
      expectedEpoch: options.expectedEpoch })
    stagedAssets = await stageBundleAssets({ ...options, bundle }, binding)
    if (alreadyReconciled) {
      const observed = await readImportDestination(options.payload, req, plan.expectedItems, stagedAssets)
      const classified = reconcileImportItems(plan.expectedItems, observed)
      const unit = unitReceipt(runId, options.manifestSha256, plan.expectedItems, observed, plan.exceptions)
      const rows = await readItems(options.payload, req, runId)
      if (!classified.ok || rows.length !== unit.itemCount || unit.verifiedCount !== unit.itemCount ||
        run.reconciliationSha256 !== unit.digest || run.destinationFingerprint !== unit.destinationFingerprint ||
        !plan.expectedItems.every(expected => rows.some(row => row.entityKind === expected.entityKind && row.sourceId === expected.sourceId &&
          row.expectedHash === expected.expectedHash && row.observedHash === expected.expectedHash && row.state === 'verified'))) {
        throw new Error('import_previous_receipt_conflict')
      }
      resultReceipt = unit.digest
      await assertOperatorImportActive(req, options.payload, bundle, scope)
      return { runId, manifestSha256: options.manifestSha256, receipt: unit.digest, counts: plan.counts,
        exceptions: plan.exceptions, alreadyApplied: true }
    }
    await withPreparationAuthority(req, { runId, manifestSha256: options.manifestSha256,
      expectedEpoch: options.expectedEpoch }, async authorizedReq => {
      const observedBefore = await readImportDestination(options.payload, authorizedReq, plan.expectedItems, stagedAssets)
      const initial = reconcileImportItems(plan.expectedItems, observedBefore)
      if (initial.conflicts.length) throw new Error('import_destination_reconciliation_conflict')
      await ensurePlannedItems(options.payload, authorizedReq, runId, plan.expectedItems)
      for (const asset of manifest.assets) {
        if (!observedBefore.some(item => item.entityKind === 'asset' && item.sourceId === asset.id)) {
          await createMediaMetadata(options.payload, authorizedReq, stagedAssets.get(asset.id)!)
        }
      }
      for (const document of plan.documents) for (const history of document.history) await writeHistory(options.payload, authorizedReq, history)
      const sourceDocuments = new Map(manifest.documents.map(document => [document.id, document]))
      for (const document of plan.documents) {
        if (observedBefore.some(item => item.entityKind === 'document' && item.sourceId === document.id)) continue
        const source = sourceDocuments.get(document.id)
        if (!source) throw new Error('import_document_missing')
        await writeArticle(options.payload, authorizedReq, document as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>)
      }
      if (!observedBefore.some(item => item.entityKind === 'home' && item.sourceId === 'news-home')) {
        await writeHome(options.payload, authorizedReq, plan.home as unknown as Record<string, unknown>)
      }
      for (const schedule of plan.schedules) {
        if (observedBefore.some(item => item.entityKind === 'schedule' && item.sourceId === schedule.sourceId)) continue
        const current = await cmsAPI(options.payload).findByID({ collection: 'news-articles', id: schedule.documentId,
          req: authorizedReq, overrideAccess: true, depth: 0, draft: false })
        const generation = typeof current?.publicationGeneration === 'number' && Number.isSafeInteger(current.publicationGeneration)
          ? Math.max(1, current.publicationGeneration) : 1
        await createSuspendedImportSchedule(options.payload, authorizedReq, { documentId: schedule.documentId,
          revisionId: schedule.revisionId, scheduledAt: schedule.scheduledAt, snapshotHash: schedule.snapshotHash,
          sourceSnapshot: schedule.snapshot, nativeSnapshot: schedule.nativeSnapshot,
          nativeSnapshotHash: schedule.nativeSnapshotHash }, generation)
      }
      const observedAfter = await readImportDestination(options.payload, authorizedReq, plan.expectedItems, stagedAssets)
      const verification = reconcileImportItems(plan.expectedItems, observedAfter)
      if (!verification.ok || observedAfter.some(row => row.entityKind === 'asset' && row.bytesVerified !== true)) {
        throw new Error('import_destination_reconciliation_conflict')
      }
      await setItemsVerified(options.payload, authorizedReq, runId, plan.expectedItems, observedAfter)
      const unit = unitReceipt(runId, options.manifestSha256, plan.expectedItems, observedAfter, plan.exceptions)
      resultReceipt = unit.digest
      await cmsAPI(options.payload).update({ collection: 'news-migration-runs', id: runId,
        req: authorizedReq, overrideAccess: true, depth: 0,
        data: { progressState: 'reconciled', reconciliationSha256: unit.digest,
          destinationFingerprint: unit.destinationFingerprint, unresolvedExceptions: plan.exceptions,
          commitOutcome: 'acknowledged' } })
    })
    await assertOperatorImportActive(req, options.payload, bundle, scope)
    return { runId, manifestSha256: options.manifestSha256, receipt: resultReceipt, counts: plan.counts,
      exceptions: plan.exceptions, alreadyApplied: false }
  }, { confirmCommitted: async receipt => Boolean(await freshUnitConfirmation(options.payload, options.req,
    receipt.runId, receipt.manifestSha256, plan, stagedAssets, receipt.receipt)) })
  } catch (error) {
    if (error instanceof ImportCommitOutcomeUnknown) {
      await Promise.allSettled([...stagedAssets.values()].map(staged => recordAssetCommitOutcome(staged, 'unknown')))
    }
    throw error
  }
  if (!options.req.transactionID) {
    const writes = await Promise.allSettled([...stagedAssets.values()].map(staged => recordAssetCommitOutcome(staged, 'acknowledged')))
    if (writes.some(result => result.status === 'rejected')) throw new Error('import_asset_receipt_write_failed')
  }
  return { ...report, commitOutcome: options.req.transactionID ? 'caller_owned' as const : 'acknowledged' as const,
    phase: 'applied' as const, destinationReconciled: true, cutoverEligible: false,
    sourceFingerprint: plan.sourceFingerprint, unresolvedExceptions: plan.exceptions,
    controlBaselineStored: false, sealed: false }
}

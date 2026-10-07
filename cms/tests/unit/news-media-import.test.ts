import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CollectionConfig, Payload, PayloadRequest } from 'payload'
import { PgDialect } from 'drizzle-orm/pg-core'
import { generateFileData } from '../../node_modules/payload/dist/uploads/generateFileData.js'
import type { Collection } from '../../node_modules/payload/dist/collections/config/types.js'
import { createNewsMedia } from '../../src/collections/NewsMedia.js'
import { legacyNewsImportContext } from '../../src/news/validation.js'
import { stageImportAsset, promoteImportAsset, recordAssetCommitOutcome, verifyImportPromotion, type StagedImportAsset } from '../../src/migration/staging.js'
import { withPreparationAuthority } from '../../src/publication/authority.js'
import { persistMediaIdentity, protectMediaOperation } from '../../src/media/lifecycle.js'
import { assertStagedMediaCreate, assertStagedMediaBeforeChange, withStagedImportMedia } from '../../src/media/import-staged.js'

const binding = { runId: '11111111-1111-4111-8111-111111111111', manifestSha256: 'a'.repeat(64), expectedEpoch: 2 }
const actor = { uid: 'staged-import-actor', email: 'import@example.invalid', name: null, canManageNews: true }
const pdf = Buffer.from('%PDF-1.7\nstaged asset fixture\n%%EOF\n')
const sha256 = createHash('sha256').update(pdf).digest('hex')

async function fixture(t: TestContext) {
  // Existing staging tests avoid the approved opencode temp on Windows because
  // an ancestor .git correctly makes it ineligible as private import storage.
  const tempBase = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'Temp') : os.tmpdir()
  const root = await mkdtemp(path.join(tempBase, 'owner-news-media-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceRoot = path.join(root, 'source'), storageRoot = path.join(root, 'cms-private')
  await mkdir(sourceRoot); await mkdir(storageRoot)
  const assetId = randomUUID()
  await writeFile(path.join(sourceRoot, 'asset.pdf'), pdf)
  const calls: string[] = []
  const state = { mode: 'frozen', epoch: binding.expectedEpoch, denied: false,
    run: { id: binding.runId, manifest_sha256: binding.manifestSha256, authority_epoch: binding.expectedEpoch,
      source_fingerprint: 'b'.repeat(64), progress_state: 'preparing', admission_state: 'open', commit_outcome: 'acknowledged' } }
  const dialect = new PgDialect()
  const session = { execute: async (query?: unknown) => {
    const rendered = query ? dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0]).sql : ''
    calls.push(rendered)
    return { rows: [state.run] }
  } }
  const payload = { db: { sessions: { live: { db: session } } },
    config: { serverURL: 'https://cms.invalid', sharp: undefined },
    collections: { 'news-media': { config: { upload: { staticDir: storageRoot, filesRequiredOnCreate: false, disableLocalStorage: true } } } } } as unknown as Payload
  const req = { payload, transactionID: 'live', context: legacyNewsImportContext, user: { id: binding.runId,
    collection: 'portal-editors', portalUid: actor.uid, portalActor: actor, portalExpiresAt: '2000-01-01T00:00:00.000Z' } } as unknown as PayloadRequest
  const stagedBase = await stageImportAsset({ sourceRoot, storageRoot, binding: { runId: binding.runId,
    manifestSha256: binding.manifestSha256, authorityEpoch: binding.expectedEpoch },
    asset: { id: assetId, mime: 'application/pdf', size: pdf.length, sha256, relativePath: 'asset.pdf' } })
  const staged = await promoteImportAsset(stagedBase)
  const env = { CMS_DATABASE_URL: 'postgres://cms.invalid/synthetic', PAYLOAD_SECRET: 'synthetic-payload-secret-not-production-32chars',
    PORTAL_PUBLIC_URL: 'https://portal.invalid', PORTAL_INTERNAL_URL: 'https://portal-internal.invalid',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-payload-to-portal-not-production-32chars',
    PORTAL_TO_PAYLOAD_SECRET: 'synthetic-portal-to-payload-not-production-32chars', CMS_UPLOAD_DIR: storageRoot }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]; process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const authority = input.endsWith('/authority'); calls.push(authority ? 'portal:authority' : 'portal:actor')
    if (authority) return Response.json({ mode: state.mode, epoch: state.epoch })
    assert.equal(JSON.parse(init.body as string).uid, actor.uid)
    return state.denied ? Response.json({ reason: 'editorial_permission_denied' }, { status: 403 }) : Response.json({ actor })
  })
  return { root, storageRoot, assetId, payload, req, staged, state, calls,
    cleanup: () => rm(root, { recursive: true, force: true }) }
}

function metadata(staged: StagedImportAsset) {
  return { id: staged.intent.assetId, filename: staged.intent.filename, mimeType: staged.intent.mime,
    filesize: staged.intent.size, sha256: staged.intent.sha256, legacyAssetId: staged.intent.assetId,
    importedAt: '2026-10-06T12:00:00.000Z' }
}

function requireUploadConfig(collection: CollectionConfig) {
  const upload = collection.upload
  if (!upload || typeof upload === 'boolean') throw new Error('test_collection_upload_config_required')
  return upload
}

function nativeCollection(config: CollectionConfig): Collection {
  // generateFileData accepts Payload's sanitized Collection; these unit tests
  // provide the exact consumed { config } shape without booting Payload.
  return { config } as unknown as Collection
}

test('only the separate server-marked import config disables native local file handling', () => {
  const environment = { uploadDir: path.resolve('synthetic-media-upload') }
  const runtime = requireUploadConfig(createNewsMedia(environment))
  const imported = requireUploadConfig(createNewsMedia(environment, legacyNewsImportContext))
  assert.equal(runtime.filesRequiredOnCreate, undefined)
  assert.equal(runtime.disableLocalStorage, undefined)
  assert.equal(imported.filesRequiredOnCreate, false)
  assert.equal(imported.disableLocalStorage, true)
  assert.equal(requireUploadConfig(createNewsMedia(environment, { legacyImport: true })).disableLocalStorage, undefined)
})

test('Payload generateFileData returns metadata unchanged only when missing-file is allowed', async () => {
  const environment = { uploadDir: path.resolve('synthetic-media-upload') }
  const data = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', filename: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.pdf',
    mimeType: 'application/pdf', filesize: pdf.length, sha256, legacyAssetId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    importedAt: '2026-10-06T12:00:00.000Z' }
  const importConfig = createNewsMedia(environment, legacyNewsImportContext)
  const runtimeConfig = createNewsMedia(environment)
  const payload = { config: { serverURL: 'https://cms.invalid', sharp: undefined } } as unknown as Payload
  const req = { file: undefined, query: {}, payload, t: (key: string) => key } as unknown as PayloadRequest
  const imported = await generateFileData({ collection: nativeCollection(importConfig), config: payload.config,
    data: { ...data }, operation: 'create',
    draft: false, isDuplicating: false, overwriteExistingFiles: false, req,
    throwOnMissingFile: requireUploadConfig(importConfig).filesRequiredOnCreate !== false })
  assert.deepEqual(imported.data, data)
  assert.deepEqual(imported.files, [])
  await assert.rejects(generateFileData({ collection: nativeCollection(runtimeConfig), config: payload.config,
    data: { ...data }, operation: 'create',
    draft: false, isDuplicating: false, overwriteExistingFiles: false, req,
    throwOnMissingFile: requireUploadConfig(runtimeConfig).filesRequiredOnCreate !== false }))
})

test('forged context/data and cloned request cannot manufacture staged media scope', async t => {
  const f = await fixture(t)
  try {
    const forged = { ...f.req, context: { preparation: binding, legacyImport: true } } as PayloadRequest
    await assert.rejects(assertStagedMediaCreate(forged, { data: metadata(f.staged) }), /staged_media_context_required/)
    await assert.rejects(assertStagedMediaBeforeChange(forged, metadata(f.staged)), /staged_media_context_required/)
    await withPreparationAuthority(f.req, binding, async () => {
      // A cloned request is not the WeakMap key even while the source request is authorized.
      await assert.rejects(assertStagedMediaCreate({ ...f.req } as PayloadRequest, { data: metadata(f.staged) }), /staged_media_context_required/)
    })
  } finally { await f.cleanup() }
})

test('cross-run binding and dead transaction deny before metadata create', async t => {
  const f = await fixture(t)
  try {
    const otherRun = { ...f.staged, intent: { ...f.staged.intent, runId: '22222222-2222-4222-8222-222222222222' } }
    await withPreparationAuthority(f.req, binding, async () => {
      await assert.rejects(withStagedImportMedia(f.req, otherRun, async () => assert.fail('cross-run create')), /staged_media_identity_mismatch/)
      const wrongRoot = path.join(f.root, 'other-storage'); await mkdir(wrongRoot)
      const upload = f.payload.collections['news-media'].config.upload!
      const originalRoot = upload.staticDir; upload.staticDir = wrongRoot
      await assert.rejects(withStagedImportMedia(f.req, f.staged, async () => assert.fail('wrong storage root create')),
        /staged_media_storage_root_mismatch/)
      upload.staticDir = originalRoot
      f.req.transactionID = 'missing'
      await assert.rejects(withStagedImportMedia(f.req, f.staged, async () => assert.fail('dead transaction create')), /cms_transaction_required/)
      f.req.transactionID = 'live'
    })
  } finally { await f.cleanup() }
})

test('promoted bytes are revalidated against the journal hash before a create scope', async t => {
  const f = await fixture(t)
  try {
    await writeFile(path.join(f.storageRoot, f.staged.intent.filename), Buffer.from('corrupt bytes'))
    await assert.rejects(verifyImportPromotion(f.staged), /import_asset_conflict/)
    await withPreparationAuthority(f.req, binding, async () => {
      if (process.platform === 'win32') {
        // Windows cannot prove directory fsync; do not manufacture directorySynced=true.
        await assert.rejects(withStagedImportMedia(f.req, f.staged, async () => assert.fail('corrupt create')),
          /import_directory_durability_unavailable/)
      } else {
        await assert.rejects(withStagedImportMedia(f.req, f.staged, async () => assert.fail('corrupt create')),
          /import_asset_conflict/)
      }
    })
    await recordAssetCommitOutcome(f.staged, 'unknown')
    assert.ok((await readdir(f.staged.journalDirectory)).some(name => name.startsWith('commit-unknown-')))
    await access(path.join(f.storageRoot, f.staged.intent.filename))
    await access(path.join(f.staged.journalDirectory, 'bytes'))
  } finally { await f.cleanup() }
})

test('metadata-only Local API create preserves the exact staged identity and rechecks generated data', {
  skip: process.platform === 'win32' ? 'Windows directory fsync is not evidence of Linux promotion durability' : false,
}, async t => {
  const f = await fixture(t)
  try {
    await withPreparationAuthority(f.req, binding, async () => withStagedImportMedia(f.req, f.staged, async () => {
      const data = metadata(f.staged)
      await assert.rejects(assertStagedMediaCreate({ ...f.req } as PayloadRequest, { data }), /staged_media_context_required/)
      await protectMediaOperation({ operation: 'create', args: { collection: f.payload.collections['news-media'], data, req: f.req },
        req: f.req, collection: f.payload.collections['news-media'].config, context: {} })
      const importConfig = createNewsMedia({ uploadDir: f.storageRoot }, legacyNewsImportContext)
      const generated = await generateFileData({ collection: nativeCollection(importConfig), config: f.payload.config,
        data: { ...data }, operation: 'create', draft: false, isDuplicating: false, overwriteExistingFiles: false,
        req: f.req, throwOnMissingFile: false })
      const changed = await persistMediaIdentity({ operation: 'create', data: generated.data, req: f.req,
        collection: f.payload.collections['news-media'].config, context: {} })
      assert.equal(changed.id, f.assetId)
      assert.equal(changed.filename, f.staged.intent.filename)
      assert.equal(changed.mimeType, 'application/pdf')
      assert.equal(changed.filesize, pdf.length)
      assert.equal(changed.sha256, sha256)
      assert.equal(changed.legacyAssetId, f.assetId)
      assert.equal(f.req.file, undefined)
    }))
    await withPreparationAuthority(f.req, binding, async () => {
      await assert.rejects(withStagedImportMedia(f.req, f.staged, async () => { throw new Error('synthetic unknown commit') }), /synthetic unknown commit/)
    })
    await access(path.join(f.storageRoot, f.staged.intent.filename))
    await access(path.join(f.staged.journalDirectory, 'bytes'))
  } finally { await f.cleanup() }
})

test('staged hooks reject file upload, overwrite, changed bytes metadata and duplicate create', {
  skip: process.platform === 'win32' ? 'Windows directory fsync is not evidence of Linux promotion durability' : false,
}, async t => {
  const f = await fixture(t)
  try {
    await withPreparationAuthority(f.req, binding, async () => withStagedImportMedia(f.req, f.staged, async () => {
      const data = metadata(f.staged)
      const operationBase = { req: f.req, collection: f.payload.collections['news-media'].config, context: {} }
      await assert.rejects(async () => await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data, req: f.req, overwriteExistingFiles: true } }), /staged_media_file_input_forbidden/)
      const otherFilename = { ...data, filename: 'other.pdf' }
      const externalURL = { ...data, url: 'https://example.invalid/a.pdf' }
      await assert.rejects(async () => await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data: otherFilename, req: f.req } }), /staged_media_identity_mismatch/)
      await assert.rejects(async () => await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data: externalURL, req: f.req } }), /staged_media_identity_mismatch/)
      Object.assign(f.req, { query: { uploadEdits: { crop: { x: 1 } } } })
      await assert.rejects(async () => await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data, req: f.req } }), /staged_media_file_input_forbidden/)
      f.req.query = {}
      Object.assign(f.req, { file: { data: pdf } })
      await assert.rejects(async () => await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data, req: f.req } }), /staged_media_file_input_forbidden/)
      f.req.file = undefined
      await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data, req: f.req } })
      await assert.rejects(async () => await protectMediaOperation({ ...operationBase, operation: 'create', args: { collection: f.payload.collections['news-media'], data, req: f.req } }), /staged_media_create_reused/)
      await assert.rejects(async () => await persistMediaIdentity({ operation: 'create', data: { ...data, mimeType: 'image/png' }, req: f.req, collection: f.payload.collections['news-media'].config, context: {} }), /staged_media_generated_identity_mismatch/)
      await persistMediaIdentity({ operation: 'create', data, req: f.req, collection: f.payload.collections['news-media'].config, context: {} })
    }))
  } finally { await f.cleanup() }
})

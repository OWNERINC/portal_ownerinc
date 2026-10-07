import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildBundle, serializeManifest } from '../../../scripts/owner-news-payload/bundle.mjs'
import { assetMetadataHash } from '../../../scripts/owner-news-payload/export.mjs'
import { sourceFixture, mediaFixture, ids } from '../../../tests/fixtures/owner-news-payload.mjs'
import { runImportPreflight } from '../../src/migration/preflight'
import { validateImportBundleParts } from '../../src/migration/bundle'
import { main } from '../../scripts/import-owner-news'

const sourceURL = 'postgresql://synthetic:synthetic@127.0.0.1/portal_local'
const targetURL = 'postgresql://synthetic:synthetic@127.0.0.1/cms_local'
const metadataText = '{"counter":9007199254740993,"sha256":"not-the-file-hash","unknown":{"n":1}}'

function env(root: string): Record<string, string | undefined> {
  return { OWNER_NEWS_SOURCE_DATABASE_URL: sourceURL, OWNER_NEWS_TARGET_DATABASE_URL: targetURL,
    OWNER_NEWS_SOURCE_ID: 'synthetic-local', OWNER_NEWS_SOURCE_UPLOAD_DIR: path.join(root, 'source-uploads'),
    OWNER_NEWS_TARGET_UPLOAD_DIR: path.join(root, 'target-uploads') }
}

function connector(options: { samePhysical?: boolean; sourceMode?: string } = {}) {
  const closed: string[] = []
  const rollbacks: string[] = []
  return {
    closed, rollbacks,
    connect: (config: { databaseName: string }) => {
      const source = config.databaseName === 'portal_local'
      return {
        connect: async () => {},
        query: async (sql: string) => {
          if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')) return { rows: [] }
          if (sql === 'ROLLBACK') { rollbacks.push(config.databaseName); return { rows: [] } }
          if (sql.includes('current_database()')) return { rows: [{ database_name: config.databaseName,
            database_oid: source || options.samePhysical ? '100' : '200',
            system_identifier: '9912345678901234567', in_recovery: false, transaction_read_only: 'on',
            legacy_documents: source ? 'cms_documents' : null, legacy_authority: source ? 'owner_news_authority' : null,
            payload_articles: source ? null : 'news_articles', payload_home: source ? null : 'news_home',
            payload_media: source ? null : 'news_media' }] }
          if (sql.includes('owner_news_authority')) return { rows: [{ mode: options.sourceMode ?? 'frozen', epoch: 2 }] }
          throw new Error('unexpected synthetic query')
        },
        end: async () => { closed.push(config.databaseName) },
      }
    },
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'Temp') : os.tmpdir()
  const root = await realpath(await mkdtemp(path.join(base, 'news-import-preflight-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundleRoot = path.join(root, 'bundle'), sourceUploads = path.join(root, 'source-uploads')
  const targetUploads = path.join(root, 'target-uploads')
  const assetBytes = Buffer.from('%PDF-synthetic')
  const fixtureSource = sourceFixture()
  const source = {
    ...fixtureSource,
    revisions: fixtureSource.revisions.map(revision => revision.id === ids.published
      ? { ...revision, blocks: [{ type: 'pdf', asset_id: ids.image, title: 'Synthetic PDF' }] }
      : revision),
    assets: [{ ...mediaFixture(ids.image, 'application/pdf', assetBytes), metadataHash: assetMetadataHash(metadataText) }],
  }
  const manifestRoot = buildBundle(source)
  const { manifest } = validateImportBundleParts(manifestRoot.manifest, manifestRoot.revisionFiles)
  await mkdir(bundleRoot); await mkdir(path.join(bundleRoot, 'assets'), { recursive: true })
  await mkdir(path.join(sourceUploads, 'cms-private'), { recursive: true })
  await mkdir(targetUploads)
  for (const [name, bytes] of manifestRoot.revisionFiles) {
    const filename = path.join(bundleRoot, ...name.split('/'))
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes)
  }
  await writeFile(path.join(bundleRoot, 'assets', ids.image), assetBytes)
  const manifestPath = path.join(bundleRoot, 'manifest.json')
  await writeFile(manifestPath, serializeManifest(manifestRoot.manifest), { flag: 'wx' })
  return { root, manifestPath, manifest, environment: env(root) }
}

test('real loadBundle dry-run verifies all manifest/revision files and physical target identity', async t => {
  const input = await fixture(t), db = connector()
  const result = await runImportPreflight(['--bundle', input.manifestPath], { env: input.environment, createClient: db.connect })
  assert.equal(result.applyRequested, false)
  assert.equal(result.sourceInstance, 'synthetic-local')
  assert.equal(result.authorityEpoch, 2)
  assert.equal(result.sourceFingerprint, input.manifest.sourceFingerprint)
  assert.equal(input.manifest.assets[0].metadataHash, assetMetadataHash(metadataText))
  assert.equal(result.expectedEntities.history, input.manifest.revisions.length)
  assert.equal(result.expectedEntities.document, 1)
  assert.equal(result.expectedEntities.home, 1)
  assert.equal(result.sourceHasExceptions, true) // source microsecond precision is reported, not rounded away
  assert.notEqual(result.databases.sourceIdentitySha256, result.databases.targetIdentitySha256)
  assert.deepEqual(db.closed.sort(), ['cms_local', 'portal_local'])
  assert.deepEqual(db.rollbacks.sort(), ['cms_local', 'portal_local'])
})

test('CLI output is safe counts/identities only and makes no destination reconciliation claim', async t => {
  const input = await fixture(t), db = connector()
  const result = await main(['--bundle', input.manifestPath], input.environment, { createClient: db.connect })
  assert.equal(result.phase, 'preflight')
  assert.equal(result.destinationReconciled, false)
  const text = JSON.stringify(result)
  for (const secretOrContent of ['synthetic:synthetic', 'Synthetic body.', 'Synthetic document', 'originalBody', input.manifestPath]) {
    assert.equal(text.includes(secretOrContent), false)
  }
  assert.deepEqual(db.closed.sort(), ['cms_local', 'portal_local'])
  assert.deepEqual(db.rollbacks.sort(), ['cms_local', 'portal_local'])
})

test('preflight fails closed for same physical database, target storage alias and nonfrozen source', async t => {
  const input = await fixture(t)
  await assert.rejects(runImportPreflight(['--bundle', input.manifestPath], { env: input.environment,
    createClient: connector({ samePhysical: true }).connect }), /import_source_destination_same_database/)
  await assert.rejects(runImportPreflight(['--bundle', input.manifestPath], { env: {
    ...input.environment, OWNER_NEWS_TARGET_UPLOAD_DIR: path.join(input.root, 'source-uploads', 'cms-private') }, createClient: connector().connect }), /import_storage_overlap/)
  await assert.rejects(runImportPreflight(['--bundle', input.manifestPath], { env: {
    ...input.environment, OWNER_NEWS_TARGET_UPLOAD_DIR: path.join(input.root, 'missing-target') }, createClient: connector().connect }), /import_storage_overlap/)
  await assert.rejects(runImportPreflight(['--bundle', input.manifestPath], { env: input.environment,
    createClient: connector({ sourceMode: 'legacy' }).connect }), /import_source_authority_changed/)
})

test('preflight rejects damaged/missing bundle files before connecting to either database', async t => {
  const input = await fixture(t), db = connector()
  const rev = input.manifest.revisions[0]
  await writeFile(path.join(path.dirname(input.manifestPath), ...rev.relativePath.split('/')), Buffer.from('{}'))
  await assert.rejects(runImportPreflight(['--bundle', input.manifestPath], { env: input.environment, createClient: db.connect }))
  assert.deepEqual(db.closed, [])
  await rm(path.join(path.dirname(input.manifestPath), ...rev.relativePath.split('/')))
  await assert.rejects(runImportPreflight(['--bundle', input.manifestPath], { env: input.environment, createClient: db.connect }))
  assert.deepEqual(db.closed, [])
})

test('explicit apply refuses before creating a run or touching CMS data', async t => {
  const input = await fixture(t), db = connector()
  await assert.rejects(main(['--bundle', input.manifestPath, '--apply'], input.environment, { createClient: db.connect }), /import_apply_not_ready/)
  assert.deepEqual(db.closed.sort(), ['cms_local', 'portal_local'])
  assert.deepEqual(db.rollbacks.sort(), ['cms_local', 'portal_local'])
})

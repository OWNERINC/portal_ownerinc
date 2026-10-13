import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { buildBundle, serializeManifest } from '../../../scripts/owner-news-payload/bundle.mjs'
import { sourceFixture } from '../../../tests/fixtures/owner-news-payload.mjs'
import { assertCmsWriteAuthority } from '../../src/publication/authority'
import { claimImportPreflightArtifact, runImportPreflight } from '../../src/migration/preflight'
import { withOperatorImportCapability,
  activateOperatorImportCapability, assertOperatorImportActive } from '../../src/migration/target-binding'
import { importDatabaseIdentityFingerprint } from '../../src/migration/target'

const runId = '11111111-1111-4111-8111-111111111111'
const systemIdentifier = '9912345678901234567'
const databaseOid = '200'
const sourceURL = 'postgresql://preflight:preflight@127.0.0.1/portal_local'
const targetURL = 'postgresql://preflight:preflight@127.0.0.1/cms_local'
const cmsURL = 'postgresql://cms_runtime:cms-runtime-secret@127.0.0.1/cms_local'
const targetIdentitySha256 = importDatabaseIdentityFingerprint({ systemIdentifier, databaseOid, databaseName: 'cms_local' })

function identityRow(readOnly: 'on' | 'off' = 'off') {
  return { database_name: 'cms_local', database_oid: databaseOid, system_identifier: systemIdentifier,
    in_recovery: false, transaction_read_only: readOnly }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'Temp') : os.tmpdir()
  const root = await realpath(await mkdtemp(path.join(base, 'news-target-binding-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const uploadDir = path.join(root, 'target-uploads')
  const sourceUploadDir = path.join(root, 'source-uploads')
  const bundleDir = path.join(root, 'bundle')
  await mkdir(uploadDir)
  await mkdir(path.join(sourceUploadDir, 'cms-private'), { recursive: true })
  await mkdir(bundleDir)
  const built = buildBundle(sourceFixture())
  for (const [relative, bytes] of built.revisionFiles) {
    const filename = path.join(bundleDir, ...relative.split('/'))
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, bytes)
  }
  const manifestPath = path.join(bundleDir, 'manifest.json')
  await writeFile(manifestPath, serializeManifest(built.manifest), { flag: 'wx' })
  const preflight = await runImportPreflight(['--bundle', manifestPath], {
    env: { OWNER_NEWS_SOURCE_DATABASE_URL: sourceURL, OWNER_NEWS_TARGET_DATABASE_URL: targetURL,
      OWNER_NEWS_SOURCE_ID: 'synthetic-local', OWNER_NEWS_SOURCE_UPLOAD_DIR: sourceUploadDir,
      OWNER_NEWS_TARGET_UPLOAD_DIR: uploadDir },
    createClient: options => {
      const source = options.databaseName === 'portal_local'
      return { connect: async () => {}, end: async () => {}, on: () => {}, query: async (statement: string) => {
        if (statement.startsWith('BEGIN') || statement.startsWith('SET LOCAL') || statement === 'ROLLBACK') return { rows: [] }
        if (statement.includes('current_database()')) return { rows: [{ database_name: options.databaseName,
          database_oid: source ? '100' : databaseOid, system_identifier: systemIdentifier, in_recovery: false,
          transaction_read_only: 'on', legacy_documents: source ? 'cms_documents' : null,
          legacy_authority: source ? 'owner_news_authority' : null, payload_articles: source ? null : 'news_articles',
          payload_home: source ? null : 'news_home', payload_media: source ? null : 'news_media' }] }
        if (statement.includes('owner_news_authority')) return { rows: [{ mode: 'frozen', epoch: 2 }] }
        throw new Error('unexpected synthetic preflight query')
      } }
    },
  })
  const artifact = claimImportPreflightArtifact(preflight)
  const bundle = artifact.bundle
  const environment = {
    CMS_DATABASE_URL: cmsURL,
    PAYLOAD_SECRET: 'synthetic-payload-secret-not-production',
    PORTAL_PUBLIC_URL: 'https://portal.invalid',
    PORTAL_INTERNAL_URL: 'https://portal-internal.invalid',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-payload-to-portal-not-production',
    PORTAL_TO_PAYLOAD_SECRET: 'synthetic-portal-to-payload-not-production',
    CMS_UPLOAD_DIR: uploadDir,
  }
  for (const [key, value] of Object.entries(environment)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(async () => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }

  const calls: string[] = []
  const session = { execute: async () => ({ rows: [identityRow()] }) }
  const payload = {
    config: { collections: [{ slug: 'news-media', upload: { staticDir: uploadDir } }] },
    db: { allowIDOnCreate: true, poolOptions: { connectionString: cmsURL }, pool: { connect: async () => ({
      query: async (statement: string) => { calls.push(statement); return { rows: [identityRow('on')] } },
      release: () => { calls.push('release') }, on: () => {},
    }) }, sessions: { live: { db: session }, other: { db: { execute: async () => ({ rows: [identityRow()] }) } } } },
  } as unknown as Payload
  const actorUid = 'strict-news-operator'
  const req = { payload, transactionID: 'live', context: {}, user: { id: 'projected-editor', collection: 'portal-editors',
    portalUid: actorUid, portalActor: { uid: actorUid, email: 'operator@example.invalid', name: null, canManageNews: true },
    portalExpiresAt: new Date(Date.now() + 60000).toISOString() } } as unknown as PayloadRequest
  const identity = { actorUid, runId, manifestSha256: artifact.manifestSha256, expectedEpoch: 2 }
  return { artifact, bundle, calls, identity, payload, preflight, req, session, uploadDir }
}

test('preflight binding is exact, in-process, and one-use', async t => {
  const state = await fixture(t)
  assert.throws(() => claimImportPreflightArtifact({ ...state.preflight }), /import_preflight_binding_required/)
  assert.throws(() => claimImportPreflightArtifact(state.preflight), /import_preflight_binding_required/)
})

test('operator capability is request-, transaction-, run-, bundle-, and actor-bound then expires on release', async t => {
  const state = await fixture(t)
  await withOperatorImportCapability(state.req, state.payload, state.bundle, state.artifact, state.identity, async () => {
    await activateOperatorImportCapability(state.req, state.req, state.payload, state.bundle, state.identity)
    await assertOperatorImportActive(state.req, state.payload, state.bundle, state.identity)
    await assert.rejects(assertOperatorImportActive({ ...state.req } as PayloadRequest,
      state.payload, state.bundle, state.identity), /import_operator_admission_mismatch/)
    await assert.rejects(assertOperatorImportActive(state.req, state.payload, Object.assign({}, state.bundle), state.identity),
      /import_operator_admission_mismatch/)
    await assert.rejects(assertOperatorImportActive(state.req, state.payload, state.bundle,
      { ...state.identity, runId: '22222222-2222-4222-8222-222222222222' }), /import_operator_admission_mismatch/)
    const originalUser = state.req.user
    state.req.user = { ...state.req.user!, portalUid: 'other-operator', portalActor: {
      uid: 'other-operator', email: 'other@example.invalid', name: null, canManageNews: true,
    } } as typeof state.req.user
    await assert.rejects(assertOperatorImportActive(state.req, state.payload, state.bundle, state.identity),
      /import_operator_admission_mismatch/)
    state.req.user = originalUser
    state.req.transactionID = 'other'
    await assert.rejects(assertOperatorImportActive(state.req, state.payload, state.bundle, state.identity),
      /import_operator_admission_mismatch/)
    state.req.transactionID = 'live'
    delete state.req.transactionID
    await assert.rejects(assertOperatorImportActive(state.req, state.payload, state.bundle, state.identity),
      /cms_transaction_required/)
    state.req.transactionID = 'live'
  })
  await assert.rejects(assertOperatorImportActive(state.req, state.payload, state.bundle, state.identity),
    /import_operator_admission_mismatch/)
})

test('operator capability does not bypass native write authority while Portal is frozen', async t => {
  const state = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (input: string) => input.endsWith('/authority')
    ? Response.json({ mode: 'frozen', epoch: 2 })
    : Response.json({ actor: { uid: state.identity.actorUid, email: 'operator@example.invalid', name: null, canManageNews: true } }))
  await withOperatorImportCapability(state.req, state.payload, state.bundle, state.artifact, state.identity, async () => {
    await activateOperatorImportCapability(state.req, state.req, state.payload, state.bundle, state.identity)
    await assert.rejects(assertCmsWriteAuthority(state.req), /cms_authority_read_only/)
  })
})

test('preflight artifacts reject changed and symlinked configured CMS storage before adapter use', async t => {
  const state = await fixture(t)
  const payload = state.payload as unknown as { config: { collections: { slug: string; upload: { staticDir: string } }[] }; db: { pool: { connect: () => Promise<unknown> } } }
  const linked = path.join(path.dirname(state.uploadDir), 'linked-uploads')
  await symlink(state.uploadDir, linked, process.platform === 'win32' ? 'junction' : 'dir')
  payload.config.collections[0].upload.staticDir = linked
  process.env.CMS_UPLOAD_DIR = linked
  await assert.rejects(withOperatorImportCapability(state.req, state.payload, state.bundle, state.artifact, state.identity,
    async () => activateOperatorImportCapability(state.req, state.req, state.payload, state.bundle, state.identity)),
  /import_target_binding_mismatch/)
  assert.deepEqual(state.calls, [])
})

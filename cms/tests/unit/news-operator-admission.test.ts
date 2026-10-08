import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pt } from '@payloadcms/translations/languages/pt'
import { buildBundle, serializeManifest } from '../../../scripts/owner-news-payload/bundle.mjs'
import { sourceFixture } from '../../../tests/fixtures/owner-news-payload.mjs'
import { runImportPreflight } from '../../src/migration/preflight'
import { applyFrozenNewsImport, type FrozenNewsImportAdmission } from '../../src/migration/operator-admission'
import type { Payload } from 'payload'

const sourceURL = 'postgresql://preflight:preflight@127.0.0.1/portal_local'
const targetURL = 'postgresql://preflight:preflight@127.0.0.1/cms_local'
const cmsURL = 'postgresql://cms_runtime:cms-runtime-secret@127.0.0.1/cms_local'
const actorUid = 'verified-news-operator'
const runId = '11111111-1111-4111-8111-111111111111'

function setEnvironment(t: { after: (fn: () => void | Promise<void>) => void }, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
}

function preflightConnector() {
  return (configuration: { databaseName: string }) => {
    const isSource = configuration.databaseName === 'portal_local'
    return {
      connect: async () => {},
      query: async (statement: string) => {
        if (statement.startsWith('BEGIN') || statement.startsWith('SET LOCAL')) return { rows: [] }
        if (statement === 'ROLLBACK') return { rows: [] }
        if (statement.includes('current_database()')) return { rows: [{ database_name: configuration.databaseName,
          database_oid: isSource ? '100' : '200', system_identifier: '9912345678901234567',
          in_recovery: false, transaction_read_only: 'on', legacy_documents: isSource ? 'cms_documents' : null,
          legacy_authority: isSource ? 'owner_news_authority' : null, payload_articles: isSource ? null : 'news_articles',
          payload_home: isSource ? null : 'news_home', payload_media: isSource ? null : 'news_media' }] }
        if (statement.includes('owner_news_authority')) return { rows: [{ mode: 'frozen', epoch: 2 }] }
        throw new Error('unexpected synthetic preflight query')
      },
      end: async () => {}, on: () => {},
    }
  }
}

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, options: {
  runtimeURL?: string; runtimeUploadDir?: string; payloadUploadDir?: string; actualSystemIdentifier?: string
} = {}) {
  const base = process.platform === 'win32' ? path.join(process.env.SystemRoot!, 'Temp') : os.tmpdir()
  const root = await realpath(await mkdtemp(path.join(base, 'news-operator-admission-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bundleDir = path.join(root, 'bundle')
  const sourceUploadDir = path.join(root, 'source-uploads')
  const targetUploadDir = path.join(root, 'target-uploads')
  await mkdir(bundleDir)
  await mkdir(path.join(sourceUploadDir, 'cms-private'), { recursive: true })
  await mkdir(targetUploadDir)
  const built = buildBundle(sourceFixture())
  const { manifest } = built
  for (const [relative, bytes] of built.revisionFiles) {
    const filename = path.join(bundleDir, ...relative.split('/'))
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, bytes)
  }
  const manifestPath = path.join(bundleDir, 'manifest.json')
  await writeFile(manifestPath, serializeManifest(manifest), { flag: 'wx' })
  const preflight = await runImportPreflight(['--bundle', manifestPath], {
    env: { OWNER_NEWS_SOURCE_DATABASE_URL: sourceURL, OWNER_NEWS_TARGET_DATABASE_URL: targetURL,
      OWNER_NEWS_SOURCE_ID: 'synthetic-local', OWNER_NEWS_SOURCE_UPLOAD_DIR: sourceUploadDir,
      OWNER_NEWS_TARGET_UPLOAD_DIR: targetUploadDir },
    createClient: preflightConnector(),
  })

  const runtimeURL = options.runtimeURL ?? cmsURL
  const runtimeUploadDir = options.runtimeUploadDir ?? targetUploadDir
  const payloadUploadDir = options.payloadUploadDir ?? targetUploadDir
  setEnvironment(t, { CMS_DATABASE_URL: runtimeURL,
    PAYLOAD_SECRET: 'synthetic-payload-secret-not-production',
    PORTAL_PUBLIC_URL: 'https://portal.invalid', PORTAL_INTERNAL_URL: 'https://portal-internal.invalid',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-payload-to-portal-not-production',
    PORTAL_TO_PAYLOAD_SECRET: 'synthetic-portal-to-payload-not-production', CMS_UPLOAD_DIR: runtimeUploadDir })

  const state = { poolConnects: 0, projectionReads: 0, writes: 0, portalCalls: [] as string[] }
  const physicalRow = { database_name: 'cms_local', database_oid: '200',
    system_identifier: options.actualSystemIdentifier ?? '9912345678901234567', in_recovery: false,
    transaction_read_only: 'on' }
  const payload = {
    config: { collections: [{ slug: 'news-media', upload: { staticDir: payloadUploadDir } }],
      admin: { user: 'portal-editors' }, i18n: { fallbackLanguage: 'pt', supportedLanguages: { pt } } },
    db: { allowIDOnCreate: true, poolOptions: { connectionString: runtimeURL }, pool: { connect: async () => {
      state.poolConnects++
      return { query: async (statement: string) => statement.includes('current_database()')
        ? { rows: [physicalRow] } : { rows: [] }, release: () => {}, on: () => {} }
    } } },
    find: async () => { state.projectionReads++; return { docs: [] } },
    create: async (args: { data?: Record<string, unknown> }) => { state.writes++; return {
      id: 'projected-editor-id', portalUid: args.data?.portalUid, email: args.data?.email, displayName: args.data?.displayName,
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    } },
  } as unknown as Payload
  return { manifest, payload, preflight, root, state, targetUploadDir }
}

function importInput(state: Awaited<ReturnType<typeof fixture>>) {
  return { preflight: state.preflight, payload: state.payload, actorUid, runId,
    manifestSha256: state.preflight.manifestSha256, expectedEpoch: 2 }
}

test('CMS adapter URL mismatch with preflight target fails before identity projection or content writes', async t => {
  const state = await fixture(t, { runtimeURL: 'postgresql://cms_runtime:cms-runtime-secret@127.0.0.1/cms_other' })
  await assert.rejects(applyFrozenNewsImport(importInput(state)), /import_target_binding_mismatch/)
  assert.deepEqual(state.state, { poolConnects: 0, projectionReads: 0, writes: 0, portalCalls: [] })
})

test('live adapter physical target mismatch fails closed before Portal actor check and writes', async t => {
  const state = await fixture(t, { actualSystemIdentifier: '8812345678901234567' })
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    state.state.portalCalls.push(input)
    return Response.json({ actor: { uid: actorUid, email: 'operator@example.invalid', name: null, canManageNews: true } })
  })
  await assert.rejects(applyFrozenNewsImport(importInput(state)), /import_target_binding_(?:mismatch|unavailable)/)
  assert.equal(state.state.poolConnects, 1)
  assert.equal(state.state.portalCalls.length, 0)
  assert.equal(state.state.projectionReads, 0)
  assert.equal(state.state.writes, 0)
})

test('CMS upload symlink is rejected before adapter connection, Portal checks, or writes', async t => {
  const state = await fixture(t)
  const linked = path.join(state.root, 'linked-uploads')
  await symlink(state.targetUploadDir, linked, process.platform === 'win32' ? 'junction' : 'dir')
  process.env.CMS_UPLOAD_DIR = linked
  const payload = state.payload as unknown as { config: { collections: { slug: string; upload: { staticDir: string } }[] } }
  payload.config.collections[0].upload.staticDir = linked
  await assert.rejects(applyFrozenNewsImport(importInput(state)), /import_target_binding_mismatch/)
  assert.equal(state.state.poolConnects, 0)
  assert.equal(state.state.projectionReads, 0)
  assert.equal(state.state.writes, 0)
})

test('inactive/unverified service actor is rejected and never projected into Payload', async t => {
  const state = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    state.state.portalCalls.push(input)
    return Response.json({ reason: 'editorial_permission_denied' }, { status: 403 })
  })
  await assert.rejects(applyFrozenNewsImport(importInput(state)), /editorial_permission_denied/)
  assert.equal(state.state.portalCalls.length, 1)
  assert.equal(state.state.projectionReads, 0)
  assert.equal(state.state.writes, 0)
})

test('malformed/mismatched strict actor and unexpected frozen epoch fail before projection', async t => {
  const malformed = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    malformed.state.portalCalls.push(input)
    return Response.json({ actor: { uid: actorUid, email: 'operator@example.invalid', name: null } })
  })
  await assert.rejects(applyFrozenNewsImport(importInput(malformed)), /editorial_unavailable/)
  assert.equal(malformed.state.projectionReads, 0)
  assert.equal(malformed.state.writes, 0)

  const mismatched = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    mismatched.state.portalCalls.push(input)
    return Response.json({ actor: { uid: 'different-uid', email: 'operator@example.invalid', name: null, canManageNews: true } })
  })
  await assert.rejects(applyFrozenNewsImport(importInput(mismatched)), /editorial_unavailable/)
  assert.equal(mismatched.state.projectionReads, 0)
  assert.equal(mismatched.state.writes, 0)

  const wrongEpoch = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    wrongEpoch.state.portalCalls.push(input)
    return input.endsWith('/authority') ? Response.json({ mode: 'frozen', epoch: 3 })
      : Response.json({ actor: { uid: actorUid, email: 'operator@example.invalid', name: null, canManageNews: true } })
  })
  await assert.rejects(applyFrozenNewsImport(importInput(wrongEpoch)), /cms_preparation_authority_conflict/)
  assert.equal(wrongEpoch.state.portalCalls.length, 2)
  assert.equal(wrongEpoch.state.projectionReads, 0)
  assert.equal(wrongEpoch.state.writes, 0)
})

test('admission snapshots every caller field once across the delayed Portal check', async t => {
  const state = await fixture(t)
  const originalPayload = state.payload
  const transactionStart = new Error('reached captured apply request')
  let beginCalls = 0
  ;(originalPayload.db as typeof originalPayload.db & { beginTransaction: () => Promise<never> }).beginTransaction = async () => {
    beginCalls++
    throw transactionStart
  }

  const alternateState = { find: 0, create: 0 }
  const alternatePayload = {
    config: (originalPayload as unknown as { config: unknown }).config,
    db: originalPayload.db,
    find: async () => { alternateState.find++; return { docs: [] } },
    create: async () => { alternateState.create++; return { id: 'wrong-runtime-editor', portalUid: 'mutated' } },
  } as unknown as Payload
  const values: Record<string, unknown> = importInput(state)
  const fields = ['preflight', 'payload', 'actorUid', 'runId', 'manifestSha256', 'expectedEpoch'] as const
  const reads = Object.fromEntries(fields.map(field => [field, 0])) as Record<typeof fields[number], number>
  const admission = {} as FrozenNewsImportAdmission
  for (const field of fields) Object.defineProperty(admission, field, {
    enumerable: true,
    get() { reads[field]++; return values[field] },
  })

  let startActorCheck!: () => void
  let returnActorResponse!: (response: Response) => void
  const actorCheckStarted = new Promise<void>(resolve => { startActorCheck = resolve })
  const actorResponse = new Promise<Response>(resolve => { returnActorResponse = resolve })
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    if (input.endsWith('/actor/check')) {
      assert.equal(JSON.parse(init.body as string).uid, actorUid)
      startActorCheck()
      return actorResponse
    }
    if (input.endsWith('/authority')) return Response.json({ mode: 'frozen', epoch: 2 })
    throw new Error('unexpected Portal request')
  })

  const operation = applyFrozenNewsImport(admission)
  await actorCheckStarted
  Object.assign(values, { preflight: {}, payload: alternatePayload, actorUid: 'mutated-actor',
    runId: 'not-a-run-id', manifestSha256: 'not-a-manifest-hash', expectedEpoch: 3 })
  returnActorResponse(Response.json({ actor: { uid: actorUid, email: 'operator@example.invalid', name: null,
    canManageNews: true } }))

  await assert.rejects(operation, error => error === transactionStart)
  assert.deepEqual(reads, { preflight: 1, payload: 1, actorUid: 1, runId: 1, manifestSha256: 1, expectedEpoch: 1 })
  assert.equal(state.state.projectionReads, 1)
  assert.equal(state.state.writes, 1)
  assert.equal(alternateState.find, 0)
  assert.equal(alternateState.create, 0)
  assert.equal(beginCalls, 1, 'the captured run/manifest/actor identity passed the import pending-capability guard')
})

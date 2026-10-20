import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'

type IntegrationConfig = {
  cmsDatabaseURL: string
  evidenceDir: string
  portalDatabaseURL: string
  playwrightModule: string | null
  runId: string
  uploadDir: string
}

const runId = process.env.PAYLOAD_TEST_RUN_ID || 'unavailable'
const cases: Array<{ name: string; status: 'PASS' | 'FAIL' | 'NOT_EXECUTED'; detail: string }> = []
let setupFailed = false
let config: IntegrationConfig
let payload: any
let actor: any
let user: any
let makeReq: () => Promise<any>
let editorial: any
let persistence: any
let transaction: any
let reader: any
let preview: any
let editable: any
let fixture: { category: any; image: any; video: any; pdf: any }

function safeFailure(error: unknown): string {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
    return `assertion_or_payload_status_${error.status}`
  }
  return 'assertion_or_payload_error'
}

async function acceptance(name: string, operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
    cases.push({ name, status: 'PASS', detail: 'Real Payload/PostgreSQL assertion passed.' })
  } catch (error) {
    cases.push({ name, status: 'FAIL', detail: safeFailure(error) })
    throw error
  }
}

function sameEditable(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function latestVersion(id: string): Promise<any> {
  const req = await makeReq()
  const result = await payload.findVersions({ collection: 'portal-pages', req, overrideAccess: true,
    depth: 0, limit: 2, where: { and: [{ parent: { equals: id } }, { latest: { equals: true } }] },
    sort: ['-updatedAt', '-id'] })
  assert.equal(result.docs.length, 1)
  return result.docs[0]
}

async function versionByID(id: string): Promise<any> {
  return payload.findVersionByID({ collection: 'portal-pages', id, req: await makeReq(), overrideAccess: true, depth: 0 })
}

async function mainPage(id: string): Promise<any> {
  return payload.findByID({ collection: 'portal-pages', id, req: await makeReq(), overrideAccess: true,
    depth: 0, draft: false, disableErrors: true })
}

before(async () => {
  try {
    // Explicitly validate the test URLs before loading Payload or its adapter.
    // The runner supplies CMS_DATABASE_URL only after this same external guard;
    // require it to equal the explicitly guarded CMS target before removing it
    // from the helper's runtime-fallback check.
    if (process.env.CMS_DATABASE_URL !== process.env.PAYLOAD_TEST_CMS_DATABASE_URL) throw new Error('cms_target_mismatch')
    const guardEnv = { ...process.env }
    delete guardEnv.CMS_DATABASE_URL
    const guard = await import('../support/integration-config.mjs')
    const checked = guard.readIntegrationConfig(guardEnv)
    await guard.checkIntegrationDirectories(checked)
    config = {
      cmsDatabaseURL: checked.cmsDatabaseURL,
      evidenceDir: checked.evidenceDir,
      portalDatabaseURL: checked.portalDatabaseURL,
      playwrightModule: checked.playwrightModule,
      runId: checked.runId,
      uploadDir: checked.uploadDir,
    }
    const [payloadModule, configModule] = await Promise.all([
      import('payload'), import('../../src/payload.config.js'),
    ])
    payload = await payloadModule.getPayload({ config: configModule.default })

    const uid = `portal-page-task4-${config.runId}`
    actor = {
      version: 2,
      uid,
      email: `${config.runId}@example.invalid`,
      name: 'Portal Pages Task 4 synthetic editor',
      capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false },
    }
    let editor = (await payload.find({ collection: 'portal-editors', overrideAccess: true, depth: 0, limit: 1,
      where: { portalUid: { equals: uid } } })).docs[0]
    if (!editor) editor = await payload.create({ collection: 'portal-editors', overrideAccess: true,
      data: { portalUid: uid, email: actor.email, displayName: actor.name } })
    user = { ...editor, collection: 'portal-editors', portalUid: uid, adminActor: actor,
      adminExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
    makeReq = async () => payloadModule.createLocalReq({ req: {
      user, headers: new Headers({ 'sec-fetch-site': 'same-origin' }), context: {},
    }, user, context: {} }, payload)

    ;[editorial, persistence, transaction, reader, preview, editable] = await Promise.all([
      import('../../src/portal-pages/editorial-service.js'),
      import('../../src/portal-pages/persistence.js'),
      import('../../src/publication/transaction.js'),
      import('../../src/portal-pages/reader.js'),
      import('../../src/portal-pages/editorial-preview.js'),
      import('../../src/portal-pages/editorial-native.js'),
    ])

    await mkdir(path.join(config.uploadDir, 'portal-pages'), { recursive: true, mode: 0o700 })
    const req = await makeReq()
    const category = await transaction.withCmsTransaction(payload, req, (transactionReq: any) => payload.create({
      collection: 'portal-page-categories', req: transactionReq, overrideAccess: false,
      data: { name: `Task 4 ${config.runId.slice(0, 8)}`, slug: `task-4-${config.runId.slice(0, 8)}` },
    }))

    const makeMedia = async (mimeType: string, extension: string, originalName: string) => {
      const mediaReq = await makeReq()
      return persistence.withPortalPageMediaMutation(mediaReq, actor.uid, 'create', (transactionReq: any) =>
        payload.create({ collection: 'portal-page-media', req: transactionReq, overrideAccess: true,
          data: { originalName, storageKey: `${randomUUID()}.${extension}`, mimeType, filesize: 16,
            sha256: 'a'.repeat(64), state: 'complete', completedAt: new Date().toISOString(), uploadedBy: actor.uid },
        }))
    }
    const image = await makeMedia('image/png', 'png', `task4-${config.runId.slice(0, 8)}.png`)
    const video = await makeMedia('video/mp4', 'mp4', `task4-${config.runId.slice(0, 8)}.mp4`)
    const pdf = await makeMedia('application/pdf', 'pdf', `task4-${config.runId.slice(0, 8)}.pdf`)
    const mediaFiles = [
      [image, Buffer.from('synthetic-image!')],
      [video, Buffer.from('synthetic-video!')],
      [pdf, Buffer.from('synthetic-pdf-00')],
    ] as const
    await Promise.all(mediaFiles.map(([media, contents]) => {
      assert.equal(contents.byteLength, media.filesize, `synthetic ${media.mimeType} file size must match its Payload record`)
      return writeFile(path.join(config.uploadDir, 'portal-pages', media.storageKey), contents, { mode: 0o600 })
    }))
    fixture = { category, image, video, pdf }
    if (config.playwrightModule) {
      const storageStateFile = path.join(config.evidenceDir, 'portal-page-editorial-storage-state.json')
      await writeFile(storageStateFile, `${JSON.stringify({ cookies: [{ name: 'ownerinc-editorial-dev',
        value: config.runId, domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] })}\n`, { mode: 0o600 })
      const browserFixture = { runId: config.runId, baseURL: 'http://127.0.0.1:3100',
        playwrightModule: config.playwrightModule, storageStateFile }
      await writeFile(path.join(config.evidenceDir, 'portal-page-editorial-browser.json'),
        `${JSON.stringify(browserFixture, null, 2)}\n`, { mode: 0o600 })
    }
  } catch (error) {
    setupFailed = true
    throw error
  }
})

after(async () => {
  try { await payload?.destroy() } catch { /* Report only sanitized fixture status. */ }
  const status = setupFailed || cases.some(item => item.status === 'FAIL') ? 'FAIL'
    : cases.length > 0 && cases.every(item => item.status === 'PASS') ? 'PASS' : 'NOT_EXECUTED'
  if (!config?.evidenceDir) return
  const report = { runId: config.runId, status, cases }
  await writeFile(path.join(config.evidenceDir, 'portal-page-editorial-native-cases.json'),
    `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
})

test('real Payload/PostgreSQL Portal Pages snapshot, publication, preview and rollback acceptance', async () => {
  let pageID = ''
  let saveA: any
  let saveB: any
  let publicationB: any
  let data: any

  await acceptance('synthetic category and complete media records cover every native MIME role', async () => {
    assert.equal(fixture.image.state, 'complete')
    assert.equal(fixture.video.mimeType, 'video/mp4')
    assert.equal(fixture.pdf.mimeType, 'application/pdf')
    assert.equal(fixture.image.uploadedBy, actor.uid)
    assert.equal(fixture.video.uploadedBy, actor.uid)
    assert.equal(fixture.pdf.uploadedBy, actor.uid)
  })

  data = {
    title: `Task 4 ${runId.slice(0, 8)}`,
    slug: `task-4-${runId.slice(0, 8)}`,
    summary: 'Initial editorial summary',
    cover: fixture.image.id,
    coverAlt: 'Imagem de capa sintética',
    categories: [fixture.category.id],
    body: [
      { blockType: 'image', asset: fixture.image.id, alt: 'Imagem inicial' },
      { blockType: 'gallery', images: [
        { asset: fixture.image.id, alt: 'Galeria um' }, { asset: fixture.image.id, alt: 'Galeria dois' },
      ] },
      { blockType: 'video', asset: fixture.video.id, title: 'Vídeo inicial' },
      { blockType: 'pdf', asset: fixture.pdf.id, title: 'PDF inicial' },
      { blockType: 'heading', text: 'Conteúdo inicial', level: '2' },
      { blockType: 'embed', provider: 'youtube', url: 'https://youtu.be/abcdefghijk', title: 'Aula inicial' },
      { blockType: 'callout', tone: 'info', text: 'Informação inicial' },
      { blockType: 'link', label: 'Link inicial', url: 'https://example.invalid', newTab: false, style: 'primary' },
      { blockType: 'divider' },
    ],
  }

  await acceptance('initial explicit create runs Portal author hooks and persists a native Version', async () => {
    saveA = await editorial.saveEditorialVersion(await makeReq(), { id: null, data: data as never })
    pageID = saveA.id
    assert.match(pageID, /^[0-9a-f-]{36}$/iu)
    const row = await versionByID(saveA.version_id)
    const rawParent = typeof row.parent === 'string' ? row.parent : row.parent?.id
    assert.equal(rawParent, pageID)
    assert.equal(row.autosave, false)
    assert.equal(row.version.createdBy, actor.uid)
    assert.equal(row.version.updatedBy, actor.uid)
    assert.equal(row.version._status, 'draft')
    assert.equal(row.version.slug, data.slug)
  })

  await acceptance('direct native publication and historical restore remain denied without the helper scope', async () => {
    const req = await makeReq()
    await assert.rejects(transaction.withCmsTransaction(payload, req, (transactionReq: any) => payload.update({
      collection: 'portal-pages', id: pageID, req: transactionReq, overrideAccess: false, draft: false,
      data: { _status: 'published' },
    })), (error: any) => error?.status === 403)
    await assert.rejects(payload.restoreVersion({ collection: 'portal-pages', id: saveA.version_id,
      req: await makeReq(), draft: true }), (error: any) => error?.status === 403)
  })

  await acceptance('explicit publication creates a matching published Version and main document', async () => {
    const result = await editorial.transitionEditorialPublication(await makeReq(), {
      id: pageID, expected_version_id: saveA.version_id, operation: 'publish',
    })
    assert.equal(result.document_status, 'published')
    assert.ok(result.published_at)
    const published = await mainPage(pageID)
    const savedVersion = await versionByID(result.resulting_version_id)
    assert.equal(published._status, 'published')
    assert.equal(published.publishedAt, result.published_at)
    assert.equal(await editable.editableHash(editable.extractNativeEditable(published)),
      await editable.editableHash(editable.extractNativeEditable(savedVersion.version)))
  })

  const staleRevision = await editorial.readEditorialRevision(await makeReq(), pageID)
  await acceptance('native autosave keeps its mutable Version identity and invalidates an older CAS receipt', async () => {
    const autoSave = async (summary: string) => transaction.withCmsTransaction(payload, await makeReq(), (req: any) =>
      payload.update({ collection: 'portal-pages', id: pageID, req, overrideAccess: false, draft: true,
        autosave: true, depth: 0, data: { summary } }))
    const first = await autoSave('Autosave one')
    const firstAutoRevision = await editorial.readEditorialRevision(await makeReq(), pageID)
    const second = await autoSave('Autosave two')
    const secondAutoRevision = await editorial.readEditorialRevision(await makeReq(), pageID)
    assert.equal(firstAutoRevision.latest?.autosave, true)
    assert.equal(secondAutoRevision.latest?.autosave, true)
    assert.equal(firstAutoRevision.latest?.version_id, secondAutoRevision.latest?.version_id)
    assert.notEqual(firstAutoRevision.latest?.version_id, firstAutoRevision.explicit?.version_id)
    assert.notEqual(first.id, undefined)
    assert.equal(second.id, pageID)
    await assert.rejects(editorial.saveEditorialVersion(await makeReq(), {
      id: pageID, expected_latest_version_id: staleRevision.latest!.version_id,
      expected_snapshot_hash: staleRevision.latest!.snapshot_hash,
    }), (error: any) => error?.status === 409)
  })

  await acceptance('explicit save copies the current autosave without changing the published main document', async () => {
    const revision = await editorial.readEditorialRevision(await makeReq(), pageID)
    saveB = await editorial.saveEditorialVersion(await makeReq(), {
      id: pageID, expected_latest_version_id: revision.latest!.version_id,
      expected_snapshot_hash: revision.latest!.snapshot_hash,
    })
    assert.notEqual(saveB.version_id, revision.latest!.version_id)
    assert.equal(saveB.document_status, 'published')
    const main = await mainPage(pageID)
    assert.equal(main._status, 'published')
    assert.equal(main.summary, 'Initial editorial summary')
    const saved = await versionByID(saveB.version_id)
    assert.equal(saved.autosave, false)
    assert.equal(saved.version.summary, 'Autosave two')
    assert.equal(saved.version.cover, fixture.image.id)
    assert.deepEqual(saved.version.categories, [fixture.category.id])
  })

  await acceptance('concurrent publication of one explicit Version has exactly one winner', async () => {
    const input = { id: pageID, expected_version_id: saveB.version_id, operation: 'publish' as const }
    const results = await Promise.allSettled([
      editorial.transitionEditorialPublication(await makeReq(), input),
      editorial.transitionEditorialPublication(await makeReq(), input),
    ])
    const successes = results.filter(item => item.status === 'fulfilled') as PromiseFulfilledResult<any>[]
    const failures = results.filter(item => item.status === 'rejected') as PromiseRejectedResult[]
    assert.equal(successes.length, 1)
    assert.equal(failures.length, 1)
    assert.equal((failures[0]!.reason as { status?: number }).status, 409)
    publicationB = successes[0]!.value
    const main = await mainPage(pageID)
    const publishedVersion = await versionByID(publicationB.resulting_version_id)
    const savedB = await versionByID(saveB.version_id)
    assert.equal(main._status, 'published')
    assert.equal(main.summary, 'Autosave two')
    assert.equal(await editable.editableHash(editable.extractNativeEditable(savedB.version)),
      await editable.editableHash(editable.extractNativeEditable(publishedVersion.version)))
    assert.deepEqual(main.categories, [fixture.category.id])
    assert.equal(main.cover, fixture.image.id)
  })

  await acceptance('wrong MIME role and incomplete media are rejected before publication', async () => {
    const req = await makeReq()
    await assert.rejects(transaction.withCmsTransaction(payload, req, (transactionReq: any) =>
      persistence.assertPortalPageMediaReferences(payload, { cover: null,
        body: [{ blockType: 'video', asset: fixture.pdf.id, title: 'Wrong MIME' }] }, transactionReq,
      { requireComplete: true })), (error: any) => error?.status === 400)
    const incomplete = await persistence.withPortalPageMediaMutation(await makeReq(), actor.uid, 'create', (transactionReq: any) =>
      payload.create({ collection: 'portal-page-media', req: transactionReq, overrideAccess: true,
        data: { originalName: `incomplete-${runId.slice(0, 8)}.png`, storageKey: `${randomUUID()}.png`,
          mimeType: 'image/png', filesize: 16, sha256: null, state: 'uploading', completedAt: null, uploadedBy: actor.uid } }))
    await assert.rejects(transaction.withCmsTransaction(payload, await makeReq(), (transactionReq: any) =>
      persistence.assertPortalPageMediaReferences(payload, { cover: null,
        body: [{ blockType: 'image', asset: incomplete.id, alt: 'Incomplete' }] }, transactionReq,
      { requireComplete: true })), (error: any) => error?.status === 400)
  })

  await acceptance('fresh exact preview keeps its historical Version and private media authorization', async () => {
    const dto = await reader.queryPortalPagePreview(await makeReq(), pageID, saveB.version_id, {
      uid: actor.uid, email: actor.email, name: actor.name, canManageKnowledge: true,
    })
    assert.equal(dto.revision.id, saveB.version_id)
    assert.equal(dto.revision.status, 'draft')
    assert.equal(dto.title, data.title)
    assert.equal(dto.categories[0]?.id, fixture.category.id)
    assert.equal(dto.cover?.asset_id, fixture.image.id)
    assert.deepEqual(dto.content_blocks.map((block: any) => block.type),
      ['image', 'gallery', 'video', 'pdf', 'heading', 'embed', 'callout', 'link', 'divider'])
    const exact = await preview.loadEditorialPreview(await makeReq(), pageID, saveB.version_id)
    assert.equal(exact.dto.revision.id, saveB.version_id)
    assert.equal(exact.savedAt, saveB.saved_at)
    const assetReq = await makeReq()
    assetReq.routeParams = { pageId: pageID, versionId: saveB.version_id, assetId: fixture.pdf.id }
    assetReq.headers = new Headers({ 'sec-fetch-site': 'same-origin', range: 'bytes=1-4' })
    const asset = await preview.readEditorialPreviewAsset(assetReq)
    assert.equal(asset.status, 206)
    assert.equal(asset.headers.get('cache-control'), 'private,no-store')
    await asset.body?.cancel()
    const expiredReq = await makeReq()
    expiredReq.routeParams = { pageId: pageID, versionId: saveB.version_id, assetId: fixture.image.id }
    expiredReq.headers = new Headers({ 'sec-fetch-site': 'same-origin', range: 'bytes=0-2' })
    expiredReq.user = { ...expiredReq.user, adminExpiresAt: '2020-01-01T00:00:00.000Z' }
    const revoked = await preview.readEditorialPreviewAsset(expiredReq)
    assert.equal(revoked.status, 401)
    assert.equal(await revoked.text().then((text: string) => text.includes('synthetic-image')), false)
  })

  await acceptance('draft save followed by unpublish preserves published withdrawal and exact history', async () => {
    const revision = await editorial.readEditorialRevision(await makeReq(), pageID)
    const savedDraft = await editorial.saveEditorialVersion(await makeReq(), {
      id: pageID, expected_latest_version_id: revision.latest!.version_id,
      expected_snapshot_hash: revision.latest!.snapshot_hash,
    })
    assert.equal(savedDraft.document_status, 'published')
    const unpublished = await editorial.transitionEditorialPublication(await makeReq(), {
      id: pageID, expected_version_id: savedDraft.version_id, operation: 'unpublish',
    })
    assert.equal(unpublished.document_status, 'draft')
    assert.equal(unpublished.published_at, null)
    const main = await mainPage(pageID)
    assert.equal(main._status, 'draft')
    assert.equal(main.publishedAt, null)
    assert.equal(await reader.queryPortalPagePublishedDetail(await makeReq(), data.slug, {
      uid: actor.uid, email: actor.email, name: actor.name, canManageKnowledge: true,
    }), null)
    const historical = await preview.loadEditorialPreview(await makeReq(), pageID, saveB.version_id)
    assert.equal(historical.dto.revision.id, saveB.version_id)
    assert.equal(historical.dto.summary, 'Autosave two')
  })

  await acceptance('a resolved commit failure cannot return a false mutation receipt', async () => {
    const revision = await editorial.readEditorialRevision(await makeReq(), pageID)
    const adapter = payload.db as { commitTransaction: (id: string) => Promise<void>; rollbackTransaction: (id: string) => Promise<void> }
    const realCommit = adapter.commitTransaction.bind(adapter)
    const realRollback = adapter.rollbackTransaction.bind(adapter)
    adapter.commitTransaction = async id => { await realRollback(id) }
    try {
      await assert.rejects(editorial.saveEditorialVersion(await makeReq(), {
        id: pageID, expected_latest_version_id: revision.latest!.version_id,
        expected_snapshot_hash: revision.latest!.snapshot_hash,
      }), (error: any) => error?.status === 503)
    } finally { adapter.commitTransaction = realCommit }
    assert.equal((await editorial.readEditorialRevision(await makeReq(), pageID)).latest?.version_id,
      revision.latest!.version_id)
  })

  await acceptance('receipt confirmation survives a later legitimate Version before independent readback', async () => {
    const revision = await editorial.readEditorialRevision(await makeReq(), pageID)
    const adapter = payload.db as { commitTransaction: (id: string) => Promise<void> }
    const realCommit = adapter.commitTransaction.bind(adapter)
    let injectOnce = true
    adapter.commitTransaction = async id => {
      await realCommit(id)
      if (!injectOnce) return
      injectOnce = false
      const fresh = await editorial.readEditorialRevision(await makeReq(), pageID)
      await transaction.withCmsTransaction(payload, await makeReq(), (transactionReq: any) => payload.update({
        collection: 'portal-pages', id: pageID, req: transactionReq, overrideAccess: false,
        draft: true, autosave: false, depth: 0, data: { summary: 'Later legitimate draft Version' },
      }))
      assert.ok(fresh.latest)
    }
    try {
      const receipt = await editorial.saveEditorialVersion(await makeReq(), {
        id: pageID, expected_latest_version_id: revision.latest!.version_id,
        expected_snapshot_hash: revision.latest!.snapshot_hash,
      })
      assert.ok(receipt.version_id)
      assert.notEqual((await editorial.readEditorialRevision(await makeReq(), pageID)).latest?.version_id, receipt.version_id)
    } finally { adapter.commitTransaction = realCommit }
  })
})

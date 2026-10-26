import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { BasePayload, createLocalReq } from 'payload'
import { assertCmsStorageReady } from '../../src/config/readiness.js'
import { queryGoLivePreflight } from '../../src/publication/go-live-preflight.js'

const marker = process.env.PAYLOAD_MANUAL_RUNTIME_MARKER
const directory = path.resolve(process.env.PAYLOAD_MANUAL_RUNTIME_EVIDENCE || '')
const uploadDir = path.resolve(process.env.CMS_UPLOAD_DIR || '')
const mode = process.env.PAYLOAD_MANUAL_RUNTIME_ACTION
if (!/^[0-9a-f]{32}$/u.test(marker || '') || !['prepare', 'capture', 'verify'].includes(mode || '') ||
  path.dirname(uploadDir) !== directory || path.basename(uploadDir) !== 'uploads') {
  throw new Error('manual_runtime_disposable_contract_invalid')
}

const evidenceFile = path.join(directory, 'content-proof.json')
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const editor = { uid: `manual-editor-${marker}`, email: `manual-${marker}@example.invalid`, name: null, canManageNews: true }

test(`manual-only persisted content ${mode}`, async () => {
  const originalFetch = globalThis.fetch
  let stage = 'config'
  globalThis.fetch = async url => {
    if (String(url).endsWith('/authority')) return Response.json({ mode: 'payload', epoch: 1 })
    return Response.json({ actor: editor, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  }
  const payload = new BasePayload()
  try {
    const config = await (await import('../../src/payload.config.js')).default
    assert.equal(config.collections.some(collection => collection.slug === 'news-schedules'), false)
    assert.equal(config.endpoints.some(endpoint => endpoint.path === '/news-schedule'), false)
    assert.deepEqual(config.jobs?.tasks, [])
    config.typescript.autoGenerate = false
    stage = 'payload-init'
    await payload.init({ config, disableOnInit: true })
    stage = 'readiness'
    await payload.find({ collection: 'portal-editors', limit: 1, depth: 0, pagination: false, overrideAccess: true })
    await assertCmsStorageReady(uploadDir)

    if (mode === 'prepare') {
      stage = 'preflight'
      const preflight = await queryGoLivePreflight(await createLocalReq({}, payload), {
        publicationMode: 'manual', getAuthority: async () => ({ mode: 'frozen', epoch: 1 }),
      })
      assert.equal(preflight.newsEmpty, true); assert.equal(preflight.mutation.sequence, '0')
      stage = 'editor-projection'
      const projection = await payload.create({ collection: 'portal-editors', overrideAccess: true,
        data: { portalUid: editor.uid, email: editor.email } })
      assert.equal(projection.portalUid, editor.uid)
    } else if (mode === 'capture') {
      stage = 'capture'
      const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
      const version = await payload.findVersions({ collection: 'news-articles', overrideAccess: true,
        where: { parent: { equals: evidence.articleId } }, sort: '-updatedAt', depth: 0, limit: 1 })
      assert.ok(version.docs[0]?.id)
      assert.equal(version.docs[0].version._status, 'draft')
      evidence.versionId = version.docs[0].id; evidence.versionTitle = version.docs[0].version.title
      evidence.versionStatus = version.docs[0].version._status
      assert.equal(digest(await readFile(path.join(uploadDir, evidence.filename))), evidence.mediaSha256)
      await writeFile(evidenceFile, JSON.stringify(evidence), { mode: 0o600 })
    } else {
      stage = 'verify'
      const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'))
      assert.equal(evidence.schemaVersion, 1)
      const article = await payload.findByID({ collection: 'news-articles', id: evidence.articleId, overrideAccess: true, draft: false, depth: 0 })
      const media = await payload.findByID({ collection: 'news-media', id: evidence.mediaId, overrideAccess: true, depth: 0 })
      const version = await payload.findVersions({ collection: 'news-articles', overrideAccess: true,
        where: { and: [{ id: { equals: evidence.versionId } }, { parent: { equals: evidence.articleId } }] }, depth: 0, limit: 1 })
      assert.equal(article._status, 'published'); assert.equal(article.title, evidence.title)
      assert.equal(media.filename, evidence.filename); assert.equal(version.docs.length, 1)
      assert.equal(version.docs[0].version.title, evidence.versionTitle)
      assert.equal(evidence.versionStatus, 'draft')
      assert.equal(version.docs[0].version._status, evidence.versionStatus)
      assert.equal(digest(await readFile(path.join(uploadDir, evidence.filename))), evidence.mediaSha256)
    }
  } catch (error) {
    process.stderr.write(`MANUAL_RUNTIME_CONTENT_DIAGNOSTIC action=${mode} stage=${stage}\n`)
    throw error
  } finally {
    globalThis.fetch = originalFetch
    await payload.destroy().catch(() => {})
  }
})

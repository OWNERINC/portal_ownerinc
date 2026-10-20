import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'node:test'
import React from 'react'
import { editorialFixture, nativePage, pageID, versionID } from '../fixtures/portal-page-editorial'
import { PortalPagePreview, assetURL } from '../../src/admin/portal-pages/PortalPagePreview'
import { createEditorialPreviewAssetReader, loadEditorialPreview, readEditorialPreviewAsset } from '../../src/portal-pages/editorial-preview'
import { portalPageMediaResponse, type PortalPageDescriptor } from '../../src/portal-pages/read-file'
import type { PortalPageDTO } from '../../src/portal-pages/contracts'

const editorHeaders = new Headers({ 'sec-fetch-site': 'same-origin' })
const assetID = '44444444-4444-4444-8444-444444444444'
const laterVersionID = '55555555-5555-4555-8555-555555555555'

function nativeVersion(overrides: Record<string, unknown> = {}) {
  return { id: versionID, parent: pageID, latest: true, autosave: false,
    updatedAt: '2026-10-19T10:00:00.000Z', version: { ...nativePage, _status: 'draft', publishedAt: null, ...overrides } }
}

function withEditorialHeaders(req: ReturnType<typeof editorialFixture>['req']) {
  req.headers = editorHeaders
  return req
}

function fixtureAssetRecord(overrides: Record<string, unknown> = {}) {
  return { id: assetID, originalName: 'preview.png', storageKey: `${assetID}.png`, mimeType: 'image/png', filesize: 8,
    sha256: 'a'.repeat(64), state: 'complete', uploadedBy: 'editor-uid', completedAt: '2026-10-19T10:00:00.000Z', ...overrides }
}

async function assetFixture(
  body: unknown[] = [{ blockType: 'image', asset: assetID, alt: 'Imagem de teste' }],
  mediaOverrides: Record<string, unknown> = {},
) {
  const f = editorialFixture()
  f.seedVersion(nativeVersion({ body }))
  const media = fixtureAssetRecord(mediaOverrides)
  const payload = f.req.payload as unknown as { findByID: (args: Record<string, unknown>) => Promise<unknown> }
  const findByID = payload.findByID.bind(payload)
  payload.findByID = async args => args.collection === 'portal-page-media' ? structuredClone(media) : findByID(args)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-page-preview-'))
  const mediaDir = path.join(dir, 'portal-pages')
  await mkdir(mediaDir, { recursive: true, mode: 0o700 })
  await writeFile(path.join(mediaDir, media.storageKey), Buffer.from('preview!'), { mode: 0o600 })
  const original = {
    CMS_DATABASE_URL: process.env.CMS_DATABASE_URL,
    PAYLOAD_SECRET: process.env.PAYLOAD_SECRET,
    PORTAL_PUBLIC_URL: process.env.PORTAL_PUBLIC_URL,
    PORTAL_INTERNAL_URL: process.env.PORTAL_INTERNAL_URL,
    PAYLOAD_TO_PORTAL_SECRET: process.env.PAYLOAD_TO_PORTAL_SECRET,
    PORTAL_TO_PAYLOAD_SECRET: process.env.PORTAL_TO_PAYLOAD_SECRET,
    CMS_UPLOAD_DIR: process.env.CMS_UPLOAD_DIR,
  }
  Object.assign(process.env, {
    CMS_DATABASE_URL: 'postgresql://editorial_test:local-only@127.0.0.1:55440/portal_pages_cms_test',
    PAYLOAD_SECRET: 'local-test-payload-secret-at-least-32-bytes',
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:3001',
    PORTAL_INTERNAL_URL: 'http://127.0.0.1:3002',
    PAYLOAD_TO_PORTAL_SECRET: 'local-test-payload-to-portal-secret',
    PORTAL_TO_PAYLOAD_SECRET: 'local-test-portal-to-payload-secret',
    CMS_UPLOAD_DIR: dir,
  })
  const req = withEditorialHeaders(f.req)
  req.routeParams = { pageId: pageID, versionId: versionID, assetId: assetID }
  return {
    ...f, req, dir,
    async restore() {
      await rm(dir, { recursive: true, force: true })
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

function countedDescriptor(bytes: Buffer) {
  let reads = 0
  let closes = 0
  const handle: PortalPageDescriptor = {
    stat: async () => ({ size: bytes.byteLength, isFile: () => true }),
    read: async (buffer, offset, length, position) => {
      reads++
      const count = Math.min(length, Math.max(0, bytes.byteLength - position))
      bytes.copy(buffer, offset, position, position + count)
      return { bytesRead: count }
    },
    close: async () => { closes++ },
  }
  return { handle, get reads() { return reads }, get closes() { return closes } }
}

test('missing version is not replaced with published content', async () => {
  const f = editorialFixture()
  withEditorialHeaders(f.req)
  await assert.rejects(loadEditorialPreview(f.req, pageID, ''), { status: 400 })
  assert.equal(f.calls.some(call => call.operation === 'update'), false)
})

test('editorial asset endpoint replaces storage metadata in Content-Disposition and preserves safe range headers', async () => {
  const secretStorageKey = '77777777-7777-4777-8777-777777777777.pdf'
  const secretOriginalName = 'confidential-finance-name.pdf'
  const f = await assetFixture([{ blockType: 'pdf', asset: assetID, title: 'Manual' }], {
    originalName: secretOriginalName,
    storageKey: secretStorageKey,
    mimeType: 'application/pdf',
  })
  try {
    f.req.headers = new Headers({ range: 'bytes=2-4', 'sec-fetch-site': 'same-origin' })
    const response = await readEditorialPreviewAsset(f.req)
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.equal(response.headers.get('content-length'), '3')
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/8')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('cache-control'), 'private,no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('content-disposition'), `inline; filename="portal-page-${assetID}.pdf"`)
    const exposed = `${[...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n')}\n${await response.text()}`
    assert.equal(exposed.includes(secretStorageKey), false)
    assert.equal(exposed.includes(secretOriginalName), false)
  } finally { await f.restore() }
})

test('unknown or wrong-parent Version is not found and never falls back to the current page', async () => {
  const unknown = editorialFixture()
  withEditorialHeaders(unknown.req)
  await assert.rejects(loadEditorialPreview(unknown.req, pageID, versionID), { status: 404 })

  const wrongParent = editorialFixture()
  wrongParent.seedVersion({ ...nativeVersion(), parent: '99999999-9999-4999-8999-999999999999' })
  withEditorialHeaders(wrongParent.req)
  await assert.rejects(loadEditorialPreview(wrongParent.req, pageID, versionID), { status: 404 })
})

test('an old preview stays bound to its immutable Version after the current document changes', async () => {
  const f = editorialFixture()
  f.seedVersion(nativeVersion({ title: 'Versão antiga' }))
  f.seedPage({ id: pageID, ...nativePage, title: 'Publicação posterior', _status: 'published', publishedAt: '2026-10-20T10:00:00.000Z' })
  withEditorialHeaders(f.req)
  const result = await loadEditorialPreview(f.req, pageID, versionID)
  assert.equal(result.dto.title, 'Versão antiga')
  assert.equal(result.dto.revision.id, versionID)
  assert.equal(result.dto.revision.status, 'draft')
  assert.equal(result.savedAt, '2026-10-19T10:00:00.000Z')
})

test('preview requires current manageKnowledge authority and a live V2 session', async () => {
  const denied = editorialFixture()
  denied.seedVersion(nativeVersion())
  withEditorialHeaders(denied.req)
  const user = denied.req.user as unknown as { adminActor: { capabilities: { manageKnowledge: boolean } } }
  user.adminActor.capabilities.manageKnowledge = false
  await assert.rejects(loadEditorialPreview(denied.req, pageID, versionID), { status: 403 })

  const expired = editorialFixture()
  expired.seedVersion(nativeVersion())
  withEditorialHeaders(expired.req)
  ;(expired.req.user as unknown as { adminExpiresAt: string }).adminExpiresAt = '2020-01-01T00:00:00.000Z'
  await assert.rejects(loadEditorialPreview(expired.req, pageID, versionID), { status: 401 })
})

test('preview service strictly validates both UUIDs and rejects cross-site reads', async () => {
  const f = editorialFixture()
  withEditorialHeaders(f.req)
  await assert.rejects(loadEditorialPreview(f.req, `${pageID}/extra`, versionID), { status: 400 })
  f.req.headers = new Headers({ 'sec-fetch-site': 'cross-site' })
  await assert.rejects(loadEditorialPreview(f.req, pageID, versionID), { status: 403 })
})

test('asset route requires all three UUIDs and returns no bytes for an unreferenced completed asset', async () => {
  const malformed = await assetFixture()
  try {
    malformed.req.routeParams = { pageId: pageID, versionId: versionID, assetId: 'not-a-uuid' }
    const invalid = await readEditorialPreviewAsset(malformed.req)
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).error, 'invalid_request')

    malformed.req.routeParams = { pageId: pageID, versionId: laterVersionID, assetId: assetID }
    const unknownVersion = await readEditorialPreviewAsset(malformed.req)
    assert.equal(unknownVersion.status, 404)
    assert.deepEqual(await unknownVersion.json(), {
      error: 'portal_page_not_found', message: 'A página ou o arquivo não foi encontrado.',
    })

    const unreferenced = await assetFixture([])
    try {
      const response = await readEditorialPreviewAsset(unreferenced.req)
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), {
        error: 'portal_page_not_found', message: 'A página ou o arquivo não foi encontrado.',
      })
    } finally { await unreferenced.restore() }
  } finally { await malformed.restore() }
})

test('asset role MIME mismatch is denied without exposing bytes', async () => {
  const f = await assetFixture([{ blockType: 'video', asset: assetID, title: 'Vídeo' }])
  try {
    const payload = f.req.payload as unknown as { findByID: (args: Record<string, unknown>) => Promise<unknown> }
    const findByID = payload.findByID.bind(payload)
    payload.findByID = async args => args.collection === 'portal-page-media'
      ? fixtureAssetRecord({ mimeType: 'image/png', storageKey: `${assetID}.png` }) : findByID(args)
    const response = await readEditorialPreviewAsset(f.req)
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), {
      error: 'portal_page_not_found', message: 'A página ou o arquivo não foi encontrado.',
    })
  } finally { await f.restore() }
})

test('private preview assets honor PDF open, suffix and invalid ranges while images stay whole', async () => {
  const pdfID = assetID
  const f = await assetFixture([{ blockType: 'pdf', asset: pdfID, title: 'Manual' }])
  try {
    const payload = f.req.payload as unknown as { findByID: (args: Record<string, unknown>) => Promise<unknown> }
    const findByID = payload.findByID.bind(payload)
    const pdf = fixtureAssetRecord({ originalName: 'preview.pdf', mimeType: 'application/pdf', storageKey: `${pdfID}.pdf` })
    await rm(path.join(f.dir, 'portal-pages', `${assetID}.png`))
    await writeFile(path.join(f.dir, 'portal-pages', pdf.storageKey), Buffer.from('preview!'), { mode: 0o600 })
    payload.findByID = async args => args.collection === 'portal-page-media' ? pdf : findByID(args)

    f.req.headers = new Headers({ 'range': 'bytes=2-', 'sec-fetch-site': 'same-origin' })
    const open = await readEditorialPreviewAsset(f.req)
    assert.equal(open.status, 206, `${await open.clone().text()} operations=${f.calls.map(call => call.operation).join(',')}`)
    assert.equal(open.headers.get('content-range'), 'bytes 2-7/8')
    assert.equal(await open.text(), 'eview!')

    f.req.headers = new Headers({ 'range': 'bytes=-3', 'sec-fetch-site': 'same-origin' })
    const suffix = await readEditorialPreviewAsset(f.req)
    assert.equal(suffix.status, 206)
    assert.equal(suffix.headers.get('content-range'), 'bytes 5-7/8')
    assert.equal(await suffix.text(), 'ew!')

    f.req.headers = new Headers({ 'range': 'bytes=9-', 'sec-fetch-site': 'same-origin' })
    const invalidRange = await readEditorialPreviewAsset(f.req)
    assert.equal(invalidRange.status, 416)
    assert.equal(invalidRange.headers.get('content-range'), 'bytes */8')
    assert.equal(invalidRange.headers.get('cache-control'), 'private,no-store')

    const image = await assetFixture()
    try {
      image.req.headers = new Headers({ 'range': 'bytes=2-3', 'sec-fetch-site': 'same-origin' })
      const full = await readEditorialPreviewAsset(image.req)
      assert.equal(full.status, 200)
      assert.equal(full.headers.get('accept-ranges'), null)
      assert.equal(await full.text(), 'preview!')
    } finally { await image.restore() }
  } finally { await f.restore() }
})

test('asset response streams with bounded reads and cancellation closes its descriptor', async () => {
  const f = await assetFixture()
  try {
    const response = await readEditorialPreviewAsset(f.req)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private,no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.equal(first.value?.byteLength, 8)
    await reader.cancel()
    await rm(path.join(f.dir, 'portal-pages', `${assetID}.png`))
  } finally { await f.restore() }
})

test('editorial endpoint downstream cancellation closes its opened descriptor exactly once', async () => {
  const f = await assetFixture([{ blockType: 'pdf', asset: assetID, title: 'Manual' }], {
    mimeType: 'application/pdf', storageKey: '77777777-7777-4777-8777-777777777777.pdf',
  })
  const opened = countedDescriptor(Buffer.from('preview!'))
  const endpoint = createEditorialPreviewAssetReader(options => portalPageMediaResponse({
    media: options.media, range: options.range, signal: options.signal,
    openDescriptor: async () => opened.handle,
  }))
  try {
    const response = await endpoint(f.req)
    assert.equal(response.status, 200)
    const body = response.body!.getReader()
    await body.cancel()
    await body.cancel()
    assert.equal(opened.reads, 0)
    assert.equal(opened.closes, 1)
  } finally { await f.restore() }
})

test('storage errors are sanitized and a commit failure cancels an already-open stream', async () => {
  const missing = await assetFixture()
  try {
    await rm(path.join(missing.dir, 'portal-pages', `${assetID}.png`))
    const response = await readEditorialPreviewAsset(missing.req)
    assert.equal(response.status, 503)
    const detail = await response.text()
    assert.doesNotMatch(detail, /portal-page-preview|storageKey|uploadDir|[A-Z]:\\/u)
  } finally { await missing.restore() }

  const failedCommit = await assetFixture()
  try {
    const opened = countedDescriptor(Buffer.from('preview!'))
    const endpoint = createEditorialPreviewAssetReader(options => portalPageMediaResponse({
      media: options.media, range: options.range, signal: options.signal,
      openDescriptor: async () => opened.handle,
    }))
    const db = failedCommit.req.payload.db as unknown as { commitTransaction: (id: string) => Promise<void> }
    db.commitTransaction = async () => { throw new Error('synthetic_commit_failure') }
    const response = await endpoint(failedCommit.req)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'portal_page_editorial_unavailable', message: 'Não foi possível carregar a prévia agora.',
    })
    assert.equal(opened.reads, 0)
    assert.equal(opened.closes, 1)
    await rm(path.join(failedCommit.dir, 'portal-pages', `${assetID}.png`))
  } finally { await failedCommit.restore() }
})

test('a revoked editor receives no bytes on a fresh Range request', async () => {
  const f = await assetFixture()
  try {
    f.req.headers = new Headers({ range: 'bytes=0-3', 'sec-fetch-site': 'same-origin' })
    const allowed = await readEditorialPreviewAsset(f.req)
    assert.equal(allowed.status, 200)
    await allowed.body?.cancel()
    ;(f.req.user as unknown as { adminExpiresAt: string }).adminExpiresAt = '2020-01-01T00:00:00.000Z'
    const revoked = await readEditorialPreviewAsset(f.req)
    assert.equal(revoked.status, 401)
    assert.deepEqual(await revoked.json(), {
      error: 'editorial_session_invalid', message: 'A sessão editorial expirou. Entre novamente.',
    })
  } finally { await f.restore() }
})

test('renderer covers every normalized block and inline variant without unsafe markup or storage metadata', () => {
  const dto: PortalPageDTO = {
    id: pageID, slug: 'guia', title: '<Título>', summary: 'Resumo & mais',
    cover: { asset_id: assetID, alt: 'Capa "segura"' }, categories: [], published_at: null,
    content_version: 1, asset_scope: 'portal-pages-preview', revision: { id: versionID, status: 'draft' },
    content_blocks: [
      { type: 'heading', text: '<Seção>', level: 2 },
      { type: 'rich_text', nodes: [
        { type: 'paragraph', children: [
          { type: 'text', text: '<texto>', marks: ['bold', 'italic', 'underline', 'code'] },
          { type: 'break' },
          { type: 'link', url: 'https://example.test/guia', new_tab: true, children: [{ type: 'text', text: 'link', marks: [] }] },
        ] },
        { type: 'heading', level: 3, children: [{ type: 'text', text: 'subtítulo', marks: [] }] },
        { type: 'list', ordered: false, items: [[{ type: 'text', text: 'um', marks: [] }]] },
        { type: 'list', ordered: true, items: [[{ type: 'text', text: 'dois', marks: [] }]] },
      ] },
      { type: 'image', asset_id: assetID, alt: 'Imagem', caption: 'Legenda' },
      { type: 'gallery', images: [{ asset_id: assetID, alt: 'Foto um' }, { asset_id: assetID, alt: 'Foto dois', caption: 'Duas' }] },
      { type: 'video', asset_id: assetID, title: 'Vídeo' },
      { type: 'pdf', asset_id: assetID, title: 'Documento' },
      { type: 'embed', provider: 'youtube', url: 'https://www.youtube.com/embed/abcdefghijk', title: 'Aula' },
      { type: 'callout', tone: 'warning', title: 'Atenção', text: 'Leia com atenção' },
      { type: 'link', label: 'Abrir guia', url: 'https://example.test', new_tab: true, style: 'primary' },
      { type: 'divider' },
      { type: 'heading', text: 'Largura total', level: 3, layout: 'full' },
      { type: 'heading', text: 'Coluna esquerda', level: 4, layout: 'left' },
      { type: 'heading', text: 'Coluna direita', level: 2, layout: 'right' },
      { type: 'heading', text: 'Amplo', level: 3, layout: 'wide' },
    ],
  }
  const html = renderToStaticMarkup(React.createElement(PortalPagePreview, { dto, savedAt: '2026-10-19T10:00:00.000Z' }))
  assert.match(html, /&lt;Título&gt;/u)
  assert.match(html, /&lt;texto&gt;/u)
  assert.match(html, /<strong><em><u><code>&lt;texto&gt;/u)
  assert.match(html, /<br\s*\//u)
  assert.match(html, /target="_blank" rel="noopener noreferrer"/u)
  assert.match(html, /<ol/u)
  assert.match(html, /<ul/u)
  assert.match(html, /<figure/u)
  assert.match(html, /<video[^>]*controls[^>]*preload="metadata"/u)
  assert.match(html, /<object[^>]*type="application\/pdf"/u)
  assert.match(html, /<iframe[^>]*title="Aula"/u)
  assert.match(html, /<aside[^>]*aria-label="Atenção"/u)
  assert.match(html, /<hr\s*\//u)
  assert.match(html, /portal-page-preview__block--full/u)
  assert.match(html, /portal-page-preview__block--left/u)
  assert.match(html, /portal-page-preview__block--right/u)
  assert.match(html, /portal-page-preview__block--wide/u)
  assert.equal((html.match(new RegExp(assetURL(dto, assetID), 'gu')) || []).length, 9)
  assert.doesNotMatch(html, /<script|<style|storageKey|uploadDir|token=|storageKey|[A-Z]:\\/iu)
  assert.equal(assetURL(dto, assetID), `/editorial/api/portal-page-editorial/preview-assets/${pageID}/${versionID}/${assetID}`)
})

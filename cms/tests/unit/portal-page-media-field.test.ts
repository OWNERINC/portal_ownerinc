import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { claimPortalPageUpload, portalPageUploadIsOwnedByOther, releasePortalPageUpload, sameDestination } from '../../src/admin/portal-pages/upload-client'
import type { Destination } from '../../src/admin/portal-pages/upload-client'

const wrapperSource = readFileSync(fileURLToPath(new URL('../../src/admin/portal-pages/PortalPageMediaField.tsx', import.meta.url)), 'utf8')
const panelSource = readFileSync(fileURLToPath(new URL('../../src/admin/portal-pages/PortalPageUploadPanel.tsx', import.meta.url)), 'utf8')
const clientSource = readFileSync(fileURLToPath(new URL('../../src/admin/portal-pages/upload-client.ts', import.meta.url)), 'utf8')
const browserSource = readFileSync(fileURLToPath(new URL('../integration/portal-page-editorial-upload.mjs', import.meta.url)), 'utf8')

const pageID = '11111111-1111-4111-8111-111111111111'
const start: Destination = { documentID: pageID, path: 'body.0.images.0.asset',
  blockID: 'gallery-a', galleryItemID: 'row-a', generation: 1 }

test('reordering a gallery invalidates the original destination even if index is reused', () => {
  assert.equal(sameDestination(start, { ...start, galleryItemID: 'row-b' }), false)
  assert.equal(sameDestination(start, { ...start, path: 'body.0.images.1.asset' }), false)
})

test('destination equality includes document, exact native path, both row IDs and observed generation', () => {
  assert.equal(sameDestination(start, { ...start }), true)
  assert.equal(sameDestination(start, { ...start, documentID: '22222222-2222-4222-8222-222222222222' }), false)
  assert.equal(sameDestination(start, { ...start, path: 'body.1.images.0.asset' }), false)
  assert.equal(sameDestination(start, { ...start, blockID: 'gallery-b' }), false)
  assert.equal(sameDestination(start, { ...start, generation: 2 }), false)
  assert.equal(sameDestination({ ...start, galleryItemID: null }, start), false)
})

test('document-scoped upload mutex blocks synchronous duplicate starts and releases only its owner', () => {
  const ownerA = {}, ownerB = {}, formA = {}, formB = {}
  assert.equal(claimPortalPageUpload('page-a', formA, ownerA), true)
  assert.equal(claimPortalPageUpload('page-a', formA, ownerB), false)
  assert.equal(portalPageUploadIsOwnedByOther('page-a', formA, ownerB), true)
  assert.equal(releasePortalPageUpload('page-a', formA, ownerB), false)
  assert.equal(portalPageUploadIsOwnedByOther('page-a', formA, ownerA), false)
  assert.equal(claimPortalPageUpload('page-b', formB, ownerB), true)
  assert.equal(claimPortalPageUpload('', formA, ownerA), true)
  assert.equal(claimPortalPageUpload('', formB, ownerB), true, 'unsaved forms use separate form identities')
  assert.equal(releasePortalPageUpload('page-a', formA, ownerA), true)
  assert.equal(claimPortalPageUpload('page-a', formA, ownerB), true)
  releasePortalPageUpload('page-a', formA, ownerB)
  releasePortalPageUpload('page-b', formB, ownerB)
  releasePortalPageUpload('', formA, ownerA)
  releasePortalPageUpload('', formB, ownerB)
})

test('the relationship wrapper consumes only public Payload APIs and the reviewed Task 2 focus hook', () => {
  assert.match(wrapperSource, /from ['"]payload['"]/u, 'RelationshipFieldClientProps must use Payload public types')
  assert.match(wrapperSource, /from ['"]@payloadcms\/ui['"]/u, 'Payload UI imports must use its public package')
  assert.match(wrapperSource, /RelationshipField/u)
  assert.match(wrapperSource, /useField/u)
  assert.match(wrapperSource, /useFormFields/u)
  assert.match(wrapperSource, /useDocumentInfo/u)
  assert.match(wrapperSource, /useEditorialFieldFocusTarget/u)
  assert.match(wrapperSource, /\.rows/u, 'native array/block row IDs must be observed from selective form state')
  assert.match(panelSource, /setUploadStatus\?\./u)
  assert.match(wrapperSource, /allowCreate|field/u)
  assert.doesNotMatch(wrapperSource, /form\.fields|document\.querySelector|querySelector\(/u)
  assert.doesNotMatch(wrapperSource, /fetch\(['"]\/api\/|graphql|portal-page-media['"].*method/u)
  assert.match(wrapperSource, /readGenerationRef\.current\s*\+=\s*1[\s\S]{0,120}readControllerRef\.current\?\.abort\(\)/u,
    'starting a later upload must invalidate any earlier collection reread')
})

test('the accessible upload panel uses a labeled file input, linked instructions, status, alert, progress and Drawer', () => {
  assert.match(panelSource, /<Drawer/u)
  assert.match(panelSource, /type="file"/u)
  assert.match(panelSource, /aria-describedby/u)
  assert.match(panelSource, /role="progressbar"/u)
  assert.match(panelSource, /aria-valuemax/u)
  assert.match(panelSource, /aria-valuenow/u)
  assert.match(panelSource, /role="status"/u)
  assert.match(panelSource, /aria-live="polite"/u)
  assert.match(panelSource, /role="alert"/u)
  assert.match(panelSource, /beforeunload/u)
  assert.match(panelSource, /Cancelar envio\?/u)
  assert.match(panelSource, /role="alertdialog"[\s\S]{0,100}aria-labelledby/u,
    'the cancellation confirmation needs an accessible name')
  assert.match(clientSource, /upload_limit_reached|dois uploads por editor e oito no total/u)
})

test('browser acceptance source names all five native media destinations and required stale/selection cases', () => {
  for (const expected of ['cover', 'image.asset', 'gallery.images[0].asset', 'video.asset', 'pdf.asset']) {
    assert.ok(browserSource.includes(expected), `browser cases must include ${expected}`)
  }
  for (const expected of ['Usar este arquivo', '100%', 'reorder', 'document', 'close', 'MIME', 'focus', 'alt', 'title']) {
    assert.ok(browserSource.toLowerCase().includes(expected.toLowerCase()), `browser cases must cover ${expected}`)
  }
  assert.match(browserSource, /runEditorialUploadCases/u)
})

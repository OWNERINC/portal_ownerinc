import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractNativeEditable, validateNativeEditable, editableHash } from '../../src/portal-pages/editorial-native'
import { nativePage, pageID } from '../fixtures/portal-page-editorial'

test('strict browser ingress rejects ownership keys; trusted extraction strips them', () => {
  assert.throws(() => validateNativeEditable({ ...nativePage, _status: 'published' }))
  assert.throws(() => validateNativeEditable({ ...nativePage, serverField: 'forged' }))
  assert.deepEqual(extractNativeEditable({ ...nativePage, id: pageID, _status: 'published' }), nativePage)
})

test('editable hash ignores key order and populated relationship shape, not array order', async () => {
  const a = { ...nativePage, categories: [pageID] }
  assert.equal(await editableHash(a), await editableHash({ ...nativePage, categories: [{ id: pageID }] }))
  assert.notEqual(await editableHash(nativePage), await editableHash({ ...nativePage, title: 'Outro guia' }))
  assert.notEqual(await editableHash({ ...a, categories: [pageID, '33333333-3333-4333-8333-333333333333'] }),
    await editableHash({ ...a, categories: ['33333333-3333-4333-8333-333333333333', pageID] }))
  const gallery = { blockType: 'gallery', images: [
    { id: '33333333-3333-4333-8333-333333333333', asset: pageID, alt: 'Primeira' },
    { id: '44444444-4444-4444-8444-444444444444', asset: '55555555-5555-4555-8555-555555555555', alt: 'Segunda' },
  ] }
  assert.notEqual(await editableHash({ ...nativePage, body: [gallery] }), await editableHash({ ...nativePage,
    body: [{ ...gallery, images: [...gallery.images].reverse() }] }))
})

test('missing optional page values normalize, but required title and slug never default', () => {
  assert.deepEqual(extractNativeEditable({ title: ' Guia ', slug: ' Guia ', categories: null, body: null }),
    { ...nativePage, title: 'Guia', slug: 'guia' })
  assert.deepEqual(validateNativeEditable({ title: 'Guia', slug: 'guia' }), nativePage)
  assert.throws(() => extractNativeEditable({ slug: 'guia' }))
  assert.throws(() => extractNativeEditable({ title: 'Guia' }))
})

test('native block fields and IDs are retained, optional defaults normalize, and unsupported fields fail', () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const body = [
    { id, blockName: ' Nome ', blockType: 'heading', text: 'Título', level: null, layout: null },
    { blockType: 'rich_text', content: { root: { type: 'root', children: [] } }, layout: '' },
    { blockType: 'image', asset: '77777777-7777-4777-8777-777777777777', alt: 'Alt', caption: '' },
    { blockType: 'gallery', images: [
      { id, asset: '44444444-4444-4444-8444-444444444444', alt: 'Um', caption: null },
      { id: '55555555-5555-4555-8555-555555555555', asset: '66666666-6666-4666-8666-666666666666', alt: 'Dois' },
    ] },
    { blockType: 'video', asset: '88888888-8888-4888-8888-888888888888', title: 'Filme' },
    { blockType: 'embed', provider: 'youtube', url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', title: 'Vídeo' },
    { blockType: 'pdf', asset: '99999999-9999-4999-8999-999999999999', title: 'Manual' },
    { blockType: 'callout', tone: null, title: '', text: 'Aviso' },
    { blockType: 'link', label: 'Abrir', url: 'https://example.test', newTab: null, style: null },
    { blockType: 'divider' },
  ]
  const normalized = extractNativeEditable({ ...nativePage, body })
  assert.deepEqual(normalized.body[0], { id, blockName: ' Nome ', blockType: 'heading', text: 'Título', level: '2' })
  assert.deepEqual(normalized.body[1], { blockType: 'rich_text', content: { root: { type: 'root', children: [] } } })
  assert.deepEqual(normalized.body[2], { blockType: 'image', asset: '77777777-7777-4777-8777-777777777777', alt: 'Alt' })
  assert.deepEqual(normalized.body[3], { blockType: 'gallery', images: [
    { id, asset: '44444444-4444-4444-8444-444444444444', alt: 'Um' },
    { id: '55555555-5555-4555-8555-555555555555', asset: '66666666-6666-4666-8666-666666666666', alt: 'Dois' },
  ] })
  assert.deepEqual(normalized.body[4], { blockType: 'video', asset: '88888888-8888-4888-8888-888888888888', title: 'Filme' })
  assert.deepEqual(normalized.body[7], { blockType: 'callout', tone: 'info', text: 'Aviso' })
  assert.deepEqual(normalized.body[8], { blockType: 'link', label: 'Abrir', url: 'https://example.test', newTab: false, style: 'primary' })
  assert.throws(() => extractNativeEditable({ ...nativePage, body: [{ blockType: 'divider', mystery: true }] }))
  assert.throws(() => extractNativeEditable({ ...nativePage, body: [{ blockType: 'unknown' }] }))
})

test('native validation rejects malformed Lexical content and projected content over five MiB', () => {
  assert.throws(() => extractNativeEditable({ ...nativePage, body: [{ blockType: 'rich_text', content: { root: { children: [{ type: 'unknown' }] } } }] }))
  const tooLarge = 'x'.repeat(5 * 1024 * 1024)
  assert.throws(() => extractNativeEditable({ ...nativePage, body: [{ blockType: 'rich_text', content: { root: {
    type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: tooLarge, format: 0 }] }],
  } } }] }), /portal_page_content_too_large/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalCreationEditable, canonicalNativeEditable, creationEquivalenceHash, extractNativeEditable,
  validateNativeEditable, editableHash } from '../../src/portal-pages/editorial-native'
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
    { id: '0123456789abcdef01234567', asset: pageID, alt: 'Primeira' },
    { id: 'abcdef0123456789abcdef01', asset: '55555555-5555-4555-8555-555555555555', alt: 'Segunda' },
  ] }
  assert.notEqual(await editableHash({ ...nativePage, body: [gallery] }), await editableHash({ ...nativePage,
    body: [{ ...gallery, images: [...gallery.images].reverse() }] }))
})

test('native row IDs preserve Payload ObjectId text while relation IDs remain UUID-only', async () => {
  const blockID = '0123456789abcdef01234567'
  const galleryID = 'abcdef0123456789abcdef01'
  const editable = { ...nativePage, body: [
    { id: blockID, blockType: 'heading', text: 'Seção' },
    { blockType: 'gallery', images: [
      { id: galleryID, asset: pageID, alt: 'Imagem' },
      { id: 'fedcba9876543210fedcba98', asset: '77777777-7777-4777-8777-777777777777', alt: 'Outra' },
    ] },
  ] }
  const editableBody = editable.body as Array<Record<string, unknown>>
  const editableGallery = editableBody[1]!
  const editableImages = editableGallery.images as Array<Record<string, unknown>>
  const extracted = extractNativeEditable(editable)
  assert.deepEqual(extracted.body[0], { id: blockID, blockType: 'heading', text: 'Seção', level: '2' })
  assert.deepEqual(extracted.body[1], { blockType: 'gallery', images: [
    { id: galleryID, asset: pageID, alt: 'Imagem' },
    { id: 'fedcba9876543210fedcba98', asset: '77777777-7777-4777-8777-777777777777', alt: 'Outra' },
  ] })
  assert.match(canonicalNativeEditable(editable), new RegExp(blockID, 'u'))
  assert.match(canonicalNativeEditable(editable), new RegExp(galleryID, 'u'))
  assert.equal(await editableHash(editable), await editableHash(extracted))
  assert.notEqual(await editableHash(editable), await editableHash({ ...editable, body: [
    { ...editableBody[0]!, id: 'fedcba9876543210fedcba98' }, editableBody[1]!,
  ] }))
  assert.notEqual(await editableHash(editable), await editableHash({ ...editable, body: [editableBody[0]!, {
    ...editableGallery, images: [
      { ...editableImages[0]!, id: '00112233445566778899aabb' }, editableImages[1]!,
    ],
  }] }))

  for (const invalidID of ['33333333-3333-4333-8333-333333333333', 'ABCDEF0123456789ABCDEF01',
    'abcdef0123456789abcdef0', 'abcdef0123456789abcdef010', null, '']) {
    assert.throws(() => extractNativeEditable({ ...nativePage, body: [{ id: invalidID, blockType: 'divider' }] }),
      `invalid native row ID ${String(invalidID)}`)
    assert.throws(() => extractNativeEditable({ ...nativePage, body: [{ blockType: 'gallery', images: [
      { id: invalidID, asset: pageID, alt: 'Inválida' },
      { asset: '77777777-7777-4777-8777-777777777777', alt: 'Válida' },
    ] }] }), `invalid gallery row ID ${String(invalidID)}`)
  }
  assert.throws(() => extractNativeEditable({ ...nativePage, cover: blockID, coverAlt: 'Capa' }),
    'relationship identifiers remain UUID-only')
})

test('creation equivalence omits only server-generated row IDs and retains explicit IDs and all content', async () => {
  const submitted = { ...nativePage, body: [
    { blockType: 'heading', blockName: 'Introdução', text: 'Bem-vindo', level: '2' },
    { blockType: 'gallery', images: [
      { asset: '77777777-7777-4777-8777-777777777777', alt: 'Primeira' },
      { asset: '88888888-8888-4888-8888-888888888888', alt: 'Segunda', caption: 'Legenda' },
    ] },
  ] }
  const submittedBody = submitted.body as Array<Record<string, unknown>>
  const submittedImages = submittedBody[1]!.images as Array<Record<string, unknown>>
  const persisted = { ...submitted, body: [
    { ...submittedBody[0]!, id: '0123456789abcdef01234567' },
    { ...submittedBody[1]!, id: 'abcdef0123456789abcdef01', images: [
      { ...submittedImages[0]!, id: 'fedcba9876543210fedcba98' },
      { ...submittedImages[1]!, id: '00112233445566778899aabb' },
    ] },
  ] }
  const persistedBody = persisted.body as Array<Record<string, unknown>>
  const persistedGallery = persistedBody[1]!
  const persistedImages = persistedGallery.images as Array<Record<string, unknown>>
  assert.equal(canonicalCreationEditable(submitted, persisted), canonicalNativeEditable(submitted))
  assert.equal(await creationEquivalenceHash(submitted, persisted), await editableHash(submitted))

  const changedContent = [
    { ...persisted, title: 'Conteúdo alterado' },
    { ...persisted, body: [{ ...persistedBody[0]!, blockName: 'Outro nome' }, persistedBody[1]!] },
    { ...persisted, body: [{ ...persistedBody[0]!, text: 'Outro texto' }, persistedBody[1]!] },
    { ...persisted, body: [{ id: persistedBody[0]!.id, blockType: 'callout', tone: 'info', text: 'Bem-vindo' }, persistedBody[1]!] },
    { ...persisted, body: [persistedBody[0]!, { ...persistedGallery, images: [
      { ...persistedImages[0]!, alt: 'Alterado' }, persistedImages[1]!,
    ] }] },
  ]
  for (const actual of changedContent) {
    assert.notEqual(await creationEquivalenceHash(submitted, actual), await editableHash(submitted))
  }

  const explicit = { ...nativePage, body: [{ id: '0123456789abcdef01234567', blockType: 'divider' }] }
  const changedExplicitID = { ...explicit, body: [{ id: 'abcdef0123456789abcdef01', blockType: 'divider' }] }
  assert.equal(await creationEquivalenceHash(explicit, explicit), await editableHash(explicit))
  assert.notEqual(await creationEquivalenceHash(explicit, changedExplicitID), await editableHash(explicit))

  const explicitGallery = { ...nativePage, body: [{ blockType: 'gallery', images: [
    { id: '0123456789abcdef01234567', asset: '77777777-7777-4777-8777-777777777777', alt: 'Uma' },
    { id: 'abcdef0123456789abcdef01', asset: '88888888-8888-4888-8888-888888888888', alt: 'Duas' },
  ] }] }
  const changedExplicitGallery = { ...explicitGallery, body: [{ blockType: 'gallery', images: [
    { id: 'fedcba9876543210fedcba98', asset: '77777777-7777-4777-8777-777777777777', alt: 'Uma' },
    { id: 'abcdef0123456789abcdef01', asset: '88888888-8888-4888-8888-888888888888', alt: 'Duas' },
  ] }] }
  assert.notEqual(await creationEquivalenceHash(explicitGallery, changedExplicitGallery), await editableHash(explicitGallery))
})

test('missing optional page values normalize, but required title and slug never default', () => {
  assert.deepEqual(extractNativeEditable({ title: ' Guia ', slug: ' Guia ', categories: null, body: null }),
    { ...nativePage, title: 'Guia', slug: 'guia' })
  assert.deepEqual(validateNativeEditable({ title: 'Guia', slug: 'guia' }), nativePage)
  assert.throws(() => extractNativeEditable({ slug: 'guia' }))
  assert.throws(() => extractNativeEditable({ title: 'Guia' }))
})

test('native block fields and IDs are retained, optional defaults normalize, and unsupported fields fail', () => {
  const id = '0123456789abcdef01234567'
  const body = [
    { id, blockName: ' Nome ', blockType: 'heading', text: 'Título', level: null, layout: null },
    { blockType: 'rich_text', content: { root: { type: 'root', children: [] } }, layout: '' },
    { blockType: 'image', asset: '77777777-7777-4777-8777-777777777777', alt: 'Alt', caption: '' },
    { blockType: 'gallery', images: [
      { id: 'abcdef0123456789abcdef01', asset: '44444444-4444-4444-8444-444444444444', alt: 'Um', caption: null },
      { id: 'fedcba9876543210fedcba98', asset: '66666666-6666-4666-8666-666666666666', alt: 'Dois' },
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
    { id: 'abcdef0123456789abcdef01', asset: '44444444-4444-4444-8444-444444444444', alt: 'Um' },
    { id: 'fedcba9876543210fedcba98', asset: '66666666-6666-4666-8666-666666666666', alt: 'Dois' },
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

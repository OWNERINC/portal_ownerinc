import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import type { CollectionBeforeChangeHook, GlobalBeforeChangeHook, PayloadRequest } from 'payload'
import { lexicalToRich } from '../../src/news/lexical-to-rich'
import { legacyToPayloadBlocks } from '../../src/news/legacy-blocks'
import { legacyNewsImportContext, normalizeEditorial, normalizeNewsContent, normalizeNewsDocument, validateNewsMediaShapes, validateNewsPublication, validateNewsBeforeChange, validateNewsHomeBeforeChange } from '../../src/news/validation'
import { estimateNewsMinutes, newsText, toNewsDTO } from '../../src/news/to-dto'
import { NewsArticles } from '../../src/collections/NewsArticles'
import { NewsHome } from '../../src/globals/NewsHome'
import { createNewsMedia } from '../../src/collections/NewsMedia'
import { newsBlocks } from '../../src/news/blocks'
import { articleID, editorial, imageID, legacyBlocks, lexical, mediaShapes, pdfID, textNode } from '../fixtures/news'

const require = createRequire(import.meta.url)
const { validateBlocks } = require('../../../api/cms/blocks.js')
const { validateNewsRevision } = require('../../../api/owner-news/editorial.js')
const document = (body: unknown = [{ blockType: 'richText', content: lexical() }]) => ({
  id: articleID, title: 'Título', category: '', editorial, body, _status: 'published', publishedAt: null,
})
const runArticleHook = (data: Record<string, unknown>, originalDoc?: Record<string, unknown>) =>
  validateNewsBeforeChange({ data, originalDoc } as Parameters<CollectionBeforeChangeHook>[0])
const runHomeHook = (data: Record<string, unknown>, originalDoc?: Record<string, unknown>) =>
  validateNewsHomeBeforeChange({ data, originalDoc } as Parameters<GlobalBeforeChangeHook>[0])
const runAutosaveHook = (data: Record<string, unknown>, originalDoc: Record<string, unknown>) =>
  validateNewsBeforeChange({ data, originalDoc, operation: 'update', context: {},
    req: { query: { draft: 'true', autosave: 'true' } },
  } as unknown as Parameters<CollectionBeforeChangeHook>[0])

test('bold não vira HTML nem desaparece na projeção', () => {
  assert.deepEqual(lexicalToRich(lexical([textNode('Owner News', 1)])), [
    { type: 'paragraph', children: [{ type: 'text', text: 'Owner News', marks: ['bold'] }] },
  ])
})

test('native unchecked link omission persists with marker and projects false; supplied types and URLs stay strict', async () => {
  const link = (fields: Record<string, unknown>) => ({ type: 'link', version: 3,
    fields: { linkType: 'custom', url: 'https://example.test/reference', ...fields }, children: [textNode('Reference')] })
  for (const fields of [{}, { newTab: false }, { newTab: true }]) {
    const body = [{ blockType: 'richText', content: lexical([link(fields), textNode(' Persisted marker')]) }]
    const draft = { ...document(body), _status: 'draft' }
    assert.strictEqual(await runAutosaveHook(draft, document()), draft)
    const blocks = toNewsDTO(draft, { preview: true }).content_blocks
    assert.deepEqual(blocks, [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
      { type: 'link', url: 'https://example.test/reference', new_tab: fields.newTab === true,
        children: [{ type: 'text', text: 'Reference', marks: [] }] },
      { type: 'text', text: ' Persisted marker', marks: [] },
    ] }] }])
  }
  for (const fields of [{ newTab: null }, { newTab: undefined }, { newTab: 0 }, { newTab: 'false' },
    { newTab: {} }, { url: 'javascript:alert(1)' }, { url: 'http://example.test' },
    { url: 'https://user:pass@example.test' }, { linkType: 'internal' }]) {
    const body = [{ blockType: 'richText', content: lexical([link(fields)]) }]
    await assert.rejects(async () => runAutosaveHook({ body }, document()), /invalid_rich_text/)
  }
})

test('all eleven legacy types round-trip with the same options', () => {
  assert.deepEqual(normalizeNewsContent(legacyToPayloadBlocks(legacyBlocks)), legacyBlocks)
  assert.deepEqual(normalizeNewsContent(legacyBlocks), validateBlocks(legacyBlocks))
  for (const block of legacyBlocks) {
    const minimal = { ...block }
    for (const key of ['layout', 'typography', 'usage', 'caption', 'credit', 'attribution', 'role']) delete minimal[key]
    assert.deepEqual(normalizeNewsContent(legacyToPayloadBlocks([minimal])), [minimal])
  }
})

test('near-limit legacy list content round-trips despite larger native persistence rows (I2)', async () => {
  const item = 'é'.repeat(20) + 'x'.repeat(480)
  const blocks = Array.from({ length: 100 }, () => ({ type: 'list', ordered: false, items: Array(100).fill(item) }))
  const revision = validateNewsRevision(blocks, null)
  assert.ok(revision, 'original legacy revision validator accepts this content')
  assert.equal(Buffer.byteLength(JSON.stringify(revision)), 5234229)
  assert.deepEqual(normalizeNewsDocument({ ...document(blocks), editorial: null }).blocks, revision.blocks)
  const native = legacyToPayloadBlocks(blocks)
  assert.ok(Buffer.byteLength(JSON.stringify(native)) > 5 * 1024 * 1024)
  assert.deepEqual(normalizeNewsContent(native), revision.blocks)
  const persisted = { ...document(native), editorial: null, _status: 'draft' }
  assert.deepEqual(normalizeNewsDocument(persisted).blocks, revision.blocks)
  assert.deepEqual(await runAutosaveHook({ title: 'Updated' }, persisted), { title: 'Updated' })
  assert.deepEqual(await runArticleHook({ _status: 'published' }, persisted), { _status: 'published' })
  const tooLarge = blocks.map(block => ({ ...block, items: block.items.map(() => 'é'.repeat(21) + 'x'.repeat(479)) }))
  assert.equal(validateNewsRevision(tooLarge, null), null)
  assert.throws(() => legacyToPayloadBlocks(tooLarge), /news_content_too_large/)
})

for (const [name, unfinished, complete] of [
  ['quote', { blockType: 'quote', text: '', attribution: 'Already entered' }, { blockType: 'quote', text: 'Completed quote', attribution: 'Already entered' }],
  ['richText', { blockType: 'richText', content: null }, { blockType: 'richText', content: lexical([textNode('Completed rich text', 1)]) }],
  ['image without media/alt', { blockType: 'image', caption: 'Already entered' }, { blockType: 'image', caption: 'Already entered', media: imageID, alt: 'Alt' }],
  ['image awaiting alt', { blockType: 'image', media: imageID, alt: '' }, { blockType: 'image', media: imageID, alt: 'Alt' }],
] as const) {
  test(`native ${name} autosaves losslessly, then completes and publishes via full PATCH (I1)`, async () => {
    const prior = document()
    const body = [{ blockType: 'paragraph', text: 'Existing body.' }, { ...unfinished, id: 'native-row', blockName: 'In progress' }]
    const newDraft = { ...document(body), _status: 'draft' }
    assert.strictEqual(await validateNewsBeforeChange({ data: newDraft, operation: 'create', context: {},
      req: { query: { draft: 'true', autosave: 'true' } },
    } as unknown as Parameters<CollectionBeforeChangeHook>[0]), newDraft)
    const patch = { _status: 'draft', body }
    const before = structuredClone(patch)
    const savedPatch = await runAutosaveHook(patch, prior)
    assert.strictEqual(savedPatch, patch, 'hook retains native fields instead of saving a lossy boundary projection')
    assert.deepEqual(patch, before)
    const savedDraft = { ...prior, ...savedPatch }
    assert.deepEqual(await runAutosaveHook({ category: 'Category only' }, savedDraft), { category: 'Category only' })
    await assert.rejects(async () => runAutosaveHook({ _status: 'published' }, savedDraft))
    assert.throws(() => toNewsDTO(savedDraft, { preview: true }), 'incomplete saved draft is not a complete reading DTO')
    assert.throws(() => toNewsDTO(savedDraft, { preview: false }))
    const completedPatch = { body: [body[0], { ...complete, id: 'native-row', blockName: 'In progress' }] }
    const completedDraft = { ...savedDraft, ...await runAutosaveHook(completedPatch, savedDraft) }
    assert.deepEqual(await runArticleHook({ _status: 'published' }, completedDraft), { _status: 'published' })
    assert.equal(toNewsDTO(completedDraft, { preview: false }).content_blocks.length, 2)
  })
}

test('all native block forms may be incomplete, while legacy imports and DTOs stay strict (I1)', async () => {
  const body: Record<string, unknown>[] = newsBlocks.map(block => ({ blockType: block.slug }))
  body.push({ blockType: 'list', items: [{ id: 'row', text: '' }, { text: null }, {}] })
  const patch = { _status: 'draft', body }
  assert.deepEqual(await runAutosaveHook(patch, document()), patch)
  for (const block of [{ type: 'quote', text: '' }, { type: 'image' }, { type: 'list', items: [] }]) {
    await assert.rejects(async () => runAutosaveHook({ _status: 'draft', body: [block] }, document()))
    assert.throws(() => legacyToPayloadBlocks([block]))
  }
  const imported = { ...document([{ blockType: 'quote', text: '' }]), editorial: null, _status: 'draft' }
  await assert.rejects(async () => validateNewsBeforeChange({ data: imported, operation: 'create',
    context: legacyNewsImportContext,
  } as unknown as Parameters<CollectionBeforeChangeHook>[0]))
})

test('incomplete autosaves reject supplied malformed/unsafe fields and validate omitted PATCH state (I1)', async () => {
  const unsafeBlocks = [
    { blockType: 'quote', text: '', attribution: '<script>bad</script>' },
    { blockType: 'quote', text: '', unexpected: true }, { blockType: 'unknown' },
    { blockType: 'quote', text: {} }, { blockType: 'quote', text: '', id: {} },
    { blockType: 'quote', text: ' '.repeat(5001) },
    { blockType: 'quote', text: '', blockName: { text: 'not a label' } },
    { blockType: 'quote', text: '', blockName: '<script>bad</script>' },
    { blockType: 'quote', text: '', blockName: 'x'.repeat(201) },
    { blockType: 'image', media: 'wrong-id', alt: '' }, { blockType: 'image', media: {} },
    { blockType: 'image', alt: '<svg>bad</svg>' }, { blockType: 'image', alt: 'x'.repeat(301) },
    { blockType: 'pdf', usage: 'unknown' }, { blockType: 'quote', layout: 'unknown' },
    { blockType: 'list', items: 'bad' }, { blockType: 'list', items: [null] },
    { blockType: 'list', items: [{ text: '', html: 'bad' }] }, { blockType: 'list', items: [{ text: 'x'.repeat(501) }] },
    { blockType: 'list', items: Array.from({ length: 101 }, () => ({ text: '' })) },
    { blockType: 'heading', level: 7 }, { blockType: 'list', ordered: 'true' },
    { blockType: 'link', label: '', url: 'javascript:bad' }, { blockType: 'video', url: 'http://example.test/' },
    { blockType: 'video', media: imageID, url: 'https://example.test/' },
    { blockType: 'richText', content: {} }, { blockType: 'richText', content: '' },
    { blockType: 'richText', content: lexical([{ type: 'html', version: 1, html: 'bad' }]) },
    { blockType: 'richText', content: lexical([{ ...textNode(), style: 'color:red' }]) },
    { blockType: 'richText', content: lexical([textNode('bad mark', 4)]) },
  ]
  for (const block of unsafeBlocks) {
    await assert.rejects(async () => runAutosaveHook({ _status: 'draft', body: [block] }, document()), JSON.stringify(block))
    await assert.rejects(async () => runAutosaveHook({ title: 'Only title' }, { ...document([block]), _status: 'draft' }))
  }
  const unfinished = { ...document([{ blockType: 'quote', text: '' }]), _status: 'draft' }
  await assert.rejects(async () => runAutosaveHook({ editorial: { ...editorial, source_date: '2023-02-29' } }, unfinished), /invalid_source_date/)
  for (const block of [{ blockType: 'image', usage: 'cover' }, { blockType: 'pdf', usage: 'edition' }]) {
    await assert.rejects(async () => runAutosaveHook({ body: [block, block] }, unfinished), /duplicate_news_usage/)
  }
})

test('unfinished native fields cannot bypass aggregate byte, block or shared rich-node budgets (I1)', async () => {
  const prior = { ...document([{ blockType: 'quote', text: '' }]), _status: 'draft' }
  await assert.rejects(async () => runAutosaveHook({ body: Array.from({ length: 101 }, () => ({ blockType: 'quote' })) }, prior))
  const manyNodes = { blockType: 'richText', content: lexical(Array.from({ length: 5000 }, () => textNode(''))) }
  await assert.rejects(async () => runAutosaveHook({ body: [{ blockType: 'image' }, manyNodes, manyNodes] }, prior), /invalid_rich_text/)
  const largeRich = { blockType: 'richText', content: lexical([textNode('é'.repeat(1500000))]) }
  await assert.rejects(async () => runAutosaveHook({ body: [{ blockType: 'quote', text: '' }, largeRich, largeRich] }, prior), /news_content_too_large/)
  // A complete native draft at the exact normalized aggregate cap stays valid;
  // adding an incomplete block consumes budget even though it has no body text yet.
  const normalized = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', text: '', marks: [] }] }] }]
  const padding = 5 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ blocks: normalized, editorial }))
  const native = { blockType: 'richText', content: lexical([textNode('x'.repeat(padding))]) }
  assert.deepEqual(await runAutosaveHook({ body: [native] }, prior), { body: [native] })
  await assert.rejects(async () => runAutosaveHook({ body: [native, { blockType: 'quote', text: '' }] }, prior), /news_content_too_large/)
})

test('publication requires summary and meaningful body for native articles', () => {
  assert.throws(() => validateNewsPublication({ title: 'Título', category: '', editorial, body: [] }))
  assert.doesNotThrow(() => validateNewsPublication({ title: 'Título', category: '', editorial,
    body: [{ blockType: 'richText', content: lexical() }] }))
})

test('native optional nulls disappear without fabricating layout, typography or usage', () => {
  assert.deepEqual(normalizeNewsContent([{ blockType: 'image', media: { id: imageID, filename: 'private.png' },
    alt: 'Alt', caption: null, credit: '', usage: null, layout: null, id: 'row', blockName: null }]),
  [{ type: 'image', asset_id: imageID, alt: 'Alt' }])
  assert.throws(() => normalizeNewsContent([{ type: 'image', asset_id: imageID, alt: 'Alt', usage: null }]))
})

test('legacy allowlists, limits, URL canonicalization and exact video source count', () => {
  assert.deepEqual(normalizeNewsContent([{ type: 'video', url: ' https://example.test ', title: ' Vídeo ' }]),
    [{ type: 'video', url: 'https://example.test/', title: 'Vídeo' }])
  for (const block of [
    { type: 'video', asset_id: imageID, url: 'javascript:bad' },
    { type: 'video', url: 'https://example.test', asset_id: 'bad' },
    { type: 'video' }, { type: 'image', asset_id: 'bad', alt: 'Alt' },
    { type: 'profile', name: 'Pessoa', alt: 'Orphan' },
    { type: 'paragraph', text: '<svg>bad</svg>' }, { type: 'paragraph', text: 'onerror=bad' },
    { type: 'paragraph', text: 'a'.repeat(5001) }, { type: 'image', asset_id: imageID, alt: 'a'.repeat(301) },
    { type: 'list', items: ['x'.repeat(501)] }, { type: 'list', items: [] },
    { type: 'divider', unexpected: true }, { type: 'divider', typography: 'sans' },
    { type: 'link', label: 'Link', url: 'https://user:pass@example.test' },
    { type: 'link', label: 'Link', url: 'http://example.test' },
    { type: 'quote', text: 'Quote', attribution: '' },
  ]) assert.throws(() => normalizeNewsContent([block]), JSON.stringify(block))
  assert.equal(normalizeNewsContent(Array.from({ length: 100 }, () => ({ type: 'divider' }))).length, 100)
  assert.throws(() => normalizeNewsContent(Array.from({ length: 101 }, () => ({ type: 'divider' }))))
})

test('all supported rich nodes and combined marks preserve content without flattening', () => {
  const input = { root: { type: 'root', version: 1, children: [
    { type: 'heading', version: 1, tag: 'h1', children: [textNode('Heading')] },
    { type: 'paragraph', version: 1, direction: null, indent: 0, format: '', textFormat: 27, textStyle: '', children: [
      textNode('Bold italic underline code', 27), { type: 'linebreak', version: 1 },
      { type: 'link', version: 3, id: 'lexical-link', fields: { linkType: 'custom', newTab: true, url: 'https://example.test', doc: null }, children: [textNode('Link', 2)] },
    ] },
    ...['number', 'bullet'].map(listType => ({ type: 'list', version: 1, listType, tag: listType === 'number' ? 'ol' : 'ul', start: 1,
      children: [{ type: 'listitem', version: 1, value: 1, children: [textNode('Item')] }] })),
  ] } }
  const result = lexicalToRich(input)
  assert.deepEqual(result, [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Heading', marks: [] }] },
    { type: 'paragraph', children: [{ type: 'text', text: 'Bold italic underline code', marks: ['bold', 'italic', 'underline', 'code'] },
      { type: 'break' }, { type: 'link', url: 'https://example.test/', new_tab: true, children: [{ type: 'text', text: 'Link', marks: ['italic'] }] }] },
    { type: 'list', ordered: true, items: [[{ type: 'text', text: 'Item', marks: [] }]] },
    { type: 'list', ordered: false, items: [[{ type: 'text', text: 'Item', marks: [] }]] },
  ])
  assert.deepEqual(normalizeNewsContent([{ type: 'rich_text', nodes: result }]), [{ type: 'rich_text', nodes: result }])
  for (const level of [2, 3, 4, 5, 6]) assert.equal(lexicalToRich({ root: { type: 'root', version: 1,
    children: [{ type: 'heading', version: 1, tag: `h${level}`, children: [] }] } })[0].type, 'heading')
})

test('unsupported Lexical nodes, marks, metadata, internal links and nested lists fail closed', () => {
  for (const node of [
    { type: 'html', version: 1, html: '<b>lost</b>' }, { type: 'upload', version: 1 }, { type: 'tab', version: 1 },
    ...[4, 32, 64, -1, 1.5, 4294967296].map(format => textNode('x', format)),
    { ...textNode(), style: 'color:red' }, { ...textNode(), html: 'bad' },
    { ...textNode(), mode: 'token' }, { ...textNode(), detail: 1 }, { ...textNode(), version: 2 },
    ...['javascript:alert(1)', 'http://example.test', 'https://x:y@example.test'].map(url => ({
      type: 'link', version: 3, fields: { linkType: 'custom', newTab: false, url }, children: [textNode()] })),
    { type: 'link', version: 3, url: 'https://example.test', children: [textNode()] },
    { type: 'link', version: 3, fields: { linkType: 'internal', newTab: false, doc: { value: articleID } }, children: [textNode()] },
    { type: 'autolink', version: 1, fields: { linkType: 'custom', url: 'https://example.test', newTab: false }, children: [textNode()] },
  ]) assert.throws(() => lexicalToRich(lexical([node])), /invalid_rich_text/)
  const list = { type: 'list', version: 1, listType: 'bullet', tag: 'ul', children: [
    { type: 'listitem', version: 1, children: [{ type: 'list', version: 1, children: [] }] },
  ] }
  assert.throws(() => lexicalToRich({ root: { type: 'root', version: 1, children: [list] } }), /invalid_rich_text/)
  assert.throws(() => lexicalToRich({ root: { type: 'root', version: 1, children: [{ type: 'paragraph', version: 1, format: 'center', children: [] }] } }), /invalid_rich_text/)
})

test('projected rich allowlists, nested links and global 10000-node budget', () => {
  for (const nodes of [
    [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['strike'] }] }],
    [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['bold', 'bold'] }] }],
    [{ type: 'heading', level: 1, children: [] }],
    [{ type: 'paragraph', children: [], style: 'bad' }],
    [{ type: 'list', ordered: true, items: [[{ type: 'paragraph', children: [] }]] }],
  ]) assert.throws(() => normalizeNewsContent([{ type: 'rich_text', nodes }]), /invalid_rich_text/)
  const link = (children: unknown[]) => ({ type: 'link', version: 3,
    fields: { url: 'https://example.test', linkType: 'custom', newTab: false }, children })
  let nested: unknown = textNode()
  for (let depth = 0; depth < 5; depth++) nested = link([nested])
  assert.throws(() => lexicalToRich(lexical([nested])), /invalid_rich_text/)
  assert.equal(lexicalToRich(lexical(Array.from({ length: 9998 }, () => textNode('')))).length, 1)
  assert.throws(() => lexicalToRich(lexical(Array.from({ length: 9999 }, () => textNode('')))), /invalid_rich_text/)
  assert.throws(() => normalizeNewsContent(Array.from({ length: 2 }, () => ({
    blockType: 'richText', content: lexical(Array.from({ length: 5000 }, () => textNode(''))),
  }))), /invalid_rich_text/)
})

test('publication matrix extends legacy meaningful body semantics to rich paragraphs/lists', () => {
  for (const body of [[], [{ type: 'heading', text: 'Heading' }], [{ type: 'callout', text: 'Notice' }],
    [{ type: 'profile', name: 'Name' }], [{ blockType: 'richText', content: lexical([textNode('  ')]) }],
    [{ type: 'rich_text', nodes: [{ type: 'heading', level: 2, children: [{ type: 'text', text: 'Heading', marks: [] }] }] }],
  ]) assert.throws(() => validateNewsPublication(document(body)), /article_requires_summary_and_body/)
  for (const body of [[{ type: 'paragraph', text: 'Body' }], [{ type: 'quote', text: 'Quote' }],
    [{ type: 'profile', name: 'Name', text: 'Biography' }], [{ type: 'list', items: ['Item'] }],
    [{ type: 'rich_text', nodes: [{ type: 'list', ordered: true, items: [[{ type: 'text', text: 'Item', marks: [] }]] }] }],
  ]) assert.doesNotThrow(() => validateNewsPublication(document(body)))
  assert.throws(() => validateNewsPublication({ ...document(), editorial: { ...editorial, summary: '' } }))
  assert.throws(() => validateNewsPublication({ ...document(), editorial: { ...editorial, kind: 'edition' } }), /edition_requires_pdf/)
  assert.doesNotThrow(() => validateNewsPublication({ ...document([{ type: 'pdf', asset_id: pdfID, title: 'PDF' }]), editorial: { ...editorial, kind: 'edition', summary: '' } }))
  assert.doesNotThrow(() => normalizeNewsDocument({ ...document([]), title: '', editorial: { ...editorial, summary: '' } }))
  assert.doesNotThrow(() => validateNewsPublication({ ...document([]), editorial: null }))
  assert.throws(() => validateNewsPublication({ ...document(), editorial: undefined }))
})

test('civil dates, metadata allowlists and duplicate cover/edition validation apply to drafts too', () => {
  assert.equal(normalizeEditorial(editorial)?.source_date, '2024-02-29')
  assert.equal(normalizeEditorial({ ...editorial, source_date: null })?.source_date, null)
  for (const source_date of ['2023-02-29', '2024-02-30', '2024-04-31', '2024-01-01T00:00:00Z', '', undefined]) {
    assert.throws(() => normalizeEditorial({ ...editorial, source_date }))
  }
  for (const e of [{ ...editorial, html: 'bad' }, { ...editorial, version: 2 }, { ...editorial, author: 'a\nb' },
    { ...editorial, author: 'Name\n' }, { ...editorial, source_label: '\nSource' },
    { ...editorial, author: 'x'.repeat(201) }, { ...editorial, source_label: 'x'.repeat(201) }, { ...editorial, summary: 'x'.repeat(1001) }]) {
    assert.throws(() => normalizeEditorial(e))
  }
  for (const block of [{ type: 'image', asset_id: imageID, alt: 'Alt', usage: 'cover' },
    { type: 'pdf', asset_id: pdfID, title: 'PDF', usage: 'edition' }]) {
    assert.throws(() => normalizeNewsDocument(document([block, block])), /duplicate_news_usage/)
  }
})

test('aggregate UTF-8 budget is exactly normalized {blocks,editorial}, including metadata', () => {
  const base = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', text: '', marks: [] }] }] }]
  const overhead = Buffer.byteLength(JSON.stringify({ blocks: base, editorial }), 'utf8')
  const padding = 5 * 1024 * 1024 - overhead
  base[0].nodes[0].children[0].text = 'é'.repeat(Math.floor(padding / 2)) + (padding % 2 ? 'x' : '')
  assert.doesNotThrow(() => normalizeNewsDocument(document(base)))
  base[0].nodes[0].children[0].text += 'x'
  assert.throws(() => normalizeNewsDocument(document(base)), /news_content_too_large/)
  assert.throws(() => lexicalToRich(lexical([textNode('x'.repeat(5 * 1024 * 1024))])), /news_content_too_large/)
})

test('MIME fixtures validate shape by reference kind and 50 MiB, not live file existence', () => {
  assert.doesNotThrow(() => validateNewsMediaShapes(legacyBlocks, mediaShapes))
  assert.throws(() => validateNewsMediaShapes(legacyBlocks, mediaShapes.slice(1)), /invalid_media_reference/)
  for (const [id, mimeType] of [[imageID, 'application/pdf'], [pdfID, 'image/png']]) {
    assert.throws(() => validateNewsMediaShapes(legacyBlocks, mediaShapes.map(shape => shape.id === id ? { ...shape, mimeType } : shape)))
  }
  for (const filesize of [0, -1, 1.5, 50 * 1024 * 1024 + 1]) assert.throws(() =>
    validateNewsMediaShapes(legacyBlocks, mediaShapes.map(shape => ({ ...shape, filesize }))))
  assert.doesNotThrow(() => validateNewsMediaShapes(legacyBlocks, mediaShapes.map(shape => ({ ...shape, filesize: 50 * 1024 * 1024 }))))
  assert.throws(() => validateNewsMediaShapes([{ type: 'profile', name: 'Name', asset_id: pdfID, alt: 'Alt' }], mediaShapes))
})

test('actual collection hook validates the full PATCH, including status-only publication and explicit null', async () => {
  const draft = { ...document([]), _status: 'draft', editorial: { ...editorial, summary: '' } }
  await assert.rejects(async () => runArticleHook({ _status: 'published' }, draft), /article_requires_summary_and_body/)
  assert.deepEqual(await runArticleHook({ title: 'Updated' }, document()), { title: 'Updated' })
  await assert.rejects(async () => runArticleHook({ body: [] }, document()), /article_requires_summary_and_body/)
  await assert.rejects(async () => runArticleHook({ editorial: null }, document()), /cannot_clear_news_editorial/)
  assert.deepEqual(await runArticleHook({ title: 'Legacy' }, { ...document([]), editorial: null }), { title: 'Legacy' })
  await assert.rejects(async () => runArticleHook({ body: null }, document()))
  await assert.rejects(async () => runArticleHook({ editorial: undefined }, document()))
  assert.deepEqual(await runArticleHook({ _status: 'draft', body: [] }, document()), { _status: 'draft', body: [] })
  const args = { data: { ...document([]), editorial: null }, operation: 'create', context: {} } as unknown as Parameters<CollectionBeforeChangeHook>[0]
  await assert.rejects(async () => validateNewsBeforeChange(args), /new_article_requires_editorial/)
  await assert.rejects(async () => validateNewsBeforeChange({ ...args, context: { legacyImport: true } }), /new_article_requires_editorial/)
  const imported = await validateNewsBeforeChange({ ...args, context: legacyNewsImportContext })
  assert.equal(imported.editorial, null)
})

test('home hook uses full PATCH and preserves draft/publication constraints and text limits', async () => {
  const home = { eyebrow: 'Owner News', headline: 'Linha um\nLinha dois', summary: 'Resumo', _status: 'published' }
  assert.deepEqual(await runHomeHook({ summary: 'Resumo' }, home), { summary: 'Resumo' })
  await assert.rejects(async () => runHomeHook({ headline: '' }, home))
  await assert.rejects(async () => runHomeHook({ _status: 'published' }, { ...home, headline: '', _status: 'draft' }))
  assert.deepEqual(await runHomeHook({ headline: '', _status: 'draft' }, home), { headline: '', _status: 'draft' })
  for (const data of [{ summary: '' }, { eyebrow: '' }, { summary: 'Resumo\n' }, { eyebrow: '\nOwner News' },
    { summary: 'a\nb' }, { eyebrow: 'a\nb' }, { eyebrow: 'x'.repeat(81) },
    { eyebrow: ' '.repeat(80) + 'x' },
    { headline: 'x'.repeat(161) }, { summary: 'x'.repeat(601) }, { headline: null }]) await assert.rejects(async () => runHomeHook(data, home))
})

test('DTO is an explicit projection with flat IDs, null metadata and separate preview scope', () => {
  const legacy = { ...document(legacyToPayloadBlocks(legacyBlocks)), editorial: null,
    secret: 'internal-only', legacySourceId: null, publishedAt: '2020-01-02T03:04:05.000Z' }
  const dto = toNewsDTO(legacy, { preview: false })
  assert.deepEqual(dto, { id: articleID, title: 'Título', category: '', editorial: null,
    published_at: '2020-01-02T03:04:05.000Z', content_version: 2, asset_scope: 'owner-news',
    content_blocks: legacyBlocks, read_time_minutes: null })
  assert.equal(toNewsDTO(legacy, { preview: true }).asset_scope, 'owner-news-preview')
  assert.equal(toNewsDTO(document(), { preview: false }).read_time_minutes, 1)
  assert.throws(() => toNewsDTO({ ...legacy, id: 'invalid' }, { preview: false }))
})

test('reading time includes body text, excludes attribution/name/metadata, infers legacy PDF editions', () => {
  assert.equal(newsText(legacyBlocks), 'Título Texto de corpo. Um Dois Aviso Citação Perfil')
  assert.equal(estimateNewsMinutes(legacyBlocks, null), null)
  assert.equal(estimateNewsMinutes(legacyBlocks, editorial), 1)
  assert.equal(estimateNewsMinutes([], editorial), null)
  assert.equal(estimateNewsMinutes([{ type: 'paragraph', text: 'word '.repeat(201) }], editorial), 2)
  assert.equal(estimateNewsMinutes([{ type: 'paragraph', text: 'word '.repeat(200) }], editorial), 1)
  assert.equal(estimateNewsMinutes([{ type: 'paragraph', text: 'word' }], { ...editorial, kind: 'edition' }), null)
  assert.equal(estimateNewsMinutes([{ type: 'profile', name: 'Name', role: 'Role' }], null), null)
})

test('native configs protect CRUD/history, retain every block, drafts/autosave, and restrict media to editors', async () => {
  assert.deepEqual(new Set(newsBlocks.map(block => block.slug)), new Set(['richText', ...legacyBlocks.map(block => block.type)]))
  assert.deepEqual(NewsArticles.versions, { maxPerDoc: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } })
  assert.deepEqual(NewsHome.versions, { max: 0, drafts: { autosave: { interval: 2000 }, schedulePublish: false } })
  const req = { user: null } as PayloadRequest
  const editorReq = { user: { id: articleID, collection: 'portal-editors', portalUid: 'uid',
    portalActor: { uid: 'uid', canManageNews: true } } } as unknown as PayloadRequest
  for (const config of [NewsArticles, NewsHome]) for (const access of Object.values(config.access!)) {
    assert.equal(await access!({ req }), false)
    assert.equal(await access!({ req: editorReq }), true)
    assert.equal(await access!({ req: { ...editorReq, user: { ...editorReq.user!, portalUid: 'forged' } } }), false)
  }
  const media = createNewsMedia({ uploadDir: 'C:/synthetic-private-media' })
  for (const [operation, access] of Object.entries(media.access!)) {
    assert.equal(await access!({ req }), false)
    assert.equal(await access!({ req: editorReq }), operation !== 'update')
  }
  assert.equal(media.versions, undefined)
  for (const name of ['publishedAt', 'publicationGeneration', 'legacyDocumentId', 'legacySourceId', 'legacyRevisionId', 'importedAt']) {
    const field = NewsArticles.fields.find(field => 'name' in field && field.name === name)!
    assert.ok('access' in field)
    assert.equal(await field.access!.update!({ req: editorReq }), false)
    assert.equal(await field.access!.create!({ req: editorReq }), false)
  }
})

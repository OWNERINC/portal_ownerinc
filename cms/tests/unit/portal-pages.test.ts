import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PORTAL_PAGE_CONTENT_BYTES,
  PORTAL_PAGE_LAYOUTS,
  PORTAL_PAGE_MEDIA_MIMES,
  normalizePortalPageContent,
  normalizeSlug,
  validatePortalPageDTO,
  validatePortalPagePublicationInput,
} from '../../src/portal-pages'

const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab'
const versionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac'
const assetID = '018f47a2-7b3c-7a11-8a2c-1234567890ad'
const categoryID = '018f47a2-7b3c-7a11-8a2c-1234567890ae'
const youtubeID = 'dQw4w9WgXcQ'

const richText = (text = 'Conteúdo') => ({ type: 'rich_text', nodes: [
  { type: 'paragraph', children: [{ type: 'text', text, marks: ['bold'] }] },
] })

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: pageID,
    slug: 'Crème Brûlée / Página',
    title: ' Página modular ',
    summary: 'Uma página\npara o Portal.',
    cover: { asset_id: assetID, alt: 'Capa' },
    categories: [{ id: categoryID, slug: 'Equipe Produto', name: 'Produto' }],
    published_at: '2026-10-19T10:20:30.000Z',
    content_version: 1,
    asset_scope: 'portal-pages',
    content_blocks: [richText()],
    revision: { id: versionID, status: 'published' },
    ...overrides,
  }
}

test('slug normalization accepts Unicode sources and returns a bounded canonical ASCII slug', () => {
  assert.equal(normalizeSlug('  Crème brûlée — São João!  '), 'creme-brulee-sao-joao')
  assert.equal(normalizeSlug('Design & Produto 2026'), 'design-produto-2026')
  for (const value of ['', '   ', '東京', 'a'.repeat(161), 'a'.repeat(201), `${' '.repeat(1)}${'a'.repeat(200)}`,
    'x\ny', '<script>alert(1)</script>']) {
    assert.throws(() => normalizeSlug(value), `slug source must fail closed: ${JSON.stringify(value)}`)
  }
})

test('page title is trimmed plain Unicode text with required 1–200 character bounds', () => {
  assert.equal(validatePortalPageDTO(page()).title, 'Página modular')
  for (const title of ['', '   ', 'x'.repeat(201), 'linha 1\nlinha 2', 'controle\u0000', '<b>HTML</b>',
    '<script>alert(1)</script>', 'onerror=alert(1)', 'javascript:alert(1)']) {
    assert.throws(() => validatePortalPageDTO(page({ title })), `unsafe/invalid page title: ${JSON.stringify(title)}`)
  }
  assert.equal(validatePortalPageDTO(page({ title: 'é'.repeat(200) })).title, 'é'.repeat(200))
})

test('layout and block discriminator allowlists are exact and capped at 100 blocks', () => {
  assert.deepEqual(PORTAL_PAGE_LAYOUTS, ['content', 'wide', 'full', 'left', 'right'])
  for (const layout of PORTAL_PAGE_LAYOUTS) {
    assert.deepEqual(normalizePortalPageContent([{ type: 'divider', layout }]), [{ type: 'divider', layout }])
  }
  assert.equal(normalizePortalPageContent(Array.from({ length: 100 }, () => ({ type: 'divider' }))).length, 100)
  for (const blocks of [Array.from({ length: 101 }, () => ({ type: 'divider' })),
    [{ type: 'unknown' }], [{ type: 'divider', layout: 'unknown' }],
    [{ type: 'divider', style: 'color:red' }], [{ type: 'heading', text: 'Título', level: 2, extra: true }]]) {
    assert.throws(() => normalizePortalPageContent(blocks))
  }
  assert.throws(() => normalizePortalPageContent(new Array(1)))
})

test('heading, rich text and divider normalize only their exact public shapes', () => {
  assert.deepEqual(normalizePortalPageContent([
    { type: 'heading', text: '  Seção  ', level: 3, layout: 'wide' },
    richText('Texto seguro'), { type: 'divider' },
  ]), [
    { type: 'heading', text: 'Seção', level: 3, layout: 'wide' },
    richText('Texto seguro'), { type: 'divider' },
  ])
  for (const block of [
    { type: 'heading', text: '', level: 2 }, { type: 'heading', text: 'Título', level: 1 },
    { type: 'heading', text: 'Título', level: 2.5 }, { type: 'heading', text: 'a'.repeat(201), level: 2 },
    { type: 'heading', text: '<style>bad</style>', level: 2 },
    { type: 'rich_text', nodes: [{ type: 'paragraph', children: [], html: '<b>unsafe</b>' }] },
  ]) assert.throws(() => normalizePortalPageContent([block]))
})

test('rich text preserves paragraph, heading, list, safe marks, breaks and HTTPS links', () => {
  const nodes = [
    { type: 'paragraph', children: [
      { type: 'text', text: ' Texto ', marks: ['bold', 'italic', 'underline', 'code'] },
      { type: 'break' },
      { type: 'link', url: ' https://example.test/path ', new_tab: true,
        children: [{ type: 'text', text: 'Referência', marks: [] }] },
    ] },
    { type: 'heading', level: 6, children: [{ type: 'text', text: 'Subtítulo', marks: [] }] },
    { type: 'list', ordered: false, items: [[{ type: 'text', text: 'Item', marks: [] }]] },
  ]
  assert.deepEqual(normalizePortalPageContent([{ type: 'rich_text', nodes }]), [{ type: 'rich_text', nodes: [
    { type: 'paragraph', children: [
      { type: 'text', text: ' Texto ', marks: ['bold', 'italic', 'underline', 'code'] },
      { type: 'break' },
      { type: 'link', url: 'https://example.test/path', new_tab: true,
        children: [{ type: 'text', text: 'Referência', marks: [] }] },
    ] },
    { type: 'heading', level: 6, children: [{ type: 'text', text: 'Subtítulo', marks: [] }] },
    { type: 'list', ordered: false, items: [[{ type: 'text', text: 'Item', marks: [] }]] },
  ] }])
})

test('rich text rejects unsupported fields, nested links, unsafe text and malformed nested nodes', () => {
  const badRichValues = [
    [{ type: 'script', html: 'bad' }],
    [{ type: 'paragraph', children: [{ type: 'text', text: '<img src=x onerror=bad>', marks: [] }] }],
    [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['strike'] }] }],
    [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['bold', 'bold'] }] }],
    [{ type: 'paragraph', children: [{ type: 'link', url: 'http://example.test', new_tab: false, children: [] }] }],
    [{ type: 'paragraph', children: [{ type: 'link', url: 'https://user:pass@example.test', new_tab: false, children: [] }] }],
    [{ type: 'paragraph', children: [{ type: 'link', url: 'https://example.test', new_tab: 'yes', children: [] }] }],
    [{ type: 'heading', level: 1, children: [] }],
    [{ type: 'paragraph', children: 'not-an-array' }],
    [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: [], style: 'color:red' }] }],
    [{ type: 'paragraph', children: new Array(1) }],
    [{ type: 'list', ordered: 'false', items: [] }],
    [{ type: 'list', ordered: true, items: [[{ type: 'unknown' }]] }],
  ]
  for (const nodes of badRichValues) assert.throws(() => normalizePortalPageContent([{ type: 'rich_text', nodes }]))
})

test('rich text enforces one 10,000-node and four-level inline budget across the page', () => {
  const exact = { type: 'rich_text', nodes: [{ type: 'paragraph',
    children: Array.from({ length: 9999 }, () => ({ type: 'break' })) }] }
  assert.doesNotThrow(() => normalizePortalPageContent([exact]))
  const over = { type: 'rich_text', nodes: [{ type: 'paragraph',
    children: Array.from({ length: 10000 }, () => ({ type: 'break' })) }] }
  assert.throws(() => normalizePortalPageContent([over]))
  assert.throws(() => normalizePortalPageContent([exact, { ...exact }]))

  let nested: unknown = { type: 'text', text: 'x', marks: [] }
  for (let depth = 0; depth < 3; depth++) nested = ({ type: 'link', url: 'https://example.test',
    new_tab: false, children: [nested] })
  assert.doesNotThrow(() => normalizePortalPageContent([{ type: 'rich_text', nodes: [
    { type: 'paragraph', children: [nested] },
  ] }]))
  nested = { type: 'text', text: 'x', marks: [] }
  for (let depth = 0; depth < 4; depth++) nested = ({ type: 'link', url: 'https://example.test',
    new_tab: false, children: [nested] })
  assert.throws(() => normalizePortalPageContent([{ type: 'rich_text', nodes: [
    { type: 'paragraph', children: [nested] },
  ] }]))
})

test('normalized public content is bounded by UTF-8 JSON bytes, inclusive at exactly 5 MiB', () => {
  const base = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
    { type: 'text', text: '', marks: [] },
  ] }] }]
  const overhead = Buffer.byteLength(JSON.stringify(base), 'utf8')
  const padding = MAX_PORTAL_PAGE_CONTENT_BYTES - overhead
  base[0].nodes[0].children[0].text = 'é'.repeat(Math.floor(padding / 2)) + (padding % 2 ? 'x' : '')
  assert.equal(Buffer.byteLength(JSON.stringify(normalizePortalPageContent(base)), 'utf8'), MAX_PORTAL_PAGE_CONTENT_BYTES)
  base[0].nodes[0].children[0].text += 'x'
  assert.throws(() => normalizePortalPageContent(base))
})

test('image, gallery, video and PDF enforce UUID media, required metadata and exact nested keys', () => {
  const image = { type: 'image', asset_id: assetID, alt: '  Retrato  ', caption: 'Legenda\nem duas linhas' }
  const video = { type: 'video', asset_id: assetID, title: 'Vídeo local' }
  const pdf = { type: 'pdf', asset_id: assetID, title: 'Manual PDF' }
  const gallery = { type: 'gallery', images: [
    { asset_id: assetID, alt: 'Primeira', caption: 'Legenda 1' },
    { asset_id: versionID, alt: 'Segunda' },
  ], layout: 'wide' }
  const result = normalizePortalPageContent([image, gallery, video, pdf])
  assert.equal(result[0].type, 'image')
  assert.deepEqual(result[1], gallery)
  assert.deepEqual(result[2], video)
  assert.deepEqual(result[3], pdf)

  for (const block of [
    { type: 'image', asset_id: 'not-a-uuid', alt: 'Alt' },
    { type: 'image', asset_id: assetID, alt: '' },
    { type: 'image', asset_id: assetID, alt: 'a'.repeat(301) },
    { type: 'image', asset_id: assetID, alt: 'Alt', caption: 'c'.repeat(1001) },
    { type: 'video', asset_id: assetID, title: '' },
    { type: 'pdf', asset_id: assetID, title: '<b>PDF</b>' },
    { type: 'gallery', images: [{ asset_id: assetID, alt: 'Only one' }] },
    { type: 'gallery', images: Array.from({ length: 21 }, () => ({ asset_id: assetID, alt: 'Alt' })) },
    { type: 'gallery', images: [{ asset_id: assetID, alt: 'First', extra: true }, { asset_id: versionID, alt: 'Second' }] },
    { type: 'gallery', images: [{ asset_id: assetID, alt: '' }, { asset_id: versionID, alt: 'Second' }] },
    { type: 'gallery', images: Object.assign(new Array(2), { 0: { asset_id: assetID, alt: 'First' } }) },
  ]) assert.throws(() => normalizePortalPageContent([block]))

  const twenty = Array.from({ length: 20 }, (_, index) => ({ asset_id: assetID, alt: `Imagem ${index + 1}` }))
  assert.equal((normalizePortalPageContent([{ type: 'gallery', images: twenty }])[0] as { images: unknown[] }).images.length, 20)
})

test('YouTube and Vimeo embeds normalize supported URLs and reject unsafe/noncanonical sources', () => {
  for (const url of [
    `https://youtube.com/watch?v=${youtubeID}`,
    `https://www.youtube.com/watch?v=${youtubeID}`,
    `https://youtu.be/${youtubeID}`,
    `https://youtube.com/shorts/${youtubeID}`,
    `https://www.youtube.com/embed/${youtubeID}`,
  ]) {
    assert.deepEqual(normalizePortalPageContent([{ type: 'embed', provider: 'youtube', url, title: 'Vídeo' }]),
      [{ type: 'embed', provider: 'youtube', url: `https://www.youtube.com/embed/${youtubeID}`, title: 'Vídeo' }])
  }
  for (const url of ['https://vimeo.com/12345678', 'https://www.vimeo.com/12345678']) {
    assert.deepEqual(normalizePortalPageContent([{ type: 'embed', provider: 'vimeo', url, title: 'Vimeo' }]),
      [{ type: 'embed', provider: 'vimeo', url: 'https://player.vimeo.com/video/12345678', title: 'Vimeo' }])
  }

  for (const [provider, url] of [
    ['youtube', 'http://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://evil.test/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://youtube.com:443/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://user@youtube.com/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://youtube.com/watch?v=short'],
    ['youtube', 'https://youtube.com/watch?v=dQw4w9WgXcQ&list=playlist'],
    ['youtube', 'https://youtube.com/shorts/dQw4w9WgXcQ/extra'],
    ['youtube', 'https://youtube.com/embed/dQw4w9WgXcQ#fragment'],
    ['youtube', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['youtube', 'https://youtube.com/playlist?list=abc'],
    ['vimeo', 'https://vimeo.com/not-numeric'],
    ['vimeo', 'https://vimeo.com/12345678/extra'],
    ['vimeo', 'https://vimeo.com/12345678?autoplay=1'],
    ['vimeo', 'https://player.vimeo.com/video/12345678'],
    ['vimeo', 'https://youtube.com/watch?v=dQw4w9WgXcQ'],
  ] as const) assert.throws(() => normalizePortalPageContent([{ type: 'embed', provider, url, title: 'Vídeo' }]))
  for (const block of [
    { type: 'embed', provider: 'youtube', url: `https://youtube.com/watch?v=${youtubeID}`, title: '' },
    { type: 'embed', provider: 'youtube', url: `https://youtube.com/watch?v=${youtubeID}`, title: 'Título', extra: true },
    { type: 'embed', provider: 'unknown', url: `https://youtube.com/watch?v=${youtubeID}`, title: 'Título' },
  ]) assert.throws(() => normalizePortalPageContent([block]))
})

test('callout and link enforce exact tone/style, safe text and HTTPS destinations', () => {
  assert.deepEqual(normalizePortalPageContent([
    { type: 'callout', tone: 'warning', title: 'Atenção', text: 'Linha 1\nLinha 2' },
    { type: 'link', label: 'Acessar', url: ' https://example.test/path ', new_tab: true, style: 'primary' },
  ]), [
    { type: 'callout', tone: 'warning', title: 'Atenção', text: 'Linha 1\nLinha 2' },
    { type: 'link', label: 'Acessar', url: 'https://example.test/path', new_tab: true, style: 'primary' },
  ])
  for (const block of [
    { type: 'callout', tone: 'danger', text: 'Texto' },
    { type: 'callout', tone: 'info', text: '' },
    { type: 'callout', tone: 'info', text: 'x'.repeat(2001) },
    { type: 'callout', tone: 'info', title: 'x'.repeat(201), text: 'Texto' },
    { type: 'callout', tone: 'info', text: '<style>body{display:none}</style>' },
    { type: 'link', label: '', url: 'https://example.test', new_tab: false, style: 'primary' },
    { type: 'link', label: 'Link', url: 'http://example.test', new_tab: false, style: 'primary' },
    { type: 'link', label: 'Link', url: 'https://user:pass@example.test', new_tab: false, style: 'primary' },
    { type: 'link', label: 'Link', url: 'https://example.test', new_tab: 'false', style: 'primary' },
    { type: 'link', label: 'Link', url: 'https://example.test', new_tab: false, style: 'tertiary' },
  ]) assert.throws(() => normalizePortalPageContent([block]))
})

test('DTO boundary has exact keys and binds revision state to normal or preview asset scope', () => {
  const normalized = validatePortalPageDTO(page())
  assert.deepEqual(normalized, {
    id: pageID, slug: 'creme-brulee-pagina', title: 'Página modular', summary: 'Uma página\npara o Portal.',
    cover: { asset_id: assetID, alt: 'Capa' },
    categories: [{ id: categoryID, slug: 'equipe-produto', name: 'Produto' }],
    published_at: '2026-10-19T10:20:30.000Z', content_version: 1, asset_scope: 'portal-pages',
    content_blocks: [richText()], revision: { id: versionID, status: 'published' },
  })
  assert.deepEqual(validatePortalPageDTO(page({ asset_scope: 'portal-pages-preview',
    revision: { id: versionID, status: 'draft' } })).revision, { id: versionID, status: 'draft' })
  const vimeo = validatePortalPageDTO(page({ content_blocks: [{ type: 'embed', provider: 'vimeo',
    url: 'https://vimeo.com/12345678', title: 'Vídeo' }] }))
  assert.equal(vimeo.content_blocks[0].type, 'embed')
  assert.equal((vimeo.content_blocks[0] as Extract<(typeof vimeo.content_blocks)[number], { type: 'embed' }>).url,
    'https://player.vimeo.com/video/12345678')
  assert.deepEqual(validatePortalPageDTO(vimeo), vimeo)

  for (const invalidPage of [
    page({ extra: true }), page({ id: 'bad' }), page({ slug: '!!!' }), page({ title: 'x'.repeat(201) }),
    page({ summary: 'x'.repeat(1001) }), page({ cover: { asset_id: assetID, alt: '' } }),
    page({ cover: { asset_id: assetID, alt: 'Alt', filename: 'private.png' } }),
    page({ categories: Array.from({ length: 21 }, () => ({ id: categoryID, slug: 'slug', name: 'Name' })) }),
    page({ categories: new Array(1) }),
    page({ categories: [{ id: categoryID, slug: '!!!', name: 'Name' }] }),
    page({ published_at: 'yesterday' }), page({ content_version: 2 }),
    page({ asset_scope: 'news' }), page({ revision: { id: versionID, status: 'draft' } }),
    page({ revision: { id: versionID, status: 'scheduled' } }),
    page({ revision: { id: 'bad', status: 'published' } }),
    page({ asset_scope: 'portal-pages-preview', revision: { id: versionID, status: 'scheduled' } }),
  ]) assert.throws(() => validatePortalPageDTO(invalidPage))
})

test('publication input is a strict expected-version contract without performing a transition', () => {
  assert.deepEqual(validatePortalPagePublicationInput({ id: pageID, expected_version_id: versionID, operation: 'publish' }),
    { id: pageID, expected_version_id: versionID, operation: 'publish' })
  assert.deepEqual(validatePortalPagePublicationInput({ id: pageID, expected_version_id: versionID, operation: 'unpublish' }),
    { id: pageID, expected_version_id: versionID, operation: 'unpublish' })
  for (const input of [
    { id: 'bad', expected_version_id: versionID, operation: 'publish' },
    { id: pageID, expected_version_id: 'bad', operation: 'publish' },
    { id: pageID, expected_version_id: versionID, operation: 'delete' },
    { id: pageID, expected_version_id: versionID, operation: 'publish', force: true },
  ]) assert.throws(() => validatePortalPagePublicationInput(input))
})

test('Portal Page public media MIME allowlist excludes QuickTime/MOV', () => {
  assert.deepEqual(PORTAL_PAGE_MEDIA_MIMES, [
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm',
  ])
  assert.equal(PORTAL_PAGE_MEDIA_MIMES.includes('video/quicktime' as never), false)
})

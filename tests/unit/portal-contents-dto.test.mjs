import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import {
  ASSET_ID, PAGE_ID, REVISION_ID, blockFixtures, categoryFixtures, clone, layoutCases, pageFixture, richBlockFixtures,
} from '../helpers/portal-contents-fixtures.mjs';

const require = createRequire(import.meta.url);
const apiDTO = require('../../api/portal-pages/payload-dto.js');
const sourcePath = new URL('../../public/js/portal-contents/dto.js', import.meta.url);

async function loadBrowserDTO() {
  let source;
  try { source = await readFile(sourcePath, 'utf8'); } catch { return null; }
  const context = vm.createContext({ TextEncoder, URL, Date, Number, Set, Map, Object, Array, String, RegExp, Error });
  const body = source.replace(/^export\s+/gmu, '');
  vm.runInContext(`${body}\nglobalThis.dto = { validatePortalPageDTO, validateDetail, validateList, validateCategories, isCanonicalSlug, PAGE_SIZE, MAX_OFFSET, MAX_TOTAL, MAX_BLOCKS, MAX_NODES, MAX_CONTENT_BYTES, MAX_DETAIL_BYTES, MAX_COLLECTION_BYTES, LAYOUTS };`, context, { filename: 'dto.js' });
  return context.dto;
}

const browser = await loadBrowserDTO();
const invalid = predicate => assert.throws(predicate, error => error?.code === 'invalid_contents' && error.message === 'Conteúdo inválido.');
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('browser validator exports the fixed public contract and rejects without normalizing wire values', () => {
  assert.ok(browser, 'browser DTO module must exist');
  assert.deepEqual({
    PAGE_SIZE: browser.PAGE_SIZE, MAX_OFFSET: browser.MAX_OFFSET, MAX_TOTAL: browser.MAX_TOTAL,
    MAX_BLOCKS: browser.MAX_BLOCKS, MAX_NODES: browser.MAX_NODES, MAX_CONTENT_BYTES: browser.MAX_CONTENT_BYTES,
    MAX_DETAIL_BYTES: browser.MAX_DETAIL_BYTES, MAX_COLLECTION_BYTES: browser.MAX_COLLECTION_BYTES,
    LAYOUTS: Array.from(browser.LAYOUTS),
  }, { PAGE_SIZE: 12, MAX_OFFSET: 1000000, MAX_TOTAL: 100000, MAX_BLOCKS: 100, MAX_NODES: 10000,
    MAX_CONTENT_BYTES: 5 * 1024 * 1024, MAX_DETAIL_BYTES: 6 * 1024 * 1024,
    MAX_COLLECTION_BYTES: 16 * 1024 * 1024, LAYOUTS: ['content', 'wide', 'full', 'left', 'right'] });
  const dto = pageFixture();
  assert.equal(browser.validatePortalPageDTO(dto), dto);
  assert.equal(browser.validateDetail(dto, dto.slug), dto);
  assert.equal(browser.isCanonicalSlug('a-b-2'), true);
  assert.equal(browser.isCanonicalSlug('A-B'), false);
  invalid(() => browser.validateDetail(dto, 'another-slug'));
});

test('browser and API validators agree on all block/layout pairs and complete pages', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const cases = layoutCases();
  for (const [index, dto] of cases.entries()) {
    assert.equal(browser.validatePortalPageDTO(dto), dto, `browser case ${index}`);
    assert.equal(apiDTO.validatePortalPageDTO(dto, 'portal-pages'), dto, `API case ${index}`);
  }
  for (const layout of [undefined, 'content', 'wide', 'full', 'left', 'right']) {
    const content_blocks = blockFixtures().map(block => layout === undefined ? block : { ...block, layout });
    const dto = pageFixture({ content_blocks });
    browser.validatePortalPageDTO(dto);
    apiDTO.validatePortalPageDTO(dto, 'portal-pages');
  }
  const extended = pageFixture({ content_blocks: richBlockFixtures(), categories: categoryFixtures(20),
    cover: { asset_id: ASSET_ID, alt: 'Capa' }, published_at: null });
  browser.validatePortalPageDTO(extended);
  apiDTO.validatePortalPageDTO(extended, 'portal-pages');
});

test('strict validators accept CMS normalization outputs but reject noncanonical authoring input', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const authoringFixtures = layoutCases();
  for (const layout of [undefined, 'content', 'wide', 'full', 'left', 'right']) {
    authoringFixtures.push(pageFixture({ content_blocks: blockFixtures().map(block => layout === undefined ? block : { ...block, layout }) }));
  }
  const rawAuthoring = pageFixture({ title: '  Título não canônico  ', summary: '  Resumo preservado após trim  ',
    content_blocks: [{ type: 'embed', provider: 'youtube', url: 'https://www.youtube.com/watch?v=Abc123_-xyz', title: '  Vídeo  ' }] });
  authoringFixtures.push(rawAuthoring);
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {readFileSync} from 'node:fs'; import {validatePortalPageDTO} from './src/portal-pages/validation.ts'; process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(validatePortalPageDTO)));"],
  { cwd: fileURLToPath(new URL('../../cms/', import.meta.url)), input: JSON.stringify(authoringFixtures), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.equal(normalized.length, authoringFixtures.length);
  for (const dto of normalized) {
    browser.validatePortalPageDTO(dto);
    apiDTO.validatePortalPageDTO(dto, 'portal-pages');
  }
  assert.equal(normalized.at(-1).title, 'Título não canônico');
  assert.equal(normalized.at(-1).content_blocks[0].url, 'https://www.youtube.com/embed/Abc123_-xyz');
  invalid(() => browser.validatePortalPageDTO(rawAuthoring));
  assert.throws(() => apiDTO.validatePortalPageDTO(rawAuthoring, 'portal-pages'));
});

test('strict page, block, category, rich-text, provider, Unicode and prototype rejection matrix', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const bad = [];
  const mutate = fn => { const value = pageFixture(); fn(value); bad.push(value); };
  mutate(value => { value.extra = true; });
  mutate(value => { value.revision.extra = true; });
  mutate(value => { value.cover = { asset_id: ASSET_ID, alt: 'Capa', url: 'https://example.test' }; });
  mutate(value => { value.categories = [{ ...categoryFixtures(1)[0], relationTo: 'categories' }]; });
  mutate(value => { value.content_blocks = [{ type: 'heading', text: 'x', level: 2, style: 'red' }]; });
  mutate(value => { value.content_blocks = [{ type: 'image', asset_id: ASSET_ID, alt: 'Imagem', storageKey: 'private' }]; });
  mutate(value => { value.content_blocks = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [], html: '<b>x</b>' }] }]; });
  mutate(value => { value.content_blocks = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', text: '<img src=x>', marks: [] }] }] }]; });
  mutate(value => { value.content_blocks = [{ type: 'embed', provider: 'youtube', url: 'https://evil.youtube.com/embed/Abc123_-xyz', title: 'x' }]; });
  mutate(value => { value.content_blocks = [{ type: 'embed', provider: 'youtube', url: 'https://www.youtube.com/embed/Abc123_-xyz?x=1', title: 'x' }]; });
  mutate(value => { value.content_blocks = [{ type: 'embed', provider: 'vimeo', url: 'https://player.vimeo.com.evil.test/video/123', title: 'x' }]; });
  mutate(value => { value.content_blocks = [{ type: 'link', label: 'x', url: 'javascript:alert(1)', new_tab: false, style: 'primary' }]; });
  mutate(value => { value.content_blocks = [{ type: 'link', label: 'x', url: 'https://user:pass@example.test', new_tab: false, style: 'primary' }]; });
  mutate(value => { value.content_blocks = [{ type: 'link', label: 'x', url: 'https://example.test\\evil', new_tab: false, style: 'primary' }]; });
  mutate(value => { value.content_blocks = [{ type: 'gallery', images: [1, 2].map(() => ({ asset_id: ASSET_ID, alt: 'x', style: 'x' })) }]; });
  mutate(value => { value.content_blocks = [{ type: 'callout', tone: 'alert', text: 'x' }]; });
  mutate(value => { value.content_blocks = [{ type: 'divider', srcdoc: '<script>' }]; });
  mutate(value => { value.content_blocks = [{ type: 'heading', text: 'x', level: 2, layout: 'unknown' }]; });
  mutate(value => { value.content_blocks = [{ type: 'heading', text: '  x', level: 2 }]; });
  mutate(value => { value.title = '  title'; });
  mutate(value => { value.title = '<script>x</script>'; });
  mutate(value => { value.summary = 'x\u0000'; });
  mutate(value => { value.content_version = '1'; });
  mutate(value => { value.asset_scope = 'portal-pages-preview'; });
  mutate(value => { value.revision.status = 'draft'; });
  mutate(value => { value.id = 'not-a-uuid'; });
  mutate(value => { value.slug = 'Not canonical'; });
  mutate(value => { value.published_at = '2026-10-20T12:00:00Z'; });
  mutate(value => { value.published_at = '2026-02-30T00:00:00.000Z'; });
  mutate(value => { value.categories = categoryFixtures(21); });
  mutate(value => { value.categories[0] = { id: PAGE_ID, slug: 'foo', name: 'x', description: 'unknown' }; });
  mutate(value => { value.content_blocks = Array.from({ length: 101 }, () => ({ type: 'divider' })); });
  mutate(value => { value.content_blocks = [{ type: 'gallery', images: Array.from({ length: 21 }, () => ({ asset_id: ASSET_ID, alt: 'x' })) }]; });
  mutate(value => { value.content_blocks = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['bold', 'bold'] }] }] }]; });
  mutate(value => { value.content_blocks = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['unknown'] }] }] }]; });
  mutate(value => { value.content_blocks = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'link', url: 'https://example.test', new_tab: false, children: [{ type: 'link', url: 'https://example.test', new_tab: false, children: [] }] }] }] }]; });
  mutate(value => { value.content_blocks = [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'link', url: 'https://example.test', new_tab: false, children: [{ type: 'text', text: 'x\n', marks: [] }] }] }] }]; });
  for (const value of bad) invalid(() => browser.validatePortalPageDTO(value));
  const ownProto = JSON.parse('{"id":"' + PAGE_ID + '","slug":"published-policy","title":"x","summary":"","cover":null,"categories":[],"published_at":null,"content_version":1,"asset_scope":"portal-pages","content_blocks":[],"revision":{"id":"' + REVISION_ID + '","status":"published"},"__proto__":{"polluted":true}}');
  invalid(() => browser.validatePortalPageDTO(ownProto));
  const inherited = Object.create(pageFixture());
  invalid(() => browser.validatePortalPageDTO(inherited));
  assert.equal({}.polluted, undefined);
});

test('field limits use Unicode code points, accept case-insensitive UUID syntax and reject all over-limits', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const uppercase = pageFixture({ id: PAGE_ID.toUpperCase(), revision: { id: REVISION_ID.toUpperCase(), status: 'published' } });
  assert.equal(browser.validatePortalPageDTO(uppercase), uppercase, 'reader does not lowercase a wire UUID');
  const limits = [
    pageFixture({ title: '😀'.repeat(200) }),
    pageFixture({ title: 'x'.repeat(201) }),
    pageFixture({ content_blocks: [{ type: 'heading', text: '😀'.repeat(200), level: 2 }] }),
    pageFixture({ content_blocks: [{ type: 'heading', text: 'x'.repeat(201), level: 2 }] }),
    pageFixture({ content_blocks: [{ type: 'image', asset_id: ASSET_ID, alt: 'x'.repeat(300), caption: `${'x\n'.repeat(499)}xx` }] }),
    pageFixture({ content_blocks: [{ type: 'image', asset_id: ASSET_ID, alt: 'x'.repeat(301) }] }),
    pageFixture({ content_blocks: [{ type: 'callout', tone: 'info', text: 'x'.repeat(2000), title: 'x'.repeat(200) }] }),
    pageFixture({ content_blocks: [{ type: 'callout', tone: 'info', text: 'x'.repeat(2001) }] }),
  ];
  browser.validatePortalPageDTO(limits[0]);
  browser.validatePortalPageDTO(limits[2]);
  browser.validatePortalPageDTO(limits[4]);
  browser.validatePortalPageDTO(limits[6]);
  invalid(() => browser.validatePortalPageDTO(limits[1]));
  invalid(() => browser.validatePortalPageDTO(limits[3]));
  invalid(() => browser.validatePortalPageDTO(limits[5]));
  invalid(() => browser.validatePortalPageDTO(limits[7]));
});

test('strict browser matrix covers single-line controls, URL hazards, and the combined rich-node budget', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const invalidPage = content_blocks => pageFixture({ content_blocks });
  const unsafeLinks = [
    'http://example.test/path', 'javascript:alert(1)', 'https://user@example.test/',
    'https://example.test/a b', 'https://example.test/a\\b', 'https://example.test/a\u0001b',
  ];
  for (const url of unsafeLinks) invalid(() => browser.validatePortalPageDTO(invalidPage([
    { type: 'link', label: 'Link', url, new_tab: false, style: 'secondary' },
  ])));
  invalid(() => browser.validatePortalPageDTO(invalidPage([{ type: 'heading', text: 'line\nbreak', level: 2 }])));
  invalid(() => browser.validatePortalPageDTO(invalidPage([{ type: 'heading', text: 'delete\u007f', level: 2 }])));
  invalid(() => browser.validatePortalPageDTO(invalidPage([{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
    { type: 'text', text: 'not\nstructural', marks: [] },
  ] }] }])));

  const inline = () => ({ type: 'text', text: 'x', marks: [] });
  const exactNodes = invalidPage([{ type: 'rich_text', nodes: [{ type: 'paragraph', children: Array.from({ length: 9998 }, inline) }] }]);
  browser.validatePortalPageDTO(exactNodes); // block + rich node + 9,998 inline nodes = 10,000
  const tooManyNodes = invalidPage([{ type: 'rich_text', nodes: [{ type: 'paragraph', children: Array.from({ length: 9999 }, inline) }] }]);
  invalid(() => browser.validatePortalPageDTO(tooManyNodes));
});

test('browser, API, and CMS accept 2048-unit HTTPS links and reject 2049 in both link forms', () => {
  const prefix = 'https://example.test/';
  const maxURL = `${prefix}${'a'.repeat(2048 - prefix.length)}`;
  const overURL = `${maxURL}a`;
  assert.equal(maxURL.length, 2048);
  for (const content_blocks of [
    [{ type: 'link', label: 'Link', url: maxURL, new_tab: false, style: 'primary' }],
    [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
      { type: 'link', url: maxURL, new_tab: false, children: [{ type: 'text', text: 'Link', marks: [] }] },
    ] }] }],
  ]) {
    const dto = pageFixture({ content_blocks });
    browser.validatePortalPageDTO(dto);
    apiDTO.validatePortalPageDTO(dto, 'portal-pages');
  }
  for (const url of [overURL, 'https://user:pass@example.test', 'http://example.test']) {
    const blockForms = [
      [{ type: 'link', label: 'Link', url, new_tab: false, style: 'primary' }],
      [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
        { type: 'link', url, new_tab: false, children: [{ type: 'text', text: 'Link', marks: [] }] },
      ] }] }],
    ];
    for (const content_blocks of blockForms) {
      const dto = pageFixture({ content_blocks });
      invalid(() => browser.validatePortalPageDTO(dto));
      assert.throws(() => apiDTO.validatePortalPageDTO(dto, 'portal-pages'));
    }
  }
});

function contentBoundaryDTO(targetBytes) {
  const dto = pageFixture({ content_blocks: [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
    { type: 'text', text: '', marks: [] },
  ] }] }] });
  const block = dto.content_blocks;
  const base = bytes(block);
  block[0].nodes[0].children[0].text = 'x'.repeat(targetBytes - base);
  assert.equal(bytes(block), targetBytes);
  return dto;
}

test('content and aggregate collection serialization enforce exact independent byte caps', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const exact = contentBoundaryDTO(5 * 1024 * 1024);
  browser.validatePortalPageDTO(exact);
  const tooLarge = contentBoundaryDTO(5 * 1024 * 1024 + 1);
  invalid(() => browser.validatePortalPageDTO(tooLarge));

  const rows = Array.from({ length: 4 }, (_, index) => {
    const row = pageFixture({ content_blocks: [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [
      { type: 'text', text: '', marks: [] },
    ] }] }] });
    row.id = `018f47a2-7b3c-7a11-8a2c-${String(index + 1).padStart(12, '0')}`;
    row.slug = `page-${index + 1}`;
    return row;
  });
  const collectionTarget = 16 * 1024 * 1024;
  const baseline = bytes({ rows, count: 4 });
  const remainder = collectionTarget - baseline;
  const each = Math.floor(remainder / rows.length);
  rows.forEach((row, index) => {
    row.content_blocks[0].nodes[0].children[0].text = 'x'.repeat(each + (index === 0 ? remainder % rows.length : 0));
  });
  assert.equal(bytes({ rows, count: 4 }), collectionTarget);
  assert.ok(rows.every(row => bytes(row.content_blocks) <= 5 * 1024 * 1024));
  browser.validateList(rows, 4, 4);
  rows[0].content_blocks[0].nodes[0].children[0].text += 'x';
  invalid(() => browser.validateList(rows, 4, 4));
});

test('list and categories reject duplicate IDs/slug, invalid totals, oversize and preserve the public result shape', () => {
  assert.ok(browser, 'browser DTO module must exist');
  const row = pageFixture();
  const listResult = browser.validateList([row], 1, 12);
  assert.equal(listResult.data[0], row);
  assert.equal(listResult.total, 1);
  for (const [data, total, limit] of [
    [[row, clone(row)], 2, 12], [[row], 0, 12], [[row], 100001, 12], [[row, clone(row)], 2, 1],
    [[row], 1.5, 12], [[row], Number.MAX_SAFE_INTEGER + 1, 12],
  ]) invalid(() => browser.validateList(data, total, limit));
  const cats = categoryFixtures(2).map((value, index) => ({ ...value, count: index + 1 }));
  assert.equal(browser.validateCategories(cats), cats);
  invalid(() => browser.validateCategories([{ ...cats[0], extra: true }]));
  invalid(() => browser.validateCategories([cats[0], { ...cats[1], id: cats[0].id }]));
  invalid(() => browser.validateCategories([cats[0], { ...cats[1], slug: cats[0].slug }]));
  invalid(() => browser.validateCategories([{ ...cats[0], count: 0 }]));
  invalid(() => browser.validateCategories(Array.from({ length: 10001 }, (_, index) => ({
    id: `018f47a2-7b3c-7a11-8a2c-${String(index + 1).padStart(12, '0')}`, slug: `category-${index + 1}`, name: 'C', count: 1,
  }))));
});

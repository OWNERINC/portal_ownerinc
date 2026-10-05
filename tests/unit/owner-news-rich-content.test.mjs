import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';

const asset = '11111111-1111-4111-8111-111111111111';
const text = (text, marks = []) => ({ type: 'text', text, marks });
const rich = { type: 'rich_text', nodes: [
  { type: 'heading', level: 2, children: [text('Seção')] },
  { type: 'paragraph', children: [text('Seguro ', ['bold', 'italic', 'underline', 'code']),
    { type: 'link', url: 'https://example.test/news', new_tab: true, children: [text('Link')] },
    { type: 'break' }, text('<img src=x onerror=alert(1)>')] },
  { type: 'list', ordered: true, items: [[text('Um')], [text('Dois', ['bold'])]] },
] };
const modules = [
  { path: 'public/js/cms-block-renderer.js', exports: 'renderBlocks, cleanupRenderedBlocks, validateBlocks' },
  { path: 'public/js/owner-news/content-contract.js', exports: 'validateNewsBlocks, newsBlocksToText' },
  { path: 'public/js/owner-news/rich-content.js', exports: 'renderRichContent' },
  { path: 'public/js/owner-news/model.js', exports: 'getNewsPresentation, normalizeEditorial, estimateNewsReadTime' },
  { path: 'public/js/owner-news/reader-view.js', exports: 'renderNewsArticle' },
  { path: 'public/js/owner-news/catalog.js', exports: 'renderNewsCard' },
];
async function setup() {
  const h = await createFeedbackHarness('announcements', { mount: false, modules });
  const root = h.doc.createElement('article'); h.doc.body.append(root);
  return { h, root };
}
test('media URLs use only a closed scope and UUID', async () => {
  const { cmsAssetEndpoint } = await import('../../public/js/owner-news/asset-path.mjs');
  assert.equal(cmsAssetEndpoint(asset), `/api/cms/assets/${asset}`);
  assert.equal(cmsAssetEndpoint(asset.toUpperCase(), 'owner-news'), `/api/announcements/assets/${asset}`);
  assert.equal(cmsAssetEndpoint(asset, 'owner-news-preview'), `/api/announcements/preview/assets/${asset}`);
  for (const scope of ['https://outside.example', '__proto__', {}, null]) assert.throws(() => cmsAssetEndpoint(asset, scope), /asset_scope/);
  for (const id of ['../secret', `${asset}?token=x`, {}, null]) assert.throws(() => cmsAssetEndpoint(id), /asset_id/);
});
test('rich DOM preserves marks, safe links, lists, text-only XSS and mixed order', async () => {
  const { h, root } = await setup();
  h.context.renderNewsArticle(root, { title: 'Título', content_version: 2, asset_scope: 'owner-news', content_blocks: [
    { type: 'paragraph', text: 'Antes.' }, rich, { type: 'quote', text: 'Depois.' },
  ] }, { signal: h.page.signal });
  assert.equal(root.querySelectorAll('h1').length, 1);
  assert.equal(root.querySelector('h2').textContent, 'Seção');
  assert.ok(root.querySelector('strong em u code'));
  assert.equal(root.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(root.querySelector('a').getAttribute('href'), 'https://example.test/news');
  assert.equal(root.querySelectorAll('ol li').length, 2);
  assert.equal(root.querySelectorAll('br').length, 1);
  assert.equal(root.querySelector('img'), null);
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(root.querySelector('.news-article-body').textContent, /Antes\..*Seção.*Depois\./s);
  assert.match(h.context.newsBlocksToText([rich]), /Seguro Link\n<img/);
  assert.equal(h.context.estimateNewsReadTime([{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [text('palavra '.repeat(201))] }] }]), 2);
  assert.equal(h.context.estimateNewsReadTime([{ type: 'pdf', asset_id: asset, title: 'PDF' }], null), null);
  h.page.dispose(); assert.equal(root.children.length, 0);
});
test('unknown or malformed rich trees reject the whole body before DOM/media, not just the bad node', async () => {
  const { h, root } = await setup();
  const invalid = [
    { type: 'html', html: '<script>x</script>' },
    { type: 'heading', level: 1, children: [text('Bad')] },
    { type: 'paragraph', children: [text('Bad', ['style'])] },
    { type: 'paragraph', children: [text('Bad', ['bold', 'bold'])] },
    { type: 'paragraph', children: [{ type: 'text', text: 'Bad' }] },
    { type: 'paragraph', children: [{ type: 'break', style: 'red' }] },
    ...['javascript:alert(1)', 'http://example.test', 'https://user:pass@example.test'].map(url => ({ type: 'paragraph', children: [{ type: 'link', url, new_tab: true, children: [text('Bad')] }] })),
    { type: 'paragraph', children: [{ type: 'link', url: 'https://example.test', new_tab: true, children: [{ type: 'link', url: 'https://example.test', new_tab: false, children: [] }] }] },
  ];
  for (const node of invalid) {
    const blocks = [{ type: 'image', asset_id: asset, alt: 'Capa' }, rich, { type: 'rich_text', nodes: [node] }];
    assert.equal(h.context.validateNewsBlocks(blocks, 2), null);
    root.textContent = 'Original';
    assert.throws(() => h.context.renderRichContent(root, [rich.nodes[0], node]), /invalid_rich_text/);
    assert.equal(root.textContent, 'Original');
    const dispose = h.context.renderNewsArticle(root, { title: 'Inválido', content_version: 2, content_blocks: blocks });
    assert.equal(root.querySelector('.news-article-body'), null);
    assert.match(root.textContent, /Conteúdo indisponível/);
    dispose();
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.context.validateNewsBlocks([rich]), null);
  assert.equal(h.context.validateNewsBlocks([rich], 3), null);
  assert.equal(h.context.validateBlocks([rich]), null, 'shared renderer stays legacy-only');
  assert.equal(h.context.validateNewsBlocks(Array(101).fill(rich), 2), null);
  assert.equal(h.context.validateNewsBlocks([{ type: 'rich_text', nodes: [{ type: 'paragraph', children: Array(10000).fill(text('x')) }] }], 2), null);
  assert.equal(h.context.validateNewsBlocks([{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [text('x'.repeat(5 * 1024 * 1024))] }] }], 2), null);
  h.page.dispose();
});
test('every article media type and catalog cover uses scope; retries and late blobs remain local', async () => {
  const { h, root } = await setup();
  const blocks = [{ type: 'image', asset_id: asset, alt: 'Capa', usage: 'cover' }, rich,
    { type: 'profile', name: 'Pessoa', asset_id: asset, alt: 'Retrato' },
    { type: 'video', asset_id: asset }, { type: 'image', asset_id: asset, alt: 'Inline' },
    { type: 'pdf', asset_id: asset, title: 'Arquivo' }, { type: 'pdf', asset_id: asset, title: 'Edição', usage: 'edition' }];
  const story = { title: 'Mídias', content_version: 2, asset_scope: 'owner-news-preview', content_blocks: blocks };
  h.context.renderNewsArticle(root, story, { signal: h.page.signal });
  root.querySelector('details').open = true; root.querySelector('details').dispatchEvent(new TestEvent('toggle'));
  assert.equal(h.requests.length, 6);
  assert.ok(h.requests.every(r => r.path === `/api/announcements/preview/assets/${asset}`));
  h.requests[0].reject(Object.assign(new Error('forbidden'), { status: 403 })); await drain();
  const body = root.querySelector('.news-article-body');
  root.querySelector('.cms-asset-error button').click();
  assert.equal(root.querySelector('.news-article-body'), body);
  const card = h.context.renderNewsCard({ ...story, asset_scope: 'owner-news' }, { signal: h.page.signal });
  h.doc.body.append(card.node);
  assert.equal(h.requests.at(-1).path, `/api/announcements/assets/${asset}`);
  h.page.dispose();
  for (const [i, request] of h.requests.slice(1).entries()) request.resolve(`blob:late-${i}`);
  await drain(); assert.equal(h.revoked.length, h.requests.length - 1);
  assert.ok(h.requests.every(r => r.options.signal.aborted));
  assert.throws(() => h.context.renderBlocks(root, blocks, { assetScope: 'https://outside.test' }), /asset_scope/);
});

test('Dashboard hero and all cards use published media scope, rich fallback and dispose late assets', async () => {
  const h = await createFeedbackHarness('dashboard');
  h.latest('/api/announcements?').resolve([{ id: asset, title: 'Destaque', content_version: 2, asset_scope: 'owner-news', content_blocks: [
    { type: 'image', asset_id: asset, alt: 'Capa', usage: 'cover' }, rich,
  ] }]);
  await drain();
  const media = h.requests.filter(r => r.kind === 'asset');
  assert.equal(media.length, 2);
  assert.ok(media.every(r => r.path === `/api/announcements/assets/${asset}`));
  assert.match(h.node('dashboard-hero-description').textContent, /Seguro Link/);
  h.page.dispose(); media.forEach((r, i) => r.resolve(`blob:dashboard-${i}`)); await drain();
  assert.ok(media.every(r => r.options.signal.aborted));
  assert.ok(h.revoked.includes('blob:dashboard-0')); assert.ok(h.revoked.includes('blob:dashboard-1'));
});

test('all eleven legacy blocks retain validation and DOM behavior in v1 and mixed v2', async () => {
  const blocks = [{ type: 'heading', text: 'Heading', level: 1 }, { type: 'paragraph', text: 'Paragraph' },
    { type: 'list', items: ['Item'], ordered: false }, { type: 'callout', title: 'Notice', text: 'Callout', tone: 'info' },
    { type: 'image', asset_id: asset, alt: 'Cover' }, { type: 'divider' },
    { type: 'link', label: 'Link', url: 'https://example.test/', new_tab: true }, { type: 'pdf', asset_id: asset, title: 'PDF' },
    { type: 'video', asset_id: asset, title: 'Video' }, { type: 'quote', text: 'Quote', attribution: 'Author' },
    { type: 'profile', name: 'Person', text: 'Profile', asset_id: asset, alt: 'Portrait' }];
  for (const version of [1, 2]) {
    const { h, root } = await setup();
    assert.equal(JSON.stringify(h.context.validateNewsBlocks(blocks, version)), JSON.stringify(h.context.validateBlocks(blocks)));
    h.context.renderNewsArticle(root, { title: 'Legacy', content_version: version, content_blocks: blocks }, { signal: h.page.signal });
    for (const [selector, count] of [['h1', 1], ['h2', 1], ['ul li', 1], ['.cms-callout', 1], ['img', 2], ['hr', 1],
      ['.cms-link', 1], ['.cms-pdf-frame', 1], ['video', 1], ['blockquote', 1], ['.cms-profile', 1]]) assert.equal(root.querySelectorAll(selector).length, count, `${version}: ${selector}`);
    assert.equal(h.requests.length, 4); assert.ok(h.requests.every(r => r.path === `/api/cms/assets/${asset}`));
    h.page.dispose();
  }
});

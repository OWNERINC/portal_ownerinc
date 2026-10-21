import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContentsHarness } from '../helpers/portal-contents-harness.mjs';
import { ASSET_ID, blockFixtures, clone, pageFixture } from '../helpers/portal-contents-fixtures.mjs';

function emptyRoot(h) {
  const root = h.document.createElement('section');
  h.document.body.append(root);
  return root;
}

test('ordinary reader renders safe semantic content and returns inert media descriptors only', async () => {
  const h = await createContentsHarness();
  const root = emptyRoot(h);
  const view = h.modules.reader.renderReader(root, pageFixture(), { returnHref: '/contents.html?page=2' }, {
    signal: new AbortController().signal, isCurrent: () => true, onReload() {},
  });
  assert.equal(root.querySelectorAll('h1').length, 1, 'the title is the only h1 in an isolated reader root');
  assert.equal(root.querySelectorAll('iframe[src], img[src], video[src], object').length, 0);
  assert.equal(root.querySelectorAll('dialog').length, 0);
  assert.equal(view.media.length, 5, 'image, gallery, video, PDF and embed are described, never activated');
  assert.deepEqual([...view.media.map(item => item.kind)], ['image', 'gallery', 'video', 'pdf', 'embed']);
  assert.equal(view.media.every(item => item.dto === view.media[0].dto), true);
  assert.equal(view.media[0].host.getAttribute('aria-label'), 'Imagem: Diagrama do processo');
  assert.equal(view.media[0].caption, 'Fluxo\ncompleto');
  assert.equal(view.media[1].blockIndex, 3);
  assert.equal(view.media[1].images.length, 2);
  assert.equal(view.media[4].url, 'https://www.youtube.com/embed/Abc123_-xyz');
  assert.equal(root.querySelectorAll('h2').length, 2, 'block heading and optional callout title are semantic second-level headings');
  assert.equal(root.querySelectorAll('p').length >= 2, true);
  assert.equal(root.querySelectorAll('aside').length, 1);
  assert.equal(root.querySelector('aside').getAttribute('role'), null, 'callouts are not role=alert');
  assert.match(root.querySelector('aside').textContent, /InformaçãoImportanteLeia\nantes/u);
  assert.ok(root.querySelector('hr'));
  assert.equal(root.querySelectorAll('.contents-layout-content').length, 10, 'omitted layouts default to the content layout');
  assert.equal(root.querySelectorAll('.contents-block').length, 10);
  assert.equal(root.querySelector('.contents-back-link').getAttribute('href'), '/contents.html?page=2');
  assert.equal(root.querySelector('.contents-summary').classList.contains('contents-multiline'), true);
  assert.equal(root.querySelector('.contents-caption').classList.contains('contents-multiline'), true);
  assert.equal(root.querySelectorAll('[style]').length, 0);
  assert.equal(root.querySelectorAll('[srcdoc]').length, 0);
  assert.equal(root.querySelectorAll('iframe, img, video, object').length, 0);
  assert.equal(root.querySelectorAll('[onclick], [onerror], [onload]').length, 0);
});

test('callout asides are accessibly named by their visible tone labels with unique IDs', async () => {
  const h = await createContentsHarness();
  const root = emptyRoot(h);
  h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'callout', tone: 'info', text: 'Texto informativo' },
    { type: 'callout', tone: 'warning', title: 'Importante', text: 'Texto de atenção' },
    { type: 'callout', tone: 'success', text: 'Texto de sucesso' },
  ] }), {}, {});
  const asides = root.querySelectorAll('aside');
  assert.equal(asides.length, 3);
  const labelIds = asides.map(aside => {
    const label = aside.querySelector('.contents-callout-label');
    assert.ok(label?.id, 'the visible tone label has a stable DOM ID');
    assert.equal(aside.getAttribute('aria-labelledby'), label.id, 'the aside name is tied to its visible tone label');
    return label.id;
  });
  assert.equal(new Set(labelIds).size, labelIds.length, 'multiple callouts never reuse an accessible-name ID');
  assert.deepEqual(asides.map(aside => aside.querySelector('.contents-callout-label').textContent), ['Informação', 'Atenção', 'Sucesso']);
});

test('rich text marks use a fixed safe nesting order and links expose visible new-tab cues', async () => {
  const h = await createContentsHarness();
  const dto = pageFixture({ content_blocks: [{ type: 'rich_text', nodes: [
    { type: 'heading', level: 5, children: [{ type: 'text', text: '&lt;literal&gt;', marks: ['code', 'underline', 'italic', 'bold'] }] },
    { type: 'paragraph', children: [
      { type: 'text', text: '', marks: [] }, { type: 'break' },
      { type: 'link', url: 'https://example.test/safe', new_tab: true, children: [{ type: 'text', text: 'Link', marks: [] }] },
    ] },
    { type: 'list', ordered: true, items: [[], [{ type: 'text', text: 'Item', marks: [] }]] },
    { type: 'list', ordered: false, items: [] },
  ] }] });
  const root = emptyRoot(h);
  const view = h.modules.reader.renderReader(root, dto, {}, { signal: new AbortController().signal, isCurrent: () => true });
  const heading = root.querySelector('h5');
  const code = heading.querySelector('code');
  assert.equal(code.parentNode.tagName, 'U');
  assert.equal(code.parentNode.parentNode.tagName, 'EM');
  assert.equal(code.parentNode.parentNode.parentNode.tagName, 'STRONG');
  assert.equal(heading.textContent, '&lt;literal&gt;');
  assert.equal(root.querySelectorAll('br').length, 1);
  const external = root.querySelector('a[target="_blank"]');
  assert.equal(external.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(external.querySelector('.contents-new-tab-cue').textContent, 'Abre em nova aba');
  assert.ok(root.querySelector('ol li'));
  assert.ok(root.querySelector('ul'));
  assert.equal(root.querySelectorAll('h1').length, 1);
  assert.equal(view.media.length, 0);
});

test('reader supports cover, null dates, categories, empty rich arrays, and every validated layout class', async () => {
  const h = await createContentsHarness();
  const dto = pageFixture({ cover: { asset_id: ASSET_ID, alt: 'Capa' }, published_at: null,
    categories: [{ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'people', name: 'Pessoas' }],
    content_blocks: ['content', 'wide', 'full', 'left', 'right'].map(layout => ({ type: 'divider', layout }))
      .concat([{ type: 'rich_text', nodes: [] }]) });
  const root = emptyRoot(h);
  const result = h.modules.reader.renderReader(root, dto, {}, { signal: new AbortController().signal, isCurrent: () => true });
  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].kind, 'image');
  assert.equal(root.querySelectorAll('time').length, 0);
  assert.equal(root.querySelector('.contents-reader-categories').textContent, 'Pessoas');
  for (const layout of ['content', 'wide', 'full', 'left', 'right']) {
    assert.equal(root.querySelectorAll(`.contents-layout-${layout}`).length, layout === 'content' ? 2 : 1);
  }
  assert.equal(root.querySelectorAll('h1').length, 1);
});

test('all ten block kinds get all five contained layouts and responsive CSS stays feature-scoped', async () => {
  const h = await createContentsHarness();
  const root = emptyRoot(h);
  const blocks = ['content', 'wide', 'full', 'left', 'right'].flatMap(layout =>
    blockFixtures().map(block => ({ ...block, layout })));
  h.modules.reader.renderReader(root, pageFixture({ content_blocks: blocks }), {}, {});
  for (const layout of ['content', 'wide', 'full', 'left', 'right']) {
    assert.equal(root.querySelectorAll(`.contents-layout-${layout}`).length, 10,
      `every supported block kind renders in the ${layout} layout`);
  }

  const css = (await readFile('public/css/portal-contents.css', 'utf8')).replace(/\/\*[\s\S]*?\*\//gu, '');
  const selectors = [];
  let start = 0;
  for (let index = 0; index < css.length; index += 1) {
    if (css[index] === '{') {
      const prelude = css.slice(start, index).trim();
      if (prelude && !prelude.startsWith('@')) selectors.push(...prelude.split(',').map(item => item.trim()));
      start = index + 1;
    } else if (css[index] === '}') start = index + 1;
  }
  assert.ok(selectors.length > 0);
  for (const selector of selectors) {
    assert.match(selector, /^(?:\.portal-contents(?:\b|\s|[.#:\[]).*|\.portal-contents-lightbox(?:\b|\s|[.#:\[]).*)$/u,
      `feature stylesheet selector is scoped: ${selector}`);
  }
  assert.match(css, /\.portal-contents\s*\{[^}]*container-type:\s*inline-size/u);
  assert.match(css, /\.portal-contents\s+\.contents-article\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/u);
  assert.match(css, /\.portal-contents\s+\.contents-layout-content\s*\{[^}]*72ch/u);
  assert.match(css, /\.portal-contents\s+\.contents-layout-wide\s*\{[^}]*1100px/u);
  assert.match(css, /\.portal-contents\s+\.contents-layout-full\s*\{[^}]*inline-size:\s*100%/u);
  assert.match(css, /\.portal-contents\s+\.contents-layout-left\s*\{[^}]*margin-inline-start:\s*max\(0px/u);
  assert.match(css, /\.portal-contents\s+\.contents-layout-right\s*\{[^}]*margin-inline-end:\s*max\(0px/u);
  assert.match(css, /@container\s*\(max-width:\s*1100px\)/u);
  assert.match(css, /\.portal-contents\s+\.contents-gallery-list\s*\{[^}]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*180px\),\s*1fr\)\)/u);
  assert.match(css, /\.portal-contents\s+\.contents-multiline\s*\{[^}]*white-space:\s*pre-wrap/u);
  assert.match(css, /\.portal-contents\s+\.contents-embed\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/u);
  assert.match(css, /\.portal-contents-lightbox\s*\{[^}]*100dvw[^}]*100dvh/u);
  assert.match(css, /\.portal-contents-lightbox\s+\.contents-lightbox-controls\s+button[^}]*min-inline-size:\s*44px/u);
  assert.match(css, /@container\s*\(max-width:\s*480px\)/u, 'gallery collapses to one column at narrow container sizes');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
});

test('invalid DTO is rejected atomically before content DOM or media descriptors are created', async () => {
  const h = await createContentsHarness();
  const root = emptyRoot(h);
  const preserved = h.document.createElement('p'); preserved.textContent = 'old view'; root.append(preserved);
  const hostile = clone(pageFixture());
  hostile.content_blocks[0].style = 'background:url(javascript:alert(1))';
  assert.throws(() => h.modules.reader.renderReader(root, hostile, {}, {}), error => error.code === 'invalid_contents');
  assert.equal(root.children.length, 1);
  assert.equal(root.firstChild, preserved);
  assert.equal(root.querySelectorAll('iframe, img, video, object').length, 0);
});

test('catalog uses semantic list/article cards, safe titles, stable covers and canonical pagination links', async () => {
  const h = await createContentsHarness();
  const root = emptyRoot(h);
  const first = pageFixture({ content_blocks: [], cover: { asset_id: ASSET_ID, alt: 'Capa do primeiro' } });
  const second = pageFixture({ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'second-page', title: 'Segundo', content_blocks: [], cover: null, published_at: null });
  const categoriesData = [{ id: '018f47a2-7b3c-7a11-8a2c-000000000002', slug: 'people', name: 'Pessoas', count: 30 }];
  const view = h.modules.catalog.renderCatalog(root, { data: [first, second], total: 30, category: 'people', page: 2 }, {});
  const categories = root.querySelectorAll('nav').find(node => node.getAttribute('aria-label') === 'Filtrar por categoria');
  h.modules.catalog.renderCategories(categories, categoriesData, 'people', { signal: new AbortController().signal, isCurrent: () => true });
  assert.equal(root.querySelectorAll('h1').length, 1);
  assert.equal(root.querySelector('h1').textContent, 'Conteúdos');
  assert.ok(categories);
  const cardList = root.querySelector('.contents-card-list');
  assert.equal(cardList.children.length, 2);
  assert.equal(cardList.children.every(item => item.tagName === 'LI' && item.querySelector('article')?.parentNode === item), true);
  assert.equal(root.querySelectorAll('article h2 a').length, 2);
  assert.equal(root.querySelector('#contents-card-018f47a2-7b3c-7a11-8a2c-1234567890ab').getAttribute('href'), '/contents.html?slug=published-policy');
  assert.equal(root.querySelectorAll('article').every(article => article.querySelectorAll('a').length === 1), true,
    'the article card is not a nested click target');
  assert.equal(root.querySelectorAll('img[src], iframe[src], video[src], object').length, 0);
  assert.equal(view.media.length, 1);
  assert.equal(view.media[0].eager, false);
  assert.equal(root.querySelector('.contents-page-current').textContent, 'Página 2 de 3');
  assert.equal(root.querySelector('.contents-page-previous').getAttribute('href'), '/contents.html?category=people');
  assert.equal(root.querySelector('.contents-page-next').getAttribute('href'), '/contents.html?category=people&page=3');
  assert.equal(root.querySelector('.contents-card-summary').classList.contains('contents-multiline'), true);
  assert.equal(categories.querySelector('a[aria-current="page"]').textContent, 'Pessoas (30)');
});

test('catalog empty states and page-one links do not invent media or an unavailable pager direction', async () => {
  const h = await createContentsHarness();
  const root = emptyRoot(h);
  const result = h.modules.catalog.renderCatalog(root, { data: [], total: 0, category: null, page: 1 }, {});
  assert.equal(result.media.length, 0);
  assert.equal(root.querySelectorAll('article').length, 0);
  assert.equal(root.querySelectorAll('.contents-page-previous, .contents-page-next').length, 0);
  assert.equal(root.querySelector('.contents-page-current').textContent, 'Página 1 de 1');
  assert.throws(() => h.modules.catalog.renderCatalog(root, { data: [pageFixture()], total: 0, page: 1 }, {}), { code: 'invalid_contents' });
});

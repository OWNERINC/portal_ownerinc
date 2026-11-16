import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererHarness } from '../helpers/pages-renderer-harness.mjs';
import { drain } from '../helpers/frontend-feedback-harness.mjs';
import { referenceDocument } from '../helpers/pages-reference-document.mjs';
import { resolveAppearance, appearanceIssues } from '../../public/pages/appearance.js';

const prose = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
function context(h, doc, current) {
  return { ...h.options, document: doc, resolveBlock: () => current(), richNode: h.context.richNode, imageFigure: h.context.imageFigure, mediaFigure: h.context.mediaFigure };
}
test('gallery keys preserve ordered private image/GIF lifecycle across reorder, replace, remove and late blobs', async () => {
  const h = await rendererHarness(), doc = referenceDocument();
  let current = { id: 'gallery', type: 'gallery', items: [
    { id: 'a', kind: 'image', media_id: 'image-a', alt: 'Primeira', caption: 'Legenda', credit: 'Crédito' },
    { id: 'b', kind: 'gif', media_id: 'gif-b', alt: 'Segunda', caption: '', credit: '' },
    { id: 'c', kind: 'image', media_id: null, alt: '', caption: '', credit: '' },
  ] };
  const figure = h.context.renderV3Block(current, context(h, doc, () => current));
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].args[1], 'image-a');
  const original = figure.node.querySelector('[data-gallery-item-id="a"]');
  assert.equal(original.querySelector('img').alt, 'Primeira');
  assert.match(original.textContent, /Legenda/); assert.match(original.textContent, /Crédito/);
  const gif = figure.node.querySelector('[data-gallery-item-id="b"]'); gif.querySelector('button').click();
  assert.equal(h.requests[1].args[1], 'gif-b');
  current = { ...current, items: [current.items[1], { ...current.items[0], alt: 'Atual' }] }; figure.refresh();
  assert.equal(figure.node.children[0], gif); assert.equal(figure.node.children[1], original); assert.equal(original.querySelector('img').alt, 'Atual');
  assert.equal(h.requests.length, 2, 'reorder must not refetch');
  current.items = [{ ...current.items[1], media_id: 'replacement' }]; figure.refresh();
  assert.equal(h.requests[0].args[2].signal.aborted, true); assert.equal(h.requests[1].args[2].signal.aborted, true);
  h.requests[0].resolve('blob:old'); h.requests[1].resolve('blob:removed'); await drain();
  assert.ok(h.revoked.includes('blob:old')); assert.ok(h.revoked.includes('blob:removed'));
  h.requests[2].resolve('blob:replacement'); await drain(); assert.equal(original.querySelector('img').src, 'blob:replacement');
  figure.dispose(); figure.dispose(); assert.ok(h.revoked.includes('blob:replacement'));
  current.items.push({ id: 'new', kind: 'image', media_id: 'never' }); figure.refresh(); assert.equal(h.requests.length, 3);
});
test('FAQ uses independent native details, stable headings and safe rich answers; expansion never changes data', async () => {
  const h = await rendererHarness(), doc = referenceDocument();
  const block = { id: 'faq', type: 'faq', items: [{ id: 'a', question: 'Um?', answer: prose('<script>literal</script>') }, { id: 'b', question: 'Dois?', answer: prose('Resposta') }] };
  const bytes = JSON.stringify(block), figure = h.context.renderV3Block(block, context(h, doc, () => block));
  const details = figure.node.querySelectorAll('details'); assert.equal(details.length, 2);
  for (const node of details) { assert.equal(node.hasAttribute('name'), false); node.open = true; assert.ok(node.querySelector('summary').querySelector('h3').id); }
  assert.ok(details.every(n => n.open)); assert.equal(JSON.stringify(block), bytes); assert.equal(figure.node.querySelectorAll('script').length, 0);
  figure.refresh(); assert.equal(figure.node.querySelector('details'), details[0]); assert.ok(details.every(n => n.open));
  figure.dispose();
});
test('YouTube requires its own informed click; unload/dispose removes sources and stale consent cannot recreate', async () => {
  const h = await rendererHarness(), doc = referenceDocument();
  let block = { id: 'embed', type: 'video_embed', provider: 'youtube', video_id: 'dQw4w9WgXcQ', title: 'Exemplo', transcript: 'Descrição' };
  const figure = h.context.renderV3Block(block, context(h, doc, () => block));
  assert.equal(figure.node.querySelectorAll('iframe').length, 0); assert.equal(h.requests.length, 0); assert.equal(figure.node.querySelectorAll('img').length, 0);
  assert.match(figure.node.textContent, /YouTube/); assert.match(figure.node.textContent, /privado/);
  const consent = figure.node.querySelector('[data-pages-video-consent]'); consent.click();
  let iframe = figure.node.querySelector('iframe'); assert.match(iframe.src, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  assert.doesNotMatch(iframe.src, /autoplay=1/); assert.equal(iframe.title, 'Exemplo'); assert.doesNotMatch(iframe.getAttribute('allow') || '', /autoplay/);
  figure.node.querySelector('[data-pages-video-unload]').click(); assert.equal(iframe.hasAttribute('src'), false); assert.equal(figure.node.querySelectorAll('iframe').length, 0);
  consent.click(); iframe = figure.node.querySelector('iframe'); block = { ...block, video_id: 'aaaaaaaaaaa' }; figure.refresh(); assert.equal(iframe.hasAttribute('src'), false);
  figure.dispose(); consent.click(); assert.equal(figure.node.querySelectorAll('iframe').length, 0);
  for (const invalid of [{ ...block, video_id: 'https://evil.test' }, { ...block, provider: 'evil' }]) {
    const bad = h.context.renderV3Block(invalid, context(h, doc, () => invalid)); bad.node.querySelector('button').click(); assert.equal(bad.node.querySelectorAll('iframe').length, 0); bad.dispose();
  }
});
test('v3 canonical painter includes marks, inner pairs, header, captions, local icons/tags; legacy ignores v3 marks', async () => {
  const h = await rendererHarness(), doc = referenceDocument();
  const block = { id: 'rich', type: 'rich_text', appearance: { foreground: '#FFFFFF', background: '#000000', icon: 'coffee' }, tags: ['Local'], content: prose('Run') };
  block.content.content[0].content[0].marks = [{ type: 'text_color', attrs: { color: '#abcdef' } }, { type: 'link', attrs: { href: '/perfil.html' } }, { type: 'highlight', attrs: { color: '#123456' } }];
  const rich = h.context.richNode(block.content, { document: doc, block });
  assert.equal(rich.querySelector('a').style.color, '#ABCDEF');
  assert.equal(rich.querySelector('[data-pages-rich-run]').style.backgroundColor, '#123456');
  assert.equal(h.context.richNode(block.content).querySelector('a').style.color, undefined);
  const figureBlock = { id: 'image', type: 'image', media_id: 'image', caption: 'Legenda', credit: 'Crédito', style: { palette: 'brand', scale: 'large', align: 'start', font: 'manrope' } };
  doc.sections = [doc.sections[0]]; doc.sections[0].rows[0].columns[0].blocks = [block, figureBlock];
  const host = h.doc.createElement('div'); h.doc.body.append(host); const dispose = h.context.renderDocument({ host, document: doc, ...h.options });
  assert.equal(host.querySelector('article').dataset.schemaVersion, '3'); assert.equal(host.querySelector('header').style.color, doc.presentation.defaults.foreground);
  const caption = host.querySelector('figcaption'), pair = resolveAppearance(doc, figureBlock, 'caption');
  assert.equal(caption.style.color, pair.foreground); assert.equal(caption.style.backgroundColor, pair.background); assert.equal(caption.style.fontSize, '14px'); assert.equal(caption.style.fontWeight, '400');
  assert.ok(appearanceIssues(doc).some(i => i.path.endsWith('.caption')), 'paint low legacy caption honestly; do not silently fix it');
  assert.ok(host.querySelector('[data-block-id="rich"]').querySelector('svg')); assert.match(host.querySelector('[data-block-id="rich"]').textContent, /Local/);
  dispose(); h.requests[0].resolve('blob:late-document'); await drain(); assert.ok(h.revoked.includes('blob:late-document'));
});
test('published null/empty content never fetches null or displays draft placeholders; empty anchors remain', async () => {
  const h = await rendererHarness(), doc = referenceDocument();
  const host = h.doc.createElement('div'); h.doc.body.append(host);
  const dispose = h.context.renderDocument({ host, document: doc, ...h.options, staged: false });
  assert.equal(h.requests.length, 0); assert.equal(host.querySelectorAll('[data-pages-placeholder]').length, 0);
  assert.ok(host.querySelector('[data-pages-empty-section]')); dispose();
});

test('image refresh resolves replaced current document/caption appearance, aborts pending on removal and keeps legacy two-argument style API', async () => {
  const h = await rendererHarness(); let doc = referenceDocument();
  let block = { id: 'image', type: 'image', media_id: 'a', alt: 'Antes', caption: 'Legenda' };
  const figure = h.context.imageFigure(block, { ...h.options, document: doc, resolveDocument: () => doc, resolveBlock: () => block });
  doc = JSON.parse(JSON.stringify(doc)); doc.presentation.defaults.foreground = '#112233'; block = { ...block, alt: 'Depois' };
  figure.refresh(); assert.equal(figure.node.querySelector('img').alt, 'Depois'); assert.equal(figure.node.querySelector('figcaption').style.color, '#112233');
  block = null; figure.refresh(); assert.equal(h.requests[0].args[2].signal.aborted, true);
  h.requests[0].resolve('blob:removed'); await drain(); assert.ok(h.revoked.includes('blob:removed'));
  block = { id: 'image', type: 'image', media_id: 'a', alt: 'Retorno' }; figure.refresh(); assert.equal(h.requests.length, 2);
  figure.dispose(); h.requests[1].resolve('blob:disposed'); await drain(); assert.ok(h.revoked.includes('blob:disposed'));
  const wrapper = h.doc.createElement('div'); h.context.applyBlockStyle(wrapper, block, doc); assert.equal(wrapper.dataset.schemaVersion,'3');
  h.context.applyBlockStyle(wrapper, block, { schema_version: 2 }); assert.equal(wrapper.dataset.schemaVersion,undefined);assert.equal(wrapper.style.color,'');
  const legacy = h.doc.createElement('div'); h.context.applyBlockStyle(legacy, block); assert.equal(legacy.dataset.palette,'neutral'); assert.equal(legacy.style.color,undefined);
});

test('embed abort clears iframe/src and all listeners; empty draft gallery refresh is honest and idempotent', async () => {
  const h = await rendererHarness(), doc = referenceDocument(), controller = new AbortController();
  const block = { id:'embed',type:'video_embed',provider:'youtube',video_id:'dQw4w9WgXcQ',title:'Título',transcript:'Texto' };
  const figure = h.context.renderV3Block(block, { ...context(h,doc,()=>block),signal:controller.signal });
  const consent=figure.node.querySelector('button');consent.click();const iframe=figure.node.querySelector('iframe');
  controller.abort();assert.equal(iframe.hasAttribute('src'),false);assert.equal(figure.node.querySelectorAll('iframe').length,0);consent.click();assert.equal(figure.node.querySelectorAll('iframe').length,0);
  const gallery={id:'gallery',type:'gallery',items:[]}, empty=h.context.renderV3Block(gallery,context(h,doc,()=>gallery));
  empty.refresh();empty.refresh();assert.equal(empty.node.querySelectorAll('[data-pages-placeholder]').length,1);assert.equal(h.requests.length,0);empty.dispose();
});

test('v1/v2 article DOM/palettes/text marks remain legacy, with no v3 inline paint or implicit upgrade', async () => {
  for (const version of [1,2]) {
    const h = await rendererHarness(), doc=referenceDocument();doc.schema_version=version;
    const block={id:'legacy',type:'rich_text',style:{palette:'warm',font:'oswald',align:'end',scale:'small'},appearance:{foreground:'#FFFFFF'},content:prose('Literal')};
    block.content.content[0].content[0].marks=[{type:'text_color',attrs:{color:'#FFFFFF'}},{type:'link',attrs:{href:'/profile.html'}}];
    doc.sections=[doc.sections[0]];doc.sections[0].rows[0].columns[0].blocks=[block];const bytes=JSON.stringify(doc),host=h.doc.createElement('div');
    const dispose=h.context.renderDocument({host,document:doc,...h.options});
    const wrapper=host.querySelector('.pages-rendered-block');assert.equal(wrapper.dataset.palette,'warm');assert.equal(wrapper.dataset.font,'oswald');assert.equal(wrapper.style.color,undefined);assert.equal(host.querySelector('article').hasAttribute('data-schema-version'),false);
    assert.equal(host.querySelector('a').style.color,undefined);assert.equal(host.querySelectorAll('[data-pages-rich-run]').length,0);assert.equal(JSON.stringify(doc),bytes);dispose();
  }
});

test('button/callout presets paint their own inner pairs, not a full-width outer color stripe; tags keep the checked pair', async () => {
  const h=await rendererHarness(),doc=referenceDocument(),host=h.doc.createElement('div');
  const button={id:'button',type:'button',label:'Guia',preset:'primary',action:{type:'url',value:'/profile.html'},tags:['Tag']};
  const callout={id:'callout',type:'callout',tone:'attention',icon:'none',content:prose('Aviso')};
  doc.sections=[doc.sections[0]];doc.sections[0].rows[0].columns[0].blocks=[button,callout];
  const dispose=h.context.renderDocument({host,document:doc,...h.options});
  for(const block of [button,callout]){
    const wrapper=host.querySelector(`[data-block-id="${block.id}"]`),inner=wrapper.querySelector(block.type==='button'?'.pages-action-button':'.pages-callout');
    assert.equal(wrapper.style.backgroundColor,doc.presentation.defaults.background);
    assert.equal(inner.style.backgroundColor,resolveAppearance(doc,block).background);
  }
  const tags=host.querySelector('.pages-block-tags');assert.equal(tags.style.color,resolveAppearance(doc,button).foreground);assert.equal(tags.style.backgroundColor,resolveAppearance(doc,button).background);dispose();
});

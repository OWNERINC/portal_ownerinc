import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { publicationIssues } from '../../public/pages/model.js';
import { publicationIssueDetails, publicationIssueTarget } from '../../public/pages/publication-issues.js';
import { errorText } from '../../public/pages/dom.js';
import { upgradeDocument } from '../../public/pages/document-v3.js';

const require = createRequire(import.meta.url);
const { validateDocument } = require('../../api/pages/validation');
const { createTemplate } = require('../../api/pages/templates');
const id = n => `abcdefab-1234-4000-8000-${String(n).padStart(12, '0')}`;
const cargos = [{ id: id(1), active: true }];
const prose = text => ({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });
const faq = () => ({ id: id(2), type: 'faq', items: [{ id: id(3), question: 'Como funciona?', answer: prose('Resposta completa.') }] });
const gallery = () => ({ id: id(4), type: 'gallery', items: [{ id: id(5), kind: 'image', media_id: id(6), alt: 'Descrição', caption: '', credit: '' }] });
const embed = () => ({ id: id(7), type: 'video_embed', provider: 'youtube', video_id: 'aB3_-dE6Fg7', title: 'Vídeo', transcript: 'Transcrição' });
const text = () => ({ id: id(8), type: 'rich_text', content: prose('Texto de apoio.') });
test('structured issues preserve exact legacy aggregate messages and stable item destinations', () => {
  const f = faq(); f.items[0].question = ''; f.items[0].answer = prose('');
  const audio = { id: id(20), type: 'audio', media_id: null, transcript: '', title: '' };
  const doc = document(text(), f, audio); doc.metadata.title = ''; doc.metadata.audience.job_title_ids = [];
  const before = JSON.stringify(doc), details = publicationIssueDetails(doc, cargos);
  assert.deepEqual(details.map(issue => issue.message), [
    'Preencha o título.', 'Selecione apenas cargos atualmente ativos.',
    'Áudio e vídeo precisam de transcrição; vídeo também precisa de legendas sincronizadas.',
    'FAQ (bloco 2), item 1: preencha a pergunta.', 'FAQ (bloco 2), item 1: escreva o texto da resposta.',
  ]);
  assert.deepEqual(details.map(issue => issue.message), publicationIssues(doc, cargos));
  assert.ok(details.some(issue => issue.blockId === audio.id && issue.field === 'media_id'));
  assert.ok(details.some(issue => issue.blockId === f.id && issue.itemId === f.items[0].id && issue.field === 'answer'));
  assert.equal(JSON.stringify(doc), before);
});
test('destinations are re-resolved by stable ID and fail closed after item/block removal or source replacement', () => {
  const f=faq(), doc=document(f);f.items[0].question='';
  const issue=publicationIssueDetails(doc,cargos).find(value=>value.field==='question');
  assert.deepEqual(publicationIssueTarget(doc,issue),{blockId:f.id,itemId:f.items[0].id,field:'question'});
  f.items=[];assert.equal(publicationIssueTarget(doc,issue),null);
  doc.sections[0].rows[0].columns[0].blocks=[];assert.equal(publicationIssueTarget(doc,issue),null);
  assert.equal(publicationIssueTarget(doc,{code:'contrast',message:'No safe field'}),null);
  assert.deepEqual(publicationIssueTarget(doc,{field:'audience'}),{field:'audience'});
});
test('legacy aggregate image and AV checks keep one message each and first failing destination', () => {
  for(const version of [1,2,3]){
    const image={id:id(30),type:'image',media_id:id(31),alt:''};
    const video={id:id(32),type:'video',media_id:id(33),transcript:'Ready',captions:[]};
    const doc=document(image,{...image,id:id(34)},video,{...video,id:id(35)});doc.schema_version=version;
    doc.metadata.title='';doc.metadata.audience.job_title_ids=[id(36)];
    const details=publicationIssueDetails(doc,cargos);
    assert.deepEqual(details.map(i=>i.message),[
      'Preencha o título.','Selecione apenas cargos atualmente ativos.',
      version===3?'Adicione conteúdo de texto à página ou a uma resposta de FAQ.':'Adicione conteúdo de texto ao comunicado.',
      'Todas as imagens precisam estar prontas e ter texto alternativo.',
      'Áudio e vídeo precisam de transcrição; vídeo também precisa de legendas sincronizadas.',
    ]);
    assert.deepEqual(details.map(i=>i.message),publicationIssues(doc,cargos));
    assert.deepEqual(details.filter(i=>i.blockId).map(i=>[i.blockId,i.field]),[[image.id,'alt'],[video.id,'captions']]);
  }
});
function document(...blocks) {
  const doc = upgradeDocument(createTemplate('comunicado'));
  doc.metadata.title = 'Preflight sintético'; doc.metadata.audience.job_title_ids = [id(1)];
  doc.sections[0].rows[0].columns[0].blocks = blocks;
  return doc;
}

test('FAQ answers alone satisfy server and frontend meaningful prose without mutating the draft', () => {
  const doc = document(faq()), before = JSON.stringify(doc);
  assert.doesNotThrow(() => validateDocument(doc, { publishing: true }));
  assert.deepEqual(publicationIssues(doc, cargos), []);
  assert.equal(JSON.stringify(doc), before);
});

for (const [label, make, change, reason, message] of [
  ['empty gallery', gallery, b => { b.items = []; }, 'publication_incomplete', /Galeria.*adicione/i],
  ['gallery placeholder', gallery, b => { b.items[0].media_id = null; }, 'media_not_ready', /Galeria.*item 1.*arquivo/i],
  ['gallery alt', gallery, b => { b.items[0].alt = ' \n '; }, 'image_alt_required', /Galeria.*item 1.*alternativo/i],
  ['empty FAQ', faq, b => { b.items = []; }, 'publication_incomplete', /FAQ.*adicione/i],
  ['FAQ question', faq, b => { b.items[0].question = ' \n '; }, 'publication_incomplete', /FAQ.*item 1.*pergunta/i],
  ['FAQ answer', faq, b => { b.items[0].answer = prose(' \n '); }, 'publication_incomplete', /FAQ.*item 1.*resposta/i],
  ['embed title', embed, b => { b.title = ' \n '; }, 'media_accessibility_required', /Vídeo incorporado.*título/i],
  ['embed transcript', embed, b => { b.transcript = ' \n '; }, 'media_accessibility_required', /Vídeo incorporado.*transcrição/i],
]) test(`${label}: draft accepted, preflight actionable, server publication rejects`, () => {
  const block = make(); change(block); const doc = document(text(), block);
  assert.doesNotThrow(() => validateDocument(doc));
  assert.throws(() => validateDocument(doc, { publishing: true }), { reason });
  const issues = publicationIssues(doc, cargos);
  assert.deepEqual(publicationIssueDetails(doc, cargos).map(issue => issue.message), issues);
  assert.ok(issues.some(issue => message.test(issue)), JSON.stringify(issues));
  assert.ok(issues.some(issue => issue.includes('bloco 2')), 'identify the document-order block');
});

test('all gallery image/GIF items and all FAQ items are checked, not only the first', () => {
  const g = gallery(), f = faq();
  g.items.push({ ...g.items[0], id: id(9), kind: 'gif', alt: '' });
  f.items.push({ ...f.items[0], id: id(10), question: '', answer: prose('') });
  const doc = document(g, f), issues = publicationIssues(doc, cargos);
  assert.throws(() => validateDocument(doc, { publishing: true }), { reason: 'image_alt_required' });
  assert.ok(issues.some(issue => /Galeria.*item 2.*alternativo/.test(issue)));
  assert.ok(issues.some(issue => /FAQ.*item 2.*pergunta/.test(issue)));
  assert.ok(issues.some(issue => /FAQ.*item 2.*resposta/.test(issue)));
});

test('complete v3 blocks pass; questions, media labels and transcripts do not replace meaningful prose', () => {
  for (const blocks of [[faq(), gallery(), embed()], [text(), gallery(), embed()]]) {
    const doc = document(...blocks);
    assert.doesNotThrow(() => validateDocument(doc, { publishing: true }));
    assert.deepEqual(publicationIssues(doc, cargos), []);
  }
  const doc = document(gallery(), embed());
  assert.throws(() => validateDocument(doc, { publishing: true }), { reason: 'publication_incomplete' });
  assert.deepEqual(publicationIssues(doc, cargos), ['Adicione conteúdo de texto à página ou a uma resposta de FAQ.']);
});

test('nested FAQ answer text counts but hard breaks and whitespace do not', () => {
  const f = faq();
  f.items[0].answer = { type: 'doc', content: [{ type: 'bullet_list', content: [{ type: 'list_item', content: [prose('Resposta na lista').content[0]] }] }] };
  const doc = document(f);
  assert.doesNotThrow(() => validateDocument(doc, { publishing: true }));
  assert.deepEqual(publicationIssues(doc, cargos), []);
  f.items[0].answer = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hard_break' }] }] };
  assert.throws(() => validateDocument(doc, { publishing: true }), { reason: 'publication_incomplete' });
  assert.ok(publicationIssues(doc, cargos).some(issue => /resposta/.test(issue)));
});

test('v1/v2 preflight preserves existing text messages and schema bytes', () => {
  for (const name of ['comunicado', 'owner-news']) {
    const doc = createTemplate(name);
    doc.metadata.title = 'Legado'; doc.metadata.audience.job_title_ids = [id(1)];
    doc.sections = [doc.sections[0]];
    doc.sections[0].rows[0].columns[0].blocks = [text()];
    const before = JSON.stringify(doc);
    assert.doesNotThrow(() => validateDocument(doc, { publishing: true }));
    assert.deepEqual(publicationIssues(doc, cargos), []);
    assert.equal(JSON.stringify(doc), before);
    doc.sections[0].rows[0].columns[0].blocks = [];
    assert.deepEqual(publicationIssues(doc, cargos), ['Adicione conteúdo de texto ao comunicado.']);
  }
});

test('server fallback explains v3 incomplete blocks and embed accessibility', () => {
  assert.match(errorText({ status: 400, reason: 'publication_incomplete' }), /galeria.*FAQ/i);
  assert.match(errorText({ status: 400, reason: 'media_accessibility_required' }), /incorporado.*título.*transcrição/i);
});

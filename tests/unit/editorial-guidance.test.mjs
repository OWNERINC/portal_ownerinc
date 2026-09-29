import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createMountedHarness, drain } from '../helpers/cms-harness.mjs';
import { createKnowledgeEditorialHarness, editor } from '../helpers/knowledge-editorial-harness.mjs';

const PDF = '550e8400-e29b-41d4-a716-446655440001';
const TEMP_PDF = '550e8400-e29b-41d4-a716-446655440002';
const document = { id: 'document-a', content_type: 'knowledge', title: 'Política', category: 'DHO', draft_revision_id: 'draft-a' };
const blocks = [{ type: 'paragraph', text: 'Corpo preservado' }];
const legacyArticle = { id: 'article-a', title: 'Política', category: 'DHO', content: 'Texto legado editável', cms_managed: false };
const cmsArticle = { ...legacyArticle, cms_managed: true, content: 'Não deve substituir os blocos', content_blocks: blocks };
const revision = (status, version = 1) => ({ id: `revision-${version}`, version, status, created_at: '2026-09-29T12:00:00Z' });
const compactText = node => node.textContent.replace(/\s+/g, ' ').trim();

// Execute the actual frontend permission helper without loading Firebase. The
// mounted harness must retain its current truthy semantics, not hide a bad gate
// by substituting the strict API policy in the double.
const frontendCanSource = (await readFile(new URL('../../public/js/auth.js', import.meta.url), 'utf8'))
  .match(/^export function can\([\s\S]*?^\}/m)?.[0];
assert.ok(frontendCanSource, 'the real frontend can() helper must be available');
const frontendCan = vm.runInNewContext(`(${frontendCanSource.replace(/^export /, '')})`);

function assertCmsNavigation(h) {
  assert.equal(h.location.pathname, '/cms.html');
  assert.equal(h.location.search, '');
  assert.equal(h.page.active, false);
  assert.equal(h.mounts.at(-1).name, './cms.js', 'destination reached the router mount boundary');
  assert.deepEqual(h.errors, [], 'a committed URL alone does not establish successful navigation');
}

async function cmsHarness(t, revisions = [], user) {
  const h = await createMountedHarness('cms', user ? { user } : undefined);
  t.after(() => h.page.dispose());
  h.latest('/documents?').resolve({ data: [document], total: 1 }); await drain();
  h.node('document-list').querySelector('button').click();
  h.latest('/documents/document-a').resolve({ document, draft: { id: 'draft-a', blocks } }); await drain();
  h.latest('/revisions?').resolve({ data: revisions, total: revisions.length }); await drain();
  return h;
}

for (const [status, label] of [['draft', 'Rascunho'], ['published', 'Publicado'], ['scheduled', 'Agendado'], ['archived', 'Arquivado']]) {
  test(`CMS renders revision ${status} as ${label} without rewriting its transport enum`, async t => {
    const records = [revision(status)];
    const before = structuredClone(records);
    const h = await cmsHarness(t, records);
    assert.equal(h.node('revision-history').querySelector('strong').textContent, `v1 · ${label}`);
    assert.deepEqual(records, before);
    assert.equal(h.latest('/revisions?').path, '/api/cms/documents/document-a/revisions?limit=50&offset=0');
    assert.equal(h.requests.some(call => call.options.method), false);
  });
}

test('CMS unknown history codes remain literal safe text, including prototype keys and markup', async t => {
  const unknown = ['future_status', '__proto__', 'constructor', '<img src=x onerror=alert(1)>'];
  const records = unknown.map((status, index) => revision(status, index + 1));
  const h = await cmsHarness(t, records);
  assert.deepEqual(h.node('revision-history').querySelectorAll('strong').map(node => node.textContent), unknown.map((status, index) => `v${index + 1} · ${status}`));
  assert.equal(h.node('revision-history').querySelectorAll('img, script').length, 0);
  assert.equal(h.node('revision-history').innerHTML, undefined, 'rendering must not assign innerHTML on the DOM double');
  assert.deepEqual(records.map(record => record.status), unknown);
});

test('CMS area label and inspector heading are Portuguese but requests and creation keep knowledge', async t => {
  const h = await cmsHarness(t, [revision('draft')], editor);
  assert.deepEqual(h.node('content-types').querySelectorAll('button').map(node => node.textContent), ['Base de Conhecimento', 'Owner News']);
  assert.equal(h.node('inspector-type').textContent, 'Base de Conhecimento');
  assert.equal(compactText(h.doc.querySelector('.cms-inspector').querySelector('summary')), 'Configuração e publicação');
  assert.equal(h.latest('/documents?').path, '/api/cms/documents?type=knowledge&limit=50&offset=0');
  assert.equal(h.node('editor-status').className, 'badge badge-gold');
  h.node('new-document').click();
  h.latest('/api/knowledge?').resolve({ data: [{ id: 'source-a', title: 'Artigo existente' }], total: 1 }); await drain();
  h.node('new-title').value = 'Novo documento'; h.node('new-category').value = 'DHO'; h.node('new-source').value = 'source-a';
  h.submit('new-document-form'); await drain();
  const create = h.requests.find(call => call.path === '/api/cms/documents' && call.options.method === 'POST');
  assert.deepEqual(JSON.parse(create.options.body), { type: 'knowledge', title: 'Novo documento', category: 'DHO', source_id: 'source-a' });
});

test('CMS publication guidance is associated with controls and does not treat autosave as publication', async t => {
  const h = await cmsHarness(t);
  const help = h.node('cms-publication-help');
  assert.ok(help);
  assert.equal(help.parentNode, h.doc.querySelector('.cms-publish-controls'), 'help stays inside the existing responsive publication group');
  assert.match(compactText(help), /rascunho.*salvamento automático.*não publicam/i);
  assert.match(compactText(help), /Publicar.*Agendar/);
  for (const id of ['save-draft', 'publish-document', 'scheduled-at', 'schedule-document']) {
    assert.ok(h.node(id).getAttribute('aria-describedby').split(/\s+/).includes(help.id), id);
  }
  assert.equal(h.doc.querySelector('label[for="scheduled-at"]').querySelector('input'), h.node('scheduled-at'));
  const paragraph = h.node('inspector-block-settings').querySelector('textarea');
  h.input(paragraph, 'Revisão sem publicação'); await h.runTimers();
  const draft = h.latest('/draft');
  assert.equal(draft.options.method, 'PUT');
  assert.deepEqual(JSON.parse(draft.options.body), { blocks: [{ type: 'paragraph', text: 'Revisão sem publicação' }] });
  draft.resolve({ document, revision: { id: 'draft-b', status: 'draft', blocks } }); await drain();
  assert.equal(h.node('save-state').textContent, 'Rascunho salvo');
  assert.equal(h.node('editor-status').textContent, 'Rascunho');
  assert.equal(h.requests.some(call => /\/(publish|schedule)$/.test(call.path)), false);
});

for (const action of ['publish', 'schedule']) {
  test(`CMS ${action} still saves first and sends only canonical revision identifiers/date`, async t => {
    const h = await cmsHarness(t);
    const localDate = '2027-01-10T10:30';
    if (action === 'publish') h.node('publish-document').click();
    else { h.node('scheduled-at').value = localDate; h.submit('schedule-form'); }
    await drain();
    assert.equal(h.requests.some(call => call.path.endsWith(`/${action}`)), false);
    const draft = h.latest('/draft');
    assert.deepEqual(JSON.parse(draft.options.body), { blocks });
    draft.resolve({ document, revision: { id: 'draft-next', status: 'draft', blocks } }); await drain();
    const mutation = h.latest(`/${action}`);
    assert.equal(mutation.options.method, 'POST');
    assert.deepEqual(JSON.parse(mutation.options.body), {
      revision_id: 'draft-next', ...(action === 'schedule' ? { scheduled_at: new Date(localDate).toISOString() } : {}),
    });
    const key = action === 'publish' ? 'published_revision_id' : 'scheduled_revision_id';
    mutation.resolve({ document: { ...document, draft_revision_id: null, [key]: 'draft-next' }, revision: { id: 'draft-next', status: action === 'publish' ? 'published' : 'scheduled', blocks } }); await drain();
    assert.equal(h.node('save-state').textContent, action === 'publish' ? 'Publicado' : 'Agendado');
  });
}

test('CMS translated area still follows permission filtering', async t => {
  const h = await createMountedHarness('cms', { user: { role: 'admin', permissions: { manageAcademy: true } } });
  t.after(() => h.page.dispose());
  assert.deepEqual(h.node('content-types').querySelectorAll('button').map(node => node.textContent), ['Academy']);
  assert.equal(h.latest('/documents?').path, '/api/cms/documents?type=academy&limit=50&offset=0');
});

test('Knowledge legacy guidance keeps simple text required/editable with native help associations', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(legacyArticle);
  assert.equal(h.node('modal-article').classList.contains('hidden'), false);
  assert.equal(h.node('f-content').disabled, false);
  assert.equal(h.node('f-content').required, true);
  assert.equal(h.node('f-content').value, legacyArticle.content);
  assert.match(compactText(h.node('f-content-help')), /texto simples.*editável/i);
  assert.match(compactText(h.node('article-editor-help')), /título, categoria e anexo PDF/i);
  assert.equal(h.node('article-cms-link'), null);
  assert.equal(h.node('article-cms-help').hidden, true);
  for (const [id, help] of [['f-title', 'article-editor-help'], ['f-category', 'article-editor-help'], ['f-content', 'f-content-help'], ['f-pdf', 'f-pdf-status']]) {
    assert.ok(h.doc.querySelector(`label[for="${id}"]`), `${id}: native label`);
    assert.ok(h.node(id).getAttribute('aria-describedby').split(/\s+/).includes(help), `${id}: helper association`);
  }
  h.input('f-title', ' Título atualizado '); h.input('f-category', ' Categoria '); h.input('f-content', ' Texto simples atualizado ');
  await h.submit();
  assert.equal(h.latest('/api/knowledge/article-a').options.method, 'PUT');
  assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), { title: 'Título atualizado', category: 'Categoria', content: 'Texto simples atualizado' });
});

test('Knowledge CMS guidance explains disabled body and points to the existing area/document without deep links', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(cmsArticle);
  assert.equal(h.node('f-content').disabled, true);
  assert.equal(h.node('f-content').required, false);
  assert.equal(h.node('f-content').value, '');
  assert.match(compactText(h.node('f-content-help')), /desabilitado.*blocos.*revisões/i);
  assert.match(compactText(h.node('article-cms-help')), /corpo.*blocos.*revisões.*publicar.*agendar/i);
  assert.match(compactText(h.node('article-cms-help')), /Base de Conhecimento.*documento existente/i);
  assert.equal(h.node('article-cms-help').hidden, false);
  assert.equal(h.node('article-cms-link').getAttribute('href'), './cms.html');
  assert.equal(h.node('article-cms-link').hasAttribute('target'), false);
  assert.ok(h.node('f-content').getAttribute('aria-describedby').split(/\s+/).includes('article-cms-help'));
  h.input('f-title', ' Novo título '); h.input('f-category', ' Nova categoria '); h.node('f-content').value = 'Never overwrite CMS';
  await h.submit();
  assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), { title: 'Novo título', category: 'Nova categoria' });
  assert.deepEqual(cmsArticle.content_blocks, blocks);
});

for (const user of [
  { uid: 'user-1', role: 'viewer', permissions: {} },
  { uid: 'user-1', role: 'admin', permissions: { manageAcademy: true } },
  { uid: 'user-1', role: 'viewer', permissions: { manageKnowledge: true } },
]) {
  test(`Knowledge does not offer a CMS helper link to unauthorized ${user.role}/${JSON.stringify(user.permissions)}`, async t => {
    const h = await createKnowledgeEditorialHarness(t, { user });
    await h.showArticle(cmsArticle);
    assert.equal(h.node('article-cms-link'), null);
    assert.equal(h.router.routeAllowed('/cms.html', user) && Boolean(user.permissions.manageKnowledge), false);
  });
}

test('Knowledge superadmin can follow the normal CMS link when the article is clean', async t => {
  const h = await createKnowledgeEditorialHarness(t, { user: { uid: 'user-1', role: 'admin', permissions: { superAdmin: true } } });
  await h.showArticle(cmsArticle);
  await h.followCmsLink();
  assertCmsNavigation(h);
  assert.equal(h.confirms.length, 0);
});

const permissionFlagCases = [
  ['text true', 'true', true, false],
  ['text false', 'false', true, false],
  ['number', 1, true, false],
  ['array', [], true, false],
  ['object', {}, true, false],
  ['boolean true', true, true, true],
  ['boolean false', false, false, false],
  ['null', null, false, false],
  ['absent', undefined, false, false],
];
const cmsLinkPermissionCases = [
  ...['manageKnowledge', 'superAdmin'].flatMap(permission => permissionFlagCases.map(([label, value, frontendAllowed, linkAllowed]) => ({
    label: `${permission}: ${label}`, role: 'admin', permissions: { [permission]: value }, frontendAllowed, linkAllowed,
  }))),
  { label: 'permissions absent', role: 'admin', frontendAllowed: false, linkAllowed: false },
  { label: 'permissions null', role: 'admin', permissions: null, frontendAllowed: false, linkAllowed: false },
  { label: 'both false booleans', role: 'admin', permissions: { manageKnowledge: false, superAdmin: false }, frontendAllowed: false, linkAllowed: false },
  { label: 'both text true', role: 'admin', permissions: { manageKnowledge: 'true', superAdmin: 'true' }, frontendAllowed: true, linkAllowed: false },
  { label: 'both text false', role: 'admin', permissions: { manageKnowledge: 'false', superAdmin: 'false' }, frontendAllowed: true, linkAllowed: false },
  { label: 'strict manager and textual superAdmin', role: 'admin', permissions: { manageKnowledge: true, superAdmin: 'false' }, frontendAllowed: true, linkAllowed: true },
  { label: 'textual manager and strict superAdmin', role: 'admin', permissions: { manageKnowledge: 'false', superAdmin: true }, frontendAllowed: true, linkAllowed: true },
  { label: 'both true booleans', role: 'admin', permissions: { manageKnowledge: true, superAdmin: true }, frontendAllowed: true, linkAllowed: true },
  { label: 'viewer with superAdmin', role: 'viewer', permissions: { superAdmin: true }, frontendAllowed: true, linkAllowed: false },
  { label: 'role absent with both booleans', permissions: { manageKnowledge: true, superAdmin: true }, frontendAllowed: true, linkAllowed: false },
  { label: 'role Admin is not admin', role: 'Admin', permissions: { manageKnowledge: true, superAdmin: true }, frontendAllowed: true, linkAllowed: false },
  { label: 'viewer with both booleans', role: 'viewer', permissions: { manageKnowledge: true, superAdmin: true }, frontendAllowed: true, linkAllowed: false },
];

for (const { label, role, permissions, frontendAllowed, linkAllowed } of cmsLinkPermissionCases) {
  test(`Knowledge editorial link uses strict admin/boolean authorization: ${label}`, async t => {
    const user = { uid: 'user-1', role, permissions };
    const h = await createKnowledgeEditorialHarness(t, { user });
    assert.equal(frontendCan(user, 'manageKnowledge'), frontendAllowed, 'actual auth.js retains the preexisting truthy contract');
    assert.equal(h.context.can(user, 'manageKnowledge'), frontendAllowed, 'the mounted helper double matches auth.js, including text false');
    await h.showArticle(cmsArticle);
    assert.equal(h.node('modal-article').classList.contains('hidden'), !frontendAllowed, 'preexisting edit handlers keep their own gate');
    assert.equal(h.node('article-cms-help').hidden, !linkAllowed);
    const link = h.node('article-cms-link');
    if (linkAllowed) {
      assert.ok(link);
      assert.equal(link.getAttribute('href'), './cms.html');
      assert.equal(link.hasAttribute('target'), false);
      assert.match(compactText(h.node('article-cms-help')), /Base de Conhecimento.*documento existente/);
      await h.followCmsLink();
      assertCmsNavigation(h);
    } else {
      assert.equal(link, null);
      assert.equal(h.node('article-cms-help').textContent, '');
      assert.equal(h.location.pathname, '/knowledge.html');
      assert.deepEqual(h.errors, []);
    }
  });
}

test('Knowledge CMS-to-new and CMS-to-legacy editor transitions reset help without leaking the link', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(cmsArticle);
  assert.ok(h.node('article-cms-link'));
  h.node('modal-article-cancel').click(); await drain();
  h.node('btn-new').click(); await drain();
  assert.equal(h.node('f-content').disabled, false);
  assert.equal(h.node('f-content').required, true);
  assert.equal(h.node('article-cms-link'), null);
  assert.match(compactText(h.node('f-content-help')), /texto simples.*editável/i);
  h.node('modal-article-cancel').click(); await drain();
  await h.showArticle({ ...legacyArticle, id: 'legacy-b' });
  assert.equal(h.node('f-content').value, legacyArticle.content);
  assert.equal(h.node('article-cms-link'), null);
});

test('Knowledge CMS link respects dirty-dialog rejection and accepted discard through the real router', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(cmsArticle);
  h.input('f-title', 'Título não salvo'); h.context.confirmResult = false;
  await h.followCmsLink();
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.node('f-title').value, 'Título não salvo');
  assert.equal(h.page.active, true);
  assert.equal(h.confirms.length, 1);
  h.context.confirmResult = true; await h.followCmsLink();
  assertCmsNavigation(h);
  assert.equal(h.confirms.length, 2);
  assert.equal(h.requests.some(call => call.options.method === 'PUT'), false);
});

test('Knowledge CMS link cannot leave during a save, and a failed save retains body protection/help', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(cmsArticle);
  h.input('f-title', 'Título editado'); await h.submit();
  const save = h.latest('/api/knowledge/article-a');
  await h.followCmsLink();
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.page.active, true);
  assert.equal(h.confirms.length, 0);
  save.reject(new Error('save failed')); await drain();
  assert.equal(h.node('f-content').disabled, true);
  assert.equal(h.node('f-title').disabled, false);
  assert.ok(h.node('article-cms-link'));
  assert.equal(h.node('f-title').value, 'Título editado');
});

test('Knowledge CMS link blocks upload and waits for staged PDF cleanup before leaving', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(cmsArticle);
  const upload = await h.uploadPdf();
  await h.followCmsLink();
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.confirms.length, 0);
  upload.resolve({ id: TEMP_PDF, original_name: 'synthetic.pdf' }); await drain();
  h.context.confirmResult = false; await h.followCmsLink();
  assert.equal(h.requests.filter(call => call.options.method === 'DELETE').length, 0);
  h.context.confirmResult = true; await h.followCmsLink();
  const cleanup = h.latest(`/api/cms/assets/${TEMP_PDF}`);
  assert.equal(cleanup.options.method, 'DELETE');
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.page.active, true);
  cleanup.resolve({ deleted: true }); await drain();
  assertCmsNavigation(h);
});

test('Knowledge CMS link keeps the editor and retryable PDF when discard cleanup fails', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(cmsArticle);
  (await h.uploadPdf()).resolve({ id: TEMP_PDF, original_name: 'synthetic.pdf' }); await drain();
  const link = h.node('article-cms-link');
  link.focus();
  await h.followCmsLink();
  h.latest(`/api/cms/assets/${TEMP_PDF}`).reject(new Error('cleanup failed')); await drain();
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.page.active, true);
  assert.match(h.node('f-pdf-status').textContent, /Não foi possível remover/);
  assert.equal(h.node('f-content').disabled, true);
  assert.equal(h.node('article-cms-link'), link, 'a busy-state refresh does not replace the focused link');
  assert.equal(h.doc.activeElement, link);
  await h.followCmsLink();
  assert.equal(h.requests.filter(call => call.options.method === 'DELETE').length, 2);
  h.latest(`/api/cms/assets/${TEMP_PDF}`).resolve({ deleted: true }); await drain();
  assertCmsNavigation(h);
});

for (const action of ['keep', 'remove', 'replace']) {
  test(`Knowledge CMS PDF ${action} only alters its own attachment fields, not body/blocks`, async t => {
    const h = await createKnowledgeEditorialHarness(t);
    const article = { ...cmsArticle, content_blocks: [...blocks, { type: 'pdf', asset_id: PDF, title: 'PDF original' }] };
    const before = structuredClone(article);
    await h.showArticle(article);
    h.latest(`/api/cms/assets/${PDF}`).resolve('blob:private-pdf'); await drain();
    if (action === 'remove') { h.node('f-pdf-remove').click(); await drain(); }
    if (action === 'replace') { (await h.uploadPdf()).resolve({ id: TEMP_PDF, original_name: 'replacement.pdf' }); await drain(); }
    await h.submit();
    assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), {
      title: article.title, category: article.category,
      ...(action === 'remove' ? { pdf_asset_id: null } : {}),
      ...(action === 'replace' ? { pdf_asset_id: TEMP_PDF, pdf_title: 'replacement.pdf' } : {}),
    });
    assert.deepEqual(article, before);
    assert.equal(h.requests.some(call => call.path === `/api/cms/assets/${PDF}` && call.options.method === 'DELETE'), false, 'never delete an existing referenced asset from this editor');
  });
}

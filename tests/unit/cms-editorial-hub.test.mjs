import assert from 'node:assert/strict';
import test from 'node:test';
import { createMountedHarness, drain } from '../helpers/cms-harness.mjs';

const cases = [
  ['manageKnowledge', ['Base de Conhecimento', 'Owner News'], 'knowledge', '/api/knowledge?'],
  ['manageAcademy', ['Academy', 'Academy — Aulas'], 'academy', '/api/academy?'],
  ['manageBenefits', ['Benefícios'], 'benefit', '/api/benefits?'],
  ['manageReminders', ['Lembretes'], 'reminder', '/api/reminders?'],
];
for (const [permission, labels, type, endpoint] of cases) {
  test(`central CMS: ${permission} shows only authorized areas and binds an existing record`, async t => {
    const h = await createMountedHarness('cms', { user: { permissions: { [permission]: true } } });
    t.after(() => h.page.dispose());
    h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
    assert.deepEqual(h.node('content-types').querySelectorAll('button').map(node => node.textContent), labels);
    h.node('new-document').click();
    const source = h.latest(endpoint); assert.ok(source); assert.equal(source.options.method, undefined);
    source.resolve({ data: [{ id: 'existing-record', title: 'Registro sintético existente' }], total: 1 }); await drain();
    assert.equal(h.node('new-source-field').hidden, false);
    assert.equal(h.node('new-source').required, true);
    assert.equal(h.node('new-source').querySelectorAll('option').at(-1).value, 'existing-record');
    h.input(h.node('new-title'), 'Conteúdo sintético'); h.input(h.node('new-source'), 'existing-record');
    h.submit('new-document-form');
    const creation = h.latest('/api/cms/documents');
    assert.equal(creation.options.method, 'POST');
    assert.deepEqual(JSON.parse(creation.options.body), { type, title: 'Conteúdo sintético', category: '', source_id: 'existing-record' });
    assert.equal(h.page.canLeave(), false, 'pending creation blocks departure');
    assert.equal(h.requests.filter(request => request.options.method === 'POST' && !request.path.startsWith('/api/cms/')).length, 0, 'central does not create domain entities');
  });
}

test('Academy lesson content selects an existing lesson and distinguishes publication from activation', async t => {
  const h = await createMountedHarness('cms', { user: { permissions: { manageAcademy: true } } });
  t.after(() => h.page.dispose());
  h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
  h.node('content-types').querySelectorAll('button').find(node => node.textContent === 'Academy — Aulas').click();
  h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
  h.node('new-document').click();
  h.latest('/api/academy/lessons?').resolve({ data: [], total: 0 }); await drain();
  assert.match(h.node('cms-publication-help').textContent, /não ativa o curso, módulo ou aula/);
  assert.match(h.node('cms-source-help').textContent, /registro existente/);
  assert.equal(h.node('preview-root').parentNode, h.doc.querySelector('.cms-preview'));
});

test('Payload entry is shown only when Owner News is activated and the runtime is ready', async t => {
  for (const [authority, expectedLink, expectedMessage] of [
    [{ mode: 'legacy', epoch: 1, runtimeReady: true }, true, /não foi ativada/],
    [{ mode: 'payload', epoch: 2, runtimeReady: false }, true, /runtime não respondeu/],
    [{ mode: 'payload', epoch: 2, runtimeReady: true }, false, /respondeu à verificação/],
  ]) {
    const h = await createMountedHarness('cms', { user: { permissions: { manageKnowledge: true } }, authority });
    t.after(() => h.page.dispose());
    h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
    h.node('content-types').querySelectorAll('button').find(node => node.textContent === 'Owner News').click();
    h.latest('/documents?type=announcement').resolve({ data: [], total: 0 }); await drain();
    assert.equal(h.node('owner-news-authority').hidden, false);
    assert.equal(h.node('owner-news-payload-entry').hidden, expectedLink);
    assert.match(h.node('owner-news-authority-status').textContent, expectedMessage);
  }
});

test('Payload availability failure preserves known legacy authority but never falls back when authority is unknown or Payload is active', async t => {
  const document = { id: 'news-route-check', title: 'Matéria sintética', content_type: 'announcement', draft_revision_id: 'draft-route-check' };
  const cases = [
    ['legacy authority with unavailable runtime probe', { authority: { mode: 'legacy', epoch: 1 }, availabilityFailure: true }, true],
    ['unreadable authority with a legacy-shaped probe', { authority: { mode: 'legacy', epoch: 1 }, authorityFailure: true }, false],
    ['newer Payload probe must not fall back to a stale legacy authority snapshot', { authority: { mode: 'legacy', epoch: 1 },
      availabilityOverride: { mode: 'payload', epoch: 2, activated: true, runtimeReady: false, canEnter: false } }, false],
    ['payload authority with unavailable runtime probe', { authority: { mode: 'payload', epoch: 2 }, availabilityFailure: true }, false],
    ['payload_frozen authority with unavailable runtime probe', { authority: { mode: 'payload_frozen', epoch: 3 }, availabilityFailure: true }, false],
  ];
  for (const [label, options, editable] of cases) {
    const h = await createMountedHarness('cms', { user: { permissions: { manageKnowledge: true } }, ...options });
    t.after(() => h.page.dispose());
    h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
    h.node('content-types').querySelectorAll('button').find(node => node.textContent === 'Owner News').click();
    h.latest('/documents?type=announcement').resolve({ data: [document], total: 1 }); await drain();
    assert.equal(h.node('owner-news-payload-entry').hidden, true, label);
    h.node('document-list').querySelector('button').click();
    h.latest('/api/cms/documents/news-route-check').resolve({ document, draft: { blocks: [{ type: 'paragraph', text: 'Corpo sintético.' }] } });
    await drain();
    assert.equal(h.editorCallbacks.length > 0, editable, label);
    assert.equal(h.node('save-draft').disabled, !editable, label);
    if (editable) assert.match(h.node('owner-news-authority-status').textContent, /edição pelo CMS central permanece disponível/);
    else assert.match(h.node('editor-root').textContent, /somente leitura/);
  }
});

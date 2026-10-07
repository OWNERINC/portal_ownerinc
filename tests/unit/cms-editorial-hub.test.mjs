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

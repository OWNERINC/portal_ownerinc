import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createFeedbackHarness, drain } from '../helpers/frontend-feedback-harness.mjs';

test('real Benefits mount groups successful API results, renders content, and keeps filters and pagination', async () => {
  const h = await createFeedbackHarness('benefits', { mount: false });
  const paginationSource = (await readFile('public/js/pagination.js', 'utf8')).replace(/^export /gm, '');
  vm.runInContext(paginationSource, h.context, { filename: 'public/js/pagination.js' });

  const source = (await readFile('public/js/benefits.js', 'utf8'))
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.mountBenefits = mount;`, h.context, { filename: 'public/js/benefits.js' });
  h.context.mountBenefits(h.page);

  const listing = h.latest('/api/benefits?');
  const categoryRequest = h.latest('/api/benefits/categories');
  assert.ok(listing);
  assert.equal(listing.path, '/api/benefits?active=true&limit=20&offset=0');
  assert.ok(categoryRequest);

  categoryRequest.resolve(['Alimentação', 'Viagens']);
  await drain();
  assert.match(h.node('benefits-content').textContent, /Carregando benefícios/,
    'the catalog remains loading until both server responses are ready');

  listing.resolve({
    total: 21,
    data: [
      {
        id: 'benefit-cafe', company: 'Café Aurora', category: 'Alimentação', active: true,
        description: 'Descrição legada do café.', instructions: 'Apresente seu crachá na compra.',
        content_blocks: [{ type: 'paragraph', text: 'Desconto de 15% em cafés e refeições.' }],
      },
      {
        id: 'benefit-hotel', company: 'Pousada Vale', category: 'Viagens', active: true,
        description: 'Hospedagem com tarifa para colaboradores.', instructions: 'Informe o convênio ao reservar.',
        content_blocks: [],
      },
      {
        id: 'benefit-general', company: 'Loja Geral', category: '', active: true,
        description: 'Vantagens gerais da loja.', instructions: '', content_blocks: [],
      },
      {
        id: 'benefit-inactive', company: 'Oferta inativa', category: 'Oculta', active: false,
        description: 'Não deve aparecer.', instructions: '', content_blocks: [],
      },
    ],
  });
  await h.page.ready();

  const content = h.node('benefits-content');
  assert.deepEqual([...content.querySelectorAll('.content-section h2')].map(heading => heading.textContent), [
    'Alimentação', 'Viagens', 'Geral',
  ]);
  assert.match(content.textContent, /Café Aurora/);
  assert.match(content.textContent, /Desconto de 15% em cafés e refeições\./);
  assert.match(content.textContent, /Apresente seu crachá na compra\./);
  assert.match(content.textContent, /Pousada Vale/);
  assert.match(content.textContent, /Hospedagem com tarifa para colaboradores\./);
  assert.match(content.textContent, /Loja Geral/);
  assert.doesNotMatch(content.textContent, /Oferta inativa|Não deve aparecer/);
  assert.deepEqual([...h.node('benefits-filters').querySelectorAll('button')].map(button => button.textContent), [
    'Todos', 'Alimentação', 'Viagens',
  ]);
  assert.match(h.node('benefits-pagination').textContent, /Página 1 de 2/);
  assert.equal(h.node('benefits-content').querySelector('.empty-state'), null,
    'successful API responses replace the loading state with visible benefits');

  h.page.dispose();
});

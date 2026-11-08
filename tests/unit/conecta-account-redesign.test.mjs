import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminUIHarness, manager, superadmin } from '../helpers/admin-ui-harness.mjs';

test('responsive user rows retain header associations, safe text and protected account controls', async t => {
  const h = await createAdminUIHarness(t, { user: manager });
  await h.catalog();
  const name = '<img src=x onerror=alert(1)> Conta protegida';
  await h.resolve(h.latest('/api/users?'), [{ ...superadmin, uid: 'protected-target', name }], 1);
  const table = h.node('users-tbody').closest('table');
  const labels = [...table.querySelectorAll('th')].map(node => node.textContent.trim());
  const row = h.node('users-tbody').querySelector('tr');
  assert.equal(row.getAttribute('role'), 'row');
  const cells = [...row.querySelectorAll('td')];
  assert.deepEqual(cells.map(node => node.getAttribute('data-label')), labels);
  assert.ok(cells.every(node => node.getAttribute('role') === 'cell'));
  assert.equal(cells[0].textContent, name);
  assert.equal(row.querySelector('img'), null, 'responsive metadata does not turn data into HTML');
  const buttons = [...row.querySelectorAll('button')];
  assert.ok(buttons.find(node => node.textContent === 'Editar').disabled);
  assert.ok(buttons.find(node => node.textContent === 'Desativar').disabled);
  assert.equal(buttons.some(node => node.textContent === 'Anonimizar'), false);
  assert.match(row.textContent, /Somente um superadministrador/);
});

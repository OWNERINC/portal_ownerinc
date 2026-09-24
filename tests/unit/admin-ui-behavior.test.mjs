import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile('public/js/bulk-preview-state.js', 'utf8');
const { createBulkPreviewState } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('prévia CSV rejeita resposta de seleção obsoleta', () => {
  const state = createBulkPreviewState(); const a = {}; const b = {};
  state.select(a); const ta = state.begin(); state.select(b);
  assert.equal(state.accept(ta, { rows: [{ email: 'a@test' }] }), false);
  assert.deepEqual(state.confirmedRows(), []);
  const tb = state.begin(); assert.equal(state.accept(tb, { rows: [{ email: 'b@test' }] }), true);
  assert.equal(state.confirmedRows()[0].email, 'b@test');
  state.begin(); assert.deepEqual(state.confirmedRows(), []);
});


test('preview obsoleta nao limpa a selecao B quando A falha depois', async () => {
  const state = createBulkPreviewState(); const a = {}; const b = {};
  let rejectA;
  const requestA = new Promise((_, reject) => { rejectA = reject; });
  state.select(a); const ticketA = state.begin();
  state.select(b); const ticketB = state.begin();
  rejectA(new Error('A falhou'));
  await assert.rejects(requestA, /A falhou/);
  assert.equal(state.current(ticketA), false);
  assert.equal(state.current(ticketB), true);
  assert.deepEqual(state.confirmedRows(), []);
  assert.equal(state.accept(ticketB, { rows: [{ email: 'b@test' }] }), true);
  assert.equal(state.confirmedRows()[0].email, 'b@test');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';

const card = (id = 'card-a') => ({ id, name: `Convite ${id}`, template: 'convite_owner', updatedAt: '2026-09-29T12:00:00Z' });
async function mounted(t) {
  const h = await createFeedbackHarness('cards-pos', { expose: 'globalThis.historyProbe = { duplicateCard, deleteCard, pending: () => historyMutation !== null };' }); t.after(() => h.page.dispose());
  h.node('status').textContent = 'Mensagem do editor.';
  h.node('mediaStatus').textContent = 'Falha da foto anterior.';
  h.doc.querySelector('[data-view="history"]').click();
  return h;
}
const query = h => h.latest('/api/pos-cards/cards?');
async function resolve(h, data, total = data.length) { query(h).resolve({ data, total }); await drain(); }
const action = (h, label, container = 'historyEmpty') => h.node(container).querySelectorAll('button').find(button => button.textContent === label);
async function attemptMutations(h, id) {
  // Do not await the operations: a regressed guard would otherwise leave the
  // assertion hanging on a second transport request instead of failing it.
  h.context.historyProbe.duplicateCard(id);
  h.context.historyProbe.deleteCard(id);
  await drain();
}

test('history has one live state, distinguishes an empty library from no matches, and clears search at offset zero', async t => {
  const h = await mounted(t);
  assert.equal(h.node('history-status').textContent, 'Carregando convites...');
  assert.equal(h.node('historyEmpty').textContent, '');
  assert.equal(h.node('historyList').getAttribute('aria-busy'), 'true');
  await resolve(h, []);
  assert.equal(h.node('history-status').textContent, 'Nenhum convite salvo ainda.');
  assert.equal(h.node('historyView').querySelectorAll('[role="status"]').length, 1);
  assert.equal(h.node('historyEmpty').textContent, 'Criar convite');
  h.input('historySearch', 'Gramado'); await resolve(h, []);
  assert.equal(h.node('history-status').textContent, 'Nenhum convite encontrado para esta busca.');
  const clear = action(h, 'Limpar busca'); assert.ok(clear);
  clear.click(); assert.equal(h.node('historySearch').value, '');
  const url = new URL(query(h).path, 'https://portal.test');
  assert.equal(url.searchParams.get('search'), ''); assert.equal(url.searchParams.get('offset'), '0');
  assert.equal(h.doc.activeElement, h.node('historySearch'));
  await resolve(h, [card()]);
  assert.equal(h.node('history-status').textContent, '1 convite(s) encontrado(s).');
  assert.equal(h.node('historyEmpty').classList.contains('hidden'), true);
  assert.equal(h.node('status').textContent, 'Mensagem do editor.');
  assert.equal(h.node('mediaStatus').textContent, 'Falha da foto anterior.');
  const count = h.requests.length; clear.click(); assert.equal(h.requests.length, count);
});

for (const outcome of ['success', 'failure']) test(`history ignores stale ${outcome}, old row actions and pagination while another query loads`, async t => {
  const h = await mounted(t); await resolve(h, [card()], 120);
  const row = h.node('historyList').querySelector('[data-delete]');
  const next = action(h, 'Próxima', 'historyPagination');
  h.input('historySearch', 'old'); const old = query(h);
  assert.equal(h.node('historyList').children.length, 0); assert.equal(h.node('historyPagination').children.length, 0);
  h.node('historyList').dispatchEvent(new TestEvent('click', { target: row }));
  h.node('historyPagination').dispatchEvent(new TestEvent('click', { target: next }));
  assert.equal(h.requests.filter(item => item.options.method).length, 0);
  h.input('historySearch', 'new'); const current = query(h);
  if (outcome === 'success') old.resolve({ data: [card('old')], total: 80 }); else old.reject(new Error('old failure'));
  await drain(); assert.equal(h.node('history-status').textContent, 'Carregando convites...');
  assert.equal(h.node('historyList').getAttribute('aria-busy'), 'true');
  current.resolve({ data: [card('new')], total: 1 }); await drain();
  assert.match(h.node('historyList').textContent, /Convite new/);
  assert.doesNotMatch(h.node('historyList').textContent, /Convite old/);
  assert.equal(h.node('history-status').classList.contains('is-error'), false);
});

test('history failure retries its submitted snapshot and a detached retry cannot restart a later query', async t => {
  const h = await mounted(t); await resolve(h, []);
  h.input('historySearch', 'Gramado & serra'); const failedPath = query(h).path;
  query(h).reject(new Error('private upstream details')); await drain();
  assert.equal(h.node('history-status').textContent, 'Não foi possível carregar o histórico.');
  const retry = action(h, 'Tentar novamente'); assert.ok(retry);
  h.node('historySearch').value = 'not submitted'; retry.click();
  assert.equal(query(h).path, failedPath);
  await resolve(h, [card()]); const count = h.requests.length; retry.click(); assert.equal(h.requests.length, count);
  assert.equal(h.node('status').textContent, 'Mensagem do editor.');
  assert.equal(h.node('mediaStatus').textContent, 'Falha da foto anterior.');
});

test('a disappearing last page recovers the same query before announcing an empty catalog', async t => {
  const h = await mounted(t); await resolve(h, [card()], 101);
  h.input('historySearch', 'Gramado'); await resolve(h, [card()], 101);
  action(h, 'Próxima', 'historyPagination').click(); await resolve(h, [card('page-2')], 101);
  action(h, 'Próxima', 'historyPagination').click();
  assert.match(query(h).path, /offset=100$/);
  await resolve(h, [], 51);
  assert.match(query(h).path, /search=Gramado&limit=50&offset=50$/);
  assert.equal(h.node('history-status').textContent, 'Carregando convites...');
  await resolve(h, [card('last')], 51);
  assert.match(h.node('historyList').textContent, /Convite last/);
  assert.match(h.node('historyPagination').textContent, /Página 2 de 2/);
  // A total of zero on a nonzero page must also recheck page zero.
  h.input('historySearch', 'Gramado'); await resolve(h, [card()], 51);
  action(h, 'Próxima', 'historyPagination').click(); await resolve(h, [], 0);
  assert.match(query(h).path, /offset=0$/); assert.doesNotMatch(h.node('history-status').textContent, /Nenhum/);
  await resolve(h, [], 0); assert.match(h.node('history-status').textContent, /para esta busca/);
});

for (const mutation of ['copy', 'delete']) test(`${mutation} still announces action feedback, and a refresh error is not overwritten by success`, async t => {
  const h = await mounted(t); await resolve(h, [card()]);
  h.node('historyList').querySelector(`[data-${mutation}]`).click();
  assert.match(h.node('history-status').textContent, mutation === 'copy' ? /Duplicando/ : /Excluindo/);
  h.requests.at(-1).resolve(mutation === 'copy' ? card('copy') : null); await drain();
  await resolve(h, [card('after')]);
  assert.equal(h.node('history-status').textContent, mutation === 'copy' ? 'Convite duplicado.' : 'Convite excluído.');
  assert.equal(h.node('mediaStatus').textContent, 'Falha da foto anterior.');
  h.node('historyList').querySelector(`[data-${mutation}]`).click();
  h.requests.at(-1).resolve(null); await drain(); query(h).reject(new Error('offline')); await drain();
  assert.equal(h.node('history-status').textContent, 'Não foi possível carregar o histórico.');
  assert.ok(action(h, 'Tentar novamente'));
  assert.equal(h.context.historyProbe.pending(), false);
  action(h, 'Tentar novamente').click(); await resolve(h, [card('retry')]);
  assert.equal(h.node('historyList').querySelectorAll('button').some(button => button.disabled), false);
});

for (const outcome of ['success', 'failure']) test(`a new history query stays authoritative during mutation ${outcome} and its actions are unlocked safely`, async t => {
  const h = await mounted(t); await resolve(h, [card('a'), card('b')]);
  h.node('historyList').querySelector('[data-delete="a"]').click(); const pending = h.requests.at(-1);
  h.input('historySearch', 'new'); await resolve(h, [card('a'), card('b')], 60);
  action(h, 'Próxima', 'historyPagination').click(); await resolve(h, [card('a'), card('b')], 60);
  assert.equal(h.node('historyList').querySelectorAll('button').every(button => button.disabled), true);
  await attemptMutations(h, 'b');
  assert.equal(h.requests.filter(item => item.options.method).length, 1);
  const count = h.requests.length;
  if (outcome === 'success') {
    pending.resolve(null); await drain();
    assert.equal(h.requests.length, count + 1, 'a committed deletion refreshes the latest query, not the old filter');
    assert.match(query(h).path, /search=new&limit=50&offset=50$/);
    await resolve(h, [card('b')], 59);
    assert.doesNotMatch(h.node('historyList').textContent, /Convite a/);
  } else {
    pending.reject(new Error('failure from a previous query')); await drain();
    assert.equal(h.requests.length, count);
    assert.doesNotMatch(h.node('history-status').textContent, /failure from a previous query/);
  }
  assert.match(h.node('history-status').textContent, /convite\(s\) encontrado\(s\)/);
  assert.equal(h.context.historyProbe.pending(), false);
  assert.equal(h.node('historyList').querySelectorAll('button').some(button => button.disabled), false);
  assert.equal(h.node('mediaStatus').textContent, 'Falha da foto anterior.');
});

for (const first of ['copy', 'delete']) for (const outcome of ['success', 'failure']) for (const secondOutcome of ['success', 'failure']) {
  test(`history serializes two different IDs through ${first} ${outcome} then ${secondOutcome}, including the awaited refresh`, async t => {
    const h = await mounted(t); await resolve(h, [card('a'), card('b')]);
    const firstButton = h.node('historyList').querySelector(`[data-${first}="a"]`);
    const second = first === 'copy' ? 'delete' : 'copy';
    const secondButton = h.node('historyList').querySelector(`[data-${second}="b"]`);
    firstButton.click(); const pending = h.requests.at(-1);
    assert.equal(h.context.historyProbe.pending(), true);
    assert.equal(h.node('historyList').querySelectorAll('button').every(button => button.disabled), true);
    secondButton.click();
    h.node('historyList').dispatchEvent(new TestEvent('click', { target: secondButton }));
    await attemptMutations(h, 'b');
    assert.equal(h.requests.filter(item => item.options.method).length, 1, 'both function guards must reject a second ID');
    if (outcome === 'success') {
      pending.resolve(first === 'copy' ? card('copy') : null); await drain();
      assert.equal(h.page.busy, false, 'the transport mutation is over while the refresh is still pending');
      assert.equal(h.page.canLeave(), false, 'the history guard covers the refresh, not just page.busy');
      const unload = new TestEvent('beforeunload'); h.window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
      await attemptMutations(h, 'b');
      assert.equal(h.requests.filter(item => item.options.method).length, 1);
      await resolve(h, first === 'delete' ? [card('b')] : [card('a'), card('b'), card('copy')]);
      assert.equal(h.node('history-status').textContent, first === 'copy' ? 'Convite duplicado.' : 'Convite excluído.');
    } else {
      pending.reject(new Error('Primeira ação falhou.')); await drain();
      assert.equal(h.node('history-status').textContent, 'Primeira ação falhou.');
    }
    assert.equal(h.context.historyProbe.pending(), false);
    assert.equal(h.node('historyList').querySelectorAll('button').some(button => button.disabled), false);
    assert.equal(h.page.canLeave(), true);
    h.node('historyList').querySelector(`[data-${second}="b"]`).click();
    assert.equal(h.requests.filter(item => item.options.method).length, 2);
    if (secondOutcome === 'success') {
      h.requests.at(-1).resolve(second === 'copy' ? card('copy-b') : null); await drain();
      assert.equal(h.context.historyProbe.pending(), true);
      await attemptMutations(h, 'a');
      assert.equal(h.requests.filter(item => item.options.method).length, 2);
      const remaining = [card('a'), card('b')].filter(row => row.id !== (second === 'delete' ? 'b' : outcome === 'success' ? 'a' : ''));
      if (first === 'copy' && outcome === 'success') remaining.push(card('copy'));
      if (second === 'copy') remaining.push(card('copy-b'));
      await resolve(h, remaining);
      assert.equal(h.node('history-status').textContent, second === 'copy' ? 'Convite duplicado.' : 'Convite excluído.');
      if (second === 'delete') assert.doesNotMatch(h.node('historyList').textContent, /Convite b/);
      else assert.match(h.node('historyList').textContent, /Convite copy-b/);
    } else {
      h.requests.at(-1).reject(new Error('Segunda ação falhou.')); await drain();
      assert.equal(h.node('history-status').textContent, 'Segunda ação falhou.', 'the second failure is not discarded by the first refresh token');
    }
    assert.equal(h.context.historyProbe.pending(), false);
    assert.equal(h.node('historyList').querySelectorAll('button').some(button => button.disabled), false);
    assert.equal(h.node('mediaStatus').textContent, 'Falha da foto anterior.');
  });
}

for (const outcome of ['success', 'failure']) for (const order of ['refresh-first', 'search-first']) {
  test(`a superseded ${outcome} refresh settles ${order} without stranding or unlocking another history mutation`, async t => {
    const h = await mounted(t); await resolve(h, [card('a'), card('b')]);
    h.node('historyList').querySelector('[data-delete="a"]').click();
    h.requests.at(-1).resolve(null); await drain(); const refresh = query(h);
    h.input('historySearch', 'new'); const search = query(h);
    const settleRefresh = async () => {
      if (outcome === 'success') refresh.resolve({ data: [card('obsolete')], total: 1 });
      else refresh.reject(new Error('obsolete refresh error'));
      await drain();
    };
    if (order === 'refresh-first') {
      await settleRefresh();
      assert.equal(h.context.historyProbe.pending(), false);
      assert.equal(h.node('historyList').getAttribute('aria-busy'), 'true');
      await attemptMutations(h, 'b');
      assert.equal(h.requests.filter(item => item.options.method).length, 1, 'the latest query is still loading');
      search.resolve({ data: [card('b')], total: 1 }); await drain();
    } else {
      search.resolve({ data: [card('b')], total: 1 }); await drain();
      assert.equal(h.context.historyProbe.pending(), true);
      assert.equal(h.node('historyList').querySelectorAll('button').every(button => button.disabled), true);
      await attemptMutations(h, 'b');
      assert.equal(h.requests.filter(item => item.options.method).length, 1);
      await settleRefresh();
    }
    assert.equal(h.context.historyProbe.pending(), false);
    assert.equal(h.node('historyList').getAttribute('aria-busy'), 'false');
    assert.equal(h.node('historyList').querySelectorAll('button').some(button => button.disabled), false);
    assert.doesNotMatch(h.node('historyList').textContent, /obsolete/);
    assert.equal(h.node('history-status').textContent, '1 convite(s) encontrado(s).');
    h.node('historyList').querySelector('[data-copy="b"]').click(); await drain();
    assert.equal(h.context.historyProbe.pending(), true);
    assert.equal(h.node('historyList').querySelectorAll('button').every(button => button.disabled), true);
    assert.equal(h.requests.filter(item => item.options.method).length, 2);
    h.requests.at(-1).reject(new Error('Current action failed.')); await drain();
    assert.equal(h.node('history-status').textContent, 'Current action failed.');
    assert.equal(h.node('mediaStatus').textContent, 'Falha da foto anterior.');
  });
}

test('cancelled history deletion releases its own guard without a request or disabling later actions', async t => {
  const h = await mounted(t); await resolve(h, [card('a'), card('b')]);
  h.window.confirm = () => false;
  h.node('historyList').querySelector('[data-delete="a"]').click(); await drain();
  assert.equal(h.requests.filter(item => item.options.method).length, 0);
  assert.equal(h.context.historyProbe.pending(), false);
  assert.equal(h.node('historyList').querySelectorAll('button').some(button => button.disabled), false);
  h.node('historyList').querySelector('[data-copy="b"]').click();
  assert.equal(h.requests.filter(item => item.options.method).length, 1);
});

for (const stage of ['write', 'refresh']) for (const outcome of ['success', 'failure']) test(`disposing history during ${stage} releases its guard and late ${outcome} cannot unlock a new mount`, async t => {
  const old = await mounted(t); await resolve(old, [card('a')]);
  old.node('historyList').querySelector('[data-copy="a"]').click(); let pending = old.requests.at(-1);
  if (stage === 'refresh') { pending.resolve(card('copy')); await drain(); pending = query(old); }
  const current = await mounted(t); await resolve(current, [card('b')]);
  current.node('historyList').querySelector('[data-delete="b"]').click();
  // Model synchronous disposal and DOM replacement before the old finally runs.
  old.page.dispose();
  old.context.document = current.doc;
  assert.equal(old.context.historyProbe.pending(), false);
  assert.equal(pending.options.signal.aborted, true);
  if (outcome === 'success') pending.resolve(stage === 'write' ? card('copy') : { data: [card('copy')], total: 1 });
  else pending.reject(new Error('Late operation failed.'));
  await drain();
  const count = old.requests.length;
  await attemptMutations(old, 'a'); assert.equal(old.requests.length, count);
  assert.equal(current.context.historyProbe.pending(), true);
  assert.equal(current.node('historyList').querySelectorAll('button').every(button => button.disabled), true);
  assert.equal(current.node('history-status').textContent, 'Excluindo convite...');
  current.requests.at(-1).resolve(null); await drain(); await resolve(current, []);
  assert.equal(current.context.historyProbe.pending(), false);
});

test('history leave/disposal invalidates late responses without overwriting editor feedback', async t => {
  const h = await mounted(t); const pending = query(h);
  h.doc.querySelector('[data-view="editor"]').click();
  pending.reject(new Error('late')); await drain();
  assert.equal(h.node('status').textContent, 'Mensagem do editor.');
  h.doc.querySelector('[data-view="history"]').click(); const disposed = query(h);
  const before = h.node('history-status').textContent;
  h.page.dispose(); assert.equal(disposed.options.signal.aborted, true);
  disposed.resolve({ data: [card('late')], total: 1 }); await drain();
  assert.equal(h.node('history-status').textContent, before);
  assert.equal(h.node('historyList').children.length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMountedHarness, drain, TestEvent } from '../helpers/cms-harness.mjs';

const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const poll = (status = 'draft', version = 1) => ({ id: 'poll-a', title: 'Enquete sintética', question: 'Qual tema?', description: '', closing: '', status, version,
  options: [{ id: `a-${version}`, label: 'Cultura', votes: 0, percentage: 0 }, { id: `b-${version}`, label: 'Pessoas', votes: 0, percentage: 0 }], total_votes: 0 });
async function setup(t, rows = [poll()]) {
  const h = await createMountedHarness();
  t.after(() => h.page.dispose());
  h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
  button(h.node('content-types'), 'Owner News').click();
  h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
  button(h.node('owner-news-sections'), 'Enquetes').click();
  h.latest('/polls?').resolve({ data: rows, total: rows.length }); await drain();
  h.root = h.node('owner-news-settings');
  return h;
}
test('saved draft uses server version; dirty guard and conflict preserve local inputs', async t => {
  const h = await setup(t);
  button(h.root, 'Enquete sintética · Rascunho').click();
  h.input(h.root.querySelector('[name="question"]'), 'Pergunta local');
  assert.equal(button(h.root, 'Publicar enquete').disabled, true);
  assert.equal(h.page.canLeave(), false);
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  assert.equal(JSON.parse(h.latest('/draft').options.body).expected_version, 1);
  h.latest('/draft').reject(Object.assign(new Error(), { status: 409, reason: 'version_conflict' })); await drain();
  assert.equal(h.root.querySelector('[name="question"]').value, 'Pergunta local');
  assert.equal(button(h.root, 'Publicar enquete').disabled, true);
  h.context.confirmResult = true;
  button(h.root, 'Recarregar versão atual').click();
  h.latest('/polls?').resolve({ data: [poll('draft', 4)], total: 1 }); await drain();
  button(h.root, 'Publicar enquete').click();
  assert.deepEqual(JSON.parse(h.latest('/publish').options.body), { expected_version: 4 });
  h.latest('/publish').resolve(poll('open', 5)); await drain();
  assert.equal(h.root.querySelector('form'), null);
  assert.ok(button(h.root, 'Encerrar enquete'));
});
test('closed is read only and copying starts unsaved without votes or id', async t => {
  const h = await setup(t, [poll('closed', 3)]);
  button(h.root, 'Enquete sintética · Encerrada').click();
  assert.equal(h.root.querySelector('input'), null);
  assert.equal(button(h.root, 'Publicar enquete'), undefined);
  button(h.root, 'Criar nova enquete').click();
  assert.equal(button(h.root, 'Publicar enquete').disabled, true);
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  const save = h.latest('/polls');
  assert.equal(save.options.method, 'POST');
  assert.equal(JSON.parse(save.options.body).expected_version, undefined);
  save.resolve({ ...poll(), id: 'copy' }); await drain();
  assert.equal(h.page.canLeave(), true);
});
test('403 removes management and late response after disposal cannot restore the panel', async t => {
  const h = await setup(t);
  button(h.node('owner-news-sections'), 'Matérias').click();
  button(h.node('owner-news-sections'), 'Enquetes').click();
  h.latest('/polls?').reject(Object.assign(new Error(), { status: 403 })); await drain();
  assert.equal(h.root.querySelector('button'), null);
  assert.match(h.root.textContent, /permissão/);
  button(h.node('owner-news-sections'), 'Matérias').click();
  button(h.node('owner-news-sections'), 'Enquetes').click();
  const pending = h.latest('/polls?');
  button(h.node('owner-news-sections'), 'Matérias').click();
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve({ data: [poll()], total: 1 }); await drain();
  assert.equal(h.root.children.length, 0);
});

test('option order, limits, duplicate validation, retries and regenerated saved DTO are authoritative', async t => {
  const h = await setup(t);
  button(h.root, 'Enquete sintética · Rascunho').click();
  assert.equal(button(h.root, 'Remover').disabled, true);
  button(h.root, 'Adicionar opção').click();
  h.input(h.root.querySelectorAll('[name="option"]')[2], 'Cultura');
  assert.equal(button(h.root, 'Salvar rascunho').disabled, true);
  h.input(h.root.querySelectorAll('[name="option"]')[2], 'Terceira');
  const stale = h.root.querySelectorAll('.cms-poll-option')[2].querySelector('button');
  stale.click(); stale.click();
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  const save = h.latest('/draft');
  assert.deepEqual(JSON.parse(save.options.body).options, ['Cultura', 'Terceira', 'Pessoas']);
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  assert.equal(h.matching('/draft').length, 1);
  assert.equal(h.page.canLeave(), false);
  save.reject(new Error('offline')); await drain();
  assert.equal(h.root.querySelectorAll('[name="option"]')[1].value, 'Terceira');
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  h.latest('/draft').resolve(poll('draft', 8)); await drain();
  assert.equal(h.root.querySelectorAll('[name="option"]').length, 2);
  assert.equal(h.page.canLeave(), true);
  assert.equal(h.context.canLeavePageUI(), true);
  h.input(h.root.querySelector('[name="question"]'), 'Outro tema?');
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  assert.equal(JSON.parse(h.latest('/draft').options.body).expected_version, 8);
  h.latest('/draft').resolve(poll('draft', 9)); await drain();
  for (let index = 0; index < 4; index++) button(h.root, 'Adicionar opção').click();
  assert.equal(h.root.querySelectorAll('[name="option"]').length, 6);
  assert.equal(button(h.root, 'Adicionar opção').disabled, true);
});

test('active_poll_exists fetches current poll, preserves draft and never closes it automatically', async t => {
  const h = await setup(t);
  button(h.root, 'Enquete sintética · Rascunho').click();
  button(h.root, 'Publicar enquete').click();
  h.latest('/publish').reject(Object.assign(new Error(), { status: 409, reason: 'active_poll_exists' })); await drain();
  h.latest('/polls/current').resolve({ poll: { ...poll('open', 7), id: 'active' } }); await drain();
  assert.match(h.root.textContent, /Já existe uma enquete aberta/);
  assert.equal(h.root.querySelector('[name="question"]').value, 'Qual tema?');
  assert.equal(h.matching('/close').length, 0);
  button(h.root, 'Ver enquete aberta: Qual tema?').click();
  button(h.root, 'Encerrar enquete').click();
  assert.deepEqual(JSON.parse(h.latest('/active/close').options.body), { expected_version: 7 });
  h.latest('/close').resolve({ ...poll('closed', 8), id: 'active' }); await drain();
  assert.equal(button(h.root, 'Encerrar enquete'), undefined);
});

test('pagination uses 20 and failed reload keeps values; reconciliation locates drafts beyond page one', async t => {
  const h = await setup(t);
  button(h.root, 'Enquete sintética · Rascunho').click();
  h.input(h.root.querySelector('[name="question"]'), 'Local preservado');
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  h.latest('/draft').reject(Object.assign(new Error(), { status: 409, reason: 'version_conflict' })); await drain();
  const before = h.matching('/polls?').length;
  button(h.root, 'Recarregar versão atual').click();
  assert.equal(h.matching('/polls?').length, before);
  h.context.confirmResult = true;
  button(h.root, 'Recarregar versão atual').click();
  h.latest('/polls?').reject(new Error('offline')); await drain();
  assert.equal(h.root.querySelector('[name="question"]').value, 'Local preservado');
  button(h.root, 'Recarregar versão atual').click();
  h.latest('/polls?').resolve({ data: [], total: 21 }); await drain();
  assert.match(h.latest('/polls?').path, /limit=20&offset=20$/);
  h.latest('/polls?').resolve({ data: [poll('draft', 12)], total: 21 }); await drain();
  button(h.root, 'Publicar enquete').click();
  assert.equal(JSON.parse(h.latest('/publish').options.body).expected_version, 12);
});

test('subarea changes confirm once, preserve home guards and detach old poll controls', async t => {
  const h = await setup(t);
  button(h.root, 'Nova enquete').click();
  const stale = h.root.querySelector('form');
  h.input(h.root.querySelector('[name="title"]'), 'Não salvo');
  const before = h.confirms;
  button(h.node('owner-news-sections'), 'Página inicial').click();
  assert.equal(h.confirms, before + 1);
  assert.equal(h.root.querySelector('form'), stale);
  h.context.confirmResult = true;
  assert.equal(h.page.canLeave(), true);
  assert.equal(h.context.canLeavePageUI(), true);
  assert.equal(h.confirms, before + 2, 'global UI does not prompt a second time');
  button(h.node('owner-news-sections'), 'Página inicial').click();
  h.latest('/owner-news/home').resolve({ version: 1, draft: { eyebrow: 'Sintética', headline: 'Teste', summary: 'Resumo' } }); await drain();
  stale.dispatchEvent(new TestEvent('submit'));
  assert.equal(h.matching('/polls').filter(request => request.options.method).length, 0);
  h.input(h.root.querySelector('[name="summary"]'), 'Home editada');
  h.context.confirmResult = false;
  button(h.node('owner-news-sections'), 'Enquetes').click();
  assert.equal(h.root.querySelector('[name="summary"]').value, 'Home editada');
  h.context.confirmResult = true;
  button(h.node('owner-news-sections'), 'Enquetes').click();
  h.latest('/polls?').resolve({ data: [poll()], total: 1 }); await drain();
  assert.equal(h.root.querySelectorAll('h2').length, 1);
});

test('list pages retain loaded content on network failure and reload at the requested offset', async t => {
  const h = await setup(t);
  button(h.root, 'Atualizar lista').click();
  h.latest('/polls?').resolve({ data: [poll()], total: 21 }); await drain();
  assert.equal(button(h.root, 'Anterior').disabled, true);
  button(h.root, 'Próxima').click();
  assert.match(h.latest('/polls?').path, /limit=20&offset=20$/);
  h.latest('/polls?').reject(new Error('offline')); await drain();
  assert.ok(button(h.root, 'Enquete sintética · Rascunho'));
  button(h.root, 'Próxima').click();
  h.latest('/polls?').resolve({ data: [{ ...poll(), id: 'last', title: 'Última sintética' }], total: 21 }); await drain();
  assert.equal(button(h.root, 'Próxima').disabled, true);
  assert.equal(button(h.root, 'Anterior').disabled, false);
  assert.ok(button(h.root, 'Última sintética · Rascunho'));
});

test('published conflict reconciles to closed and page disposal ignores late mutation results', async t => {
  const h = await setup(t, [poll('open', 2)]);
  button(h.root, 'Enquete sintética · Aberta').click();
  const stale = button(h.root, 'Encerrar enquete');
  stale.click();
  h.latest('/close').reject(Object.assign(new Error(), { status: 409, reason: 'version_conflict' })); await drain();
  button(h.root, 'Recarregar versão atual').click();
  h.latest('/polls?').resolve({ data: [poll('closed', 3)], total: 1 }); await drain();
  stale.click();
  assert.equal(h.matching('/close').length, 1);
  assert.equal(h.root.querySelector('form'), null);
  button(h.root, 'Criar nova enquete').click();
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  const pending = h.latest('/polls');
  h.page.dispose();
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve(poll()); await drain();
  assert.equal(h.root.children.length, 0);
});

test('keyboard selection, save and publication restore meaningful focus without stealing newer focus', async t => {
  const h = await setup(t);
  const item = button(h.root, 'Enquete sintética · Rascunho');
  item.focus(); item.click();
  assert.ok(h.doc.activeElement === h.root.querySelector('[name="title"]'), 'selection focuses first field');
  const question = h.root.querySelector('[name="question"]');
  question.focus(); h.input(question, 'Pergunta editada');
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  h.latest('/draft').resolve(poll('draft', 2)); await drain();
  assert.ok(h.doc.activeElement === h.root.querySelector('[name="question"]'), 'save restores submitted field');
  const save = button(h.root, 'Salvar rascunho'); save.focus();
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  h.latest('/draft').resolve(poll('draft', 3)); await drain();
  assert.ok(h.doc.activeElement === button(h.root, 'Salvar rascunho'), 'save restores submit control');
  const option = h.root.querySelectorAll('[name="option"]')[1]; option.focus();
  h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  h.latest('/draft').resolve(poll('draft', 4)); await drain();
  assert.ok(h.doc.activeElement === h.root.querySelectorAll('[name="option"]')[1], 'save preserves option position');
  const publish = button(h.root, 'Publicar enquete'); publish.focus(); publish.click();
  h.latest('/publish').resolve(poll('open', 4)); await drain();
  assert.ok(h.doc.activeElement === h.root.querySelector('h3'), 'publication focuses results');
  const close = button(h.root, 'Encerrar enquete'); close.focus(); close.click();
  const elsewhere = button(h.node('owner-news-sections'), 'Matérias');
  elsewhere.focus(); elsewhere.dispatchEvent(new TestEvent('focusin', { bubbles: true }));
  h.latest('/close').resolve(poll('closed', 5)); await drain();
  assert.ok(h.doc.activeElement === elsewhere, 'newer focus is preserved');
  button(h.root, 'Enquete sintética · Encerrada').click();
  assert.ok(h.doc.activeElement === h.root.querySelector('h3'), 'closed selection focuses results');
});

test('repeated list failures replace retry and detach the previous retry binding', async t => {
  const h = await setup(t);
  button(h.node('owner-news-sections'), 'Matérias').click();
  button(h.node('owner-news-sections'), 'Enquetes').click();
  h.latest('/polls?').reject(new Error('offline')); await drain();
  const stale = button(h.root, 'Tentar novamente'); stale.focus(); stale.click();
  h.latest('/polls?').reject(new Error('offline again')); await drain();
  assert.equal(h.root.querySelectorAll('button').filter(node => node.textContent === 'Tentar novamente').length, 1);
  assert.ok(h.doc.activeElement === button(h.root, 'Tentar novamente'), 'retry focus follows replacement');
  const count = h.matching('/polls?').length; stale.dispatchEvent(new TestEvent('click'));
  assert.equal(h.matching('/polls?').length, count);
  button(h.root, 'Tentar novamente').click();
  h.latest('/polls?').resolve({ data: [], total: 0 }); await drain();
  assert.equal(button(h.root, 'Tentar novamente'), undefined);
});

test('repeated active conflicts replace their action and capture the displayed poll identity', async t => {
  const h = await setup(t);
  button(h.root, 'Enquete sintética · Rascunho').click();
  async function conflictWith(id, question) {
    button(h.root, 'Publicar enquete').click();
    h.latest('/publish').reject(Object.assign(new Error(), { status: 409, reason: 'active_poll_exists' })); await drain();
    h.latest('/polls/current').resolve({ poll: { ...poll('open', 7), id, question } }); await drain();
  }
  await conflictWith('first', 'Primeira aberta');
  const stale = button(h.root, 'Ver enquete aberta: Primeira aberta');
  await conflictWith('second', 'Segunda aberta');
  assert.equal(h.root.querySelectorAll('button').filter(node => node.textContent.startsWith('Ver enquete aberta:')).length, 1);
  stale.dispatchEvent(new TestEvent('click'));
  assert.ok(h.root.querySelector('form'), 'detached action cannot select any poll');
  button(h.root, 'Ver enquete aberta: Segunda aberta').click();
  assert.equal(h.root.querySelector('h3').textContent, 'Segunda aberta');
  button(h.root, 'Encerrar enquete').click();
  assert.match(h.latest('/close').path, /\/second\/close$/);
});

test('new pointer or keyboard activity cancels pending focus restoration even with body focus', async t => {
  const h = await setup(t);
  button(h.root, 'Enquete sintética · Rascunho').click();
  for (const type of ['pointerdown', 'keydown']) {
    button(h.root, 'Salvar rascunho').focus();
    h.root.querySelector('form').dispatchEvent(new TestEvent('submit'));
    h.doc.activeElement = h.doc.body;
    h.doc.dispatchEvent(new TestEvent(type));
    h.latest('/draft').resolve(poll('draft', 9)); await drain();
    assert.ok(h.doc.activeElement === h.doc.body, `${type} prevents stale focus restoration`);
  }
});

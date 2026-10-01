import assert from 'node:assert/strict';
import test from 'node:test';
import { createMountedHarness, drain, TestEvent } from '../helpers/cms-harness.mjs';
import { createFeedbackHarness } from '../helpers/frontend-feedback-harness.mjs';

async function publicPoll(t, value = { ...poll('open', 2), viewer_option_id: null }) {
  const h = await createFeedbackHarness('announcements', { mount: false, modules: [
    { path: 'public/js/owner-news/poll.js', exports: 'createNewsPoll' },
  ] });
  t.after(() => h.page.dispose());
  h.component = h.context.createNewsPoll({ page: h.page, poll: value });
  h.doc.body.append(h.component.node); h.root = h.component.node; h.value = value;
  return h;
}
const voted = value => ({ ...value, viewer_option_id: value.options[0].id, total_votes: 1,
  options: value.options.map((option, i) => ({ ...option, votes: i ? 0 : 1, percentage: i ? 0 : 100 })) });

test('public poll serializes clicks, uses only option_id and confirms authoritative results with focus', async t => {
  const h = await publicPoll(t);
  const first = h.root.querySelector('button'); first.focus(); first.click(); first.click();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { option_id: h.value.options[0].id });
  assert.equal(h.root.getAttribute('aria-busy'), 'true');
  assert.match(h.root.textContent, /Seja a primeira pessoa/);
  h.requests[0].resolve(voted(h.value)); await drain();
  assert.equal(h.root.getAttribute('aria-busy'), 'false');
  assert.equal(h.root.querySelector('button').getAttribute('aria-pressed'), 'true');
  assert.ok(h.root.querySelectorAll('button').every(node => node.disabled));
  assert.match(h.root.textContent, /Sua escolha/); assert.match(h.root.textContent, /100%/);
  assert.ok(h.doc.activeElement === h.root.querySelector('[role="status"]'));
});

test('ambiguous POST and empty reconciliation lock other choices until late commit or same-choice resend', async t => {
  const h = await publicPoll(t);
  h.root.querySelector('button').click();
  h.latest('/votes').reject(new Error('connection lost')); await drain();
  assert.equal(h.requests.at(-1).path, '/api/announcements/polls/poll-a');
  h.requests.at(-1).resolve(h.value); await drain();
  assert.equal(h.root.querySelectorAll('.news-poll-option')[1].disabled, true);
  button(h.root, 'Verificar meu voto').click();
  h.requests.at(-1).reject(new Error('offline')); await drain();
  assert.match(h.root.textContent, /não foi possível verificar/);
  h.root.querySelector('.news-poll-option').click();
  assert.deepEqual(JSON.parse(h.latest('/votes').options.body), { option_id: h.value.options[0].id });
  h.latest('/votes').resolve(voted(h.value)); await drain();
  assert.match(h.root.textContent, /Sua escolha/);
});

for (const reason of ['already_voted', 'poll_closed']) test(`409 ${reason} reconciles by GET without assuming error DTO`, async t => {
  const h = await publicPoll(t); h.root.querySelector('button').click();
  h.latest('/votes').reject(Object.assign(new Error('Conflito'), { status: 409, reason })); await drain();
  h.requests.at(-1).resolve(reason === 'already_voted' ? voted(h.value) : { ...h.value, status: 'closed', version: 3 }); await drain();
  assert.ok(h.root.querySelectorAll('button').every(node => node.disabled));
  assert.match(h.root.textContent, reason === 'already_voted' ? /Sua escolha/ : /encerrada/);
});

test('public poll ignores foreign/older updates, preserves confirmed choice and never steals outside focus', async t => {
  const h = await publicPoll(t);
  const elsewhere = h.doc.createElement('button'); h.doc.body.append(elsewhere);
  h.root.querySelector('button').focus(); h.root.querySelector('button').click(); elsewhere.focus();
  h.latest('/votes').resolve(voted(h.value)); await drain();
  h.component.update({ ...h.value, id: 'other', question: 'Wrong' });
  h.component.update({ ...h.value, version: 1, question: 'Old' });
  h.component.update(h.value);
  assert.match(h.root.textContent, /Sua escolha/); assert.doesNotMatch(h.root.textContent, /Wrong|Old/);
  assert.ok(h.doc.activeElement === elsewhere);
  const remount = h.context.createNewsPoll({ page: h.page, poll: voted(h.value) });
  assert.match(remount.node.textContent, /Sua escolha/);
});

test('public disposal aborts pending request and detaches controls; late results cannot mutate removed DOM', async t => {
  const h = await publicPoll(t); const first = h.root.querySelector('button'); first.click();
  const pending = h.latest('/votes'); h.component.dispose(); h.root.remove(); const before = h.root.textContent;
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve(voted(h.value)); await drain(); first.dispatchEvent(new TestEvent('click'));
  h.component.update(voted(h.value));
  assert.equal(h.root.textContent, before); assert.equal(h.requests.length, 1);
});

test('public percentages reject nonfinite/out-of-range values and render editorial strings as text', async t => {
  const value = { ...poll('closed', 3), question: '<script>synthetic</script>', options: [NaN, Infinity, -1, 101, '50', 50].map((percentage, i) => ({ id: String(i), label: 'Opção', percentage })) };
  const h = await publicPoll(t, value);
  assert.deepEqual(h.root.querySelectorAll('.news-poll-option-bar').map(node => node.style.width), ['0%', '0%', '0%', '0%', '0%', '50%']);
  assert.equal(h.root.querySelector('script'), null);
  assert.equal(h.root.querySelector('[role="status"]').getAttribute('aria-live'), 'polite');
});

test('current loader interleaves after three articles, keeps page totals and voting preserves card identity', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const value = { ...poll('open', 2), viewer_option_id: null };
  const articles = Array.from({ length: 4 }, (_, i) => ({ id: String(i), title: `Sintética ${i}`, content_blocks: [] }));
  h.requests.find(r => r.kind === 'list').resolve({ data: articles, total: 48 });
  h.latest('/polls/current').resolve({ poll: value }); await drain();
  const list = h.node('announcements-list'), card = h.node('news-card-0');
  assert.equal(list.children[3].className, 'news-poll-slot');
  const pager = h.node('announcements-pagination'); assert.match(pager.textContent, /Página 1 de 2/);
  list.querySelector('.news-poll-option').click(); h.latest('/votes').resolve(voted(value)); await drain();
  assert.ok(h.node('news-card-0') === card);
  pager.querySelectorAll('button').at(-1).click();
  assert.equal(list.querySelector('.news-poll'), null);
  assert.match(h.requests.filter(r => r.kind === 'list').at(-1).path, /offset=24/);
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: articles.slice(0, 1), total: 25 }); await drain();
  h.popstate('/announcements.html', {});
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: articles, total: 25 }); await drain();
  assert.match(list.textContent, /Sua escolha/);
  h.popstate('/announcements.html?category=Cultura', {});
  assert.equal(list.querySelector('.news-poll'), null);
});

test('poll loader error/retry, null and stale pageshow requests stay independent of articles and reader', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const article = { id: 'story', title: 'Sintética', content_blocks: [] };
  h.requests.find(r => r.kind === 'list').resolve({ data: [article], total: 1 });
  h.latest('/polls/current').reject(new Error('offline')); await drain();
  const card = h.node('news-card-story'); assert.ok(card);
  const staleRetry = h.node('announcements-list').querySelector('.news-poll-slot').querySelector('button');
  staleRetry.click(); const old = h.latest('/polls/current');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  assert.equal(old.options.signal.aborted, true);
  h.latest('/polls/current').resolve({ poll: null }); await drain();
  old.resolve({ poll: poll('open', 2) }); await drain();
  assert.equal(h.node('announcements-list').querySelector('.news-poll-slot'), null);
  const count = h.requests.length; staleRetry.click(); assert.equal(h.requests.length, count);
  card.querySelector('a').click(); await drain();
  h.requests.find(r => r.path === '/api/announcements/story').resolve(article); await drain();
  assert.match(h.node('news-reader-content').textContent, /Sintética/);
  h.page.dispose();
});

test('article failure retains poll; pagehide disposes a pending vote and pageshow recovers server choice', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const value = { ...poll('open', 2), viewer_option_id: null };
  h.latest('/polls/current').resolve({ poll: value });
  h.requests.find(r => r.kind === 'list').reject(new Error('offline')); await drain();
  assert.match(h.node('news-feed-status').textContent, /Não foi possível/);
  const oldNode = h.node('announcements-list').querySelector('.news-poll'); oldNode.querySelector('button').click();
  const pending = h.latest('/votes'); h.window.dispatchEvent(new TestEvent('pagehide'));
  assert.equal(pending.options.signal.aborted, true);
  const before = oldNode.textContent;
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/polls/current').resolve({ poll: voted(value) }); pending.resolve(voted(value)); await drain();
  assert.equal(oldNode.textContent, before);
  assert.match(h.node('announcements-list').textContent, /Sua escolha/);
});

test('empty GET followed by late commit is verified without offering a different vote or extra POST', async t => {
  const h = await publicPoll(t); h.root.querySelector('button').click();
  h.latest('/votes').reject(new Error('ambiguous')); await drain();
  h.requests.at(-1).resolve(h.value); await drain();
  h.root.querySelectorAll('.news-poll-option')[1].dispatchEvent(new TestEvent('click'));
  assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1);
  button(h.root, 'Verificar meu voto').click();
  h.requests.at(-1).resolve(voted(h.value)); await drain();
  assert.match(h.root.textContent, /Sua escolha/);
  assert.equal(h.requests.filter(r => r.options.method === 'POST').length, 1);
});

test('POST and reconciliation failure retain totals and accessible retry; page disposal aborts verification', async t => {
  const h = await publicPoll(t); h.root.querySelector('button').click();
  h.latest('/votes').reject(new Error('offline')); await drain();
  h.requests.at(-1).reject(new Error('offline')); await drain();
  assert.match(h.root.querySelector('[role="status"]').textContent, /Tente verificar novamente/);
  assert.match(h.root.textContent, /Seja a primeira pessoa/);
  button(h.root, 'Verificar meu voto').click(); const pending = h.requests.at(-1);
  h.page.dispose(); const before = h.root.textContent;
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve(voted(h.value)); await drain(); assert.equal(h.root.textContent, before);
});

test('current replacement disposes the old pending poll and stale success cannot change its successor', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const value = { ...poll('open', 2), viewer_option_id: null };
  h.latest('/polls/current').resolve({ poll: value }); await drain();
  const old = h.node('announcements-list').querySelector('.news-poll'); old.querySelector('button').click();
  const pending = h.latest('/votes');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/polls/current').resolve({ poll: { ...value, id: 'next-poll', question: 'Nova pergunta' } }); await drain();
  const before = old.textContent;
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve(voted(value)); await drain();
  assert.equal(old.textContent, before);
  assert.match(h.node('announcements-list').textContent, /Nova pergunta/);
  assert.doesNotMatch(h.node('announcements-list').textContent, /Sua escolha/);
});

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

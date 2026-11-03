import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';

const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const poll = (status = 'draft', version = 1) => ({
  id: 'poll-a', title: 'Enquete sintética', question: 'Qual tema?', description: '', closing: '', status, version,
  options: [{ id: `a-${version}`, label: 'Cultura', votes: 0, percentage: 0 }, { id: `b-${version}`, label: 'Pessoas', votes: 0, percentage: 0 }], total_votes: 0,
});
const voted = value => ({ ...value, viewer_option_id: value.options[0].id, total_votes: 1,
  options: value.options.map((option, i) => ({ ...option, votes: i ? 0 : 1, percentage: i ? 0 : 100 })) });

async function publicPoll(t, value = { ...poll('open', 2), viewer_option_id: null }) {
  const h = await createFeedbackHarness('announcements', { mount: false, modules: [
    { path: 'public/js/owner-news/poll.js', exports: 'createNewsPoll' },
  ] });
  t.after(() => h.page.dispose());
  h.component = h.context.createNewsPoll({ page: h.page, poll: value });
  h.doc.body.append(h.component.node); h.root = h.component.node; h.value = value;
  return h;
}

test('public poll serializes clicks, uses only option_id and confirms authoritative results with focus', async t => {
  const h = await publicPoll(t);
  const first = h.root.querySelector('button'); first.focus(); first.click(); first.click();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { option_id: h.value.options[0].id });
  assert.equal(h.root.getAttribute('aria-busy'), 'true');
  h.requests[0].resolve(voted(h.value)); await drain();
  assert.equal(h.root.getAttribute('aria-busy'), 'false');
  assert.equal(h.root.querySelector('button').getAttribute('aria-pressed'), 'true');
  assert.ok(h.root.querySelectorAll('button').every(node => node.disabled));
  assert.match(h.root.textContent, /Sua escolha/);
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

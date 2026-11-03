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

for (const reason of ['already_voted', 'poll_closed']) test(`409 ${reason} reconciles by GET without assuming error DTO`, async t => {
  const h = await publicPoll(t); h.root.querySelector('button').click();
  h.latest('/votes').reject(Object.assign(new Error('Conflito'), { status: 409, reason })); await drain();
  h.requests.at(-1).resolve(reason === 'already_voted' ? voted(h.value) : { ...h.value, status: 'closed', version: 3 }); await drain();
  assert.ok(h.root.querySelectorAll('button').every(node => node.disabled));
  assert.match(h.root.textContent, reason === 'already_voted' ? /Sua escolha/ : /encerrada/);
});

test('public disposal aborts pending request and detaches controls; late results cannot mutate removed DOM', async t => {
  const h = await publicPoll(t); const first = h.root.querySelector('button'); first.click();
  const pending = h.latest('/votes'); h.component.dispose(); h.root.remove(); const before = h.root.textContent;
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve(voted(h.value)); await drain(); first.dispatchEvent(new TestEvent('click'));
  h.component.update(voted(h.value));
  assert.equal(h.root.textContent, before); assert.equal(h.requests.length, 1);
});

test('current poll loader interleaves with articles without replacing card identity', async t => {
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
});

test('pagehide disposes a pending vote and pageshow recovers the authoritative choice', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const value = { ...poll('open', 2), viewer_option_id: null };
  h.latest('/polls/current').resolve({ poll: value });
  h.requests.find(r => r.kind === 'list').resolve({ data: [], total: 0 }); await drain();
  const option = h.node('announcements-list').querySelector('.news-poll-option');
  option.click();
  const pending = h.latest('/votes'); h.window.dispatchEvent(new TestEvent('pagehide'));
  assert.equal(pending.options.signal.aborted, true);
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/polls/current').resolve({ poll: voted(value) }); pending.resolve(voted(value)); await drain();
  assert.match(h.node('announcements-list').textContent, /Sua escolha/);
});

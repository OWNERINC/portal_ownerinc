import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRouterHarness, drain, Node } from '../helpers/router-harness.mjs';

const destination = '/solides.html?view=history#today';

const failures = [
  {
    name: '200 with linked false',
    respond: async () => ({ available: true, linked: false, linkStatus: 'missing' }),
    message: /vínculo ativo/,
  },
  {
    name: '404 hidden by the backend',
    respond: async () => { throw Object.assign(new Error('Not found.'), { status: 404 }); },
    message: /indisponível ou inativa.*O servidor não informa o motivo/,
  },
  {
    name: '401 session response',
    respond: async () => { throw Object.assign(new Error('Unauthorized.'), { status: 401 }); },
    message: /sessão não está mais válida/,
  },
  {
    name: '403 permission response',
    respond: async () => { throw Object.assign(new Error('Forbidden.'), { status: 403 }); },
    message: /não possui permissão/,
  },
  {
    name: '503 temporary response',
    respond: async () => { throw Object.assign(new Error('Unavailable.'), { status: 503 }); },
    message: /temporariamente indisponível/,
  },
];

function installStatusResponse(h, respond) {
  let calls = 0;
  h.context.fetchAPI = async path => {
    assert.equal(path, '/api/solides/me/status');
    calls++;
    return respond();
  };
  return () => calls;
}

for (const failure of failures) {
  test(`Sólides first load distinguishes ${failure.name} without mounting`, async () => {
    const h = await createRouterHarness({ initialURL: `https://portal.test${destination}`, autoStart: false });
    const calls = installStatusResponse(h, failure.respond);
    await h.router.startRouter();

    const notice = h.doc.querySelector('.portal-navigation-error');
    assert.ok(notice);
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.match(notice.querySelector('p').textContent, failure.message);
    assert.equal(calls(), 1);
    assert.equal(h.mounts.length, 0, 'the linked-data page must not mount without a valid status response');
    assert.equal(h.location.pathname, '/solides.html');
    assert.equal(h.location.search, '?view=history');
    assert.equal(h.location.hash, '#today');
    assert.ok(notice.querySelector('button'), 'the failure exposes an accessible retry action');
  });

  test(`Sólides SPA navigation distinguishes ${failure.name} and preserves the current page`, async () => {
    const h = await createRouterHarness();
    const previous = h.scope;
    const main = h.doc.getElementById('main-content');
    const oldContent = main.children[0];
    const calls = installStatusResponse(h, failure.respond);

    assert.equal(await h.router.navigate(destination), false);
    const notice = h.doc.querySelector('.portal-navigation-error');
    assert.ok(notice);
    assert.match(notice.querySelector('p').textContent, failure.message);
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(calls(), 1);
    assert.equal(previous.active, true);
    assert.equal(main.children[0], oldContent);
    assert.equal(h.location.pathname, '/dashboard.html');
    assert.equal(h.location.search, '');
    assert.equal(h.mounts.length, 1);
    assert.ok(notice.querySelector('button'));
  });
}

test('Sólides retry revalidates the same deep link before mounting', async () => {
  const h = await createRouterHarness({ initialURL: `https://portal.test${destination}`, autoStart: false });
  let statusCalls = 0;
  h.context.fetchAPI = async () => {
    if (++statusCalls === 1) throw Object.assign(new Error('Unavailable.'), { status: 503 });
    return { available: true, linked: true };
  };
  await h.router.startRouter();
  const notice = h.doc.querySelector('.portal-navigation-error');
  assert.ok(notice);

  notice.querySelector('button').click();
  await drain();
  await drain();

  assert.equal(statusCalls, 2, 'retry performs the status gate again');
  assert.equal(h.requests.at(-1).url, `https://portal.test${destination}`);
  assert.equal(h.location.href, `https://portal.test${destination}`);
  assert.equal(h.mounts.length, 1);
  assert.equal(h.doc.querySelector('.portal-navigation-error'), null);
});

test('Sólides data panels distinguish permission, hidden/unavailable and temporary API errors with retry actions', async () => {
  const h = await createRouterHarness({ realUI: true });
  await h.router.navigate('/solides.html');
  const main = h.doc.getElementById('main-content');
  const card = id => {
    const wrapper = new Node('article', h.doc, { class: 'card' });
    const content = new Node('p', h.doc, { id });
    wrapper.append(content); main.append(wrapper);
    return content;
  };
  card('today-summary');
  card('hours-balance');
  card('schedule-summary');
  for (const id of ['schedule-days', 'adjustments-list', 'punch-history']) main.append(new Node('div', h.doc, { id }));
  for (const id of ['history-more', 'history-filter', 'history-from', 'history-to', 'history-error']) {
    main.append(new Node(id === 'history-filter' ? 'form' : id.includes('from') || id.includes('to') ? 'input' : 'button', h.doc, { id }));
  }

  let summaryCalls = 0;
  h.context.fetchAPI = async path => {
    if (path.includes('/summary')) { summaryCalls++; throw Object.assign(new Error('Not found.'), { status: 404 }); }
    if (path.includes('/hours-balance')) throw Object.assign(new Error('Forbidden.'), { status: 403 });
    if (path.includes('/schedule')) throw Object.assign(new Error('Unavailable.'), { status: 503 });
    if (path.includes('/adjustments')) throw Object.assign(new Error('Forbidden.'), { status: 403 });
    throw new Error(`Unexpected Sólides request: ${path}`);
  };
  h.context.fetchAPIPage = async () => { throw Object.assign(new Error('Unavailable.'), { status: 503 }); };
  const source = (await readFile('public/js/solides.js', 'utf8'))
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.mountSolides = mount;`, h.context);
  h.context.mountSolides(h.scope);
  await h.scope.ready();

  assert.match(h.doc.getElementById('today-summary').textContent, /indisponível ou inativa/);
  assert.match(h.doc.getElementById('hours-balance').textContent, /não possui permissão/);
  assert.match(h.doc.getElementById('schedule-summary').textContent, /temporariamente indisponível/);
  assert.match(h.doc.getElementById('adjustments-list').querySelector('.empty-state p').textContent, /não possui permissão/);
  assert.match(h.doc.getElementById('punch-history').querySelector('.empty-state p').textContent, /temporariamente indisponível/);
  for (const id of ['today-summary', 'hours-balance']) {
    assert.ok(h.doc.getElementById(id).closest('.card').querySelector('[data-solides-card-retry]'));
  }
  for (const id of ['schedule-days', 'adjustments-list', 'punch-history']) {
    const state = h.doc.getElementById(id).querySelector('.empty-state');
    assert.equal(state.getAttribute('role'), 'alert');
    assert.ok(state.querySelector('button'));
  }

  h.doc.getElementById('today-summary').closest('.card').querySelector('[data-solides-card-retry]').click();
  await h.scope.ready();
  assert.equal(summaryCalls, 2, 'the summary retry repeats only its own request');
});

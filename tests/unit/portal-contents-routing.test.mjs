import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentsHarness } from '../helpers/portal-contents-harness.mjs';
import { createRouterHarness, deferred, drain, TestEvent } from '../helpers/router-harness.mjs';
import { pageFixture } from '../helpers/portal-contents-fixtures.mjs';

function responseForDetail(slug = 'published-policy', status = 200) {
  if (status !== 200) return new Response('private server detail', { status });
  return Response.json(pageFixture({ slug, title: slug === 'published-policy' ? 'Política publicada' : 'Outra página', content_blocks: [] }));
}

test('route parser canonicalizes accepted reader/catalog routes and rejects malformed recognized parameters', async () => {
  const h = await createContentsHarness();
  const parse = search => JSON.parse(JSON.stringify(h.modules.index.parseContentsLocation(search)));
  assert.deepEqual(parse(''), { kind: 'catalog', category: null, page: 1, offset: 0, href: '/contents.html' });
  assert.deepEqual(parse('?category=people&page=2'), { kind: 'catalog', category: 'people', page: 2, offset: 12,
    href: '/contents.html?category=people&page=2' });
  assert.deepEqual(parse('?slug=published-policy&page=2&category=people&tracking=x'), {
    kind: 'reader', slug: 'published-policy', href: '/contents.html?slug=published-policy',
  });
  assert.deepEqual(parse('?slug=published-policy&slug=another'), { kind: 'invalid', href: null });
  assert.deepEqual(parse('?slug=published-policy&page=bad'), { kind: 'invalid', href: null }, 'bad page rejects even with valid slug');
  for (const search of [
    '?slug=', '?slug=Not-Canonical', '?slug=a%2Fb', '?category=', '?category=Bad',
    '?category=a&category=b', '?page=', '?page=0', '?page=01', '?page=-1', '?page=1.5',
    '?page=1e2', '?page=%201', '?page=83335', '?page=9007199254740992', '?page=2&page=3',
  ]) assert.deepEqual(parse(search), { kind: 'invalid', href: null }, search);
});

test('direct slug mounts without consulting availability and strips unrelated query while preserving history metadata', async () => {
  const requests = [];
  const h = await createContentsHarness({ url: '/contents.html?slug=published-policy&category=people&page=2&tracking=drop',
    request: async (path, options) => {
      requests.push({ path, options });
      assert.notEqual(path, '/api/contents/availability');
      return responseForDetail('published-policy');
    } });
  h.history.replaceState({ portalNavigation: 7, custom: 'preserve' }, '', h.location.href);
  h.mount();
  await h.ready();
  assert.deepEqual(requests.map(item => item.path), ['/api/contents/published-policy']);
  assert.equal(h.location.search, '?slug=published-policy');
  assert.equal(h.history.state.custom, 'preserve');
  assert.equal(h.history.state.portalNavigation, 7);
  assert.equal(h.document.title, 'Política publicada — Conteúdos — Portal Ownerinc');
  assert.equal(h.document.getElementById('contents-root').querySelectorAll('h1').length, 1);
  assert.equal(h.document.getElementById('contents-status').textContent, 'Conteúdo aberto.');
});

test('initial catalog and detail loads are tracked through DOM commit; canonical page-one and unrelated params are removed', async () => {
  const h = await createContentsHarness({ url: '/contents.html?category=people&page=1&tracking=strip' });
  h.mount();
  await h.ready();
  assert.equal(h.location.search, '?category=people');
  assert.deepEqual(h.requests.map(request => request.path).sort(), [
    '/api/contents/?limit=12&offset=0&category=people', '/api/contents/categories',
  ]);
  assert.equal(h.document.querySelector('#contents-status').textContent, 'Nenhum conteúdo nesta categoria.Todas');
  assert.equal(h.document.querySelector('#contents-status a').getAttribute('href'), '/contents.html');
  assert.equal(h.document.querySelector('#contents-root').getAttribute('aria-busy'), null);
  assert.equal(h.page.active, true);
});

test('invalid URL displays a safe catalog action and sends no content requests', async () => {
  const h = await createContentsHarness({ url: '/contents.html?slug=published-policy&page=invalid' });
  h.mount();
  await h.ready();
  assert.equal(h.requests.length, 0);
  assert.equal(h.document.querySelector('#contents-status').textContent, 'Não foi possível abrir este conteúdo com segurança.Voltar ao catálogo');
  assert.equal(h.document.querySelector('#contents-status a').getAttribute('href'), '/contents.html');
  assert.equal(h.document.querySelector('#contents-root').getAttribute('aria-busy'), null);
});

test('A→B→A generations abort obsolete jobs and only the latest response reaches the DOM', async () => {
  const pending = [];
  const h = await createContentsHarness({ url: '/contents.html?slug=published-policy', request: (path, options) => {
    const ticket = { path, options, ...deferred() };
    pending.push(ticket);
    options.signal.addEventListener('abort', () => ticket.reject(new DOMException('stale', 'AbortError')), { once: true });
    return ticket.promise;
  } });
  h.mount();
  await drain();
  h.history.pushState(h.history.state, '', '/contents.html?slug=second-page');
  h.window.dispatchEvent(new TestEvent('popstate', { state: h.history.state }));
  await drain();
  h.history.pushState(h.history.state, '', '/contents.html?slug=published-policy');
  h.window.dispatchEvent(new TestEvent('popstate', { state: h.history.state }));
  await drain();
  assert.equal(pending.length, 3);
  pending[2].resolve(responseForDetail('published-policy'));
  await h.ready();
  pending[0].resolve(responseForDetail('published-policy'));
  pending[1].resolve(responseForDetail('second-page'));
  await drain();
  assert.equal(h.document.querySelector('#contents-root').querySelector('h1').textContent, 'Política publicada');
  assert.equal(h.document.title, 'Política publicada — Conteúdos — Portal Ownerinc');
});

test('identity invalidation clears committed text synchronously and late body bytes cannot restore it', async () => {
  let cancelCount = 0;
  let calls = 0;
  const h = await createContentsHarness({ url: '/contents.html?slug=published-policy', request: async () => {
    if (calls++ > 0) return responseForDetail();
    return new Response(new ReadableStream({ cancel() { cancelCount += 1; } }, { highWaterMark: 0 }));
  } });
  h.mount();
  await drain();
  h.notifyIdentity({ uid: 'user-b', generation: 2, validated: false });
  assert.equal(h.document.querySelector('#contents-view').textContent, '');
  assert.equal(h.document.querySelector('#contents-title').isConnected, true);
  assert.equal(cancelCount, 1);
  await h.ready();
  assert.equal(h.document.querySelector('#contents-view').querySelector('h1'), null);
  h.notifyIdentity({ uid: 'user-b', generation: 2, validated: true });
  await h.ready();
  assert.equal(h.requests.length, 2);
});

test('category fetch failure changes only category controls and retry preserves already committed cards', async () => {
  let categoryCalls = 0;
  const row = pageFixture({ content_blocks: [] });
  const h = await createContentsHarness({ request: async path => {
    if (path === '/api/contents/categories' && categoryCalls++ === 0) throw new Error('private category outage');
    if (path === '/api/contents/categories') return Response.json([{ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'people', name: 'Pessoas', count: 1 }]);
    return new Response(JSON.stringify([row]), { headers: { 'X-Total-Count': '1' } });
  } });
  h.mount();
  await h.ready();
  const catalog = h.document.querySelector('#contents-view');
  assert.ok(catalog.querySelector('.contents-card'));
  const nav = catalog.querySelector('#contents-categories');
  assert.match(nav.textContent, /Não foi possível carregar as categorias\./u);
  nav.querySelector('button').click();
  await h.ready();
  assert.ok(catalog.querySelector('.contents-card'), 'category retry must not clear the successful card list');
  assert.equal(catalog.querySelector('#contents-categories').textContent, 'TodasPessoas (1)');
  assert.equal(categoryCalls, 2);
});

test('404 and 400 details have distinct safe states; 503 retry is same-route and focuses only its heading', async () => {
  for (const [status, expected] of [[404, 'Este conteúdo não está mais disponível.Voltar ao catálogo'],
    [400, 'Não foi possível abrir este conteúdo com segurança.Voltar ao catálogo']]) {
    const h = await createContentsHarness({ url: '/contents.html?slug=published-policy', request: async () => responseForDetail('', status) });
    h.mount(); await h.ready();
    assert.equal(h.document.querySelector('#contents-status').textContent, expected);
    assert.equal(h.document.querySelector('#contents-status').textContent.includes('private server detail'), false);
  }
  let calls = 0;
  const retry = await createContentsHarness({ url: '/contents.html?slug=published-policy', request: async () => {
    if (calls++ === 0) return responseForDetail('', 503);
    return responseForDetail('published-policy');
  } });
  retry.mount(); await retry.ready();
  assert.equal(retry.document.querySelector('#contents-status').textContent, 'Conteúdos temporariamente indisponíveis.Tentar novamente');
  retry.document.querySelector('#contents-status button').click();
  await retry.ready();
  assert.equal(calls, 2);
  assert.equal(retry.document.querySelector('#contents-view').querySelector('h1').textContent, 'Política publicada');
  assert.equal(retry.document.activeElement, retry.document.querySelector('#contents-view').querySelector('h1'));
});

test('all supported API statuses render distinct fixed Portuguese copy without backend details', async () => {
  const cases = [
    [400, 'Não foi possível abrir este conteúdo com segurança.'],
    [401, 'Sua sessão não está mais válida. Entre novamente para continuar.'],
    [403, 'Você não tem permissão para visualizar este conteúdo.'],
    [404, 'Este conteúdo não está mais disponível.'],
    [409, 'O conteúdo mudou durante a leitura. Atualize e tente novamente.'],
    [413, 'Este conteúdo excede o limite permitido para leitura.'],
    [429, 'Muitas solicitações. Aguarde um instante e tente novamente.'],
    [503, 'Conteúdos temporariamente indisponíveis.'],
  ];
  const observed = new Set();
  for (const [status, message] of cases) {
    const h = await createContentsHarness({ url: '/contents.html?slug=published-policy',
      request: async () => responseForDetail('', status) });
    h.mount(); await h.ready();
    const state = h.document.querySelector('#contents-status');
    assert.ok(state.textContent.startsWith(message), `HTTP ${status} has its fixed status copy`);
    assert.doesNotMatch(state.textContent, /private server detail/u);
    observed.add(state.textContent.slice(0, message.length));
  }
  assert.equal(observed.size, cases.length, 'each supported status has distinct user-facing copy');
});

test('retry focus intent belongs only to its run and a superseded late response cannot steal focus', async () => {
  let calls = 0;
  let pullStarted;
  const pullStartedPromise = new Promise(resolve => { pullStarted = resolve; });
  let staleCancelled = 0;
  const h = await createContentsHarness({ url: '/contents.html?slug=published-policy', request: async () => {
    calls += 1;
    if (calls === 1) return responseForDetail('', 503);
    if (calls === 2) return new Response(new ReadableStream({
      pull() { pullStarted(); return new Promise(() => {}); },
      cancel() { staleCancelled += 1; },
    }, { highWaterMark: 0 }));
    return responseForDetail('another-page');
  } });
  h.mount(); await h.ready();
  h.document.body.focus();
  h.document.querySelector('#contents-status button').click();
  await pullStartedPromise;
  assert.equal(calls, 2);
  await h.popstate('/contents.html?slug=another-page');
  assert.equal(h.document.querySelector('#contents-view h1').textContent, 'Outra página');
  assert.equal(h.document.activeElement.tagName, 'BODY', 'ordinary navigation does not inherit a stale retry focus request');
  assert.equal(staleCancelled, 1, 'the superseded retry stream is cancelled');
});

test('missing optional status target does not block direct-route rendering', async () => {
  const h = await createContentsHarness({ url: '/contents.html?slug=published-policy' });
  h.document.getElementById('contents-status').remove();
  h.mount();
  await h.ready();
  assert.equal(h.document.querySelector('#contents-view').querySelector('h1').textContent, 'Política publicada');
});

test('catalog return href is remembered in-page and Back/Forward restores catalog and reader without reloading the shell', async () => {
  const dto = pageFixture({ content_blocks: [] });
  const h = await createContentsHarness({ url: '/contents.html?category=people&page=2', request: async path => {
    if (path === '/api/contents/categories') return Response.json([{ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'people', name: 'People', count: 14 }]);
    if (path.includes('/api/contents/?')) return new Response(JSON.stringify([dto]), { headers: { 'X-Total-Count': '14' } });
    return Response.json(dto);
  } });
  h.mount(); await h.ready();
  h.history.pushState(h.history.state, '', '/contents.html?slug=published-policy');
  h.window.dispatchEvent(new TestEvent('popstate', { state: h.history.state }));
  await h.ready();
  assert.equal(h.document.querySelector('.contents-back-link').getAttribute('href'), '/contents.html?category=people&page=2');
  h.history.back();
  await h.ready();
  assert.equal(h.location.search, '?category=people&page=2');
  assert.equal(h.document.querySelector('#contents-view').querySelector('h1').textContent, 'Conteúdos');
  h.history.forward();
  await h.ready();
  assert.equal(h.location.search, '?slug=published-policy');
  assert.equal(h.document.querySelector('#contents-view').querySelector('h1').textContent, dto.title);
});

test('real persistent router admits contents while availability is unavailable and preserves native local navigation ownership', async () => {
  const requested = [];
  const dto = pageFixture({ content_blocks: [] });
  const h = await createRouterHarness({ initialURL: 'https://portal.test/contents.html?slug=published-policy', autoStart: false });
  h.page('/contents.html');
  const feature = await h.loadContentsModule({ request: async path => {
    requested.push(path);
    if (path === '/api/contents/availability') throw new Error('availability unavailable');
    if (path === '/api/contents/categories') return Response.json([{ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'people', name: 'People', count: 1 }]);
    if (path.startsWith('/api/contents/?')) return new Response(JSON.stringify([dto]), { headers: { 'X-Total-Count': '1' } });
    if (path.startsWith('/api/contents/')) return Response.json({ ...dto, slug: path.split('/').at(-1), title: path.split('/').at(-1) });
    throw new Error(`unexpected ${path}`);
  } });
  h.context.contentsAvailability = 'unavailable';
  await h.router.startRouter();
  await h.scope.ready();
  assert.equal(h.router.routes['/contents.html'], './portal-contents/index.js');
  assert.equal(h.router.routeAllowed('/contents.html', h.context.user), true);
  assert.deepEqual(requested, ['/api/contents/published-policy']);
  assert.equal(h.doc.querySelector('#contents-view').querySelector('h1').textContent, 'published-policy');
  const mounts = h.mounts.length;
  const event = h.click('/contents.html?slug=another');
  await drain();
  await h.scope.ready();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.mounts.length, mounts, 'same-area query navigation uses the existing reader mount');
  assert.equal(h.location.search, '?slug=another');
  assert.equal(h.doc.querySelector('#contents-view').querySelector('h1').textContent, 'another');
  const modified = h.click('/contents.html?slug=another', { ctrlKey: true });
  assert.equal(modified.defaultPrevented, false, 'modified clicks remain native browser navigation');
  const category = h.click('/contents.html?category=people&page=2');
  await drain(); await h.scope.ready();
  assert.equal(category.defaultPrevented, true);
  assert.equal(h.location.search, '?category=people&page=2');
  const categoryLink = h.doc.querySelector('.contents-category-list')?.querySelector('a');
  assert.equal(categoryLink.getAttribute('href'), '/contents.html', 'category selection removes the old page number');
  h.history.back(); await drain(); await h.scope.ready();
  assert.equal(h.location.search, '?slug=another');
  h.history.forward(); await drain(); await h.scope.ready();
  assert.equal(h.location.search, '?category=people&page=2');
  await h.router.navigate('/knowledge.html');
  h.history.back(); await drain();
  await h.scope.ready();
  assert.equal(h.location.pathname, '/contents.html', 'cross-area Back remounts contents through the persistent router');
  assert.equal(h.doc.querySelector('#contents-view').querySelector('h1').textContent, 'Conteúdos');
  h.history.forward(); await drain();
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.ok(requested.includes('/api/contents/categories'));
  assert.equal(h.router.routes['/announcements.html'], './announcements.js', 'Owner News routing remains unchanged');
  assert.ok(feature.modules.index);
});

test('Contents local forward anchors wait for the current load, focus its heading, and preserve traversal snapshots', async () => {
  const dto = pageFixture({ content_blocks: [] });
  let resolveReader;
  let delayReader = true;
  const h = await createRouterHarness({ initialURL: 'https://portal.test/contents.html', autoStart: false });
  h.page('/contents.html');
  const feature = await h.loadContentsModule({ request: async path => {
    if (path === '/api/contents/categories') return Response.json([]);
    if (path.startsWith('/api/contents/?')) return new Response(JSON.stringify([dto]), { headers: { 'X-Total-Count': '1' } });
    if (path.endsWith('/published-policy') && delayReader) {
      delayReader = false;
      return new Promise(resolve => { resolveReader = resolve; });
    }
    return Response.json({ ...dto, slug: path.split('/').at(-1), title: 'Página de leitura' });
  } });
  await h.router.startRouter();
  await h.scope.ready();
  const catalogHeading = h.doc.querySelector('#contents-view h1');
  catalogHeading.focus();
  h.window.scrollTo(0, 420);

  const click = h.click('/contents.html?slug=published-policy');
  await drain();
  assert.equal(typeof resolveReader, 'function', 'the click started the tracked detail loader');
  assert.equal(h.window.scrollY, 420, 'forward restoration must wait while the tracked loader is pending');
  resolveReader(Response.json({ ...dto, title: 'Página de leitura' }));
  await h.scope.ready();
  await drain();
  const readerHeading = h.doc.querySelector('#contents-view h1');
  assert.equal(click.defaultPrevented, true);
  assert.equal(h.window.scrollY, 0, 'forward local navigation resets scroll only after the tracked load completes');
  assert.equal(h.doc.activeElement.id, readerHeading.id, 'forward local navigation focuses the new reader heading');

  h.history.back(); await drain(); await h.scope.ready();
  assert.equal(h.location.search, '');
  assert.equal(h.window.scrollY, 420, 'Back restores the saved catalog scroll position');
  assert.equal(h.doc.activeElement.id, catalogHeading.id, 'Back restores the saved catalog focus target');
  h.history.forward(); await drain(); await h.scope.ready();
  assert.equal(h.doc.activeElement.id, 'contents-title');
  assert.equal(h.window.scrollY, 0, 'Forward restores the saved reader position rather than rerunning the forward reset');
  assert.ok(feature.modules.index);
});

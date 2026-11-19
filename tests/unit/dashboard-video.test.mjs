import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFeedbackHarness, TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';

async function dashboard(t, options) {
  const h = await createFeedbackHarness('dashboard', options);
  t.after(() => h.page.dispose());
  return h;
}

test('dashboard opening orders video, existing Ethics and compact access before secondary tools', async t => {
  const h = await dashboard(t, { user: { name: 'Gabriel Silva' } });
  assert.match(h.node('dashboard-greeting').textContent, /^(Bom dia|Boa tarde|Boa noite), Gabriel\.$/);
  const html = h.html;
  assert.ok(html.indexOf('id="dashboard-video"') < html.indexOf('id="ethics-heading"'));
  assert.ok(html.indexOf('id="ethics-heading"') < html.indexOf('id="quick-links"'));
  assert.ok(html.indexOf('id="quick-links"') < html.indexOf('id="reminders-heading"'));
  assert.ok(html.indexOf('id="reminders-heading"') < html.indexOf('id="tools-heading"'));
  assert.doesNotMatch(html, /Encontre informações da Ownerinc/);
  assert.equal(h.node('dashboard-video-frame').querySelector('iframe'), null);
  assert.equal(h.node('dashboard-video-load').disabled, false);
  assert.equal(h.node('dashboard-video-load').textContent, '');
  assert.equal(h.node('dashboard-video-load').getAttribute('aria-label'), 'Carregar vídeo');
  assert.equal(h.node('dashboard-video-notice'), null);
  assert.equal(h.node('dashboard-video-external'), null);
  assert.equal(h.node('dashboard-video-poster').querySelector('img').getAttribute('src'), './assets/conecta/dashboard-video-poster.jpg');
  assert.ok(!h.node('dashboard-video-title'), 'the visible video heading is absent');
  assert.equal(h.node('dashboard-video').getAttribute('aria-label'), 'Vídeo de abertura');
  assert.equal(h.node('dashboard-video').getAttribute('aria-labelledby'), null);
  assert.equal(h.node('dashboard-video').querySelector('.dashboard-video-caption p').textContent, 'Andamento das obras · Maio de 2026');
  assert.doesNotMatch(html, /Abrir no YouTube|Ao carregar o vídeo, você se conecta ao YouTube/);
  assert.equal(h.requests.some(request => /youtu/i.test(request.path)), false);
});

test('dashboard video connects to the fixed no-cookie player only on click without autoplay or duplicate frames', async t => {
  const h = await dashboard(t);
  const button = h.node('dashboard-video-load');
  button.focus(); button.click();
  const frame = h.node('dashboard-video-frame').querySelector('iframe');
  assert.ok(frame);
  const url = new URL(frame.getAttribute('src'));
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, '/embed/VAhBJOKc3-s');
  assert.equal(url.searchParams.get('autoplay'), '0');
  assert.equal(url.searchParams.get('playsinline'), '1');
  assert.equal(frame.getAttribute('allowfullscreen'), '');
  assert.doesNotMatch(frame.getAttribute('allow'), /autoplay|camera|microphone/);
  assert.equal(frame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  assert.match(frame.getAttribute('title'), /Owntime Home Club Gramado/);
  assert.equal(h.node('dashboard-video-poster').hidden, true);
  assert.equal(h.doc.activeElement, frame);
  assert.equal(h.node('dashboard-video-frame').getAttribute('aria-busy'), 'true');
  assert.match(h.node('dashboard-video-status').textContent, /Carregando/);
  button.dispatchEvent(new TestEvent('click'));
  assert.equal(h.node('dashboard-video-frame').querySelectorAll('iframe').length, 1);
  frame.dispatchEvent(new TestEvent('load'));
  assert.equal(h.node('dashboard-video-frame').getAttribute('aria-busy'), 'false');
  assert.equal(h.node('dashboard-video-status').hidden, true);
  assert.equal(h.timers.size, 0);
});

test('dashboard video error restores a visible retry without stealing focus moved elsewhere', async t => {
  for (const moved of [false, true]) {
    const h = await dashboard(t);
    h.node('dashboard-video-load').focus();
    h.node('dashboard-video-load').click();
    const frame = h.node('dashboard-video-frame').querySelector('iframe');
    const other = h.node('quick-links').querySelector('a');
    if (moved) other.focus();
    frame.dispatchEvent(new TestEvent('error'));
    assert.equal(frame.getAttribute('src'), null);
    assert.equal(frame.parentNode, null);
    assert.equal(h.node('dashboard-video-poster').hidden, false);
    assert.equal(h.node('dashboard-video-load').disabled, false);
    assert.equal(h.node('dashboard-video-frame').getAttribute('aria-busy'), 'false');
    assert.equal(h.node('dashboard-video-status').textContent, 'Não foi possível carregar o vídeo. Tente novamente.');
    assert.equal(h.node('dashboard-video-status').hidden, false);
    assert.equal(h.doc.activeElement, moved ? other : h.node('dashboard-video-load'));
    h.node('dashboard-video-load').click();
    assert.ok(h.node('dashboard-video-frame').querySelector('iframe'));
    assert.equal(h.timers.size, 1);
  }
});

test('dashboard video times out honestly and ignores callbacks from an earlier attempt', async t => {
  const h = await dashboard(t);
  h.node('dashboard-video-load').click();
  const first = h.node('dashboard-video-frame').querySelector('iframe');
  const oldLoad = first.listeners.get('load')[0].fn;
  const oldError = first.listeners.get('error')[0].fn;
  const [timerID, expire] = [...h.timers][0];
  h.timers.delete(timerID); expire();
  assert.equal(first.getAttribute('src'), null);
  assert.equal(h.node('dashboard-video-load').disabled, false);
  assert.equal(h.node('dashboard-video-status').textContent, 'O carregamento está demorando. Tente novamente.');
  h.node('dashboard-video-load').click();
  const second = h.node('dashboard-video-frame').querySelector('iframe');
  assert.notEqual(first, second);
  oldLoad(new TestEvent('load')); oldError(new TestEvent('error')); expire();
  assert.equal(h.node('dashboard-video-frame').querySelector('iframe'), second);
  assert.equal(h.node('dashboard-video-frame').getAttribute('aria-busy'), 'true');
  assert.equal(h.timers.size, 1);
});

test('dashboard video unloads on pagehide and BFCache does not silently reconnect', async t => {
  const h = await dashboard(t);
  h.node('dashboard-video-load').click();
  const frame = h.node('dashboard-video-frame').querySelector('iframe');
  h.window.dispatchEvent(new TestEvent('pagehide', { persisted: true }));
  assert.equal(frame.getAttribute('src'), null);
  assert.equal(frame.parentNode, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.node('dashboard-video-load').disabled, false);
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  assert.equal(h.node('dashboard-video-frame').querySelector('iframe'), null);
  assert.equal(h.node('dashboard-video-poster').hidden, false);
  h.node('dashboard-video-load').click();
  assert.ok(h.node('dashboard-video-frame').querySelector('iframe'));
});

test('dashboard video cleanup removes source, callbacks and timer; detached controls cannot restart it', async t => {
  const h = await dashboard(t);
  h.node('dashboard-video-load').click();
  const frame = h.node('dashboard-video-frame').querySelector('iframe');
  const late = frame.listeners.get('error')[0].fn;
  h.page.dispose();
  const text = h.node('dashboard-video-status').textContent;
  assert.equal(frame.getAttribute('src'), null);
  assert.equal(frame.parentNode, null);
  assert.equal(h.timers.size, 0);
  assert.equal(frame.listeners.get('load').length, 0);
  assert.equal(frame.listeners.get('error').length, 0);
  h.node('dashboard-video-load').dispatchEvent(new TestEvent('click'));
  late(new TestEvent('error'));
  assert.equal(h.node('dashboard-video-frame').querySelector('iframe'), null);
  assert.equal(h.node('dashboard-video-status').textContent, text);
});

test('missing optional video elements do not prevent Ethics and reminder loading', async t => {
  for (const id of ['dashboard-video-frame', 'dashboard-video-poster', 'dashboard-video-load', 'dashboard-video-status']) {
    const h = await dashboard(t, {
      mount: false, modules: [{ path: 'public/js/dashboard.js', exports: 'mount' }],
    });
    h.node(id).remove();
    assert.doesNotThrow(() => h.context.mount(h.page));
    assert.deepEqual(h.requests.map(request => request.path), ['/api/reminders/upcoming?days=7', '/api/knowledge?limit=1']);
    h.latest('/api/reminders/upcoming').resolve([]);
    h.latest('/api/knowledge?').resolve([]);
    await drain();
    assert.match(h.node('ethics-preview').textContent, /indisponível/);
    assert.match(h.node('reminders-list').textContent, /Nenhuma notificação/);
  }
});

test('dashboard video reserves responsive space and never introduces third-party resource hints', async () => {
  const html = await readFile('public/dashboard.html', 'utf8');
  const css = await readFile('public/css/dashboard-home.css', 'utf8');
  assert.doesNotMatch(html, /<iframe|rel="(?:preconnect|dns-prefetch)"|src="https:\/\/[^"]*(?:youtube|ytimg)/);
  assert.match(css, /\.dashboard-video-frame\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
  assert.match(css, /\.dashboard-area-card\s*\{[^}]*min-height:\s*(?:44|48|52)px/);
});

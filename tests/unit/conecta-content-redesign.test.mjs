import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';
import { academyHarness, course, courseData, lessonData } from '../helpers/academy-frontend.mjs';

const ethicsId = 'aabbccdd-1234-4567-89ab-123456abcdef';
const ethicsArticle = (overrides = {}) => ({ id: ethicsId, title: 'Código de Ética', document: { kind: 'ethics' }, ...overrides });

test('dashboard discovers the ethics article once and links to Knowledge without trusting payload URLs or markup', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/reminders/upcoming').resolve([]);
  h.latest('/api/knowledge?').resolve([ethicsArticle({
    title: '<script>Código seguro</script>', content: '<img src=x onerror=alert(1)>',
    url: 'javascript:alert(1)', document: { kind: 'ethics', download_url: 'https://outside.test/private.pdf' },
  })]);
  await drain();
  const preview = h.node('ethics-preview');
  assert.equal(preview.textContent, 'Ler Código de Ética');
  assert.equal(preview.querySelectorAll('script').length, 0);
  assert.equal(preview.querySelector('a').getAttribute('href'), `./knowledge.html?article=${ethicsId}`);
  assert.equal(preview.querySelector('a').getAttribute('target'), null);
  assert.equal(preview.getAttribute('aria-busy'), 'false');
  const cover = h.doc.querySelector('.dashboard-ethics-cover');
  assert.equal(cover.getAttribute('src'), './assets/conecta/ethics-cover.svg');
  assert.equal(cover.getAttribute('width'), '960');
  assert.equal(cover.getAttribute('height'), '540');
  assert.equal(cover.getAttribute('alt'), '');
  assert.deepEqual(h.requests.map(request => request.path), ['/api/reminders/upcoming?days=7', '/api/knowledge?limit=1']);
});

test('dashboard ignores superseded ethics success and failure after BFCache refresh', async t => {
  for (const failure of [false, true]) {
    const h = await createFeedbackHarness('dashboard');
    t.after(() => h.page.dispose());
    const old = h.latest('/api/knowledge?');
    h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
    const freshId = 'bbccddee-2345-4678-9abc-234567abcdef';
    h.latest('/api/knowledge?').resolve([ethicsArticle({ id: freshId })]);
    await drain();
    if (failure) old.reject(new Error('old failure'));
    else old.resolve([ethicsArticle()]);
    await drain();
    assert.equal(h.node('ethics-preview').querySelector('a').getAttribute('href'), `./knowledge.html?article=${freshId}`);
    assert.equal(h.node('ethics-preview').querySelector('button'), null);
    assert.equal(h.node('ethics-preview').getAttribute('aria-busy'), 'false');
  }
});

test('dashboard has an honest unavailable state for an empty list, wrong descriptor or invalid identity', async t => {
  for (const data of [
    [], [null], [ethicsArticle({ document: null })],
    [ethicsArticle({ document: { kind: 'pdf' } }), ethicsArticle()],
    [ethicsArticle({ id: 'javascript:alert(1)' })],
    [ethicsArticle({ id: ` ${ethicsId}` })],
    [ethicsArticle({ id: ethicsId.replace('-4567-', '-0567-') })],
  ]) {
    const h = await createFeedbackHarness('dashboard');
    t.after(() => h.page.dispose());
    h.latest('/api/knowledge?').resolve(data);
    await drain();
    assert.match(h.node('ethics-preview').textContent, /Código de Ética está temporariamente indisponível/);
    assert.equal(h.node('ethics-preview').querySelector('a'), null);
    assert.equal(h.node('ethics-preview').querySelector('button'), null);
    assert.equal(h.node('ethics-preview').getAttribute('aria-busy'), 'false');
    assert.equal(h.requests.length, 2, 'never searches another endpoint or fetches private document bytes');
  }
});

test('dashboard retry restores its removed control focus without stealing a later user interaction', async t => {
  for (const moved of [false, true]) {
    const h = await createFeedbackHarness('dashboard');
    t.after(() => h.page.dispose());
    h.latest('/api/knowledge?').reject(new Error('offline'));
    await drain();
    const retry = h.node('ethics-preview').querySelector('button');
    retry.focus(); retry.click();
    const other = h.node('quick-links').querySelector('a');
    if (moved) other.focus();
    assert.equal(h.node('ethics-preview').getAttribute('aria-busy'), 'true');
    h.latest('/api/knowledge?').resolve([ethicsArticle()]);
    await drain();
    assert.equal(h.doc.activeElement, moved ? other : h.node('ethics-preview').querySelector('a'));
  }
});

test('dashboard retry keeps a visible focus destination on empty and repeated error responses', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/knowledge?').reject(new Error('offline'));
  await drain();
  const first = h.node('ethics-preview').querySelector('button'); first.focus(); first.click();
  h.latest('/api/knowledge?').reject(new Error('offline again'));
  await drain();
  const second = h.node('ethics-preview').querySelector('button');
  assert.equal(h.doc.activeElement, second);
  second.click();
  h.latest('/api/knowledge?').resolve([]);
  await drain();
  assert.equal(h.doc.activeElement, h.node('ethics-preview').querySelector('[role="status"]'));
  assert.equal(h.doc.activeElement.tabIndex, -1);
  const count = h.requests.length;
  h.page.dispose(); second.click();
  await drain();
  assert.equal(h.requests.length, count);
});

test('dashboard error and unavailable responses never steal focus moved away from retry', async t => {
  for (const failure of [false, true]) {
    const h = await createFeedbackHarness('dashboard');
    t.after(() => h.page.dispose());
    h.latest('/api/knowledge?').reject(new Error('offline'));
    await drain();
    const retry = h.node('ethics-preview').querySelector('button');
    retry.focus(); retry.click();
    const other = h.node('quick-links').querySelector('a');
    other.focus();
    if (failure) h.latest('/api/knowledge?').reject(new Error('still offline'));
    else h.latest('/api/knowledge?').resolve([ethicsArticle({ document: { kind: 'other' } })]);
    await drain();
    assert.equal(h.doc.activeElement, other);
  }
});

test('dashboard retains the current ethics action while refreshing and stale results cannot clear busy', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());
  h.latest('/api/knowledge?').resolve([ethicsArticle()]);
  await drain();
  const currentAction = h.node('ethics-preview').querySelector('a');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  const old = h.latest('/api/knowledge?');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  const latest = h.latest('/api/knowledge?');
  old.resolve([]);
  await drain();
  assert.equal(h.node('ethics-preview').querySelector('a'), currentAction);
  assert.equal(h.node('ethics-preview').getAttribute('aria-busy'), 'true');
  latest.resolve([]);
  await drain();
  assert.equal(h.node('ethics-preview').querySelector('a'), null);
  assert.equal(h.node('ethics-preview').getAttribute('aria-busy'), 'false');
});

test('dashboard optional containers can be omitted without blocking the remaining section', async t => {
  for (const omitted of ['ethics-preview', 'reminders-list']) {
    const h = await createFeedbackHarness('dashboard', {
      mount: false, user: { role: 'admin', autocard_access: true },
      modules: [{ path: 'public/js/dashboard.js', exports: 'mount' }],
    });
    t.after(() => h.page.dispose());
    for (const id of [omitted, 'dashboard-greeting', 'quick-links', 'tool-links']) h.node(id).remove();
    h.context.mount(h.page);
    assert.equal(h.requests.length, 1);
    if (omitted === 'ethics-preview') {
      h.latest('/api/reminders/upcoming').resolve([]);
      await drain();
      assert.match(h.node('reminders-list').textContent, /Nenhuma notificação/);
    } else {
      h.latest('/api/knowledge?').resolve([ethicsArticle()]);
      await drain();
      assert.match(h.node('ethics-preview').textContent, /Ler Código de Ética/);
    }
  }
});

test('dashboard names are trimmed to the first word, tolerate missing values and remain literal text', async t => {
  for (const [name, expected] of [
    ['  Ana   Maria  ', ', Ana'], ['   ', ''], [undefined, ''], [null, ''], [7, ''],
    ['<script>alert(1)</script> Silva', ', <script>alert(1)</script>'],
  ]) {
    const h = await createFeedbackHarness('dashboard', { user: { name } });
    t.after(() => h.page.dispose());
    const greeting = h.node('dashboard-greeting');
    assert.match(greeting.textContent, /^(Bom dia|Boa tarde|Boa noite)/);
    assert.ok(greeting.textContent.endsWith(`${expected}.`));
    assert.equal(greeting.querySelectorAll('script').length, 0);
    assert.equal(greeting.children.length, 0);
  }
});

test('dashboard compact links retain named destinations; tools follow strict verified profile flags and admin role', async t => {
  for (const [user, permitted] of [
    [{ role: 'user' }, []],
    [{ role: 'admin' }, ['./admin.html']],
    [{ role: 'admin', permissions: { superAdmin: true }, autocard_access: true, pos_cards_access: true }, ['./autocard.html', './cards-pos.html', './admin.html']],
    [{ role: 'admin', permissions: { superAdmin: true }, autocard_access: false, pos_cards_access: false }, ['./admin.html']],
    [{ role: 'user', autocard_access: true }, ['./autocard.html']],
    [{ role: 'user', pos_cards_access: true }, ['./cards-pos.html']],
    [{ role: 'user', autocard_access: 'true', pos_cards_access: 1, permissions: { superAdmin: true } }, []],
  ]) {
    const h = await createFeedbackHarness('dashboard', { user });
    t.after(() => h.page.dispose());
    const links = h.node('quick-links').querySelectorAll('a');
    assert.deepEqual(links.map(link => link.getAttribute('href')), ['./knowledge.html', './reminders.html', './pages.html', './profile.html']);
    for (const link of links) {
      assert.ok(link.querySelector('strong').textContent);
      assert.equal(link.querySelector('.dashboard-area-card-copy').children.length, 1);
      assert.equal(link.querySelector('a'), null, 'links cannot be nested');
    }
    assert.deepEqual(h.node('tool-links').querySelectorAll('a').map(link => link.getAttribute('href')), permitted);
    assert.equal(h.node('dashboard-tools').hidden, permitted.length === 0);
    assert.equal(h.requests.some(request => /academy|users\/me/.test(request.path)), false);
  }
});

test('Academy continuation action targets the saved lesson and keeps catalog focus while its response arrives', async t => {
  const h = await academyHarness();
  t.after(() => h.page.dispose());
  await h.resolve('group=initial', { data: [], total: 0 });
  const select = h.doc.querySelector('#academy-filter-initial'); select.focus();
  await h.resolve('/continue?', [course('older', { resume_lesson_id: 'lesson-b', completed_lessons: 1 })]);
  assert.equal(h.doc.activeElement, select);
  assert.equal(h.link('Continuar curso').getAttribute('href'), './academy.html?course=older&lesson=lesson-b');
  const progress = h.root.querySelector('progress');
  assert.equal(progress.getAttribute('value'), '1');
  assert.equal(progress.getAttribute('max'), '2');
  h.link('Continuar curso').click(); await drain();
  assert.equal(h.location.searchParams.get('lesson'), 'lesson-b');
  await h.resolve('/api/academy/older', courseData('older'));
  await h.resolve('/lessons/lesson-b', lessonData('lesson-b', { course_id: 'older' }));
  assert.equal(h.doc.activeElement.tagName, 'H1');
});

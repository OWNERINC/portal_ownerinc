import test from 'node:test';
import assert from 'node:assert/strict';
import { academyHarness, course, courseData, lessonData, drain, TestEvent } from '../helpers/academy-frontend.mjs';

async function classroom() {
  const h = await academyHarness({ url: 'https://portal.test/academy.html?course=course-a&lesson=lesson-a' });
  await h.resolve('/api/academy/course-a', courseData());
  await h.resolve('/lessons/lesson-a', lessonData());
  return h;
}
async function catalog(h, data = []) {
  await h.resolve('/continue?', []);
  for (const group of ['initial', 'role']) await h.resolve(`group=${group}`, { data, total: data.length });
  await h.resolve('/categories', ['Cultura', 'todos']);
}
test('real catalog retains brand and one h1 when empty; each group and continue is independent', async () => {
  const h = await academyHarness();
  assert.equal(h.requests.length, 4);
  let ready = false;
  const waiting = h.page.ready().then(() => { ready = true; });
  await drain(); assert.equal(ready, false, 'Portal restoration waits for explicit Academy reads');
  await h.resolve('/continue?', [course('older-course')]);
  assert.ok(h.link('Cultura Ownerinc'));
  await h.resolve('group=initial', { data: [], total: 0 });
  await h.resolve('group=role', { data: [], total: 0 });
  await h.resolve('/categories', []);
  await waiting; assert.equal(ready, true);
  assert.equal(h.root.querySelectorAll('h1').length, 1);
  assert.ok(h.root.querySelector('.academy-brand'));
  assert.match(h.root.textContent, /Escolha|Nenhum curso/);
  h.page.dispose();
});
test('failure and repeated retry recover without coupling to the other catalog sections', async () => {
  const h = await academyHarness();
  h.latest('group=initial').reject(new Error('network')); await drain();
  h.button('Tentar novamente').click(); await drain();
  h.latest('group=initial').reject(new Error('network')); await drain();
  h.button('Tentar novamente').click(); await drain();
  await h.resolve('group=initial', { data: [course()], total: 1 });
  assert.ok(h.link('Cultura Ownerinc'));
  h.page.dispose();
});
test('group pagination/filter URLs are independent; stale controls cannot mutate the current route', async () => {
  const h = await academyHarness({ url: 'https://portal.test/academy.html?role_category=Vendas&role_offset=40' });
  await h.resolve('group=initial', { data: [course()], total: 40 });
  await h.resolve('/categories', ['Cultura', 'todos']);
  const old = h.button('Próxima'); old.click(); await drain();
  assert.equal(h.location.searchParams.get('initial_offset'), '20');
  assert.equal(h.location.searchParams.get('role_offset'), '40');
  old.click(); await drain(); assert.equal(h.entries.length, 2);
  assert.match(h.latest('group=role').path, /category=Vendas/);
  assert.equal(h.doc.activeElement.tagName, 'H1');
  await h.resolve('group=initial', { data: [], total: 0 });
  h.button('Ver todos os cursos deste grupo').click(); await drain();
  assert.equal(h.location.searchParams.get('initial_offset'), '0');
  h.page.dispose();
});
test('catalog return metadata survives detail and Back/Forward within the shell', async () => {
  const h = await academyHarness({ url: 'https://portal.test/academy.html?group=initial&category=Cultura&offset=20' });
  const sidebar = h.doc.querySelector('.sidebar');
  await catalog(h, [course()]);
  h.link('Cultura Ownerinc').click(); await drain();
  assert.equal(h.history.state.custom, 'preserved');
  assert.match(h.history.state.academyCatalog, /offset=20/);
  await h.resolve('/api/academy/course-a', courseData());
  assert.match(h.link('← Voltar aos cursos').getAttribute('href'), /offset=20/);
  h.history.go(-1); await drain();
  assert.ok(h.root.querySelector('.academy-brand'));
  h.history.go(1); await drain(); await h.resolve('/api/academy/course-a', courseData());
  assert.ok(h.link('Começar curso'));
  assert.equal(h.doc.querySelector('.sidebar'), sidebar);
  h.page.dispose();
});
test('late lesson A cannot replace B or instantiate its player', async () => {
  const h = await academyHarness({ url: 'https://portal.test/academy.html?course=course-a&lesson=lesson-a' });
  await h.resolve('/api/academy/course-a', courseData());
  const old = h.latest('/lessons/lesson-a');
  await h.navigate('course=course-a&lesson=lesson-b');
  await h.resolve('/api/academy/course-a', courseData());
  await h.resolve('/lessons/lesson-b', lessonData('lesson-b'));
  old.resolve(lessonData()); await drain();
  assert.equal(old.options.signal.aborted, true);
  assert.equal(h.players.length, 1);
  assert.equal(h.players[0].options.host.getAttribute('aria-label'), 'Nosso jeito');
  assert.equal(h.root.querySelectorAll('h1').length, 1);
  h.page.dispose();
});
test('unavailable course and mismatched URLs never fetch or mount playable media', async () => {
  for (const mismatch of [false, true]) {
    const h = await academyHarness({ url: `https://portal.test/academy.html?course=course-a&lesson=${mismatch ? 'foreign' : 'lesson-a'}` });
    if (mismatch) await h.resolve('/api/academy/course-a', courseData());
    else { h.latest('/api/academy/course-a').reject(Object.assign(new Error(), { status: 404 })); await drain(); }
    assert.match(h.root.textContent, /Este conteúdo não está disponível para seu perfil/);
    assert.equal(h.players.length, 0);
    assert.equal(h.requests.length, 1);
    h.page.dispose();
  }
});
test('a returned lesson with the wrong parent is also rejected', async () => {
  const h = await academyHarness({ url: 'https://portal.test/academy.html?course=course-a&lesson=lesson-a' });
  await h.resolve('/api/academy/course-a', courseData());
  await h.resolve('/lessons/lesson-a', lessonData('lesson-a', { course_id: 'foreign' }));
  assert.equal(h.players.length, 0); assert.match(h.root.textContent, /não está disponível/); h.page.dispose();
});
test('management and editorial preview require explicit permission', async () => {
  for (const query of ['manage=1', 'course=course-a&preview=1']) {
    const h = await academyHarness({ url: `https://portal.test/academy.html?${query}` });
    assert.equal(h.requests.length, 0); assert.match(h.root.textContent, /não está disponível/); h.page.dispose();
  }
});
test('manual completion is busy and never optimistic; only its own acknowledgement marks the lesson', async () => {
  const h = await classroom();
  const player = h.players[0]; player.position = 32; player.options.onPosition(32);
  player.options.onPause(); await drain();
  const background = h.latest('/progress'); assert.equal(h.page.busy, false);
  const action = h.button('Concluir aula'); action.focus(); action.click(); await drain();
  assert.equal(h.page.busy, true); assert.equal(h.page.canLeave(), false);
  assert.equal(h.link('Próxima aula →').hidden, true);
  background.resolve({ ...lessonData().progress, position_seconds: 32, version: 1 }); await drain();
  const own = h.latest('/progress'); assert.notEqual(own, background);
  assert.equal(JSON.parse(own.options.body).completed, true);
  assert.equal(action.textContent, 'Concluir aula');
  own.resolve({ ...lessonData().progress, position_seconds: 32, version: 2, completed: true }); await drain();
  assert.equal(action.textContent, 'Aula concluída'); assert.equal(h.link('Próxima aula →').hidden, false);
  assert.equal(h.doc.activeElement, action); assert.equal(h.page.busy, false);
  h.page.dispose();
});
test('failed, unconfirmed and backoff completion never show success', async () => {
  for (const response of ['failure', 'unconfirmed']) {
    const h = await classroom(); h.button('Concluir aula').click(); await drain();
    const request = h.latest('/progress');
    if (response === 'failure') request.reject(new Error('offline'));
    else request.resolve({ ...lessonData().progress, version: 1 });
    await drain();
    assert.ok(h.button('Concluir aula')); assert.equal(h.link('Próxima aula →').hidden, true);
    assert.match(h.root.textContent, /Não foi possível concluir/);
    if (response === 'failure') { h.button('Concluir aula').click(); await drain(); assert.ok(h.button('Concluir aula')); }
    h.page.dispose();
  }
});
test('explicit switch flushes then destroys the old player before mounting the next', async () => {
  const h = await classroom(), old = h.players[0];
  old.position = 47;
  h.link('Nosso jeito').click(); await drain();
  assert.equal(h.location.searchParams.get('lesson'), 'lesson-a');
  assert.equal(old.destroyed, false);
  await h.resolve('/progress', { ...lessonData().progress, position_seconds: 47, version: 1 });
  assert.equal(old.destroyed, true); assert.equal(old.options.signal.aborted, true);
  await h.resolve('/api/academy/course-a', courseData());
  await h.resolve('/lessons/lesson-b', lessonData('lesson-b'));
  assert.equal(h.players.length, 2); h.page.dispose();
});
test('leaving the area aborts sublesson resources and no late response restores private content', async () => {
  const h = await classroom();
  h.players[0].options.onPosition(30); h.players[0].options.onPause(); await drain();
  const save = h.latest('/progress');
  h.page.dispose();
  assert.equal(h.players[0].destroyed, true); assert.equal(save.options.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  save.resolve({ ...lessonData().progress, completed: true }); await drain();
  assert.equal(h.button('Aula concluída'), undefined);
});
test('focus revalidation destroys player and materials on definitive access loss, not network failure', async () => {
  const h = await classroom();
  h.window.dispatchEvent(new TestEvent('focus')); await drain();
  h.latest('/lessons/lesson-a').reject(new Error('network')); await drain();
  assert.equal(h.players[0].destroyed, false);
  h.window.dispatchEvent(new TestEvent('focus')); await drain();
  h.latest('/lessons/lesson-a').reject(Object.assign(new Error(), { status: 404 })); await drain();
  assert.equal(h.players[0].destroyed, true);
  assert.equal(h.root.querySelector('.academy-materials').textContent, '');
  assert.match(h.root.textContent, /não está disponível para seu perfil/);
  h.page.dispose();
});
test('definitive save authorization loss clears the lesson immediately', async () => {
  const h = await classroom(); h.button('Concluir aula').click(); await drain();
  h.latest('/progress').reject(Object.assign(new Error(), { status: 403 })); await drain();
  assert.equal(h.players[0].destroyed, true);
  assert.equal(h.root.querySelector('.academy-materials').textContent, ''); h.page.dispose();
});
test('external courses use validated links, while internal courses resume inside Portal', async () => {
  for (const external of [false, true]) {
    const h = await academyHarness({ url: 'https://portal.test/academy.html?course=course-a' });
    await h.resolve('/api/academy/course-a', courseData('course-a', external ? { delivery_mode: 'external', url: 'javascript:alert(1)' } : { resume_lesson_id: 'lesson-b' }));
    if (external) { assert.match(h.root.textContent, /Link externo indisponível/); assert.equal(h.root.querySelector('.academy-curriculum'), null); }
    else assert.match(h.link('Continuar curso').getAttribute('href'), /lesson=lesson-b/);
    h.page.dispose();
  }
});

test('player loader has a stable host and a usable retry; CMS assets abort with the lesson', async () => {
  const h = await academyHarness({ url: 'https://portal.test/academy.html?course=course-a&lesson=lesson-a', playerFailures: 1 });
  await h.resolve('/api/academy/course-a', courseData());
  await h.resolve('/lessons/lesson-a', lessonData('lesson-a', { content_blocks: [{ type: 'image', asset_id: 'c0b4af6a-4608-40f7-bfb0-2e0a19e2181e', alt: 'Material de apoio' }] }));
  const host = h.root.querySelector('.academy-player');
  assert.equal(host.getAttribute('aria-busy'), 'false');
  const asset = h.latest('/cms/assets/'); assert.ok(asset);
  h.button('Tentar novamente').click(); await drain();
  assert.equal(h.players.length, 1); assert.equal(h.players[0].options.host, host);
  h.page.dispose(); assert.equal(asset.options.signal.aborted, true);
  asset.resolve('blob:late-material'); await drain(); assert.ok(h.revoked.includes('blob:late-material'));
});

test('an authorized preview uses explicit all=true but never persists progress', async () => {
  const h = await academyHarness({ manager: true, url: 'https://portal.test/academy.html?course=course-a&lesson=lesson-a&preview=1' });
  assert.match(h.latest('/api/academy/course-a').path, /all=true/);
  await h.resolve('/api/academy/course-a', courseData());
  assert.match(h.latest('/lessons/lesson-a').path, /all=true/);
  await h.resolve('/lessons/lesson-a', lessonData());
  h.players[0].options.onPosition(50); h.players[0].options.onPause();
  assert.equal(h.button('Concluir aula').disabled, true);
  assert.equal(h.latest('/progress'), undefined); h.page.dispose();
});

test('the actual Dashboard opens internal courses in Portal and keeps valid legacy external destinations', async () => {
  const { createFeedbackHarness } = await import('../helpers/frontend-feedback-harness.mjs');
  const h = await createFeedbackHarness('dashboard');
  h.latest('/api/academy?').resolve([course('course-a'), course('external', { delivery_mode: 'external', url: 'https://training.test/course' })]);
  await drain();
  const links = h.node('academy-preview').querySelectorAll('a');
  assert.equal(links[0].getAttribute('href'), './academy.html?course=course-a');
  assert.equal(links[0].getAttribute('target'), null);
  assert.equal(links[1].getAttribute('href'), 'https://training.test/course');
  assert.equal(links[1].getAttribute('target'), '_blank');
  assert.equal(h.latest('/api/announcements?').path, '/api/announcements?limit=3&offset=0');
  h.page.dispose();
});

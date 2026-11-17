import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { FixtureNode, TestEvent, parseInto, deferred, drain, createFeedbackHarness } from '../helpers/frontend-feedback-harness.mjs';

const [app, manager, course, curriculum, admin] = await Promise.all([
  readFile('public/academy/app.js', 'utf8'), readFile('public/academy/manage-view.js', 'utf8'),
  readFile('public/academy/course-editor.js', 'utf8'), readFile('public/academy/curriculum-editor.js', 'utf8'),
  readFile('public/js/admin.js', 'utf8'),
]);

async function curriculumHarness(extraLesson = false) {
  const doc = new FixtureNode('document'); doc.ownerDocument = doc;
  doc.createElement = tag => new FixtureNode(tag, doc);
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  const window = new FixtureNode('window', doc); window.confirm = () => true;
  const requests = [];
  const transport = (path, options = {}) => { const item = { path, options, ...deferred() }; requests.push(item); return item.promise; };
  const pageController = new AbortController();
  const guards = [];
  const page = {
    signal: pageController.signal,
    bindAPI() { return { fetchAPI: transport, fetchAPIPage: transport }; },
    beforeLeave(guard) { guards.push(guard); },
    canLeave() { return guards.every(guard => guard() !== false); },
  };
  const context = vm.createContext({ document: doc, window, console, AbortController, DOMException, URLSearchParams, URL, setTimeout, clearTimeout,
    fetchAPI: transport, fetchAPIPage: transport });
  const ui = (await readFile('public/js/ui.js', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${ui}\nglobalThis.element = element;`, context);
  const source = curriculum.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.createCurriculumEditor = createCurriculumEditor;`, context);
  const root = doc.createElement('main');
  const handle = context.createCurriculumEditor({ root, page, courseId: 'course-a', initialCourse: {
    id: 'course-a', delivery_mode: 'internal', modules: [{ id: 'module-a', title: 'Módulo original', order: 1, active: false,
      lessons: [{ id: 'lesson-a', title: 'Aula original', order: 1, active: false, media_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ', description: '' },
        ...(extraLesson ? [{ id: 'lesson-b', title: 'Segunda aula', order: 2, active: false, media_type: 'file', media_url: 'https://media.test/b.mp4', description: '' }] : [])] }],
  } });
  await drain();
  return { root, requests, handle, pageController, window, page };
}

function button(root, text) { return root.querySelectorAll('button').find(node => node.textContent === text); }

async function managerHarness(search = '?manage=1', { allowed = true, courseId, newCourse = false } = {}) {
  const h = await createFeedbackHarness('academy', { mount: false, url: `https://portal.test/academy.html${search}`,
    modules: [{ path: 'public/academy/view-utils.js', exports: 'routeLink, button, errorState' }] });
  const navigations = [], editors = [];
  // The router facade exposes writes only; read state from window.history.
  h.page.history = Object.fromEntries(['pushState', 'replaceState'].map(method => [method, h.window.history[method].bind(h.window.history)]));
  Object.assign(h.context, {
    can: () => allowed,
    createCourseEditor: options => { editors.push(options); return { dispose() {} }; },
    createCurriculumEditor: () => ({ dispose() {} }),
  });
  vm.runInContext(`${manager.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')}\nglobalThis.mountAcademyManager = mountAcademyManager;`, h.context);
  const root = h.node('academy-root');
  const dispose = h.context.mountAcademyManager({ root, page: h.page, courseId, newCourse, navigate: params => navigations.push({ ...params }) });
  await drain();
  return { ...h, root, dispose, navigations, editors };
}
const courses = (offset, count) => Array.from({ length: count }, (_, i) => ({
  id: `course-${offset + i}`, title: `Curso ${offset + i}`, delivery_mode: 'external', active: true,
}));

test('management reaches all 105 courses in bounded pages with total, links and navigation context', async () => {
  const seen = [];
  for (let offset = 0; offset < 105; offset += 20) {
    const h = await managerHarness(`?manage=1&manage_offset=${offset}`);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].path, `/api/academy?all=true&limit=20&offset=${offset}`);
    h.requests[0].resolve({ data: courses(offset, Math.min(20, 105 - offset)), total: 105 }); await drain();
    const links = h.root.querySelector('.academy-manager-list').querySelectorAll('a');
    seen.push(...links.map(link => new URL(link.href, h.page.location.href).searchParams.get('course')));
    for (const link of links) assert.equal(new URL(link.href, h.page.location.href).searchParams.get('manage_offset'), String(offset));
    assert.match(h.root.textContent, new RegExp(`Página ${offset / 20 + 1} de 6 · 105 cursos`));
    assert.equal(Boolean(button(h.root, 'Anterior')), offset > 0);
    assert.equal(Boolean(button(h.root, 'Próxima')), offset < 100);
    const create = h.root.querySelectorAll('a').find(link => link.textContent === 'Novo curso');
    assert.equal(new URL(create.href, h.page.location.href).searchParams.get('manage_offset'), String(offset));
    if (offset < 100) {
      button(h.root, 'Próxima').click(); button(h.root, 'Próxima').click();
      await drain();
      assert.deepEqual(h.navigations, [{ manage: '1', manage_offset: String(offset + 20) }]);
    } else {
      links.at(-1).click();
      assert.deepEqual(h.navigations, [{ manage: '1', manage_offset: '100', course: 'course-104' }]);
    }
    h.dispose(); h.page.dispose();
  }
  assert.deepEqual(seen, courses(0, 105).map(item => item.id));
});

test('management editor cancel and creation retain their source page', async () => {
  for (const newCourse of [false, true]) {
    const h = await managerHarness('?manage=1&manage_offset=100', { newCourse, courseId: newCourse ? undefined : 'course-104' });
    if (!newCourse) { h.requests[0].resolve({ course: courses(104, 1)[0] }); await drain(); }
    h.editors[0].onCancel();
    assert.deepEqual(h.navigations[0], { manage: '1', manage_offset: '100' });
    if (newCourse) {
      h.editors[0].onSaved({ id: 'created' });
      assert.deepEqual(h.navigations[1], { manage: '1', manage_offset: '100', course: 'created' });
    }
    h.dispose(); h.page.dispose();
  }
});

test('management canonicalizes invalid offsets without losing router state or pushing history', async () => {
  for (const [input, expected] of [['-20', 0], ['abc', 0], ['1e2', 0], ['9007199254740992', 0], ['1000020', 0], ['1000000', 1000000], ['39', 20], ['020', 20]]) {
    const h = await managerHarness(`?manage=1&manage_offset=${input}`);
    assert.equal(h.requests[0].path, `/api/academy?all=true&limit=20&offset=${expected}`);
    assert.equal(new URL(h.page.location.href).searchParams.get('manage_offset'), String(expected));
    assert.equal(h.window.history.length, 1);
    h.dispose(); h.requests[0].resolve({ data: [], total: 0 }); await drain(); h.page.dispose();
  }
});

test('management recovers a removed last page once and preserves history state', async () => {
  const h = await managerHarness('?manage=1&manage_offset=100');
  h.window.history.replaceState({ routerIndex: 7, academyCatalog: '/academy.html?initial_offset=20' }, '', h.page.location.href);
  h.requests[0].resolve({ data: [], total: 42 }); await drain();
  assert.equal(h.requests[1].path, '/api/academy?all=true&limit=20&offset=40');
  assert.equal(new URL(h.page.location.href).searchParams.get('manage_offset'), '40');
  assert.equal(h.window.history.state.routerIndex, 7);
  h.requests[1].resolve({ data: courses(40, 2), total: 42 }); await drain();
  assert.match(h.root.textContent, /Página 3 de 3 · 42 cursos/);
  assert.equal(h.window.history.length, 1);
  h.dispose(); h.page.dispose();
  const changedAgain = await managerHarness('?manage=1&manage_offset=100');
  changedAgain.requests[0].resolve({ data: [], total: 42 }); await drain();
  changedAgain.requests[1].resolve({ data: [], total: 1 }); await drain();
  assert.equal(changedAgain.requests.length, 2, 'bounded recovery on concurrent deletions');
  assert.ok(button(changedAgain.root, 'Tentar novamente'));
  changedAgain.dispose(); changedAgain.page.dispose();
});

test('management distinguishes empty/forbidden/error and retries the same page once with focus', async () => {
  const h = await managerHarness('?manage=1&manage_offset=20');
  h.requests[0].reject(new Error('offline')); await drain();
  const retry = button(h.root, 'Tentar novamente'); assert.ok(retry); retry.focus();
  retry.click(); retry.click(); await drain();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].path, h.requests[0].path);
  h.requests[1].resolve({ data: courses(20, 1), total: 21 }); await drain();
  assert.equal(h.doc.activeElement, h.root.querySelector('h1'));
  h.dispose(); h.page.dispose();
  const empty = await managerHarness();
  empty.requests[0].resolve({ data: [], total: 0 }); await drain();
  assert.match(empty.root.textContent, /Nenhum curso cadastrado/);
  assert.equal(button(empty.root, 'Tentar novamente'), undefined);
  empty.dispose(); empty.page.dispose();
  const forbidden = await managerHarness('?manage=1', { allowed: false });
  assert.equal(forbidden.requests.length, 0);
  assert.match(forbidden.root.textContent, /não está disponível/);
  forbidden.dispose(); forbidden.page.dispose();
  const revoked = await managerHarness('?manage=1&manage_offset=20');
  revoked.requests[0].reject(Object.assign(new Error('forbidden'), { status: 403 })); await drain();
  assert.match(revoked.root.textContent, /não tem permissão/);
  assert.equal(button(revoked.root, 'Tentar novamente'), undefined);
  assert.equal(revoked.root.querySelector('.academy-manager-list'), null);
  revoked.dispose(); revoked.page.dispose();
});

test('management ignores late success and failure after disposal', async () => {
  for (const failure of [false, true]) {
    const h = await managerHarness();
    h.dispose();
    if (failure) h.requests[0].reject(new Error('late failure'));
    else h.requests[0].resolve({ data: courses(0, 1), total: 1 });
    await drain();
    assert.equal(h.root.textContent, '');
    h.page.dispose();
  }
});

test('Academy management is a permissioned route with dedicated editors and real API links', () => {
  assert.match(app, /mountAcademyManager/);
  assert.match(manager, /can\(page\?\.user, 'manageAcademy'\)/);
  assert.match(course, /allowed_job_title_ids/);
  assert.match(course, /api\/academy\/job-titles\?limit=100/);
  assert.match(curriculum, /modules\/order/);
  assert.match(curriculum, /lessons\/order/);
  assert.match(curriculum, /controller\.abort/);
  assert.doesNotMatch(manager, /\/api\/cms|ensureLessonDocument|lessonDocumentFlights/);
  assert.doesNotMatch(curriculum, /cms\.html|ensureLessonDocument|Materiais/);
  assert.match(admin, /academy\.html\?manage=1&course=/);
});

test('typing a curriculum draft protects navigation; pending and failed saves retain it', async () => {
  const h = await curriculumHarness();
  const title = h.root.querySelectorAll('input').find(node => node.value === 'Aula original');
  title.value = 'Rascunho'; title.dispatchEvent(new TestEvent('input', { bubbles: true }));
  h.window.confirm = () => false;
  assert.equal(h.handle.isDirty(), true);
  assert.equal(h.page.canLeave(), false);
  h.window.confirm = () => true;
  assert.equal(h.page.canLeave(), true);
  button(h.root, 'Salvar aula').click(); await drain();
  assert.equal(h.page.canLeave(), false);
  h.requests.at(-1).reject(new Error('Falha de escrita')); await drain();
  assert.equal(title.value, 'Rascunho');
  assert.equal(h.handle.isDirty(), true);
});

test('saving a module preserves the pending lesson after authoritative refresh', async () => {
  const h = await curriculumHarness();
  const title = h.root.querySelectorAll('input').find(node => node.value === 'Aula original');
  title.value = 'Edição pendente'; title.dispatchEvent(new TestEvent('input', { bubbles: true }));
  button(h.root, 'Salvar módulo').click(); await drain();
  h.requests.at(-1).resolve({ id: 'module-a' }); await drain();
  h.requests.at(-1).resolve({ course: { id: 'course-a' }, modules: [{ id: 'module-a', title: 'Módulo salvo', active: false, order: 1,
    lessons: [{ id: 'lesson-a', title: 'Aula original', order: 1, active: false, media_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ', description: 'Descrição preservada' }] }] });
  await drain();
  assert.ok(h.root.querySelectorAll('input').some(node => node.value === 'Edição pendente'));
  assert.equal(h.handle.isDirty(), true);
  button(h.root, 'Salvar aula').click(); await drain();
  const body = JSON.parse(h.requests.at(-1).options.body);
  assert.equal(body.title, 'Edição pendente');
  assert.equal(body.description, 'Descrição preservada');
});

test('inline lesson validates, retains inputs on error, and closes after committed POST even if refresh fails', async () => {
  const h = await curriculumHarness();
  button(h.root, 'Adicionar aula').click();
  const form = h.root.querySelector('form');
  form.reportValidity = () => true;
  const [title, url] = form.querySelectorAll('input');
  const submit = () => form.dispatchEvent(new TestEvent('submit', { bubbles: true }));
  submit(); await drain();
  assert.equal(h.requests.length, 0);
  title.value = 'Nova aula'; title.dispatchEvent(new TestEvent('input'));
  url.value = 'https://media.test/new.mp4'; url.dispatchEvent(new TestEvent('input'));
  submit(); await drain();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0].options.body).media, { type: 'file', url: url.value });
  submit(); await drain(); assert.equal(h.requests.length, 1, 'No duplicate POST while pending');
  h.requests[0].reject(new Error('Erro de escrita')); await drain();
  assert.equal(title.value, 'Nova aula'); assert.equal(url.value, 'https://media.test/new.mp4');
  h.window.confirm = () => false;
  button(form, 'Cancelar').click(); assert.ok(h.root.querySelector('form'));
  submit(); await drain();
  h.requests.at(-1).resolve({ id: 'lesson-b', title: 'Nova aula', media_type: 'file', media_url: url.value, active: false, order: 2 }); await drain();
  h.requests.at(-1).reject(new Error('Erro no refresh')); await drain();
  assert.equal(h.root.querySelector('form'), null);
  assert.ok(h.root.querySelectorAll('input').some(node => node.value === 'Nova aula'));
  assert.equal(h.handle.isDirty(), false);
});

test('reorder ACK survives failed refresh and subsequent title save never resends stale order', async () => {
  const h = await curriculumHarness(true);
  h.root.querySelectorAll('button').find(node => node.getAttribute('aria-label') === 'Mover aula Segunda aula para cima').click();
  await drain();
  assert.deepEqual(JSON.parse(h.requests.at(-1).options.body).ids, ['lesson-b', 'lesson-a']);
  h.requests.at(-1).resolve([{ id: 'lesson-b', order: 1 }, { id: 'lesson-a', order: 2 }]); await drain();
  h.requests.at(-1).reject(new Error('Falha de releitura')); await drain();
  const titles = h.root.querySelectorAll('input').filter(node => node.getAttribute('aria-label')?.startsWith('Título da aula'));
  assert.deepEqual(titles.map(node => node.value), ['Segunda aula', 'Aula original']);
  titles[0].value = 'Título confirmado'; titles[0].dispatchEvent(new TestEvent('input'));
  button(h.root, 'Salvar aula').click(); await drain();
  const body = JSON.parse(h.requests.at(-1).options.body);
  assert.equal(body.title, 'Título confirmado');
  assert.equal(Object.hasOwn(body, 'order'), false);
  h.requests.at(-1).resolve({ id: 'lesson-b', title: 'Título confirmado', order: 1 }); await drain();
  h.requests.at(-1).reject(new Error('Falha de releitura')); await drain();
  assert.ok(h.root.querySelectorAll('input').some(node => node.value === 'Título confirmado'));
});

test('inline media classification uses exact YouTube hosts, never query fragments', async () => {
  const h = await curriculumHarness();
  button(h.root, 'Adicionar aula').click();
  const form = h.root.querySelector('form'); form.reportValidity = () => true;
  const [title, url] = form.querySelectorAll('input'); title.value = 'Nova aula';
  for (const [value, type] of [
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'youtube'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'youtube'],
    ['https://media.test/video.mp4?source=youtube.com', 'file'],
  ]) {
    url.value = value; form.dispatchEvent(new TestEvent('submit')); await drain();
    assert.deepEqual(JSON.parse(h.requests.at(-1).options.body).media, { type, url: value });
    h.requests.at(-1).reject(new Error('Manter formulário para próxima entrada')); await drain();
  }
});

test('course-save lock freezes curriculum controls without clearing drafts', async () => {
  const h = await curriculumHarness();
  const title = h.root.querySelectorAll('input').find(node => node.value === 'Aula original');
  title.value = 'Rascunho preservado'; title.dispatchEvent(new TestEvent('input'));
  h.handle.setLocked(true);
  assert.equal(title.disabled, true);
  assert.equal(h.page.canLeave(), false);
  button(h.root, 'Salvar aula').click();
  assert.equal(h.requests.length, 0);
  h.handle.setLocked(false);
  assert.equal(title.disabled, false);
  assert.equal(title.value, 'Rascunho preservado');
  assert.equal(h.handle.isDirty(), true);
});

test('ordinary module save reloads and renders the authoritative title/status', async () => {
  const h = await curriculumHarness();
  const moduleInput = h.root.querySelectorAll('input').find(node => node.value === 'Módulo original');
  moduleInput.value = 'Módulo atualizado';
  h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Módulo ativo Módulo original').checked = true;
  button(h.root, 'Salvar módulo').click(); await drain();
  const save = h.requests.find(request => request.path.includes('/modules/module-a') && request.options.method === 'PUT');
  assert.ok(save); save.resolve({ id: 'module-a', title: 'Módulo atualizado', active: true }); await drain();
  const reload = h.requests.at(-1); assert.match(reload.path, /\/api\/academy\/course-a\?all=true/);
  reload.resolve({ course: { id: 'course-a', delivery_mode: 'internal' }, modules: [{ id: 'module-a', title: 'Módulo do servidor', order: 2, active: true, lessons: [] }] }); await drain();
  assert.equal(h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Título do módulo Módulo do servidor').value, 'Módulo do servidor');
  assert.equal(h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Módulo ativo Módulo do servidor').checked, true);
});

test('ordinary lesson save reloads title/media/status/order and ignores a late refresh after dispose', async () => {
  const h = await curriculumHarness();
  const lessonInput = h.root.querySelectorAll('input').find(node => node.value === 'Aula original');
  lessonInput.value = 'Aula atualizada';
  button(h.root, 'Salvar aula').click(); await drain();
  const save = h.requests.find(request => request.path.includes('/lessons/lesson-a') && request.options.method === 'PUT');
  assert.ok(save); save.resolve({ id: 'lesson-a', title: 'Aula atualizada' }); await drain();
  const reload = h.requests.at(-1); assert.match(reload.path, /\/api\/academy\/course-a\?all=true/);
  reload.resolve({ course: { id: 'course-a', delivery_mode: 'internal' }, modules: [{ id: 'module-a', title: 'Módulo original', order: 1, active: false, lessons: [
    { id: 'lesson-a', title: 'Aula do servidor', order: 7, active: true, media_type: 'file', media_url: 'https://media.test/new.webm', description: '' },
    { id: 'lesson-b', title: 'Outra aula', order: 8, active: false, media_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ', description: '' },
  ] }] }); await drain();
  const refreshedInputs = h.root.querySelectorAll('input');
  assert.equal(refreshedInputs.find(node => node.getAttribute('aria-label') === 'Título da aula Aula do servidor').value, 'Aula do servidor');
  assert.equal(refreshedInputs.find(node => node.getAttribute('aria-label') === 'Vídeo da aula Aula do servidor').value, 'https://media.test/new.webm');
  assert.equal(refreshedInputs.find(node => node.getAttribute('aria-label') === 'Aula ativa Aula do servidor').checked, true);
  const lessonTitles = refreshedInputs.filter(node => node.getAttribute('aria-label')?.startsWith('Título da aula')).map(node => node.value);
  assert.deepEqual(lessonTitles, ['Aula do servidor', 'Outra aula']);
  const refreshedSave = h.root.querySelectorAll('button').find(node => node.textContent === 'Salvar aula');
  refreshedSave.click(); await drain();
  const secondSave = h.requests.find(request => request.path.includes('/lessons/lesson-a') && request.options.method === 'PUT' && request !== save);
  assert.ok(secondSave, 'the second mutation should start a second authoritative reload');
  secondSave.resolve({ id: 'lesson-a', title: 'Aula atualizada novamente' }); await drain();
  const lateRefresh = h.requests.at(-1);
  assert.match(lateRefresh.path, /\/api\/academy\/course-a\?all=true/);
  h.handle.dispose(); lateRefresh.resolve({ course: { id: 'course-a', delivery_mode: 'internal' }, modules: [{ id: 'module-a', title: 'Estado tardio', order: 9, active: true, lessons: [] }] }); await drain();
  assert.equal(h.root.children.length, 0);
});

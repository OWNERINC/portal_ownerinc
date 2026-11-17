import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { FixtureNode, TestEvent, parseInto, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

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

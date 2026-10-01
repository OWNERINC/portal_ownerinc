import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { FixtureNode, TestEvent, parseInto, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

const [app, manager, course, curriculum, cms, admin] = await Promise.all([
  readFile('public/academy/app.js', 'utf8'), readFile('public/academy/manage-view.js', 'utf8'),
  readFile('public/academy/course-editor.js', 'utf8'), readFile('public/academy/curriculum-editor.js', 'utf8'),
  readFile('public/js/cms.js', 'utf8'), readFile('public/js/admin.js', 'utf8'),
]);

async function curriculumHarness() {
  const doc = new FixtureNode('document'); doc.ownerDocument = doc;
  doc.createElement = tag => new FixtureNode(tag, doc);
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  const window = new FixtureNode('window', doc); window.confirm = () => true;
  const requests = [];
  const transport = (path, options = {}) => { const item = { path, options, ...deferred() }; requests.push(item); return item.promise; };
  const pageController = new AbortController();
  const page = {
    signal: pageController.signal,
    bindAPI() { return { fetchAPI: transport, fetchAPIPage: transport }; },
    beforeLeave() {},
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
      lessons: [{ id: 'lesson-a', title: 'Aula original', order: 1, active: false, media_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ', description: '' }] }],
  } });
  await drain();
  requests.at(-1).resolve({ course: { id: 'course-a', delivery_mode: 'internal' }, modules: [{ id: 'module-a', title: 'Módulo original', order: 1, active: false,
    lessons: [{ id: 'lesson-a', title: 'Aula original', order: 1, active: false, media_type: 'youtube', youtube_video_id: 'dQw4w9WgXcQ', description: '' }] }] });
  await drain();
  return { root, requests, handle, pageController, window };
}

function button(root, text) { return root.querySelectorAll('button').find(node => node.textContent === text); }

test('Academy management is a permissioned route with dedicated editors and real API links', () => {
  assert.match(app, /mountAcademyManager/);
  assert.match(manager, /can\(page\?\.user, 'manageAcademy'\)/);
  assert.match(manager, /academy_lesson/);
  assert.match(manager, /source_id/);
  assert.match(course, /allowed_job_title_ids/);
  assert.match(course, /api\/academy\/job-titles\?limit=100/);
  assert.match(curriculum, /modules\/order/);
  assert.match(curriculum, /lessons\/order/);
  assert.match(curriculum, /controller\.abort/);
  assert.match(curriculum, /cms\.html\?type=academy_lesson&document=/);
  assert.match(admin, /academy\.html\?manage=1&course=/);
});

test('CMS lesson type and deep links remain type-scoped', () => {
  assert.match(cms, /\['academy_lesson', 'Academy — Aulas', 'manageAcademy'\]/);
  assert.match(cms, /academy_lesson: '\/api\/academy\/lessons\?all=true&limit=100&offset=0'/);
  assert.match(cms, /requestedTypeAllowed/);
  assert.match(cms, /doc\.content_type !== selectedType/);
});

test('management editors protect dirty and in-flight navigation', () => {
  assert.match(course, /page\.beforeLeave\(\(\) => !saving/);
  assert.match(curriculum, /page\.beforeLeave\(\(\) => !saving/);
  assert.match(manager, /curriculum\?\.dispose\(\)/);
  assert.match(manager, /view\.course \|\| view/);
  assert.match(manager, /delivery_mode === 'internal'/);
  assert.match(manager, /error\?\.status === 409/);
  assert.match(manager, /findExisting/);
});

test('materials are single-flight per lesson and curriculum refreshes authoritative state after mutations', () => {
  assert.match(manager, /lessonDocumentFlights/);
  assert.match(manager, /existingFlight/);
  assert.match(manager, /error\?\.status === 409/);
  assert.match(curriculum, /documentBusy/);
  assert.match(curriculum, /course = null; panel\.querySelector/);
  assert.match(curriculum, /const loaded = await request\.fetchAPI\(`\/api\/academy/);
  assert.match(curriculum, /loadToken/);
  assert.match(curriculum, /const result = await save\(`\/api\/academy\/lessons/);
  assert.match(curriculum, /const result = await save\(`\/api\/academy\/modules/);
  assert.match(curriculum, /if \(result && !disposed\) await reload\(\)/);
  assert.match(curriculum, /media: \{ type: 'youtube', url: '' \}/, 'new lessons start without a fabricated video URL');
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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createAcademyHttp } from '../helpers/academy-integration.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { authorizeLessonInTransaction } = require('./academy/authorization');

function fixture() {
  const closerJob = randomUUID();
  const captureJob = randomUUID();
  const courses = [
    { audience: 'job_titles', allowed_job_title_ids: [captureJob], category: 'Captação', learning_group: 'role' },
    { audience: 'all', allowed_job_title_ids: [], category: 'Cultura', learning_group: 'initial' },
    { audience: 'job_titles', allowed_job_title_ids: [closerJob], category: 'Vendas', learning_group: 'role' },
  ].map((row, order) => ({ id: randomUUID(), title: `Course ${order}`, description: 'Legacy', url: null,
    active: true, delivery_mode: 'internal', icon_key: 'icon-01', instructor_name: '', order, ...row }));
  const modules = courses.map(course => ({ id: randomUUID(), course_id: course.id, active: true, title: 'Module', order: 0 }));
  const lessons = modules.flatMap(module => [0, 1].map(order => ({ id: randomUUID(), module_id: module.id,
    active: true, title: `Lesson ${order}`, description: 'Simple description', order, media_type: 'youtube',
    youtube_video_id: 'dQw4w9WgXcQ', media_version: 1 })));
  const documents = [];
  const progress = [];
  const assets = [];
  const calls = [];
  let connections = 0;
  const users = {
    closer: { uid: 'closer', role: 'viewer', job_title_id: closerJob, job_title_active: true, permissions: {} },
    capture: { uid: 'capture', role: 'viewer', job_title_id: captureJob, job_title_active: true, permissions: {} },
    manager: { uid: 'manager', role: 'admin', permissions: { manageAcademy: true } },
    adminWithoutPermission: { uid: 'admin', role: 'admin', permissions: {} },
    noJob: { uid: 'no-job', role: 'viewer', permissions: {} },
  };
  const pool = {
    async connect() { connections++; return { query: pool.query, release() { connections--; } }; },
    async query(sql, values = []) {
      calls.push({ sql, values });
      let rows;
      if (/^(BEGIN|COMMIT|ROLLBACK)$|pg_advisory_xact_lock/.test(sql)) rows = [];
      else if (/scheduled.status = 'scheduled'/.test(sql)) rows = [];
      else if (/FROM academy a/.test(sql)) {
        rows = courses.filter(course => {
          const id = /a.id = \$(\d+)::uuid/.exec(sql);
          const category = /btrim\(a.category\) = \$(\d+)/.exec(sql);
          const group = /a.learning_group = \$(\d+)/.exec(sql);
          return (!id || course.id === values[Number(id[1]) - 1])
            && (!category || course.category.trim() === values[Number(category[1]) - 1])
            && (!group || course.learning_group === values[Number(group[1]) - 1]);
        }); // Policy still executes for every candidate; no policy replacement in the double.
      } else if (/FROM academy s/.test(sql)) {
        const ids = /FOR UPDATE OF s/.test(sql) ? values[0] : values[1];
        rows = courses.filter(row => ids.includes(row.id)).map(row => {
          const doc = documents.find(doc => doc.type === 'academy' && doc.source_id === row.id);
          return { source_id: row.id, source_active: row.active, document_id: doc?.id || null,
            published_revision_id: doc?.blocks ? doc.id : null, blocks: doc?.blocks || null };
        });
      } else if (/FROM cms_documents d/.test(sql)) {
        rows = documents.filter(row => row.type === values[0] && (Array.isArray(values[1]) ? values[1].includes(row.source_id) : row.source_id === values[1]));
      } else if (/FROM cms_assets/.test(sql)) rows = assets.filter(row => values[0].includes(row.id) && !row.deleting_at);
      else if (/SELECT m.course_id/.test(sql)) {
        const lesson = lessons.find(row => row.id === values[0].toLowerCase());
        const module = modules.find(row => row.id === lesson?.module_id);
        rows = module ? [{ course_id: module.course_id, module_id: module.id }] : [];
      } else if (/FROM academy WHERE id=/.test(sql)) rows = courses.filter(row => row.id === values[0]);
      else if (/FROM academy_course_job_titles/.test(sql)) rows = courses.find(row => row.id === values[0])?.allowed_job_title_ids.map(job_title_id => ({ job_title_id })) || [];
      else if (/FROM academy_modules/.test(sql)) rows = modules.filter(row => Array.isArray(values[0])
        ? values[0].includes(row.course_id) && (!/AND active = TRUE/.test(sql) || row.active)
        : row.id === values[0] && row.course_id === values[1]);
      else if (/FROM academy_lesson_progress/.test(sql)) rows = progress.filter(row => row.user_uid === values[0]
        && (Array.isArray(values[1]) ? values[1].includes(row.lesson_id) : row.lesson_id === values[1] && row.media_version === values[2]));
      else if (/COUNT\(\*\).*FROM academy_lessons/.test(sql)) rows = [{ count: lessons.length }];
      else if (/FROM academy_lessons l JOIN/.test(sql)) rows = lessons.slice(values[1], values[1] + values[0]);
      else if (/FROM academy_lessons/.test(sql)) rows = lessons.filter(row => Array.isArray(values[0])
        ? values[0].includes(row.module_id) && (!/AND active = TRUE/.test(sql) || row.active)
        : row.id === values[0] && row.module_id === values[1]);
      else throw new Error(`Unmocked academy SQL: ${sql}`);
      return { rows: structuredClone(rows) };
    },
  };
  return { pool, users, courses, modules, lessons, documents, progress, assets, calls, connections: () => connections,
    publish(type, source_id, blocks) { documents.push({ id: randomUUID(), type, source_id, blocks }); } };
}

test('HTTP authorization precedes pagination, counts and categories; groups are immediately available', async t => {
  const f = fixture();
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  const get = (path, user = 'closer') => request.get(`/api/academy${path}`).set('x-fixture-user', user);
  const first = await get('?limit=1&offset=0').expect(200);
  assert.equal(first.headers['x-total-count'], '2');
  assert.deepEqual(first.body.map(row => row.id), [f.courses[1].id]);
  assert.equal((await get('?limit=1&offset=1')).body[0].id, f.courses[2].id);
  assert.deepEqual((await get('?limit=1&offset=2')).body, []);
  assert.deepEqual((await get('/categories')).body, ['Cultura', 'Vendas']);
  assert.deepEqual((await get('')).body.map(row => row.learning_group), ['initial', 'role']);
  assert.equal((await get('?group=role')).body.length, 1);
  assert.equal((await get('?category=Captação')).headers['x-total-count'], '0');
  assert.equal((await get('', 'noJob')).body.length, 1);
  f.users.closer.job_title_active = false;
  assert.equal((await get('')).body.length, 1);
  f.users.closer.job_title_active = true;
  f.courses[2].allowed_job_title_ids = [];
  assert.equal((await get('')).body.length, 1);
  for (const path of ['?all=true', '/categories?all=true', '/lessons?all=true', `/${f.courses[0].id}?all=true`, `/lessons/${f.lessons[0].id}?all=true`]) {
    await get(path, 'adminWithoutPermission').expect(403);
    await get(path, 'manager').expect(200);
  }
  await get(`/${f.courses[0].id}`).expect(404);
  await get(`/lessons/${f.lessons[0].id}`).expect(404);
  await get('/lessons').expect(403);
  await get('?group=invalid').expect(400);
  await get('/lessons/not-a-uuid').expect(400);
  assert.equal(f.connections(), 0);
  assert.ok(f.calls.some(call => call.values[0] === true && call.values[1] === f.users.closer.job_title_id));
});

test('curriculum, neighbors and progress use visible current-version lessons and ancestor publication', async t => {
  const f = fixture();
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  const get = (path, user = 'closer') => request.get(`/api/academy${path}`).set('x-fixture-user', user);
  const course = f.courses[2];
  const module = f.modules[2];
  const [first, second] = f.lessons.slice(4);
  f.progress.push({ user_uid: 'closer', lesson_id: first.id, media_version: 1, completed: true, updated_at: '2026-09-30' },
    { user_uid: 'closer', lesson_id: second.id, media_version: 2, completed: true, updated_at: '2026-09-30' });
  let view = (await get(`/${course.id}`).expect(200)).body;
  assert.equal(view.course.total_lessons, 2);
  assert.equal(view.course.progress_percent, 50);
  assert.equal(view.modules[0].lessons[1].completed, false);
  assert.equal((await get(`/lessons/${first.id}`)).body.next_lesson_id, second.id);
  assert.equal((await get(`/lessons/${second.id}`)).body.previous_lesson_id, first.id);
  f.publish('academy_lesson', second.id, null);
  await get(`/lessons/${second.id}`).expect(404);
  assert.equal((await get(`/lessons/${first.id}`)).body.next_lesson_id, null);
  module.active = false;
  await get(`/lessons/${first.id}`).expect(404);
  view = (await get(`/${course.id}`)).body;
  assert.deepEqual(view.modules, []);
  assert.equal(view.course.progress_percent, 0);
  await get(`/lessons/${first.id}?all=true`, 'manager').expect(200);
  module.active = true;
  first.active = false;
  await get(`/lessons/${first.id}`).expect(404);
  first.active = true;
  course.active = false;
  await get(`/lessons/${first.id}`).expect(404);
  course.active = true;
  f.publish('academy', course.id, null);
  await get(`/${course.id}`).expect(404);
  await get(`/lessons/${first.id}`).expect(404);
  assert.equal((await get('')).headers['x-total-count'], '1');
  assert.deepEqual((await get('/categories')).body, ['Cultura']);
});

test('transaction authorization uses only its client and locks CMS → course → module → lesson', async () => {
  const f = fixture();
  const lesson = f.lessons[4];
  const db = { query: f.pool.query }; // No connect method: nested pool readers cannot work.
  assert.ok(await authorizeLessonInTransaction(db, f.users.closer, lesson.id));
  const locks = f.calls.filter(call => /pg_advisory_xact_lock|FOR UPDATE/.test(call.sql));
  assert.match(locks[0].sql, /pg_advisory_xact_lock/);
  assert.match(locks[1].sql, /FROM academy WHERE/);
  assert.match(locks[2].sql, /FROM academy_modules/);
  assert.match(locks[3].sql, /FROM academy_lessons/);
  assert.equal(f.connections(), 0);
  assert.equal(await authorizeLessonInTransaction(db, f.users.capture, lesson.id), null);
  f.modules[2].active = false;
  assert.equal(await authorizeLessonInTransaction(db, f.users.closer, lesson.id), null);
  f.modules[2].active = true;
  f.publish('academy_lesson', lesson.id, [{ type: 'pdf', asset_id: randomUUID(), title: 'Missing PDF' }]);
  assert.equal(await authorizeLessonInTransaction(db, f.users.closer, lesson.id), null);
  assert.ok(f.calls.some(call => /FROM cms_assets/.test(call.sql)));
  f.documents.length = 0;
  f.publish('academy', f.courses[2].id, null);
  assert.equal(await authorizeLessonInTransaction(db, f.users.closer, lesson.id), null);
});

test('valid published blocks replace legacy descriptions; invalid assets remove lessons and counts', async t => {
  const f = fixture();
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  const lesson = f.lessons[4];
  const image = { id: randomUUID(), mime_type: 'image/png', byte_size: 100, storage_key: randomUUID() };
  const pdf = { id: randomUUID(), mime_type: 'application/pdf', byte_size: 100, storage_key: randomUUID() };
  f.assets.push(image, pdf);
  f.publish('academy', f.courses[2].id, [{ type: 'image', asset_id: image.id, alt: 'Cover' }]);
  f.publish('academy_lesson', lesson.id, [{ type: 'pdf', asset_id: pdf.id, title: 'Material' }]);
  const get = path => request.get(`/api/academy${path}`).set('x-fixture-user', 'closer');
  const course = (await get(`/${f.courses[2].id}`).expect(200)).body;
  assert.equal(course.course.cover_asset_id, image.id);
  assert.equal(course.course.description, '');
  const detail = (await get(`/lessons/${lesson.id.toUpperCase()}`).expect(200)).body;
  assert.equal(detail.description, '');
  assert.deepEqual(detail.content_blocks, [{ type: 'pdf', asset_id: pdf.id, title: 'Material' }]);
  pdf.deleting_at = '2026-09-30';
  await get(`/lessons/${lesson.id}`).expect(404);
  assert.equal((await get(`/${f.courses[2].id}`)).body.course.total_lessons, 1);
  const original = f.pool.query;
  f.pool.query = async () => { throw new Error('private database failure'); };
  const failure = await get('').expect(500);
  assert.equal(JSON.stringify(failure.body).includes('private database failure'), false);
  f.pool.query = original;
});

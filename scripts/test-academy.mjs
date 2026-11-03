import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAcademyHttp, createAcademyIntegration, requireDisposableAcademyDatabase,
} from '../tests/helpers/academy-integration.mjs';

export const academyRunnerContracts = Object.freeze([
  'catalog-audience-preview',
  'progress-uid-cas-media-version',
  'management-activation-and-media',
  'concurrent-limits-and-reorder',
  'reorder-create-lock-race',
  'audit-rollback-and-historical-preservation',
]);

export function registerAcademyIntegrationTests() {
  test('progress isolates authenticated UID, serializes CAS races, preserves completion and media versions', async t => {
    const h = await createAcademyIntegration(t);
    const progressPath = `/api/academy/lessons/${h.ids.closerLesson}/progress`;
    const input = { media_version: 1, expected_version: 0, position_seconds: 30 };
    const put = (body, user = 'closer') => h.request.put(progressPath).set('x-fixture-user', user).send(body);
    const continuing = (user = 'closer') => h.request.get('/api/academy/continue?limit=3').set('x-fixture-user', user).expect(200);

    await put({ ...input, user_uid: 'other-person' }).expect(400);
    await put(input, 'capture').expect(404);
    assert.deepEqual((await continuing()).body, []);
    const race = await Promise.all([put(input), put(input)]);
    assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
    assert.equal(race.find(row => row.status === 200).body.version, 1);
    assert.equal(race.find(row => row.status === 409).body.reason, 'progress_conflict');
    assert.deepEqual((await continuing()).body[0].id, h.ids.closerCourse);

    const complete = await put({ ...input, expected_version: 1, completed: true }).expect(200);
    const preserved = await put({ ...input, expected_version: 2, position_seconds: 5 }).expect(200);
    assert.equal(preserved.body.completed_at, complete.body.completed_at);
    await put({ ...input, expected_version: 3, completed: false }).expect(200);
    await h.client.query('UPDATE academy_lessons SET media_version=2 WHERE id=$1', [h.ids.closerLesson]);
    assert.equal((await put({ ...input, expected_version: 4 }).expect(409)).body.reason, 'media_changed');
    await put({ ...input, media_version: 2 }).expect(200);
    await h.client.query('UPDATE academy SET active=FALSE WHERE id=$1', [h.ids.closerCourse]);
    await put({ ...input, media_version: 2, expected_version: 1 }).expect(404);
    assert.deepEqual((await continuing()).body, []);
  });

  test('management validates audience, activation playability and normalized media versions', async t => {
    const h = await createAcademyIntegration(t);
    const send = (method, route, body, user = 'manager') => h.request[method](`/api/academy${route}`)
      .set('x-fixture-user', user).send(body);
    const input = {
      title: 'Integração Ownerinc', category: 'Cultura', description: 'Comece por aqui',
      delivery_mode: 'internal', audience: 'all', allowed_job_title_ids: [], learning_group: 'initial',
      icon_key: 'icon-01', instructor_name: 'Equipe Ownerinc', url: null, order: 1, active: false,
    };
    const created = (await send('post', '', input).expect(201)).body;
    h.trackCourse(created.id);
    assert.equal(created.url, null);
    await send('put', `/${created.id}`, { ...input, audience: 'job_titles', allowed_job_title_ids: [] }).expect(400);
    for (const ids of [[randomUUID()], Array.from({ length: 101 }, () => randomUUID())]) {
      await send('put', `/${created.id}`, { audience: 'job_titles', allowed_job_title_ids: ids }).expect(400);
    }
    await send('post', '', input, 'adminWithoutPermission').expect(403);

    const module = (await send('post', `/${created.id}/modules`, { title: 'Módulo', active: true }).expect(201)).body;
    const lesson = (await send('post', `/modules/${module.id}/lessons`, {
      title: 'Aula', media: { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' },
    }).expect(201)).body;
    await send('put', `/${created.id}`, { active: true }).expect(400);
    await send('put', `/lessons/${lesson.id}`, { active: true }).expect(200);
    assert.equal((await send('put', `/${created.id}`, { active: true }).expect(200)).body.active, true);
    for (const [value, version] of [
      [{ title: 'Renamed' }, 1],
      [{ media: { type: 'youtube', url: 'https://youtube.com/embed/dQw4w9WgXcQ' } }, 1],
      [{ media: { type: 'file', url: 'https://example.test/lesson.mp4' } }, 2],
    ]) assert.equal((await send('put', `/lessons/${lesson.id}`, value).expect(200)).body.media_version, version);

    const external = (await send('post', '', { title: 'External', url: 'https://example.test/course', active: true }).expect(201)).body;
    h.trackCourse(external.id);
    const converted = (await send('put', `/${external.id}`, { delivery_mode: 'internal', url: external.url, active: false }).expect(200)).body;
    assert.equal(converted.id, external.id);
    assert.equal(converted.url, null);
  });

  test('concurrent hierarchy limits and complete parent-bound reorder preserve children', async t => {
    const h = await createAcademyIntegration(t);
    const send = (method, route, body) => h.request[method](`/api/academy${route}`).set('x-fixture-user', 'manager').send(body);
    await h.client.query(`INSERT INTO academy_modules(course_id,title) SELECT $1,'Inactive' FROM generate_series(1,98)`, [h.ids.closerCourse]);
    const attempts = await Promise.all([1, 2].map(() => send('post', `/${h.ids.closerCourse}/modules`, { title: 'Limit race' })));
    assert.deepEqual(attempts.map(row => row.status).sort(), [201, 400]);
    assert.equal(attempts.find(row => row.status === 400).body.reason, 'module_limit');
    const secondModule = attempts.find(row => row.status === 201).body.id;
    await h.client.query(`INSERT INTO academy_lessons(module_id,title,media_type,youtube_video_id)
      SELECT $1,'Inactive','youtube','dQw4w9WgXcQ' FROM generate_series(1,498)`, [h.ids.module]);
    const lessons = await Promise.all([h.ids.module, secondModule].map(id => send('post', `/modules/${id}/lessons`, {
      title: 'Limit race', media: { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' },
    })));
    assert.deepEqual(lessons.map(row => row.status).sort(), [201, 400]);
    assert.equal(lessons.find(row => row.status === 400).body.reason, 'lesson_limit');

    for (const [table, parent, parentId, route, foreign] of [
      ['academy_modules', 'course_id', h.ids.closerCourse, `/${h.ids.closerCourse}/modules/order`, h.ids.captureModule],
      ['academy_lessons', 'module_id', h.ids.module, `/modules/${h.ids.module}/lessons/order`, h.ids.captureLesson],
    ]) {
      const before = (await h.client.query(`SELECT id,"order" FROM ${table} WHERE ${parent}=$1 ORDER BY id`, [parentId])).rows;
      const ids = before.map(row => row.id);
      for (const invalidIds of [ids.slice(1), [...ids.slice(1), foreign], [...ids.slice(1), ids[1].toUpperCase()]]) {
        const invalid = await send('put', route, { ids: invalidIds }).expect(400);
        assert.equal(invalid.body.reason, 'invalid_order');
        assert.deepEqual((await h.client.query(`SELECT id,"order" FROM ${table} WHERE ${parent}=$1 ORDER BY id`, [parentId])).rows, before);
      }
      await send('put', route, { ids: ids.reverse() }).expect(200);
      assert.deepEqual((await h.client.query(`SELECT id FROM ${table} WHERE ${parent}=$1 ORDER BY "order"`, [parentId])).rows.map(row => row.id), ids);
    }
  });

  test('create and reorder serialize stale snapshots through the course lock', async t => {
    const h = await createAcademyIntegration(t);
    const route = `/${h.ids.closerCourse}/modules/order`;
    const initial = (await h.client.query('SELECT id FROM academy_modules WHERE course_id=$1 ORDER BY "order", id', [h.ids.closerCourse])).rows.map(row => row.id);
    const [created, reordered] = await Promise.all([
      h.request.post(`/api/academy/${h.ids.closerCourse}/modules`).set('x-fixture-user', 'manager').send({ title: 'Concurrent module' }),
      h.request.put(`/api/academy${route}`).set('x-fixture-user', 'manager').send({ ids: initial }),
    ]);
    assert.equal(created.status, 201);
    assert.ok([200, 400].includes(reordered.status));
    if (reordered.status === 400) assert.equal(reordered.body.reason, 'invalid_order');
    const current = (await h.client.query('SELECT id FROM academy_modules WHERE course_id=$1 ORDER BY "order", id', [h.ids.closerCourse])).rows.map(row => row.id);
    assert.deepEqual(new Set(current), new Set([...initial, created.body.id]));
    assert.equal((await h.client.query('SELECT module_id FROM academy_lessons WHERE id=$1', [h.ids.closerLesson])).rows[0].module_id, h.ids.module);
  });

  test('audit rollback preserves Academy and historical rows', async t => {
    const h = await createAcademyIntegration(t);
    const beforeTree = (await h.client.query('SELECT * FROM academy WHERE id=$1', [h.ids.closerCourse])).rows;
    const beforeHistory = await h.historicalSnapshot();
    const failingPool = { async connect() {
      const db = await h.pool.connect();
      return {
        release: () => db.release(),
        query(sql, values) {
          if (/INSERT INTO audit_log/.test(sql)) throw new Error('controlled audit failure');
          return db.query(sql, values);
        },
      };
    } };
    const { request } = await createAcademyHttp(t, failingPool, h.users);
    await request.put(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'manager')
      .send({ title: 'Rollback' }).expect(500);
    await request.delete(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'manager').expect(500);
    assert.deepEqual((await h.client.query('SELECT * FROM academy WHERE id=$1', [h.ids.closerCourse])).rows, beforeTree);
    assert.deepEqual(await h.historicalSnapshot(), beforeHistory);
    await h.request.delete(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'manager').expect(200);
    assert.equal((await h.client.query('SELECT id FROM academy WHERE id=$1', [h.ids.closerCourse])).rowCount, 0);
    assert.deepEqual(await h.historicalSnapshot(), beforeHistory);
  });

  test('catalog, audience and explicit manager preview use only Academy data', async t => {
    const h = await createAcademyIntegration(t);
    const get = (route, user = 'closer', status = 200) => h.request.get(`/api/academy${route}`).set('x-fixture-user', user).expect(status);
    assert.equal((await get('?limit=1&offset=0')).headers['x-total-count'], '2');
    assert.deepEqual((await get('?limit=1&offset=0')).body.map(row => row.id), [h.ids.allCourse]);
    assert.equal((await get('', 'noJob')).body.length, 1);
    await get(`/${h.ids.captureCourse}`, 'closer', 404);
    await get('?all=true', 'adminWithoutPermission', 403);
    assert.equal((await get('/lessons?all=true', 'manager')).body.length, 2);
    assert.equal((await get(`/lessons/${h.ids.closerLesson}`)).body.progress.version, 0);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  requireDisposableAcademyDatabase();
  registerAcademyIntegrationTests();
}

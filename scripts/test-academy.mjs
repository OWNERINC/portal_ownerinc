import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { enforceCmsAssetRetention } from '../cron/cms-asset-retention.js';
import { createAcademyHttp, createAcademyIntegration, requireDisposableAcademyDatabase } from '../tests/helpers/academy-integration.mjs';

requireDisposableAcademyDatabase();

test('progress isolates authenticated UID, serializes CAS races, preserves manual completion and filters continue', async t => {
  const h = await createAcademyIntegration(t);
  const path = `/api/academy/lessons/${h.ids.closerLesson}/progress`;
  const input = { media_version: 1, expected_version: 0, position_seconds: 30 };
  const put = (body, user = 'closer') => h.request.put(path).set('x-fixture-user', user).send(body);
  const continuing = (user = 'closer') => h.request.get('/api/academy/continue?limit=3').set('x-fixture-user', user).expect(200);
  await put({ ...input, user_uid: 'other-person' }).expect(400);
  await put(input, 'capture').expect(404);
  assert.deepEqual((await continuing()).body, []);
  const race = await Promise.all([put(input), put(input)]);
  assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
  assert.equal(race.find(row => row.status === 200).body.version, 1);
  assert.equal(race.find(row => row.status === 409).body.reason, 'progress_conflict');
  assert.equal((await continuing()).body[0].id, h.ids.closerCourse);
  assert.deepEqual((await continuing('capture')).body, []);
  const complete = await put({ ...input, expected_version: 1, completed: true }).expect(200);
  assert.equal(complete.body.completed, true);
  const preserved = await put({ ...input, expected_version: 2, position_seconds: 5 }).expect(200);
  assert.equal(preserved.body.completed_at, complete.body.completed_at);
  assert.deepEqual((await continuing()).body, []);
  await put({ ...input, expected_version: 3, completed: false }).expect(200);
  assert.equal((await continuing()).body.length, 1);
  await h.client.query('UPDATE academy_lessons SET media_version=2 WHERE id=$1', [h.ids.closerLesson]);
  assert.equal((await put({ ...input, expected_version: 4 }).expect(409)).body.reason, 'media_changed');
  assert.deepEqual((await continuing()).body, []);
  await put({ ...input, media_version: 2 }).expect(200);
  await h.client.query('UPDATE academy SET active=FALSE WHERE id=$1', [h.ids.closerCourse]);
  await put({ ...input, media_version: 2, expected_version: 1 }).expect(404);
  assert.deepEqual((await continuing()).body, []);
});

test('transactional management validates audience, conversion, child publication and normalized media versions', async t => {
  const h = await createAcademyIntegration(t);
  const send = (method, path, body, user = 'manager') => h.request[method](`/api/academy${path}`)
    .set('x-fixture-user', user).send(body);
  const input = { title: 'Integração Ownerinc', category: 'Cultura', description: 'Comece por aqui',
    delivery_mode: 'internal', audience: 'all', allowed_job_title_ids: [], learning_group: 'initial',
    icon_key: 'icon-01', instructor_name: 'Equipe Ownerinc', url: null, order: 1, active: false };
  const created = (await send('post', '', input).expect(201)).body;
  h.trackCourse(created.id);
  assert.equal(created.url, null);
  await send('put', `/${created.id}`, { ...input, audience: 'job_titles', allowed_job_title_ids: [] }).expect(400);
  assert.equal((await h.client.query('SELECT audience FROM academy WHERE id=$1', [created.id])).rows[0].audience, 'all');
  for (const extra of [{ id: created.id }, { created_at: '2026-09-30' }, { unexpected: true }]) {
    await send('put', `/${created.id}`, { ...input, ...extra }).expect(400);
  }
  for (const allowed_job_title_ids of [[randomUUID()], Array.from({ length: 101 }, () => randomUUID())]) {
    await send('put', `/${created.id}`, { audience: 'job_titles', allowed_job_title_ids }).expect(400);
  }
  await h.client.query('UPDATE job_titles SET active=FALSE WHERE id=$1', [h.ids.closerJob]);
  await send('put', `/${created.id}`, { audience: 'job_titles', allowed_job_title_ids: [h.ids.closerJob] }).expect(400);
  await h.client.query('UPDATE job_titles SET active=TRUE WHERE id=$1', [h.ids.closerJob]);
  await send('put', `/${created.id}`, { audience: 'job_titles', allowed_job_title_ids: [h.ids.closerJob] }).expect(200);
  await h.client.query('UPDATE job_titles SET active=FALSE WHERE id=$1', [h.ids.closerJob]);
  assert.deepEqual((await send('put', `/${created.id}`, { title: 'Selection retained' }).expect(200)).body.allowed_job_title_ids, [h.ids.closerJob]);
  await send('post', '', input, 'adminWithoutPermission').expect(403);
  await send('post', `/${created.id}/modules`, { title: 'Blocked' }, 'adminWithoutPermission').expect(403);
  await send('put', `/${created.id}`, { active: true }).expect(400);
  const module = (await send('post', `/${created.id}/modules`, { title: 'Módulo', active: true }).expect(201)).body;
  const media = { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' };
  const lesson = (await send('post', `/modules/${module.id}/lessons`, { title: 'Aula', media }).expect(201)).body;
  await send('put', `/${created.id}`, { active: true }).expect(400);
  await send('put', `/lessons/${lesson.id}`, { active: true }).expect(200);
  const doc = (await h.client.query("INSERT INTO cms_documents(content_type,source_id,title) VALUES ('academy_lesson',$1,'Draft') RETURNING id", [lesson.id])).rows[0];
  await send('put', `/${created.id}`, { active: true }).expect(400);
  const revision = (await h.client.query("INSERT INTO cms_revisions(document_id,version,status,blocks) VALUES ($1,1,'published',$2::jsonb) RETURNING id",
    [doc.id, JSON.stringify([{ type: 'pdf', asset_id: randomUUID(), title: 'Missing' }])])).rows[0];
  await h.client.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [doc.id, revision.id]);
  await send('put', `/${created.id}`, { active: true }).expect(400);
  await h.client.query("UPDATE cms_revisions SET blocks='[]'::jsonb WHERE id=$1", [revision.id]);
  await send('put', `/${created.id}`, { active: true }).expect(200);
  for (const [value, version] of [
    [{ title: 'Renamed' }, 1], [{ media: { type: 'youtube', url: 'https://youtube.com/embed/dQw4w9WgXcQ' } }, 1],
    [{ media: { type: 'file', url: 'https://example.test/lesson.mp4' } }, 2],
  ]) assert.equal((await send('put', `/lessons/${lesson.id}`, value).expect(200)).body.media_version, version);
  const external = (await send('post', '', { title: 'External', url: 'https://example.test/course', active: true }).expect(201)).body;
  h.trackCourse(external.id);
  const presentation = (await h.client.query("INSERT INTO cms_documents(content_type,source_id,title) VALUES ('academy',$1,'Presentation') RETURNING id", [external.id])).rows[0];
  await send('put', `/${external.id}`, { delivery_mode: 'internal' }).expect(400);
  const converted = (await send('put', `/${external.id}`, { delivery_mode: 'internal', url: external.url, active: false }).expect(200)).body;
  assert.equal(converted.id, external.id); assert.equal(converted.url, null);
  assert.equal((await h.client.query('SELECT source_id FROM cms_documents WHERE id=$1', [presentation.id])).rows[0].source_id, external.id);
});

test('real concurrent hierarchy limits and complete parent-bound reorder include inactive descendants', async t => {
  const h = await createAcademyIntegration(t);
  const send = (method, path, body) => h.request[method](`/api/academy${path}`).set('x-fixture-user', 'manager').send(body);
  await h.client.query(`INSERT INTO academy_modules(course_id,title) SELECT $1,'Inactive' FROM generate_series(1,98)`, [h.ids.closerCourse]);
  const attempts = await Promise.all([1, 2].map(() => send('post', `/${h.ids.closerCourse}/modules`, { title: 'Limit race' })));
  assert.deepEqual(attempts.map(row => row.status).sort(), [201, 400]);
  assert.equal(attempts.find(row => row.status === 400).body.reason, 'module_limit');
  assert.equal((await h.client.query('SELECT COUNT(*)::integer AS count FROM academy_modules WHERE course_id=$1', [h.ids.closerCourse])).rows[0].count, 100);
  const secondModule = attempts.find(row => row.status === 201).body.id;
  await h.client.query(`INSERT INTO academy_lessons(module_id,title,media_type,youtube_video_id)
    SELECT $1,'Inactive','youtube','dQw4w9WgXcQ' FROM generate_series(1,498)`, [h.ids.module]);
  const lessons = await Promise.all([h.ids.module, secondModule].map(id => send('post', `/modules/${id}/lessons`,
    { title: 'Limit race', media: { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' } })));
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

test('real audit rollback preserves the tree and successful deletion removes CMS revisions/progress but retains shared files', async t => {
  const h = await createAcademyIntegration(t);
  const documentIds = [];
  for (const [type, source] of [['academy', h.ids.closerCourse], ['academy_lesson', h.ids.closerLesson], ['academy', h.ids.allCourse]]) {
    const document = (await h.request.post('/api/cms/documents').set('x-fixture-user', 'manager')
      .send({ type, source_id: source, title: 'Shared file' }).expect(201)).body.document.id;
    documentIds.push(document);
    await h.request.put(`/api/cms/documents/${document}/draft`).set('x-fixture-user', 'manager')
      .send({ blocks: [{ type: 'pdf', asset_id: h.ids.pdfAsset, title: 'Shared' }] }).expect(200);
    await h.request.post(`/api/cms/documents/${document}/publish`).set('x-fixture-user', 'manager').send({}).expect(200);
  }
  await h.client.query('INSERT INTO academy_lesson_progress(user_uid,lesson_id,media_version) VALUES ($1,$2,1)', [h.users.closer.uid, h.ids.closerLesson]);
  let failedAudits = 0;
  const failingPool = { async connect() {
    const db = await h.pool.connect();
    return { release: () => db.release(), query(sql, values) {
      if (/INSERT INTO audit_log/.test(sql)) { failedAudits++; throw new Error('controlled audit failure'); }
      return db.query(sql, values);
    } };
  } };
  const { request } = await createAcademyHttp(t, failingPool, h.users);
  const before = (await h.client.query('SELECT * FROM academy WHERE id=$1', [h.ids.closerCourse])).rows;
  await request.put(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'manager')
    .send({ title: 'Rollback', allowed_job_title_ids: [h.ids.captureJob] }).expect(500);
  assert.deepEqual((await h.client.query('SELECT * FROM academy WHERE id=$1', [h.ids.closerCourse])).rows, before);
  assert.deepEqual((await h.client.query('SELECT job_title_id FROM academy_course_job_titles WHERE course_id=$1', [h.ids.closerCourse])).rows,
    [{ job_title_id: h.ids.closerJob }]);
  await request.delete(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'manager').expect(500);
  assert.equal(failedAudits, 2);
  assert.equal((await h.client.query('SELECT id FROM cms_documents WHERE id=ANY($1::uuid[])', [documentIds])).rowCount, 3);
  assert.equal((await h.client.query('SELECT lesson_id FROM academy_lesson_progress WHERE lesson_id=$1', [h.ids.closerLesson])).rowCount, 1);
  await h.request.delete(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'manager').expect(200);
  assert.equal((await h.client.query('SELECT id FROM cms_documents WHERE id=ANY($1::uuid[])', [documentIds.slice(0, 2)])).rowCount, 0);
  assert.equal((await h.client.query('SELECT id FROM cms_revisions WHERE document_id=ANY($1::uuid[])', [documentIds.slice(0, 2)])).rowCount, 0);
  assert.equal((await h.client.query('SELECT lesson_id FROM academy_lesson_progress WHERE lesson_id=$1', [h.ids.closerLesson])).rowCount, 0);
  const asset = (await h.client.query('SELECT storage_key FROM cms_assets WHERE id=$1', [h.ids.pdfAsset])).rows[0];
  assert.deepEqual(await readFile(path.join(h.uploadDirectory, 'cms-private', asset.storage_key)), h.pdf);
  await h.request.get(`/api/cms/assets/${h.ids.pdfAsset}`).set('x-fixture-user', 'capture').expect(200);
});

test('lesson PDF uses real CMS publication, inherits course access, and survives draft retention', async t => {
  const h = await createAcademyIntegration(t);
  const manager = req => req.set('x-fixture-user', 'manager');
  const assetUrl = `/api/cms/assets/${h.ids.pdfAsset}`;
  const get = (user = 'closer', status = 200) => h.request.get(assetUrl).set('x-fixture-user', user).expect(status);
  const create = async (type, source) => (await manager(h.request.post('/api/cms/documents'))
    .send({ type, source_id: source, title: 'Material Academy' }).expect(201)).body.document.id;
  const draft = (id, blocks) => manager(h.request.put(`/api/cms/documents/${id}/draft`)).send({ blocks }).expect(200);
  const publish = id => manager(h.request.post(`/api/cms/documents/${id}/publish`)).send({}).expect(200);
  const unpublish = id => manager(h.request.post(`/api/cms/documents/${id}/unpublish`)).send({}).expect(200);
  const blocks = [{ type: 'pdf', asset_id: h.ids.pdfAsset, title: 'Material' }];
  const lesson = await create('academy_lesson', h.ids.closerLesson);
  await draft(lesson, blocks);
  await get('closer', 403);
  await get('manager');
  await h.client.query("UPDATE cms_assets SET created_at=NOW()-INTERVAL '40 days' WHERE id=$1", [h.ids.pdfAsset]);
  await enforceCmsAssetRetention(h.pool, { UPLOAD_DIR: h.uploadDirectory, CMS_ASSET_ORPHAN_RETENTION_DAYS: '30' });
  await get('manager');
  await publish(lesson);
  await get('capture', 403);
  const delivered = await get();
  assert.equal(delivered.headers['content-type'], 'application/pdf');
  assert.deepEqual(delivered.body, h.pdf);
  await h.client.query('UPDATE academy_modules SET active=FALSE WHERE id=$1', [h.ids.module]);
  await get('closer', 403);
  await h.client.query('UPDATE academy_modules SET active=TRUE WHERE id=$1', [h.ids.module]);
  const course = await create('academy', h.ids.closerCourse);
  await get('closer', 403);
  await draft(course, blocks); await publish(course);
  await get('capture', 403); await get();
  await unpublish(course); await get('closer', 403);
  await draft(course, []); await publish(course); await get();
  // Corrupt a sibling block to prove full referencing revision validation.
  await h.client.query(`UPDATE cms_revisions SET blocks=$2::jsonb WHERE id=(
    SELECT published_revision_id FROM cms_documents WHERE id=$1)`, [lesson, JSON.stringify([...blocks, { type: 'invalid' }])]);
  await get('closer', 403);
  await h.client.query(`UPDATE cms_revisions SET blocks=$2::jsonb WHERE id=(
    SELECT published_revision_id FROM cms_documents WHERE id=$1)`, [lesson, JSON.stringify(blocks)]);
  await unpublish(lesson); await get('closer', 403);
  await draft(lesson, blocks); await publish(lesson);
  const publicCourse = await create('academy', h.ids.allCourse);
  await draft(publicCourse, blocks); await publish(publicCourse);
  await get('capture'); // one authorized reference is enough
  await unpublish(publicCourse);
  const { deleteCmsSource } = createRequire(import.meta.url)('../api/cms/sources');
  await h.client.query('BEGIN');
  try {
    await deleteCmsSource(h.client, 'academy_lesson', h.ids.closerLesson);
    await h.client.query('COMMIT');
  } catch (error) { await h.client.query('ROLLBACK'); throw error; }
  assert.equal((await h.client.query('SELECT id FROM cms_documents WHERE id=$1', [lesson])).rowCount, 0);
  assert.equal((await h.client.query('SELECT id FROM cms_revisions WHERE document_id=$1', [lesson])).rowCount, 0);
  await get('closer', 403);
  const asset = (await h.client.query('SELECT storage_key FROM cms_assets WHERE id=$1', [h.ids.pdfAsset])).rows[0];
  assert.deepEqual(await readFile(path.join(h.uploadDirectory, 'cms-private', asset.storage_key)), h.pdf);
  // Archived/shared revisions still retain files; remove all fixture references
  // before exercising the existing orphan cleanup.
  await h.client.query('DELETE FROM cms_documents WHERE id=ANY($1::uuid[])', [[course, publicCourse]]);
  await enforceCmsAssetRetention(h.pool, { UPLOAD_DIR: h.uploadDirectory, CMS_ASSET_ORPHAN_RETENTION_DAYS: '30' });
  await get('closer', 404);
});

test('catalog, counts, curriculum, detail and explicit preview respect audience', async t => {
  const h = await createAcademyIntegration(t);
  const get = (path, user = 'closer', status = 200) => h.request.get(`/api/academy${path}`).set('x-fixture-user', user).expect(status);
  const first = await get('?limit=1&offset=0');
  assert.equal(first.headers['x-total-count'], '2');
  assert.deepEqual(first.body.map(row => row.id), [h.ids.allCourse]);
  const last = await get('?limit=1&offset=1');
  assert.equal(last.body[0].id, h.ids.closerCourse);
  assert.deepEqual((await get('?limit=1&offset=2')).body, []);
  assert.deepEqual((await get('/categories')).body, ['Cultura', 'Vendas']);
  assert.deepEqual((await get('')).body.map(row => row.learning_group), ['initial', 'role']);
  assert.equal((await get('', 'noJob')).body.length, 1);
  await get(`/${h.ids.captureCourse}`, 'closer', 404);
  await get(`/lessons/${h.ids.captureLesson}`, 'closer', 404);
  await get('?all=true', 'adminWithoutPermission', 403);
  await get('/categories?all=true', 'adminWithoutPermission', 403);
  await get('/lessons?all=true', 'adminWithoutPermission', 403);
  assert.equal((await get('/lessons?all=true', 'manager')).body.length, 2);
  assert.equal((await get(`/${h.ids.closerCourse}`)).body.modules[0].lessons[0].id, h.ids.closerLesson);
  assert.equal((await get(`/lessons/${h.ids.closerLesson}`)).body.progress.version, 0);
  const document = (await h.client.query("INSERT INTO cms_documents(content_type,source_id,title) VALUES ('academy_lesson',$1,'Lesson') RETURNING id", [h.ids.closerLesson])).rows[0];
  const blocks = [{ type: 'pdf', asset_id: h.ids.pdfAsset, title: 'Material' }];
  const revision = (await h.client.query("INSERT INTO cms_revisions(document_id,version,status,blocks) VALUES ($1,1,'published',$2::jsonb) RETURNING id", [document.id, JSON.stringify(blocks)])).rows[0];
  await h.client.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [document.id, revision.id]);
  assert.deepEqual((await get(`/lessons/${h.ids.closerLesson}`)).body.content_blocks, blocks);
  await h.client.query('UPDATE academy_modules SET active=FALSE WHERE id=$1', [h.ids.module]);
  await get(`/lessons/${h.ids.closerLesson}`, 'closer', 404);
  assert.equal((await get(`/${h.ids.closerCourse}`)).body.course.progress_percent, 0);
  await get(`/lessons/${h.ids.closerLesson}?all=true`, 'manager');
  await h.client.query('UPDATE academy_modules SET active=TRUE WHERE id=$1', [h.ids.module]);
  await h.client.query('UPDATE cms_documents SET published_revision_id=NULL WHERE id=$1', [document.id]);
  await get(`/lessons/${h.ids.closerLesson}`, 'closer', 404);
  await h.client.query("INSERT INTO cms_documents(content_type,source_id,title) VALUES ('academy',$1,'Unpublished')", [h.ids.closerCourse]);
  assert.equal((await get('')).headers['x-total-count'], '1');
  assert.deepEqual((await get('/categories')).body, ['Cultura']);
  await get(`/${h.ids.closerCourse}`, 'closer', 404);
  await get(`/${h.ids.closerCourse}?all=true`, 'manager');
});

test('deleted unpublished lesson cannot become legacy content across the CMS lock boundary', async t => {
  const h = await createAcademyIntegration(t);
  await h.client.query("INSERT INTO cms_documents(content_type,source_id,title) VALUES ('academy_lesson',$1,'Draft')", [h.ids.closerLesson]);
  let locks = 0;
  let deleted = false;
  // Gate the real client's lock acquisition, not business logic or SQL results.
  // The first two locks are the shared course reader; the third is curriculum.
  const gatedPool = {
    query: h.pool.query.bind(h.pool),
    async connect() {
      const db = await h.pool.connect();
      return {
        async query(sql, values) {
          if (/pg_advisory_xact_lock/.test(sql) && ++locks === 3) {
            await h.client.query('BEGIN');
            try {
              await h.client.query('SELECT pg_advisory_xact_lock(7193029)');
              await h.client.query('SELECT id FROM academy WHERE id=$1 FOR UPDATE', [h.ids.closerCourse]);
              await h.client.query('SELECT id FROM academy_modules WHERE id=$1 FOR UPDATE', [h.ids.module]);
              await h.client.query('SELECT id FROM academy_lessons WHERE id=$1 FOR UPDATE', [h.ids.closerLesson]);
              await h.client.query("DELETE FROM cms_documents WHERE content_type='academy_lesson' AND source_id=$1", [h.ids.closerLesson]);
              await h.client.query('DELETE FROM academy_lessons WHERE id=$1', [h.ids.closerLesson]);
              await h.client.query('COMMIT');
              deleted = true;
            } catch (error) {
              await h.client.query('ROLLBACK');
              throw error;
            }
          }
          return db.query(sql, values);
        },
        release: () => db.release(),
      };
    },
  };
  const { request } = await createAcademyHttp(t, gatedPool, h.users);
  await request.get(`/api/academy/lessons/${h.ids.closerLesson}`).set('x-fixture-user', 'closer').expect(404);
  assert.equal(deleted, true, 'fixture mutation must run at the curriculum lock boundary');
  const course = await request.get(`/api/academy/${h.ids.closerCourse}`).set('x-fixture-user', 'closer').expect(200);
  assert.equal(course.body.course.total_lessons, 0);
  assert.deepEqual(course.body.modules[0].lessons, []);
});

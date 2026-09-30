import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { enforceCmsAssetRetention } from '../cron/cms-asset-retention.js';
import { createAcademyHttp, createAcademyIntegration, requireDisposableAcademyDatabase } from '../tests/helpers/academy-integration.mjs';

requireDisposableAcademyDatabase();

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

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mutationFixture } from '../helpers/academy-mutations-fixture.mjs';
import { createAcademyHttp } from '../helpers/academy-integration.mjs';

const require = (await import('node:module')).createRequire(import.meta.url);
const mutations = require('../../api/academy/mutations');
const { withAudit } = require('../../api/route-utils');
const input = { title: 'Integração', delivery_mode: 'internal', audience: 'all', allowed_job_title_ids: [] };
const media = { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' };
const writes = f => f.calls.filter(call => /^(INSERT|UPDATE|DELETE)/.test(call.sql));
const run = (f, fn, ...args) => withAudit(f.pool, { user: f.users.manager, id: 'test' }, 'test', 'academy', db => fn(db, ...args));
const bad = reason => error => error.status === 400 && error.reason === reason;

test('real HTTP creates inactive course, rejects empty audience separately from extra fields and denies managers without permission', async t => {
  const f = mutationFixture();
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  const post = (value, user = 'manager') => request.post('/api/academy').set('x-fixture-user', user).send(value);
  const created = await post(input).expect(201);
  assert.equal(created.body.url, null);
  assert.equal(created.body.active, false);
  const id = created.body.id;
  const put = value => request.put(`/api/academy/${id}`).set('x-fixture-user', 'manager').send(value);
  for (const value of [
    { ...input, audience: 'job_titles', allowed_job_title_ids: [] },
    { ...input, id }, { ...input, created_at: 'today' }, { ...input, extra: true },
    { ...input, job_title_ids: [] },
  ]) {
    f.calls.length = 0;
    await put(value).expect(400);
    assert.equal(writes(f).length, 0);
    assert.equal(f.state.courses[0].audience, 'all');
  }
  await post({ title: 'Legacy', url: 'https://example.test/course' }).expect(201);
  assert.equal(f.state.courses[1].delivery_mode, 'external');
  f.calls.length = 0;
  await post(input, 'denied').expect(403);
  for (const [method, path] of [
    ['put', `/${id}`], ['delete', `/${id}`], ['post', `/${id}/modules`],
    ['put', '/modules/' + id], ['delete', '/modules/' + id], ['post', `/modules/${id}/lessons`],
    ['put', '/lessons/' + id], ['delete', '/lessons/' + id], ['put', `/${id}/modules/order`], ['put', `/modules/${id}/lessons/order`],
  ]) await request[method](`/api/academy${path}`).set('x-fixture-user', 'denied').send({}).expect(403);
  assert.equal(f.calls.length, 0);
});

test('audience validates exact active assignments and max count before writes; preserves existing inactive selection', async () => {
  const f = mutationFixture();
  const course = f.course();
  const active = { id: randomUUID(), active: true }, inactive = { id: randomUUID(), active: false };
  f.state.jobs.push(active, inactive);
  for (const ids of [[randomUUID()], [active.id, inactive.id], Array.from({ length: 101 }, randomUUID), [active.id, active.id.toUpperCase()]]) {
    f.calls.length = 0;
    await assert.rejects(run(f, mutations.saveCourse, f.users.manager, course.id, { audience: 'job_titles', allowed_job_title_ids: ids }), { status: 400 });
    assert.equal(writes(f).length, 0);
  }
  await run(f, mutations.saveCourse, f.users.manager, course.id, { audience: 'job_titles', allowed_job_title_ids: [active.id] });
  f.state.jobs[0].active = false;
  const saved = await run(f, mutations.saveCourse, f.users.manager, course.id, { title: 'Updated' });
  assert.deepEqual(saved.allowed_job_title_ids, [active.id]);
});

test('activation validates the own active curriculum and never consults editorial rows', async () => {
  const f = mutationFixture();
  const course = f.course();
  const module = f.module(course.id, { active: true });
  const lesson = f.lesson(module.id, { active: true });
  const moduleId = module.id;
  const lessonId = lesson.id;
  for (const change of [
    () => { f.state.lessons.find(row => row.id === lessonId).active = false; },
    () => { const row = f.state.lessons.find(item => item.id === lessonId); row.active = true; row.youtube_video_id = 'invalid'; },
    () => { f.state.lessons.find(row => row.id === lessonId).youtube_video_id = 'dQw4w9WgXcQ'; f.state.modules.find(row => row.id === moduleId).active = false; },
  ]) {
    const before = structuredClone(f.state);
    change();
    await assert.rejects(run(f, mutations.saveCourse, f.users.manager, course.id, { active: true }), bad('course_not_playable'));
    assert.equal(f.state.courses[0].active, before.courses[0].active);
    f.state.lessons.find(row => row.id === lessonId).active = true;
    f.state.lessons.find(row => row.id === lessonId).youtube_video_id = 'dQw4w9WgXcQ';
    f.state.modules.find(row => row.id === moduleId).active = true;
  }
  assert.equal((await run(f, mutations.saveCourse, f.users.manager, course.id, { active: true })).active, true);
  assert.equal(f.calls.some(call => /cms_documents|cms_revisions|cms_assets|7193029|pg_advisory/.test(call.sql)), false);
});

test('audit rollback preserves Academy and historical document/revision/asset bytes', async () => {
  const f = mutationFixture();
  const course = f.course();
  const module = f.module(course.id);
  const lesson = f.lesson(module.id);
  const before = structuredClone(f.state);
  f.failAudit();
  await assert.rejects(run(f, mutations.saveCourse, f.users.manager, course.id, { title: 'Rollback' }), /audit unavailable/);
  assert.deepEqual(f.state, before);
  await assert.rejects(run(f, mutations.deleteCourseTree, course.id), /audit unavailable/);
  assert.deepEqual(f.state, before);
  assert.equal(f.state.documents[0].bytes, 'document-bytes');
  assert.equal(f.state.revisions[0].bytes, 'revision-bytes');
  assert.equal(f.state.assets[0].bytes, 'asset-bytes');
  assert.equal(lesson.module_id, module.id);
  assert.equal(f.calls.some(call => /cms_documents|cms_revisions|cms_assets|7193029|pg_advisory/.test(call.sql)), false);
});

test('curriculum HTTP edits whitelist metadata and increments version only for normalized origin changes', async t => {
  const f = mutationFixture();
  const course = f.course();
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  const send = (method, path, body) => request[method](`/api/academy${path}`).set('x-fixture-user', 'manager').send(body);
  const module = (await send('post', `/${course.id}/modules`, { title: 'Módulo' }).expect(201)).body;
  assert.equal(module.active, false);
  await send('put', `/modules/${module.id}`, { active: true }).expect(200);
  const lesson = (await send('post', `/modules/${module.id}/lessons`, { title: 'Aula', media }).expect(201)).body;
  assert.equal(lesson.active, false);
  await send('put', `/${course.id}/modules/order`, { ids: [module.id] }).expect(200);
  await send('put', `/modules/${module.id}/lessons/order`, { ids: [lesson.id] }).expect(200);
  assert.equal((await send('put', `/modules/${module.id}/lessons/order`, { ids: [] }).expect(400)).body.reason, 'invalid_order');
  await send('put', `/${course.id}/modules/order`, { ids: [module.id], course_id: course.id }).expect(400);
  for (const [body, version] of [
    [{ title: 'Outro título', order: 3 }, 1],
    [{ media: { type: 'youtube', url: 'https://www.youtube.com/embed/dQw4w9WgXcQ?start=1' } }, 1],
    [{ media: { type: 'youtube', url: 'https://youtu.be/abcdefghijk' } }, 2],
    [{ media: { type: 'file', url: 'https://example.test/video.mp4' } }, 3],
    [{ media: { type: 'file', url: 'https://EXAMPLE.test:443/video.mp4' } }, 3],
    [{ media: { type: 'file', url: 'https://example.test/video.mp4?v=2' } }, 4],
  ]) assert.equal((await send('put', `/lessons/${lesson.id}`, body).expect(200)).body.media_version, version);
  for (const body of [{ media_version: 20 }, { module_id: randomUUID() }, { id: lesson.id }, { media: { type: 'file', url: 'http://bad/video.mp4' } }]) {
    f.calls.length = 0;
    await send('put', `/lessons/${lesson.id}`, body).expect(400);
    assert.equal(writes(f).length, 0);
  }
  await send('put', `/modules/${module.id}`, { course_id: randomUUID() }).expect(400);
  await send('put', `/lessons/${randomUUID()}`, { title: 'Missing' }).expect(404);
});

test('domain row locks serialize module and lesson limits without advisory or editorial locks', async () => {
  for (const kind of ['module', 'lesson']) {
    const f = mutationFixture();
    const course = f.course();
    const parent = kind === 'lesson' ? f.module(course.id) : null;
    const maximum = kind === 'module' ? 100 : 500;
    for (let i = 0; i < maximum - 1; i += 1) {
      if (kind === 'module') f.module(course.id, { active: false });
      else f.lesson(parent.id, { active: false });
    }
    const results = await Promise.allSettled([1, 2].map(() => kind === 'module'
      ? run(f, mutations.createModule, course.id, { title: 'Race' })
      : run(f, mutations.createLesson, parent.id, { title: 'Race', media })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.reason, `${kind}_limit`);
    assert.equal(f.state[kind === 'module' ? 'modules' : 'lessons'].length, maximum);
    assert.equal(f.state.audits.length, 1);
    assert.equal(f.calls.some(call => /pg_advisory_xact_lock|cms_documents|cms_revisions|cms_assets|7193029/.test(call.sql)), false);
  }
});

test('reorder validates a complete set, normalizes UUIDs and remains transactional', async () => {
  for (const kind of ['module', 'lesson']) {
    const f = mutationFixture();
    const course = f.course();
    const parent = kind === 'module' ? course : f.module(course.id);
    const make = () => kind === 'module' ? f.module(parent.id) : f.lesson(parent.id);
    const a = make(); const b = make();
    const fn = kind === 'module' ? mutations.reorderModules : mutations.reorderLessons;
    for (const ids of [[a.id], [a.id, randomUUID()], [a.id, a.id.toUpperCase()]]) {
      f.calls.length = 0;
      await assert.rejects(run(f, fn, parent.id, ids), bad('invalid_order'));
      assert.equal(writes(f).length, 0);
    }
    await run(f, fn, parent.id, [b.id.toUpperCase(), a.id]);
    const items = kind === 'module' ? f.state.modules : f.state.lessons;
    assert.equal(items.find(row => row.id === b.id).order, 1);
    assert.equal(items.find(row => row.id === a.id).order, 2);
  }
});

test('create and reorder serialize on the course lock and preserve lesson parents', async () => {
  const f = mutationFixture();
  const course = f.course();
  const module = f.module(course.id);
  const lesson = f.lesson(module.id);
  const initial = [module.id];

  const results = await Promise.allSettled([
    run(f, mutations.createModule, course.id, { title: 'Concurrent module' }),
    run(f, mutations.reorderModules, course.id, initial),
  ]);
  const created = results[0];
  const reordered = results[1];
  assert.equal(created.status, 'fulfilled');
  assert.ok(reordered.status === 'fulfilled'
    || (reordered.status === 'rejected' && reordered.reason.reason === 'invalid_order'));
  assert.equal(f.state.modules.length, 2);
  assert.equal(f.state.lessons.find(row => row.id === lesson.id).module_id, module.id);
  assert.equal(f.state.courses.find(row => row.id === course.id).id, course.id);
  assert.equal(f.calls.some(call => /pg_advisory_xact_lock|cms_documents|cms_revisions|cms_assets|7193029/.test(call.sql)), false);
});

test('deleting Academy trees removes only domain rows and preserves historical rows and bytes', async () => {
  const f = mutationFixture();
  const course = f.course();
  const module = f.module(course.id);
  const lesson = f.lesson(module.id);
  const beforeHistory = structuredClone({ documents: f.state.documents, revisions: f.state.revisions, assets: f.state.assets });
  await run(f, mutations.deleteLesson, lesson.id);
  assert.equal(f.state.lessons.some(row => row.id === lesson.id), false);
  assert.deepEqual({ documents: f.state.documents, revisions: f.state.revisions, assets: f.state.assets }, beforeHistory);
  await run(f, mutations.deleteModuleTree, module.id);
  await run(f, mutations.deleteCourseTree, course.id);
  assert.equal(f.state.courses.some(row => row.id === course.id), false);
  assert.deepEqual({ documents: f.state.documents, revisions: f.state.revisions, assets: f.state.assets }, beforeHistory);
  assert.equal(f.calls.some(call => /cms_documents|cms_revisions|cms_assets|7193029|pg_advisory/.test(call.sql)), false);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { mutationFixture } from '../helpers/academy-mutations-fixture.mjs';
import { createAcademyHttp } from '../helpers/academy-integration.mjs';

const require = createRequire(import.meta.url);
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

test('conversion clears URL and keeps ID/CMS; activation requires an active playable published child', async () => {
  const f = mutationFixture();
  const course = f.course({ delivery_mode: 'external', url: 'https://example.test', active: true });
  const doc = { id: randomUUID(), type: 'academy', source_id: course.id, blocks: [] };
  f.state.documents.push(doc);
  await assert.rejects(run(f, mutations.saveCourse, f.users.manager, course.id, { delivery_mode: 'internal' }), bad('course_not_playable'));
  assert.equal(f.state.courses[0].url, 'https://example.test');
  const saved = await run(f, mutations.saveCourse, f.users.manager, course.id, { delivery_mode: 'internal', url: course.url, active: false });
  assert.equal(saved.url, null); assert.equal(saved.id, course.id);
  assert.deepEqual(f.state.documents, [doc]);
  const module = f.module(course.id);
  const lesson = f.lesson(module.id, { active: false });
  const activate = () => run(f, mutations.saveCourse, f.users.manager, course.id, { active: true });
  await assert.rejects(activate(), bad('course_not_playable'));
  f.state.lessons[0].active = true;
  f.state.documents.push({ id: randomUUID(), type: 'academy_lesson', source_id: lesson.id, blocks: null });
  for (const blocks of [null, [{ type: 'invalid' }], [{ type: 'pdf', asset_id: randomUUID(), title: 'Missing' }]]) {
    f.state.documents[1].blocks = blocks;
    f.calls.length = 0;
    await assert.rejects(activate(), bad('course_not_playable'));
    assert.equal(writes(f).length, 0);
  }
  f.state.documents[1].blocks = [];
  f.state.lessons[0].youtube_video_id = 'invalid';
  await assert.rejects(activate(), bad('course_not_playable'));
  f.state.lessons[0].youtube_video_id = 'dQw4w9WgXcQ';
  f.state.modules[0].active = false;
  await assert.rejects(activate(), bad('course_not_playable'));
  f.state.modules[0].active = true;
  assert.equal((await activate()).active, true);
  const lockCalls = f.calls.filter(call => /FOR UPDATE|advisory/.test(call.sql));
  assert.match(lockCalls[0].sql, /advisory/);
  assert.match(lockCalls[1].sql, /FROM academy WHERE/);
  assert.match(lockCalls[2].sql, /FROM academy_modules/);
  assert.match(lockCalls[3].sql, /FROM academy_lessons/);
});

test('activation requires valid parent publication and preserves no-document fallback', async () => {
  for (const blocks of [null, [{ type: 'invalid' }], [{ type: 'pdf', asset_id: randomUUID(), title: 'Missing' }], []]) {
    const f = mutationFixture();
    const course = f.course();
    f.lesson(f.module(course.id).id);
    f.state.documents.push({ id: randomUUID(), type: 'academy', source_id: course.id, blocks });
    const activate = () => run(f, mutations.saveCourse, f.users.manager, course.id, { active: true });
    if (Array.isArray(blocks) && blocks.length === 0) assert.equal((await activate()).active, true);
    else {
      await assert.rejects(activate(), bad('course_not_playable'));
      assert.equal(f.state.courses[0].active, false);
      assert.equal(writes(f).length, 0);
      f.state.documents = [];
      assert.equal((await activate()).active, true);
    }
  }
});

function schedule(f, type, source_id, { blocks = [], future = false, published = false } = {}) {
  const document = { id: randomUUID(), type, source_id, published_revision_id: null,
    scheduled_revision_id: randomUUID(), scheduled_at: new Date(Date.now() + (future ? 86400000 : -86400000)) };
  if (published) {
    document.published_revision_id = randomUUID();
    f.state.revisions.push({ id: document.published_revision_id, document_id: document.id, status: 'published', blocks: [] });
  }
  f.state.documents.push(document);
  f.state.revisions.push({ id: document.scheduled_revision_id, document_id: document.id, status: 'scheduled', blocks });
  return structuredClone(document);
}

test('activation processes due first course and lesson publications without a GET on its single client', async () => {
  const f = mutationFixture();
  const course = f.course(), lesson = f.lesson(f.module(course.id).id);
  const parent = schedule(f, 'academy', course.id);
  const child = schedule(f, 'academy_lesson', lesson.id);
  const unrelated = schedule(f, 'academy', randomUUID());
  assert.equal((await run(f, mutations.saveCourse, f.users.manager, course.id, { active: true })).active, true);
  for (const document of [parent, child]) {
    const current = f.state.documents.find(row => row.id === document.id);
    assert.equal(current.published_revision_id, document.scheduled_revision_id);
    assert.equal(current.scheduled_revision_id, null);
    assert.equal(f.state.revisions.find(row => row.id === document.scheduled_revision_id).status, 'published');
  }
  assert.deepEqual(f.state.documents.find(row => row.id === unrelated.id), unrelated);
  assert.equal(f.calls.filter(call => call.sql === 'BEGIN').length, 1);
  assert.equal(f.calls.filter(call => call.sql === 'COMMIT').length, 1);
  assert.equal(new Set(f.calls.map(call => call.clientId)).size, 1);
  assert.equal(f.calls.filter(call => /cms.document.promote/.test(call.sql)).length, 2);
});

test('future and invalid first schedules cannot activate; rejected activation rolls back CMS processing', async () => {
  for (const type of ['academy', 'academy_lesson']) {
    for (const options of [{ future: true }, { blocks: [{ type: 'invalid' }] },
      { blocks: [{ type: 'pdf', asset_id: randomUUID(), title: 'Missing' }] }]) {
      const f = mutationFixture();
      const course = f.course(), lesson = f.lesson(f.module(course.id).id);
      schedule(f, type, type === 'academy' ? course.id : lesson.id, options);
      const before = structuredClone(f.state);
      await assert.rejects(run(f, mutations.saveCourse, f.users.manager, course.id, { active: true }), bad('course_not_playable'));
      assert.deepEqual(f.state, before);
      assert.equal(f.calls.some(call => /^UPDATE academy SET/.test(call.sql)), false);
      assert.equal(f.calls.filter(call => /cms.document.schedule_invalid/.test(call.sql)).length, options.future ? 0 : 1);
    }
  }
});

test('invalid due replacements retire without replacing valid publication; valid replacement archives prior revision', async () => {
  for (const type of ['academy', 'academy_lesson']) {
    for (const invalid of [true, false]) {
      const f = mutationFixture();
      const course = f.course(), lesson = f.lesson(f.module(course.id).id);
      const document = schedule(f, type, type === 'academy' ? course.id : lesson.id,
        { published: true, blocks: invalid ? [{ type: 'pdf', asset_id: randomUUID(), title: 'Missing' }] : [] });
      assert.equal((await run(f, mutations.saveCourse, f.users.manager, course.id, { active: true })).active, true);
      const current = f.state.documents[0];
      assert.equal(current.scheduled_revision_id, null);
      assert.equal(current.published_revision_id, invalid ? document.published_revision_id : document.scheduled_revision_id);
      assert.equal(f.state.revisions.find(row => row.id === document.scheduled_revision_id).status, invalid ? 'archived' : 'published');
      assert.equal(f.state.revisions.find(row => row.id === document.published_revision_id).status, invalid ? 'published' : 'archived');
      assert.equal(f.calls.filter(call => /cms.document.schedule_invalid/.test(call.sql)).length, invalid ? 1 : 0);
    }
  }
});

test('due promotion is atomic with later playability rejection and CMS audit failure', async () => {
  for (const auditFailure of [false, true]) {
    const f = mutationFixture();
    const course = f.course(), lesson = f.lesson(f.module(course.id).id);
    schedule(f, 'academy', course.id);
    schedule(f, 'academy_lesson', lesson.id, { future: true });
    const before = structuredClone(f.state);
    f.failAudit(auditFailure);
    await assert.rejects(run(f, mutations.saveCourse, f.users.manager, course.id, { active: true }),
      auditFailure ? /audit unavailable/ : bad('course_not_playable'));
    assert.equal(f.calls.some(call => /UPDATE cms_documents SET published_revision_id/.test(call.sql)), true);
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.filter(call => call.sql === 'ROLLBACK').length, 1);
  }
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

test('course lock serializes competing creates at module 100 and lesson 500 across modules, including inactive rows', async () => {
  for (const kind of ['module', 'lesson']) {
    const f = mutationFixture();
    const course = f.course();
    const maximum = kind === 'module' ? 100 : 500;
    const first = kind === 'lesson' ? f.module(course.id) : null;
    const second = kind === 'lesson' ? f.module(course.id) : null;
    for (let i = 0; i < maximum - 1; i++) {
      if (kind === 'module') f.module(course.id, { active: false });
      else f.lesson(first.id, { active: false });
    }
    const results = await Promise.allSettled([first, second].map(module => kind === 'module'
      ? run(f, mutations.createModule, course.id, { title: 'Race' })
      : run(f, mutations.createLesson, module.id, { title: 'Race', media })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.reason, `${kind}_limit`);
    assert.equal(f.state[kind === 'module' ? 'modules' : 'lessons'].length, maximum);
    assert.equal(f.state.audits.length, 1);
  }
});

test('reorder requires the complete parent-bound set, rejects case duplicates and serializes against creates', async () => {
  for (const kind of ['module', 'lesson']) {
    const f = mutationFixture();
    const course = f.course();
    const parent = kind === 'module' ? course : f.module(course.id);
    const make = () => kind === 'module' ? f.module(parent.id) : f.lesson(parent.id);
    const a = make(), b = make();
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
    const create = kind === 'module'
      ? run(f, mutations.createModule, parent.id, { title: 'New' })
      : run(f, mutations.createLesson, parent.id, { title: 'New', media });
    const reorder = run(f, fn, parent.id, [a.id, b.id]);
    await create;
    await assert.rejects(reorder, bad('invalid_order'));
  }
});

test('audit failure rolls back metadata, audience, version and complete tree deletion; shared assets remain', async t => {
  const f = mutationFixture();
  const course = f.course(), other = f.course();
  const module = f.module(course.id), lesson = f.lesson(module.id), sibling = f.lesson(module.id);
  const otherLesson = f.lesson(f.module(other.id).id);
  const asset = { id: randomUUID(), storage_key: 'retained' };
  f.state.assets.push(asset);
  for (const [type, source_id] of [['academy', course.id], ['academy_lesson', lesson.id], ['academy_lesson', sibling.id], ['academy_lesson', otherLesson.id]]) {
    const document = { id: randomUUID(), type, source_id, blocks: [{ type: 'pdf', asset_id: asset.id, title: 'Shared' }] };
    f.state.documents.push(document);
    f.state.revisions.push({ id: randomUUID(), document_id: document.id, blocks: document.blocks });
  }
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  f.failAudit();
  const before = structuredClone(f.state);
  await request.put(`/api/academy/${course.id}`).set('x-fixture-user', 'manager').send({ title: 'Rollback' }).expect(500);
  assert.deepEqual(f.state, before);
  await request.put(`/api/academy/lessons/${lesson.id}`).set('x-fixture-user', 'manager')
    .send({ media: { type: 'youtube', url: 'https://youtu.be/abcdefghijk' } }).expect(500);
  assert.deepEqual(f.state, before);
  await request.delete(`/api/academy/${course.id}`).set('x-fixture-user', 'manager').expect(500);
  assert.deepEqual(f.state, before);
  assert.equal(f.calls.filter(call => /INSERT INTO audit_log/.test(call.sql)).length, 3);
  assert.equal(f.calls.filter(call => call.sql === 'ROLLBACK').length, 3);
  f.failAudit(false);
  for (const [path, remaining] of [[`/lessons/${lesson.id}`, 3], [`/modules/${module.id}`, 2], [`/${course.id}`, 1]]) {
    f.calls.length = 0;
    await request.delete(`/api/academy${path}`).set('x-fixture-user', 'manager').expect(200);
    assert.equal(f.state.documents.length, remaining);
    assert.equal(f.state.revisions.length, remaining);
    assert.deepEqual(f.state.assets, [asset]);
    const firstWrite = writes(f)[0];
    assert.match(firstWrite.sql, /DELETE FROM cms_documents/);
    assert.match(f.calls[1].sql, /advisory/);
  }
  assert.equal(f.state.lessons[0].id, otherLesson.id);
  await request.delete(`/api/academy/${course.id}`).set('x-fixture-user', 'manager').expect(404);
});

test('CMS source course deletion removes all descendant documents across modules before deleting the source', async () => {
  const { deleteCmsSource } = require('../../api/cms/sources');
  const f = mutationFixture();
  const course = f.course(), other = f.course();
  const lessons = [f.lesson(f.module(course.id).id), f.lesson(f.module(course.id).id)];
  for (const [type, source_id] of [['academy', course.id], ['academy', other.id],
    ...lessons.map(row => ['academy_lesson', row.id])]) {
    const doc = { id: randomUUID(), type, source_id, blocks: [] };
    f.state.documents.push(doc);
    f.state.revisions.push({ document_id: doc.id });
  }
  await run(f, deleteCmsSource, 'academy', course.id);
  assert.equal(f.state.documents.length, 1);
  assert.equal(f.state.documents[0].source_id, other.id);
  assert.equal(f.state.revisions.length, 1);
  assert.equal(f.state.lessons.length, 0);
  assert.equal(f.state.modules.length, 0);
  assert.deepEqual(writes(f).slice(0, 3).map(call => call.sql.split(' WHERE')[0]), [
    'DELETE FROM cms_documents', 'DELETE FROM cms_documents', 'DELETE FROM academy',
  ]);
});

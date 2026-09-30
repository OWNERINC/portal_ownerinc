import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mutationFixture } from '../helpers/academy-mutations-fixture.mjs';
import { createAcademyHttp } from '../helpers/academy-integration.mjs';
import { createProgressController } from '../../public/academy/progress-controller.js';

const require = createRequire(import.meta.url);
const { saveProgress, summarizeProgress } = require('../../api/academy/progress');
const input = { media_version: 1, expected_version: 0, position_seconds: 30 };
const initial = { lesson_id: 'lesson', media_version: 1, version: 0, position_seconds: 0, completed: false };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function browser() {
  let time = 0, id = 0;
  let server = { ...initial };
  const timers = new Map(), calls = [], statuses = [];
  const session = new AbortController();
  const controller = createProgressController({ lessonId: 'lesson', initial, signal: session.signal,
    now: () => time, setTimer: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimer: id => timers.delete(id), onStatus: (...args) => statuses.push(args),
    request(path, options) {
      return new Promise((resolve, reject) => calls.push({ path, options, body: JSON.parse(options.body), resolve, reject }));
    } });
  return { controller, calls, statuses, timers, session,
    async tick(ms) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } await settle(); },
    async success(index = calls.length - 1) {
      const call = calls[index];
      server = { ...server, ...call.body, version: call.body.expected_version + 1 };
      call.resolve({ ...server }); await settle();
    },
    async fail(status, index = calls.length - 1) { calls[index].reject(Object.assign(new Error('failure'), { status })); await settle(); },
  };
}

test('30s dirty sync uses raw fetchAPI options, single flight and latest coalesced position', async () => {
  const h = browser();
  h.controller.record(10.8);
  await h.tick(29999); assert.equal(h.calls.length, 0);
  await h.tick(1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, '/api/academy/lessons/lesson/progress');
  assert.equal(h.calls[0].options.method, 'PUT');
  assert.ok(h.calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(h.calls[0].body, { ...input, position_seconds: 10 });
  h.controller.record(20); h.controller.record(29);
  const flushed = h.controller.flush();
  assert.equal(h.calls.length, 1);
  await h.success(0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.position_seconds, 29);
  assert.equal(h.calls[1].body.expected_version, 1);
  await h.success(1); await flushed;
  await h.tick(60000); assert.equal(h.calls.length, 2);
  assert.equal(h.statuses.at(-1)[0], 'saved');
});

test('transient retries use 5/15/30 seconds and 429 cannot be bypassed by flush', async () => {
  const h = browser(); h.controller.record(12); await h.tick(30000);
  for (const delay of [5000, 15000, 30000, 30000]) {
    const count = h.calls.length;
    await h.fail(503);
    assert.equal(h.statuses.at(-1)[0], 'pending');
    await assert.rejects(h.controller.flush());
    await h.tick(delay - 1); assert.equal(h.calls.length, count);
    await h.tick(1); assert.equal(h.calls.length, count + 1);
  }
  await h.fail(429);
  h.controller.record(99);
  await assert.rejects(h.controller.complete());
  const count = h.calls.length;
  await h.tick(59999); assert.equal(h.calls.length, count);
  await h.tick(1); assert.equal(h.calls.at(-1).body.position_seconds, 99);
  await h.success();
});

test('dispose/session abort cancels timers and signal and suppresses delayed UI; new login is independent', async () => {
  const old = browser(); old.controller.record(88);
  const save = old.controller.flush();
  old.session.abort(); const count = old.statuses.length;
  assert.equal(old.calls[0].options.signal.aborted, true);
  const rejected = assert.rejects(save, { name: 'AbortError' });
  await old.success(); await rejected;
  assert.equal(old.statuses.length, count); assert.equal(old.timers.size, 0);
  const fresh = browser(); fresh.controller.record(2);
  const next = fresh.controller.flush();
  assert.equal(fresh.calls[0].body.expected_version, 0);
  assert.equal(fresh.calls[0].body.position_seconds, 2);
  await fresh.success(); await next;
});

test('completion queues behind position save and resolves only after confirmed manual completion', async () => {
  const h = browser(); h.controller.record(10);
  const save = h.controller.flush();
  const complete = h.controller.complete();
  await h.success(0);
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].body.completed, true);
  assert.equal(h.statuses.some(([status, data]) => status === 'saved' && data.completed), false);
  await h.success(1);
  assert.equal((await complete).completed, true); await save;
});

test('completion immediately after a clean flush still persists, and dispose before timer sends nothing', async () => {
  const h = browser();
  await h.controller.flush();
  const first = h.controller.flush();
  const complete = h.controller.complete();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.completed, true);
  await h.success(); await first; await complete;
  const unmounted = browser(); unmounted.controller.record(50); unmounted.controller.dispose();
  await unmounted.tick(30000); assert.equal(unmounted.calls.length, 0);
});

test('manual completion resolves at its own confirmation despite a later position failure and retry', async () => {
  const h = browser();
  let outcome;
  const complete = h.controller.complete().then(result => { outcome = { result }; }, error => { outcome = { error }; });
  h.controller.record(1); h.controller.record(2);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.completed, true);
  await h.success(0);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body, { media_version: 1, expected_version: 1, position_seconds: 2 });
  assert.equal(outcome?.result?.completed, true, 'manual action must settle before the later position request');
  assert.equal(outcome.result.version, 1);
  assert.equal(outcome.result.position_seconds, 0);
  await h.fail(503, 1); await complete;
  assert.equal(outcome.error, undefined);
  assert.equal(h.statuses.at(-1)[0], 'pending');
  h.controller.record(3);
  await h.tick(4999); assert.equal(h.calls.length, 2);
  await h.tick(1); assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls[2].body, { media_version: 1, expected_version: 1, position_seconds: 3 });
  await h.success(2);
  const [status, progress] = h.statuses.at(-1);
  assert.equal(status, 'saved'); assert.equal(progress.completed, true);
  assert.equal(progress.version, 2); assert.equal(progress.position_seconds, 3);
});

test('disposing pending manual completion rejects promptly and ignores its late confirmation', async () => {
  const h = browser();
  const complete = h.controller.complete();
  assert.equal(h.controller.complete(), complete, 'duplicate manual actions share their own confirmation');
  const rejected = assert.rejects(complete, { name: 'AbortError' });
  h.controller.dispose();
  await rejected;
  const count = h.statuses.length;
  assert.equal(h.calls[0].options.signal.aborted, true);
  await h.success();
  assert.equal(h.statuses.length, count);
  assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('failed completion rejects without publishing completed state or retrying the manual action', async () => {
  const h = browser();
  const result = assert.rejects(h.controller.complete());
  await h.fail(500); await result;
  await h.tick(60000); assert.equal(h.calls.length, 1);
  assert.equal(h.statuses.some(([status]) => status === 'saved'), false);
  const retry = h.controller.complete(); await h.success();
  assert.equal((await retry).completed, true);
});

for (const status of [409, 401, 403, 404]) test(`terminal ${status} stops this visit and passes error to access/session layer`, async () => {
  const h = browser(); h.controller.record(10); await h.tick(30000); await h.fail(status);
  assert.equal(h.statuses.at(-1)[0], status === 409 ? 'conflict' : 'unavailable');
  assert.equal(h.statuses.at(-1)[1].status, status);
  h.controller.record(50); await h.tick(60000);
  await assert.rejects(h.controller.complete(), { status });
  assert.equal(h.calls.length, 1);
});

function service() {
  const f = mutationFixture();
  const course = f.course({ active: true });
  const module = f.module(course.id), lesson = f.lesson(module.id);
  const rows = [];
  const pool = { async connect() {
    const db = await f.pool.connect();
    return { release: () => db.release(), async query(sql, values) {
      if (!/^(INSERT INTO|UPDATE) academy_lesson_progress/.test(sql)) return db.query(sql, values);
      const [user_uid, lesson_id, media_version, position_seconds, completed, expected] = values;
      const row = rows.find(row => row.user_uid === user_uid && row.lesson_id === lesson_id && row.media_version === media_version);
      if (/^INSERT/.test(sql)) {
        assert.match(sql, /ON CONFLICT .* DO NOTHING/);
        if (row) return { rows: [] };
        rows.push({ user_uid, lesson_id, media_version, position_seconds, completed: completed ?? false,
          completed_at: completed ? '2026-09-30' : null, version: 1 });
        return { rows: [{ ...rows.at(-1) }] };
      }
      assert.match(sql, /user_uid=\$1 AND lesson_id=\$2 AND media_version=\$3 AND version=\$6/);
      if (!row || row.version !== expected) return { rows: [] };
      Object.assign(row, { position_seconds, version: row.version + 1 });
      if (completed !== null) Object.assign(row, { completed, completed_at: completed ? row.completed_at || '2026-09-30' : null });
      return { rows: [{ ...row }] };
    } };
  } };
  return { ...f, pool, get course() { return f.state.courses.find(row => row.id === course.id); },
    get module() { return f.state.modules.find(row => row.id === module.id); },
    get lesson() { return f.state.lessons.find(row => row.id === lesson.id); }, rows };
}

test('real service authorizes on one locked client, isolates UID, CAS races and manual completion', async () => {
  const f = service(), user = { uid: 'learner' };
  const save = data => saveProgress(f.pool, user, f.lesson.id, data);
  const results = await Promise.allSettled([save(input), save(input)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.reason, 'progress_conflict');
  assert.deepEqual(f.calls.filter(c => c.clientId === 1 && /advisory|FOR UPDATE/.test(c.sql)).slice(0, 4).map(c => c.sql.match(/advisory|FROM \w+/)[0]),
    ['advisory', 'FROM academy', 'FROM academy_modules', 'FROM academy_lessons']);
  for (const client of new Set(f.calls.map(c => c.clientId))) {
    const calls = f.calls.filter(c => c.clientId === client);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.match(calls.at(-1).sql, /COMMIT|ROLLBACK/);
  }
  const completed = await save({ ...input, expected_version: 1, completed: true });
  assert.equal(completed.completed, true);
  const preserved = await save({ ...input, expected_version: 2, position_seconds: 5 });
  assert.equal(preserved.completed, true); assert.equal(preserved.completed_at, completed.completed_at);
  assert.equal((await save({ ...input, expected_version: 3, completed: false })).completed_at, null);
  await assert.rejects(save({ ...input, expected_version: 1 }), { reason: 'progress_conflict' });
  assert.equal((await saveProgress(f.pool, { uid: 'other' }, f.lesson.id, input)).version, 1);
  assert.equal(f.rows.length, 2);
});

test('HTTP rejects external UID/invalid payloads, stale media, inactive hierarchy and unpublished sources', async t => {
  const f = service();
  const { request } = await createAcademyHttp(t, f.pool, f.users);
  const put = data => request.put(`/api/academy/lessons/${f.lesson.id}/progress`).set('x-fixture-user', 'denied').send(data);
  for (const body of [{ ...input, user_uid: 'other' }, { ...input, position_seconds: 86401 },
    { ...input, position_seconds: 1.5 }, { ...input, expected_version: -1 }, { ...input, completed: null },
    { ...input, media_version: 0 }, { position_seconds: 0 }, { ...input, constructor: 'extra' }]) await put(body).expect(400);
  assert.equal(f.calls.length, 0);
  assert.equal((await put(input).expect(200)).body.version, 1);
  f.lesson.media_version = 2;
  assert.equal((await put(input).expect(409)).body.reason, 'media_changed');
  const current = { ...input, media_version: 2 };
  assert.equal((await put(current).expect(200)).body.version, 1);
  f.course.active = false; await put(current).expect(404); f.course.active = true;
  f.module.active = false; await put(current).expect(404); f.module.active = true;
  f.lesson.active = false; await put(current).expect(404); f.lesson.active = true;
  f.course.audience = 'job_titles'; await put(current).expect(404); f.course.audience = 'all';
  f.state.documents.push({ type: 'academy_lesson', source_id: f.lesson.id, blocks: null });
  await put(current).expect(404);
});

test('summary deduplicates visible IDs, ignores old media and resumes after most recent completed lesson', () => {
  const lessons = ['a', 'b', 'c'].map(id => ({ id, media_version: 2 }));
  const progress = [
    { lesson_id: 'a', media_version: 2, completed: false, updated_at: '2026-09-01' },
    { lesson_id: 'b', media_version: 2, completed: true, updated_at: '2026-09-30' },
    { lesson_id: 'c', media_version: 1, completed: true, updated_at: '2026-09-30' },
  ];
  assert.deepEqual(summarizeProgress([...lessons, lessons[0]], progress), {
    total_lessons: 3, completed_lessons: 1, progress_percent: 33, resume_lesson_id: 'c',
  });
});

test('authenticated middleware selects 120/UID only for exact progress PUT, retaining default write limit', async () => {
  const source = await readFile(new URL('../../api/middleware/auth.js', import.meta.url), 'utf8');
  const selected = [];
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === 'firebase-admin/app') return { getApps: () => [1] };
    if (name === 'firebase-admin/auth') return { getAuth: () => ({ verifyIdToken: async token => ({ uid: token, email_verified: true }) }) };
    if (name === '../db') return { query: async (_sql, [uid]) => ({ rows: [{ uid }] }) };
    if (name === './policy') return { can() {}, canUseAutoCard() {}, canUsePosCards() {} };
    if (name === './security') return { rateLimit: options => (req, _res, next) => { selected.push([options.max, options.windowMs, options.key(req)]); next(); } };
    throw new Error(name);
  } });
  vm.runInContext(source, context);
  const path = '/api/academy/lessons/12345678-abcd-abcd-abcd-123456789abc/progress';
  for (const [method, url, max] of [ ['PUT', path, 120], ['PUT', path + '?x=1', 120],
    ['POST', path, 60], ['PATCH', path, 60], ['DELETE', path, 60], ['PUT', path + '/', 60],
    ['PUT', path + '/extra', 60], ['PUT', path.replace('12345678', 'invalid'), 60],
    ['PUT', '/api/academy/12345678-abcd-abcd-abcd-123456789abc', 60], ['PUT', '/api/users/me', 60] ]) {
    let next = false;
    await context.module.exports.authMiddleware({ method, originalUrl: url, headers: { authorization: 'Bearer user-a' } }, {}, error => { if (error) throw error; next = true; });
    assert.equal(next, true); assert.deepEqual(selected.at(-1), [max, 900000, 'user-a']);
  }
});

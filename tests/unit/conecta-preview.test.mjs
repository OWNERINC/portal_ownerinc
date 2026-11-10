import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixtureData, fixtureResponse, user } from '../visual/conecta-fixtures.mjs';

const now = new Date('2026-12-30T15:00:00Z');
const response = path => fixtureResponse(new URL(path, 'http://localhost'), now);
const data = path => response(path)?.data;

test('preview has exactly two complete learning paths and consistent progress', () => {
  const courses = data('/api/academy');
  assert.equal(courses.length, 2);
  assert.deepEqual(courses.map(course => course.learning_group), ['initial', 'role']);
  for (const course of courses) {
    const view = data(`/api/academy/${course.id}`);
    assert.equal(view.modules.length, 2);
    assert.ok(view.modules.every(module => module.lessons.length === 3));
    const lessons = view.modules.flatMap(module => module.lessons);
    assert.equal(course.total_lessons, lessons.length);
    assert.equal(course.completed_lessons, lessons.filter(lesson => lesson.completed).length);
    assert.equal(course.progress_percent, Math.floor(course.completed_lessons / lessons.length * 100));
    lessons.forEach((lesson, index) => {
      const detail = data(`/api/academy/lessons/${lesson.id}`);
      assert.equal(detail.course_id, course.id);
      assert.equal(detail.lesson.module_id, view.modules.find(module => module.lessons.includes(lesson)).id);
      assert.equal(detail.progress.completed, lesson.completed);
      assert.equal(detail.next_lesson_id, lessons[index + 1]?.id ?? null);
      assert.equal(detail.previous_lesson_id, lessons[index - 1]?.id ?? null);
      assert.equal(detail.media, null);
      assert.match(detail.description, /demonstrativ/i);
      assert.ok(detail.description.length > 160);
    });
    if (course.resume_lesson_id) assert.equal(lessons.find(lesson => lesson.id === course.resume_lesson_id).completed, false);
  }
  assert.deepEqual(data('/api/academy/continue').map(course => course.id), ['culture']);
  assert.equal(data('/api/academy?group=role')[0].resume_lesson_id, null);
  assert.equal(data('/api/academy/lessons/culture-4').lesson.title, 'Nosso jeito de trabalhar');
});

test('lists apply filters before pagination and return full filtered totals', () => {
  assert.equal(response('/api/academy?limit=1').total, 2);
  assert.equal(data('/api/academy?limit=1&offset=1')[0].id, 'service');
  assert.equal(data('/api/academy?group=initial&category=Cultura').length, 1);
  assert.equal(data('/api/academy?group=role&category=Cultura').length, 0);
  assert.equal(data('/api/knowledge').length, 8);
  const filtered = response('/api/knowledge?category=Tecnologia&limit=1&offset=1');
  assert.equal(filtered.total, 2);
  assert.equal(filtered.data.length, 1);
  assert.equal(data('/api/knowledge?search=SEGURANÇA').length, 1);
  assert.equal(data('/api/knowledge?q=SEGURANÇA').length, 1);
  assert.equal(data('/api/knowledge?search=conteudo-inexistente').length, 0);
  assert.equal(data('/api/knowledge?limit=0').length, 0);
  assert.equal(data('/api/knowledge?limit=-1').length, 8);
  assert.equal(data('/api/knowledge?offset=999').length, 0);
  assert.equal(data('/api/knowledge?offset=NaN').length, 8);
  for (const article of data('/api/knowledge')) {
    assert.ok(article.content.length > 500);
    assert.match(article.content, /demonstrativ/i);
    assert.equal(data(`/api/knowledge/${article.id}`).title, article.title);
  }
});

test('categories are derived from content and group filters', () => {
  for (const domain of ['knowledge', 'benefits', 'academy']) {
    assert.deepEqual(new Set(data(`/api/${domain}/categories`)), new Set(data(`/api/${domain}`).map(item => item.category)));
  }
  assert.deepEqual(data('/api/academy/categories?group=role'), ['Atendimento']);
});

test('reminder dates stay future and valid across month and year boundaries', () => {
  for (const date of [now, new Date('2028-02-28T15:00:00Z'), new Date('2027-01-01T01:00:00Z')]) {
    const get = path => fixtureResponse(new URL(path, 'http://localhost'), date).data;
    const reminders = get('/api/reminders');
    assert.equal(reminders.length, 6);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
    for (const reminder of reminders) {
      assert.equal(new Date(`${reminder.next_occurrence}T12:00:00Z`).toISOString().slice(0, 10), reminder.next_occurrence);
      assert.ok(reminder.next_occurrence >= today);
      assert.equal(Number(reminder.next_occurrence.slice(-2)), reminder.trigger_day);
      assert.equal(get(`/api/reminders/${reminder.id}`).title, reminder.title);
    }
    const upcoming = get('/api/reminders/upcoming?days=7');
    assert.ok(upcoming.length >= 3);
    assert.ok(upcoming.every(item => item.active && Date.parse(item.next_occurrence) - Date.parse(today) <= 7 * 86400000));
    assert.ok(get('/api/reminders/upcoming?days=0').length < upcoming.length);
    const deliveries = get('/api/reminders/deliveries?status=sent');
    assert.ok(deliveries.length > 0);
    assert.ok(deliveries.every(item => item.status === 'sent' && reminders.some(reminder => reminder.id === item.reminder_id)));
  }
});

test('secondary pages have compatible mock records and working filters', () => {
  assert.equal(data('/api/users/me').uid, user.uid);
  assert.ok(data('/api/users').length >= 5);
  assert.ok(data('/api/users?state=disabled').every(item => item.state === 'disabled'));
  assert.equal(data('/api/users?q=Rafael').length, 1);
  assert.equal(data('/api/users?role=admin').length, 1);
  assert.ok(data(`/api/users?job_title_id=${user.job_title_id}`).every(item => item.job_title_id === user.job_title_id));
  assert.ok(data('/api/job-titles?active=false').every(item => item.active === false));
  assert.ok(data('/api/users/audit').length > 0);
  assert.ok(data('/api/registrations?status=pending').length > 0);
  assert.ok(data('/api/benefits').length >= 4);
  for (const tool of ['autocard', 'pos-cards']) {
    const cards = data(`/api/${tool}/cards`);
    assert.ok(cards.length >= 2);
    for (const card of cards) {
      assert.equal(data(`/api/${tool}/cards/${card.id}`).name, card.name);
      assert.ok(card.values && Number.isFinite(Date.parse(card.updatedAt)));
      assert.equal(card.mediaId, null);
    }
    assert.equal(data(`/api/${tool}/cards?search=inexistente`).length, 0);
  }
  assert.equal(data('/api/solides/admin/status').enabled, false);
  assert.ok(data('/api/solides/me/summary').entries.length > 0);
  assert.ok(data('/api/solides/me/schedule').employee.schedule.days.length > 0);
  assert.ok(data('/api/solides/me/adjustments').entries.length > 0);
  assert.ok(response('/api/solides/me/punches?limit=1').total > 1);
  assert.equal(data('/api/solides/me/punches?limit=1').entries.length, 1);
  assert.equal(data('/api/solides/me/punches?from=2000-01-01&to=2000-12-31').entries.length, 0);
});

test('unknown details never leak an unrelated fixture and reads cannot mutate shared data', () => {
  for (const path of ['/api/unknown', '/api/knowledge/missing', '/api/reminders/missing', '/api/academy/missing',
    '/api/academy/lessons/missing', '/api/academy/lessons/culture-4/progress', '/api/autocard/cards/missing', '/api/pos-cards/cards/missing', '/api/solides/me/missing']) {
    assert.equal(response(path), undefined, path);
  }
  data('/api/academy/culture').modules[0].lessons[0].title = 'changed';
  assert.notEqual(data('/api/academy/culture').modules[0].lessons[0].title, 'changed');
  assert.ok(Array.isArray(fixtureData(new URL('http://localhost/api/academy'))));
});

test('loopback HTTP preview preserves totals, unknown IDs and read-only isolation', { timeout: 15000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../visual/serve-conecta.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    child.on('error', reject);
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => reject(new Error(`Preview exited ${code}: ${output}`)));
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  const result = await fetch(`${base}/api/knowledge?limit=1`);
  assert.equal(result.headers.get('X-Total-Count'), '8');
  assert.equal((await result.json()).length, 1);
  const filtered = await fetch(`${base}/api/knowledge?category=Tecnologia&limit=1`);
  assert.equal(filtered.headers.get('X-Total-Count'), '2');
  assert.equal((await filtered.json()).length, 1);
  const punches = await fetch(`${base}/api/solides/me/punches?limit=1`);
  assert.equal(punches.headers.get('X-Total-Count'), '5');
  assert.equal((await punches.json()).entries.length, 1);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const write = await fetch(`${base}/api/knowledge`, { method });
    assert.equal(write.status, 405);
    assert.match((await write.json()).error, /gravações indisponíveis/);
  }
  for (const path of ['/api/academy/lessons/missing', '/api/unknown', '/api/cms', '/api/knowledge/missing']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/announcements.html`)).status, 404);
  const html = await (await fetch(`${base}/dashboard.html`)).text();
  assert.match(html, /PRÉVIA LOCAL/);
  assert.match(html, /sem gravações/);
  assert.match(html, /integrações reais indisponíveis/);
  const head = await fetch(`${base}/api/academy`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

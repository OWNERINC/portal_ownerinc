import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDependencyHarness } from '../helpers/api-dependency-harness.mjs';
import { createFeedbackHarness, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';

const removedFiles = [
  'public/announcements.html',
  'public/css/owner-news.css',
  'public/js/announcements.js',
  'api/routes/announcements.js',
  'api/routes/owner-news-admin.js',
  'api/routes/owner-news-polls.js',
  'api/owner-news/editorial.js',
  'api/owner-news/home.js',
  'api/owner-news/polls.js',
];

const removedDirectories = ['public/js/owner-news', 'api/owner-news'];

test('Owner News executable files and frontend module directory are absent', async () => {
  for (const file of removedFiles) {
    if (file === 'cron/Dockerfile') continue;
    assert.equal(existsSync(file), false, file);
  }
  for (const directory of removedDirectories) assert.equal(existsSync(directory), false, directory);

  const scripts = await readFile('scripts/generate-public-shell.mjs', 'utf8');
  assert.doesNotMatch(scripts, /announcements|owner-news|Owner News/i);
});

test('shared runtime has no Owner News or CMS consumer', async () => {
  const files = [
    'api/index.js',
    'public/js/dashboard.js',
    'public/js/router.js',
    'public/dashboard.html',
    'public/home-preview.html',
    'cron/checkReminders.js',
  ];
  const sources = await Promise.all(files.map(file => readFile(file, 'utf8')));
  assert.doesNotMatch(sources[0], /routes\/announcements|owner-news-admin|owner-news/);
  for (const [index, source] of sources.slice(1).entries()) {
    assert.doesNotMatch(source, /owner-news|Owner News|announcements|announcement/i, files[index + 1]);
  }

  assert.doesNotMatch(sources[0], /\/api\/cms|routes\/cms|cms-assets/);
  assert.match(sources[1], /storyCard/);
  assert.match(sources[1], /reminders\/upcoming/);
  assert.match(sources[1], /api\/academy/);
});

test('maintained Dashboard keeps scoped areas, civil dates, retry and lifecycle cleanup', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());

  const reminders = h.latest('/api/reminders/upcoming');
  const academy = h.latest('/api/academy/continue?');
  assert.ok(reminders);
  assert.ok(academy);
  assert.equal(h.requests.some(request => /announcements|owner-news/i.test(request.path)), false);

  reminders.reject(new Error('offline'));
  academy.resolve([{ id: 'course-1', title: 'Curso sintético', active: true, delivery_mode: 'internal' }]);
  await drain();
  assert.match(h.node('reminders-list').textContent, /Não foi possível carregar as notificações/);
  assert.match(h.node('academy-preview').textContent, /Curso sintético/);

  const retry = h.node('reminders-list').querySelector('button');
  assert.ok(retry);
  retry.click();
  const retryRequest = h.latest('/api/reminders/upcoming');
  retryRequest.resolve([{ id: 'reminder-1', title: 'Lembrete sintético', next_occurrence: '2099-01-02', description: 'Descrição' }]);
  await drain();
  assert.match(h.node('reminders-list').textContent, /Lembrete sintético/);
  assert.equal(h.node('quick-links').querySelectorAll('a').length, 3);

  h.page.bindAPI({ fetchAPI: h.context.fetchAPI }).fetchAPI('/api/reminders/upcoming?days=7');
  const pending = h.latest('/api/reminders/upcoming?days=7');
  h.page.dispose();
  assert.equal(pending.options.signal.aborted, true);
});

test('maintained Dashboard reloads only its areas after a persisted pageshow', async () => {
  const h = await createFeedbackHarness('dashboard');
  const initialReminders = h.latest('/api/reminders/upcoming');
  const initialAcademy = h.latest('/api/academy/continue?');
  initialReminders.resolve([{ id: 'reminder-initial', title: 'Lembrete inicial', next_occurrence: '2099-01-02', description: 'Inicial' }]);
  initialAcademy.resolve([{ id: 'course-initial', title: 'Curso inicial', active: true, delivery_mode: 'internal' }]);
  await drain();
  assert.match(h.node('reminders-list').textContent, /Lembrete inicial/);
  assert.match(h.node('academy-preview').textContent, /Curso inicial/);

  const beforeNonPersistedPageshow = h.requests.length;
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: false }));
  await drain();
  assert.equal(h.requests.length, beforeNonPersistedPageshow);

  const beforePageshow = h.requests.length;
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  await drain();
  const reloaded = h.requests.slice(beforePageshow);
  assert.deepEqual(reloaded.map(request => request.path), [
    '/api/reminders/upcoming?days=7',
    '/api/academy/continue?limit=1',
  ]);
  assert.equal(h.requests.filter(request => /announcements|owner-news/i.test(request.path)).length, 0);
  assert.equal(h.requests.some(request => request.kind === 'asset'), false);

  reloaded[0].resolve([{ id: 'reminder-bfcache', title: 'Lembrete BFCache', next_occurrence: '2099-01-03', description: 'Atualizado' }]);
  reloaded[1].resolve([{ id: 'course-bfcache', title: 'Curso BFCache', active: true, delivery_mode: 'internal' }]);
  await drain();
  assert.match(h.node('reminders-list').textContent, /Lembrete BFCache/);
  assert.match(h.node('academy-preview').textContent, /Curso BFCache/);
  assert.doesNotMatch(h.node('reminders-list').textContent, /Lembrete inicial/);
  assert.doesNotMatch(h.node('academy-preview').textContent, /Curso inicial/);

  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  await drain();
  const late = h.requests.slice(-2);
  const requestCountBeforeDispose = h.requests.length;
  h.page.dispose();
  assert.equal(late.every(request => request.options.signal.aborted), true);
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  late[0].resolve([{ id: 'reminder-stale', title: 'Lembrete tardio', next_occurrence: '2099-01-04' }]);
  late[1].resolve([{ id: 'course-stale', title: 'Curso tardio', active: true, delivery_mode: 'internal' }]);
  await drain();
  assert.equal(h.requests.length, requestCountBeforeDispose);
  assert.match(h.node('reminders-list').textContent, /Lembrete BFCache/);
  assert.match(h.node('academy-preview').textContent, /Curso BFCache/);
  assert.doesNotMatch(h.node('reminders-list').textContent, /Lembrete tardio/);
  assert.doesNotMatch(h.node('academy-preview').textContent, /Curso tardio/);
});

test('legacy Owner News API paths return controlled 404s without database access', async t => {
  const h = await createDependencyHarness(t);
  for (const path of [
    '/api/announcements',
    '/api/announcements/categories',
    '/api/announcements/00000000-0000-4000-8000-000000000000',
    '/api/cms/owner-news',
    '/api/cms/owner-news/home',
    '/api/cms/owner-news/polls',
    '/api/cms/documents',
    '/api/cms/assets',
    '/api/cms/assets/00000000-0000-4000-8000-000000000000',
  ]) {
    const response = await h.request.get(path);
    assert.equal(response.status, 404, path);
  }
  assert.equal(h.state.sql.some(({ sql }) => /owner_news|announcement/i.test(sql)), false);
});

test('legacy Owner News browser URL is an explicit Nginx 404 and does not use SPA fallback', async () => {
  const nginx = await readFile('nginx/nginx.conf', 'utf8');
  assert.match(nginx, /location\s*=\s*\/announcements\.html\s*\{\s*return\s+404;\s*\}/);
  assert.match(nginx, /location\s+\^~\s+\/announcements\.html\/\s*\{\s*return\s+404;\s*\}/);
  assert.match(nginx, /location\s+\/\s*\{\s*try_files\s+\$uri\s+\$uri\/\s+\/index\.html;\s*\}/s);
});

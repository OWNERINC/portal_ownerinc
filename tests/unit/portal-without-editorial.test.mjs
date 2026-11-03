import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDependencyHarness } from '../helpers/api-dependency-harness.mjs';
import { createFeedbackHarness, drain } from '../helpers/frontend-feedback-harness.mjs';

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

test('shared runtime has no Owner News consumer while generic CMS remains', async () => {
  const files = [
    'api/index.js',
    'api/routes/cms.js',
    'api/routes/cms-assets.js',
    'api/cms/permissions.js',
    'api/cms/reader.js',
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

  const cms = sources[1];
  const reader = sources[4];
  assert.match(cms, /CONTENT_TYPES/);
  assert.match(cms, /knowledge/);
  assert.match(cms, /academy/);
  assert.match(cms, /reminder/);
  assert.match(reader, /getPublishedBlocksBatch/);
  assert.match(reader, /validatePublishedBlocksBatch/);
  assert.match(sources[5], /storyCard/);
  assert.match(sources[5], /reminders\/upcoming/);
  assert.match(sources[5], /api\/academy/);
});

test('maintained Dashboard keeps scoped areas, civil dates, retry and lifecycle cleanup', async t => {
  const h = await createFeedbackHarness('dashboard');
  t.after(() => h.page.dispose());

  const reminders = h.latest('/api/reminders/upcoming');
  const academy = h.latest('/api/academy?');
  assert.ok(reminders);
  assert.ok(academy);
  assert.equal(h.requests.some(request => /announcements|owner-news/i.test(request.path)), false);

  reminders.reject(new Error('offline'));
  academy.resolve([{ id: 'course-1', title: 'Curso sintético', active: true, delivery_mode: 'internal' }]);
  await drain();
  assert.match(h.node('reminders-list').textContent, /Não foi possível carregar os lembretes/);
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

test('legacy Owner News API paths return controlled 404s without database access', async t => {
  const h = await createDependencyHarness(t);
  for (const path of [
    '/api/announcements',
    '/api/announcements/categories',
    '/api/announcements/00000000-0000-4000-8000-000000000000',
    '/api/cms/owner-news',
    '/api/cms/owner-news/home',
    '/api/cms/owner-news/polls',
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

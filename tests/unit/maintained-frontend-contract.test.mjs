import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createFeedbackHarness, drain } from '../helpers/frontend-feedback-harness.mjs';

const [knowledgeCss, knowledgeHtml, knowledge, academy, academyLesson, benefits, reminders, dashboard] = await Promise.all([
  readFile('public/css/knowledge.css', 'utf8'),
  readFile('public/knowledge.html', 'utf8'),
  readFile('public/js/knowledge.js', 'utf8'),
  readFile('public/academy/course-view.js', 'utf8'),
  readFile('public/academy/lesson-view.js', 'utf8'),
  readFile('public/js/benefits.js', 'utf8'),
  readFile('public/js/reminders.js', 'utf8'),
  readFile('public/js/dashboard.js', 'utf8'),
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createRemindersLoaderHarness() {
  const sourceStart = reminders.indexOf('async function loadReminders(');
  const sourceEnd = reminders.indexOf('\n\nasync function loadDeliveryManager', sourceStart);
  const source = reminders.slice(sourceStart, sourceEnd);
  const context = {
    canManage: false,
    PAGE_SIZE: 50,
    page: 0,
    reminders: [],
    remindersRequest: 0,
    totalReminders: 0,
    fetchImpl: () => { throw new Error('fetchImpl not configured'); },
    fetchAPIPage: (...args) => context.fetchImpl(...args),
    tableStates: [],
    tableState: (...args) => context.tableStates.push(args),
    rendered: [],
    pagination: [],
    renderTable: () => {
      context.rendered.push({
        ids: context.reminders.map(reminder => reminder.id),
        page: context.page,
        total: context.totalReminders,
      });
      context.pagination.push({ page: context.page, total: context.totalReminders });
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.loadReminders = loadReminders;`, context, { filename: 'reminders.js' });
  return { context, loadReminders: context.loadReminders };
}

test('reminder reloads ignore deferred responses that finish out of order', async () => {
  const harness = createRemindersLoaderHarness();
  const pending = [];
  harness.context.fetchImpl = url => new Promise((resolve, reject) => pending.push({ url, resolve, reject }));

  harness.context.page = 1;
  const first = harness.loadReminders();
  const second = harness.loadReminders(true);
  await Promise.resolve();
  assert.deepEqual(pending.map(({ url }) => url), [
    '/api/reminders?limit=50&offset=50',
    '/api/reminders?limit=50&offset=0',
  ]);

  pending[1].resolve({ data: [{ id: 'new' }], total: 1 });
  await second;
  pending[0].resolve({ data: [{ id: 'old' }], total: 99 });
  await first;

  assert.deepEqual(harness.context.reminders, [{ id: 'new' }]);
  assert.equal(harness.context.totalReminders, 1);
  assert.deepEqual(harness.context.rendered, [{ ids: ['new'], page: 0, total: 1 }]);
  assert.equal(harness.context.tableStates.length, 2);

  harness.context.page = 2;
  const fallback = harness.loadReminders();
  await Promise.resolve();
  assert.equal(pending[2].url, '/api/reminders?limit=50&offset=100');
  pending[2].resolve({ data: [], total: 75 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending[3].url, '/api/reminders?limit=50&offset=50');
  pending[3].resolve({ data: [{ id: 'last-valid-page' }], total: 75 });
  await fallback;

  assert.equal(harness.context.page, 1);
  assert.deepEqual(harness.context.reminders, [{ id: 'last-valid-page' }]);
  assert.equal(harness.context.totalReminders, 75);
  assert.deepEqual(harness.context.rendered, [
    { ids: ['new'], page: 0, total: 1 },
    { ids: ['last-valid-page'], page: 1, total: 75 },
  ]);
  assert.deepEqual(harness.context.pagination, [
    { page: 0, total: 1 },
    { page: 1, total: 75 },
  ]);
  assert.equal(harness.context.tableStates.length, 4);
});

test('maintained frontends have no editorial renderer dependency', () => {
  for (const source of [knowledge, academy, academyLesson, benefits, reminders, dashboard]) {
    assert.doesNotMatch(source, /cms-block-renderer|content_blocks|\/api\/cms|renderBlocks/);
  }
});

test('optional pagination containers stay null-safe on list and detail pages', async () => {
  const [pagination, remindersSource] = await Promise.all([
    readFile('public/js/pagination.js', 'utf8'),
    readFile('public/js/reminders.js', 'utf8'),
  ]);
  assert.match(pagination, /if \(!node\) return/);
  assert.match(remindersSource, /if \(!remindersPagination\) return/);
});

test('Knowledge frontend has no PDF or editorial controls', () => {
  assert.match(knowledgeHtml, /href="\.\/css\/knowledge\.css"/);
  assert.doesNotMatch(knowledgeHtml, /f-pdf|pdf_state|PDF do artigo/i);
  assert.match(knowledgeCss, /\.knowledge-search\s*\{/);
  assert.doesNotMatch(knowledge, /FormData|pdf_asset_id|pdf_title|pdfUploadPromise|cms\.html|article-cms-link/);
});

test('Benefits renders own description as text without the CMS transport', async () => {
  const h = await createFeedbackHarness('benefits', {
    mount: false,
    modules: [
      { path: 'public/js/pagination.js', exports: 'readOffset, renderPagination' },
      { path: 'public/js/benefits.js', exports: 'mount' },
    ],
  });
  h.context.mount(h.page);
  await drain();
  h.latest('/api/benefits?').resolve({
    data: [{ id: 'benefit-1', company: 'Parceria', category: 'Saúde', active: true,
      description: '<script>não executar</script>', instructions: 'Procure o RH.' }], total: 1,
  });
  h.latest('/api/benefits/categories').resolve(['Saúde']);
  await drain();
  assert.equal(h.node('benefits-content').textContent.includes('<script>não executar</script>'), true);
  assert.equal(h.requests.some(request => /\/api\/cms/i.test(request.path)), false);
  assert.equal(h.requests.some(request => /\/api\/benefits\?/.test(request.path)), true);
});

test('Knowledge has retired the PDF upload surface', () => {
  assert.doesNotMatch(knowledgeHtml, /f-pdf|pdf_state|application\/pdf/i);
  assert.doesNotMatch(knowledge, /file\.size|pdf_asset_id|pdf_title|fetchAPIAsset|\/api\/cms/);
});

test('descriptions stay in each maintained domain and the retired shared CSS is not loaded', async () => {
  const pages = await Promise.all(['public/academy.html', 'public/dashboard.html', 'public/reminders.html', 'public/benefits.html']
    .map(file => readFile(file, 'utf8')));
  for (const source of pages) assert.doesNotMatch(source, /css\/cms\.css|content_blocks|\/api\/cms/);
  assert.match(benefits, /description/);
  assert.match(reminders, /description/);
  assert.match(dashboard, /description/);
});

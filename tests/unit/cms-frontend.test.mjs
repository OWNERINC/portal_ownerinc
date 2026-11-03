import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [renderer, css, knowledgeCss, knowledgeHtml, knowledge, academy, academyLesson, benefits, reminders, dashboard] = await Promise.all([
  readFile('public/js/cms-block-renderer.js', 'utf8'),
  readFile('public/css/cms.css', 'utf8'),
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

test('safe renderer validates the allowlist and never uses raw HTML sinks', () => {
  for (const type of ['quote', 'profile']) assert.match(renderer, new RegExp(`['"]${type}['"]`));
  assert.match(renderer, /export const BLOCK_TYPES/);
  assert.match(renderer, /export function validateBlocks/);
  assert.match(renderer, /MAX_CMS_PAYLOAD_BYTES = 5 \* 1024 \* 1024/);
  assert.match(renderer, /TextEncoder\(\)\.encode\(JSON\.stringify\(blocks\)\)/);
  assert.match(renderer, /textContent/);
  assert.match(renderer, /fetchAPIAsset/);
  assert.match(renderer, /\/api\/cms\/assets\//);
  assert.doesNotMatch(renderer, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('optional pagination containers stay null-safe on list and detail pages', async () => {
  const [pagination, remindersSource] = await Promise.all([
    readFile('public/js/pagination.js', 'utf8'),
    readFile('public/js/reminders.js', 'utf8'),
  ]);
  assert.match(pagination, /if \(!node\) return/);
  assert.match(remindersSource, /if \(!remindersPagination\) return/);
});

test.skip('legacy Knowledge PDF controls', () => {
  assert.match(knowledgeHtml, /href="\.\/css\/knowledge\.css"/);
  assert.match(knowledgeHtml, /id="f-pdf"[^>]*type="file"[^>]*accept="application\/pdf"/);
  assert.match(knowledgeHtml, /id="f-pdf-remove"/);
  assert.match(knowledgeCss, /\.knowledge-search\s*\{/);
  assert.match(knowledge, /FormData/);
  assert.match(knowledge, /pdf_asset_id/);
  assert.match(knowledge, /pdf_title/);
  assert.match(knowledge, /pdfUploadPromise/);
  assert.doesNotMatch(knowledge, /Editor CMS|cms\.html|article-cms-link/);
});

test.skip('legacy Knowledge PDF upload limit', () => {
  assert.equal((knowledge.match(/file\.size > 100 \* 1024 \* 1024/g) || []).length, 2);
  assert.equal((knowledge.match(/O PDF deve ter no máximo 100 MB\./g) || []).length, 2);
});

test.skip('legacy CMS block rendering transition', () => {
  for (const source of [knowledge, academy, academyLesson, benefits]) {
    assert.match(source, /content_blocks/);
    assert.match(source, /renderBlocks/);
  }
  assert.match(reminders, /renderBlocks\(content, reminder\.content_blocks/);
  assert.match(reminders, /fallbackText: reminder\.description/);
  assert.match(dashboard, /renderBlocks\(copy, blocks/);
  assert.match(dashboard, /fallbackText: description/);
  assert.match(reminders, /renderBlocks/);
});

test('private preview URLs are revoked and media reserve intrinsic layout space', () => {
  assert.match(renderer, /export function cleanupRenderedBlocks/);
  assert.match(renderer, /URL\.revokeObjectURL/);
  assert.match(renderer, /MutationObserver/);
  assert.match(css, /aspect-ratio: 16 \/ 9/);
});

test('one document-level observer cleans private media when any rendered ancestor detaches', () => {
  assert.match(renderer, /const documentObservers = new WeakMap\(\)/);
  assert.match(renderer, /container\.ownerDocument\?\.documentElement/);
  assert.match(renderer, /observer\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/);
  assert.match(renderer, /candidate\.container\.isConnected/);
  assert.match(renderer, /record\.states\.add\(state\)/);
  assert.doesNotMatch(renderer, /observer\.observe\(parent/);
});

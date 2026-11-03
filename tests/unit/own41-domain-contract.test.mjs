import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const domainFiles = [
  'api/routes/knowledge.js',
  'api/routes/benefits.js',
  'api/routes/reminders.js',
  'api/academy/authorization.js',
  'api/academy/catalog.js',
  'api/academy/mutations.js',
  'cron/checkReminders.js',
  'public/js/knowledge.js',
  'public/academy/course-view.js',
  'public/academy/lesson-view.js',
  'public/academy/view-utils.js',
];

test('OWN-41: domínios mantidos não têm dependências editoriais ativas', async () => {
  const forbidden = /cms_documents|cms_revisions|cms_assets|\/api\/cms/;
  for (const file of domainFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, forbidden, file);
  }
});

test('OWN-41: Knowledge expõe somente o contrato próprio de texto', async () => {
  const [route, page] = await Promise.all([
    readFile('api/routes/knowledge.js', 'utf8'),
    readFile('public/knowledge.html', 'utf8'),
  ]);
  assert.match(route, /knowledge_base/);
  assert.match(route, /title: text\(200, true\)/);
  assert.match(route, /content: text\(50000\)/);
  assert.doesNotMatch(route, /pdf_asset_id|pdf_title|syncKnowledgePdf/);
  assert.match(page, /texto simples/i);
});

test('OWN-41: cron entrega a descrição própria e não promove revisões', async () => {
  const source = await readFile('cron/checkReminders.js', 'utf8');
  assert.match(source, /reminder\.description/);
  assert.doesNotMatch(source, /promoteDueScheduled|promoteScheduledRevisions/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertNoEditorialAccess, assertOwnDomainAccess, createDependencyHarness,
} from '../helpers/api-dependency-harness.mjs';

const domainFiles = [
  'api/routes/knowledge.js',
  'api/routes/benefits.js',
  'api/routes/reminders.js',
  'api/academy/authorization.js',
  'api/academy/catalog.js',
  'api/academy/mutations.js',
  'cron/checkReminders.js',
  'public/js/knowledge.js',
  'public/js/benefits.js',
  'public/js/reminders.js',
  'public/js/dashboard.js',
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
  assert.match(route, /legacyPdfFields/);
  assert.match(route, /hasLegacyPdfFields\(req\.body\)/);
  assert.doesNotMatch(route, /syncKnowledgePdf/);
  assert.match(page, /texto simples/i);
});

test('OWN-41: cron entrega a descrição própria e não promove revisões', async () => {
  const source = await readFile('cron/checkReminders.js', 'utf8');
  assert.match(source, /reminder\.description/);
  assert.doesNotMatch(source, /promoteDueScheduled|promoteScheduledRevisions/);
});

test('OWN-41: CRUD HTTP real usa Knowledge, Benefits e Reminders sem SQL editorial', async t => {
  const harness = await createDependencyHarness(t, { forbidEditorial: true });
  const auth = { Authorization: 'Bearer manager' };
  const knowledge = await harness.request.post('/api/knowledge').set(auth).send({
    title: 'Texto próprio', category: 'Operação', content: 'Conteúdo simples',
  }).expect(201);
  await harness.request.get('/api/knowledge?limit=20&offset=0').set(auth).expect(200);
  await harness.request.put(`/api/knowledge/${knowledge.body.id}`).set(auth).send({
    title: 'Texto atualizado', category: 'Operação', content: 'Texto seguro',
  }).expect(200);
  const benefit = await harness.request.post('/api/benefits').set(auth).send({
    company: 'Benefício próprio', description: 'Descrição', instructions: 'Instruções',
  }).expect(201);
  await harness.request.get('/api/benefits?limit=20&offset=0').set(auth).expect(200);
  await harness.request.put(`/api/benefits/${benefit.body.id}`).set(auth).send({
    company: 'Benefício atualizado', category: '', description: 'Nova descrição',
    instructions: 'Novas instruções', order: 0, active: true,
  }).expect(200);
  await harness.request.post('/api/reminders').set(auth).send({
    title: 'Lembrete próprio', description: 'Descrição do lembrete', trigger_day: 15,
  }).expect(201);

  assertOwnDomainAccess(harness.state, /knowledge_base/);
  assertOwnDomainAccess(harness.state, /benefits/);
  assertOwnDomainAccess(harness.state, /reminders/);
  assertNoEditorialAccess(harness.state);
});

test('OWN-41: Knowledge rejeita campos PDF antes de SQL e preserva histórico', async t => {
  const harness = await createDependencyHarness(t, { forbidEditorial: true });
  const auth = { Authorization: 'Bearer manager' };
  const historical = structuredClone(harness.state.history);
  const legacyFields = ['pdf_asset_id', 'pdf_title', 'pdf', 'asset_id', 'pdf_state'];

  for (const field of legacyFields) {
    const before = harness.state.sql.length;
    await harness.request.post('/api/knowledge').set(auth).send({
      title: 'Artigo inválido', category: 'Operação', content: 'Texto', [field]: 'legacy',
    }).expect(400);
    const calls = harness.state.sql.slice(before);
    assert.equal(calls.some(({ sql }) => /BEGIN|INSERT INTO|UPDATE |DELETE FROM/.test(sql)), false,
      `${field}: rejected before mutation SQL`);
  }

  const article = await harness.request.post('/api/knowledge').set(auth).send({
    title: 'Artigo histórico', category: 'Operação', content: 'Texto original',
  }).expect(201);
  await harness.request.put(`/api/knowledge/${article.body.id}`).set(auth).send({
    title: 'Artigo atualizado', category: 'Operação', content: 'Texto novo',
  }).expect(200);
  await harness.request.delete(`/api/knowledge/${article.body.id}`).set(auth).expect(200);

  assert.deepEqual(harness.state.history, historical);
  assertNoEditorialAccess(harness.state);
});

test('OWN-41: Knowledge aplica auth, permissão e PDF legado nessa ordem', async t => {
  const unauthenticated = await createDependencyHarness(t, { forbidEditorial: true });
  const unauthenticatedResponse = await unauthenticated.request.post('/api/knowledge').send({
    title: 'Não revelar', pdf_asset_id: 'legacy',
  });
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(unauthenticated.state.sql.some(({ sql }) => /knowledge_base|BEGIN|audit_log/i.test(sql)), false);
  assert.doesNotMatch(JSON.stringify(unauthenticatedResponse.body), /pdf|legacy/i);

  const reader = await createDependencyHarness(t, { forbidEditorial: true });
  const forbiddenResponse = await reader.request.post('/api/knowledge').set('Authorization', 'Bearer reader').send({
    title: 'Não revelar', pdf_asset_id: 'legacy',
  });
  assert.equal(forbiddenResponse.status, 403);
  assert.equal(reader.state.sql.some(({ sql }) => /knowledge_base|BEGIN|audit_log/i.test(sql)), false);
  assert.doesNotMatch(JSON.stringify(forbiddenResponse.body), /pdf|legacy/i);

  const manager = await createDependencyHarness(t, { forbidEditorial: true });
  const articleId = '00000000-0000-4000-8000-000000000001';
  for (const [method, route] of [
    ['post', '/api/knowledge'], ['put', `/api/knowledge/${articleId}`],
  ]) {
    const before = manager.state.sql.length;
    const response = await manager.request[method](route).set('Authorization', 'Bearer manager').send({
      title: 'Inválido', category: 'Operação', content: 'Texto', pdf_asset_id: 'legacy',
    });
    assert.equal(response.status, 400, `${method} must reject legacy PDF fields`);
    const sql = manager.state.sql.slice(before).map(call => call.sql).join('\n');
    assert.doesNotMatch(sql, /knowledge_base|BEGIN|audit_log|INSERT INTO|UPDATE |DELETE FROM/i);
  }
});

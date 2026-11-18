import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { knowledgeDocumentAPI } from '../helpers/knowledge-document-api.mjs';

if (!process.env.KNOWLEDGE_PACKAGE) throw new Error('Set KNOWLEDGE_PACKAGE to the prepared real documents');
const root = resolve(process.env.KNOWLEDGE_PACKAGE);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { importDocuments } = require('./knowledge/import');
const request = require('supertest');
const h = await knowledgeDocumentAPI({ uploadDir: root });
const { articles } = JSON.parse(await readFile(resolve(root, 'import.json'), 'utf8'));
try {
  // Exercise both fresh schema and a pre-043 table, including a retained plain article.
  await h.db.exec(`ALTER TABLE knowledge_base DROP CONSTRAINT knowledge_document_check;
    ALTER TABLE knowledge_base DROP COLUMN document;
    INSERT INTO knowledge_base(id,title) VALUES('550e8400-e29b-41d4-a716-446655440000','Preservado');`);
  const migration = await readFile('api/db/migrations/043_knowledge_documents.sql', 'utf8');
  await h.db.exec(migration); await h.db.exec(migration);
  for (const value of [{}, { kind: 'pdf' }, { kind: 'pdf', key: null }, [],
    { kind: 'ethics', other: true }, { kind: 'pdf', key: '../secret' }]) {
    await assert.rejects(h.db.query('UPDATE knowledge_base SET document=$1::jsonb', [JSON.stringify(value)]), /check constraint/);
  }
  assert.equal((await h.db.query('SELECT document FROM knowledge_base')).rows[0].document, null);
  const options = { pool: h.pool, uploadDir: root, articles, batch: 'knowledge-test' };
  const dry = await importDocuments(options);
  assert.equal(dry.wouldCreate, 9);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM knowledge_base')).rows[0].n, 1);
  assert.equal((await importDocuments({ ...options, apply: true })).created, 9);
  assert.equal((await importDocuments({ ...options, apply: true })).created, 0);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 1);
  const first = articles[0], base = `/api/knowledge/${first.id}/document`;
  for (const suffix of ['', '/cover', '/pages/1']) {
    assert.equal((await request(h.app).get(base + suffix)).status, 401);
    const pending = await request(h.app).get(base + suffix).set('Authorization', 'Bearer pending');
    assert.equal(pending.status, 403);
    assert.equal(pending.body.reason, 'ethics-required');
    const success = await request(h.app).get(base + suffix).set('Authorization', 'Bearer reader');
    assert.equal(success.status, 200);
    assert.equal(success.headers['cache-control'], 'private, no-store');
  }
  for (const suffix of ['/pages/0','/pages/01','/pages/999','/pages/1?file=x']) {
    assert.ok([400,404].includes((await request(h.app).get(base + suffix).set('Authorization','Bearer reader')).status));
  }
  assert.equal((await request(h.app).get(`/uploads/knowledge-private/${first.document.key}/0001.webp`)).status, 404);
  const list = await request(h.app).get('/api/knowledge').set('Authorization','Bearer reader');
  assert.equal(list.body.length, 10);
  assert.equal(JSON.stringify(list.body).includes(first.document.key), false);
  assert.equal((await request(h.app).put(`/api/knowledge/${first.id}`).set('Authorization','Bearer manager')
    .send({ title: first.title, category: first.category, document: { kind: 'ethics' } })).status, 400);
  const edited = await request(h.app).put(`/api/knowledge/${first.id}`).set('Authorization','Bearer manager')
    .send({ title: first.title, category: first.category, content: 'Edição humana' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.document.pageCount, 68);
  await assert.rejects(importDocuments({ ...options, apply: true }), /Article conflict/);
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 2);
  // Failure injection uses the real SQL transaction, never existing databases.
  async function resetBatch() {
    await h.db.query('DELETE FROM knowledge_base WHERE id=ANY($1::uuid[])', [articles.map(a => a.id)]);
    await h.db.query('DELETE FROM audit_log');
  }
  const snapshot = async () => ({
    articles: (await h.db.query('SELECT id,title,document FROM knowledge_base ORDER BY id')).rows,
    audits: (await h.db.query('SELECT action,details FROM audit_log ORDER BY id')).rows,
  });
  await resetBatch();
  const baseline = await snapshot();
  let inserts = 0, released = false;
  const failingPool = {
    query: h.pool.query,
    async connect() {
      return { release() { released = true; }, async query(sql, args) {
        if (/INSERT INTO knowledge_base/.test(sql) && ++inserts === 2) throw new Error('Injected write failure');
        return h.pool.query(sql, args);
      } };
    },
  };
  await assert.rejects(importDocuments({ ...options, pool: failingPool, apply: true }), /Injected write failure/);
  assert.equal(released, true);
  assert.deepEqual(await snapshot(), baseline, 'partial writes and audit must rollback together');
  for (const persisted of [false, true]) {
    await resetBatch();
    let discarded = false, commitCount = 0;
    const uncertainPool = {
      async query(sql, args) {
        assert.equal(discarded, true, 'reconciliation must discard the uncertain connection first');
        return h.pool.query(sql, args);
      },
      async connect() {
        return { release(destroy) { discarded = destroy; }, async query(sql, args) {
          if (sql === 'COMMIT') {
            commitCount += 1;
            await h.pool.query(persisted ? 'COMMIT' : 'ROLLBACK');
            throw new Error('Injected lost COMMIT response');
          }
          return h.pool.query(sql, args);
        } };
      },
    };
    const operation = importDocuments({ ...options, pool: uncertainPool, apply: true });
    if (persisted) {
      assert.equal((await operation).reconciled, true);
      assert.equal((await h.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 1);
      assert.equal((await importDocuments({ ...options, apply: true })).created, 0);
    } else {
      await assert.rejects(operation, error => error.commitAmbiguous === true);
      assert.deepEqual(await snapshot(), baseline);
    }
    assert.equal(commitCount, 1, 'uncertain COMMIT must never replay writes');
  }
  console.log('Knowledge SQL/API: migration twice, strict constraints, preserved article, dry-run, 9 imports, idempotency, authenticated files, ethics gate, private-static denial, edit preservation, conflict refusal, atomic rollback and both lost-COMMIT outcomes PASS.');
} finally { await h.close(); }

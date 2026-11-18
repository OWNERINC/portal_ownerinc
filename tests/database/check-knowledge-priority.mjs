// Real list SQL/API in disposable PostgreSQL-WASM, with synthetic identities.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeDocumentAPI } from '../helpers/knowledge-document-api.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const request = require('supertest');
const temporary = join(tmpdir(), 'opencode');
await mkdir(temporary, { recursive: true });
const uploadDir = await mkdtemp(join(temporary, 'knowledge-priority-'));
let h;
const id = number => `550e8400-e29b-41d4-a716-${String(number).padStart(12, '0')}`;
const ids = numbers => numbers.map(id);
const fixtures = [
  // Insert tied IDs backwards: the database must use the ID, not insertion order.
  [90, 'Código de Ética e Conduta', ' Institucional ', 'Orientações de conduta', { kind: 'ethics' }, '2020-01-01'],
  [30, 'Uniformes novos', 'Uniformes', 'Orientações de uso', null, '2024-03-01'],
  [20, 'Uniformes em PDF', 'Uniformes', 'Orientações de uso', { kind: 'pdf', key: 'a'.repeat(64) }, '2024-02-01'],
  [10, 'Guia institucional', 'Institucional', 'Orientações internas', null, '2024-02-01'],
  [40, 'Código de Ética e Conduta — notas', 'Institucional', 'Notas comuns', null, '2024-01-01'],
];
async function list(query = {}) {
  const response = await request(h.app).get('/api/knowledge').query(query)
    .set('Authorization', 'Bearer reader');
  assert.equal(response.status, 200);
  return response;
}
async function pages(query, expected) {
  const whole = await list(query);
  assert.deepEqual(whole.body.map(article => article.id), ids(expected));
  assert.equal(Number(whole.headers['x-total-count']), expected.length);
  for (const limit of [1, 2]) {
    const seen = [];
    // Include an empty page and require the full filtered count on every page.
    for (let offset = 0; offset <= expected.length + limit; offset += limit) {
      const response = await list({ ...query, limit, offset });
      assert.equal(Number(response.headers['x-total-count']), expected.length);
      assert.deepEqual(response.body.map(article => article.id), ids(expected.slice(offset, offset + limit)));
      seen.push(...response.body.map(article => article.id));
    }
    assert.deepEqual(seen, ids(expected));
    assert.equal(new Set(seen).size, seen.length, 'no duplicate IDs between pages');
  }
}
try {
  h = await knowledgeDocumentAPI({ uploadDir });
  for (const [number, title, category, content, document, updatedAt] of fixtures) {
    await h.db.query(`INSERT INTO knowledge_base(id, title, category, content, document, updated_at)
      VALUES($1, $2, $3, $4, $5::jsonb, $6)`,
    [id(number), title, category, content, document && JSON.stringify(document), updatedAt]);
  }
  const first = await list({ limit: 1 });
  assert.equal(first.body[0].document?.kind, 'ethics', 'old institutional post must precede recent NULL/PDF articles');
  const rest = await list({ limit: 1, offset: 1 });
  assert.notEqual(rest.body[0].document?.kind, 'ethics');
  // Re-execute the actual route SQL to catch priority applied only after retrieval.
  const query = h.state.sql.find(({ sql }) => /SELECT knowledge_base\.\*/.test(sql));
  assert.deepEqual((await h.db.query(query.sql, query.args)).rows.map(article => article.id), ids([90, 30, 10, 20, 40]));
  await pages({}, [90, 30, 10, 20, 40]);
  await pages({ q: 'ORIENTAÇÕES' }, [90, 30, 10, 20]); // content, case-insensitive
  await pages({ q: 'Ética' }, [90, 40]); // matching title does not confer priority
  await pages({ q: 'Uniformes' }, [30, 20]); // ethics does not match
  await pages({ category: 'Institucional' }, [90, 10, 40]); // trimmed stored category
  await pages({ category: 'Uniformes' }, [30, 20]);
  await pages({ category: 'Institucional', q: 'orientações' }, [90, 10]);
  await pages({ category: 'Uniformes', q: 'Ética' }, []);
  await pages({ category: 'Ausente' }, []);
  await pages({ q: 'sem correspondência' }, []);
  const updated = await request(h.app).put(`/api/knowledge/${id(40)}`)
    .set('Authorization', 'Bearer manager')
    .send({ title: 'Notas atualizadas', category: 'Institucional', content: 'Orientações revisadas' });
  assert.equal(updated.status, 200);
  await pages({}, [90, 40, 30, 10, 20]);
  await pages({ category: 'Institucional', q: 'orientações' }, [90, 40, 10]);
  await h.db.query('UPDATE knowledge_base SET title=$2 WHERE id=$1', [id(90), 'Referência institucional']);
  assert.equal((await list({ limit: 1 })).body[0].id, id(90), 'priority follows descriptor, not editable title');
  await h.db.query('DELETE FROM knowledge_base WHERE id=$1', [id(90)]);
  await pages({}, [40, 30, 10, 20]);
  assert.equal((await request(h.app).get('/api/knowledge')).status, 401);
  const pending = await request(h.app).get('/api/knowledge').set('Authorization', 'Bearer pending');
  assert.equal(pending.status, 403);
  assert.equal(pending.body.reason, 'ethics-required');
  console.log('Knowledge priority SQL/API: old ethics first; NULL/PDF date and ID order; title/content/category filters; counts; unique paginated IDs; recent edit; descriptor identity; absent ethics; auth/acceptance gate PASS.');
} finally {
  await h?.close();
  await rm(uploadDir, { recursive: true, force: true });
}

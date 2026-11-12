import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { mutate } = require('../../api/pages/store');
const { createTemplate } = require('../../api/pages/templates');

function fixture() {
  const pageId = randomUUID(), draftId = randomUUID(), cargoId = randomUUID();
  const document = createTemplate(); document.metadata.audience.job_title_ids = [cargoId];
  let data = { page: { id: pageId, author_uid: 'author', version: 0, draft_revision_id: draftId, published_revision_id: null, archived_at: null },
    revisions: { [draftId]: document }, requests: {}, audit: [], associations: [], active: true, media: [] };
  let before, failCommit = false, failAudit = false;
  const queries = [];
  const client = {
    async query(sql, values = []) {
      const q = sql.replace(/\s+/g,' ').trim(); queries.push({ q, values });
      if (q === 'BEGIN') { before = structuredClone(data); return { rows: [] }; }
      if (q === 'COMMIT') { if (failCommit) { failCommit = false; throw new Error('commit acknowledgement lost'); } before = null; return { rows: [] }; }
      if (q === 'ROLLBACK') { if (before) data = before; before = null; return { rows: [] }; }
      if (q.startsWith('SELECT pg_advisory')) return { rows: [] };
      if (q.startsWith('SELECT * FROM page_requests')) return { rows: data.requests[`${values[0]}:${values[1]}`] ? [data.requests[`${values[0]}:${values[1]}`]] : [] };
      if (q.startsWith('SELECT * FROM pages')) return { rows: values[0] === pageId ? [structuredClone(data.page)] : [] };
      if (q.startsWith('SELECT id, active FROM job_titles')) return { rows: values[0].includes(cargoId) ? [{ id: cargoId, active: data.active }] : [] };
      if (q.startsWith('SELECT id,kind,duration_ms FROM page_media')) return { rows: data.media.filter(id => values[1].includes(id)).map(id => ({ id, kind: 'image', duration_ms: null })) };
      if (q.startsWith('INSERT INTO page_revisions')) { data.revisions[values[0]] = JSON.parse(values[3]); return { rows: [] }; }
      if (q.startsWith('INSERT INTO page_revision_job_titles') || q.startsWith('INSERT INTO page_revision_media')) { data.associations.push(values); return { rows: [] }; }
      if (q.startsWith('UPDATE pages SET draft_revision_id')) { data.page.draft_revision_id = values[1]; data.page.version++; return { rows: [structuredClone(data.page)] }; }
      if (q.startsWith('SELECT document FROM page_revisions')) return { rows: [{ document: data.revisions[values[1]] }] };
      if (q.startsWith('UPDATE pages SET published_revision_id')) { data.page.published_revision_id = values[1]; data.page.version++; return { rows: [structuredClone(data.page)] }; }
      if (q.startsWith('UPDATE pages SET archived_at')) { data.page.archived_at = q.includes('archived_at = now()') ? 'date' : null; data.page.published_revision_id = null; data.page.version++; return { rows: [structuredClone(data.page)] }; }
      if (q.startsWith('INSERT INTO audit_log')) { if (failAudit) throw new Error('audit failed'); data.audit.push(values); return { rows: [] }; }
      if (q.startsWith('INSERT INTO page_requests')) { data.requests[`${values[0]}:${values[1]}`] = { operation: values[2], target_id: values[3], request_hash: values[4], response: JSON.parse(values[5]), status: values[6] }; return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${q}`);
    }, release() {},
  };
  const author = { uid: 'author', role: 'admin', permissions: { editPages: true, publishPages: true } };
  return { pool: { connect: async () => client }, req: { user: author, id: 'request-test' }, pageId, cargoId, document, queries,
    get data() { return data; }, failCommit() { failCommit = true; }, failAudit() { failAudit = true; } };
}

test('draft snapshot, relational projection, CAS, audit and idempotent ack use the same transaction; replay skips audit and CAS', async () => {
  const f = fixture(), body = { expected_version: 0, client_mutation_id: randomUUID(), document: f.document };
  const saved = await mutate(f.pool, f.req, 'draft', f.pageId, body);
  assert.equal(saved.ack.version, 1); assert.equal(f.data.audit.length, 1);
  assert.equal(f.data.page.published_revision_id, null);
  assert.deepEqual(f.data.revisions[saved.ack.draft_revision_id], f.document);
  assert.deepEqual(f.data.associations, [[saved.ack.draft_revision_id, f.cargoId]]);
  assert.equal(f.queries[0].q, 'BEGIN'); assert.match(f.queries.find(q => q.q.startsWith('SELECT * FROM pages')).q, /FOR UPDATE$/);
  assert.equal(f.queries.at(-1).q, 'COMMIT');
  const replay = await mutate(f.pool, f.req, 'draft', f.pageId, body);
  assert.equal(replay.replay, true); assert.deepEqual(replay.ack, saved.ack); assert.equal(f.data.audit.length, 1);
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, { ...body, expected_version: 1 }), { reason: 'mutation_conflict' });
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, { ...body, client_mutation_id: randomUUID() }), { reason: 'version_conflict' });
  assert.equal(f.data.audit.length, 1);
});

test('replay is reauthorized, including author-only superadmin and revoked edit capability', async () => {
  const f = fixture(), body = { expected_version: 0, client_mutation_id: randomUUID(), document: f.document };
  await mutate(f.pool, f.req, 'draft', f.pageId, body);
  f.data.page.author_uid = 'different'; f.req.user.permissions = { superAdmin: true };
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, body), { reason: 'author_only' });
  f.req.user.permissions = {};
  const before = f.queries.length;
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, body), { reason: 'permission_denied' });
  assert.equal(f.queries.length, before);
});

test('publish points to current saved revision; later drafts cannot mutate the published document; archive/restore never republish', async () => {
  const f = fixture(), first = f.data.page.draft_revision_id;
  await mutate(f.pool, f.req, 'publish', f.pageId, { expected_version: 0, client_mutation_id: randomUUID(), revision_id: first });
  assert.equal(f.data.page.published_revision_id, first);
  const changed = structuredClone(f.document); changed.metadata.title = 'New draft';
  const draft = await mutate(f.pool, f.req, 'draft', f.pageId, { expected_version: 1, client_mutation_id: randomUUID(), document: changed });
  assert.equal(f.data.revisions[first].metadata.title, f.document.metadata.title); assert.equal(f.data.page.published_revision_id, first);
  await assert.rejects(mutate(f.pool, f.req, 'publish', f.pageId, { expected_version: 2, client_mutation_id: randomUUID(), revision_id: first }), { reason: 'version_conflict' });
  f.data.active = false;
  await assert.rejects(mutate(f.pool, f.req, 'publish', f.pageId, { expected_version: 2, client_mutation_id: randomUUID(), revision_id: draft.ack.draft_revision_id }), { reason: 'invalid_audience' });
  const archive = await mutate(f.pool, f.req, 'archive', f.pageId, { expected_version: 2, client_mutation_id: randomUUID() });
  assert.equal(archive.ack.published_revision_id, null);
  const restore = await mutate(f.pool, f.req, 'restore', f.pageId, { expected_version: 3, client_mutation_id: randomUUID() });
  assert.equal(restore.ack.published_revision_id, null); assert.equal(f.data.page.archived_at, null);
});

test('audit failure rolls back the revision, associations, head and request; COMMIT errors are explicitly ambiguous', async () => {
  const f = fixture(), body = { expected_version: 0, client_mutation_id: randomUUID(), document: f.document };
  const original = structuredClone(f.data); f.failAudit();
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, body), error => error.commitAmbiguous === false);
  assert.deepEqual(f.data, original);
  const g = fixture(); g.failCommit();
  await assert.rejects(mutate(g.pool, g.req, 'draft', g.pageId, { ...body, document: g.document }), error => error.commitAmbiguous === true);
});

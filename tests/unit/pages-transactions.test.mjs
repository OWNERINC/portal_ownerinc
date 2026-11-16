import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { upgradeDocument } from '../../public/pages/document-v3.js';
import { featureDocument } from '../helpers/pages-reference-document.mjs';
const require = createRequire(import.meta.url);
const { mutate } = require('../../api/pages/store');
const { createTemplate } = require('../../api/pages/templates');

function fixture() {
  const pageId = randomUUID(), draftId = randomUUID(), cargoId = randomUUID();
  const document = createTemplate(); document.metadata.audience.job_title_ids = [cargoId];
  let data = { page: { id: pageId, author_uid: 'author', version: 0, draft_revision_id: draftId, published_revision_id: null, archived_at: null },
    revisions: { [draftId]: document }, requests: {}, audit: [], associations: [], active: true, media: [] };
  let before, failCommit = false, failAudit = false, uniqueConstraint = null;
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
      if (q.startsWith('SELECT slug FROM pages')) return { rows: data.page.slug && values[0].includes(data.page.slug) ? [{ slug: data.page.slug }] : [] };
      if (q.startsWith('UPDATE pages SET slug')) {
        if (uniqueConstraint) throw Object.assign(new Error('synthetic unique violation'), { code: '23505', constraint: uniqueConstraint });
        data.page.slug = values[1]; return { rows: [] };
      }
      if (q.startsWith('SELECT id, active FROM job_titles')) return { rows: values[0].includes(cargoId) ? [{ id: cargoId, active: data.active }] : [] };
      if (q.startsWith('SELECT id,kind,duration_ms FROM page_media')) return { rows: data.media.filter(item => item.page_id === values[0] && values[1].includes(item.id)) };
      if (q.startsWith('INSERT INTO page_revisions')) { data.revisions[values[0]] = JSON.parse(values[3]); return { rows: [] }; }
      if (q.startsWith('INSERT INTO page_revision_job_titles') || q.startsWith('INSERT INTO page_revision_media')) { data.associations.push(values); return { rows: [] }; }
      if (q.startsWith('UPDATE pages SET draft_revision_id')) { data.page.draft_revision_id = values[1]; data.page.version++; return { rows: [structuredClone(data.page)] }; }
      if (q.startsWith('SELECT document FROM page_revisions')) return { rows: [{ document: data.revisions[values[1]] }] };
      if (q.startsWith('SELECT schema_version FROM page_revisions')) return { rows: [{ schema_version: data.revisions[values[1]].schema_version }] };
      if (q.startsWith('UPDATE pages SET published_revision_id')) { data.page.published_revision_id = values[1]; data.page.version++; return { rows: [structuredClone(data.page)] }; }
      if (q.startsWith('UPDATE pages SET archived_at')) { data.page.archived_at = q.includes('archived_at = now()') ? 'date' : null; data.page.published_revision_id = null; data.page.version++; return { rows: [structuredClone(data.page)] }; }
      if (q.startsWith('INSERT INTO audit_log')) { if (failAudit) throw new Error('audit failed'); data.audit.push(values); return { rows: [] }; }
      if (q.startsWith('INSERT INTO page_requests')) { data.requests[`${values[0]}:${values[1]}`] = { operation: values[2], target_id: values[3], request_hash: values[4], response: JSON.parse(values[5]), status: values[6] }; return { rows: [] }; }
      throw new Error(`Unexpected SQL: ${q}`);
    }, release() {},
  };
  const author = { uid: 'author', role: 'admin', permissions: { editPages: true, publishPages: true } };
  return { pool: { connect: async () => client }, req: { user: author, id: 'request-test' }, pageId, cargoId, document, queries,
    get data() { return data; }, failCommit() { failCommit = true; }, failAudit() { failAudit = true; }, failUnique(constraint) { uniqueConstraint = constraint; } };
}

test('v3 replay is authorized before a disabled writer gate and creates one revision/projection/audit only', async () => {
  const f = fixture(), document = upgradeDocument(f.document), before = f.data.audit.length;
  const body = { expected_version: 0, client_mutation_id: randomUUID(), document };
  const first = await mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: true });
  const replay = await mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: false });
  assert.deepEqual(first.ack, replay.ack);
  assert.equal(f.data.audit.length, before + 1);
  assert.equal(Object.keys(f.data.revisions).length, 2);
  assert.deepEqual(f.data.associations, [[first.ack.draft_revision_id, f.cargoId]]);
  f.req.user.permissions = {};
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: false }), { reason: 'permission_denied' });
});

test('v3 new writes default disabled, strict boolean only; a v3 head cannot be downgraded', async () => {
  const f = fixture(), body = { expected_version: 0, client_mutation_id: randomUUID(), document: upgradeDocument(f.document) };
  const before = structuredClone(f.data);
  for (const options of [undefined, { v3WritesEnabled: false }, { v3WritesEnabled: 'true' }]) {
    await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, body, null, options), { status: 409, reason: 'document_version_disabled' });
    assert.deepEqual(f.data, before);
  }
  await mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: true });
  const head = structuredClone(f.data);
  for (const v3WritesEnabled of [true, false]) {
    await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, { ...body, expected_version: 1, client_mutation_id: randomUUID(), document: f.document }, null, { v3WritesEnabled }), { status: 409, reason: 'schema_downgrade_conflict' });
    assert.deepEqual(f.data, head);
  }
  // Publishing saved v3 is reader-compatible even with the writer disabled.
  const published = await mutate(f.pool, f.req, 'publish', f.pageId, { expected_version: 1, client_mutation_id: randomUUID(), revision_id: f.data.page.draft_revision_id });
  assert.equal(published.ack.published_revision_id, head.page.draft_revision_id);
});

test('v3 image/gallery/download typed uses deduplicate media IDs but reject a conflicting kind and cross-page use', async () => {
  const f = fixture(), document = featureDocument(); document.metadata.audience.job_title_ids = [f.cargoId];
  const blocks = document.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
  const image = blocks.find(block => block.type === 'image'), button = blocks.find(block => block.type === 'button');
  button.action = { type: 'download', media_id: image.media_id, kind: 'image', file_name: 'guia.webp' };
  f.data.media.push({ id: image.media_id, page_id: f.pageId, kind: 'image', duration_ms: null });
  const body = { expected_version: 0, client_mutation_id: randomUUID(), document };
  const saved = await mutate(f.pool, f.req, 'draft', f.pageId, body, null, { v3WritesEnabled: true });
  assert.deepEqual(f.data.associations, [[saved.ack.draft_revision_id, f.cargoId], [f.pageId, saved.ack.draft_revision_id, image.media_id]]);
  const snapshot = structuredClone(f.data);
  button.action.kind = 'audio'; button.action.file_name = 'guia.mp3';
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, { ...body, expected_version: 1, client_mutation_id: randomUUID() }, null, { v3WritesEnabled: true }), { reason: 'media_not_ready' });
  assert.deepEqual(f.data, snapshot);
  button.action.kind = 'image'; button.action.file_name = 'guia.webp';
  f.data.media[0].page_id = randomUUID();
  const foreignSnapshot = structuredClone(f.data);
  await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, { ...body, expected_version: 1, client_mutation_id: randomUUID() }, null, { v3WritesEnabled: true }), { reason: 'media_not_ready' });
  assert.deepEqual(f.data, foreignSnapshot);
});

test('draft snapshot, relational projection, CAS, audit and idempotent ack use the same transaction; replay skips audit and CAS', async () => {
  const f = fixture(), body = { expected_version: 0, client_mutation_id: randomUUID(), document: f.document };
  const saved = await mutate(f.pool, f.req, 'draft', f.pageId, body);
  assert.equal(saved.ack.version, 1); assert.equal(f.data.audit.length, 1);
  assert.equal(f.data.page.published_revision_id, null);
  assert.deepEqual(f.data.revisions[saved.ack.draft_revision_id], f.document);
  assert.deepEqual(f.data.associations, [[saved.ack.draft_revision_id, f.cargoId]]);
  assert.equal(f.queries[0].q, 'BEGIN'); assert.match(f.queries.find(q => q.q.startsWith('SELECT * FROM pages')).q, /FOR UPDATE$/);
  const requestLock = f.queries.findIndex(query => query.values[0] === `pages:author:${body.client_mutation_id}`);
  const pageLock = f.queries.findIndex(query => query.q === 'SELECT * FROM pages WHERE id = $1 FOR UPDATE');
  const aliasLock = f.queries.findIndex(query => query.values[0] === 'pages-alias:exemplo-de-comunicado-vestimenta-no-trabalho');
  assert.ok(requestLock > 0 && pageLock > requestLock && aliasLock > pageLock);
  assert.equal(saved.ack.slug, f.data.page.slug);
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

test('only slug unique violations become explicit conflicts after full rollback, never blind retry', async () => {
  for (const constraint of ['pages_slug_unique_idx', 'some_other_unique_idx']) {
    const f = fixture(), original = structuredClone(f.data);
    f.failUnique(constraint);
    await assert.rejects(mutate(f.pool, f.req, 'draft', f.pageId, { expected_version: 0, client_mutation_id: randomUUID(), document: f.document }), error => {
      assert.equal(error.commitAmbiguous, false);
      if (constraint === 'pages_slug_unique_idx') { assert.equal(error.status, 409); assert.equal(error.reason, 'slug_conflict'); }
      else { assert.equal(error.code, '23505'); assert.equal(error.constraint, constraint); }
      return true;
    });
    assert.deepEqual(f.data, original);
    assert.equal(f.queries.filter(query => query.q.startsWith('UPDATE pages SET slug')).length, 1);
    assert.equal(f.queries.at(-1).q, 'ROLLBACK');
    assert.equal(f.queries.some(query => query.q === 'COMMIT'), false);
  }
});

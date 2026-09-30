import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { cmsApp } from '../tests/helpers/cms-app.mjs';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
if (process.env.NODE_ENV === 'production') throw new Error('Owner News integration cannot run with NODE_ENV=production');
if (process.env.MIGRATION_TEST_DISPOSABLE !== 'true') throw new Error('MIGRATION_TEST_DISPOSABLE=true is required');
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const { Pool } = require('pg');
const { migrate } = require('../api/db/migrate');
const { getPublishedAnnouncement, listPublishedAnnouncements, promoteDueScheduledForPool } = require('../api/cms/reader');
const { lockCmsAssets } = require('../api/cms/locks');
const { canManageCms } = require('../api/cms/permissions');
const supertest = require('supertest');
await migrate();
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
const documentIds = [];
const assetIds = [];
const uid = `owner-news-fixture-${randomUUID()}`;
const oldEditorial = { version: 1, kind: 'article', summary: 'Publicada', author: 'Autora A', source_label: '', source_date: null };
const newEditorial = { ...oldEditorial, summary: 'Rascunho', author: 'Autora B' };
const blocks = [{ type: 'paragraph', text: 'Texto de trabalho.' }];
const request = supertest(cmsApp(pool, { uid, role: 'admin', permissions: { manageKnowledge: true } }));
async function documentFixture() {
  const { rows } = await client.query("INSERT INTO cms_documents (content_type, title) VALUES ('announcement', 'Fixture sintética E2') RETURNING id");
  documentIds.push(rows[0].id);
  return rows[0].id;
}
async function revision(documentId, version, status, editorial, content = blocks) {
  const { rows } = await client.query(`INSERT INTO cms_revisions
    (document_id, version, status, blocks, editorial) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [documentId, version, status, JSON.stringify(content), editorial === null ? null : JSON.stringify(editorial)]);
  return rows[0].id;
}
try {
  await client.query('INSERT INTO users (uid, email, name) VALUES ($1, $2, $3)', [uid, `${uid}@example.com`, 'Fixture sintética E2']);
  const documentId = await documentFixture();
  const publishedId = await revision(documentId, 1, 'published', oldEditorial, [{ type: 'paragraph', text: 'Texto publicado.' }]);
  await client.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [documentId, publishedId]);
  const draftId = await revision(documentId, 2, 'draft', newEditorial);
  await client.query('UPDATE cms_documents SET draft_revision_id=$2 WHERE id=$1', [documentId, draftId]);
  const visible = await client.query(`SELECT r.editorial FROM cms_documents d
    JOIN cms_revisions r ON r.id=d.published_revision_id WHERE d.id=$1`, [documentId]);
  assert.equal(visible.rows[0].editorial.author, 'Autora A');
  assert.equal((await getPublishedAnnouncement(pool, documentId)).editorial.author, 'Autora A');
  const url = `/api/cms/documents/${documentId}`;
  await request.post(`${url}/publish`).send({}).expect(200);
  const updated = await getPublishedAnnouncement(pool, documentId);
  assert.equal(updated.editorial.author, 'Autora B');
  assert.deepEqual(updated.content_blocks, blocks);
  console.log('owner-news integration: published body/editorial isolation and atomic route publication ok');

  const created = await request.post('/api/cms/documents').send({ type: 'announcement', title: 'Fixture inicial E2' }).expect(201);
  documentIds.push(created.body.document.id);
  assert.deepEqual(created.body.revision.editorial, { ...oldEditorial, summary: '', author: '' });
  await request.put(`/api/cms/documents/${created.body.document.id}/draft`).send({ blocks, editorial: null }).expect(400);
  for (const explicit of [false, true]) {
    const legacyId = await documentFixture();
    const legacyRevision = await revision(legacyId, 1, 'published', null);
    await client.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [legacyId, legacyRevision]);
    const body = explicit ? { blocks, editorial: null } : { blocks };
    const saved = await request.put(`/api/cms/documents/${legacyId}/draft`).send(body).expect(200);
    assert.equal(saved.body.revision.editorial, null);
    assert.equal((await client.query('SELECT editorial IS NULL AS legacy FROM cms_revisions WHERE id=$1', [saved.body.revision.id])).rows[0].legacy, true);
  }
  await assert.rejects(revision(documentId, 99, 'draft', 'null'), /cms_revisions_editorial_object_check/);
  await assert.rejects(client.query(`INSERT INTO cms_revisions (document_id, version, status, blocks, editorial)
    VALUES ($1, 99, 'draft', '[]', 'null'::jsonb)`, [documentId]), /cms_revisions_editorial_object_check/);
  console.log('owner-news integration: native initialization, explicit-null rejection and legacy SQL NULL ok');

  const scheduled = await request.put(`${url}/draft`).send({ blocks, editorial: { ...newEditorial, author: 'Agendada' } }).expect(200);
  await request.post(`${url}/schedule`).send({ scheduled_at: new Date(Date.now() + 60000).toISOString() }).expect(200);
  const later = await request.put(`${url}/draft`).send({ blocks }).expect(200);
  assert.equal(later.body.revision.editorial.author, 'Agendada');
  const canceled = await request.delete(`${url}/schedule`).expect(200);
  assert.equal(canceled.body.draft.id, later.body.revision.id);
  assert.equal(canceled.body.draft.editorial.author, 'Agendada');
  assert.equal((await client.query('SELECT status FROM cms_revisions WHERE id=$1', [scheduled.body.revision.id])).rows[0].status, 'archived');
  await request.post(`${url}/schedule`).send({ scheduled_at: new Date(Date.now() + 60000).toISOString() }).expect(200);
  const newest = await request.put(`${url}/draft`).send({ blocks, editorial: { ...newEditorial, author: 'Posterior' } }).expect(200);
  await client.query("UPDATE cms_documents SET scheduled_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [documentId]);
  assert.equal(await promoteDueScheduledForPool(pool), 1);
  assert.equal((await getPublishedAnnouncement(pool, documentId)).editorial.author, 'Agendada');
  assert.equal((await client.query('SELECT draft_revision_id FROM cms_documents WHERE id=$1', [documentId])).rows[0].draft_revision_id, newest.body.revision.id);
  // Corrupt synthetic stored metadata to exercise promotion's defensive validation.
  const invalidId = await revision(documentId, 100, 'scheduled', { ...oldEditorial, summary: '' });
  await client.query("UPDATE cms_documents SET scheduled_revision_id=$2, scheduled_at=NOW()-INTERVAL '1 minute' WHERE id=$1", [documentId, invalidId]);
  assert.equal(await promoteDueScheduledForPool(pool), 0);
  assert.equal((await client.query('SELECT status FROM cms_revisions WHERE id=$1', [invalidId])).rows[0].status, 'archived');
  assert.equal((await getPublishedAnnouncement(pool, documentId)).editorial.author, 'Agendada');
  assert.equal((await client.query('SELECT draft_revision_id FROM cms_documents WHERE id=$1', [documentId])).rows[0].draft_revision_id, newest.body.revision.id);
  console.log('owner-news integration: schedule/cancel/promotion preserve later draft; invalid schedule archived ok');

  const assetSource = await readFile(new URL('../api/routes/cms-assets.js', import.meta.url), 'utf8');
  const helpers = new Function('canManageCms', 'lockCmsAssets', `
    ${assetSource.slice(assetSource.indexOf('const ASSET_MIMES'), assetSource.indexOf('const upload ='))}
    ${assetSource.slice(assetSource.indexOf('function audienceFor'), assetSource.indexOf('function isMalformedMultipart'))}
    ${assetSource.slice(assetSource.indexOf('async function canReadAsset'), assetSource.indexOf('function uploadMiddleware'))}
    ${assetSource.slice(assetSource.indexOf('async function reserveUnreferencedAsset'), assetSource.indexOf('function reservationIsActive'))}
    return { canReadAsset, reserveUnreferencedAsset };`)(canManageCms, lockCmsAssets);
  for (const mime of ['application/pdf', 'image/png']) {
    const { rows: [asset] } = await client.query("INSERT INTO cms_assets (original_name, mime_type, byte_size) VALUES ('Fixture E2', $1, 1) RETURNING id, mime_type", [mime]);
    assetIds.push(asset.id);
    const profile = [{ type: 'profile', name: 'Pessoa sintética', text: 'Biografia sintética.', asset_id: asset.id, alt: 'Retrato sintético' }];
    const saved = await request.put(`${url}/draft`).send({ blocks: profile, editorial: oldEditorial });
    assert.equal(saved.status, mime === 'image/png' ? 200 : 400);
    if (mime !== 'image/png') continue;
    assert.equal(await helpers.canReadAsset(client, { uid: 'employee', permissions: {} }, asset), false);
    await request.post(`${url}/publish`).send({}).expect(200);
    assert.equal(await helpers.canReadAsset(client, { uid: 'employee', permissions: {} }, asset), true);
    assert.equal((await getPublishedAnnouncement(pool, documentId)).content_blocks[0].asset_id, asset.id);
    await client.query('BEGIN');
    try {
      assert.deepEqual(await helpers.reserveUnreferencedAsset(client, asset.id), { referenced: true, cleared: false });
    } finally { await client.query('ROLLBACK'); }
  }
  const history = await request.get(`${url}/revisions`).expect(200);
  assert.ok(history.body.every(row => Object.hasOwn(row, 'editorial')));
  const view = await request.get(url).expect(200);
  assert.equal(view.body.published.editorial.author, 'Autora A');
  await client.query('UPDATE cms_revisions SET editorial=$2 WHERE id=$1', [view.body.published.id, JSON.stringify({ version: 99 })]);
  assert.equal(await getPublishedAnnouncement(pool, documentId), null);
  assert.equal((await listPublishedAnnouncements(pool, 100, 0)).rows.some(row => row.id === documentId), false);
  console.log('owner-news integration: profile MIME, collaborator access, flat-reference retention and invalid-publication filtering ok');
  for (const sql of [
    'INSERT INTO owner_news_home(singleton) VALUES (FALSE)',
    'UPDATE owner_news_home SET version=0',
    "UPDATE owner_news_home SET draft='[]'::jsonb",
    "UPDATE owner_news_home SET published='null'::jsonb",
  ]) await assert.rejects(client.query(sql), error => error.code === '23514');
  console.log('owner-news integration: home singleton/version/object constraints ok');
  console.log('owner-news integration: ok');
} finally {
  try {
    await client.query('ROLLBACK');
    await client.query('DELETE FROM audit_log WHERE actor_uid=$1 OR target_id=ANY($2::text[])', [uid, documentIds]);
    await client.query('DELETE FROM cms_documents WHERE id=ANY($1::uuid[])', [documentIds]);
    await client.query('DELETE FROM cms_assets WHERE id=ANY($1::uuid[])', [assetIds]);
    await client.query('DELETE FROM users WHERE uid=$1', [uid]);
    assert.equal((await client.query('SELECT COUNT(*)::integer AS count FROM cms_revisions WHERE document_id=ANY($1::uuid[])', [documentIds])).rows[0].count, 0);
    console.log('owner-news integration: synthetic fixtures cleaned');
  } finally {
    client.release();
    await pool.end();
  }
}

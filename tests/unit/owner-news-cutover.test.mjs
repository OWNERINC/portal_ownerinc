import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cmsApp } from '../helpers/cms-app.mjs';
import { ownerNewsApp } from '../helpers/owner-news-app.mjs';
import { parseCutoverArguments, runCutover } from '../../scripts/owner-news-payload/cutover.mjs';
import { persist } from '../../scripts/import-owner-news.mjs';
import { applyBundle } from '../../scripts/lib/owner-news-bundle-import.mjs';
import { prepareBundle } from '../../scripts/lib/owner-news-bundle.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { writerAllowed, assertNewsWriter, validAuthorityTransition, transitionAuthority } = require('./owner-news/authority');
const { promoteDueScheduled, listPublishedAnnouncements } = require('./cms/reader');
const { saveHomeDraft, publishHome } = require('./owner-news/home');
const supertest = require('supertest');
const id = '11111111-1111-4111-8111-111111111111';
const revision = '22222222-2222-4222-8222-222222222222';

// Real asset policy/retention exports with only I/O/auth imports substituted.
const Module = require('node:module');
const assetPath = require.resolve('./routes/cms-assets');
const assetModule = new Module(assetPath);
const assetRequire = createRequire(assetPath);
assetModule.require = name => name === '../db' ? {} : name === '../middleware/auth'
  ? { authMiddleware(req, res, next) { next(); } } : assetRequire(name);
assetModule._compile(readFileSync(assetPath, 'utf8'), assetPath);
const { canReadAsset, deleteUnreferencedAsset } = assetModule.exports;

function database(mode = 'frozen', extra = () => undefined) {
  const calls = [];
  const db = {
    calls, mode, epoch: 7,
    async query(sql, values = []) {
      calls.push({ sql, values });
      const result = await extra(sql, values, db);
      if (result) return result;
      if (sql.includes('SELECT mode, epoch')) return { rows: [{ mode: db.mode, epoch: db.epoch }] };
      if (sql.includes('UPDATE owner_news_authority')) {
        if (values[2] !== db.mode || values[3] !== db.epoch) return { rows: [] };
        db.mode = values[0]; db.epoch++;
        return { rows: [{ mode: db.mode, epoch: db.epoch }] };
      }
      return { rows: [] };
    }, release() {}, async connect() { return db; }, async end() {},
  };
  return db;
}

test('closed structural graph; rollback boolean is not authorization', async () => {
  const modes = ['legacy', 'frozen', 'payload', 'payload_frozen', 'unknown'];
  const edges = new Set(['legacy:frozen', 'frozen:legacy', 'frozen:payload', 'payload:payload_frozen', 'payload_frozen:payload']);
  for (const from of modes) for (const to of modes) assert.equal(validAuthorityTransition(from, to), edges.has(`${from}:${to}`));
  assert.equal(validAuthorityTransition('payload_frozen', 'legacy', false), true);
  for (const [from, to] of [['frozen', 'payload'], ['payload_frozen', 'legacy']]) {
    const db = database(from);
    await assert.rejects(transitionAuthority(db, { from, to, expectedEpoch: 7, actorUid: 'editor',
      hasChanges: false, manifestSha256: 'a'.repeat(64), proof: { noEdits: true, reconciled: true } }),
    { code: 'news_cutover_proof_required' });
    assert.equal(db.calls.length, 0);
  }
});

test('CAS serializes advisory -> authority -> conditional UPDATE -> audit, never commits caller tx', async () => {
  const db = database('legacy');
  assert.deepEqual(await transitionAuthority(db, { from: 'legacy', to: 'frozen', expectedEpoch: 7, actorUid: 'editor', requestId: 'request' }), { mode: 'frozen', epoch: 8 });
  assert.match(db.calls[0].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(db.calls[0].values, [7193029]);
  assert.match(db.calls[1].sql, /FOR UPDATE$/);
  assert.match(db.calls[2].sql, /mode=\$3 AND epoch=\$4/);
  assert.match(db.calls[3].sql, /INSERT INTO audit_log/);
  assert.equal(db.calls.some(({ sql }) => /^(BEGIN|COMMIT)/.test(sql)), false);
  await assert.rejects(transitionAuthority(db, { from: 'legacy', to: 'frozen', expectedEpoch: 7, actorUid: 'editor' }), { code: 'news_authority_conflict' });
  assert.equal(db.epoch, 8);
});

test('non-cutover CAS edges preserve monotonic epoch; stale resume and unknown transitions fail', async () => {
  for (const [from, to] of [['legacy', 'frozen'], ['frozen', 'legacy'], ['payload', 'payload_frozen'], ['payload_frozen', 'payload']]) {
    const db = database(from);
    assert.deepEqual(await transitionAuthority(db, { from, to, expectedEpoch: 7, actorUid: 'editor' }), { mode: to, epoch: 8 });
    await assert.rejects(transitionAuthority(db, { from, to, expectedEpoch: 7, actorUid: 'editor' }), { code: 'news_authority_conflict' });
  }
  for (const expectedEpoch of [0, '7', 2147483647, NaN]) {
    const db = database('legacy');
    await assert.rejects(transitionAuthority(db, { from: 'legacy', to: 'frozen', expectedEpoch, actorUid: 'editor' }), { code: 'invalid_authority_transition' });
    assert.equal(db.calls.length, 0);
  }
});

test('write admitted before freeze but waiting for lock rechecks current mode', async () => {
  let release;
  const lock = new Promise(resolve => { release = resolve; });
  const db = database('legacy', async sql => {
    if (sql.includes('pg_advisory_xact_lock')) await lock;
  });
  const pending = assertNewsWriter(db, 'legacy');
  db.mode = 'frozen'; release();
  await assert.rejects(pending, { code: 'news_read_only' });
});

for (const mode of ['frozen', 'payload', 'payload_frozen']) {
  test(`${mode}: all explicit legacy document write routes deny before row locks/writes`, async () => {
    const routes = [
      ['post', '/documents', { type: 'announcement', title: 'Synthetic' }],
      ['put', `/documents/${id}/draft`, { blocks: [] }],
      ['post', `/documents/${id}/publish`, {}],
      ['post', `/documents/${id}/schedule`, { scheduled_at: '2099-01-01T00:00:00.000Z' }],
      ['post', `/documents/${id}/unpublish`, {}],
      ['delete', `/documents/${id}/schedule`, {}],
      ['delete', `/revisions/${revision}`, {}],
    ];
    for (const [method, route, body] of routes) {
      const db = database(mode, sql => {
        if (sql.includes('FROM cms_documents') || sql.includes('FROM cms_revisions r')) {
          assert.doesNotMatch(sql, /FOR UPDATE/);
          return { rows: [{ id, document_id: id, content_type: 'announcement', status: 'draft' }] };
        }
      });
      const response = await supertest(cmsApp(db))[method](`/api/cms${route}`).send(body);
      assert.equal(response.status, 409, `${method} ${route}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.reason, 'news_read_only');
      assert.equal(db.calls.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
      assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
    }
  });

  test(`${mode}: home helpers fence writes under same legacy lock`, async () => {
    for (const write of [db => saveHomeDraft(db, { expected_version: 1, content: { version: 1, eyebrow: 'a', headline: 'b', summary: 'c' } }, 'editor'),
      db => publishHome(db, 1, 'editor')]) {
      const db = database(mode);
      await assert.rejects(write(db), { code: 'news_read_only' });
      assert.match(db.calls[0].sql, /pg_advisory_xact_lock/);
      assert.equal(db.calls.some(({ sql }) => sql.includes('owner_news_home')), false);
    }
  });

  test(`${mode}: home HTTP exposes controlled409, not an internal error`, async () => {
    const db = database(mode);
    const api = supertest(ownerNewsApp(db));
    const draft = await api.put('/api/cms/owner-news/home/draft').set('Authorization', 'Bearer admin')
      .send({ expected_version: 1, content: { version: 1, eyebrow: 'a', headline: 'b', summary: 'c' } }).expect(409);
    const publication = await api.post('/api/cms/owner-news/home/publish').set('Authorization', 'Bearer admin')
      .send({ expected_version: 1 }).expect(409);
    assert.equal(draft.body.reason, 'news_read_only');
    assert.equal(publication.body.reason, 'news_read_only');
    assert.equal(db.calls.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
  });

  test(`${mode}: unfiltered cron skips announcement including invalid retirement, processes other areas`, async () => {
    const changed = [];
    const db = database(mode, (sql, values) => {
      if (sql.includes("scheduled.status = 'scheduled'")) {
        assert.match(sql, /d.content_type <> 'announcement'/);
        return { rows: [{ id: 'knowledge', content_type: 'knowledge', scheduled_revision_id: 'k-rev', scheduled_blocks: [] }] };
      }
      if (/^\s*(UPDATE|INSERT)/.test(sql)) changed.push(values);
    });
    assert.equal(await promoteDueScheduled(db), 1);
    assert.equal(changed.length, 3);
    assert.equal(db.calls.some(({ sql }) => sql.includes('schedule_invalid')), false);
    assert.ok(db.calls.findIndex(({ sql }) => sql.includes('pg_advisory')) < db.calls.findIndex(({ sql }) => sql.includes('SELECT mode')));
    const announcementOnly = database(mode);
    assert.equal(await promoteDueScheduled(announcementOnly, new Date(), 'announcement'), 0);
    assert.equal(announcementOnly.calls.length, 2);
  });

  test(`${mode}: old importer rejects before touching documents/assets or files`, async () => {
    const db = database(mode);
    await assert.rejects(persist({ documents: [], media: [] }, {}, { db, directory: null, apply: true }), { code: 'news_read_only' });
    assert.equal(db.calls.some(({ sql }) => /cms_documents|cms_assets/.test(sql)), false);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  });
}

test('other-area promoter does not require news authority availability', async () => {
  const db = database('unknown', sql => {
    assert.doesNotMatch(sql, /owner_news_authority/);
  });
  assert.equal(await promoteDueScheduled(db, new Date(), 'knowledge'), 0);
});

test('frozen reads remain readable while due promotions are skipped', async () => {
  const db = database('frozen', sql => {
    if (sql.includes('SELECT d.id, d.title')) return { rows: [{ id, title: 'Synthetic', category: '', published_at: null,
      published_revision_id: revision, blocks: [{ type: 'paragraph', text: 'Published' }], editorial: null }] };
    if (sql.includes('FOR UPDATE OF d, r')) return { rows: [{ id, published_revision_id: revision }] };
    if (sql.includes("scheduled.status = 'scheduled'")) assert.fail('frozen must not select due news');
  });
  const page = await listPublishedAnnouncements(db, 24, 0);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].id, id);
});

test('CLI dry-run never connects; strict command/epoch; lost COMMIT never claims success', async () => {
  for (const args of [[], ['legacy'], ['freeze-legacy', '--epoch', '0'], ['freeze-legacy', '--epoch', '7', '--proof', 'trusted']]) {
    assert.throws(() => parseCutoverArguments(args), { code: 'invalid_arguments' });
  }
  const input = parseCutoverArguments(['freeze-legacy', '--epoch', '7']);
  const plan = await runCutover({ input, pool: { connect() { assert.fail('dry-run connects'); } } });
  assert.equal(plan.applied, false); assert.equal(plan.readinessVerified, false);
  const db = database('legacy', sql => {
    if (sql.includes('SELECT role, permissions')) return { rows: [{ role: 'admin', permissions: { manageKnowledge: true } }] };
    if (sql === 'COMMIT') throw new Error('lost response');
  });
  await assert.rejects(runCutover({ pool: db, input: { ...input, apply: true }, actorUid: 'editor' }), { code: 'commit_outcome_unknown' });
  assert.equal(db.mode, 'frozen'); // seam simulates the UPDATE surviving the lost ACK
});

test('normal writer matrix remains fail-closed for all four modes', () => {
  for (const mode of ['legacy', 'frozen', 'payload', 'payload_frozen']) {
    assert.equal(writerAllowed(mode, 'legacy'), mode === 'legacy');
    assert.equal(writerAllowed(mode, 'payload'), mode === 'payload');
  }
});

test('legacy asset references never grant old-news access in Payload modes; shared grants stay independent', async () => {
  const asset = { id, mime_type: 'image/png', byte_size: 4, storage_key: 'synthetic' };
  const reference = { content_type: 'announcement', status: 'published', revision_id: revision,
    published_revision_id: revision, block_type: 'image', blocks: [{ type: 'image', asset_id: id, alt: 'Synthetic' }] };
  const employee = { uid: 'viewer', role: 'employee', permissions: {} };
  const editor = { uid: 'editor', role: 'admin', permissions: { manageKnowledge: true } };
  for (const mode of ['legacy', 'frozen', 'payload', 'payload_frozen']) {
    for (const user of [employee, editor]) {
      const db = database(mode, sql => {
        if (sql.includes('SELECT d.content_type')) return { rows: [reference] };
        if (sql.includes('FROM cms_assets')) return { rows: [asset] };
      });
      assert.equal(await canReadAsset(db, user, asset), ['legacy', 'frozen'].includes(mode));
    }
  }
  for (const content_type of ['knowledge', 'academy', 'academy_lesson']) {
    const shared = { ...reference, content_type, academy_active: true, academy_audience: 'all',
      lesson_active: true, module_active: true, course_document_id: 'course', course_blocks: [] };
    const db = database('payload', sql => {
      if (sql.includes('SELECT d.content_type')) return { rows: [reference, shared] };
      if (sql.includes('FROM cms_assets')) return { rows: [asset] };
      if (sql.includes('owner_news_authority')) assert.fail('independent grant must not require news authority');
    });
    assert.equal(await canReadAsset(db, employee, asset), true, content_type);
    if (content_type !== 'knowledge') {
      shared.academy_active = false;
      // The independent grant is revoked: authority lookup now decides only the
      // remaining legacy-news reference, which cannot grant access in Payload.
      const revoked = database('payload', sql => {
        if (sql.includes('SELECT d.content_type')) return { rows: [reference, shared] };
        if (sql.includes('FROM cms_assets')) return { rows: [asset] };
      });
      assert.equal(await canReadAsset(revoked, employee, asset), false);
    }
  }
});

test('retained old-news references protect bytes even after legacy reader grants are removed', async () => {
  const db = database('payload', sql => {
    if (sql.includes('SELECT id, storage_key, deleting_at')) return { rows: [{ id, storage_key: 'synthetic', deleting_at: null }] };
    if (sql.includes('SELECT 1') && sql.includes('jsonb_array_elements')) return { rows: [{ exists: 1 }] };
  });
  const result = await deleteUnreferencedAsset({ user: { uid: 'editor' }, id: 'request' }, id,
    { dbPool: db, fileSystem: { unlink() { assert.fail('retained file must never be unlinked'); } } });
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, 'referenced');
  assert.equal(db.calls.some(({ sql }) => sql.includes('DELETE FROM cms_assets')), false);
});

test('audit failure and CAS conflict propagate, requiring caller rollback', async () => {
  const failure = new Error('audit unavailable');
  const db = database('legacy', sql => { if (sql.includes('INSERT INTO audit_log')) throw failure; });
  await assert.rejects(transitionAuthority(db, { from: 'legacy', to: 'frozen', expectedEpoch: 7, actorUid: 'editor' }), error => error === failure);
  const conflict = database('legacy', sql => sql.includes('UPDATE owner_news_authority') ? { rows: [] } : undefined);
  await assert.rejects(transitionAuthority(conflict, { from: 'legacy', to: 'frozen', expectedEpoch: 7, actorUid: 'editor' }), { code: 'news_authority_conflict' });
  assert.equal(conflict.calls.some(({ sql }) => sql.includes('INSERT INTO audit_log')), false);
});

test('A2 apply-draft/publish deny all frozen modes after lock, before target/file mutation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'news-authority-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = prepareBundle({ referencePayload: { store: { articles: [{ id: 'synthetic', status: 'published',
    title: 'Synthetic', category: 'Test', excerpt: 'Synthetic summary', author: 'Synthetic author',
    publishedAt: '2026-09-01', blocks: [{ type: 'text', text: 'Synthetic body.' }] }] } },
  sourceSnapshot: { reference_sha256: 'a'.repeat(64), reference_observed_at: '2026-09-30T12:00:00Z',
    reference_published_count: 1, edition_key: '4', edition_pdf_sha256: null }, editionItems: [], assets: [],
  decisions: [{ source_key: 'reference:synthetic', canonical_key: 'reference:synthetic', decision: 'include', reason: 'Synthetic', reviewer: 'Synthetic' }] });
  bundle.items.forEach(item => { item.review_status = 'approved'; });
  for (const authority of ['frozen', 'payload', 'payload_frozen']) for (const mode of ['apply-draft', 'publish']) {
    const db = database(authority, sql => {
      if (sql.includes('current_database()')) return { rows: [{ database: 'synthetic', role: 'portal_api', permitted: true, recovery: false }] };
      if (sql.includes('SELECT role,permissions')) return { rows: [{ role: 'admin', permissions: { manageKnowledge: true } }] };
    });
    await assert.rejects(applyBundle({ pool: db, uploadDir: root, root, bundle, actorUid: 'editor', mode }), { code: 'news_read_only' });
    assert.equal(db.calls.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql)), false);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  }
});

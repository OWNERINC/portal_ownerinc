import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { identity } from '../../scripts/import-owner-news.mjs';
import { prepareBundle, bundleHashes, serializeBundle } from '../../scripts/lib/owner-news-bundle.mjs';
import { applyBundle, targetSnapshot } from '../../scripts/lib/owner-news-bundle-import.mjs';
import { cmsApp } from './cms-app.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const { getPublishedAnnouncement } = require('./cms/reader.js');

// Requires the caller's explicitly disposable, migrated PostgreSQL. All rows/files
// are synthetic, namespaced, tracked and cleaned; no source download is performed.
export async function checkBundleImport(pool) {
  const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const root = await fs.mkdtemp(path.join(base, 'owner-news-A2-'));
  const uploadDir = path.join(root, 'uploads'); await fs.mkdir(uploadDir);
  const uid = `bundle-A2-${randomUUID()}`, documentIds = new Set(), assetIds = new Set();
  const runtimePool = { async connect() {
    const db = await pool.connect();
    return { release: () => db.release(), async query(sql, values) {
      const result = await db.query(sql, values);
      if (sql.startsWith('BEGIN')) await db.query('SET LOCAL ROLE portal_api');
      return result;
    } };
  } };
  const run = (bundle, mode = 'dry-run', extra = {}) => applyBundle({ pool: runtimePool, bundle, root, uploadDir, actorUid: uid, mode, ...extra });
  const fixture = async (color = '#1267ab') => {
    const tag = randomUUID();
    const buffer = await require('sharp')({ create: { width: 3, height: 3, channels: 3, background: color } }).png().toBuffer();
    const asset = { key: tag, relative_path: `${tag}.png`, mime: 'image/png', sha256: sha(buffer), byte_size: buffer.length,
      url: `/assets/${tag}.png` };
    await fs.writeFile(path.join(root, asset.relative_path), buffer);
    const articles = ['a', 'b'].map(suffix => ({ id: `${tag}-${suffix}`, status: 'published', title: `Sintética ${tag}-${suffix}`, category: 'Fixture',
      excerpt: 'Resumo sintético aprovado.', blocks: [{ type: 'text', text: 'Corpo nativo sintético.' }, { type: 'image', image: asset.url }] }));
    const bundle = prepareBundle({ referencePayload: { store: { articles } }, assets: [asset], decisions: articles.map(a => ({
      source_key: `reference:${a.id}`, canonical_key: `reference:${a.id}`, decision: 'include', reason: 'Fixture aprovada', reviewer: 'Teste A2' })),
    sourceSnapshot: { reference_sha256: 'a'.repeat(64), reference_observed_at: '2026-09-30T12:00:00Z', reference_published_count: 2, edition_key: '4', edition_pdf_sha256: null } });
    bundle.items.forEach(i => { i.review_status = 'approved'; documentIds.add(identity('document', i.sources[0].external_id)); });
    assetIds.add(identity('editorial-asset-sha256', asset.sha256));
    return { bundle, buffer };
  };
  const document = async id => (await pool.query('SELECT * FROM cms_documents WHERE id=$1', [id])).rows[0];
  const count = async () => (await pool.query('SELECT COUNT(*)::integer AS n FROM cms_revisions WHERE document_id=ANY($1::uuid[])', [[...documentIds]])).rows[0].n;
  const faultPool = predicate => ({ async connect() {
    const db = await pool.connect();
    return { release: () => db.release(), async query(sql, values) {
      if (predicate(sql) === 'before') throw new Error('synthetic controlled transport failure');
      const result = await db.query(sql, values);
      if (predicate(sql) === 'after') throw new Error('synthetic lost commit acknowledgement');
      return result;
    } };
  } });
  try {
    await pool.query(`INSERT INTO users(uid,email,name,role,permissions) VALUES ($1,$2,'Fixture A2','admin',$3::jsonb)`,
      [uid, `${uid}@example.com`, JSON.stringify({ manageKnowledge: true })]);
    const { bundle, buffer } = await fixture();
    const manifest = path.join(root, 'bundle.json'); await fs.writeFile(manifest, serializeBundle(bundle));
    const cli = args => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../scripts/import-owner-news-bundle.mjs', import.meta.url)), '--bundle', manifest, ...args],
      { env: { ...process.env, OWNER_NEWS_TARGET_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
        OWNER_NEWS_TARGET_UPLOAD_DIR: uploadDir, OWNER_NEWS_ACTOR_UID: uid } });
    const cliDry = JSON.parse((await cli([])).stdout);
    assert.equal(cliDry.mode, 'dry-run'); assert.equal(cliDry.draftsCreated, 0); assert.equal(cliDry.databaseChecked, true);
    const id = identity('document', bundle.items[0].sources[0].external_id);
    const mediaId = identity('editorial-asset-sha256', bundle.assets[0].sha256);
    const file = path.join(uploadDir, 'cms-private', mediaId);
    const pending = structuredClone(bundle); pending.items[0].review_status = 'needs_review';
    await assert.rejects(run(pending, 'apply-draft'), /review_required/);
    await assert.rejects(run(bundle, 'dry-run', { actorUid: `${uid}-missing` }), /invalid_actor/);
    await pool.query('UPDATE users SET permissions=$2::jsonb WHERE uid=$1', [uid, JSON.stringify({ manageKnowledge: true, accountDisabled: true })]);
    await assert.rejects(run(bundle), /invalid_actor/);
    await pool.query('UPDATE users SET permissions=$2::jsonb WHERE uid=$1', [uid, JSON.stringify({ manageKnowledge: true })]);
    const raw = JSON.stringify(bundle);
    const dry = await run(bundle, 'dry-run', { bundleBytes: raw });
    assert.equal(dry.bundle_sha256, sha(raw)); assert.notEqual(dry.bundle_sha256, bundleHashes(bundle).bundle_sha256);
    assert.equal(dry.content_sha256, bundleHashes(bundle).content_sha256);
    assert.deepEqual(dry.conflicts, []); assert.equal(dry.prepared, 2); assert.equal(await count(), 0);
    assert.deepEqual(await fs.readdir(uploadDir), []);
    await assert.rejects(run(bundle, 'publish'), /prepared_draft_required/);
    const applied = await run(bundle, 'apply-draft');
    assert.equal(applied.draftsCreated, 2); assert.equal(applied.assetsCreated, 1); assert.equal(applied.published, 0);
    const repeated = await run(bundle, 'apply-draft');
    assert.equal(repeated.draftsCreated, 0); assert.equal(repeated.assetsCreated, 0); assert.equal(repeated.existing, 2);
    assert.equal(await count(), 2); assert.deepEqual(await fs.readFile(file), buffer);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS n FROM cms_assets WHERE metadata->>'content_sha256'=$1", [applied.content_sha256])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT COUNT(*)::integer AS n FROM cms_documents WHERE content_type='announcement' AND source_id=ANY($1::uuid[])",
      [bundle.items.map(i => identity('source', i.sources[0].external_id))])).rows[0].n, 2);
    assert.equal(JSON.parse((await cli(['--apply-draft'])).stdout).draftsCreated, 0);
    assert.equal((await run(bundle)).verifiedAssets, 1);
    const original = await document(id), draftId = original.draft_revision_id;
    const stored = (await pool.query('SELECT * FROM cms_revisions WHERE id=$1', [draftId])).rows[0];
    const cms = require('supertest')(cmsApp(pool, { uid, role: 'admin', permissions: { manageKnowledge: true } }));
    const review = (await cms.get(`/api/cms/documents/${id}`).expect(200)).body;
    assert.equal(review.draft.id, draftId); assert.deepEqual(review.draft.blocks, stored.blocks);
    assert.deepEqual(review.draft.editorial, stored.editorial); assert.equal(review.published, null);
    assert.equal(await getPublishedAnnouncement(pool, id), null);
    assert.equal(stored.blocks[1].asset_id, mediaId); assert.ok(!('asset_key' in stored.blocks[1]));
    assert.notEqual(stored.blocks[1].asset_id, identity('bundle-asset', bundle.assets[0].key));
    await pool.query("UPDATE cms_revisions SET blocks='[]'::jsonb WHERE id=$1", [draftId]);
    await assert.rejects(run(bundle, 'publish'), /target_conflict/);
    await pool.query('UPDATE cms_revisions SET blocks=$2::jsonb WHERE id=$1', [draftId, JSON.stringify(stored.blocks)]);
    await fs.writeFile(file, Buffer.alloc(buffer.length));
    assert.equal((await run(bundle)).verifiedAssets, 0);
    await assert.rejects(run(bundle, 'apply-draft'), /target_conflict/);
    await fs.writeFile(file, buffer);
    // Concurrent publication leaves the package draft intact but invalidates its snapshot.
    const concurrent = randomUUID();
    await pool.query(`INSERT INTO cms_revisions(id,document_id,version,status,blocks,editorial)
      VALUES ($1,$2,2,'published',$3::jsonb,$4::jsonb)`, [concurrent, id, JSON.stringify(stored.blocks), JSON.stringify(stored.editorial)]);
    await pool.query('UPDATE cms_documents SET published_revision_id=$2,published_at=NOW() WHERE id=$1', [id, concurrent]);
    await assert.rejects(run(bundle, 'publish'), /target_conflict/);
    await pool.query('UPDATE cms_documents SET published_revision_id=NULL,published_at=NULL WHERE id=$1', [id]);
    await pool.query("UPDATE cms_revisions SET status='scheduled' WHERE id=$1", [concurrent]);
    await pool.query("UPDATE cms_documents SET scheduled_revision_id=$2,scheduled_at=NOW()+INTERVAL '1 day' WHERE id=$1", [id, concurrent]);
    await assert.rejects(run(bundle, 'apply-draft'), /target_conflict/);
    await pool.query('UPDATE cms_documents SET scheduled_revision_id=NULL,scheduled_at=NULL WHERE id=$1', [id]);
    await pool.query('DELETE FROM cms_revisions WHERE id=$1', [concurrent]);
    await assert.rejects(run(bundle, 'publish', { bundleBytes: JSON.stringify(bundle) }), /prepared_bundle_required/);
    const published = await run(bundle, 'publish'); assert.equal(published.published, 2); assert.equal(published.verifiedPublications, 2);
    const readable = await getPublishedAnnouncement(pool, id);
    assert.deepEqual(readable.content_blocks, stored.blocks); assert.deepEqual(readable.editorial, stored.editorial);
    assert.equal((await run(bundle, 'publish')).published, 0); assert.equal(await count(), 2);
    assert.equal((await run(bundle)).verifiedPublications, 2);
    // Existing published is strictly read-only even with a subsequent draft/schedule.
    const later = randomUUID(), scheduled = randomUUID();
    for (const [rev, version, status] of [[later, 2, 'draft'], [scheduled, 3, 'scheduled']]) await pool.query(`INSERT INTO cms_revisions
      (id,document_id,version,status,blocks,editorial) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`, [rev, id, version, status, JSON.stringify(stored.blocks), JSON.stringify(stored.editorial)]);
    await pool.query("UPDATE cms_documents SET draft_revision_id=$2,scheduled_revision_id=$3,scheduled_at=NOW()+INTERVAL '1 day' WHERE id=$1", [id, later, scheduled]);
    const laterSnapshot = await document(id);
    await run(bundle, 'publish'); await run(bundle, 'apply-draft');
    assert.deepEqual(await document(id), laterSnapshot);
    console.log('owner-news A2: strict approval/actor, exact bytes, no-write dry-run, repeat drafts/publication, asset UUID/hash, revision/publication/schedule drift and later-pointer preservation ok');

    // Explicit withdraw is separate from exclude-only preparation and preserves later draft.
    const excluded = structuredClone(bundle);
    excluded.items = []; excluded.assets = [];
    excluded.decisions.forEach(d => { d.decision = 'exclude'; d.canonical_key = null; });
    await run(excluded, 'publish'); assert.deepEqual(await document(id), laterSnapshot);
    const withdrawal = structuredClone(excluded);
    withdrawal.items = [{ ...bundle.items[0], action: 'withdraw', target: targetSnapshot(laterSnapshot) }];
    await run(withdrawal, 'apply-draft'); assert.deepEqual(await document(id), laterSnapshot);
    assert.equal((await run(withdrawal, 'publish')).withdrawn, 1);
    assert.equal((await document(id)).draft_revision_id, later);
    assert.equal((await document(id)).scheduled_revision_id, null);
    assert.equal((await run(withdrawal, 'publish')).withdrawn, 0);
    await pool.query("UPDATE cms_documents SET title='Drift após retirada' WHERE id=$1", [id]);
    await assert.rejects(run(withdrawal, 'publish'), /target_conflict/);
    await pool.query('UPDATE cms_documents SET title=$2 WHERE id=$1', [id, laterSnapshot.title]);
    console.log('owner-news A2: preparation exclusion no-op; explicit audited withdrawal cancels schedule, preserves draft, is idempotent and blocks drift ok');

    // Compatible prior import keeps its ID/source/publication date; only explicit snapshot permits conversion.
    const legacy = await fixture('#a54521');
    const legacyItem = legacy.bundle.items[0], legacyId = identity('document', legacyItem.sources[0].external_id);
    const legacyRevision = randomUUID(), legacyAsset = randomUUID(); assetIds.add(legacyAsset);
    const legacyFile = path.join(uploadDir, 'cms-private', legacyAsset);
    await fs.writeFile(legacyFile, legacy.buffer);
    await pool.query(`INSERT INTO cms_assets(id,storage_key,original_name,mime_type,byte_size,metadata)
      VALUES ($1,$1,'Fixture antiga','image/png',$2,$3::jsonb)`, [legacyAsset, legacy.buffer.length, JSON.stringify({ sha256: legacy.bundle.assets[0].sha256, owner_news_source: 'https://synthetic.invalid/media' })]);
    await pool.query(`INSERT INTO cms_documents(id,content_type,source_id,title,category,published_at)
      VALUES ($1,'announcement',$2,'Título antigo','Anterior','2026-08-01T12:00:00Z')`, [legacyId, identity('source', legacyItem.sources[0].external_id)]);
    await pool.query(`INSERT INTO cms_revisions(id,document_id,version,status,blocks)
      VALUES ($1,$2,1,'published',$3::jsonb)`, [legacyRevision, legacyId, JSON.stringify([{ type: 'image', asset_id: legacyAsset, alt: 'Antiga' }])]);
    await pool.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [legacyId, legacyRevision]);
    const unmapped = await run(legacy.bundle);
    assert.ok(unmapped.conflicts.some(c => c.code === 'Unmapped existing target'));
    assert.equal(unmapped.targets[0].target.document_id, legacyId);
    await assert.rejects(run(legacy.bundle, 'apply-draft'), /target_conflict/);
    const contentHash = bundleHashes(legacy.bundle).content_sha256;
    await fs.writeFile(manifest, serializeBundle(legacy.bundle));
    const targetOutput = path.join(root, 'destination.json');
    await assert.rejects(cli(['--target-output', targetOutput]), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).conflicts.length, 1);
      assert.ok(!error.stdout.includes(legacyItem.title));
      return true;
    });
    const destination = JSON.parse(await fs.readFile(targetOutput, 'utf8'));
    assert.deepEqual(destination.items[0].target, unmapped.targets[0].target);
    assert.equal(bundleHashes(destination).content_sha256, contentHash);
    assert.notEqual(bundleHashes(destination).bundle_sha256, bundleHashes(legacy.bundle).bundle_sha256);
    legacyItem.target = unmapped.targets[0].target;
    assert.equal(bundleHashes(legacy.bundle).content_sha256, contentHash);
    // A draft changed after the approved snapshot blocks every item in this package.
    const concurrentDraft = randomUUID();
    await pool.query(`INSERT INTO cms_revisions(id,document_id,version,status,blocks)
      VALUES ($1,$2,2,'draft','[]'::jsonb)`, [concurrentDraft, legacyId]);
    await pool.query('UPDATE cms_documents SET draft_revision_id=$2 WHERE id=$1', [legacyId, concurrentDraft]);
    await assert.rejects(run(legacy.bundle, 'apply-draft'), /target_conflict/);
    assert.equal((await document(legacyId)).draft_revision_id, concurrentDraft);
    assert.equal(await document(identity('document', legacy.bundle.items[1].sources[0].external_id)), undefined);
    await pool.query('UPDATE cms_documents SET draft_revision_id=NULL WHERE id=$1', [legacyId]);
    await pool.query('DELETE FROM cms_revisions WHERE id=$1', [concurrentDraft]);
    assert.equal((await run(legacy.bundle, 'apply-draft')).assetsCreated, 0);
    assert.equal((await document(legacyId)).title, 'Título antigo');
    await run(legacy.bundle, 'publish');
    const converted = await document(legacyId);
    assert.equal(converted.source_id, legacyItem.target.source_id);
    assert.equal(converted.title, legacyItem.title); assert.equal(converted.published_at.toISOString(), '2026-08-01T12:00:00.000Z');
    const convertedBody = (await pool.query('SELECT blocks FROM cms_revisions WHERE id=$1', [converted.published_revision_id])).rows[0].blocks;
    assert.equal(convertedBody[1].asset_id, legacyAsset);
    // Explicit mapping may preserve a historical null source_id; no invented source is assigned.
    const mapped = await fixture('#7654ab');
    mapped.bundle.items = mapped.bundle.items.slice(0, 1);
    mapped.bundle.decisions[1] = { ...mapped.bundle.decisions[1], decision: 'exclude', canonical_key: null };
    const mappedId = randomUUID(); documentIds.add(mappedId);
    await pool.query("INSERT INTO cms_documents(id,content_type,title) VALUES ($1,'announcement','Mapeamento explícito')", [mappedId]);
    mapped.bundle.items[0].target = targetSnapshot(await document(mappedId));
    await run(mapped.bundle, 'apply-draft'); await run(mapped.bundle, 'publish');
    assert.equal((await document(mappedId)).source_id, null);
    // An existing asset's absent file is never reconstructed silently from package bytes.
    const mappedAsset = identity('editorial-asset-sha256', mapped.bundle.assets[0].sha256);
    const mappedPath = path.join(uploadDir, 'cms-private', mappedAsset);
    await fs.unlink(mappedPath);
    await assert.rejects(run(mapped.bundle, 'apply-draft'), /target_conflict/);
    await assert.rejects(fs.stat(mappedPath), { code: 'ENOENT' });
    await fs.writeFile(mappedPath, mapped.buffer);
    console.log('owner-news A2: prior-import identity/snapshot reconciliation without title matching, destination asset reuse and publication date preservation ok');

    const rollback = await fixture('#42ab12');
    const rollbackFile = path.join(uploadDir, 'cms-private', identity('editorial-asset-sha256', rollback.bundle.assets[0].sha256));
    const beforeCount = await count();
    const sentinel = path.join(uploadDir, 'cms-private', 'synthetic-unrelated'); await fs.writeFile(sentinel, 'preserve');
    await assert.rejects(run(rollback.bundle, 'apply-draft', { pool: faultPool(sql => sql.includes('INSERT INTO audit_log') ? 'before' : null) }), /synthetic/);
    assert.equal(await count(), beforeCount); await assert.rejects(fs.stat(rollbackFile), { code: 'ENOENT' });
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserve');
    // An unrelated title collision blocks the entire package before any file creation.
    const collision = randomUUID(); documentIds.add(collision);
    await pool.query("INSERT INTO cms_documents(id,content_type,title) VALUES ($1,'announcement',$2)", [collision, rollback.bundle.items[1].title]);
    await assert.rejects(run(rollback.bundle, 'apply-draft'), /target_conflict/);
    await assert.rejects(fs.stat(rollbackFile), { code: 'ENOENT' });
    await pool.query('DELETE FROM cms_documents WHERE id=$1', [collision]);
    // COMMIT really succeeds in PostgreSQL, then its acknowledgement is lost.
    await assert.rejects(run(rollback.bundle, 'apply-draft', { pool: faultPool(sql => sql === 'COMMIT' ? 'after' : null) }), /commit_outcome_unknown/);
    assert.deepEqual(await fs.readFile(rollbackFile), rollback.buffer);
    assert.equal((await run(rollback.bundle)).existing, 2);
    assert.equal((await run(rollback.bundle, 'apply-draft')).draftsCreated, 0);
    assert.equal(await count(), beforeCount + 2);
    console.log('owner-news A2: real audit-failure rollback removes only run files, title collision is atomic, lost successful COMMIT preserves files and reconciles ok');
  } finally {
    await pool.query('DELETE FROM audit_log WHERE actor_uid=$1', [uid]);
    await pool.query('DELETE FROM cms_documents WHERE id=ANY($1::uuid[])', [[...documentIds]]);
    await pool.query('DELETE FROM cms_assets WHERE id=ANY($1::uuid[])', [[...assetIds]]);
    await pool.query('DELETE FROM users WHERE uid=$1', [uid]);
    await fs.rm(root, { recursive: true, force: true });
    console.log('owner-news A2: synthetic fixtures cleaned');
  }
}

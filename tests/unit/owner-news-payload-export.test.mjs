import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { exportNewsBundle, readExportOptions, assetMetadataHash } from '../../scripts/owner-news-payload/export.mjs';
import { loadBundle, serializeManifest, sha256, LIMITS } from '../../scripts/owner-news-payload/bundle.mjs';
import { assertPrivatePath, inspectAssetFile, writeExclusive } from '../../scripts/owner-news-payload/files.mjs';
import { sourceFixture, ids, timestamp } from '../fixtures/owner-news-payload.mjs';

// Explicit override for machines whose home (and therefore OS temp) is itself a
// dotfiles Git checkout. Never weaken the production private-path guard for tests.
const tempRoot = process.env.OWNER_NEWS_EXPORT_TEST_TMP || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir());
async function environment(t) {
  let base = tempRoot;
  let root;
  // Prefer OS temp; if an entire user home is versioned, climb outside that Git
  // checkout before creating our single exclusively-owned synthetic directory.
  while (true) {
    try { await assertPrivatePath(base, { directory: true }); root = await fs.mkdtemp(path.join(base, 'news-export-test-')); break; }
    catch (error) {
      if (!['checkout_path_forbidden', 'EPERM', 'EACCES'].includes(error.code) || path.dirname(base) === base) throw error;
      base = path.dirname(base);
    }
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uploadDir = path.join(root, 'uploads'); await fs.mkdir(uploadDir); await fs.mkdir(path.join(uploadDir, 'cms-private'));
  return { root, uploadDir, targetDir: path.join(root, 'bundle') };
}
function database(input, rawAssets = [], shared = []) {
  const calls = [];
  return { calls, async query(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql.includes('FROM owner_news_authority')) return { rows: [structuredClone(input.source.authority)] };
    if (sql.includes('FROM cms_documents WHERE')) return { rows: structuredClone(input.documents) };
    if (sql.includes('FROM cms_revisions r JOIN') && sql.includes("WHERE d.content_type='announcement'")) return { rows: structuredClone(input.revisions) };
    if (sql.includes('FROM owner_news_home')) return { rows: input.home === null ? [] : [structuredClone(input.home)] };
    if (sql.includes('FROM cms_assets')) {
      assert.ok(sql.includes('metadata::text AS metadata_json_text'));
      assert.ok(sql.includes("metadata->>'sha256' AS stored_sha256"));
      return { rows: structuredClone(rawAssets) };
    }
    if (sql.includes('array_agg')) return { rows: structuredClone(shared) };
    if (/^(SET |SELECT pg_advisory_|BEGIN |COMMIT$|ROLLBACK$)/.test(sql)) return { rows: [] };
    throw new Error('unexpected_synthetic_query');
  } };
}
function addPDF(input, { metadata = {}, bytes = Buffer.from('%PDF-1.7\nsynthetic fixture\n') } = {}) {
  input.revisions[0].blocks.push({ type: 'pdf', asset_id: ids.pdf, title: 'Synthetic' });
  return { bytes, row: { id: ids.pdf, storage_key: ids.pdf, original_name: 'synthetic.pdf', mime_type: 'application/pdf', byte_size: String(bytes.length),
    metadata_json_text: JSON.stringify(metadata), stored_sha256: metadata.sha256 ?? null, uploaded_by: null, created_at: timestamp, updated_at: timestamp, deleting_at: null } };
}
test('dry-run is read-only and establishes RR snapshot AFTER acquiring session lock', async t => {
  const env = await environment(t), input = sourceFixture(), db = database(input);
  const result = await exportNewsBundle({ db, uploadDir: env.uploadDir, instanceId: input.source.instanceId, now: () => timestamp });
  assert.equal(result.mode, 'dry-run'); assert.equal(result.manifestPath, null);
  assert.deepEqual(await fs.readdir(env.root), ['uploads']);
  const sql = db.calls.map(row => row.sql);
  assert.ok(sql.findIndex(s => s.startsWith('SELECT pg_advisory_lock')) < sql.findIndex(s => s.startsWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')));
  assert.ok(sql.findIndex(s => s.startsWith('BEGIN')) < sql.findIndex(s => s.includes('FROM owner_news_authority')));
  assert.equal(sql.at(-1), 'SELECT pg_advisory_unlock($1)');
  assert.ok(sql.every(s => !/\b(INSERT|UPDATE|DELETE|promote|jobs)\b/i.test(s)));
  assert.ok(sql.some(s => s.includes('to_char(created_at') && s.includes('SS.US')));
});
test('write copies shared bytes without moving, missing stored SHA allowed, load validates every file', async t => {
  const env = await environment(t), input = sourceFixture(), pdf = addPDF(input);
  const original = path.join(env.uploadDir, 'cms-private', ids.pdf); await fs.writeFile(original, pdf.bytes);
  const db = database(input, [pdf.row], [{ id: ids.pdf, types: ['academy', 'knowledge'] }]);
  const result = await exportNewsBundle({ ...env, db, instanceId: input.source.instanceId, write: true, now: () => timestamp });
  const loaded = await loadBundle(result.manifestPath);
  assert.equal(loaded.manifestSha256, result.manifestSha256);
  assert.equal(loaded.revisionById.size, 2);
  assert.equal(loaded.revisionById.get(ids.published).converted.history.originalEditorial, null);
  assert.deepEqual(loaded.manifest.assets[0].sharedWithContentTypes, ['academy', 'knowledge']);
  assert.equal(loaded.manifest.assets[0].storedSha256, null);
  assert.equal(loaded.manifest.assets[0].sha256, sha256(pdf.bytes));
  assert.deepEqual(await fs.readFile(original), pdf.bytes);
  assert.deepEqual(await fs.readFile(loaded.assetPaths.get(ids.pdf)), pdf.bytes);
  await assert.rejects(exportNewsBundle({ ...env, db: database(input, [pdf.row]), instanceId: input.source.instanceId, write: true }), { code: 'export_failed' });
  assert.deepEqual(await fs.readFile(original), pdf.bytes);
  assert.equal((await loadBundle(result.manifestPath)).manifestSha256, result.manifestSha256);
});
test('load exact manifest hash changes with whitespace, but corrupted revisions and media fail closed', async t => {
  const env = await environment(t), input = sourceFixture(), pdf = addPDF(input);
  await fs.writeFile(path.join(env.uploadDir, 'cms-private', ids.pdf), pdf.bytes);
  const result = await exportNewsBundle({ ...env, db: database(input, [pdf.row]), instanceId: input.source.instanceId, write: true });
  const loaded = await loadBundle(result.manifestPath);
  await fs.appendFile(result.manifestPath, '\n');
  assert.notEqual((await loadBundle(result.manifestPath)).manifestSha256, loaded.manifestSha256);
  const revision = loaded.manifest.revisions[0], file = path.join(env.targetDir, revision.relativePath);
  const original = await fs.readFile(file); await fs.writeFile(file, 'not valid');
  await assert.rejects(loadBundle(result.manifestPath), { code: 'revision_file_mismatch' });
  await fs.writeFile(file, original);
  await fs.writeFile(loaded.assetPaths.get(ids.pdf), Buffer.alloc(pdf.bytes.length));
  await assert.rejects(loadBundle(result.manifestPath), { code: 'asset_hash_mismatch' });
});
test('stored SHA mismatch, missing bytes, deleting asset and MIME mismatch release transaction/lock', async t => {
  const env = await environment(t), input = sourceFixture(), pdf = addPDF(input, { metadata: { sha256: '0'.repeat(64) } });
  const file = path.join(env.uploadDir, 'cms-private', ids.pdf); await fs.writeFile(file, pdf.bytes);
  for (const [mutate, code] of [
    [() => {}, 'asset_hash_mismatch'],
    [() => { pdf.row.metadata = {}; pdf.row.stored_sha256 = null; pdf.row.deleting_at = timestamp; }, 'asset_deleting'],
    [async () => { pdf.row.deleting_at = null; await fs.writeFile(file, Buffer.alloc(pdf.bytes.length)); }, 'asset_signature_mismatch'],
    [async () => { await fs.unlink(file); }, 'private_path_missing'],
  ]) {
    await mutate(); const db = database(input, [pdf.row]);
    await assert.rejects(exportNewsBundle({ db, uploadDir: env.uploadDir, instanceId: input.source.instanceId }), { code });
    assert.equal(db.calls.at(-2).sql, 'ROLLBACK'); assert.equal(db.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1)');
  }
});
test('private paths reject checkout/public/traversal and exclusive writes never overwrite', async t => {
  const env = await environment(t);
  const checkout = path.join(env.root, 'checkout'); await fs.mkdir(checkout); await fs.writeFile(path.join(checkout, '.git'), 'synthetic linked worktree');
  await assert.rejects(assertPrivatePath(path.join(checkout, 'bundle'), { existing: false, directory: true }), { code: 'checkout_path_forbidden' });
  await assert.rejects(assertPrivatePath(path.join(env.root, 'public'), { existing: false, directory: true }), { code: 'public_path_forbidden' });
  await assert.rejects(assertPrivatePath(`${env.root}${path.sep}..${path.sep}escape`, { existing: false }), { code: 'private_path_required' });
  const file = path.join(env.root, 'exclusive'); await writeExclusive(file, Buffer.from('synthetic'));
  await assert.rejects(writeExclusive(file, Buffer.from('replacement')), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic');
});
test('symlink ancestors and hardlinked bytes are forbidden', async t => {
  const env = await environment(t), target = path.join(env.root, 'target'); await fs.mkdir(target);
  const link = path.join(env.root, 'link');
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('OS denies creating synthetic link'); throw error; }
  await assert.rejects(assertPrivatePath(path.join(link, 'file'), { existing: false }), { code: 'symlink_forbidden' });
  const bytes = Buffer.from('%PDF-synthetic'), original = path.join(target, 'original'), hard = path.join(target, 'hard');
  await fs.writeFile(original, bytes); await fs.link(original, hard);
  await assert.rejects(inspectAssetFile(hard, { size: bytes.length, mime: 'application/pdf' }), { code: 'invalid_private_file' });
});
test('only explicit local source configuration, write mode and destination are accepted', () => {
  const env = { OWNER_NEWS_SOURCE_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/portal_test', OWNER_NEWS_SOURCE_UPLOAD_DIR: path.resolve('synthetic'), OWNER_NEWS_SOURCE_ID: 'synthetic' };
  assert.equal(readExportOptions([], env).write, false);
  assert.equal(readExportOptions(['--write', '--output', path.resolve('synthetic-bundle')], env).write, true);
  for (const args of [['--write'], ['--output', 'path'], ['--write', '--dry-run'], ['--write', '--write'], ['--unknown']]) assert.throws(() => readExportOptions(args, env), { code: 'invalid_arguments' });
  for (const url of ['postgresql://fixture:fixture@example.invalid/portal_test', 'postgresql://fixture:fixture@localhost/production', 'postgresql://fixture:fixture@localhost/portal_test?sslmode=require']) {
    assert.throws(() => readExportOptions([], { ...env, OWNER_NEWS_SOURCE_DATABASE_URL: url }), { code: 'local_source_required' });
  }
  assert.throws(() => readExportOptions([], { DATABASE_URL: env.OWNER_NEWS_SOURCE_DATABASE_URL }), { code: 'source_database_required' });
});
test('limits apply before reads; no new aggregate media cap exists', async t => {
  const env = await environment(t), huge = path.join(env.root, 'huge');
  const handle = await fs.open(huge, 'wx'); await handle.truncate(LIMITS.asset + 1); await handle.close();
  await assert.rejects(inspectAssetFile(huge, { mime: 'application/pdf', size: LIMITS.asset + 1 }), { code: 'invalid_private_file' });
});
test('source failure has controlled diagnostics, no completion manifest and no content/connection echo', async t => {
  const env = await environment(t), input = sourceFixture(); input.home = null;
  const db = database(input);
  await assert.rejects(exportNewsBundle({ ...env, db, instanceId: input.source.instanceId, write: true }), { code: 'home_missing' });
  await assert.rejects(fs.stat(path.join(env.targetDir, 'manifest.json')), { code: 'ENOENT' });
  const bad = { async query() { throw new Error('private-connection-sentinel'); } };
  await assert.rejects(exportNewsBundle({ db: bad, uploadDir: env.uploadDir, instanceId: 'synthetic' }), error => error.code === 'export_failed' && !String(error).includes('sentinel'));
});

test('waiting exporter reads state committed before lock acquisition, not an earlier snapshot', async t => {
  const env = await environment(t), input = sourceFixture(), backing = database(input);
  let acquired = false;
  const db = { calls: backing.calls, async query(sql, parameters) {
    if (sql === 'SELECT pg_advisory_lock($1)') {
      // Simulated concurrent writer finishes while exporter waits for the lock.
      input.documents[0].updated_at = '2026-09-01T12:00:00.999999Z'; acquired = true;
    }
    if (sql.startsWith('BEGIN')) assert.equal(acquired, true);
    return backing.query(sql, parameters);
  } };
  const first = await exportNewsBundle({ ...env, db, write: true, instanceId: input.source.instanceId, now: () => timestamp });
  const loaded = await loadBundle(first.manifestPath);
  assert.equal(loaded.manifest.documents[0].updated_at, '2026-09-01T12:00:00.999999Z');
});
test('real bounded PNG decode and video container verification preserve exact bytes', async t => {
  const env = await environment(t);
  const sharp = createRequire(new URL('../../api/package.json', import.meta.url))('sharp');
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
  const mp4 = Buffer.alloc(24); mp4.writeUInt32BE(24, 0); mp4.write('ftyp', 4); mp4.write('isom', 8);
  const webm = Buffer.from([26, 69, 223, 163, 0, 0, 0, 0]);
  for (const [name, mime, bytes] of [['image', 'image/png', png], ['video', 'video/mp4', mp4], ['webm', 'video/webm', webm]]) {
    const original = path.join(env.root, name), copy = path.join(env.root, `${name}-copy`); await fs.writeFile(original, bytes);
    const result = await inspectAssetFile(original, { mime, size: bytes.length }, { copyTo: copy });
    assert.equal(result.sha256, sha256(bytes)); assert.deepEqual(await fs.readFile(copy), bytes);
  }
});
test('source byte mutation between verification and streaming copy cannot produce a valid result', async t => {
  const env = await environment(t), original = path.join(env.root, 'original'), copy = path.join(env.root, 'copy');
  const bytes = Buffer.from('%PDF-synthetic-A'); await fs.writeFile(original, bytes);
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (filename, ...args) => {
    if (filename === copy) await fs.writeFile(original, Buffer.from('%PDF-synthetic-B'));
    return open(filename, ...args);
  });
  await assert.rejects(inspectAssetFile(original, { mime: 'application/pdf', size: bytes.length }, { copyTo: copy }), { code: 'private_file_changed' });
});
test('asset metadata fingerprint is precision-safe, domain-separated and includes unknown fields', async t => {
  const preciseA = '{"unknownCounter":9007199254740992,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
  const preciseB = '{"unknownCounter":9007199254740993,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
  // These adjacent JSON integers become equal after Number/JSON.parse rounding.
  assert.equal(JSON.parse(preciseA).unknownCounter, JSON.parse(preciseB).unknownCounter);
  assert.notEqual(assetMetadataHash(preciseA), assetMetadataHash(preciseB));
  assert.notEqual(assetMetadataHash(preciseA), sha256(preciseA));
  const input = sourceFixture(), pdf = addPDF(input);
  const sourceSha = sha256(pdf.bytes);
  const exactA = `{"unknownCounter":9007199254740992,"sha256":"${sourceSha}"}`;
  const exactB = `{"unknownCounter":9007199254740993,"sha256":"${sourceSha}"}`;
  const metadataVariants = [
    { ...pdf.row, metadata_json_text: exactA, stored_sha256: sourceSha },
    { ...pdf.row, metadata_json_text: exactB, stored_sha256: sourceSha },
  ];
  const fingerprints = [];
  for (const row of metadataVariants) {
    const env = await environment(t); await fs.writeFile(path.join(env.uploadDir, 'cms-private', ids.pdf), pdf.bytes);
    const result = await exportNewsBundle({ db: database(input, [row]), uploadDir: env.uploadDir, instanceId: input.source.instanceId });
    fingerprints.push(result.sourceFingerprint);
  }
  assert.notEqual(fingerprints[0], fingerprints[1]);
  assert.equal(metadataVariants[0].stored_sha256, metadataVariants[1].stored_sha256);
});

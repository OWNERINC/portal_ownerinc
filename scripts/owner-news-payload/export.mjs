import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { buildBundle, serializeManifest, sha256, uuid, fail, BundleError, DOCUMENT_FIELDS, REVISION_FIELDS, HOME_FIELDS } from './bundle.mjs';
import { assertPrivatePath, inspectAssetFile, writeExclusive } from './files.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const LOCK = 7193029;
export const ASSET_METADATA_HASH_DOMAIN = 'owner-news-payload:asset-metadata:v1\0';
export function assetMetadataHash(metadataJsonText) {
  if (typeof metadataJsonText !== 'string') fail('asset_metadata_unavailable');
  return createHash('sha256').update(ASSET_METADATA_HASH_DOMAIN, 'utf8').update(metadataJsonText, 'utf8').digest('hex');
}
// Column identifiers are code constants only; no operator input reaches SQL syntax.
const timestampSQL = (name, prefix = '') => `to_char(${prefix}${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${name}`;
const fieldsSQL = (names, dates, prefix = '') => names.map(name => dates.includes(name) ? timestampSQL(name, prefix) : `${prefix}${name}`).join(', ');

/** Caller must own the export snapshot. No reader helpers: some promote schedules. */
export async function readSourceSnapshot(db, instanceId) {
  const authority = (await db.query('SELECT mode, epoch FROM owner_news_authority WHERE singleton=TRUE')).rows;
  if (authority.length !== 1) fail('authority_missing');
  const documents = (await db.query(`SELECT ${fieldsSQL(DOCUMENT_FIELDS, ['scheduled_at', 'published_at', 'created_at', 'updated_at'])} FROM cms_documents WHERE content_type='announcement' ORDER BY id`)).rows;
  const revisions = (await db.query(`SELECT ${fieldsSQL(REVISION_FIELDS, ['created_at'], 'r.')} FROM cms_revisions r JOIN cms_documents d ON d.id=r.document_id WHERE d.content_type='announcement' ORDER BY r.id`)).rows;
  const home = (await db.query(`SELECT ${fieldsSQL(HOME_FIELDS, ['updated_at', 'published_at'])} FROM owner_news_home WHERE singleton=TRUE`)).rows;
  if (home.length !== 1) fail('home_missing');
  const ids = [...new Set(revisions.flatMap(row => {
    if (!Array.isArray(row.blocks)) fail('invalid_revision', { id: row.id });
    return row.blocks.flatMap(block => {
      if (!block || typeof block !== 'object' || !Object.hasOwn(block, 'asset_id')) return [];
      if (typeof block.asset_id !== 'string') fail('invalid_media_reference', { id: row.id });
      return [uuid(block.asset_id.toLowerCase())];
    });
  }))].sort();
  const assets = ids.length ? (await db.query(`SELECT id, storage_key, original_name, mime_type, byte_size,
    metadata::text AS metadata_json_text, metadata->>'sha256' AS stored_sha256, uploaded_by,
    ${timestampSQL('created_at')}, ${timestampSQL('updated_at')}, ${timestampSQL('deleting_at')}
    FROM cms_assets WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids])).rows : [];
  if (assets.length !== ids.length) fail('asset_missing');
  const shared = ids.length ? (await db.query(`SELECT lower(block->>'asset_id') AS id, array_agg(DISTINCT d.content_type ORDER BY d.content_type) AS types
    FROM cms_revisions r JOIN cms_documents d ON d.id=r.document_id CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
    WHERE d.content_type <> 'announcement' AND lower(block->>'asset_id')=ANY($1::text[]) GROUP BY lower(block->>'asset_id')`, [ids])).rows : [];
  const sharedById = new Map(shared.map(row => [row.id, row.types]));
  return { source: { instanceId, authority: authority[0] }, documents, revisions, home: home[0], assets: assets.map(row => ({
    id: row.id, storageKey: row.storage_key, originalName: row.original_name, mime: row.mime_type, size: Number(row.byte_size), uploadedBy: row.uploaded_by,
    createdAt: row.created_at, updatedAt: row.updated_at, deletingAt: row.deleting_at,
    metadataHash: assetMetadataHash(row.metadata_json_text), storedSha256: row.stored_sha256,
    relativePath: `assets/${row.id}`, sharedWithContentTypes: sharedById.get(row.id) || [],
  })) };
}

/** db is an EXCLUSIVE dedicated pg Client, idle on entry (never a Pool.query).
 * Session lock comes BEFORE BEGIN so a waiter cannot establish a stale RR snapshot.
 * No writes to source DB in either mode. Partial private output is never overwritten.
 */
export async function exportNewsBundle({ db, uploadDir, targetDir = null, write = false, instanceId, now = () => new Date().toISOString() }) {
  const storage = await assertPrivatePath(path.join(await assertPrivatePath(uploadDir, { directory: true }), 'cms-private'), { directory: true });
  if (write && targetDir === null) fail('target_directory_required');
  if (!write && targetDir !== null) fail('dry_run_target_forbidden');
  if (targetDir !== null) {
    await assertPrivatePath(targetDir, { existing: false, directory: true });
    if (path.resolve(targetDir) === storage || path.resolve(targetDir).startsWith(`${storage}${path.sep}`)) fail('target_is_source_storage');
  }
  let locked = false, transaction = false;
  try {
    // Dedicated connection only. Session timeouts also bound the pre-BEGIN lock wait.
    await db.query("SET statement_timeout = '60s'");
    await db.query("SET lock_timeout = '15s'");
    await db.query('SELECT pg_advisory_lock($1)', [LOCK]); locked = true;
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const input = await readSourceSnapshot(db, instanceId);
    if (!['legacy', 'frozen'].includes(input.source.authority.mode)) fail('invalid_export_authority');
    const exportedAt = now();
    if (write) {
      await fs.mkdir(targetDir, { mode: 0o700 });
      await fs.mkdir(path.join(targetDir, 'assets'), { mode: 0o700 });
      await fs.mkdir(path.join(targetDir, 'revisions'), { mode: 0o700 });
    }
    for (const asset of input.assets) {
      uuid(asset.id); uuid(asset.storageKey);
      if (asset.deletingAt !== null) fail('asset_deleting', { id: asset.id });
      const verified = await inspectAssetFile(path.join(storage, asset.storageKey), { mime: asset.mime, size: asset.size, sha256: asset.storedSha256 },
        { copyTo: write ? path.join(targetDir, asset.relativePath) : null });
      asset.sha256 = verified.sha256;
    }
    const { manifest, revisionFiles } = buildBundle({ ...input, exportedAt });
    const bytes = serializeManifest(manifest), manifestSha256 = sha256(bytes);
    if (write) {
      for (const doc of manifest.documents) await fs.mkdir(path.join(targetDir, 'revisions', doc.id), { mode: 0o700 });
      for (const [name, content] of revisionFiles) await writeExclusive(path.join(targetDir, name), content);
      // Do not expose a completed manifest until source snapshot finished cleanly.
    }
    await db.query('COMMIT'); transaction = false;
    if (write) await writeExclusive(path.join(targetDir, 'manifest.json'), bytes);
    return { mode: write ? 'write' : 'dry-run', manifestPath: write ? path.join(targetDir, 'manifest.json') : null,
      manifestSha256, sourceFingerprint: manifest.sourceFingerprint, source: manifest.source, counts: manifest.counts };
  } catch (error) {
    if (transaction) await db.query('ROLLBACK').catch(() => {});
    if (error instanceof BundleError) throw error;
    fail('export_failed');
  } finally {
    if (locked) {
      try { await db.query('SELECT pg_advisory_unlock($1)', [LOCK]); }
      catch { fail('export_lock_release_failed'); }
    }
  }
}

export function readExportOptions(args, env) {
  const options = { write: false, targetDir: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (seen.has(arg)) fail('invalid_arguments'); seen.add(arg);
    if (arg === '--write') options.write = true;
    else if (arg === '--dry-run') options.write = false;
    else if (arg === '--output') options.targetDir = args[++index];
    else fail('invalid_arguments');
  }
  if (seen.has('--write') && seen.has('--dry-run') || options.write !== Boolean(options.targetDir)) fail('invalid_arguments');
  let connection;
  try { connection = new URL(env.OWNER_NEWS_SOURCE_DATABASE_URL); } catch { fail('source_database_required'); }
  if (!['postgres:', 'postgresql:'].includes(connection.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) ||
    connection.search || connection.hash || !/\b(dev|development|local|test)\b/i.test(decodeURIComponent(connection.pathname).replace(/[_-]/g, ' '))) fail('local_source_required');
  if (typeof env.OWNER_NEWS_SOURCE_ID !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(env.OWNER_NEWS_SOURCE_ID)) fail('source_identity_required');
  if (!env.OWNER_NEWS_SOURCE_UPLOAD_DIR || !path.isAbsolute(env.OWNER_NEWS_SOURCE_UPLOAD_DIR)) fail('source_upload_required');
  return { ...options, connectionString: connection.href, uploadDir: env.OWNER_NEWS_SOURCE_UPLOAD_DIR, instanceId: env.OWNER_NEWS_SOURCE_ID };
}
export async function main(args = process.argv.slice(2), env = process.env) {
  const options = readExportOptions(args, env);
  const { Client } = require('pg');
  const db = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 10000 });
  // pg can emit connection errors while files are being copied. Later snapshot
  // COMMIT must still succeed before a manifest is finalized; never echo pg text.
  db.on('error', () => {});
  try { await db.connect(); return await exportNewsBundle({ ...options, db }); }
  finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(({ mode, manifestSha256, sourceFingerprint, counts }) => console.log(JSON.stringify({ mode, manifestSha256, sourceFingerprint, counts })))
    .catch(error => { console.error(JSON.stringify({ code: error instanceof BundleError ? error.code : 'export_failed' })); process.exitCode = 1; });
}

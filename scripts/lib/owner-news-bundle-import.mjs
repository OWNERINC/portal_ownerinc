import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { identity } from '../import-owner-news.mjs';
import { validateBundle, validateBundleAsset, sourceIdentity, sourceKey, bundleHashes, serializeBundle, privatePath } from './owner-news-bundle.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { validateNewsRevision } = require('./owner-news/editorial.js');
const { canManageCms } = require('./cms/permissions.js');
const { assertNewsWriter } = require('./owner-news/authority.js');
const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const snapshotKeys = ['document_id', 'source_id', 'published_revision_id', 'draft_revision_id', 'scheduled_revision_id', 'scheduled_at', 'published_at', 'title', 'category'];
export class BundleImportError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const block = code => { throw new BundleImportError(code); };
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function targetSnapshot(row) {
  if (!row) return null;
  return Object.fromEntries(snapshotKeys.map(k => [k, k === 'document_id' ? row.id ?? row.document_id
    : ['scheduled_at', 'published_at'].includes(k) ? row[k] == null ? null : new Date(row[k]).toISOString() : row[k] ?? null]));
}
export function planDocumentChange(item, current, revisionId) {
  if (item.action === 'skip') return 'skip';
  if (!current) {
    if (item.target || item.action === 'withdraw') block('Target changed or missing');
    return 'create';
  }
  if (current.content_type !== 'announcement') block('Target changed: content_type');
  const target = item.target;
  if (target && (current.document_id !== target.document_id || current.source_id !== target.source_id)) block('Target changed: identity');
  const published = item.action === 'upsert' && current.published_revision_id === revisionId;
  const drafted = item.action === 'upsert' && current.draft_revision_id === revisionId;
  if (!target && !published && !drafted) block('Unmapped existing target');
  if (published) {
    if (current.title !== item.title || current.category !== item.category) block('Target changed: public metadata');
    return 'existing_published';
  }
  const expected = target || { published_revision_id: null, draft_revision_id: null, scheduled_revision_id: null,
    scheduled_at: null, published_at: null, title: item.title, category: item.category };
  const keys = ['published_revision_id', 'scheduled_revision_id', 'scheduled_at', 'published_at', 'title', 'category'];
  if (!drafted) keys.push('draft_revision_id');
  for (const key of keys) if ((current[key] ?? null) !== (expected[key] ?? null)) block(`Target changed: ${key}`);
  if (item.action === 'upsert' && current.scheduled_revision_id) block('Target changed: scheduled');
  return drafted ? 'existing_draft' : item.action === 'withdraw' ? 'withdraw' : 'draft';
}

function identities(item) {
  const sources = item.sources.map(s => sourceKey(s, item.key));
  if (!sources.includes(item.key)) block('canonical_source_required');
  const raw = item.key.startsWith('reference:') ? item.key.slice(10) : item.key;
  return { sources, documentId: item.target?.document_id || identity('document', raw), sourceId: item.target ? item.target.source_id : sourceIdentity(item.key) };
}
async function directory(uploadDir) {
  await privatePath(uploadDir, { existing: true });
  const root = await fs.realpath(uploadDir);
  if (!(await fs.stat(root)).isDirectory()) block('invalid_upload_directory');
  const result = path.join(root, 'cms-private');
  try { const stat = await fs.lstat(result); if (!stat.isDirectory() || stat.isSymbolicLink()) block('invalid_upload_directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return result;
}
async function verifyFile(asset, directoryPath, fileSystem) {
  const row = asset.row;
  if (!uuid.test(row.storage_key) || row.deleting_at || row.mime_type !== asset.mime
    || Number(row.byte_size) !== asset.byte_size || row.metadata?.sha256 !== asset.sha256) block('asset_conflict');
  const filename = path.join(directoryPath, row.storage_key);
  const stat = await fileSystem.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.byte_size
    || sha(await fileSystem.readFile(filename)) !== asset.sha256) block('asset_file_conflict');
}

// Returns private snapshots to the caller, never logs titles, bodies or database errors.
// Caller owns the transaction. A writable caller must first hold CMS advisory lock.
export async function inspectBundleTarget(db, bundle, { uploadDirectory, fileSystem = fs, lock = false, bundleHash = bundleHashes(bundle).bundle_sha256 } = {}) {
  const items = [], conflicts = [], assets = [];
  const problem = (key, code) => conflicts.push({ key, code });
  for (const item of bundle.items) {
    if (item.action === 'skip') { items.push({ item, change: 'skip' }); continue; }
    const ids = identities(item);
    const { rows } = await db.query(`SELECT * FROM cms_documents WHERE id=$1
      OR (content_type='announcement' AND source_id=ANY($2::uuid[])) ORDER BY id`,
    [ids.documentId, ids.sources.map(sourceIdentity)]);
    const current = rows.find(r => r.id === ids.documentId) || rows[0];
    const entry = { item, ...ids, current: current ? { ...targetSnapshot(current), content_type: current.content_type } : null };
    items.push(entry);
    if (rows.length > 1 || current && (current.id !== ids.documentId || current.source_id !== ids.sourceId)) problem(item.key, 'identity_conflict');
    const collision = await db.query(`SELECT id FROM cms_documents WHERE content_type='announcement'
      AND lower(title)=lower($1) AND id<>$2`, [item.title, ids.documentId]);
    if (collision.rowCount) problem(item.key, 'title_collision');
  }
  const documentIds = [...new Set(items.filter(e => e.current).map(e => e.current.document_id))].sort();
  if (new Set(items.filter(e => e.documentId).map(e => e.documentId)).size !== items.filter(e => e.documentId).length) problem(null, 'duplicate_target');
  const titles = items.filter(e => e.item.action === 'upsert').map(e => e.item.title.toLowerCase());
  if (new Set(titles).size !== titles.length) problem(null, 'title_collision');
  if (lock && documentIds.length) {
    await db.query('SELECT id FROM cms_documents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [documentIds]);
    // A CMS writer can win between discovery and row locking. Read every pointer again.
    const fresh = await db.query('SELECT * FROM cms_documents WHERE id=ANY($1::uuid[]) ORDER BY id', [documentIds]);
    for (const e of items.filter(e => e.current)) {
      const row = fresh.rows.find(r => r.id === e.current.document_id);
      e.current = row ? { ...targetSnapshot(row), content_type: row.content_type } : null;
    }
  }
  const revisions = documentIds.length ? (await db.query(`SELECT * FROM cms_revisions WHERE document_id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [documentIds])).rows : [];
  for (const asset of bundle.assets) {
    const sourceKeys = items.filter(e => e.item.blocks?.some(b => b.asset_key === asset.key)).flatMap(e => e.sources || []);
    const eligibleDocs = items.filter(e => e.item.blocks?.some(b => b.asset_key === asset.key)).map(e => e.current?.document_id).filter(Boolean);
    const mapped = revisions.filter(r => eligibleDocs.includes(r.document_id)).flatMap(r => r.blocks.map(b => b.asset_id).filter(Boolean));
    const id = identity('editorial-asset-sha256', asset.sha256);
    const candidates = (await db.query(`SELECT * FROM cms_assets WHERE id=$1 OR id=ANY($2::uuid[])
      OR (metadata->'source_keys' ?| $3::text[] AND metadata->>'sha256'=$4) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [id, mapped, sourceKeys, asset.sha256])).rows;
    const eligible = row => mapped.includes(row.id) || Array.isArray(row.metadata?.source_keys) && row.metadata.source_keys.some(k => sourceKeys.includes(k));
    const matching = candidates.filter(row => eligible(row) && row.metadata?.sha256 === asset.sha256 && row.mime_type === asset.mime && Number(row.byte_size) === asset.byte_size);
    const row = matching.find(r => r.id === id) || matching[0];
    const entry = { ...asset, id: row?.id || id, row, sourceKeys: [...new Set(sourceKeys)] };
    assets.push(entry);
    if (!row && candidates.some(r => r.id === id)) problem(asset.key, 'asset_identity_conflict');
    if (row && uploadDirectory) {
      try { await verifyFile(entry, uploadDirectory, fileSystem); entry.verified = true; }
      catch { problem(asset.key, 'asset_file_conflict'); }
    } else if (row) problem(asset.key, 'asset_directory_required');
    if (!row && uploadDirectory) {
      try { await fileSystem.lstat(path.join(uploadDirectory, id)); problem(asset.key, 'asset_orphan_file'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  for (const entry of items) {
    const { item, current } = entry;
    if (item.action === 'skip') continue;
    try {
      if (current && (current.document_id !== entry.documentId || current.source_id !== entry.sourceId)) block('identity_conflict');
      if (item.action === 'upsert') {
        const resolved = item.blocks.map(b => {
          if (!b.asset_key) return { ...b };
          const { asset_key, ...rest } = b;
          return { ...rest, asset_id: assets.find(a => a.key === asset_key).id };
        });
        const normalized = validateNewsRevision(resolved, item.editorial, { publishing: true });
        if (!normalized) block('invalid_revision');
        Object.assign(entry, normalized);
        entry.checksum = sha(canonicalJSON({ title: item.title, category: item.category, ...normalized }));
        entry.revisionId = identity('editorial-revision-v1', `${sourceIdentity(item.key)}:${entry.checksum}`);
        // Revisions of the target were already locked before assets. An unrelated
        // deterministic-ID collision is rejected rather than locked out of order.
        const candidate = (await db.query('SELECT * FROM cms_revisions WHERE id=$1', [entry.revisionId])).rows[0];
        if (candidate && (candidate.document_id !== entry.documentId || !isDeepStrictEqual(candidate.blocks, entry.blocks)
          || !isDeepStrictEqual(candidate.editorial, entry.editorial)
          || !['draft', 'published'].includes(candidate.status)
          || (candidate.status === 'draft' ? current?.draft_revision_id !== candidate.id : current?.published_revision_id !== candidate.id))) block('revision_conflict');
        if (current && [current.draft_revision_id, current.published_revision_id].includes(entry.revisionId) && !candidate) block('revision_missing');
        if (candidate && entry.blocks.some(b => b.asset_id && !assets.find(a => a.id === b.asset_id)?.row)) block('asset_missing');
        entry.candidate = candidate;
      } else if (current && item.target) {
        const audit = (await db.query(`SELECT details FROM audit_log WHERE action='owner_news.bundle.withdraw'
          AND target_id=$1 AND details->>'bundle_sha256'=$2 ORDER BY created_at DESC LIMIT 1`, [entry.documentId, bundleHash])).rows[0];
        if (audit && !current.published_revision_id && !current.scheduled_revision_id && !current.scheduled_at && !current.published_at
          && ['document_id', 'source_id', 'title', 'category'].every(k => current[k] === item.target[k])
          && current.draft_revision_id === audit.details.draft_revision_id) { entry.change = 'existing_withdrawn'; continue; }
      }
      entry.change = planDocumentChange(item, current, entry.revisionId);
      // Verify the status/ownership of all live pointers before a write, including withdrawals.
      if (!['existing_published', 'skip'].includes(entry.change) && current) {
        for (const [field, status] of [['published_revision_id', 'published'], ['draft_revision_id', 'draft'], ['scheduled_revision_id', 'scheduled']]) {
          if (current[field] && !revisions.some(r => r.id === current[field] && r.document_id === current.document_id && r.status === status)) block('pointer_conflict');
        }
      }
    } catch (error) { problem(item.key, error instanceof BundleImportError ? error.code : 'target_inspection_failed'); }
  }
  return { items, assets, conflicts };
}

async function checkActor(db, actorUid) {
  const effective = (await db.query(`SELECT current_database() AS database, current_user AS role,
    pg_is_in_recovery() AS recovery,
    (SELECT bool_and(has_table_privilege(current_user,t,p)) FROM
      (VALUES ('cms_documents','SELECT'),('cms_documents','INSERT'),('cms_documents','UPDATE'),
        ('cms_revisions','SELECT'),('cms_revisions','INSERT'),('cms_revisions','UPDATE'),
        ('cms_assets','SELECT'),('cms_assets','INSERT'),('audit_log','SELECT'),('audit_log','INSERT')) AS checks(t,p)) AS permitted`)).rows[0];
  if (!effective?.database || !effective.role || effective.recovery || !effective.permitted) block('invalid_database_role');
  const actor = (await db.query('SELECT role,permissions FROM users WHERE uid=$1 FOR SHARE', [actorUid])).rows[0];
  if (!actor || actor.permissions?.accountDisabled === true || !canManageCms(actor, 'announcement')) block('invalid_actor');
}
async function audit(db, entry, action, actorUid, hashes, extra = {}) {
  await db.query(`INSERT INTO audit_log(actor_uid,action,target_type,target_id,details)
    VALUES ($1,$2,'cms_document',$3,$4::jsonb)`, [actorUid, `owner_news.bundle.${action}`, entry.documentId,
    JSON.stringify({ ...hashes, source_keys: entry.sources, revision_id: entry.revisionId || null, ...extra })]);
}

export async function applyBundle({ pool, uploadDir, bundle, mode = 'dry-run', actorUid, fileSystem = fs,
  root, bundleBytes = serializeBundle(bundle) }) {
  if (!['dry-run', 'apply-draft', 'publish'].includes(mode)) block('invalid_mode');
  // Verify exact input bytes rather than accepting a caller-supplied hash.
  let parsed;
  try { parsed = JSON.parse(bundleBytes.toString()); } catch { block('invalid_manifest'); }
  if (!isDeepStrictEqual(parsed, bundle)) block('manifest_bytes_mismatch');
  try { bundle = await validateBundle(bundle, { root }); }
  catch (error) { block(error.message === 'Item needs_review' ? 'review_required' : 'invalid_manifest'); }
  const uploadDirectory = await directory(uploadDir);
  const buffers = new Map();
  for (const asset of bundle.assets) buffers.set(asset.key, (await validateBundleAsset(asset, { root })).buffer);
  const hashes = { ...bundleHashes(bundle), bundle_sha256: sha(bundleBytes) };
  const report = { mode, ...hashes, databaseChecked: false, prepared: bundle.items.filter(i => i.action === 'upsert').length,
    draftsCreated: 0, published: 0, withdrawn: 0, existing: 0, assetsCreated: 0, assetsReused: 0, verifiedPublications: 0, verifiedAssets: 0 };
  const db = await pool.connect(), written = [];
  let commitAttempted = false;
  try {
    await db.query(mode === 'dry-run' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    // Actor row locks are not legal in a read-only transaction; use the same checked query without a lock.
    await checkActor(mode === 'dry-run' ? { query: (sql, args) => db.query(sql.replace(' FOR SHARE', ''), args) } : db, actorUid);
    if (mode !== 'dry-run') {
      await db.query('SELECT pg_advisory_xact_lock(7193029)');
      await assertNewsWriter(db, 'legacy');
    }
    let state = await inspectBundleTarget(db, bundle, { uploadDirectory, fileSystem, lock: mode !== 'dry-run', bundleHash: hashes.bundle_sha256 });
    report.databaseChecked = true;
    report.conflicts = state.conflicts.map(c => ({ code: c.code }));
    Object.defineProperty(report, 'targets', { value: state.items.map(e => ({ key: e.item.key, target: e.current ? targetSnapshot(e.current) : null, change: e.change })) });
    if (state.conflicts.length && mode !== 'dry-run') block('target_conflict');
    report.assetsReused = new Set(state.assets.filter(a => a.row).map(a => a.id)).size;
    report.verifiedAssets = new Set(state.assets.filter(a => a.verified).map(a => a.id)).size;
    report.existing = state.items.filter(e => e.change?.startsWith('existing_')).length;
    report.verifiedPublications = state.items.filter(e => e.change === 'existing_published').length;
    if (mode === 'dry-run') { await db.query('ROLLBACK'); return report; }
    if (mode === 'publish') {
      for (const e of state.items) if (e.item.action === 'upsert' && !['existing_draft', 'existing_published'].includes(e.change)) block('prepared_draft_required');
      // The draft must have been applied from these exact destination bytes, not merely share content.
      for (const e of state.items.filter(e => e.change === 'existing_draft')) {
        const proof = await db.query(`SELECT id FROM audit_log WHERE action='owner_news.bundle.draft' AND target_id=$1
          AND details->>'bundle_sha256'=$2 AND details->>'revision_id'=$3`, [e.documentId, hashes.bundle_sha256, e.revisionId]);
        if (!proof.rowCount) block('prepared_bundle_required');
      }
    }
    const createdIds = new Set();
    for (const a of state.assets.filter(a => !a.row)) {
      if (mode !== 'apply-draft') block('asset_missing');
      if (createdIds.has(a.id)) continue;
      await fileSystem.mkdir(uploadDirectory, { recursive: true, mode: 0o700 });
      const file = path.join(uploadDirectory, a.id), handle = await fileSystem.open(file, 'wx', 0o600);
      written.push(file);
      try { await handle.writeFile(buffers.get(a.key)); await handle.sync(); } finally { await handle.close(); }
      const sources = [...new Set(state.assets.filter(x => x.id === a.id).flatMap(x => x.sourceKeys))];
      await db.query(`INSERT INTO cms_assets(id,storage_key,original_name,mime_type,byte_size,metadata,uploaded_by)
        VALUES ($1,$1,$2,$3,$4,$5::jsonb,$6)`, [a.id, `owner-news-${a.id}`, a.mime, a.byte_size,
        JSON.stringify({ ...hashes, source_keys: sources, sha256: a.sha256 }), actorUid]);
      createdIds.add(a.id); report.assetsCreated++;
    }
    for (const e of state.items) {
      if (['skip', 'existing_published', 'existing_withdrawn'].includes(e.change)) continue;
      if (mode === 'apply-draft') {
        if (e.item.action === 'withdraw') continue;
        if (e.change !== 'existing_draft') {
          if (e.change === 'create') await db.query(`INSERT INTO cms_documents(id,content_type,source_id,title,category,created_by,updated_by)
            VALUES ($1,'announcement',$2,$3,$4,$5,$5)`, [e.documentId, e.sourceId, e.item.title, e.item.category, actorUid]);
          const version = (await db.query('SELECT COALESCE(MAX(version),0)+1 AS version FROM cms_revisions WHERE document_id=$1', [e.documentId])).rows[0].version;
          await db.query(`INSERT INTO cms_revisions(id,document_id,version,status,blocks,editorial,created_by)
            VALUES ($1,$2,$3,'draft',$4::jsonb,$5::jsonb,$6)`, [e.revisionId, e.documentId, version, JSON.stringify(e.blocks), JSON.stringify(e.editorial), actorUid]);
          await db.query('UPDATE cms_documents SET draft_revision_id=$2,updated_by=$3,updated_at=NOW() WHERE id=$1', [e.documentId, e.revisionId, actorUid]);
          await audit(db, e, 'draft', actorUid, hashes); report.draftsCreated++;
        }
      } else if (e.item.action === 'withdraw') {
        for (const rev of [e.current.published_revision_id, e.current.scheduled_revision_id].filter(Boolean)) await db.query("UPDATE cms_revisions SET status='archived' WHERE id=$1", [rev]);
        await db.query(`UPDATE cms_documents SET published_revision_id=NULL,published_at=NULL,scheduled_revision_id=NULL,
          scheduled_at=NULL,updated_by=$2,updated_at=NOW() WHERE id=$1`, [e.documentId, actorUid]);
        await audit(db, e, 'withdraw', actorUid, hashes, { draft_revision_id: e.current.draft_revision_id,
          previous_published_revision_id: e.current.published_revision_id, previous_scheduled_revision_id: e.current.scheduled_revision_id });
        report.withdrawn++;
      } else {
        if (e.current.published_revision_id) await db.query("UPDATE cms_revisions SET status='archived' WHERE id=$1 AND status='published'", [e.current.published_revision_id]);
        const promoted = await db.query("UPDATE cms_revisions SET status='published' WHERE id=$1 AND document_id=$2 AND status='draft'", [e.revisionId, e.documentId]);
        if (promoted.rowCount !== 1) block('revision_conflict');
        await db.query(`UPDATE cms_documents SET title=$2,category=$3,published_revision_id=$4,published_at=COALESCE(published_at,NOW()),
          draft_revision_id=NULL,updated_by=$5,updated_at=NOW() WHERE id=$1`, [e.documentId, e.item.title, e.item.category, e.revisionId, actorUid]);
        await audit(db, e, 'publish', actorUid, hashes); report.published++;
      }
    }
    state = await inspectBundleTarget(db, bundle, { uploadDirectory, fileSystem, bundleHash: hashes.bundle_sha256 });
    if (state.conflicts.length) block('verification_failed');
    report.verifiedAssets = new Set(state.assets.map(a => a.id)).size;
    report.verifiedPublications = state.items.filter(e => e.change === 'existing_published').length;
    commitAttempted = true;
    await db.query('COMMIT');
    return report;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (!commitAttempted) for (const file of written) await fileSystem.unlink(file);
    if (commitAttempted) block('commit_outcome_unknown');
    throw error;
  } finally { db.release(); }
}

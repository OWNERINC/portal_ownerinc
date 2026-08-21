const fsp = require('node:fs/promises');
const path = require('node:path');
const pool = require('./db');

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const CMS_ASSET_RETENTION_LOCK = 7193029;

function cmsAssetRetentionDays(env = process.env) {
  const value = Number(env.CMS_ASSET_ORPHAN_RETENTION_DAYS || DEFAULT_DAYS);
  if (!Number.isInteger(value) || value < MIN_DAYS || value > MAX_DAYS) throw new Error(`CMS_ASSET_ORPHAN_RETENTION_DAYS must be an integer between ${MIN_DAYS} and ${MAX_DAYS}`);
  return value;
}

async function enforceCmsAssetRetention(db = pool, env = process.env, fileSystem = fsp) {
  const days = cmsAssetRetentionDays(env);
  const uploadDirectory = env.UPLOAD_DIR || '/app/uploads';
  const privateDirectory = path.join(uploadDirectory, 'cms-private');
  try {
    await fileSystem.access(privateDirectory);
  } catch {
    const details = { skipped: true, deletedRows: 0, deletedFiles: 0, fileFailures: 0, retentionDays: days };
    console.log(JSON.stringify({ service: 'cron', event: 'cms_asset_retention_skipped', reason: 'upload_directory_unavailable', ...details }));
    return details;
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CMS_ASSET_RETENTION_LOCK]);
    const { rows } = await client.query(`
    SELECT a.id, a.storage_key
      FROM cms_assets a
     WHERE a.created_at < NOW() - ($1::integer * INTERVAL '1 day')
       AND NOT EXISTS (
         SELECT 1
           FROM cms_revisions r
           CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
          WHERE block->>'asset_id' = a.id::text
       )
     ORDER BY a.created_at
     LIMIT 500`, [days]);
    let deletedRows = 0;
    let deletedFiles = 0;
    let fileFailures = 0;
    for (const asset of rows) {
      try {
        await fileSystem.unlink(path.join(privateDirectory, asset.storage_key));
        deletedFiles += 1;
      } catch (error) {
        if (error.code === 'ENOENT') {
          try {
            await fileSystem.access(privateDirectory);
          } catch {
            throw new Error('CMS private upload directory became unavailable');
          }
        } else {
          fileFailures += 1;
          continue;
        }
      }
      const deleted = await client.query(`
        DELETE FROM cms_assets
         WHERE id = $1
           AND NOT EXISTS (
             SELECT 1
               FROM cms_revisions r
               CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
              WHERE block->>'asset_id' = $1::text
           )`, [asset.id]);
      deletedRows += deleted.rowCount;
    }
    await client.query('COMMIT');
    const result = { deletedRows, deletedFiles, fileFailures, retentionDays: days };
    console.log(JSON.stringify({ service: 'cron', event: 'cms_asset_retention_completed', ...result }));
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { cmsAssetRetentionDays, enforceCmsAssetRetention, CMS_ASSET_RETENTION_LOCK };

const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const pool = require('./db');

const AUTOCARD_MEDIA_RETENTION_LOCK = 7193003;
const STORAGE_KEY_PATTERN = /^autocard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i;
const STORAGE_KEY_SQL_PATTERN = '^autocard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$';

function autocardMediaRetentionDays(env = process.env) {
  const value = Number(env.AUTOCARD_MEDIA_ORPHAN_DAYS || 7);
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error('AutoCard media orphan days must be an integer between 1 and 3650');
  }
  return value;
}

function isSafeStorageKey(storageKey) {
  return typeof storageKey === 'string'
    && STORAGE_KEY_PATTERN.test(storageKey)
    && path.basename(storageKey) === storageKey;
}

function storagePath(uploadDirectory, storageKey) {
  if (!isSafeStorageKey(storageKey)) return null;
  return path.join(uploadDirectory, storageKey);
}

async function uploadDirectoryAvailable(uploadDirectory) {
  try {
    const stats = await fs.stat(uploadDirectory);
    if (!stats.isDirectory()) return false;
    await fs.access(uploadDirectory, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function logFileFailure(storageKey, error) {
  console.error(JSON.stringify({
    service: 'cron',
    event: 'autocard_media_file_cleanup_failed',
    storageKey,
    error: error.message,
  }));
}

function logInvalidStorageKey(storageKey) {
  console.error(JSON.stringify({
    service: 'cron',
    event: 'autocard_media_invalid_storage_key',
    storageKey,
  }));
}

async function removeStorageFile(uploadDirectory, storageKey) {
  const filePath = storagePath(uploadDirectory, storageKey);
  if (!filePath) {
    logInvalidStorageKey(storageKey);
    return { deletedFiles: 0, fileFailures: 1 };
  }
  try {
    await fs.unlink(filePath);
    return { deletedFiles: 1, fileFailures: 0 };
  } catch (error) {
    if (error.code === 'ENOENT') return { deletedFiles: 1, fileFailures: 0 };
    logFileFailure(storageKey, error);
    return { deletedFiles: 0, fileFailures: 1 };
  }
}

async function removeDeletedFiles(uploadDirectory, rows) {
  const counts = { deletedFiles: 0, fileFailures: 0 };
  for (const row of rows) {
    const result = await removeStorageFile(uploadDirectory, row.storage_key);
    counts.deletedFiles += result.deletedFiles;
    counts.fileFailures += result.fileFailures;
  }
  return counts;
}

async function sweepOrphanedFiles(db, uploadDirectory, excludedKeys, cutoff) {
  let entries;
  try {
    entries = await fs.readdir(uploadDirectory, { withFileTypes: true });
  } catch (error) {
    console.error(JSON.stringify({
      service: 'cron',
      event: 'autocard_media_sweep_failed',
      error: error.message,
    }));
    return { deletedFiles: 0, fileFailures: 1 };
  }

  const candidates = [];
  let fileFailures = 0;
  for (const entry of entries) {
    if (!entry.isFile() || excludedKeys.has(entry.name)) continue;
    if (!isSafeStorageKey(entry.name)) {
      if (entry.name.startsWith('autocard-')) logInvalidStorageKey(entry.name);
      continue;
    }
    const filePath = storagePath(uploadDirectory, entry.name);
    try {
      const stats = await fs.stat(filePath);
      if (stats.mtime < cutoff) candidates.push(entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      fileFailures += 1;
      logFileFailure(entry.name, error);
    }
  }

  if (!candidates.length) return { deletedFiles: 0, fileFailures };

  let rows;
  try {
    ({ rows } = await db.query(
      'SELECT storage_key FROM autocard_media WHERE storage_key = ANY($1::text[])',
      [candidates],
    ));
  } catch (error) {
    console.error(JSON.stringify({
      service: 'cron',
      event: 'autocard_media_sweep_failed',
      error: error.message,
    }));
    return { deletedFiles: 0, fileFailures: fileFailures + 1 };
  }

  const knownKeys = new Set(rows.map((row) => row.storage_key));
  const counts = { deletedFiles: 0, fileFailures };
  for (const storageKey of candidates) {
    if (knownKeys.has(storageKey)) continue;
    const result = await removeStorageFile(uploadDirectory, storageKey);
    counts.deletedFiles += result.deletedFiles;
    counts.fileFailures += result.fileFailures;
  }
  return counts;
}

async function insertRetentionAudit(db, details) {
  const { rows } = await db.query(
    `INSERT INTO audit_log (action, target_type, details)
     VALUES ('autocard_media.retention', 'system', $1::jsonb)
     RETURNING id`,
    [JSON.stringify(details)],
  );
  return rows[0].id;
}

async function updateRetentionAudit(db, auditId, details) {
  const result = await db.query(
    `UPDATE audit_log
     SET details = $1::jsonb
     WHERE id = $2
     RETURNING id`,
    [JSON.stringify(details), auditId],
  );
  if (result.rowCount !== 1) throw new Error('AutoCard media retention audit row was not found');
}

async function enforceAutocardMediaRetention() {
  const days = autocardMediaRetentionDays();
  const uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads';
  const db = await pool.connect();
  let locked = false;
  try {
    ({ rows: [{ pg_try_advisory_lock: locked }] } = await db.query(
      'SELECT pg_try_advisory_lock($1)',
      [AUTOCARD_MEDIA_RETENTION_LOCK],
    ));
    if (!locked) {
      const details = { skipped: true, deletedRows: 0, deletedFiles: 0, fileFailures: 0, retentionDays: days };
      console.log(JSON.stringify({ service: 'cron', event: 'autocard_media_retention_skipped', reason: 'lock_unavailable', ...details }));
      return details;
    }

    if (!await uploadDirectoryAvailable(uploadDirectory)) {
      const details = { deletedRows: 0, deletedFiles: 0, fileFailures: 0, retentionDays: days };
      await insertRetentionAudit(db, { status: 'skipped', ...details });
      console.log(JSON.stringify({ service: 'cron', event: 'autocard_media_retention_skipped', reason: 'upload_directory_unavailable', ...details }));
      return { skipped: true, ...details };
    }

    await db.query('BEGIN');
    await db.query('LOCK TABLE autocard_cards IN SHARE MODE');
    const candidateResult = await db.query(
      `SELECT m.id, m.storage_key
       FROM autocard_media AS m
       WHERE m.created_at < NOW() - ($1::integer * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1
           FROM autocard_cards AS c
           WHERE c.media_id = m.id
         )`,
      [days],
    );
    const candidates = candidateResult.rows.filter((row) => {
      if (!isSafeStorageKey(row.storage_key)) {
        logInvalidStorageKey(row.storage_key);
        return false;
      }
      return true;
    });
    const deleted = await db.query(
      `DELETE FROM autocard_media AS m
       WHERE m.id = ANY($1::uuid[])
         AND m.storage_key ~ '${STORAGE_KEY_SQL_PATTERN}'
         AND NOT EXISTS (
           SELECT 1
           FROM autocard_cards AS c
           WHERE c.media_id = m.id
         )
       RETURNING m.id, m.storage_key`,
      [candidates.map((row) => row.id)],
    );
    const pendingDetails = {
      status: 'pending',
      plannedDeletedRows: candidates.length,
      deletedRows: 0,
      deletedFiles: 0,
      fileFailures: 0,
      retentionDays: days,
    };
    const auditId = await insertRetentionAudit(db, pendingDetails);
    await db.query('COMMIT');

    const deletedRows = deleted.rows;
    const deletedFileCounts = await removeDeletedFiles(uploadDirectory, deletedRows);
    const sweptFileCounts = await sweepOrphanedFiles(
      db,
      uploadDirectory,
      new Set(deletedRows.map((row) => row.storage_key)),
      new Date(Date.now() - days * 24 * 60 * 60 * 1000),
    );
    const details = {
      deletedRows: deletedRows.length,
      deletedFiles: deletedFileCounts.deletedFiles + sweptFileCounts.deletedFiles,
      fileFailures: deletedFileCounts.fileFailures + sweptFileCounts.fileFailures,
      retentionDays: days,
    };
    try {
      await updateRetentionAudit(db, auditId, {
        status: 'completed',
        plannedDeletedRows: candidates.length,
        ...details,
      });
    } catch (error) {
      console.error(JSON.stringify({
        service: 'cron',
        event: 'autocard_media_retention_audit_update_failed',
        auditId,
        error: error.message,
      }));
      return details;
    }
    console.log(JSON.stringify({ service: 'cron', event: 'autocard_media_retention_completed', ...details }));
    return details;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock($1)', [AUTOCARD_MEDIA_RETENTION_LOCK]).catch(() => {});
    db.release();
  }
}

module.exports = { autocardMediaRetentionDays, enforceAutocardMediaRetention, isSafeStorageKey };

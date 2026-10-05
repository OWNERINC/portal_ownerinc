// Only SHA-256 hashes enter this store. Authentication/cookie issuance belongs to
// the caller; these helpers never open connections or own transaction boundaries.
async function createSessionRecord(db, { hash, uid, expiresAt }) {
  const { rows } = await db.query(`WITH expired AS (
      SELECT token_hash FROM cms_editor_sessions WHERE expires_at <= NOW()
      ORDER BY expires_at, token_hash LIMIT 100 FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM cms_editor_sessions WHERE token_hash IN (SELECT token_hash FROM expired)
    )
    INSERT INTO cms_editor_sessions(token_hash, user_uid, expires_at, created_at)
    VALUES ($1, $2, $3, clock_timestamp())
    RETURNING user_uid AS uid, expires_at AS "expiresAt"`, [hash, uid, expiresAt]);
  return rows[0];
}

async function findSessionRecord(db, hash) {
  const { rows } = await db.query(`SELECT user_uid AS uid, expires_at AS "expiresAt"
    FROM cms_editor_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > NOW()`, [hash]);
  return rows[0] || null;
}

async function revokeSessionRecord(db, hash) {
  const { rowCount } = await db.query(`UPDATE cms_editor_sessions SET revoked_at=NOW()
    WHERE token_hash=$1 AND revoked_at IS NULL`, [hash]);
  return rowCount > 0;
}

module.exports = { createSessionRecord, findSessionRecord, revokeSessionRecord };

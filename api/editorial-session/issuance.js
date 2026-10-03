// Called on the issuance transaction's dedicated pg client. This lock coordinates
// all API processes for a UID (hash collisions only cause harmless serialization).
// No provider mutation is retried. Space the single attempt from the last committed
// INSERT, including revoked sessions, so second-granularity issuers can advance.
async function prepareSessionIssuance(db, uid) {
  await db.query("SET LOCAL lock_timeout = '3s'");
  await db.query("SET LOCAL statement_timeout = '5s'");
  await db.query('SELECT pg_advisory_xact_lock(7193030, hashtext($1))', [uid]);
  await db.query(`SELECT pg_sleep(LEAST(1.1, GREATEST(0,
    EXTRACT(EPOCH FROM (MAX(created_at) + INTERVAL '1100 milliseconds' - clock_timestamp())))))
    FROM cms_editor_sessions WHERE user_uid=$1`, [uid]);
}

async function sessionHashExists(db, hash) {
  // Include revoked/expired rows. A collision must never revive a credential.
  const { rows } = await db.query('SELECT token_hash FROM cms_editor_sessions WHERE token_hash=$1', [hash]);
  return rows.length > 0;
}

module.exports = { prepareSessionIssuance, sessionHashExists };

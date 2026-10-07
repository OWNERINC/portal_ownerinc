const { lockCmsAssets } = require('../cms/locks');

const AUTHORITY_MODES = new Set(['legacy', 'frozen', 'payload', 'payload_frozen']);

class AuthorityError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function writerAllowed(mode, writer) {
  return (mode === 'legacy' && writer === 'legacy')
    || (mode === 'payload' && writer === 'payload');
}

// The caller owns the client and transaction. Locking readers/mode changes enter
// CMS 7193029 -> authority -> documents, never the reverse order.
async function getAuthority(db, { forUpdate = false } = {}) {
  if (forUpdate) await lockCmsAssets(db);
  const { rows } = await db.query(`SELECT mode, epoch FROM owner_news_authority WHERE singleton=TRUE${forUpdate ? ' FOR UPDATE' : ''}`);
  const authority = rows[0];
  if (!authority || !AUTHORITY_MODES.has(authority.mode)
    || !Number.isSafeInteger(authority.epoch) || authority.epoch <= 0) {
    throw new AuthorityError(503, 'news_authority_unavailable');
  }
  return authority;
}

async function assertNewsWriter(db, writer) {
  const authority = await getAuthority(db, { forUpdate: true });
  if (!writerAllowed(authority.mode, writer)) throw new AuthorityError(409, 'news_read_only');
  return authority;
}

// This is the structural graph, not proof that a cutover/rollback is safe.
// Unknown mutation history is treated as changed.
function validAuthorityTransition(from, to, hasChanges = true) {
  return (from === 'legacy' && to === 'frozen')
    || (from === 'frozen' && ['legacy', 'payload'].includes(to))
    || (from === 'payload' && to === 'payload_frozen')
    || (from === 'payload_frozen' && (to === 'payload' || (to === 'legacy' && hasChanges === false)));
}

// Caller owns BEGIN/COMMIT and actor authentication. Never call the CMS from this
// transaction: Portal lock -> remote CMS lock would invert the writer protocol.
async function transitionAuthority(db, { from, to, expectedEpoch, actorUid, requestId = null } = {}) {
  if (!AUTHORITY_MODES.has(from) || !AUTHORITY_MODES.has(to)
    || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || expectedEpoch >= 2147483647
    || typeof actorUid !== 'string' || !actorUid.trim() || actorUid.length > 128
    || (requestId !== null && (typeof requestId !== 'string' || requestId.length > 128))) {
    throw new AuthorityError(400, 'invalid_authority_transition');
  }
  if (!validAuthorityTransition(from, to, false)) throw new AuthorityError(409, 'invalid_authority_transition');
  // A JSON file / caller boolean is not a verified durable seal or a full ledger.
  // These edges remain unavailable until the real migration/control verifier is
  // integrated. No hash-only or unbound "proof" can activate or roll back data.
  if ((from === 'frozen' && to === 'payload') || (from === 'payload_frozen' && to === 'legacy')) {
    throw new AuthorityError(409, 'news_cutover_proof_required');
  }
  const current = await getAuthority(db, { forUpdate: true });
  if (current.mode !== from || current.epoch !== expectedEpoch) throw new AuthorityError(409, 'news_authority_conflict');
  const { rows } = await db.query(`UPDATE owner_news_authority
    SET mode=$1, epoch=epoch+1, changed_by=$2, changed_at=NOW(),
        manifest_sha256=CASE WHEN $1='legacy' THEN NULL ELSE manifest_sha256 END
    WHERE singleton=TRUE AND mode=$3 AND epoch=$4 RETURNING mode, epoch`,
  [to, actorUid, from, expectedEpoch]);
  if (!rows[0]) throw new AuthorityError(409, 'news_authority_conflict');
  await db.query(`INSERT INTO audit_log(actor_uid,action,target_type,target_id,request_id,details)
    VALUES ($1,'owner_news.authority.transition','owner_news_authority',NULL,$2,$3::jsonb)`,
  [actorUid, requestId, JSON.stringify({ from, to, previousEpoch: expectedEpoch, epoch: rows[0].epoch })]);
  return rows[0];
}

module.exports = { AuthorityError, writerAllowed, getAuthority, assertNewsWriter, validAuthorityTransition, transitionAuthority };

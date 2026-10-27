const { lockCmsAssets } = require('../cms/locks');

const AUTHORITY_MODES = new Set(['legacy', 'frozen', 'payload', 'payload_frozen']);

class AuthorityError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function writerAllowed(mode, writer, activationObserved = false) {
  return (mode === 'legacy' && writer === 'legacy')
    || (mode === 'payload' && writer === 'payload' && activationObserved === true);
}

// The caller owns the client and transaction. Locking readers/mode changes enter
// CMS 7193029 -> authority -> documents, never the reverse order.
async function getAuthority(db, { forUpdate = false } = {}) {
  if (forUpdate) await lockCmsAssets(db);
  const { rows } = await db.query(`SELECT mode, epoch, manifest_sha256, seal_sha256, release_digest,
    image_digest, activation_request_id, activation_observed_at, transition_request_id,
    transition_actor_uid, transition_operator_uid, transition_action
    FROM owner_news_authority WHERE singleton=TRUE${forUpdate ? ' FOR UPDATE' : ''}`);
  const authority = rows[0];
  if (!authority || !AUTHORITY_MODES.has(authority.mode)
    || !Number.isSafeInteger(authority.epoch) || authority.epoch <= 0) {
    throw new AuthorityError(503, 'news_authority_unavailable');
  }
  return authority;
}

async function assertNewsWriter(db, writer) {
  const authority = await getAuthority(db, { forUpdate: true });
  if (!writerAllowed(authority.mode, writer, authority.activation_observed_at instanceof Date
    || typeof authority.activation_observed_at === 'string')) {
    console.error(JSON.stringify({ service: 'api', event: 'legacy_write_refused', reason: 'news_read_only',
      authorityMode: authority.mode, authorityEpoch: authority.epoch,
      writer: ['legacy', 'payload'].includes(writer) ? writer : 'unknown', requestId: 'unassigned' }));
    throw new AuthorityError(409, 'news_read_only');
  }
  return authority;
}

// This is the structural graph, not proof that a cutover/rollback is safe.
// Unknown mutation history is treated as changed.
function validAuthorityTransition(from, to) {
  return (from === 'legacy' && to === 'frozen')
    || (from === 'frozen' && to === 'payload')
    || (from === 'payload' && to === 'payload_frozen')
    || (from === 'payload_frozen' && to === 'payload');
}

// Caller owns BEGIN/COMMIT and actor authentication. Never call the CMS from this
// transaction: Portal lock -> remote CMS lock would invert the writer protocol.
async function transitionAuthority(db, { from, to, expectedEpoch, actorUid, operatorUid, requestId,
  action, evidenceSha256, manifestSha256 = null, sealSha256 = null, releaseDigest = null, imageDigest = null } = {}) {
  if (!AUTHORITY_MODES.has(from) || !AUTHORITY_MODES.has(to)
    || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || expectedEpoch >= 2147483647
    || typeof actorUid !== 'string' || !actorUid.trim() || actorUid.length > 128
    || typeof operatorUid !== 'string' || !operatorUid.trim() || operatorUid.length > 128
    || actorUid === operatorUid || typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)
    || !['freeze', 'freeze-payload', 'resume-payload'].includes(action)
    || typeof evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceSha256)
    || (manifestSha256 !== null && !/^[0-9a-f]{64}$/.test(manifestSha256))
    || (sealSha256 !== null && !/^[0-9a-f]{64}$/.test(sealSha256))
    || (releaseDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(releaseDigest))
    || (imageDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(imageDigest))) {
    throw new AuthorityError(400, 'invalid_authority_transition');
  }
  if (!validAuthorityTransition(from, to)) throw new AuthorityError(409, 'invalid_authority_transition');
  // A JSON file / caller boolean is not a verified durable seal or a full ledger.
  // These edges remain unavailable until the real migration/control verifier is
  // integrated. No hash-only or unbound "proof" can activate or roll back data.
  if (from === 'frozen' && to === 'payload') {
    throw new AuthorityError(409, 'news_cutover_proof_required');
  }
  const current = await getAuthority(db, { forUpdate: true });
  if (current.mode !== from || current.epoch !== expectedEpoch) throw new AuthorityError(409, 'news_authority_conflict');
  const { rows } = await db.query(`UPDATE owner_news_authority
    SET mode=$1, epoch=epoch+1, changed_by=$2, changed_at=NOW(),
        activation_observed_at=NULL,
        activation_request_id=CASE WHEN $5='resume-payload' THEN $3 ELSE activation_request_id END,
        transition_request_id=$3, transition_actor_uid=$4, transition_operator_uid=$2,
        transition_action=$5
    WHERE singleton=TRUE AND mode=$6 AND epoch=$7 RETURNING mode, epoch,
      transition_request_id,transition_actor_uid,transition_operator_uid,transition_action`,
  [to, operatorUid, requestId, actorUid, action, from, expectedEpoch]);
  if (!rows[0]) throw new AuthorityError(409, 'news_authority_conflict');
  await db.query(`INSERT INTO owner_news_authority_transitions
    (request_id,action,actor_uid,operator_uid,from_mode,to_mode,previous_epoch,resulting_epoch,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [requestId, action, actorUid, operatorUid, from, to, expectedEpoch, rows[0].epoch, evidenceSha256]);
  await db.query(`INSERT INTO audit_log(actor_uid,action,target_type,target_id,request_id,details)
    VALUES ($1,'owner_news.authority.transition','owner_news_authority',NULL,$2,$3::jsonb)`,
  [operatorUid, requestId, JSON.stringify({ request_id: requestId, action, actor_uid: actorUid,
    operator_uid: operatorUid, from_mode: from, to_mode: to, previous_epoch: expectedEpoch,
    resulting_epoch: rows[0].epoch, evidence_sha256: evidenceSha256, manifest_sha256: manifestSha256,
    seal_sha256: sealSha256, release_digest: releaseDigest, image_digest: imageDigest })]);
  return rows[0];
}

module.exports = { AuthorityError, writerAllowed, getAuthority, assertNewsWriter, validAuthorityTransition, transitionAuthority };

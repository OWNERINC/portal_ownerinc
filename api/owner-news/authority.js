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

module.exports = { AuthorityError, writerAllowed, getAuthority, assertNewsWriter };

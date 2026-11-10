const { createHash } = require('node:crypto');
const content = require('./term.json');

// The exact document is part of the acceptance identity. Changing even the mock
// text invalidates the prior acceptance; an official term must use a new version.
const term = JSON.parse(JSON.stringify(content));
term.contentHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
for (const section of term.sections) {
  Object.freeze(section.paragraphs);
  Object.freeze(section);
}
Object.freeze(term.sections);
Object.freeze(term);

function isEthicsBootstrapRequest(method, originalUrl) {
  const path = originalUrl.split('?')[0];
  return (method === 'GET' && (path === '/api/users/me' || path === '/api/ethics'))
    || (method === 'POST' && path === '/api/ethics/accept');
}

async function acceptTerm(db, uid) {
  const { rows } = await db.query(
    `INSERT INTO ethics_acceptances (user_uid, term_version, content_sha256, is_mock)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_uid, term_version, content_sha256) DO NOTHING
     RETURNING accepted_at`,
    [uid, term.version, term.contentHash, term.mock],
  );
  if (rows[0]) return rows[0];
  // A retry (including a lost HTTP response) preserves the original timestamp.
  const existing = await db.query(
    `SELECT accepted_at FROM ethics_acceptances
     WHERE user_uid = $1 AND term_version = $2 AND content_sha256 = $3`,
    [uid, term.version, term.contentHash],
  );
  if (!existing.rows[0]) throw new Error('Acceptance could not be confirmed');
  return existing.rows[0];
}

module.exports = { acceptTerm, isEthicsBootstrapRequest, term };

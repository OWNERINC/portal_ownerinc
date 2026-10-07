const { assertNewsWriter } = require('./authority');
const HOME_KEYS = new Set(['version', 'eyebrow', 'headline', 'summary']);

class HomeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function normalizeHome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !HOME_KEYS.has(key)) || value.version !== 1) return null;
  const result = { version: 1 };
  for (const [key, max] of [['eyebrow', 80], ['headline', 160], ['summary', 600]]) {
    const text = value[key];
    if (typeof text !== 'string' || text.length > max || !text.trim()
      || (key !== 'headline' && /[\r\n]/.test(text))
      || /<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(text)) return null;
    result[key] = text.trim();
  }
  return result;
}

function validVersion(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 2147483647;
}

async function getPublishedHome(db) {
  const { rows } = await db.query('SELECT published FROM owner_news_home WHERE singleton=TRUE');
  return normalizeHome(rows[0]?.published);
}

async function getHomeAdmin(db) {
  const { rows } = await db.query('SELECT version, draft, published, published_at FROM owner_news_home WHERE singleton=TRUE');
  return rows[0];
}

async function saveHomeDraft(db, { expected_version, content }, actorUid) {
  const normalized = normalizeHome(content);
  if (!validVersion(expected_version) || !normalized) throw new HomeError(400, 'invalid_home');
  await assertNewsWriter(db, 'legacy');
  const { rows } = await db.query(`UPDATE owner_news_home SET draft=$2::jsonb, version=version+1,
    updated_by=$3, updated_at=NOW()
    WHERE singleton=TRUE AND version=$1
    RETURNING version, draft, published, published_at`, [expected_version, JSON.stringify(normalized), actorUid]);
  if (!rows.length) throw new HomeError(409, 'version_conflict');
  return rows[0];
}

async function publishHome(db, expectedVersion, actorUid) {
  if (!validVersion(expectedVersion)) throw new HomeError(400, 'invalid_home');
  await assertNewsWriter(db, 'legacy');
  const { rows: current } = await db.query('SELECT version, draft FROM owner_news_home WHERE singleton=TRUE FOR UPDATE');
  if (!current[0] || current[0].version !== expectedVersion) throw new HomeError(409, 'version_conflict');
  if (current[0].draft === null) throw new HomeError(409, 'draft_required');
  if (!normalizeHome(current[0].draft)) throw new HomeError(400, 'invalid_home');
  const { rows } = await db.query(`UPDATE owner_news_home SET published=draft, draft=NULL,
    published_at=NOW(), version=version+1, updated_by=$2, updated_at=NOW()
    WHERE singleton=TRUE AND version=$1 AND draft IS NOT NULL
    RETURNING version, draft, published, published_at`, [expectedVersion, actorUid]);
  if (!rows.length) throw new HomeError(409, 'version_conflict');
  return rows[0];
}

module.exports = { HomeError, normalizeHome, validVersion, getPublishedHome, getHomeAdmin, saveHomeDraft, publishHome };

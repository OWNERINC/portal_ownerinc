const { can } = require('./middleware/policy');

const MAX_PAGE_SIZE = 100;

function text(max, required = false) {
  return (value) => value === undefined ? !required
    : typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}

const boolean = (value) => value === undefined || typeof value === 'boolean';
const integer = (min, max) => (value) => value === undefined
  || (Number.isInteger(value) && value >= min && value <= max);
const oneOf = (...values) => (value) => value === undefined || values.includes(value);

function httpUrl(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function uuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function targetUsers(value) {
  return value === undefined || ['all', 'pj', 'clt'].includes(value)
    || (Array.isArray(value) && value.length <= 500 && new Set(value).size === value.length
      && value.every((uid) => typeof uid === 'string' && uid.length > 0 && uid.length <= 128));
}

function validBody(body, schema, required = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (Object.keys(body).some((key) => !schema[key])) return false;
  if (required.some((key) => !(key in body) || body[key] === undefined)) return false;
  return Object.entries(schema).every(([key, validate]) => validate(body[key]));
}

function parseListQuery(query, extra = {}) {
  const allowed = new Set(['limit', 'offset', ...Object.keys(extra)]);
  if (Object.keys(query).some((key) => !allowed.has(key))) return null;
  if (Object.values(query).some((value) => typeof value !== 'string')) return null;

  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE
    || !Number.isInteger(offset) || offset < 0 || offset > 1000000) return null;
  if (Object.entries(extra).some(([key, validate]) => query[key] !== undefined && !validate(query[key]))) return null;
  return { limit, offset };
}

function mayViewAll(user, permission, value) {
  return value === 'true' && can(user, permission);
}

async function withAudit(pool, req, action, targetType, operation, options = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    if (result === undefined || result === null) {
      await client.query('COMMIT');
      return result;
    }
    const targetId = typeof options.targetId === 'function' ? options.targetId(result) : options.targetId;
    const details = typeof options.details === 'function' ? options.details(result) : (options.details || {});
    await client.query(
      `INSERT INTO audit_log (actor_uid, action, target_type, target_id, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [req.user.uid, action, targetType, targetId || null, req.id, JSON.stringify(details)]
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const invalid = (req, res) => res.status(400).json({ error: 'Invalid request.', requestId: req.id });
const forbidden = (req, res) => res.status(403).json({ error: 'Permission denied.', requestId: req.id });

module.exports = {
  boolean, forbidden, httpUrl, integer, invalid, mayViewAll, oneOf, parseListQuery,
  targetUsers, text, uuid, validBody, withAudit,
};

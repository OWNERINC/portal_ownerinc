const { uuid } = require('../route-utils');

const MAX_CURSOR_LENGTH = 1024;
const SOURCES = ['legacy', 'payload'];
const KINDS = ['article', 'edition'];
const invalid = () => Object.assign(new Error('invalid_request'), { status: 400, code: 'invalid_request' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, names) => record(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function timestamp(value) {
  if (value === null) return -Infinity;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid();
  return Date.parse(value);
}

function boundary(value) {
  if (!record(value) || !SOURCES.includes(value.source) || !uuid(value.id)) throw invalid();
  timestamp(value.published_at);
  return { published_at: value.published_at, source: value.source, id: value.id.toLowerCase() };
}

function normalizedFilters(value = {}) {
  if (!record(value) || Object.keys(value).some(key => !['category', 'kind'].includes(key))) throw invalid();
  const category = value.category === undefined ? null : value.category;
  const kind = value.kind === undefined ? null : value.kind;
  if (!(category === null || (typeof category === 'string' && category.length <= 100)) || !(kind === null || KINDS.includes(kind))) throw invalid();
  return { category, kind };
}

function compareNews(a, b) {
  const left = boundary(a), right = boundary(b);
  const leftStamp = timestamp(left.published_at), rightStamp = timestamp(right.published_at);
  if (leftStamp !== rightStamp) return rightStamp > leftStamp ? 1 : -1;
  const sourceOrder = SOURCES.indexOf(left.source) - SOURCES.indexOf(right.source);
  if (sourceOrder) return sourceOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function encodeNewsCursor(item, filters = {}) {
  const point = boundary(item), context = normalizedFilters(filters);
  return Buffer.from(JSON.stringify({ v: 1, ...point, ...context }), 'utf8').toString('base64url');
}

function decodeNewsCursor(value, expectedFilters = {}) {
  if (typeof value !== 'string' || !value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid();
  let decoded;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw invalid();
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch { throw invalid(); }
  const names = ['v', 'published_at', 'source', 'id', 'category', 'kind'];
  if (!exactKeys(decoded, names) || decoded.v !== 1) throw invalid();
  const point = boundary(decoded), actual = normalizedFilters({ category: decoded.category, kind: decoded.kind });
  const expected = normalizedFilters(expectedFilters);
  if (actual.category !== expected.category || actual.kind !== expected.kind) throw invalid();
  return point;
}

function assertUniqueNewsRows(source, rows) {
  if (!SOURCES.includes(source) || !Array.isArray(rows)) throw invalid();
  const seen = new Set();
  for (const row of rows) {
    const point = boundary(row);
    if (point.source !== source || seen.has(point.id)) throw invalid();
    seen.add(point.id);
  }
  return rows;
}

function mergeNewsPages({ legacy, payload, limit, boundary: after, filters = {} }) {
  if (!Array.isArray(legacy) || !Array.isArray(payload) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
  normalizedFilters(filters);
  assertUniqueNewsRows('legacy', legacy);
  assertUniqueNewsRows('payload', payload);
  const point = after === undefined || after === null ? null : boundary(after);
  const candidates = [...legacy, ...payload].sort(compareNews).filter(row => point === null || compareNews(row, point) > 0);
  const rows = candidates.slice(0, limit);
  return { rows, nextCursor: candidates.length > limit ? encodeNewsCursor(rows.at(-1), filters) : null };
}

module.exports = { compareNews, encodeNewsCursor, decodeNewsCursor, mergeNewsPages, assertUniqueNewsRows };

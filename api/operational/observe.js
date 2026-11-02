const { getAuthority } = require('../owner-news/authority');
const { samplePublishedAnnouncementsReadOnly } = require('../cms/reader');
const { signals: defaultSignals } = require('./signals');
const fixed = (id, status, reason) => ({ id, status, reason });

async function readOnly(pool, operation, timeoutMs = 8000) {
  let client, released = false, expired = false, timer;
  const release = destroy => { if (client && !released) { released = true; client.release(destroy); } };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; release(true); reject(new Error('observation_unavailable')); }, timeoutMs);
  });
  const work = (async () => {
    client = await pool.connect();
    if (expired) { release(true); throw new Error('observation_unavailable'); }
    const db = { query: (text, values) => {
      if (expired || released) return Promise.reject(new Error('observation_unavailable'));
      return client.query({ text, values, query_timeout: 2000 });
    } };
    try {
      await db.query('BEGIN READ ONLY');
      await db.query("SET LOCAL statement_timeout='1500ms'");
      await db.query("SET LOCAL lock_timeout='200ms'");
      await db.query("SET LOCAL idle_in_transaction_session_timeout='3000ms'");
      const result = await operation(db);
      await db.query('ROLLBACK'); // Observation owns no commit, including future accidental SQL.
      release(false);
      return result;
    } catch { release(true); throw new Error('observation_unavailable'); }
  })();
  try { return await Promise.race([work, deadline]); }
  finally { clearTimeout(timer); }
}

const AUDIT_SQL = `SELECT a.action,a.details->'operationalNews' AS news,
  COALESCE(d.content_type,rd.content_type) AS content_type
  FROM audit_log a
  LEFT JOIN cms_documents d ON a.target_type='cms_document' AND d.id::text=a.target_id
  LEFT JOIN cms_revisions r ON a.target_type='cms_revision' AND r.id::text=a.target_id
  LEFT JOIN cms_documents rd ON rd.id=r.document_id
  WHERE a.created_at >= NOW()-INTERVAL '24 hours'
    AND a.action=ANY($1::text[])
  ORDER BY a.created_at DESC,a.id DESC LIMIT 201`;
const AUDIT_ACTIONS = Object.freeze(['cms.document.create', 'cms.revision.draft', 'cms.document.publish',
  'cms.document.schedule', 'cms.document.unpublish', 'cms.document.unschedule', 'cms.revision.delete',
  'cms.document.promote', 'cms.document.schedule_invalid', 'owner_news.home.draft', 'owner_news.home.publish']);
function auditCheck(rows) {
  if (!Array.isArray(rows)) return fixed('legacy_writes', 'unknown', 'audit_limit');
  let missing = false;
  for (const row of rows.slice(0, 200)) {
    const value = row.news;
    if (!value) {
      if (!row.content_type || row.content_type === 'announcement' || row.action?.startsWith('owner_news.home.')) missing = true;
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'authorityEpoch,authorityMode,contentType,version'
      || value.version !== 1 || value.contentType !== 'announcement' || !Number.isSafeInteger(value.authorityEpoch)
      || value.authorityEpoch < 1 || !['legacy', 'frozen', 'payload', 'payload_frozen'].includes(value.authorityMode)) { missing = true; continue; }
    if (value.authorityMode !== 'legacy') return fixed('legacy_writes', 'failed', 'legacy_write_forbidden');
  }
  if (rows.length > 200) return fixed('legacy_writes', 'unknown', 'audit_limit');
  // This bounded audit window is operational evidence, never a no-mutations proof.
  return fixed('legacy_writes', missing ? 'unknown' : 'ok', missing ? 'audit_coverage_missing' : 'sampled');
}
async function observe({ pool, signals = defaultSignals, now = Date.now, timeoutMs = 8000 }) {
  const observedAt = now();
  let own;
  try {
    own = await readOnly(pool, async db => {
      const before = await getAuthority(db);
      const sample = await samplePublishedAnnouncementsReadOnly(db);
      const audits = await db.query(AUDIT_SQL, [AUDIT_ACTIONS]);
      const after = await getAuthority(db);
      const changed = before.mode !== after.mode || before.epoch !== after.epoch;
      const sampleReason = changed ? 'authority_changed' : sample.limited ? 'sample_limit' : sample.valid ? 'sampled' : 'sample_invalid';
      return [fixed('portal_database', 'ok', 'ready'),
        fixed('legacy_feed', changed || sample.limited ? 'unknown' : sample.valid ? 'ok' : 'failed', sampleReason),
        auditCheck(audits.rows)];
    }, timeoutMs);
  } catch {
    own = ['portal_database', 'legacy_feed', 'legacy_writes'].map(id => fixed(id, 'unknown', 'database_unavailable'));
  }
  return { schemaVersion: 1, kind: 'portal-operational-observation-v1', source: 'api', generation: signals.generation,
    observedAt, expiresAt: observedAt + 120000, checks: [...own, ...signals.snapshot(),
      ...['cms_readiness', 'cms_bridge', 'authority_barrier'].map(id => fixed(id, 'unknown', 'contract_missing'))] };
}
module.exports = { observe, readOnly, auditCheck, AUDIT_SQL, AUDIT_ACTIONS };

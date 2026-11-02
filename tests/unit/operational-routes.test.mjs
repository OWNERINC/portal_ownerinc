import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { createOperationalHandler } = require('../../api/routes/operational');
const { observe, auditCheck, readOnly } = require('../../api/operational/observe');
const { createSignals } = require('../../api/operational/signals');
const { withOperationalAudit } = require('../../api/operational/audit');
const { assertNewsWriter, setLegacyWriteObserver } = require('../../api/owner-news/authority');
const { samplePublishedAnnouncementsReadOnly } = require('../../api/cms/reader');
const { validateObservation } = require('../../cron/operational-contract');
const epoch = 1800000000000;
const token = 't'.repeat(64);
const response = () => ({ statusCode: 200, set() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });
const request = () => ({ method: 'GET', originalUrl: '/api/operational/observe', headers: { authorization: `Bearer ${token}` } });
test('exact token boundary rejects all alternate input before accessing dependencies', async () => {
  let observations = 0;
  const handler = createOperationalHandler({ env: { OPERATIONAL_MONITOR_TOKEN: token }, pool: {}, now: () => epoch,
    observeImpl: async () => { observations++; return { synthetic: true }; } });
  const rejected = [
    { ...request(), method: 'POST' }, { ...request(), method: 'HEAD' },
    { ...request(), originalUrl: '/api/operational/observe?url=https://attacker.test' },
    { ...request(), originalUrl: '/api/operational/observe/' },
    ...[{ authorization: 'Bearer wrong' }, { authorization: `Bearer ${'x'.repeat(200)}` }, {},
      { ...request().headers, origin: 'https://portal.example.test' }, { ...request().headers, cookie: 'private' },
      { ...request().headers, 'sec-fetch-site': 'same-origin' }, { ...request().headers, 'content-length': '1' },
      { ...request().headers, 'transfer-encoding': 'chunked' }].map(headers => ({ ...request(), headers })),
  ];
  for (const req of rejected) { const res = response(); await handler(req, res); assert.ok([401, 404].includes(res.statusCode)); }
  assert.equal(observations, 0);
  const res = response(); await handler(request(), res); assert.equal(res.statusCode, 200); assert.equal(observations, 1);
  const throttled = response(); await handler(request(), throttled); assert.equal(throttled.statusCode, 429);
});
function database({ auditRows = [], authorityChanges = false, invalidSample = false, budgetExceeded = false } = {}) {
  const calls = [], released = []; let authorityReads = 0;
  const client = { release: value => released.push(value), query: async input => {
    const text = typeof input === 'string' ? input : input.text; calls.push(text);
    if (text.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: authorityChanges ? ++authorityReads : 1 }] };
    if (text.includes('FROM audit_log')) return { rows: auditRows };
    if (text.includes('FROM cms_documents')) return { rows: invalidSample || budgetExceeded ? [{ blocks: null, editorial: null, oversized: budgetExceeded }] : [] };
    return { rows: [] };
  } };
  return { calls, released, pool: { connect: async () => client } };
}
test('API uses read-only bounded transactions and CMS stays explicitly unknown', async () => {
  const { calls, released, pool } = database();
  const signals = createSignals({ now: () => epoch });
  const result = await observe({ pool, signals, now: () => epoch });
  validateObservation(result, 'api', epoch);
  assert.equal(result.checks.find(row => row.id === 'legacy_feed').reason, 'sampled');
  for (const id of ['cms_readiness', 'cms_bridge', 'authority_barrier']) {
    assert.deepEqual(result.checks.find(row => row.id === id), { id, status: 'unknown', reason: 'contract_missing' });
  }
  assert.equal(calls[0], 'BEGIN READ ONLY'); assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(calls.includes("SET LOCAL statement_timeout='1500ms'"));
  assert.ok(calls.every(sql => !/\b(?:INSERT|UPDATE|DELETE|COMMIT)\b|FOR\s+(?:UPDATE|SHARE)|pg_advisory/iu.test(sql)));
  assert.deepEqual(released, [false]);
  assert.doesNotMatch(JSON.stringify(result), /SELECT|password|\.dump|@/);
});
test('read-only sampling distinguishes malformed data from budget limits, permits empty feed, and never promotes', async () => {
  let calls = 0;
  assert.deepEqual(await samplePublishedAnnouncementsReadOnly({ query: async text => {
    calls++; assert.match(text, /LIMIT 3/); assert.match(text, /octet_length\(r\.blocks::text\)/);
    assert.doesNotMatch(text, /UPDATE|INSERT|FOR SHARE|FOR UPDATE|pg_column_size/); return { rows: [] };
  } }), { sampled: 0, limited: false, valid: true });
  assert.equal(calls, 1);
  const { pool } = database({ invalidSample: true });
  const result = await observe({ pool, now: () => epoch });
  assert.equal(result.checks.find(row => row.id === 'legacy_feed').reason, 'sample_invalid');
  const limited = await observe({ pool: database({ budgetExceeded: true }).pool, now: () => epoch });
  assert.equal(limited.checks.find(row => row.id === 'legacy_feed').reason, 'sample_limit');
  assert.equal(limited.checks.find(row => row.id === 'legacy_feed').status, 'unknown');
  const changed = await observe({ pool: database({ authorityChanges: true }).pool, now: () => epoch });
  assert.equal(changed.checks.find(row => row.id === 'legacy_feed').reason, 'authority_changed');
});
test('DB errors produce unknown and private details never escape; stuck/late connections are released', async () => {
  const failed = await observe({ pool: { connect: async () => { throw new Error('postgres://private-canary'); } }, now: () => epoch });
  assert.equal(failed.checks.find(row => row.id === 'portal_database').status, 'unknown');
  assert.doesNotMatch(JSON.stringify(failed), /canary|postgres:\/\//);
  let resolve, destroyed = 0;
  const operation = readOnly({ connect: () => new Promise(done => { resolve = done; }) }, () => assert.fail('late query'), 5);
  await assert.rejects(operation, /observation_unavailable/);
  resolve({ release: destroy => { assert.equal(destroy, true); destroyed++; } });
  await new Promise(done => setImmediate(done)); assert.equal(destroyed, 1);
  const stuck = { release: value => { assert.equal(value, true); destroyed++; }, query: () => new Promise(() => {}) };
  await assert.rejects(readOnly({ connect: async () => stuck }, () => {}, 5), /observation_unavailable/);
  assert.equal(destroyed, 2);
});
test('audit gaps, limit and forbidden write are distinct; compliant writes are not false alarms', () => {
  assert.equal(auditCheck([{ action: 'cms.revision.delete', content_type: null, news: null }]).reason, 'audit_coverage_missing');
  assert.equal(auditCheck(Array(201).fill({})).reason, 'audit_limit');
  assert.equal(auditCheck([{ action: 'cms.document.publish', content_type: 'knowledge', news: null }]).status, 'ok');
  for (const mode of ['legacy', 'frozen', 'payload', 'payload_frozen']) {
    const row = { action: 'cms.document.publish', news: { version: 1, contentType: 'announcement', authorityMode: mode, authorityEpoch: 3 } };
    assert.equal(auditCheck([row]).reason, mode === 'legacy' ? 'sampled' : 'legacy_write_forbidden');
    if (mode === 'payload') assert.equal(auditCheck([row, ...Array(200).fill({})]).reason, 'legacy_write_forbidden');
  }
});
test('legacy audit metadata is in original transaction, does not leak rollback metadata to pooled client', async () => {
  const calls = [];
  const client = { release() {}, query: async (text, values) => {
    calls.push({ text, values });
    return { rows: text.includes('FROM owner_news_authority') ? [{ mode: 'legacy', epoch: 5 }] : [] };
  } };
  const pool = { connect: async () => client }, req = { user: { uid: 'fixture-user' }, id: 'fixture' };
  const result = await withOperationalAudit(pool, req, 'cms.document.publish', 'cms_document', async db => {
    await assertNewsWriter(db, 'legacy'); return { id: 'fixture-document' };
  }, { targetId: row => row.id, details: { existing: true } });
  assert.equal(result.id, 'fixture-document');
  const insert = calls.find(call => call.text.includes('INSERT INTO audit_log'));
  assert.deepEqual(JSON.parse(insert.values[5]), { existing: true, operationalNews: {
    version: 1, contentType: 'announcement', authorityMode: 'legacy', authorityEpoch: 5,
  } });
  assert.equal(calls.at(-1).text, 'COMMIT');
  await assert.rejects(withOperationalAudit(pool, req, 'cms.revision.delete', 'cms_revision', async db => {
    await assertNewsWriter(db, 'legacy'); throw new Error('rollback');
  }), /rollback/);
  calls.length = 0;
  await withOperationalAudit(pool, req, 'cms.document.publish', 'cms_document', async () => ({ id: 'knowledge' }));
  assert.deepEqual(JSON.parse(calls.find(call => call.text.includes('INSERT INTO audit_log')).values[5]), {});
});
test('finite response signals see degraded200, service503 and refused legacy writer only', async () => {
  let now = epoch; const signals = createSignals({ now: () => now });
  const res = new EventEmitter(); res.statusCode = 200; res.getHeader = () => 'degraded';
  signals.middleware({ originalUrl: '/api/announcements?limit=2' }, res, () => {}); res.emit('finish');
  assert.equal(signals.snapshot().find(row => row.id === 'feed_requests').reason, 'read_degraded');
  setLegacyWriteObserver(() => signals.record('legacy_refusals', 'degraded'));
  const db = { query: async () => ({ rows: [{ mode: 'frozen', epoch: 4 }] }) };
  const previous = console.error; console.error = () => {};
  try {
    await assert.rejects(assertNewsWriter(db, 'payload'));
    assert.equal(signals.snapshot().find(row => row.id === 'legacy_refusals').reason, 'coverage_gap');
    await assert.rejects(assertNewsWriter(db, 'legacy'));
    assert.equal(signals.snapshot().find(row => row.id === 'legacy_refusals').reason, 'legacy_refused');
  } finally { console.error = previous; setLegacyWriteObserver(null); }
  now += 300001;
  assert.equal(signals.snapshot().find(row => row.id === 'legacy_refusals').reason, 'quiet');
  assert.equal(signals.snapshot().find(row => row.id === 'feed_requests').reason, 'no_samples');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, chmod, mkdir, rm, symlink } from 'node:fs/promises';
import { closeSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { canonical, signEnvelope, verifyEnvelope, validateEvidence, validateCmsPreflight,
  readPrivateCanonical, writePrivateCanonical, runTransaction, remainingTimeouts, markObserved,
  reconcileState } = require('./owner-news/cutover');
const { transitionAuthority, writerAllowed } = require('./owner-news/authority');
const { observeFeed } = require('./owner-news/gate-e-observer');
const { createPayloadNewsClient } = require('./owner-news/payload-client');

const key = Buffer.from('gate-e-test-key-material-is-32bytes!!');
const sha = 'a'.repeat(64), now = Date.parse('2026-10-27T12:30:00.000Z');
const input = { command: 'activate', epoch: 8, editor: 'editor', operator: 'operator', 'request-id': 'request-8',
  deadline: '2026-10-27T12:59:00.000Z', deadlineMs: Date.parse('2026-10-27T12:59:00.000Z') };
const reference = name => ({ path: `/private/${name}.json`, sha256: sha });
const evidence = { version: 2, kind: 'owner-news-gate-e-evidence-v2', issuedAt: '2026-10-27T12:29:00.000Z',
  expiresAt: input.deadline, requestId: input['request-id'], mode: 'frozen', epoch: 8, commit: 'b'.repeat(40),
  manifestSha256: sha, sealSha256: 'c'.repeat(64), releaseDigest: `sha256:${'d'.repeat(64)}`,
  imageDigest: `sha256:${'e'.repeat(64)}`, editor: input.editor, operator: input.operator,
  receipts: { runtime: reference('runtime'), route: reference('route'), b1: reference('b1'),
    feed: reference('feed'), drain: reference('drain') } };

test('only canonical host-signed evidence is accepted; self-declared/tampered/stale bindings fail', () => {
  const envelope = signEnvelope(evidence, key);
  assert.deepEqual(verifyEnvelope(envelope, key, 'bad'), evidence);
  assert.equal(validateEvidence(evidence, input, sha, now).evidenceSha256, sha);
  assert.throws(() => verifyEnvelope({ ...envelope, body: { ...evidence, epoch: 9 } }, key, 'bad'));
  for (const changed of [{ ...evidence, extra: true }, { ...evidence, expiresAt: '2026-10-27T12:29:30.000Z' },
    { ...evidence, requestId: 'other' }, { ...evidence, operator: 'editor' },
    { ...evidence, receipts: { ...evidence.receipts, feed: { path: 'relative', sha256: sha } } }]) {
    assert.throws(() => validateEvidence(changed, input, sha, now));
  }
});

test('private receipt read is same-FD canonical mode-0600 and no-follow; durable writer never overwrites', async t => {
  const root = await fsTemp(); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'receipt.json'), link = path.join(root, 'link.json');
  await writeFile(file, `${canonical(signEnvelope(evidence, key))}\n`); await chmod(file, 0o600);
  assert.deepEqual((await readPrivateCanonical(file, 'bad')).value.body, evidence);
  try { await symlink(file, link); await assert.rejects(readPrivateCanonical(link, 'bad')); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  await writeFile(file, `${JSON.stringify(signEnvelope(evidence, key), null, 2)}\n`); await chmod(file, 0o600);
  await assert.rejects(readPrivateCanonical(file, 'bad'));
  const output = path.join(root, 'output.json'); await writePrivateCanonical(output, signEnvelope(evidence, key));
  const first = await readFile(output); await assert.rejects(writePrivateCanonical(output, { replaced: true }));
  assert.deepEqual(await readFile(output), first);
});

test('cutover key reader consumes a real inherited Linux FD9', { skip: process.platform !== 'linux' }, async t => {
  const root = await fsTemp(); t.after(() => rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'cutover.key');
  await writeFile(keyFile, key, { mode: 0o600 });
  const descriptor = openSync(keyFile, 'r');
  t.after(() => closeSync(descriptor));
  const script = `const { readKey } = require('./api/owner-news/cutover');\n`
    + `readKey().then(value => process.stdout.write(value.toString('hex'))).catch(error => { console.error(error.code); process.exit(1); });`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OWNER_NEWS_CUTOVER_KEY_FD: '9' },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', descriptor],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, key.toString('hex'));
});

async function fsTemp() {
  const root = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'opencode', `gate-e-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true }); return root;
}

test('CMS activation preflight requires exact runtime/database and sealed manifest epoch', () => {
  const value = { ready: true, publicationMode: 'manual', request: { id: evidence.requestId, deadline: evidence.expiresAt },
    authority: { mode: 'frozen', epoch: 8 }, activation: null, newsEmpty: true,
    runtime: { worker: false, schedules: false, autosave: false, versions: false },
    database: { migrations: true, catalog: true, grants: true, readiness: true },
    mutation: { sequence: '0', chainSha256: '0'.repeat(64), writeBarrier: 'sealed' },
    migration: { runId: '11111111-1111-4111-8111-111111111111', manifestSha256: sha,
      sealSha256: evidence.sealSha256, authorityEpoch: 8, drainReceiptSha256: sha } };
  assert.doesNotThrow(() => validateCmsPreflight(value, 'frozen', 8, evidence));
  for (const changed of [{ ...value, migration: null }, { ...value, migration: { ...value.migration, authorityEpoch: 7 } },
    { ...value, runtime: { ...value.runtime, worker: true } }, { ...value, database: { ...value.database, grants: false } }]) {
    assert.throws(() => validateCmsPreflight(changed, 'frozen', 8, evidence));
  }
});

test('CMS resume preflight is fresh, request-bound and matches existing activation bindings', () => {
  const value = { ready: true, publicationMode: 'manual', request: { id: evidence.requestId, deadline: evidence.expiresAt },
    authority: { mode: 'payload_frozen', epoch: 10 }, newsEmpty: false,
    activation: { manifestSha256: evidence.manifestSha256, sealSha256: evidence.sealSha256,
      releaseDigest: evidence.releaseDigest, imageDigest: evidence.imageDigest, requestId: 'original-activation' },
    runtime: { worker: false, schedules: false, autosave: false, versions: false },
    database: { migrations: true, catalog: true, grants: true, readiness: true },
    mutation: { sequence: '14', chainSha256: 'f'.repeat(64), writeBarrier: 'sealed' },
    migration: { runId: '11111111-1111-4111-8111-111111111111', manifestSha256: evidence.manifestSha256,
      sealSha256: evidence.sealSha256, authorityEpoch: 8, drainReceiptSha256: sha } };
  assert.doesNotThrow(() => validateCmsPreflight(value, 'payload_frozen', 10, evidence));
  for (const changed of [{ ...value, request: { ...value.request, id: 'other' } },
    { ...value, activation: { ...value.activation, imageDigest: `sha256:${sha}` } },
    { ...value, runtime: { ...value.runtime, worker: true } },
    { ...value, mutation: { ...value.mutation, writeBarrier: 'open' } }]) {
    assert.throws(() => validateCmsPreflight(changed, 'payload_frozen', 10, evidence));
  }
});

test('portable observer/client route returns one migration schema for legacy, frozen and payload_frozen', async t => {
  const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const requestId = 'portable-observer', manifest = sha, seal = 'c'.repeat(64);
  let expectedMode = 'legacy', expectedEpoch = 7;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(req.url, '/editorial/api/portal-news/preflight');
    assert.equal(body.input.mode, expectedMode); assert.equal(body.input.epoch, expectedEpoch);
    const bound = expectedMode !== 'legacy';
    const migration = bound ? { runId: '11111111-1111-4111-8111-111111111111', manifestSha256: manifest,
      sealSha256: seal, authorityEpoch: 7, drainReceiptSha256: 'f'.repeat(64) } : null;
    const counts = expectedMode === 'payload_frozen'
      ? { articles: 2, media: 1, homePublished: 0, schedules: 0 }
      : { articles: 0, media: 0, homePublished: 0, schedules: 0 };
    const response = { ready: true, publicationMode: 'manual', request: { id: requestId, deadline },
      authority: { mode: expectedMode, epoch: expectedEpoch },
      activation: expectedMode === 'payload_frozen' ? { manifestSha256: manifest, sealSha256: seal,
        releaseDigest: `sha256:${'d'.repeat(64)}`, imageDigest: `sha256:${'e'.repeat(64)}`,
        requestId: 'original-activation' } : null,
      newsEmpty: Object.values(counts).every(value => value === 0),
      mutation: bound ? { sequence: expectedMode === 'frozen' ? '0' : '3',
        chainSha256: expectedMode === 'frozen' ? '0'.repeat(64) : '9'.repeat(64), writeBarrier: 'sealed',
        barrierRunId: migration.runId, barrierEpoch: 7, barrierReceiptSha256: migration.drainReceiptSha256 }
        : { sequence: '0', chainSha256: '0'.repeat(64), writeBarrier: 'open',
          barrierRunId: null, barrierEpoch: null, barrierReceiptSha256: null },
      counts, runtime: { worker: false, schedules: false, autosave: false, versions: false },
      database: { migrations: true, catalog: true, grants: true, readiness: true }, migration };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const client = createPayloadNewsClient({ baseURL: `http://127.0.0.1:${address.port}`,
    secret: 'portable-observer-secret-is-at-least-32-bytes' });
  const backend = { async list() { return { readState: 'complete', value: { rows: [], nextCursor: null } }; } };
  for (const [mode, epoch] of [['legacy', 7], ['frozen', 7], ['payload_frozen', 10]]) {
    expectedMode = mode; expectedEpoch = epoch;
    const input = { mode, epoch, 'request-id': requestId, deadline,
      'manifest-sha256': mode === 'legacy' ? undefined : manifest,
      'seal-sha256': mode === 'legacy' ? undefined : seal,
      'release-digest': `sha256:${'d'.repeat(64)}`, 'image-digest': `sha256:${'e'.repeat(64)}` };
    const observed = await observeFeed({ pool: {}, input, actor: {}, payloadClient: client, backend });
    assert.deepEqual(observed.migration, mode === 'legacy' ? null : {
      runId: '11111111-1111-4111-8111-111111111111', manifestSha256: manifest,
      sealSha256: seal, authorityEpoch: 7, drainReceiptSha256: 'f'.repeat(64) });
  }
});

const transition = { request_id: 'request-8', action: 'activate', actor_uid: 'editor', operator_uid: 'operator',
  from_mode: 'frozen', to_mode: 'payload', previous_epoch: 8, resulting_epoch: 9, evidence_sha256: sha };
function poolFor({ committed, mismatch = null, audit = 'exact' }) {
  const state = { connections: 0 };
  return { state, async connect() {
    state.connections++; const connection = state.connections;
    return { release() {}, async query(sql) {
      if (sql === 'COMMIT') throw Object.assign(new Error('lost ack'), { committed });
      if (sql.includes('SELECT mode, epoch')) return { rows: connection > 1 && committed ? [{ mode: 'payload', epoch: 9,
        manifest_sha256: sha, seal_sha256: sha, release_digest: `sha256:${sha}`, image_digest: `sha256:${sha}`,
        activation_request_id: 'request-8', activation_observed_at: null, transition_request_id: 'request-8',
        transition_actor_uid: 'editor', transition_operator_uid: mismatch || 'operator', transition_action: 'activate' }] : [] };
      if (sql.includes('FROM owner_news_authority_transitions')) return { rows: [{ ...transition,
        operator_uid: mismatch || transition.operator_uid }] };
      if (sql.includes('FROM audit_log')) {
        if (audit === 'missing') return { rows: [] };
        const row = { actor_uid: 'operator', action: 'owner_news.authority.activate',
          target_type: 'owner_news_authority', target_id: null, request_id: 'request-8',
          details: { ...transition, manifest_sha256: sha, seal_sha256: sha,
            release_digest: `sha256:${sha}`, image_digest: `sha256:${sha}` } };
        if (audit === 'mismatch') row.details.evidence_sha256 = 'b'.repeat(64);
        return { rows: audit === 'duplicate' ? [row, row] : [row] };
      }
      return { rows: [] };
    } };
  } };
}

test('bounded transaction configures all local timeouts below deadline', () => {
  const limits = remainingTimeouts(now + 30_000, now);
  assert.ok(limits.lock <= 5000 && limits.statement <= 15000 && limits.idle <= 20000);
  assert.throws(() => remainingTimeouts(now + 5000, now), { code: 'cutover_deadline_expired' });
});

test('ambiguous COMMIT requires exact state plus actor/operator/request/audit identity and never replays', async () => {
  const expected = { mode: 'payload', epoch: 9, manifest_sha256: sha, seal_sha256: sha,
    release_digest: `sha256:${sha}`, image_digest: `sha256:${sha}`, activation_request_id: 'request-8',
    activation_observed_at: null, transition_request_id: 'request-8', transition_actor_uid: 'editor',
    transition_operator_uid: 'operator', transition_action: 'activate' };
  const pool = poolFor({ committed: true }); let operations = 0;
  const result = await runTransaction(pool, async () => { operations++; }, expected, transition, now + 30_000, () => now);
  assert.equal(result.commit, 'observed_after_ambiguous_commit'); assert.equal(operations, 1); assert.equal(pool.state.connections, 2);
  for (const fixture of [{ committed: false }, { committed: true, mismatch: 'other' },
    { committed: true, audit: 'missing' }, { committed: true, audit: 'duplicate' },
    { committed: true, audit: 'mismatch' }]) {
    const failed = poolFor(fixture); let calls = 0;
    await assert.rejects(runTransaction(failed, async () => { calls++; }, expected, transition, now + 30_000, () => now),
      { code: 'commit_ambiguous_reconciliation_required' });
    assert.equal(calls, 1); assert.equal(failed.state.connections, 2);
  }
});

test('freeze-payload then resume remains read-only until exact observe opens the Payload writer', async () => {
  const state = { mode: 'payload', epoch: 9, manifest_sha256: sha, seal_sha256: 'c'.repeat(64),
    release_digest: `sha256:${'d'.repeat(64)}`, image_digest: `sha256:${'e'.repeat(64)}`,
    activation_request_id: 'activation-9', activation_observed_at: new Date(), transition_request_id: 'activation-9',
    transition_actor_uid: 'editor', transition_operator_uid: 'operator', transition_action: 'observe' };
  const transitions = [], audits = [];
  const db = { async query(sql, values = []) {
    if (sql.includes('SELECT mode, epoch')) return { rows: [{ ...state }] };
    if (sql.includes('UPDATE owner_news_authority') && sql.includes('epoch=epoch+1')) {
      const [to, operator, requestId, actor, action, from, epoch] = values;
      if (state.mode !== from || state.epoch !== epoch) return { rows: [] };
      Object.assign(state, { mode: to, epoch: epoch + 1, activation_observed_at: null,
        activation_request_id: action === 'resume-payload' ? requestId : state.activation_request_id,
        transition_request_id: requestId, transition_actor_uid: actor,
        transition_operator_uid: operator, transition_action: action });
      return { rows: [{ ...state }] };
    }
    if (sql.includes('UPDATE owner_news_authority SET activation_observed_at=NOW()')) {
      state.activation_observed_at = new Date(); state.transition_request_id = values[1];
      state.transition_actor_uid = values[2]; state.transition_operator_uid = values[0]; state.transition_action = 'observe';
      return { rows: [{ ...state }] };
    }
    if (sql.includes('INSERT INTO owner_news_authority_transitions')) { transitions.push(values); return { rows: [] }; }
    if (sql.includes('INSERT INTO audit_log')) { audits.push(values); return { rows: [] }; }
    return { rows: [] };
  } };
  const common = { actorUid: 'editor', operatorUid: 'operator', evidenceSha256: sha };
  await transitionAuthority(db, { from: 'payload', to: 'payload_frozen', expectedEpoch: 9,
    requestId: 'freeze-10', action: 'freeze-payload', ...common });
  assert.equal(state.mode, 'payload_frozen'); assert.equal(writerAllowed(state.mode, 'payload', false), false);
  await transitionAuthority(db, { from: 'payload_frozen', to: 'payload', expectedEpoch: 10,
    requestId: 'resume-11', action: 'resume-payload', ...common });
  assert.equal(state.mode, 'payload'); assert.equal(state.activation_request_id, 'resume-11');
  assert.equal(state.activation_observed_at, null); assert.equal(writerAllowed(state.mode, 'payload', false), false);
  await markObserved(db, { epoch: 11, editor: 'editor', operator: 'operator', 'request-id': 'resume-11' },
    { manifestSha256: state.manifest_sha256, sealSha256: state.seal_sha256,
      releaseDigest: state.release_digest, imageDigest: state.image_digest, evidenceSha256: sha });
  assert.equal(state.transition_action, 'observe'); assert.equal(writerAllowed(state.mode, 'payload', true), true);
  assert.equal(transitions.length, 3); assert.equal(audits.length, 3);
  assert.notEqual(state.mode, 'legacy');
});

function reconciliationPool({ observed = false, auditMismatch = false }) {
  const activation = { ...transition };
  const observation = { ...transition, action: 'observe', from_mode: 'payload', to_mode: 'payload',
    previous_epoch: 9, resulting_epoch: 9 };
  const authority = { mode: 'payload', epoch: 9, manifest_sha256: sha, seal_sha256: 'c'.repeat(64),
    release_digest: `sha256:${'d'.repeat(64)}`, image_digest: `sha256:${'e'.repeat(64)}`,
    activation_request_id: 'request-8', activation_observed_at: observed ? new Date() : null,
    transition_request_id: 'request-8', transition_actor_uid: 'editor', transition_operator_uid: 'operator',
    transition_action: observed ? 'observe' : 'activate' };
  return { async connect() { return { release() {}, async query(sql, values) {
    if (sql.includes('SELECT mode, epoch')) return { rows: [authority] };
    const action = values?.[1];
    if (sql.includes('FROM owner_news_authority_transitions')) {
      const row = action === 'activate' ? activation : observed && action === 'observe' ? observation : null;
      if (sql.includes('SELECT request_id,action FROM')) return { rows: row ? [{ request_id: row.request_id, action }] : [] };
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('FROM audit_log')) {
      const category = action;
      const item = category.endsWith('.activate') ? activation : observed && category.endsWith('.observe') ? observation : null;
      if (sql.includes('SELECT request_id,action FROM')) return { rows: item ? [{ request_id: item.request_id, action: category }] : [] };
      if (!item) return { rows: [] };
      return { rows: [{ actor_uid: 'operator', action: category, target_type: 'owner_news_authority',
        target_id: null, request_id: 'request-8', details: { ...item, manifest_sha256: sha,
          seal_sha256: 'c'.repeat(64), release_digest: `sha256:${'d'.repeat(64)}`,
          image_digest: auditMismatch ? `sha256:${sha}` : `sha256:${'e'.repeat(64)}` } }] };
    }
    return { rows: [] };
  } }; } };
}

test('lost stdout after activate/observe uses a new read-only exact reconciliation', async () => {
  const reconcileInput = { epoch: 9, editor: 'editor', operator: 'operator', 'request-id': 'request-8',
    'expect-action': 'activate', deadlineMs: Date.now() + 30_000 };
  const boundEvidence = { manifestSha256: sha, sealSha256: 'c'.repeat(64),
    releaseDigest: `sha256:${'d'.repeat(64)}`, imageDigest: `sha256:${'e'.repeat(64)}`, evidenceSha256: sha };
  assert.deepEqual(await reconcileState(reconciliationPool({ observed: false }), reconcileInput, boundEvidence),
    { state: 'payload_unobserved', mode: 'payload', epoch: 9 });
  assert.deepEqual(await reconcileState(reconciliationPool({ observed: true }), reconcileInput, boundEvidence),
    { state: 'payload_observed', mode: 'payload', epoch: 9 });
  assert.deepEqual(await reconcileState(reconciliationPool({ observed: true, auditMismatch: true }), reconcileInput, boundEvidence),
    { state: 'diverged' });
});

function freezeReconciliationPool(state = 'frozen', mismatch = false) {
  const freeze = { request_id: 'request-8', action: 'freeze', actor_uid: 'editor', operator_uid: 'operator',
    from_mode: 'legacy', to_mode: 'frozen', previous_epoch: 7, resulting_epoch: 8, evidence_sha256: sha };
  return { async connect() { return { release() {}, async query(sql, values) {
    if (sql.includes('SELECT mode, epoch')) return { rows: [{ mode: state, epoch: state === 'legacy' ? 7 : 8,
      transition_request_id: state === 'frozen' ? 'request-8' : null,
      transition_actor_uid: state === 'frozen' ? 'editor' : null,
      transition_operator_uid: state === 'frozen' ? (mismatch ? 'other' : 'operator') : null,
      transition_action: state === 'frozen' ? 'freeze' : null }] };
    if (sql.includes('FROM owner_news_authority_transitions')) {
      if (state === 'legacy') return { rows: [] };
      return { rows: sql.includes('SELECT request_id,action FROM')
        ? [{ request_id: 'request-8', action: 'freeze' }] : [{ ...freeze, operator_uid: mismatch ? 'other' : 'operator' }] };
    }
    if (sql.includes('FROM audit_log')) {
      if (state === 'legacy') return { rows: [] };
      return { rows: sql.includes('SELECT request_id,action FROM')
        ? [{ request_id: 'request-8', action: 'owner_news.authority.transition' }]
        : [{ actor_uid: mismatch ? 'other' : 'operator', action: 'owner_news.authority.transition',
          target_type: 'owner_news_authority', target_id: null, request_id: 'request-8',
          details: { ...freeze, operator_uid: mismatch ? 'other' : 'operator', manifest_sha256: null,
            seal_sha256: null, release_digest: `sha256:${'d'.repeat(64)}`, image_digest: `sha256:${'e'.repeat(64)}` } }] };
    }
    return { rows: [] };
  } }; } };
}

test('freeze lost output reconciles exact frozen, exact legacy-not-committed, and rejects divergence', async () => {
  const reconcileInput = { epoch: 8, editor: 'editor', operator: 'operator', 'request-id': 'request-8',
    'expect-action': 'freeze', deadlineMs: Date.now() + 30_000 };
  const legacyEvidence = { manifestSha256: null, sealSha256: null, releaseDigest: `sha256:${'d'.repeat(64)}`,
    imageDigest: `sha256:${'e'.repeat(64)}`, evidenceSha256: sha };
  assert.deepEqual(await reconcileState(freezeReconciliationPool('frozen'), reconcileInput, legacyEvidence),
    { state: 'frozen', mode: 'frozen', epoch: 8 });
  assert.deepEqual(await reconcileState(freezeReconciliationPool('legacy'), reconcileInput, legacyEvidence),
    { state: 'freeze_not_committed', mode: 'legacy', epoch: 7 });
  assert.deepEqual(await reconcileState(freezeReconciliationPool('frozen', true), reconcileInput, legacyEvidence),
    { state: 'diverged' });
});

test('workflow uses deploy concurrency, posterior checkout, fresh host guard, deadlines and no runner proof', () => {
  const workflow = readFileSync('.github/workflows/payload-cutover-production.yml', 'utf8');
  assert.match(workflow, /group: portal-ownerinc-production\n  cancel-in-progress: false/u);
  assert.match(workflow, /preflight:[\s\S]*timeout-minutes: 60[\s\S]*activate:[\s\S]*timeout-minutes: 60/u);
  assert.match(workflow, /activate:[\s\S]*actions\/checkout@[0-9a-f]{40}[\s\S]*git rev-parse HEAD[\s\S]*payload-gate-e-guard activate/u);
  assert.doesNotMatch(workflow, /jq -n|upload-artifact|download-artifact|qualified:true|drained:true|proof\.json/u);
  assert.match(workflow, /\/usr\/bin\/sudo -n -u ownerinc-cutover \/usr\/local\/sbin\/payload-gate-e-guard/u);
});

test('host guard consumes FD9 and uses no-follow, canonical HMAC, freshness and durable exclusive publication', () => {
  const guard = readFileSync('ops/payload-gate-e-guard.py', 'utf8');
  for (const pattern of [/os\.fstat\(9\)/u, /O_NOFOLLOW/u, /st_nlink == 1/u, /0o600/u,
    /STATE\.verify_envelope/u, /datetime\.timedelta\(minutes=2\)/u, /os\.link\(temporary, path\)/u,
    /os\.fsync\(directory\)/u, /frozen_reconciliation_required/u]) assert.match(guard, pattern);
});

test('host durable receipt writer completes short writes and rejects zero progress', () => {
  const script = String.raw`
import importlib.util, os, pathlib, tempfile
path = pathlib.Path(r'${path.resolve('ops/payload-gate-e-guard.py').replaceAll('\\', '\\\\')}')
spec = importlib.util.spec_from_file_location('gate_e_guard_test', path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
    destination = os.path.join(root, 'receipt.json')
    original = module.os.write
    def short_write(fd, data):
        chunk = bytes(data[:3])
        return original(fd, chunk)
    module.os.write = short_write
    module.durable_exclusive(destination, b'0123456789abcdef')
    assert open(destination, 'rb').read() == b'0123456789abcdef'
    module.os.write = lambda _fd, _data: 0
    try:
        module.durable_exclusive(os.path.join(root, 'zero.json'), b'abc')
    except module.GateError as error:
        assert str(error) == 'private_receipt_write_failed'
    else:
        raise AssertionError('zero write accepted')
`;
  const result = spawnSync('python', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('portable host guard reconciliation route classifies freeze outcomes without mutation', () => {
  const script = String.raw`
import importlib.util, pathlib
path = pathlib.Path(r'${path.resolve('ops/payload-gate-e-guard.py').replaceAll('\\', '\\\\')}')
spec = importlib.util.spec_from_file_location('gate_e_guard_route_test', path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
request = {'cutover':'/fixed/cutover.js','editor':'editor','operator':'operator','request':'request-8','deadline':'x'}
for payload, expected in [
    ({'state':'frozen','mode':'frozen','epoch':8}, module.FrozenError),
    ({'state':'freeze_not_committed','mode':'legacy','epoch':7}, module.ReconciliationError),
    ({'state':'diverged'}, module.ReconciliationError)]:
    module.child = lambda _args, payload=payload: payload
    try:
        module.reconcile_after_failure(request, '/evidence', '/receipt', 8, 'freeze')
    except expected:
        pass
    else:
        raise AssertionError(payload)
`;
  const result = spawnSync('python', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('migration 037 is rerunnable and stages old payload rows while enforcing new writes', () => {
  const migration = readFileSync('api/db/migrations/037_owner_news_cutover.sql', 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS/u);
  assert.match(migration, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/u);
  assert.match(migration, /owner_news_authority_activation_state_check[\s\S]*NOT VALID/u);
  assert.match(migration, /owner_news_authority_transitions/u);
  assert.match(migration, /PRIMARY KEY \(request_id, action\)/u);
});

const { createHmac, createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { constants, readFile: readFileDescriptor } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AuthorityError, getAuthority, transitionAuthority } = require('./authority');
const { createPayloadNewsClient } = require('./payload-client');

const COMMANDS = new Set(['preflight', 'freeze', 'activate', 'observe', 'freeze-payload', 'resume-payload', 'reconcile']);
const ACTIONS = Object.freeze({ freeze: ['legacy', 'frozen'], activate: ['frozen', 'payload'],
  observe: ['payload', 'payload'], 'freeze-payload': ['payload', 'payload_frozen'],
  'resume-payload': ['payload_frozen', 'payload'] });
const SHA = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CUTOVER_LOCK = 7193030;
const MIGRATION = '037_owner_news_cutover';
const MAX_FILE = 128 * 1024;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code, status = 409) => { throw new AuthorityError(status, code); };

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  fail('cutover_receipt_invalid', 400);
}
const digest = raw => createHash('sha256').update(raw).digest('hex');

function parseDeadline(value, now = Date.now()) {
  const deadline = Date.parse(value || '');
  if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 60 * 60 * 1000) {
    fail('cutover_deadline_invalid', 409);
  }
  return deadline;
}

function parseArguments(args, now = Date.now()) {
  const command = args[0];
  if (!COMMANDS.has(command)) fail('invalid_arguments', 400);
  const options = { command };
  const allowed = new Set(['--epoch', '--editor', '--operator', '--evidence-file', '--receipt-file',
    '--request-id', '--expect-mode', '--expect-action', '--deadline']);
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!allowed.has(flag) || value === undefined || Object.hasOwn(options, flag.slice(2))) fail('invalid_arguments', 400);
    options[flag.slice(2)] = value;
  }
  if (!/^[1-9]\d*$/.test(options.epoch || '') || Number(options.epoch) >= 2147483647
    || !TOKEN.test(options.editor || '') || !TOKEN.test(options.operator || '') || options.editor === options.operator
    || !TOKEN.test(options['request-id'] || '') || !path.isAbsolute(options['evidence-file'] || '')
    || !path.isAbsolute(options['receipt-file'] || '')) fail('invalid_arguments', 400);
  if (command === 'preflight' ? !['legacy', 'frozen', 'payload', 'payload_frozen'].includes(options['expect-mode'])
    : options['expect-mode'] !== undefined) {
    fail('invalid_arguments', 400);
  }
  if (['observe', 'reconcile'].includes(command)
    ? !['freeze', 'activate', 'resume-payload'].includes(options['expect-action']) : options['expect-action'] !== undefined) {
    fail('invalid_arguments', 400);
  }
  options.epoch = Number(options.epoch);
  options.deadlineMs = parseDeadline(options.deadline, now);
  return Object.freeze(options);
}

function trustedUids(env = process.env) {
  if (process.platform === 'win32') return null;
  const values = (env.OWNER_NEWS_CUTOVER_TRUSTED_UIDS || '').split(',').filter(Boolean);
  if (!values.length && typeof process.geteuid === 'function') values.push(String(process.geteuid()));
  if (!values.length || values.some(value => !/^(0|[1-9]\d*)$/.test(value))) fail('cutover_configuration_invalid', 503);
  return new Set(values.map(Number));
}

async function readPrivateCanonical(file, code, env = process.env) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    const uids = trustedUids(env);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > MAX_FILE
      || (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || !uids.has(stat.uid)))) fail(code, 400);
    const raw = await handle.readFile();
    let value;
    try { value = JSON.parse(raw.toString('utf8')); } catch { fail(code, 400); }
    if (!Buffer.from(`${canonical(value)}\n`).equals(raw)) fail(code, 400);
    return { value, raw, sha256: digest(raw) };
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    fail(code, 400);
  } finally { await handle?.close().catch(() => {}); }
}

async function writePrivateCanonical(file, value) {
  const parent = path.dirname(file), temporary = path.join(parent, `.gate-e-${process.pid}-${randomBytes(12).toString('hex')}`);
  const raw = Buffer.from(`${canonical(value)}\n`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
    await fs.link(temporary, file); // atomic no-overwrite publication; symlink destinations fail as existing
    await fs.unlink(temporary);
    if (process.platform !== 'win32') {
      const directory = await fs.open(parent, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {});
    fail(error?.code === 'EEXIST' ? 'cutover_receipt_exists' : 'cutover_receipt_write_failed', 503);
  }
}

async function readKey(key) {
  if (Buffer.isBuffer(key) && key.length >= 32) return key;
  const descriptor = Number(process.env.OWNER_NEWS_CUTOVER_KEY_FD || '9');
  if (!Number.isInteger(descriptor) || descriptor < 3) fail('cutover_configuration_invalid', 503);
  try {
    const raw = await new Promise((resolve, reject) => {
      readFileDescriptor(descriptor, (error, value) => error ? reject(error) : resolve(value));
    });
    if (raw.length < 32 || raw.length > 128) fail('cutover_configuration_invalid', 503);
    return raw;
  } catch { fail('cutover_configuration_invalid', 503); }
}

function signEnvelope(body, key) {
  const unsigned = { body };
  return { body, signature: { algorithm: 'HMAC-SHA256', keyId: digest(key).slice(0, 24),
    value: createHmac('sha256', key).update(canonical(unsigned)).digest('hex') } };
}

function verifyEnvelope(envelope, key, code) {
  if (!exact(envelope, ['body', 'signature']) || !exact(envelope.signature, ['algorithm', 'keyId', 'value'])
    || envelope.signature.algorithm !== 'HMAC-SHA256' || envelope.signature.keyId !== digest(key).slice(0, 24)
    || !SHA.test(envelope.signature.value || '')) fail(code, 400);
  const expected = createHmac('sha256', key).update(canonical({ body: envelope.body })).digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(envelope.signature.value))) fail(code, 400);
  return envelope.body;
}

function validateEvidence(body, input, evidenceSha256, now = Date.now()) {
  const keys = ['version', 'kind', 'issuedAt', 'expiresAt', 'requestId', 'mode', 'epoch', 'commit',
    'manifestSha256', 'sealSha256', 'releaseDigest', 'imageDigest', 'editor', 'operator', 'receipts'];
  const receiptKeys = ['runtime', 'route', 'b1', 'feed', 'drain'];
  const observationOrigin = input['expect-action'] === 'freeze' ? 'legacy'
    : input['expect-action'] === 'resume-payload' ? 'payload_frozen' : 'frozen';
  const expectedMode = input['expect-mode'] || (['observe', 'reconcile'].includes(input.command)
    ? observationOrigin : ACTIONS[input.command]?.[0]);
  const expectedEpoch = ['observe', 'reconcile'].includes(input.command) ? input.epoch - 1 : input.epoch;
  if (!exact(body, keys) || body.version !== 2 || body.kind !== 'owner-news-gate-e-evidence-v2'
    || body.requestId !== input['request-id'] || body.mode !== expectedMode
    || body.epoch !== expectedEpoch || !COMMIT.test(body.commit || '')
    || (body.mode === 'legacy' ? body.manifestSha256 !== null || body.sealSha256 !== null
      : !SHA.test(body.manifestSha256 || '') || !SHA.test(body.sealSha256 || ''))
    || !DIGEST.test(body.releaseDigest || '') || !DIGEST.test(body.imageDigest || '')
    || body.editor !== input.editor || body.operator !== input.operator || body.editor === body.operator
    || !exact(body.receipts, receiptKeys) || (body.mode === 'frozen' ? body.receipts.drain === null : body.receipts.drain !== null)) {
    fail('cutover_evidence_invalid', 400);
  }
  for (const name of receiptKeys) {
    const receipt = body.receipts[name];
    if (receipt === null && name === 'drain' && body.mode !== 'frozen') continue;
    if (!exact(receipt, ['path', 'sha256']) || !path.isAbsolute(receipt.path || '') || !SHA.test(receipt.sha256 || '')) {
      fail('cutover_evidence_invalid', 400);
    }
  }
  const issued = Date.parse(body.issuedAt), expires = Date.parse(body.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > 60 * 60 * 1000
    || now < issued || now >= expires || input.deadlineMs > expires || now >= input.deadlineMs || !SHA.test(evidenceSha256)) {
    fail('cutover_evidence_stale', 409);
  }
  return Object.freeze({ ...body, evidenceSha256 });
}

function receiptBody(input, evidence, mode, epoch, now = Date.now()) {
  return { version: 2, kind: 'owner-news-gate-e-preflight-v2', issuedAt: new Date(now).toISOString(),
    expiresAt: evidence.expiresAt, requestId: input['request-id'], mode, epoch, editor: input.editor,
    operator: input.operator, deadline: input.deadline, commit: evidence.commit,
    manifestSha256: evidence.manifestSha256, sealSha256: evidence.sealSha256,
    releaseDigest: evidence.releaseDigest, imageDigest: evidence.imageDigest,
    evidenceSha256: evidence.evidenceSha256, receipts: evidence.receipts };
}

function verifyPreflightReceipt(envelope, input, evidence, key, modes, epochs, now = Date.now()) {
  const body = verifyEnvelope(envelope, key, 'cutover_receipt_invalid');
  const expectedEpochs = Array.isArray(epochs) ? epochs : [epochs];
  if (!exact(body, ['version', 'kind', 'issuedAt', 'expiresAt', 'requestId', 'mode', 'epoch', 'editor', 'operator',
    'deadline', 'commit', 'manifestSha256', 'sealSha256', 'releaseDigest', 'imageDigest', 'evidenceSha256', 'receipts'])
    || body.version !== 2 || body.kind !== 'owner-news-gate-e-preflight-v2' || !modes.includes(body.mode)
    || !expectedEpochs.includes(body.epoch) || body.requestId !== input['request-id'] || body.editor !== input.editor
    || body.operator !== input.operator || body.deadline !== input.deadline || body.commit !== evidence.commit
    || body.manifestSha256 !== evidence.manifestSha256 || body.sealSha256 !== evidence.sealSha256
    || body.releaseDigest !== evidence.releaseDigest || body.imageDigest !== evidence.imageDigest
    || body.evidenceSha256 !== evidence.evidenceSha256 || canonical(body.receipts) !== canonical(evidence.receipts)
    || Date.parse(body.expiresAt) <= now || input.deadlineMs > Date.parse(body.expiresAt)) fail('cutover_receipt_mismatch', 409);
  return body;
}

async function databasePreflight(db, expectedMode, expectedEpoch, evidence) {
  const authority = await getAuthority(db);
  if (authority.mode !== expectedMode || authority.epoch !== expectedEpoch) fail('news_authority_conflict');
  const { rows: [checks] } = await db.query(`SELECT
    EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS migration_ok,
    to_regclass('public.owner_news_authority_transitions') IS NOT NULL AS catalog_ok,
    has_table_privilege(current_user,'public.owner_news_authority','SELECT')
      AND has_table_privilege(current_user,'public.owner_news_authority','UPDATE')
      AND has_table_privilege(current_user,'public.owner_news_authority_transitions','SELECT')
      AND has_table_privilege(current_user,'public.owner_news_authority_transitions','INSERT') AS grants_ok,
    NOT pg_is_in_recovery() AS readiness_ok`, [MIGRATION]);
  if (!checks || !Object.values(checks).every(value => value === true)) fail('cutover_database_preflight_failed', 503);
  const { rows: actors } = await db.query(`SELECT uid, role, permissions FROM users
    WHERE uid=ANY($1::text[]) ORDER BY uid`, [[evidence.editor, evidence.operator]]);
  const byUid = new Map(actors.map(actor => [actor.uid, actor]));
  const editor = byUid.get(evidence.editor), operator = byUid.get(evidence.operator);
  if (editor?.permissions?.manageKnowledge !== true || operator?.role !== 'admin'
    || operator.permissions?.manageKnowledge !== true) fail('cutover_identity_invalid', 403);
  return authority;
}

async function defaultCmsPreflight(evidence, env = process.env) {
  const client = createPayloadNewsClient({ baseURL: env.PAYLOAD_INTERNAL_URL, secret: env.PORTAL_TO_PAYLOAD_SECRET });
  const input = { mode: evidence.mode, epoch: evidence.epoch, requestId: evidence.requestId, deadline: evidence.expiresAt };
  if (evidence.mode !== 'legacy') Object.assign(input, { manifestSha256: evidence.manifestSha256,
    sealSha256: evidence.sealSha256, releaseDigest: evidence.releaseDigest, imageDigest: evidence.imageDigest });
  return client.preflight(input, { requestId: evidence.requestId });
}

function validateCmsPreflight(value, expectedMode, expectedEpoch, evidence) {
  if (!value || value.ready !== true || value.publicationMode !== 'manual' || value.authority?.mode !== expectedMode
    || value.authority?.epoch !== expectedEpoch || value.request?.id !== evidence?.requestId
    || value.request?.deadline !== evidence?.expiresAt || typeof value.newsEmpty !== 'boolean' || value.runtime?.worker !== false
    || value.runtime?.schedules !== false || value.runtime?.autosave !== false || value.runtime?.versions !== false
    || value.database?.migrations !== true || value.database?.catalog !== true || value.database?.grants !== true
    || value.database?.readiness !== true || (expectedMode === 'legacy'
      ? value.activation !== null || value.migration !== null || value.newsEmpty !== true || value.mutation?.writeBarrier !== 'open'
      : value.migration?.manifestSha256 !== evidence?.manifestSha256
        || value.migration?.sealSha256 !== evidence?.sealSha256 || value.mutation?.writeBarrier !== 'sealed'
        || (expectedMode === 'frozen' ? value.activation !== null || value.migration?.authorityEpoch !== expectedEpoch
          || value.newsEmpty !== true
          : expectedMode !== 'payload_frozen' || value.activation?.manifestSha256 !== evidence?.manifestSha256
            || value.activation?.sealSha256 !== evidence?.sealSha256
            || value.activation?.releaseDigest !== evidence?.releaseDigest
            || value.activation?.imageDigest !== evidence?.imageDigest
            || !TOKEN.test(value.activation?.requestId || '') || value.migration?.authorityEpoch >= expectedEpoch))) {
    fail('payload_preflight_failed', 503);
  }
}

function transitionIdentity(input, evidence, action, from, to, previousEpoch, resultingEpoch) {
  return { request_id: input['request-id'], action, actor_uid: input.editor, operator_uid: input.operator,
    from_mode: from, to_mode: to, previous_epoch: previousEpoch, resulting_epoch: resultingEpoch,
    evidence_sha256: evidence.evidenceSha256 };
}

function auditAction(action) {
  if (action === 'activate') return 'owner_news.authority.activate';
  if (action === 'observe') return 'owner_news.authority.observe';
  return 'owner_news.authority.transition';
}

function evidenceBindings(value = {}) {
  return { manifest_sha256: value.manifestSha256 ?? value.manifest_sha256 ?? null,
    seal_sha256: value.sealSha256 ?? value.seal_sha256 ?? null,
    release_digest: value.releaseDigest ?? value.release_digest ?? null,
    image_digest: value.imageDigest ?? value.image_digest ?? null };
}

async function exactTransitionAudit(db, transition, bindings = evidenceBindings()) {
  const { rows: transitions } = await db.query(`SELECT request_id,action,actor_uid,operator_uid,from_mode,to_mode,
    previous_epoch,resulting_epoch,evidence_sha256 FROM owner_news_authority_transitions
    WHERE request_id=$1 AND action=$2`, [transition.request_id, transition.action]);
  if (transitions.length !== 1 || canonical(transitions[0]) !== canonical(transition)) return false;
  const category = auditAction(transition.action);
  const { rows: audits } = await db.query(`SELECT actor_uid,action,target_type,target_id,request_id,details
    FROM audit_log WHERE request_id=$1 AND action=$2 AND details->>'action'=$3`,
  [transition.request_id, category, transition.action]);
  const expected = { actor_uid: transition.operator_uid, action: category, target_type: 'owner_news_authority',
    target_id: null, request_id: transition.request_id, details: { ...transition, ...bindings } };
  return audits.length === 1 && canonical(audits[0]) === canonical(expected);
}

async function exactRecordCounts(db, requestId, action) {
  const category = auditAction(action);
  const { rows: transitions } = await db.query(`SELECT request_id,action FROM owner_news_authority_transitions
    WHERE request_id=$1 AND action=$2`, [requestId, action]);
  const { rows: audits } = await db.query(`SELECT request_id,action FROM audit_log
    WHERE request_id=$1 AND action=$2 AND details->>'action'=$3`, [requestId, category, action]);
  return { transitions: transitions.length, audits: audits.length };
}

async function exactExistingTransitionAudit(db, expected, bindings = evidenceBindings()) {
  const { rows } = await db.query(`SELECT request_id,action,actor_uid,operator_uid,from_mode,to_mode,
    previous_epoch,resulting_epoch,evidence_sha256 FROM owner_news_authority_transitions
    WHERE request_id=$1 AND action=$2`, [expected.request_id, expected.action]);
  if (rows.length !== 1 || !SHA.test(rows[0].evidence_sha256 || '')) return false;
  const { evidence_sha256: _ignored, ...actual } = rows[0];
  if (canonical(actual) !== canonical(expected)) return false;
  return exactTransitionAudit(db, rows[0], bindings);
}

async function observeState(pool, expected, transition) {
  const db = await pool.connect();
  try {
    const authority = await getAuthority(db);
    const stateMatches = Object.entries(expected).every(([name, value]) => typeof value === 'function'
      ? value(authority[name]) : authority[name] === value);
    if (!stateMatches) return null;
    return await exactTransitionAudit(db, transition, evidenceBindings(expected)) ? authority : null;
  } finally { db.release(); }
}

async function reconcileState(pool, input, evidence) {
  const action = input['expect-action'];
  const previousEpoch = input.epoch - 1;
  const fromMode = action === 'freeze' ? 'legacy' : action === 'activate' ? 'frozen' : 'payload_frozen';
  const toMode = action === 'freeze' ? 'frozen' : 'payload';
  const transition = transitionIdentity(input, evidence, action,
    fromMode, toMode, previousEpoch, input.epoch);
  const observed = transitionIdentity(input, evidence, 'observe', 'payload', 'payload', input.epoch, input.epoch);
  const db = await pool.connect();
  let transactionOpen = false;
  try {
    const limits = remainingTimeouts(input.deadlineMs);
    await db.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    transactionOpen = true;
    await db.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$3,true)",
      [`${limits.lock}ms`, `${limits.statement}ms`, `${limits.idle}ms`]);
    const conclude = async result => {
      await db.query('COMMIT');
      transactionOpen = false;
      return result;
    };
    const authority = await getAuthority(db);
    const bindings = evidenceBindings(evidence);
    const actionExact = await exactTransitionAudit(db, transition, bindings);
    if (action === 'freeze') {
      if (authority.mode === 'frozen' && authority.epoch === input.epoch
        && authority.transition_request_id === input['request-id']
        && authority.transition_actor_uid === input.editor && authority.transition_operator_uid === input.operator
        && authority.transition_action === 'freeze' && actionExact) {
        return await conclude({ state: 'frozen', mode: 'frozen', epoch: input.epoch });
      }
      if (authority.mode === 'legacy' && authority.epoch === previousEpoch) {
        const counts = await exactRecordCounts(db, input['request-id'], 'freeze');
        return await conclude(counts.transitions === 0 && counts.audits === 0
          ? { state: 'freeze_not_committed', mode: 'legacy', epoch: previousEpoch } : { state: 'diverged' });
      }
      return await conclude({ state: 'diverged' });
    }
    if (authority.mode === 'payload' && authority.epoch === input.epoch
      && authority.manifest_sha256 === evidence.manifestSha256 && authority.seal_sha256 === evidence.sealSha256
      && authority.release_digest === evidence.releaseDigest && authority.image_digest === evidence.imageDigest
      && authority.activation_request_id === input['request-id']) {
      if (!actionExact) return await conclude({ state: 'diverged' });
      const observeCounts = await exactRecordCounts(db, input['request-id'], 'observe');
      if (authority.activation_observed_at === null) {
        return await conclude(authority.transition_request_id === input['request-id']
          && authority.transition_actor_uid === input.editor && authority.transition_operator_uid === input.operator
          && authority.transition_action === action
          && observeCounts.transitions === 0 && observeCounts.audits === 0
          ? { state: 'payload_unobserved', mode: 'payload', epoch: input.epoch } : { state: 'diverged' });
      }
      return await conclude(authority.transition_request_id === input['request-id']
        && authority.transition_actor_uid === input.editor && authority.transition_operator_uid === input.operator
        && authority.transition_action === 'observe' && await exactTransitionAudit(db, observed, bindings)
        ? { state: 'payload_observed', mode: 'payload', epoch: input.epoch } : { state: 'diverged' });
    }
    if (action === 'activate' && authority.mode === 'frozen' && authority.epoch === previousEpoch) {
      const freeze = { request_id: input['request-id'], action: 'freeze', actor_uid: input.editor,
        operator_uid: input.operator, from_mode: 'legacy', to_mode: 'frozen',
        previous_epoch: previousEpoch - 1, resulting_epoch: previousEpoch };
      const actionCounts = await exactRecordCounts(db, input['request-id'], 'activate');
      return await conclude(previousEpoch > 1 && await exactExistingTransitionAudit(db, freeze, {
        manifest_sha256: null, seal_sha256: null, release_digest: evidence.releaseDigest,
        image_digest: evidence.imageDigest })
        && actionCounts.transitions === 0 && actionCounts.audits === 0
        ? { state: 'frozen', mode: 'frozen', epoch: previousEpoch } : { state: 'diverged' });
    }
    if (action === 'resume-payload' && authority.mode === 'payload_frozen' && authority.epoch === previousEpoch
      && authority.manifest_sha256 === evidence.manifestSha256 && authority.seal_sha256 === evidence.sealSha256
      && authority.release_digest === evidence.releaseDigest && authority.image_digest === evidence.imageDigest) {
      const actionCounts = await exactRecordCounts(db, input['request-id'], 'resume-payload');
      return await conclude(actionCounts.transitions === 0 && actionCounts.audits === 0
        ? { state: 'payload_frozen', mode: 'payload_frozen', epoch: previousEpoch } : { state: 'diverged' });
    }
    return await conclude({ state: 'diverged' });
  } catch (error) {
    if (transactionOpen) await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { db.release(); }
}

function remainingTimeouts(deadlineMs, now = Date.now()) {
  const remaining = deadlineMs - now;
  if (remaining <= 6000) fail('cutover_deadline_expired', 409);
  return { lock: Math.min(5000, remaining - 5000), statement: Math.min(15000, remaining - 4000),
    idle: Math.min(20000, remaining - 3000) };
}

async function transaction(pool, operation, expectedAfter, transition, deadlineMs, now = Date.now) {
  const db = await pool.connect();
  let commitStarted = false;
  try {
    const limits = remainingTimeouts(deadlineMs, now());
    await db.query('BEGIN');
    await db.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true),set_config('idle_in_transaction_session_timeout',$3,true)",
      [`${limits.lock}ms`, `${limits.statement}ms`, `${limits.idle}ms`]);
    await db.query('SELECT pg_advisory_xact_lock($1)', [CUTOVER_LOCK]);
    if (now() >= deadlineMs) fail('cutover_deadline_expired', 409);
    const result = await operation(db);
    commitStarted = true;
    await db.query('COMMIT');
    return { result, commit: 'acknowledged' };
  } catch (error) {
    if (!commitStarted) await db.query('ROLLBACK').catch(() => {});
    if (!commitStarted) throw error;
    const observed = await observeState(pool, expectedAfter, transition).catch(() => null);
    if (observed) return { result: observed, commit: 'observed_after_ambiguous_commit' };
    throw new AuthorityError(503, 'commit_ambiguous_reconciliation_required');
  } finally { db.release(); }
}

async function insertTransition(db, identity) {
  await db.query(`INSERT INTO owner_news_authority_transitions
    (request_id,action,actor_uid,operator_uid,from_mode,to_mode,previous_epoch,resulting_epoch,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, Object.values(identity));
}

async function activate(db, input, evidence) {
  const current = await getAuthority(db, { forUpdate: true });
  if (current.mode !== 'frozen' || current.epoch !== input.epoch) fail('news_authority_conflict');
  const { rows } = await db.query(`UPDATE owner_news_authority SET mode='payload', epoch=epoch+1,
    manifest_sha256=$1, seal_sha256=$2, release_digest=$3, image_digest=$4,
    activation_request_id=$5, activation_observed_at=NULL, changed_by=$6, changed_at=NOW(),
    transition_request_id=$5,transition_actor_uid=$7,transition_operator_uid=$6,transition_action='activate'
    WHERE singleton=TRUE AND mode='frozen' AND epoch=$8 RETURNING mode,epoch,manifest_sha256,seal_sha256,
      release_digest,image_digest,activation_request_id,activation_observed_at,transition_request_id,
      transition_actor_uid,transition_operator_uid,transition_action`,
  [evidence.manifestSha256, evidence.sealSha256, evidence.releaseDigest, evidence.imageDigest,
    input['request-id'], input.operator, input.editor, input.epoch]);
  if (!rows[0]) fail('news_authority_conflict');
  const identity = transitionIdentity(input, evidence, 'activate', 'frozen', 'payload', input.epoch, input.epoch + 1);
  await insertTransition(db, identity);
  await db.query(`INSERT INTO audit_log(actor_uid,action,target_type,request_id,details)
    VALUES($1,'owner_news.authority.activate','owner_news_authority',$2,$3::jsonb)`,
  [input.operator, input['request-id'], JSON.stringify({ ...identity, ...evidenceBindings(evidence) })]);
  return rows[0];
}

async function markObserved(db, input, evidence) {
  const current = await getAuthority(db, { forUpdate: true });
  const matches = current.mode === 'payload' && current.epoch === input.epoch
    && current.manifest_sha256 === evidence.manifestSha256 && current.seal_sha256 === evidence.sealSha256
    && current.release_digest === evidence.releaseDigest && current.image_digest === evidence.imageDigest
    && current.activation_request_id === input['request-id'];
  if (!matches || current.activation_observed_at) fail('commit_ambiguous_reconciliation_required', 503);
  const { rows } = await db.query(`UPDATE owner_news_authority SET activation_observed_at=NOW(),changed_by=$1,
    changed_at=NOW(),transition_request_id=$2,transition_actor_uid=$3,transition_operator_uid=$1,
    transition_action='observe' WHERE singleton=TRUE AND mode='payload' AND epoch=$4
      AND activation_observed_at IS NULL AND manifest_sha256=$5 AND seal_sha256=$6
      AND release_digest=$7 AND image_digest=$8 AND activation_request_id=$2
    RETURNING mode,epoch,activation_observed_at,transition_request_id,transition_actor_uid,
      transition_operator_uid,transition_action`,
  [input.operator, input['request-id'], input.editor, input.epoch, evidence.manifestSha256,
    evidence.sealSha256, evidence.releaseDigest, evidence.imageDigest]);
  if (!rows[0]) fail('commit_ambiguous_reconciliation_required', 503);
  const identity = transitionIdentity(input, evidence, 'observe', 'payload', 'payload', input.epoch, input.epoch);
  await insertTransition(db, identity);
  await db.query(`INSERT INTO audit_log(actor_uid,action,target_type,request_id,details)
    VALUES($1,'owner_news.authority.observe','owner_news_authority',$2,$3::jsonb)`,
  [input.operator, input['request-id'], JSON.stringify({ ...identity, ...evidenceBindings(evidence) })]);
  return rows[0];
}

async function run({ input, pool, env = process.env, cmsPreflight = defaultCmsPreflight, now = Date.now(), key }) {
  if (now >= input.deadlineMs) fail('cutover_deadline_expired', 409);
  const signingKey = await readKey(key);
  const evidenceFile = await readPrivateCanonical(input['evidence-file'], 'cutover_evidence_invalid', env);
  const evidence = validateEvidence(verifyEnvelope(evidenceFile.value, signingKey, 'cutover_evidence_invalid'),
    input, evidenceFile.sha256, now);
  if (input.command === 'preflight') {
    const db = await pool.connect();
    try {
      await databasePreflight(db, input['expect-mode'], input.epoch, evidence);
      if (['legacy', 'frozen', 'payload_frozen'].includes(input['expect-mode'])) {
        validateCmsPreflight(await cmsPreflight(evidence, env), input['expect-mode'], input.epoch, evidence);
      }
      await writePrivateCanonical(input['receipt-file'], signEnvelope(receiptBody(input, evidence,
        input['expect-mode'], input.epoch, now), signingKey));
      return { command: 'preflight', status: 'ready', mode: input['expect-mode'], epoch: input.epoch,
        evidenceSha256: evidence.evidenceSha256, expiresAt: evidence.expiresAt };
    } finally { db.release(); }
  }
  const receiptFile = await readPrivateCanonical(input['receipt-file'], 'cutover_receipt_invalid', env);
  const observedOrigin = input['expect-action'] === 'freeze' ? 'legacy'
    : input['expect-action'] === 'resume-payload' ? 'payload_frozen' : 'frozen';
  const receiptEpoch = ['observe', 'reconcile'].includes(input.command) ? input.epoch - 1 : input.epoch;
  verifyPreflightReceipt(receiptFile.value, input, evidence, signingKey,
    ['observe', 'reconcile'].includes(input.command) ? [observedOrigin] : [ACTIONS[input.command][0]], receiptEpoch, now);
  if (input.command === 'reconcile') return reconcileState(pool, input, evidence);
  const [from, to] = ACTIONS[input.command];
  const resultingEpoch = input.command === 'observe' ? input.epoch : input.epoch + 1;
  const identity = transitionIdentity(input, evidence, input.command, from, to, input.epoch, resultingEpoch);
  const commonState = { mode: to, epoch: resultingEpoch, transition_request_id: input['request-id'],
    transition_actor_uid: input.editor, transition_operator_uid: input.operator, transition_action: input.command };
  if (input.command === 'freeze') {
    return transaction(pool, db => transitionAuthority(db, { from, to, expectedEpoch: input.epoch,
      actorUid: input.editor, operatorUid: input.operator, requestId: input['request-id'], action: input.command,
      evidenceSha256: evidence.evidenceSha256, manifestSha256: evidence.manifestSha256,
      sealSha256: evidence.sealSha256, releaseDigest: evidence.releaseDigest,
      imageDigest: evidence.imageDigest }), commonState, identity, input.deadlineMs);
  }
  if (input.command === 'activate') {
    const db = await pool.connect();
    try { await databasePreflight(db, 'frozen', input.epoch, evidence);
      validateCmsPreflight(await cmsPreflight(evidence, env), 'frozen', input.epoch, evidence); } finally { db.release(); }
    return transaction(pool, client => activate(client, input, evidence), { ...commonState,
      manifest_sha256: evidence.manifestSha256, seal_sha256: evidence.sealSha256,
      release_digest: evidence.releaseDigest, image_digest: evidence.imageDigest,
      activation_request_id: input['request-id'], activation_observed_at: null }, identity, input.deadlineMs);
  }
  if (input.command === 'observe') {
    return transaction(pool, db => markObserved(db, input, evidence), { ...commonState,
      manifest_sha256: evidence.manifestSha256, seal_sha256: evidence.sealSha256,
      release_digest: evidence.releaseDigest, image_digest: evidence.imageDigest,
      activation_request_id: input['request-id'], activation_observed_at: value => value instanceof Date || typeof value === 'string' },
    identity, input.deadlineMs);
  }
  if (input.command === 'resume-payload') {
    const db = await pool.connect();
    try {
      await databasePreflight(db, 'payload_frozen', input.epoch, evidence);
      validateCmsPreflight(await cmsPreflight(evidence, env), 'payload_frozen', input.epoch, evidence);
    } finally { db.release(); }
  }
  const expectedState = input.command === 'resume-payload'
    ? { ...commonState, activation_request_id: input['request-id'], activation_observed_at: null,
      manifest_sha256: evidence.manifestSha256, seal_sha256: evidence.sealSha256,
      release_digest: evidence.releaseDigest, image_digest: evidence.imageDigest }
    : commonState;
  return transaction(pool, db => transitionAuthority(db, { from, to, expectedEpoch: input.epoch,
    actorUid: input.editor, operatorUid: input.operator, requestId: input['request-id'], action: input.command,
    evidenceSha256: evidence.evidenceSha256, manifestSha256: evidence.manifestSha256,
    sealSha256: evidence.sealSha256, releaseDigest: evidence.releaseDigest,
    imageDigest: evidence.imageDigest }), expectedState, identity, input.deadlineMs);
}

module.exports = { parseArguments, canonical, signEnvelope, verifyEnvelope, validateEvidence,
  validateCmsPreflight, readPrivateCanonical, writePrivateCanonical, run, observeState,
  reconcileState, exactTransitionAudit, markObserved, runTransaction: transaction, remainingTimeouts, readKey, CUTOVER_LOCK };

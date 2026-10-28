const { createHash } = require('node:crypto');
const { createNewsBackend } = require('./backend');
const { decodeNewsCursor } = require('./feed');
const { getAuthority } = require('./authority');
const { createPayloadNewsClient } = require('./payload-client');
const { canonical, signEnvelope, writePrivateCanonical, readKey } = require('./cutover');

const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const refuse = code => { throw Object.assign(new Error(code), { code }); };

function parseObserverArguments(args, now = Date.now()) {
  const kind = args[0];
  if (!['feed', 'drain'].includes(kind)) refuse('invalid_arguments');
  const result = { kind };
  const allowed = new Set(['--epoch', '--mode', '--editor', '--operator', '--request-id', '--commit',
    '--release-digest', '--image-digest', '--manifest-sha256', '--seal-sha256', '--deadline', '--receipt-file']);
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || value === undefined || Object.hasOwn(result, key.slice(2))) refuse('invalid_arguments');
    result[key.slice(2)] = value;
  }
  const deadline = Date.parse(result.deadline || '');
  if (!/^[1-9]\d*$/.test(result.epoch || '') || !['legacy', 'frozen', 'payload', 'payload_frozen'].includes(result.mode)
    || !TOKEN.test(result.editor || '') || !TOKEN.test(result.operator || '') || result.editor === result.operator
    || !TOKEN.test(result['request-id'] || '') || !COMMIT.test(result.commit || '')
    || !DIGEST.test(result['release-digest'] || '') || !DIGEST.test(result['image-digest'] || '')
    || (result.mode !== 'legacy' && (!/^[0-9a-f]{64}$/.test(result['manifest-sha256'] || '')
      || !/^[0-9a-f]{64}$/.test(result['seal-sha256'] || '')))
    || !Number.isFinite(deadline) || deadline <= now || deadline - now > 60 * 60 * 1000
    || typeof result['receipt-file'] !== 'string') refuse('invalid_arguments');
  result.epoch = Number(result.epoch); result.deadlineMs = deadline;
  return Object.freeze(result);
}

async function observeFeed({ pool, input, actor, payloadClient: suppliedClient, backend: suppliedBackend }) {
  const payloadClient = suppliedClient || createPayloadNewsClient({
    baseURL: process.env.PAYLOAD_INTERNAL_URL || process.env.CMS_INTERNAL_URL,
    secret: process.env.PORTAL_TO_PAYLOAD_SECRET,
  });
  const backend = suppliedBackend || createNewsBackend({ pool, payloadClient, logger: () => {} });
  const first = await backend.list({ limit: 2, offset: 0 }, actor, { requestId: input['request-id'] });
  if (first.readState !== 'complete' || !Array.isArray(first.value?.rows)) refuse('dual_feed_unqualified');
  const identities = new Set();
  for (const row of first.value.rows) {
    if (!['legacy', 'payload'].includes(row.source) || typeof row.id !== 'string') refuse('dual_feed_unqualified');
    const identity = `${row.source}:${row.id}`;
    if (identities.has(identity)) refuse('dual_feed_unqualified'); identities.add(identity);
  }
  let secondPageRows = 0;
  if (first.value.nextCursor) {
    const boundary = decodeNewsCursor(first.value.nextCursor, { category: undefined, kind: undefined });
    const second = await backend.list({ limit: 2, offset: 0, boundary }, actor, { requestId: input['request-id'] });
    if (second.readState !== 'complete' || !Array.isArray(second.value?.rows)) refuse('dual_feed_unqualified');
    secondPageRows = second.value.rows.length;
  }
  let migration = null;
  if (['legacy', 'frozen', 'payload_frozen'].includes(input.mode)) {
    const bound = { mode: input.mode, epoch: input.epoch, requestId: input['request-id'], deadline: input.deadline };
    if (input.mode !== 'legacy') Object.assign(bound, { manifestSha256: input['manifest-sha256'],
      sealSha256: input['seal-sha256'], releaseDigest: input['release-digest'], imageDigest: input['image-digest'] });
    const preflight = await payloadClient.preflight(bound, { requestId: input['request-id'] });
    migration = preflight.migration;
    if (input.mode === 'legacy' ? migration !== null
      : migration?.manifestSha256 !== input['manifest-sha256'] || migration?.sealSha256 !== input['seal-sha256']
        || (input.mode === 'frozen' && migration?.authorityEpoch !== input.epoch)) {
      refuse('migration_seal_unverified');
    }
  }
  return { sourcesObserved: ['legacy', 'payload'], firstPageRows: first.value.rows.length, secondPageRows,
    cursorInvariant: 'v1-filter-bound-source-id-null-last-legacy-first',
    migration,
    observationSha256: digest(canonical({ rows: first.value.rows.map(row => [row.source, row.id]),
      nextCursor: first.value.nextCursor || null, secondPageRows })) };
}

async function observeDrain({ pool, input }) {
  if (input.mode !== 'frozen') refuse('writer_drain_requires_frozen');
  const db = await pool.connect();
  try {
    const authority = await getAuthority(db);
    if (authority.mode !== 'frozen' || authority.epoch !== input.epoch) refuse('writer_drain_authority_changed');
    const { rows: activity } = await db.query(`SELECT pid::text FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle'
        AND (query ~* '(cms_documents|cms_revisions|owner_news_home|owner_news_authority)'
          OR application_name ~* '(portal|ownerinc|payload|cms)') ORDER BY pid LIMIT 2`);
    const { rows: locks } = await db.query(`SELECT l.pid::text FROM pg_locks l
      WHERE l.granted AND l.pid<>pg_backend_pid() AND l.mode IN ('RowExclusiveLock','ShareRowExclusiveLock','ExclusiveLock')
        AND l.relation=ANY(ARRAY[to_regclass('public.cms_documents'),to_regclass('public.cms_revisions'),
          to_regclass('public.owner_news_home'),to_regclass('public.owner_news_authority')]) ORDER BY l.pid LIMIT 2`);
    if (activity.length || locks.length) refuse('writers_not_drained');
    return { authority: { mode: authority.mode, epoch: authority.epoch }, activeWriters: 0,
      conflictingLocks: 0, observationSha256: digest(canonical({ mode: authority.mode, epoch: authority.epoch,
        activeWriters: 0, conflictingLocks: 0 })) };
  } finally { db.release(); }
}

async function produceObservation({ pool, input, now = Date.now(), key }) {
  if (now >= input.deadlineMs) refuse('cutover_deadline_expired');
  const db = await pool.connect();
  let actor;
  try {
    const authority = await getAuthority(db);
    if (authority.mode !== input.mode || authority.epoch !== input.epoch) refuse('news_authority_conflict');
    if (['payload', 'payload_frozen'].includes(input.mode) && (authority.manifest_sha256 !== input['manifest-sha256']
      || authority.seal_sha256 !== input['seal-sha256']
      || authority.release_digest !== input['release-digest'] || authority.image_digest !== input['image-digest'])) {
      refuse('observation_binding_mismatch');
    }
    const { rows } = await db.query('SELECT uid,email,name,permissions FROM users WHERE uid=$1', [input.editor]);
    if (!rows[0] || rows[0].permissions?.manageKnowledge !== true) refuse('cutover_identity_invalid');
    actor = { uid: rows[0].uid, email: rows[0].email, name: rows[0].name, canManageNews: true };
  } finally { db.release(); }
  const observation = input.kind === 'feed' ? await observeFeed({ pool, input, actor }) : await observeDrain({ pool, input });
  const body = { version: 1, kind: `owner-news-${input.kind}-observation-v1`, issuedAt: new Date(now).toISOString(),
    expiresAt: input.deadline, requestId: input['request-id'], mode: input.mode, epoch: input.epoch,
    commit: input.commit, releaseDigest: input['release-digest'], imageDigest: input['image-digest'],
    editor: input.editor, operator: input.operator, observation };
  const signingKey = await readKey(key);
  await writePrivateCanonical(input['receipt-file'], signEnvelope(body, signingKey));
  return { kind: input.kind, receiptSha256: digest(Buffer.from(`${canonical(signEnvelope(body, signingKey))}\n`)),
    expiresAt: input.deadline };
}

module.exports = { parseObserverArguments, observeFeed, observeDrain, produceObservation };

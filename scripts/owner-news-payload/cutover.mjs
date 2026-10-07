import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { transitionAuthority, AuthorityError } = require('./owner-news/authority');
const { canManageCms } = require('./cms/permissions');
const commands = Object.freeze({
  'freeze-legacy': ['legacy', 'frozen'], 'unfreeze-legacy': ['frozen', 'legacy'],
  'activate-payload': ['frozen', 'payload'], 'freeze-payload': ['payload', 'payload_frozen'],
  'resume-payload': ['payload_frozen', 'payload'], 'rollback-before-edit': ['payload_frozen', 'legacy'],
});

export function parseCutoverArguments(args) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(commands, command)) throw new AuthorityError(400, 'invalid_arguments');
  let epoch, apply = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--apply' && !apply) apply = true;
    else if (rest[i] === '--epoch' && epoch === undefined && /^[1-9]\d*$/.test(rest[i + 1] || '')) epoch = Number(rest[++i]);
    else throw new AuthorityError(400, 'invalid_arguments');
  }
  if (!Number.isSafeInteger(epoch) || epoch >= 2147483647) throw new AuthorityError(400, 'invalid_arguments');
  const [from, to] = commands[command];
  return { command, from, to, expectedEpoch: epoch, apply };
}

export async function runCutover({ pool, input, actorUid, requestId = randomUUID() }) {
  // Safe default: planning does not connect to a database or imply readiness.
  if (!input.apply) return { command: input.command, from: input.from, to: input.to,
    expectedEpoch: input.expectedEpoch, applied: false, readinessVerified: false };
  if (['activate-payload', 'rollback-before-edit'].includes(input.command)) {
    throw new AuthorityError(409, 'news_cutover_proof_required');
  }
  if (typeof actorUid !== 'string' || !actorUid.trim() || actorUid.length > 128) throw new AuthorityError(400, 'invalid_actor');
  const db = await pool.connect();
  let commitAttempted = false;
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '5s'");
    const { rows } = await db.query('SELECT role, permissions FROM users WHERE uid=$1 FOR SHARE', [actorUid]);
    const actor = rows[0];
    if (!actor || [true, 'true'].includes(actor.permissions?.accountDisabled)
      || [true, 'true'].includes(actor.permissions?.firebase_enable_pending)
      || !canManageCms(actor, 'announcement')) throw new AuthorityError(403, 'invalid_actor');
    const authority = await transitionAuthority(db, { ...input, actorUid, requestId });
    commitAttempted = true;
    await db.query('COMMIT');
    return { command: input.command, ...authority, actorUid, requestId, applied: true,
      // freeze-payload closes admission; it is NEVER a completed CMS drain proof.
      ...(input.command === 'freeze-payload' ? { cmsDrainConfirmed: false } : {}) };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    if (commitAttempted) throw new AuthorityError(503, 'commit_outcome_unknown');
    throw error;
  } finally { db.release(); }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const input = parseCutoverArguments(args);
  if (!input.apply) return runCutover({ input });
  if (['activate-payload', 'rollback-before-edit'].includes(input.command)) throw new AuthorityError(409, 'news_cutover_proof_required');
  let url;
  try { url = new URL(env.OWNER_NEWS_CONTROL_DATABASE_URL); } catch { throw new AuthorityError(400, 'explicit_database_required'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1) || url.search || url.hash) {
    throw new AuthorityError(400, 'invalid_database_configuration');
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  try { return await runCutover({ pool, input, actorUid: env.OWNER_NEWS_ACTOR_UID }); }
  finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ error: 'Cutover blocked', reason: error instanceof AuthorityError ? error.code : 'cutover_failed' }));
    process.exitCode = 1;
  });
}

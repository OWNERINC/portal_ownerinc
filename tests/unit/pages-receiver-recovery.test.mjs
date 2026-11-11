import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const receiver = await readFile(new URL('../../ops/deploy-from-ci.sh', import.meta.url), 'utf8');
const names = ['pages', 'page_revisions', 'page_revision_job_titles', 'page_media', 'page_revision_media', 'page_requests'];
const bash = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
function extractFunction(name) {
  const matches = [...receiver.matchAll(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, 'gm'))];
  assert.equal(matches.length, 1, `one actual receiver function: ${name}`);
  return matches[0][0];
}
function productionSql() {
  const matches = [...receiver.matchAll(/<<'PAGES_RECOVERY_SQL'\n([\s\S]*?)\nPAGES_RECOVERY_SQL/g)];
  assert.equal(matches.length, 1, 'one literal production recovery SQL block');
  return `${matches[0][1]}\n`;
}
function toc(tables = [], extra = '') {
  return `; Archive created at synthetic-test\n;     Format: CUSTOM\n;     TOC Entries: 100\n; Selected TOC Entries:\n${['users', 'job_titles', 'schema_migrations', ...tables].map((name, index) => `${index + 1}; 1259 ${100 + index} TABLE public ${name} synthetic_owner`).join('\n')}\n${extra}`;
}
async function probe(options = {}) {
  const helpers = ['stop_container', 'stop_services', 'verify_recovery_backup', 'classify_backup_pages', 'cleanup_new_pages', 'restore_previous_database', 'rollback'].map(extractFunction).join('\n\n');
  const base = join(tmpdir(), 'opencode'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'pages-receiver-test-'));
  try {
    for (const name of ['backup', 'runtime', 'previous']) await mkdir(join(directory, name));
    const dump = Buffer.from('synthetic dump consumed only by a command double');
    const uploads = Buffer.from('synthetic uploads');
    await writeFile(join(directory, 'backup/postgres.dump'), dump);
    await writeFile(join(directory, 'backup/uploads.tar.gz'), uploads);
    const manifest = [[dump, 'postgres.dump'], [uploads, 'uploads.tar.gz']].map(([bytes, name]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`).join('');
    await writeFile(join(directory, 'backup/manifest.sha256'), options.manifest ?? manifest);
    await writeFile(join(directory, 'toc'), options.toc ?? toc());
    const script = `set -uo pipefail
fixture=$FIXTURE_DIRECTORY
if command -v cygpath >/dev/null 2>&1; then fixture=$(cygpath -u "$fixture"); fi
events="$fixture/events"
: >"$events"
backup="$fixture/backup"
runtime="$fixture/runtime"
current="$fixture/previous"
current_file="$fixture/current-release"
release="$current"
target=synthetic
postgres_container=fake-postgres
web_container=fake-web
api_container=fake-api
cron_container=fake-cron
public_url=http://synthetic.invalid
requested_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
backup_complete=$BACKUP_COMPLETE
backup_pages_state=$BACKUP_PAGES_STATE
migration_started=$MIGRATION_STARTED
public_started=$PUBLIC_STARTED
services_stopped=true
event() { printf '%s\\n' "$1" >>"$events"; }
docker() {
  printf '%s\\n' "$*" >>"$fixture/arguments"
  local last=\${@: -1}
  if [[ $1 == inspect ]]; then
    if [[ $* == *State.Running* ]]; then
      if [[ -e "$fixture/$last.stopped" ]]; then printf 'false\\n'; else printf 'true\\n'; fi
    fi
    return 0
  fi
  if [[ $1 == stop ]]; then
    event "stop:$2"
    [[ $FAILURE != stop ]] || return 1
    touch "$fixture/$2.stopped"
    return 0
  fi
  [[ $1 == exec && $* == *fake-postgres* ]] || { event unexpected-docker; return 99; }
  if [[ $* == *'pg_restore --list'* ]]; then
    event toc
    cat >"$fixture/toc-input"
    [[ $FAILURE != toc ]] || return 1
    cat "$fixture/toc"
  elif [[ $* == *'pg_restore --clean'* ]]; then
    event restore
    cat >"$fixture/restore-input"
    [[ $FAILURE != restore ]] || return 1
  elif [[ $* == *firebase_cleanup_queue* ]]; then
    event legacy
    [[ $FAILURE != legacy ]] || return 1
  elif [[ $* == *psql* ]]; then
    event sql
    cat >"$fixture/captured.sql"
    [[ $FAILURE != sql ]] || return 1
  else
    event unexpected-docker
    return 99
  fi
}
sha256sum() {
  event checksum
  [[ $FAILURE != checksum ]] || return 1
  command sha256sum "$@"
}
compose_for() { event restart; [[ $FAILURE != restart ]]; }
curl() { event ready; return 0; }
wait_for_healthy_cron() { event cron; return 0; }
sleep() { event unexpected-sleep; return 99; }
${helpers}
if [[ $MODE == classify ]]; then
  classify_backup_pages
  exit $?
fi
false
rollback
`;
    await writeFile(join(directory, 'probe.sh'), script);
    const result = spawnSync(bash, ['-c', 'script=$FIXTURE_DIRECTORY/probe.sh; if command -v cygpath >/dev/null 2>&1; then script=$(cygpath -u "$script"); fi; exec bash "$script"'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, BASH_ENV: '', ENV: '', FIXTURE_DIRECTORY: directory, MODE: options.mode || 'rollback', FAILURE: options.failure || '',
        BACKUP_COMPLETE: options.backupComplete ?? 'true', BACKUP_PAGES_STATE: options.state ?? 'absent',
        MIGRATION_STARTED: options.migrationStarted ?? 'true', PUBLIC_STARTED: options.publicStarted ?? 'false' }
    });
    assert.ifError(result.error);
    const readOptional = async name => readFile(join(directory, name), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { ...result, events: (await readOptional('events')).trim().split('\n').filter(Boolean), sql: await readOptional('captured.sql'),
      args: await readOptional('arguments'), tocInput: await readOptional('toc-input'), restoreInput: await readOptional('restore-input'), dump: dump.toString() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('receiver classifies a verified backup before migrations and reuses one transaction SQL', () => {
  assert.match(receiver, /backup_pages_state=unknown/);
  const classify = receiver.indexOf('backup_pages_state=$(classify_backup_pages)');
  const migrate = receiver.indexOf('migration_started=true');
  assert.ok(classify > receiver.indexOf('verify_recovery_backup\n'), 'manifest checked before initial classification');
  assert.ok(classify < migrate, 'classification precedes the first migration');
  const sql = productionSql();
  assert.match(sql, /^BEGIN;/); assert.match(sql, /COMMIT;\n$/);
  assert.match(sql, /SET LOCAL row_security = off/);
  assert.match(sql, /rolsuper OR rolbypassrls/);
  assert.match(sql, /IN ACCESS EXCLUSIVE MODE/);
  assert.doesNotMatch(sql, /CASCADE|GRANT|DELETE FROM|TRUNCATE/);
});
test('pre-public pre-Pages rollback stops, verifies, guards, restores and only then restarts', async () => {
  const result = await probe();
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.events, ['stop:fake-web', 'stop:fake-api', 'stop:fake-cron', 'checksum', 'toc', 'sql', 'legacy', 'restore', 'restart', 'ready', 'cron']);
  assert.equal(result.sql, productionSql(), 'the production command receives the exact rehearsal SQL');
  assert.equal(result.tocInput, result.dump); assert.equal(result.restoreInput, result.dump);
  assert.match(result.args, /psql -X -v ON_ERROR_STOP=1/);
  assert.match(result.args, /pg_restore --clean --if-exists --no-owner --single-transaction/);
});
test('a backup containing all Pages tables bypasses special cleanup, not ordinary restore', async () => {
  const result = await probe({ toc: toc(names), state: 'present' });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.events.slice(3), ['checksum', 'toc', 'legacy', 'restore', 'restart', 'ready', 'cron']);
  assert.equal(result.sql, null);
});
for (const options of [{ publicStarted: 'true' }, { migrationStarted: 'false' }, { backupComplete: 'false' }]) {
  test(`rollback performs no database work outside the pre-public recovery gate: ${JSON.stringify(options)}`, async () => {
    const result = await probe(options);
    assert.deepEqual(result.events.slice(3), ['restart', 'ready', 'cron']);
    assert.equal(result.sql, null);
  });
}
for (const [name, options] of [
  ['TOC tool failure', { failure: 'toc' }],
  ['partial inventory', { toc: toc(['pages']) }],
  ['duplicate table', { toc: toc([...names, 'pages']) }],
  ['wrong reserved relation type', { toc: toc([], '99; 1259 199 VIEW public pages synthetic_owner\n') }],
  ['unrecognized reserved type', { toc: toc([], '99; 1259 199 UNKNOWN public page_media synthetic_owner\n') }],
  ['empty inventory', { toc: '' }],
  ['malformed inventory', { toc: 'not a pg_restore inventory\n' }],
  ['malformed record', { toc: toc([], '99; malformed\n') }],
  ['missing Portal anchors', { toc: toc().replace(/.*TABLE public users.*\n/, '') }],
  ['state changed since migration', { toc: toc(names) }],
  ['unproven initial state', { state: 'unknown' }],
  ['checksum mismatch', { failure: 'checksum' }],
  ['incomplete manifest', { manifest: '' }],
  ['manifest omits dump', { manifest: `${'a'.repeat(64)}  uploads.tar.gz\n` }],
  ['manifest unexpected file', { manifest: `${'a'.repeat(64)}  unexpected\n` }],
]) {
  test(`recovery refuses ${name} before any SQL or restart`, async () => {
    const result = await probe(options);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.events.some(event => ['sql', 'legacy', 'restore', 'restart'].includes(event)), result.events.join(','));
    assert.match(result.stderr, /Database restore failed; services remain stopped/);
  });
}
for (const [failure, forbidden] of [
  ['stop', ['checksum', 'toc', 'sql', 'legacy', 'restore', 'restart']],
  ['sql', ['legacy', 'restore', 'restart']],
  ['legacy', ['restore', 'restart']],
  ['restore', ['restart']],
]) {
  test(`recovery propagates ${failure} failure despite rollback disabling errexit`, async () => {
    const result = await probe({ failure });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(!result.events.some(event => forbidden.includes(event)), result.events.join(','));
  });
}
test('TOC classification ignores data, ACL and comments rather than treating them as tables', async () => {
  const extra = '91; 0 200 TABLE DATA public pages synthetic_owner\n92; 0 0 ACL public TABLE pages synthetic_owner\n93; 0 0 COMMENT public TABLE page_media synthetic_owner\n';
  const result = await probe({ mode: 'classify', toc: toc([], extra) });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'absent');
});

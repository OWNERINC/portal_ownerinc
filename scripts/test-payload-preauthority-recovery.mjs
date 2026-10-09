import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import {
  candidateImagesValid, createFixtureProjectNames, createInventory,
  createSyntheticValues, fixtureStopCommandTimeoutMs, FIXTURE_STOP_TIMEOUT_SECONDS,
  legacyAnnouncementLookupSql, normalizePgDumpForSnapshot,
  validateRecoveryInputs, writeProtectedInventory,
} from './integration/payload-preauthority-fixture.mjs';
import { createCommandDiagnostic } from './integration/payload-preauthority-diagnostics.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = process.env.PYTHON || 'python3';
const hostPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const reportPath = process.env.PAYLOAD_RECOVERY_REPORT || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'payload-preauthority-recovery-report.json');
const assignment = (key, value) => `${key}=${value}`;
const passwordKey = suffix => `POSTGRES_${suffix}`;
const safeChecks = {
  disposableSourceAndTargets: false,
  fixtureCronBootstrapOnly: false,
  quiescentSnapshotStable: false,
  actualAdapterAndCoordinator: false,
  fourStoreBackupAndRestore: false,
  exactPortalDatabaseAndSequences: false,
  exactCmsDatabaseAndMigrations: false,
  exactPortalUploadsTree: false,
  exactCmsMediaAndStagingTree: false,
  authorityLegacyEpochOne: false,
  nativeProtocolAbsent: false,
  workerStopped: false,
  allNegativeCasesRejectedBeforeRestore: false,
  repeatedCaptureRestoreAfterLiveEdit: false,
};
const negativeCases = [];
let stage = 'validate_inputs';
let activeSubstep = null;
let fixtureRoot = null;
let preserveFixture = false;
let images = null;
let runIdentity = null;
let inventoryIdentities = null;
let projectNames = null;
let runtimeRefs = [];

class FixtureFailure extends Error {
  constructor(code, diagnostic = null) {
    super(code);
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function safeEnvironment(extra = {}) {
  return { PATH: hostPath, HOME: '/root', ...extra };
}

function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repository,
    env: safeEnvironment(options.env),
    input: options.input,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout || 180_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new FixtureFailure(options.failureCode || 'fixture_command_failed', createCommandDiagnostic({
      substep: options.substep || activeSubstep,
      status: result.status,
      errorCode: result.error?.code,
      stderr: result.stderr,
      sqlCommandContext: options.sqlCommandContext === true,
    }));
  }
  return result.stdout || Buffer.alloc(0);
}

function text(result) { return result.toString('utf8').trim(); }

function setStage(value) {
  stage = value;
  activeSubstep = null;
}

function setSubstep(value) { activeSubstep = value; }

function composeArgs(project, release, runtime, actionArgs) {
  const paths = runtime.inventory.document.paths;
  return [
    '--profile', 'notifications', '--env-file', paths.environmentFile,
    '--env-file', path.join(release, '.image-env'),
    '-f', path.join(release, 'docker-compose.yml'),
    '-f', path.join(release, 'docker-compose.payload.yml'),
    '-f', paths.composeOverride,
    '-f', paths.payloadOverride,
    '--project-name', project,
    '--project-directory', release,
    ...actionArgs,
  ];
}

function compose(project, release, runtime, actionArgs, options = {}) {
  return run('env', [
    '-i', `PATH=${hostPath}`, 'HOME=/root', 'docker', 'compose',
    ...composeArgs(project, release, runtime, actionArgs),
  ], options);
}

function fixtureEnv(project, runtime, release) {
  return safeEnvironment({
    COMPOSE_PROJECT_NAME: project,
    PORTAL_OPERATION_LOCK: runtime.inventory.document.paths.lock,
    PAYLOAD_OPERATIONS_GUARD: path.join(runtime.directory, 'payload-operations-guard'),
    COMPOSE_ENV_FILE: runtime.inventory.document.paths.environmentFile,
    COMPOSE_OVERRIDE: runtime.inventory.document.paths.composeOverride,
    BACKUP_DIR: runtime.inventory.document.paths.backupRoots[0],
    PRE_RESTORE_BACKUP_DIR: runtime.inventory.document.paths.preRestoreBackupRoot,
    RESTORE_BASE_URL: runtime.baseUrl,
    SMOKE_ATTEMPTS: '8',
  });
}

function withLease(runtime, project, command, args = [], options = {}) {
  const lock = runtime.inventory.document.paths.lock;
  const script = 'set -Eeuo pipefail; lock=$1; shift; exec 9<>"$lock"; flock -n 9; export PORTAL_OPERATION_LOCK="$lock" PORTAL_OPERATION_LOCK_HELD="$lock"; exec "$@"';
  return run('bash', ['-c', script, 'payload-fixture-lease', lock, command, ...args], {
    ...options,
    env: { ...fixtureEnv(project, runtime, options.release || runtime.payloadRelease), ...options.env },
  });
}

function guard(runtime, project, action, release = runtime.payloadRelease, evidence = '') {
  return withLease(runtime, project, path.join(runtime.directory, 'payload-control'),
    [action, release, evidence], { release });
}

function coordinator(runtime, project, action, release, backup = '') {
  const script = path.join(release, 'scripts', 'payload-operations.sh');
  const args = action === 'backup' ? [script, 'backup', release] : [script, 'restore', release, backup, '--confirm', 'RESTORE'];
  return run('bash', args, { cwd: release, env: fixtureEnv(project, runtime, release), timeout: 15 * 60_000,
    failureCode: `coordinator_${action}_failed` });
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function copyReleaseSources(release) {
  await mkdir(release, { recursive: true, mode: 0o700 });
  for (const name of ['docker-compose.yml', 'docker-compose.payload.yml']) {
    await cp(path.join(repository, name), path.join(release, name));
  }
  for (const directory of ['api', 'cms', 'cron', 'nginx', 'public', 'scripts']) {
    await cp(path.join(repository, directory), path.join(release, directory), {
      recursive: true,
      filter: source => !/(^|[\\/])(?:node_modules|\.git|\.next|dist|coverage)(?:[\\/]|$)/.test(source),
    });
  }
  for (const name of ['release-manifest.sh', 'payload-operations.sh', 'smoke.sh']) {
    const target = path.join(release, 'scripts', name);
    await chmod(target, 0o700);
  }
}

async function writeRootFile(file, contents, mode = 0o600) {
  await writeFile(file, contents, { flag: 'wx', mode });
  await chmod(file, mode);
}

function envFileContents({ project, port, credentials }) {
  const origin = `http://127.0.0.1:${port}`;
  const pem = credentials.firebasePrivateKey.replaceAll('\n', '\\n');
  return [
    'NODE_ENV=production',
    'POSTGRES_DB=portal', 'POSTGRES_USER=portal_admin', assignment(passwordKey('PASSWORD'), credentials.portalAdmin),
    `PORTAL_API_DB_PASSWORD=${credentials.portalApi}`, `PORTAL_CRON_DB_PASSWORD=${credentials.portalCron}`,
    `MIGRATION_DATABASE_URL=postgresql://portal_admin:${credentials.portalAdmin}@postgres:5432/portal`,
    `API_DATABASE_URL=postgresql://portal_api:${credentials.portalApi}@postgres:5432/portal`,
    `CRON_DATABASE_URL=postgresql://portal_cron:${credentials.portalCron}@postgres:5432/portal`,
    assignment(`CMS_${passwordKey('PASSWORD')}`, credentials.cmsAdmin),
    `CMS_MIGRATOR_PASSWORD=${credentials.cmsMigrator}`,
    `CMS_RUNTIME_PASSWORD=${credentials.cmsRuntime}`,
    `CMS_ADMIN_DATABASE_URL=postgresql://cms_admin:${credentials.cmsAdmin}@cms-postgres:5432/ownerinc_cms`,
    `CMS_MIGRATION_DATABASE_URL=postgresql://cms_migrator:${credentials.cmsMigrator}@cms-postgres:5432/ownerinc_cms`,
    `CMS_RUNTIME_DATABASE_URL=postgresql://cms_runtime:${credentials.cmsRuntime}@cms-postgres:5432/ownerinc_cms`,
    `PAYLOAD_SECRET=${credentials.payloadSecret}`,
    `PAYLOAD_TO_PORTAL_SECRET=${credentials.payloadToPortal}`,
    `PORTAL_TO_PAYLOAD_SECRET=${credentials.portalToPayload}`,
    'PORTAL_PUBLIC_URL=https://portal-preauthority.test', 'PORTAL_INTERNAL_URL=http://api:3000',
    `FIREBASE_PROJECT_ID=demo-payload-preauth-${project.slice(-10)}`,
    `FIREBASE_CLIENT_EMAIL=fixture-admin@demo-payload-preauth.test`,
    `FIREBASE_PRIVATE_KEY="${pem}"`,
    `CORS_ORIGINS=${origin}`,
    `SMTP_ADDRESS=127.0.0.1`, 'SMTP_PORT=2525', 'SMTP_USERNAME=fixture',
    `SMTP_PASSWORD=${credentials.smtpPassword}`, 'MAILER_SENDER_EMAIL=fixture@preauthority.test',
    `BULK_IMPORT_WORKER_SECRET=${credentials.workerSecret}`,
    'SOLIDES_RELEASE_STAGE=off',
    'BIND_ADDRESS=127.0.0.1', `HTTP_PORT=${port}`,
    'TZ=UTC', '',
  ].join('\n');
}

async function createRuntime(project, root, sourceInventoryIdentity = null, sourceRuntime = null) {
  const runtimeDirectory = path.join(root, 'runtime');
  const releases = path.join(root, 'releases');
  await Promise.all([
    mkdir(runtimeDirectory, { recursive: true, mode: 0o700 }),
    mkdir(releases, { recursive: true, mode: 0o700 }),
    mkdir(path.join(root, 'backups'), { recursive: true, mode: 0o700 }),
    mkdir(path.join(root, 'restore-protection'), { recursive: true, mode: 0o700 }),
  ]);
  const { document, identity } = createInventory({
    project, root,
    trustedSourceInventoryIdentities: sourceInventoryIdentity ? [sourceInventoryIdentity] : [],
  });
  await writeProtectedInventory(runtimeDirectory, document);
  for (const name of ['payload-control', 'payload-control-runtime.py', 'payload-control-state.py',
    'payload-control-inventory.py', 'payload-operations-guard.sh', 'compose.payload.production.yaml']) {
    const sourceName = name === 'payload-operations-guard.sh' ? name : name;
    await cp(path.join(repository, 'ops', sourceName), path.join(runtimeDirectory,
      name === 'payload-operations-guard.sh' ? 'payload-operations-guard' : name));
  }
  await cp(new URL('./integration/payload-preauthority-fixture.compose.yml', import.meta.url), document.paths.composeOverride);
  await chmod(path.join(runtimeDirectory, 'payload-control'), 0o700);
  await chmod(path.join(runtimeDirectory, 'payload-operations-guard'), 0o700);
  await chmod(document.paths.composeOverride, 0o600);
  await chmod(document.paths.payloadOverride, 0o600);
  await writeRootFile(document.paths.lock, 'disposable shared operation lease\n');

  const legacyRelease = path.join(releases, 'legacy-floor');
  const payloadRelease = path.join(releases, 'payload-candidate');
  await copyReleaseSources(legacyRelease);
  await copyReleaseSources(payloadRelease);
  await writeRootFile(path.join(legacyRelease, '.image-env'), `API_IMAGE=${images.api}\nCRON_IMAGE=${images.cron}\n`);
  await writeRootFile(path.join(payloadRelease, '.image-env'),
    `API_IMAGE=${images.api}\nCRON_IMAGE=${images.cron}\nCMS_IMAGE=${images.cms}\nRELEASE_FORMAT=payload-v1\n`);
  const port = await allocatePort();
  const credentials = createSyntheticValues();
  const secret = () => randomBytes(48).toString('base64url');
  Object.assign(credentials, {
    portalAdmin: secret(), portalApi: secret(), portalCron: secret(), cmsAdmin: secret(),
    cmsMigrator: secret(), cmsRuntime: secret(), payloadSecret: secret(), payloadToPortal: secret(),
    portalToPayload: secret(), smtpPassword: secret(), workerSecret: secret(),
  });
  await writeRootFile(document.paths.environmentFile, envFileContents({ project, port, credentials }));
  await writeRootFile(document.paths.currentRelease, `${legacyRelease}\n`);
  const helperResult = text(run(python, [path.join(runtimeDirectory, 'payload-control-inventory.py'), 'validate',
    path.join(runtimeDirectory, 'payload-control-inventory.json')]));
  assert.equal(helperResult, identity, 'JavaScript and protected Python inventory identities must agree');
  if (sourceRuntime) {
    run(python, [path.join(runtimeDirectory, 'payload-control-state.py'), 'initialize-trusted',
      runtimeDirectory, sourceRuntime.directory, sourceInventoryIdentity]);
  } else {
    run(python, [path.join(runtimeDirectory, 'payload-control-state.py'), 'initialize', runtimeDirectory]);
  }
  return {
    project, root, directory: runtimeDirectory, inventory: { document, identity },
    legacyRelease, payloadRelease, port, baseUrl: `http://127.0.0.1:${port}`,
  };
}

function composeCall(runtime, actionArgs, options = {}) {
  return compose(runtime.project, runtime.payloadRelease, runtime, actionArgs, options);
}

async function awaitService(runtime, service, attempts = 180) {
  const safeService = service.replaceAll('-', '_');
  setSubstep(`wait_${safeService}_container`);
  for (let index = 0; index < attempts; index += 1) {
    const id = text(composeCall(runtime, ['ps', '-q', service]));
    if (id) {
      setSubstep(`wait_${safeService}_health`);
      const state = text(run('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]));
      if (state === 'healthy') return;
      setSubstep(`wait_${safeService}_container_state`);
      const containerState = text(run('docker', ['inspect', '--format', '{{.State.Status}}', id]));
      if (containerState === 'exited' || containerState === 'dead') throw new FixtureFailure(`service_${service}_stopped`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new FixtureFailure(`service_${service}_not_ready`);
}

function composeWithLease(runtime, actionArgs, options = {}) {
  const args = composeArgs(runtime.project, runtime.payloadRelease, runtime, actionArgs);
  return withLease(runtime, runtime.project, '/usr/bin/env', [
    '-i', `PATH=${hostPath}`, 'HOME=/root', 'docker', 'compose', ...args,
  ], { ...options, release: runtime.payloadRelease });
}

async function provisionProject(runtime) {
  setStage(`prepare_${runtime.project}`);
  composeWithLease(runtime, ['up', '--detach', '--no-build', '--pull', 'never', 'postgres', 'api', 'cron']);
  await awaitService(runtime, 'api');
  await awaitService(runtime, 'cron');
  const cronBootstrapMode = text(composeWithLease(runtime,
    ['exec', '-T', 'cron', 'node', '-p', 'process.env.CRON_BOOTSTRAP_ONLY']));
  assert.equal(cronBootstrapMode, 'true',
    'the running fixture cron service must receive its scoped bootstrap-only environment');
  runtime.cronBootstrapOnlyVerified = true;

  // Reproduce the reviewed initial-install floor: the shared candidate preflight
  // sees Portal authority legacy/1 with no session-v2 table grants.
  composeWithLease(runtime, ['exec', '-T', 'postgres', 'sh', '-ceu',
    'psql -Xq -v ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -c "REVOKE ALL PRIVILEGES ON TABLE public.cms_editor_sessions FROM portal_api, portal_cron"']);
  guard(runtime, runtime.project, 'release-preflight', runtime.payloadRelease);
  composeWithLease(runtime, ['exec', '-T', 'postgres', 'sh', '-ceu',
    'psql -Xq -v ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" --username="$POSTGRES_USER" -c "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cms_editor_sessions TO portal_api; REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.cms_editor_sessions FROM portal_api, portal_cron"']);

  composeWithLease(runtime, ['up', '--detach', '--no-build', '--pull', 'never', 'cms-postgres']);
  await awaitService(runtime, 'cms-postgres');
  composeWithLease(runtime, ['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-provision']);
  composeWithLease(runtime, ['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-migrate']);
  composeWithLease(runtime, ['up', '--detach', '--no-build', '--pull', 'never', 'cms']);
  await awaitService(runtime, 'cms');
  await seedProject(runtime);
  guard(runtime, runtime.project, 'verify-release', runtime.payloadRelease);
  await writeFile(runtime.inventory.document.paths.currentRelease, `${runtime.payloadRelease}\n`, { mode: 0o600 });
  await chmod(runtime.inventory.document.paths.currentRelease, 0o600);
}

function syntheticUid(project) { return `fixture-${project}`; }
function safeToken(project) { return project.replaceAll('-', '_'); }

async function seedProject(runtime) {
  setStage(`seed_${runtime.project}`);
  const marker = `payload-preauthority-${runtime.project}`;
  const uid = syntheticUid(runtime.project);
  const email = `${safeToken(runtime.project)}@fixture.invalid`;
  const pollId = randomUUID();
  const legacyDocumentId = randomUUID();
  const legacyRevisionId = randomUUID();
  runtime.legacyAnnouncementId = legacyDocumentId;
  const runSeedStatement = (service, database, user, substep, statement) => {
    setSubstep(substep);
    composeWithLease(runtime, ['exec', '-T', service, 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1',
      '-v', 'VERBOSITY=sqlstate', `--dbname=${database}`, `--username=${user}`], {
      input: `${statement};\n`, substep, sqlCommandContext: true,
    });
  };
  runSeedStatement('postgres', 'portal', 'portal_admin', 'seed_portal_user',
    `INSERT INTO public.users(uid,email,name,role) VALUES('${uid}','${email}','${marker}','viewer')`);
  runSeedStatement('postgres', 'portal', 'portal_admin', 'seed_portal_poll',
    `INSERT INTO public.owner_news_polls(id,title,question,status,created_by,updated_by) VALUES('${pollId}','${marker}','${marker} recovery question','draft','${uid}','${uid}')`);
  runSeedStatement('postgres', 'portal', 'portal_admin', 'seed_portal_legacy_document',
    `INSERT INTO public.cms_documents(id,content_type,source_id,title,category,created_by,updated_by) VALUES('${legacyDocumentId}','announcement','${legacyDocumentId}','${marker} legacy announcement','fixture','${uid}','${uid}')`);
  runSeedStatement('postgres', 'portal', 'portal_admin', 'seed_portal_legacy_revision',
    `INSERT INTO public.cms_revisions(id,document_id,version,status,blocks,editorial,created_by) VALUES('${legacyRevisionId}','${legacyDocumentId}',1,'published','[{"type":"paragraph","text":"${marker} legacy recovery body"}]'::jsonb,'{"version":1,"kind":"article","summary":"synthetic legacy recovery fixture","author":"fixture","source_label":"fixture","source_date":null}'::jsonb,'${uid}')`);
  runSeedStatement('postgres', 'portal', 'portal_admin', 'seed_portal_publish_legacy_revision',
    `UPDATE public.cms_documents SET published_revision_id='${legacyRevisionId}',published_at=NOW() WHERE id='${legacyDocumentId}'`);
  runSeedStatement('cms-postgres', 'ownerinc_cms', 'cms_admin', 'seed_cms_portal_editor',
    `INSERT INTO public.portal_editors(id,portal_uid,email,display_name) VALUES('${randomUUID()}','${uid}','${email}','${marker}')`);
  runSeedStatement('cms-postgres', 'ownerinc_cms', 'cms_admin', 'seed_cms_payload_preference',
    `INSERT INTO public.payload_preferences(id,key,value) VALUES('${randomUUID()}','fixture-${safeToken(runtime.project)}','{"marker":"${marker}"}'::jsonb)`);
  setSubstep('seed_portal_upload');
  composeWithLease(runtime, ['exec', '-T', 'api', 'sh', '-ceu', 'printf %s "$1" > /app/uploads/preauthority-fixture.txt',
    'payload-fixture', `${marker}:portal-upload`], { substep: 'seed_portal_upload' });
  setSubstep('seed_cms_media');
  composeWithLease(runtime, ['exec', '-T', 'cms', 'sh', '-ceu',
    'mkdir -p /var/lib/ownerinc-cms/media/.owner-news-import/staging && printf %s "$1" > /var/lib/ownerinc-cms/media/.owner-news-import/staging/receipt.json && printf %s "$2" > /var/lib/ownerinc-cms/media/preauthority-fixture.bin',
    'payload-fixture', `${marker}:receipt`, `${marker}:cms-media`], { substep: 'seed_cms_media' });
  await assertQuiescentSnapshotStable(runtime);
}

function databaseDump(runtime, service, database, user) {
  const dump = composeCall(runtime, ['exec', '-T', service, 'sh', '-ceu',
    `pg_dump --data-only --column-inserts --no-owner --no-privileges --dbname="${database}" --username="${user}"`]);
  return normalizePgDumpForSnapshot(dump);
}

function databaseSchemaDump(runtime, service, database, user) {
  const dump = composeCall(runtime, ['exec', '-T', service, 'sh', '-ceu',
    `pg_dump --schema-only --no-owner --no-privileges --dbname="${database}" --username="${user}"`]);
  return normalizePgDumpForSnapshot(dump);
}

function storageFingerprint(runtime, service, location) {
  const archive = composeCall(runtime, ['run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'tar',
    service, '-cf', '-', '-C', location, '.']);
  const script = String.raw`
import importlib.util, sys
path = sys.argv[1]
spec = importlib.util.spec_from_file_location('payload_control_runtime', path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(module._tar_tree(sys.stdin.buffer, compressed=False))
`;
  return text(run(python, ['-c', script, path.join(runtime.directory, 'payload-control-runtime.py')], { input: archive }));
}

function snapshot(runtime) {
  setSubstep('snapshot_portal_database_rows');
  const portalDatabase = createHash('sha256').update(databaseDump(runtime, 'postgres', 'portal', 'portal_admin')).digest('hex');
  setSubstep('snapshot_cms_database_rows');
  const cmsDatabase = createHash('sha256').update(databaseDump(runtime, 'cms-postgres', 'ownerinc_cms', 'cms_admin')).digest('hex');
  setSubstep('snapshot_portal_database_schema');
  const portalSchema = createHash('sha256').update(databaseSchemaDump(runtime, 'postgres', 'portal', 'portal_admin')).digest('hex');
  setSubstep('snapshot_cms_database_schema');
  const cmsSchema = createHash('sha256').update(databaseSchemaDump(runtime, 'cms-postgres', 'ownerinc_cms', 'cms_admin')).digest('hex');
  setSubstep('snapshot_portal_uploads');
  const portalUploads = storageFingerprint(runtime, 'api', '/app/uploads');
  setSubstep('snapshot_cms_media');
  const cmsUploads = storageFingerprint(runtime, 'cms', '/var/lib/ownerinc-cms/media');
  return {
    portalDatabase,
    cmsDatabase,
    portalSchema,
    cmsSchema,
    portalUploads,
    cmsUploads,
  };
}

async function assertQuiescentSnapshotStable(runtime) {
  setStage(`quiescent_snapshot_${runtime.project}`);
  setSubstep('snapshot_list_writers');
  const running = text(composeCall(runtime, ['ps', '--status', 'running', '--services']))
    .split(/\r?\n/u).filter(Boolean);
  const writers = ['api', 'cron', 'cms'].filter(service => running.includes(service));
  assert.deepEqual(writers, ['api', 'cron', 'cms'],
    'all fixture application writers must be running before the quiescence check');
  setSubstep('snapshot_stop_writers');
  composeWithLease(runtime, ['stop', '--timeout', String(FIXTURE_STOP_TIMEOUT_SECONDS), ...writers], {
    substep: 'snapshot_stop_writers',
    timeout: fixtureStopCommandTimeoutMs(writers.length),
  });
  try {
    setSubstep('snapshot_verify_writers_stopped');
    const remainingWriters = text(composeCall(runtime, ['ps', '--status', 'running', '--services']))
      .split(/\r?\n/u).filter(service => writers.includes(service));
    assert.deepEqual(remainingWriters, [],
      'every fixture writer must be stopped before any snapshot is captured');
    const first = snapshot(runtime);
    const second = snapshot(runtime);
    assert.deepEqual(second, first,
      'repeated quiescent snapshots must preserve every database row, sequence, catalog and file tree');
    runtime.quiescentSnapshotStable = true;
  } finally {
    setSubstep('snapshot_restart_writers');
    composeWithLease(runtime, ['start', ...writers], { substep: 'snapshot_restart_writers' });
    for (const service of writers) await awaitService(runtime, service);
  }
}

function assertUnchanged(before, after, label) {
  assert.deepEqual(after, before, `${label} must not mutate target database rows, sequences, or file trees`);
}

async function copyBackup(sourceRuntime, destinationRuntime, sourceDirectory, label) {
  const destination = path.join(destinationRuntime.inventory.document.paths.backupRoots[0], label);
  await mkdir(destination, { mode: 0o700 });
  for (const entry of await readdir(sourceDirectory)) {
    await cp(path.join(sourceDirectory, entry), path.join(destination, entry));
    await chmod(path.join(destination, entry), 0o600);
  }
  await chmod(destination, 0o700);
  return destination;
}

async function newestBackup(runtime) {
  const root = runtime.inventory.document.paths.backupRoots[0];
  const directories = (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.ok(directories.length >= 1, 'fixture coordinator must produce a source backup');
  return path.join(root, directories.at(-1));
}

async function refreshManifest(directory) {
  const files = ['postgres.dump', 'uploads.tar.gz', 'cms-postgres.dump', 'cms-uploads.tar.gz',
    'release.images', 'operations-proof.json', 'backup.format'];
  const entries = [];
  for (const name of files) {
    const data = await readFile(path.join(directory, name));
    entries.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`);
  }
  await writeFile(path.join(directory, 'manifest.sha256'), `${entries.join('\n')}\n`, { mode: 0o600 });
  await chmod(path.join(directory, 'manifest.sha256'), 0o600);
}

function cloneBackup(source, target) {
  return cp(source, target, { recursive: true, force: false, errorOnExist: true });
}

async function resignBackup(runtime, directory, mutation) {
  const code = String.raw`
import hashlib, importlib.util, json, os, sys
state_path, runtime, directory, mode = sys.argv[1:]
spec = importlib.util.spec_from_file_location('payload_control_state', state_path)
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)
key = S._key_for(runtime)
proof_path = os.path.join(directory, 'operations-proof.json')
envelope = S.parse_canonical(open(proof_path, 'rb').read(), 'proof_not_canonical')
body = envelope['body']
if mode == 'bad-migration':
    body['migrations']['cms']['names'].append('20261008_fixture_unexpected')
elif mode == 'wrong-digest':
    image = body['images']['api']
    digest = '0' * 64 if not image.endswith('0' * 64) else 'f' * 64
    body['images']['api'] = image.rsplit(':', 1)[0] + ':' + digest
    with open(os.path.join(directory, 'release.images'), 'w', encoding='ascii') as stream:
        stream.write('API_IMAGE=' + body['images']['api'] + '\n')
        stream.write('CRON_IMAGE=' + body['images']['cron'] + '\n')
        stream.write('CMS_IMAGE=' + body['images']['cms'] + '\nRELEASE_FORMAT=payload-v1\n')
elif mode == 'unsafe-archive':
    artifact_path = os.path.join(directory, 'uploads.tar.gz')
    with open(artifact_path, 'rb') as stream:
        data = stream.read()
    body['artifacts'][1]['sha256'] = hashlib.sha256(data).hexdigest()
    body['artifacts'][1]['size'] = len(data)
for item in body['artifacts']:
    data = open(os.path.join(directory, item['name']), 'rb').read()
    item['sha256'] = hashlib.sha256(data).hexdigest()
    item['size'] = len(data)
if mode == 'unsafe-archive':
    body['artifacts'][1]['sha256'] = hashlib.sha256(open(os.path.join(directory, 'uploads.tar.gz'), 'rb').read()).hexdigest()
envelope = S.sign_envelope(body, key)
with open(proof_path, 'wb') as stream:
    stream.write(S.canonical(envelope) + b'\n')
`;
  run(python, ['-c', code, path.join(runtime.directory, 'payload-control-state.py'), runtime.directory, directory, mutation]);
  await refreshManifest(directory);
}

async function negativeRestore(runtime, backupPath, label, expectedChange = null) {
  setStage(`negative_${label}`);
  let directory = backupPath;
  if (expectedChange) directory = await expectedChange(backupPath);
  const before = snapshot(runtime);
  let rejected = false;
  try {
    coordinator(runtime, runtime.project, 'restore', runtime.payloadRelease, directory);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, `${label} must fail closed before a restore completes`);
  const after = snapshot(runtime);
  assertUnchanged(before, after, label);
  assertWorkerHeld(runtime);
  negativeCases.push({ name: label, rejected: true, targetContentUnchanged: true });
}

async function createNegativeCopies(runtime, backupPath) {
  const base = runtime.inventory.document.paths.backupRoots[0];
  const copy = async name => {
    const target = path.join(base, `negative-${name}`);
    await cloneBackup(backupPath, target);
    await chmod(target, 0o700);
    for (const file of await readdir(target)) await chmod(path.join(target, file), 0o600);
    return target;
  };

  await negativeRestore(runtime, await copy('dump'), 'tampered_dump', async directory => {
    await writeFile(path.join(directory, 'postgres.dump'), 'tampered dump bytes\n', { mode: 0o600 });
    await refreshManifest(directory);
    return directory;
  });
  await negativeRestore(runtime, await copy('proof'), 'tampered_proof', async directory => {
    const proof = JSON.parse(await readFile(path.join(directory, 'operations-proof.json'), 'utf8'));
    proof.signature.value = '0'.repeat(64);
    await writeFile(path.join(directory, 'operations-proof.json'), `${JSON.stringify(sortKeys(proof))}\n`, { mode: 0o600 });
    await refreshManifest(directory);
    return directory;
  });
  await negativeRestore(runtime, await copy('manifest'), 'tampered_manifest', async directory => {
    const manifest = await readFile(path.join(directory, 'manifest.sha256'), 'utf8');
    await writeFile(path.join(directory, 'manifest.sha256'), `${'0'.repeat(64)}${manifest.slice(64)}`, { mode: 0o600 });
    return directory;
  });
  await negativeRestore(runtime, await copy('unsafe-archive'), 'unsafe_archive', async directory => {
    const tar = String.raw`
import io, sys, tarfile
path = sys.argv[1]
with tarfile.open(path, 'w:gz') as archive:
    data = b'unsafe fixture entry'
    member = tarfile.TarInfo('../escape')
    member.size = len(data)
    archive.addfile(member, io.BytesIO(data))
`;
    run(python, ['-c', tar, path.join(directory, 'uploads.tar.gz')]);
    await resignBackup(runtime, directory, 'unsafe-archive');
    return directory;
  });
  await negativeRestore(runtime, await copy('wrong-digest'), 'wrong_image_digest', async directory => {
    await resignBackup(runtime, directory, 'wrong-digest');
    return directory;
  });
  await negativeRestore(runtime, await copy('migration'), 'migration_mismatch', async directory => {
    await resignBackup(runtime, directory, 'bad-migration');
    return directory;
  });
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}

async function targetCatalogNegative(runtime, backup, label, sql, cleanupSql) {
  setStage(`negative_${label}`);
  const before = snapshot(runtime);
  composeWithLease(runtime, ['exec', '-T', 'cms-postgres', 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1',
    '--dbname=ownerinc_cms', '--username=cms_admin'], { input: `${sql}\n` });
  const injected = snapshot(runtime);
  let rejected = false;
  try {
    coordinator(runtime, runtime.project, 'restore', runtime.payloadRelease, backup);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, `${label} must reject preflight`);
  assert.notDeepEqual(injected, before, `${label} fixture must visibly alter the target catalog or data`);
  assertUnchanged(injected, snapshot(runtime), label);
  assertWorkerHeld(runtime);
  // This cleanup is explicit test fixture DDL; it runs only after proving that
  // the attempted restore left target rows/files untouched.
  composeWithLease(runtime, ['exec', '-T', 'cms-postgres', 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1',
    '--dbname=ownerinc_cms', '--username=cms_admin'], { input: `${cleanupSql}\n` });
  assert.deepEqual(snapshot(runtime), before, `${label} fixture DDL cleanup must restore the original store data`);
  negativeCases.push({ name: label, rejected: true, targetContentUnchanged: true, fixtureDdlCleaned: true });
}

async function targetContentRace(runtime, backup) {
  setStage('negative_target_changed_after_preflight');
  const before = snapshot(runtime);
  const restoreScript = path.join(runtime.payloadRelease, 'scripts', 'payload-operations.sh');
  const child = spawn('bash', [restoreScript, 'restore', runtime.payloadRelease, backup, '--confirm', 'RESTORE'], {
    cwd: runtime.payloadRelease,
    env: fixtureEnv(runtime.project, runtime, runtime.payloadRelease),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let injected = false;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    if (!injected) {
      try {
        await access(runtime.inventory.document.paths.admissionClosed);
        const extra = `${runtime.project}_lease_race`;
        run('docker', ['volume', 'create', '--label', `com.docker.compose.project=${runtime.project}`,
          '--label', 'com.docker.compose.volume=lease_race', extra]);
        injected = true;
        runtime.extraVolume = extra;
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    throw new FixtureFailure('target_change_restore_timeout');
  }
  if (!injected || child.exitCode === 0) throw new FixtureFailure('target_change_was_not_rejected');
  const after = snapshot(runtime);
  assertUnchanged(before, after, 'target_volume_inventory_changed_after_reservation');
  assertWorkerHeld(runtime);
  run('docker', ['volume', 'rm', runtime.extraVolume]);
  runtime.extraVolume = null;
  negativeCases.push({ name: 'target_changed_after_restore_preflight', rejected: true,
    targetContentUnchanged: true, raceInjectedAfterLeaseReservation: true });
}

async function currentPointer(runtime) {
  return text(await readFile(runtime.inventory.document.paths.currentRelease));
}

function databaseAuthority(runtime) {
  return text(composeCall(runtime, ['exec', '-T', 'postgres', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
    '--dbname=portal', '--username=portal_admin', '-c', "SELECT mode || '/' || epoch::text FROM owner_news_authority WHERE singleton=true"]));
}

function legacyAnnouncement(runtime, documentId) {
  return text(composeCall(runtime, ['exec', '-T', 'postgres', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
    '--dbname=portal', '--username=portal_admin', '-c', legacyAnnouncementLookupSql(documentId)]));
}

function cmsMigrationNames(runtime) {
  return text(composeCall(runtime, ['exec', '-T', 'cms-postgres', 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
    '--dbname=ownerinc_cms', '--username=cms_admin', '-c', 'SELECT string_agg(name, \'|\' ORDER BY name) FROM payload_migrations']));
}

function assertWorkerHeld(runtime) {
  const ids = text(composeCall(runtime, ['ps', '-q', 'cms-worker']));
  assert.equal(ids, '', 'CMS worker must remain absent after recovery');
  const listed = text(run('docker', ['ps', '--all', '--filter', `label=com.docker.compose.project=${runtime.project}`,
    '--filter', 'label=com.docker.compose.service=cms-worker', '--format', '{{.State}}']));
  assert.equal(listed.split(/\r?\n/).filter(Boolean).some(value => value === 'running'), false);
}

async function runRecovery() {
  const inputImages = { api: process.env.API_IMAGE, cron: process.env.CRON_IMAGE, cms: process.env.CMS_IMAGE };
  runIdentity = {
    commit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  validateRecoveryInputs({
    platform: process.platform,
    uid: process.getuid?.(),
    images: inputImages,
    ...runIdentity,
    dockerEnvironment: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('DOCKER_'))),
  });
  assert.equal(candidateImagesValid(inputImages), true, 'only exact immutable GHCR candidate digests are accepted');
  images = inputImages;
  const runTemp = process.env.RUNNER_TEMP || os.tmpdir();
  fixtureRoot = await mkdtemp(path.join(runTemp, 'payload-preauthority-recovery-'));
  await chmod(fixtureRoot, 0o700);
  projectNames = createFixtureProjectNames(runIdentity);
  const leaseProject = projectNames.source.replace(/-source$/u, '-lease');
  projectNames.lease = leaseProject;
  const sourceRoot = path.join(fixtureRoot, 'source');
  const targetRoot = path.join(fixtureRoot, 'target');
  const leaseRoot = path.join(fixtureRoot, 'lease-target');
  const source = await createRuntime(projectNames.source, sourceRoot);
  inventoryIdentities = { source: source.inventory.identity };
  const target = await createRuntime(projectNames.target, targetRoot, source.inventory.identity, source);
  const leaseTarget = await createRuntime(leaseProject, leaseRoot, source.inventory.identity, source);
  runtimeRefs = [source, target, leaseTarget];
  inventoryIdentities.target = target.inventory.identity;
  inventoryIdentities.leaseTarget = leaseTarget.inventory.identity;

  // Pull the exact scanned/published same-run digests. Do not build, retag, or
  // substitute locally tagged images in the recovery acceptance.
  setStage('pull_published_candidate_images');
  for (const image of Object.values(images)) {
    const present = run('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
    assert.ok(text(present).startsWith('sha256:'), 'published candidate image must already be present by digest');
  }

  await provisionProject(source);
  await provisionProject(target);
  await provisionProject(leaseTarget);
  safeChecks.fixtureCronBootstrapOnly = runtimeRefs.every(runtime => runtime.cronBootstrapOnlyVerified === true);
  safeChecks.quiescentSnapshotStable = runtimeRefs.every(runtime => runtime.quiescentSnapshotStable === true);
  assert.equal(safeChecks.fixtureCronBootstrapOnly, true);
  assert.equal(safeChecks.quiescentSnapshotStable, true);
  safeChecks.disposableSourceAndTargets = true;

  setStage('capture_actual_coordinated_backup');
  coordinator(source, source.project, 'backup', source.payloadRelease);
  const sourceBackup = await newestBackup(source);
  assert.equal((await readdir(sourceBackup)).includes('payload-control.key'), false,
    'the source signing key must remain host state, not a backup artifact');
  const targetBackup = await copyBackup(source, target, sourceBackup, 'source-backup');
  const leaseBackup = await copyBackup(source, leaseTarget, sourceBackup, 'source-backup');
  safeChecks.actualAdapterAndCoordinator = true;

  setStage('offline_rejection_matrix');
  await createNegativeCopies(target, targetBackup);
  await targetCatalogNegative(target, targetBackup, 'unexpected_schema',
    'CREATE SCHEMA fixture_unexpected_schema', 'DROP SCHEMA fixture_unexpected_schema');
  await targetCatalogNegative(target, targetBackup, 'weak_native_constraint',
    `ALTER TABLE public.news_migration_runs DROP CONSTRAINT news_migration_runs_manifest_sha256_check; ALTER TABLE public.news_migration_runs ADD CONSTRAINT news_migration_runs_manifest_sha256_check CHECK (manifest_sha256 IS NOT NULL)`,
    `ALTER TABLE public.news_migration_runs DROP CONSTRAINT news_migration_runs_manifest_sha256_check; ALTER TABLE public.news_migration_runs ADD CONSTRAINT news_migration_runs_manifest_sha256_check CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$')`);
  await targetCatalogNegative(target, targetBackup, 'materialized_view',
    'CREATE MATERIALIZED VIEW public.fixture_recovery_matview AS SELECT id FROM public.portal_editors',
    'DROP MATERIALIZED VIEW public.fixture_recovery_matview');
  await targetCatalogNegative(target, targetBackup, 'migration_ledger_mismatch',
    `INSERT INTO public.payload_migrations(name,batch) VALUES('20261008_fixture_unexpected',999)`,
    `DELETE FROM public.payload_migrations WHERE name='20261008_fixture_unexpected'`);
  await targetContentRace(leaseTarget, leaseBackup);
  safeChecks.allNegativeCasesRejectedBeforeRestore = true;

  setStage('first_actual_restore');
  const targetBefore = snapshot(target);
  coordinator(target, target.project, 'restore', target.payloadRelease, targetBackup);
  assert.equal(databaseAuthority(target), 'legacy/1');
  const sourceAnnouncement = legacyAnnouncement(source, source.legacyAnnouncementId);
  assert.match(sourceAnnouncement, /synthetic legacy recovery fixture/u);
  assert.equal(legacyAnnouncement(target, source.legacyAnnouncementId), sourceAnnouncement,
    'restore must preserve the source legacy announcement by its exact source document identity');
  assert.equal(legacyAnnouncement(target, target.legacyAnnouncementId), '',
    'restore must replace, not accidentally match, the independently seeded target announcement');
  assertWorkerHeld(target);
  assert.deepEqual(snapshot(target), snapshot(source), 'all four restored stores must exactly match the independent source');
  assert.notDeepEqual(targetBefore, snapshot(target), 'independently seeded target contents must have changed only through restore');
  safeChecks.fourStoreBackupAndRestore = true;
  safeChecks.exactPortalDatabaseAndSequences = true;
  safeChecks.exactCmsDatabaseAndMigrations = true;
  safeChecks.exactPortalUploadsTree = true;
  safeChecks.exactCmsMediaAndStagingTree = true;
  safeChecks.authorityLegacyEpochOne = true;
  safeChecks.nativeProtocolAbsent = true;
  safeChecks.workerStopped = true;

  setStage('second_capture_after_synthetic_live_edit');
  const liveEdit = `UPDATE public.owner_news_polls SET title='payload-preauthority-live-edit' WHERE title LIKE 'payload-preauthority-${source.project}';`;
  composeWithLease(source, ['exec', '-T', 'postgres', 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1',
    '--dbname=portal', '--username=portal_admin'], { input: `${liveEdit}\n` });
  await new Promise(resolve => setTimeout(resolve, 1100));
  coordinator(source, source.project, 'backup', source.payloadRelease);
  const secondSourceBackup = await newestBackup(source);
  // Keep the original source backup and the second run as separate evidence sets.
  const secondName = path.join(target.inventory.document.paths.backupRoots[0], 'source-backup-after-live-edit');
  await mkdir(secondName, { mode: 0o700 });
  for (const file of await readdir(secondSourceBackup)) {
    await cp(path.join(secondSourceBackup, file), path.join(secondName, file));
    await chmod(path.join(secondName, file), 0o600);
  }
  const secondTargetBefore = snapshot(target);
  coordinator(target, target.project, 'restore', target.payloadRelease, secondName);
  assert.equal(databaseAuthority(target), 'legacy/1');
  assertWorkerHeld(target);
  assert.deepEqual(snapshot(target), snapshot(source), 'second recovery must include the post-backup synthetic live edit');
  assert.notDeepEqual(secondTargetBefore, snapshot(target), 'second restore should apply the source live edit');
  safeChecks.repeatedCaptureRestoreAfterLiveEdit = true;
  safeChecks.allNegativeCasesRejectedBeforeRestore = negativeCases.length >= 10 &&
    negativeCases.every(item => item.rejected && item.targetContentUnchanged);
  assert.equal(safeChecks.allNegativeCasesRejectedBeforeRestore, true);

  const finalMigrations = cmsMigrationNames(target).split('|').filter(Boolean);
  assert.deepEqual(finalMigrations, [
    '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
    '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
    '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
  ]);
  assert.equal(await currentPointer(target), target.payloadRelease);
  const nativeState = JSON.parse(text(composeCall(target, [
    'run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-preauthority-verify',
  ])));
  assert.equal(nativeState.phase, 'preauthority');
  assert.equal(nativeState.protocolStatus, 'absent');
  assert.equal(nativeState.coverageApplicability, 'not-applicable');
  assert.equal(nativeState.newsMutationRows, 0);
  assert.equal(nativeState.ready, false);
  assert.equal(nativeState.admissionActivated, false);
  assert.equal(nativeState.cutoverCertified, false);
  return {
    schemaVersion: 1, status: 'passed', run: runIdentity, images,
    sourceInventoryIdentity: inventoryIdentities.source,
    targetInventoryIdentity: inventoryIdentities.target,
    negativeCases,
    checks: safeChecks,
    evidence: { kind: 'redacted-metadata-only', privateFixtureRetainedForRunnerLifetime: false },
  };
}

async function writeReport(report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  await chmod(reportPath, 0o644);
}

let report;
try {
  report = await runRecovery();
  setStage('successful_fixture_cleanup');
  for (const runtime of runtimeRefs) {
    composeCall(runtime, ['down', '--volumes', '--remove-orphans']);
  }
  preserveFixture = false;
  await rm(fixtureRoot, { recursive: true, force: true });
} catch (error) {
  preserveFixture = Boolean(fixtureRoot);
  report = {
    schemaVersion: 1, status: 'failed', run: runIdentity,
    images, failedStage: stage,
    failureCode: error instanceof FixtureFailure ? error.code : 'acceptance_assertion_failed',
    ...(activeSubstep ? { failedSubstep: activeSubstep } : {}),
    ...(error instanceof FixtureFailure && error.diagnostic ? { commandDiagnostic: error.diagnostic } : {}),
    checks: safeChecks, negativeCases,
    evidence: { kind: 'redacted-metadata-only', privateFixtureRetainedForRunnerLifetime: preserveFixture },
  };
}

await writeReport(report);
if (report.status !== 'passed') {
  console.error(`Payload preauthority recovery acceptance failed at ${report.failedStage}; redacted report written.`);
  process.exitCode = 1;
} else {
  console.log('Payload four-store preauthority recovery acceptance passed.');
}

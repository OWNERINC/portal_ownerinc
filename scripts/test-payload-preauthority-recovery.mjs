import assert from 'node:assert/strict';
import { createPrivateRecoveryRoot, initializePreauthority, legacySourceMaterial,
  validateRecoveryPrivateAncestry, verifyInitializerCheckout } from './integration/payload-preauthority-initialize.mjs';
import { runCatalogNegative } from './integration/payload-preauthority-negative.mjs';
import {
  assertRecoveryCondition, assertRecoverySnapshots, createPrivateSnapshotEvidence,
  holdFailedRecoveryFixtures, postRestoreFixtureHoldScript,
} from './integration/payload-preauthority-snapshot.mjs';
import { logicalSnapshotScript, LOGICAL_SNAPSHOT_MAX_BYTES } from './integration/payload-logical-snapshot.mjs';
import { CONVERSION_PROBE_CONTEXT } from './integration/payload-logical-snapshot-probe-protocol.mjs';
import { recoveryPayloadRelease, recoveryComposeArgs, recoveryFixtureEnvironment,
  conversionProbeCommandInput, writerRestartCommandInput } from './integration/payload-preauthority-snapshot-runtime.mjs';
import { WRITER_RESTART_CONTEXT } from './integration/payload-preauthority-writer-restart-protocol.mjs';
import { assertWriterIdentities } from './integration/payload-preauthority-writer-restart.mjs';
import { POST_RESTORE_HOLD_CONTEXT, POST_RESTORE_HOLD_TIMEOUT_MS,
  parseFixtureFailureHold } from './integration/payload-preauthority-snapshot-hold.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chown, chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import {
  candidateImagesValid, createFixtureProjectNames, createInventory,
  createSyntheticValues, fixtureStopCommandTimeoutMs, FIXTURE_STOP_TIMEOUT_SECONDS,
  legacyAnnouncementLookupSql, normalizePgDumpForSnapshot,
  validateRecoveryInputs, writeProtectedInventory,
} from './integration/payload-preauthority-fixture.mjs';
import {
  CMS_READINESS_ROUTE, createReadinessDiagnostic,
  createRecoveryProgressReport,
  inferReadinessFailureReason,
} from './integration/payload-preauthority-diagnostics.mjs';
import {
  assertRootOwnerGuardProbe, controlCommandOptions, coordinatorCommandOptions, createLeasedCommandInvocation,
  createBoundedCommandStderr, createFixtureCommandFailure,
  FixtureFailure, persistPrivateCommandEvidence, runFixtureCommand,
} from './integration/payload-preauthority-command.mjs';
import {
  createRecoveryFailureReportFields, runSnapshotAndRestart,
} from './integration/payload-preauthority-recovery-flow.mjs';

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
const privateCommandEvidence = [];
const privateSnapshotEvidence = createPrivateSnapshotEvidence();
const restoreAcceptanceProgress = {
  first: { coordinatorReturnedSuccessfully: false, fullSnapshotComparisonPassed: false },
  second: { coordinatorReturnedSuccessfully: false, fullSnapshotComparisonPassed: false },
};
let failureReportFields = null;
const recoveryProgress = {
  source: { initialCmsHealthPassed: false, writersRestartedHealthy: false, quiescentSnapshotComparison: 'not_started' },
  target: { initialCmsHealthPassed: false, writersRestartedHealthy: false, quiescentSnapshotComparison: 'not_started' },
  leaseTarget: { initialCmsHealthPassed: false, writersRestartedHealthy: false, quiescentSnapshotComparison: 'not_started' },
};

const rootOwnerProbeScript = String.raw`
set -uo pipefail
lock=$1
expected_identity=$2
guard=$3
release=$4
mutation_stderr=$5
adapter_stderr=$6
restoration_stderr=$7
[[ "$PORTAL_OPERATION_LOCK_HELD" == "$lock" && ! -L "$lock" && -f "$lock" && /proc/$$/fd/9 -ef "$lock" ]] || {
  printf 'Owner regression probe could not confirm inherited lease\n' >&2
  exit 92
}
lock_identity=$(stat -Lc '%d:%i' -- "$lock" 2>/dev/null) || exit 93
lock_gid=$(stat -c '%g' -- "$lock" 2>/dev/null) || exit 93
[[ "$lock_identity" == "$expected_identity" && "$(stat -c '%u' -- "$lock" 2>/dev/null)" == 0 ]] || exit 94
mutation_status=125
adapter_status=125
restoration_status=125
probe_started=0
identity_preserved=0
lock_uid=unknown
restored_gid=unknown
finish_probe() {
  original_status=$?
  trap - EXIT
  set +e
  if [[ "$probe_started" == 1 ]]; then
    current_identity=$(stat -Lc '%d:%i' -- "$lock" 2>/dev/null)
    if [[ "$current_identity" == "$lock_identity" && /proc/$$/fd/9 -ef "$lock" ]]; then
      identity_preserved=1
      chown "0:$lock_gid" -- "$lock" 2>"$restoration_stderr"
      restoration_status=$?
    else
      restoration_status=1
      printf 'fixture_lock_identity_changed\n' >"$restoration_stderr"
    fi
    restored_identity=$(stat -Lc '%d:%i' -- "$lock" 2>/dev/null)
    if [[ "$restored_identity" != "$lock_identity" || ! /proc/$$/fd/9 -ef "$lock" ]]; then
      identity_preserved=0
      if [[ "$restoration_status" == 0 ]]; then restoration_status=1; fi
    fi
    lock_uid=$(stat -c '%u' -- "$lock" 2>/dev/null) || lock_uid=unknown
    restored_gid=$(stat -c '%g' -- "$lock" 2>/dev/null) || restored_gid=unknown
    restoration_verified=0
    if [[ "$identity_preserved" == 1 && "$restoration_status" == 0 && "$lock_uid" == 0 \
      && "$restored_gid" == "$lock_gid" && /proc/$$/fd/9 -ef "$lock" ]]; then
      restoration_verified=1
    fi
    printf 'mutation_exit=%s\nadapter_exit=%s\nrestoration_exit=%s\nlock_identity_preserved=%s\nrestoration_verified=%s\nlock_uid=%s\nlock_gid=%s\n' \
      "$mutation_status" "$adapter_status" "$restoration_status" "$identity_preserved" "$restoration_verified" "$lock_uid" "$restored_gid"
    exit 0
  fi
  exit "$original_status"
}
trap finish_probe EXIT
probe_started=1
if chown "65534:$lock_gid" -- "$lock" 2>"$mutation_stderr"; then
  mutation_status=0
else
  mutation_status=$?
  exit 0
fi
if [[ "$(stat -c '%u' -- "$lock" 2>/dev/null)" != 65534 ]]; then
  mutation_status=1
  printf 'fixture_nonroot_owner_not_applied\n' >"$mutation_stderr"
  exit 0
fi
if "$guard" verify-release "$release" '' >/dev/null 2>"$adapter_stderr"; then
  adapter_status=0
else
  adapter_status=$?
fi
exit 0
`;

function safeEnvironment(extra = {}) {
  return { PATH: hostPath, HOME: '/root', ...extra };
}

function run(command, args = [], options = {}) {
  return runFixtureCommand(command, args, {
    ...options,
    cwd: options.cwd || repository,
    env: safeEnvironment(options.env),
    activeSubstep,
    privateCommandEvidence,
  });
}

function text(result) { return result.toString('utf8').trim(); }

function setStage(value) {
  stage = value;
  activeSubstep = null;
}

function setSubstep(value) { activeSubstep = value; }

function composeArgs(project, release, runtime, actionArgs) {
  return recoveryComposeArgs(project, release, runtime, actionArgs);
}

function compose(project, release, runtime, actionArgs, options = {}) {
  return run('env', [
    '-i', `PATH=${hostPath}`, 'HOME=/root', 'docker', 'compose',
    ...composeArgs(project, release, runtime, actionArgs),
  ], options);
}

function fixtureEnv(project, runtime, release) {
  return recoveryFixtureEnvironment(project, runtime, hostPath);
}

function withLease(runtime, project, command, args = [], options = {}) {
  const lock = runtime.inventory.document.paths.lock;
  const invocation = createLeasedCommandInvocation(lock, command, args);
  return run(invocation.command, invocation.args, {
    ...options,
    env: { ...fixtureEnv(project, runtime, options.release || runtime.payloadRelease), ...options.env },
  });
}

function guard(runtime, project, action, release = runtime.payloadRelease, evidence = '') {
  const options = controlCommandOptions(action, release);
  setSubstep(options.substep);
  const result = withLease(runtime, project, path.join(runtime.directory, 'payload-control'),
    [action, release, evidence], options);
  setSubstep(null);
  return result;
}

function coordinator(runtime, project, action, release, backup = '') {
  const script = path.join(release, 'scripts', 'payload-operations.sh');
  const args = action === 'backup' ? [script, 'backup', release] : [script, 'restore', release, backup, '--confirm', 'RESTORE'];
  return run('bash', args, { cwd: release, env: fixtureEnv(project, runtime, release), timeout: 15 * 60_000,
    ...coordinatorCommandOptions(action, release) });
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

async function assertFixtureRootUid(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
    'fixture protected input must remain a regular, unlinked file');
  assert.equal(info.uid, 0, 'fixture protected input must satisfy the adapter root-UID contract');
}

async function ensureFixtureRootUid(file) {
  const before = await lstat(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
    'fixture control input must remain a regular, unlinked file');
  if (before.uid !== 0) await chown(file, 0, before.gid);
  await assertFixtureRootUid(file);
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
    `CMS_CONTROLLER_PASSWORD=${credentials.cmsController}`,
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
  await validateRecoveryPrivateAncestry(path.dirname(root), true);
  await mkdir(root, { mode: 0o700 });
  await validateRecoveryPrivateAncestry(root, true);
  const runtimeDirectory = path.join(root, 'runtime');
  const releases = path.join(root, 'releases');
  await Promise.all([
    mkdir(runtimeDirectory, { mode: 0o700 }),
    mkdir(releases, { mode: 0o700 }),
    mkdir(path.join(root, 'backups'), { mode: 0o700 }),
    mkdir(path.join(root, 'restore-protection'), { mode: 0o700 }),
  ]);
  const { document, identity } = createInventory({
    project, root,
    trustedSourceInventoryIdentities: sourceInventoryIdentity ? [sourceInventoryIdentity] : [],
  });
  await writeProtectedInventory(runtimeDirectory, document);
  await ensureFixtureRootUid(path.join(runtimeDirectory, 'payload-control-inventory.json'));
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
  await ensureFixtureRootUid(document.paths.composeOverride);
  await ensureFixtureRootUid(document.paths.payloadOverride);
  await writeRootFile(document.paths.lock, 'disposable shared operation lease\n');
  await assertFixtureRootUid(document.paths.lock);

  const sourceMaterial = legacySourceMaterial(images);
  const legacyRelease = path.join(releases, sourceMaterial.releaseId);
  const payloadRelease = recoveryPayloadRelease(releases, runIdentity.commit);
  await copyReleaseSources(legacyRelease);
  await copyReleaseSources(payloadRelease);
  await writeRootFile(path.join(legacyRelease, '.image-env'), sourceMaterial.manifest);
  await writeRootFile(path.join(payloadRelease, '.image-env'),
    `API_IMAGE=${images.api}\nCRON_IMAGE=${images.cron}\nCMS_IMAGE=${images.cms}\nRELEASE_FORMAT=payload-v1\n`);
  for (const protectedCmsInput of [
    path.join(payloadRelease, 'cms', 'src', 'migrations', '20261006_181424_z_owner_news_native.json'),
    path.join(payloadRelease, 'cms', 'scripts', 'finalize-news-protocol.ts'),
  ]) {
    await ensureFixtureRootUid(protectedCmsInput);
  }
  const port = await allocatePort();
  const credentials = createSyntheticValues();
  const secret = () => randomBytes(48).toString('base64url');
  Object.assign(credentials, {
    portalAdmin: secret(), portalApi: secret(), portalCron: secret(), cmsAdmin: secret(),
    cmsController: secret(), cmsMigrator: secret(), cmsRuntime: secret(), payloadSecret: secret(), payloadToPortal: secret(),
    portalToPayload: secret(), smtpPassword: secret(), workerSecret: secret(),
  });
  await writeRootFile(document.paths.environmentFile, envFileContents({ project, port, credentials }));
  await ensureFixtureRootUid(document.paths.environmentFile);
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

async function assertAdapterRejectsNonRootOwner(runtime) {
  setStage('fixture_root_owner_guard_regression');
  const lock = runtime.inventory.document.paths.lock;
  const original = await lstat(lock, { bigint: true });
  assert.equal(original.uid, 0n, 'protected fixture lock must start with the adapter-required root UID');
  assert.ok(original.isFile() && !original.isSymbolicLink() && original.nlink === 1n,
    'protected fixture lock must remain a regular, unlinked file');
  const privateDirectory = path.join(fixtureRoot, 'private-diagnostics');
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await chmod(privateDirectory, 0o700);
  const probeId = randomUUID();
  const privateFiles = {
    mutation: path.join(privateDirectory, `owner-mutation-${probeId}.stderr`),
    adapter: path.join(privateDirectory, `owner-adapter-${probeId}.stderr`),
    restoration: path.join(privateDirectory, `owner-restoration-${probeId}.stderr`),
  };
  for (const file of Object.values(privateFiles)) {
    await writeFile(file, '', { flag: 'wx', mode: 0o600 });
    await chmod(file, 0o600);
  }
  const evidenceStart = privateCommandEvidence.length;
  const options = controlCommandOptions('verify-release', runtime.payloadRelease);
  const commandArgs = [
    '-c', rootOwnerProbeScript,
    'payload-root-owner-regression',
    lock,
    `${original.dev}:${original.ino}`,
    path.join(runtime.directory, 'payload-operations-guard'),
    runtime.payloadRelease,
    privateFiles.mutation,
    privateFiles.adapter,
    privateFiles.restoration,
  ];
  let commandOutput;
  let commandFailure;
  try {
    commandOutput = withLease(runtime, runtime.project, 'bash', commandArgs, {
      release: runtime.payloadRelease,
      substep: 'fixture_root_owner_lease_probe',
      preservePrivateErrorEvidence: true,
    });
  } catch (error) {
    commandFailure = error;
  }
  const privateStderr = {};
  for (const [key, file] of Object.entries(privateFiles)) {
    const bytes = await readFile(file).catch(() => Buffer.alloc(0));
    privateStderr[key] = bytes.subarray(0, 16 * 1024);
  }
  setSubstep(null);
  const retainPrivateProbeEvidence = () => {
    for (const [key, stderr] of Object.entries(privateStderr)) {
      if (stderr.length > 0 && privateCommandEvidence.length < 8) {
        const substep = key === 'adapter' ? options.substep
          : key === 'mutation' ? 'fixture_set_nonroot_owner' : 'fixture_restore_root_owner';
        privateCommandEvidence.push({ substep, stderr: Buffer.from(stderr) });
      }
    }
  };
  if (commandFailure) {
    retainPrivateProbeEvidence();
    throw commandFailure;
  }

  const protocol = commandOutput.toString('utf8').match(
    /^mutation_exit=(\d{1,3})\nadapter_exit=(\d{1,3})\nrestoration_exit=(\d{1,3})\nlock_identity_preserved=([01])\nrestoration_verified=([01])\nlock_uid=(\d{1,10}|unknown)\nlock_gid=(\d{1,10}|unknown)\n$/u,
  );
  if (!protocol) {
    retainPrivateProbeEvidence();
    throw new Error('owner regression probe returned an invalid fixed status protocol');
  }
  const after = await lstat(lock, { bigint: true }).catch(() => null);
  const lockIdentityPreserved = protocol[4] === '1' && after !== null
    && after.dev === original.dev && after.ino === original.ino;
  assertRootOwnerGuardProbe({
    mutationStatus: Number(protocol[1]),
    mutationStderr: privateStderr.mutation,
    adapterStatus: Number(protocol[2]),
    adapterStderr: privateStderr.adapter,
    restorationStatus: Number(protocol[3]),
    restorationStderr: privateStderr.restoration,
    lockIdentityPreserved,
    restorationVerifiedUnderLease: protocol[5] === '1',
    lockUid: protocol[6] === 'unknown' ? null : Number(protocol[6]),
    lockGid: protocol[7] === 'unknown' ? null : Number(protocol[7]),
    lockUidAfterLease: after === null ? null : Number(after.uid),
    lockGidAfterLease: after === null ? null : Number(after.gid),
    expectedGid: Number(original.gid),
    controlCommandContext: options.controlCommandContext,
    privateCommandEvidence,
  });
  // The helper returns only after exact adapter attribution and restoration of
  // the original root-owned inode have both passed. If file cleanup fails, keep
  // the buffers so the outer failure path can persist them privately.
  setSubstep('fixture_root_owner_evidence_cleanup');
  await Promise.all(Object.values(privateFiles).map(file => rm(file, { force: true })));
  privateCommandEvidence.splice(evidenceStart);
  setSubstep(null);
}

function composeCall(runtime, actionArgs, options = {}) {
  return compose(runtime.project, runtime.payloadRelease, runtime, actionArgs, options);
}

async function awaitService(runtime, service, attempts = 180) {
  const safeService = service.replaceAll('-', '_');
  let lastContainerId = null;
  let lastHealthStatus = 'unknown';
  const readinessDiagnostic = async (reason, containerId) => {
    let containerState = 'unknown';
    let healthStatus = 'unknown';
    let containerExitCode = null;
    if (containerId) {
      try {
        const stateText = text(run('docker', ['inspect', '--format',
          '{{.State.Status}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', containerId], {
          timeout: 10_000,
          substep: 'readiness_container_inspect',
          preservePrivateErrorEvidence: true,
        }));
        const parsed = stateText.match(/^(created|restarting|running|removing|paused|exited|dead)\|(\d{1,3})\|(starting|healthy|unhealthy|none)$/u);
        if (parsed) {
          [, containerState] = parsed;
          containerExitCode = Number(parsed[2]);
          healthStatus = parsed[3];
        }
      } catch { /* Safe metadata remains unknown; private stderr is retained if available. */ }
    }

    let readinessHttpStatus = null;
    if (service === 'cms' && containerId && !['exited', 'dead', 'removing'].includes(containerState)) {
      const probe = `fetch("http://127.0.0.1:3001${CMS_READINESS_ROUTE}",{signal:AbortSignal.timeout(3000)})` +
        '.then(async response=>{const status=String(response.status);await response.body?.cancel().catch(()=>{});process.stdout.write(status)})' +
        '.catch(()=>process.stdout.write("unavailable"))';
      try {
        const status = text(run('docker', ['exec', containerId, 'node', '-e', probe], {
          timeout: 8_000,
          substep: 'readiness_http_probe',
          preservePrivateErrorEvidence: true,
        }));
        if (/^[1-5]\d\d$/u.test(status)) readinessHttpStatus = Number(status);
      } catch { /* Never include probe output or body in the report. */ }
    }

    const observedReason = inferReadinessFailureReason(reason, { containerId, containerState, healthStatus });
    return createReadinessDiagnostic({
      reason: observedReason,
      containerState,
      healthStatus,
      containerExitCode,
      readinessHttpStatus,
      service,
    });
  };
  const failReadiness = async (reason, containerId, originalError = null) => {
    const detail = await readinessDiagnostic(reason, containerId);
    const failedSubstep = originalError?.diagnostic?.substep || activeSubstep;
    setSubstep(failedSubstep);
    throw new FixtureFailure(
      originalError instanceof FixtureFailure ? originalError.code : `service_${service}_not_ready`,
      originalError instanceof FixtureFailure ? originalError.diagnostic : null,
      detail,
    );
  };

  for (let index = 0; index < attempts; index += 1) {
    setSubstep(`wait_${safeService}_container`);
    const id = text(composeCall(runtime, ['ps', '-q', service], {
      substep: `wait_${safeService}_container`,
      preservePrivateErrorEvidence: true,
    }));
    if (id) {
      lastContainerId = id;
      setSubstep(`wait_${safeService}_health`);
      let state;
      try {
        state = text(run('docker', ['inspect', '--format', '{{.State.Health.Status}}', id], {
          substep: `wait_${safeService}_health`,
          preservePrivateErrorEvidence: true,
        }));
      } catch (error) {
        if (!(error instanceof FixtureFailure)) throw error;
        await failReadiness('health_inspect_failed', id, error);
      }
      lastHealthStatus = ['starting', 'healthy', 'unhealthy'].includes(state) ? state : 'unknown';
      if (state === 'healthy') {
        setSubstep(null);
        return;
      }
      setSubstep(`wait_${safeService}_container_state`);
      let containerState;
      try {
        containerState = text(run('docker', ['inspect', '--format', '{{.State.Status}}', id], {
          substep: `wait_${safeService}_container_state`,
          preservePrivateErrorEvidence: true,
        }));
      } catch (error) {
        if (!(error instanceof FixtureFailure)) throw error;
        await failReadiness('container_inspect_failed', id, error);
      }
      if (containerState === 'exited' || containerState === 'dead') {
        await failReadiness('exited', id);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await failReadiness(lastContainerId && lastHealthStatus === 'unhealthy' ? 'unhealthy' : 'wait_deadline', lastContainerId);
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
  // The actual ops initializer captures/signs B0, advances the shared journal,
  // binds physical creator receipts and commits the floor under one fd9 lease.
  // It returns closed/held. Readiness and fixture data happen only afterwards.
  setSubstep('payload_initialize_isolated');
  await initializePreauthority({ runtime, runIdentity, images, run, withLease });
  composeWithLease(runtime, ['up', '--detach', '--no-deps', '--no-recreate', '--no-build', '--pull', 'never', 'api', 'cron', 'cms']);
  await awaitService(runtime, 'api');
  await awaitService(runtime, 'cron');
  await awaitService(runtime, 'cms');
  recoveryProgress[runtime.role].initialCmsHealthPassed = true;
  guard(runtime, runtime.project, 'verify-release', runtime.payloadRelease);
  withLease(runtime, runtime.project, path.join(runtime.directory, 'payload-operations-guard'),
    ['open-admission', runtime.payloadRelease, '']);
  await seedProject(runtime);
  setStage(`verify_release_${runtime.role}`);
  guard(runtime, runtime.project, 'verify-release', runtime.payloadRelease);
  setSubstep(null);
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

function logicalDatabaseSnapshot(runtime, service, database, user) {
  const capture = composeCall(runtime, ['exec', '-T', service, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=sqlstate',
    `--dbname=${database}`, `--username=${user}`], {
    input: logicalSnapshotScript, maxBuffer: LOGICAL_SNAPSHOT_MAX_BYTES,
    failureCode: 'logical_snapshot_capture_failed', preservePrivateErrorEvidence: true, sqlCommandContext: true,
  });
  const result = run(process.execPath, ['--import',
    pathToFileURL(path.join(repository, 'cms', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
    path.join(repository, 'scripts', 'integration', 'payload-logical-snapshot-cli.mjs')], {
    input: capture, maxBuffer: 64 * 1024, failureCode: 'logical_snapshot_fingerprint_failed',
    preservePrivateErrorEvidence: true, logicalSnapshotCommandContext: 'logical-snapshot-cli',
  });
  const value = JSON.parse(text(result));
  if (!value || Object.keys(value).sort().join(',') !== 'data,schema'
      || !/^[0-9a-f]{64}$/u.test(value.data) || !/^[0-9a-f]{64}$/u.test(value.schema)) {
    throw new FixtureFailure('logical_snapshot_invalid_result');
  }
  return value;
}

function storageFingerprint(runtime, service, location, capture = () => {}) {
  const archive = composeCall(runtime, ['run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'tar',
    service, '-cf', '-', '-C', location, '.']);
  capture(archive);
  const script = String.raw`
import importlib.util, sys
path = sys.argv[1]
spec = importlib.util.spec_from_file_location('payload_control_runtime', path)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
print(module._tar_tree(sys.stdin.buffer, compressed=False))
`;
  return text(run(python, ['-c', script, path.join(runtime.directory, 'payload-control-runtime.py')], { input: archive }));
}

function snapshot(runtime, evidenceLabel = null) {
  const capture = (component, bytes) => {
    if (evidenceLabel) privateSnapshotEvidence.capture(evidenceLabel, component, bytes);
    return bytes;
  };
  setSubstep('snapshot_portal_logical_database');
  const portal = logicalDatabaseSnapshot(runtime, 'postgres', 'portal', 'portal_admin');
  setSubstep('snapshot_cms_logical_database');
  const cms = logicalDatabaseSnapshot(runtime, 'cms-postgres', 'ownerinc_cms', 'cms_admin');
  const portalDatabase = portal.data; const portalSchema = portal.schema;
  const cmsDatabase = cms.data; const cmsSchema = cms.schema;
  if (evidenceLabel) {
    setSubstep('snapshot_private_dump_evidence');
    capture('portalDatabase', databaseDump(runtime, 'postgres', 'portal', 'portal_admin'));
    capture('cmsDatabase', databaseDump(runtime, 'cms-postgres', 'ownerinc_cms', 'cms_admin'));
    capture('portalSchema', databaseSchemaDump(runtime, 'postgres', 'portal', 'portal_admin'));
    capture('cmsSchema', databaseSchemaDump(runtime, 'cms-postgres', 'ownerinc_cms', 'cms_admin'));
  }
  setSubstep('snapshot_portal_uploads');
  const portalUploads = storageFingerprint(runtime, 'api', '/app/uploads', bytes => capture('portalUploads', bytes));
  setSubstep('snapshot_cms_media');
  const cmsUploads = storageFingerprint(runtime, 'cms', '/var/lib/ownerinc-cms/media', bytes => capture('cmsUploads', bytes));
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
  const snapshotStage = stage;
  setSubstep('snapshot_list_writers');
  const running = text(composeCall(runtime, ['ps', '--status', 'running', '--services']))
    .split(/\r?\n/u).filter(Boolean);
  const writers = ['api', 'cron', 'cms'].filter(service => running.includes(service));
  assert.deepEqual(writers, ['api', 'cron', 'cms'],
    'all fixture application writers must be running before the quiescence check');
  setSubstep('snapshot_observe_writer_identities');
  const observedWriters = JSON.parse(withLease(runtime, runtime.project, process.execPath, [
    path.join(repository, 'scripts', 'integration', 'payload-preauthority-writer-restart.mjs'),
  ], {
    ...writerRestartCommandInput(runtime, { commit: runIdentity.commit, python, mode: 'observe' }),
    substep: 'snapshot_observe_writer_identities', writerRestartCommandContext: WRITER_RESTART_CONTEXT,
    writerRestartMode: 'observe', timeout: 420_000, preservePrivateErrorEvidence: true,
  }).toString('utf8'));
  assertWriterIdentities(observedWriters);
  setSubstep('snapshot_stop_writers');
  composeWithLease(runtime, ['stop', '--timeout', String(FIXTURE_STOP_TIMEOUT_SECONDS), ...writers], {
    substep: 'snapshot_stop_writers',
    timeout: fixtureStopCommandTimeoutMs(writers.length),
  });
  const outcome = await runSnapshotAndRestart(
    async () => {
      setSubstep('snapshot_verify_writers_stopped');
      const remainingWriters = text(composeCall(runtime, ['ps', '--status', 'running', '--services']))
        .split(/\r?\n/u).filter(service => writers.includes(service));
      assert.deepEqual(remainingWriters, [],
        'every fixture writer must be stopped before any snapshot is captured');
      recoveryProgress[runtime.role].quiescentSnapshotComparison = 'running';
      try {
        const first = snapshot(runtime);
        const second = snapshot(runtime);
        setSubstep('snapshot_compare_quiescent');
        assert.deepEqual(second, first,
          'repeated quiescent snapshots must preserve every database row, sequence, catalog and file tree');
        if (runtime.role === 'source') {
          // Mandatory Linux prerequisite, not a twelfth restore-negative case.
          // The child owns one inherited lease for DDL + actual capture + cleanup
          // + full-store comparison while this callback keeps writers stopped.
          setSubstep('linux_conversion_prerequisite');
          const conversion = withLease(runtime, runtime.project, process.execPath, [
            path.join(repository, 'scripts', 'integration', 'payload-logical-snapshot-conversion-probe.mjs'),
          ], {
            ...conversionProbeCommandInput(runtime, { commit: runIdentity.commit, python }),
            substep: 'linux_conversion_prerequisite', failureCode: 'linux_conversion_prerequisite_failed',
            conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT,
            timeout: 15 * 60_000, maxBuffer: 64 * 1024, preservePrivateErrorEvidence: true,
          });
          if (conversion.toString('utf8') !== 'PAYLOAD_LINUX_CONVERSION_PREREQUISITE passed\n') {
            throw new FixtureFailure('linux_conversion_prerequisite_protocol_invalid', { substep: 'linux_conversion_prerequisite' });
          }
        }
        recoveryProgress[runtime.role].quiescentSnapshotComparison = 'passed';
      } catch (error) {
        recoveryProgress[runtime.role].quiescentSnapshotComparison = 'failed';
        throw error;
      }
      runtime.quiescentSnapshotStable = true;
    },
    async () => {
      setStage(`restart_writers_${runtime.role}`);
      setSubstep('snapshot_restart_writers');
      withLease(runtime, runtime.project, process.execPath, [
        path.join(repository, 'scripts', 'integration', 'payload-preauthority-writer-restart.mjs'),
      ], {
        ...writerRestartCommandInput(runtime, { commit: runIdentity.commit, python, mode: 'restart', identities: observedWriters }),
        substep: 'snapshot_restart_writers', writerRestartCommandContext: WRITER_RESTART_CONTEXT,
        writerRestartMode: 'restart', timeout: 600_000, preservePrivateErrorEvidence: true,
      });
      for (const service of writers) await awaitService(runtime, service);
      recoveryProgress[runtime.role].writersRestartedHealthy = true;
    },
    () => activeSubstep,
  );
  if (outcome.primaryError) {
    failureReportFields = {
      ...createRecoveryFailureReportFields(outcome),
      failedStage: outcome.primaryPhase === 'snapshot' ? snapshotStage : stage,
    };
    throw outcome.primaryError;
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
  const evidenceStart = privateCommandEvidence.length;
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
  // Discard expected failure output only after every no-mutation assertion.
  privateCommandEvidence.splice(evidenceStart);
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
  const evidenceStart = privateCommandEvidence.length;
  const ddl = statement => composeWithLease(runtime, ['exec', '-T', 'cms-postgres', 'psql', '-Xq', '-v', 'ON_ERROR_STOP=1',
    '--dbname=ownerinc_cms', '--username=cms_admin'], { input: `${statement}\n`, preservePrivateErrorEvidence: true });
  await runCatalogNegative(label, {
    setSubstep, snapshot: () => snapshot(runtime),
    inject: () => ddl(sql), cleanup: () => ddl(cleanupSql),
    restore: () => coordinator(runtime, runtime.project, 'restore', runtime.payloadRelease, backup),
    assertWorkerHeld: () => assertWorkerHeld(runtime),
  });
  privateCommandEvidence.splice(evidenceStart);
  negativeCases.push({ name: label, rejected: true, targetContentUnchanged: true, fixtureDdlCleaned: true });
}

async function targetContentRace(runtime, backup) {
  setStage('negative_target_changed_after_preflight');
  const before = snapshot(runtime);
  const restoreScript = path.join(runtime.payloadRelease, 'scripts', 'payload-operations.sh');
  const evidenceStart = privateCommandEvidence.length;
  const stderr = createBoundedCommandStderr();
  const child = spawn('bash', [restoreScript, 'restore', runtime.payloadRelease, backup, '--confirm', 'RESTORE'], {
    cwd: runtime.payloadRelease,
    env: fixtureEnv(runtime.project, runtime, runtime.payloadRelease),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => stderr.append(chunk));
  let processError = null;
  let closed = false;
  child.on('error', error => { processError = error; });
  const settled = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  const retainFailure = (failureCode, error = processError) => createFixtureCommandFailure({
    status: child.exitCode, stderr: stderr.buffer(), error,
  }, { ...coordinatorCommandOptions('restore', runtime.payloadRelease), failureCode, privateCommandEvidence });
  let injected = false;
  const deadline = Date.now() + 10 * 60_000;
  try {
    while (Date.now() < deadline && !closed) {
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
    if (!closed) {
      child.kill('SIGKILL');
      child.stderr.destroy(); // A descendant must not hold the diagnostic pipe past the deadline.
      await settled;
      throw retainFailure('target_change_restore_timeout', { code: 'ETIMEDOUT' });
    }
    if (processError || child.signalCode || !Number.isInteger(child.exitCode)) throw retainFailure('coordinator_restore_failed');
    if (!injected || child.exitCode === 0) throw retainFailure('target_change_was_not_rejected');
    retainFailure('coordinator_restore_failed');
    const after = snapshot(runtime);
    assertUnchanged(before, after, 'target_volume_inventory_changed_after_reservation');
    assertWorkerHeld(runtime);
    run('docker', ['volume', 'rm', runtime.extraVolume]);
    runtime.extraVolume = null;
    negativeCases.push({ name: 'target_changed_after_restore_preflight', rejected: true,
      targetContentUnchanged: true, raceInjectedAfterLeaseReservation: true });
    privateCommandEvidence.splice(evidenceStart);
  } catch (error) {
    // A fixture assertion/injection failure must not abandon an active child or
    // discard its stderr. Preserve that primary error; record coordinator output
    // privately after the pipe has closed, including launch/timeout cases.
    if (!closed) { child.kill('SIGKILL'); child.stderr.destroy(); await settled; }
    if (privateCommandEvidence.length === evidenceStart) retainFailure('coordinator_restore_failed');
    throw error;
  }
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
  await verifyInitializerCheckout({ runIdentity, run });
  fixtureRoot = await createPrivateRecoveryRoot(runIdentity);
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
  source.role = 'source';
  target.role = 'target';
  leaseTarget.role = 'leaseTarget';
  runtimeRefs = [source, target, leaseTarget];
  inventoryIdentities.target = target.inventory.identity;
  inventoryIdentities.leaseTarget = leaseTarget.inventory.identity;
  await assertAdapterRejectsNonRootOwner(source);

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
  const targetBefore = snapshot(target, 'first_target_before');
  coordinator(target, target.project, 'restore', target.payloadRelease, targetBackup);
  restoreAcceptanceProgress.first.coordinatorReturnedSuccessfully = true;
  setSubstep('verify_restored_authority');
  assertRecoveryCondition('restored_authority_mismatch', databaseAuthority(target) === 'legacy/1');
  setSubstep('verify_source_announcement');
  const sourceAnnouncement = legacyAnnouncement(source, source.legacyAnnouncementId);
  assertRecoveryCondition('source_announcement_invalid', /synthetic legacy recovery fixture/u.test(sourceAnnouncement));
  setSubstep('verify_restored_source_document');
  assertRecoveryCondition('restored_source_document_mismatch', legacyAnnouncement(target, source.legacyAnnouncementId) === sourceAnnouncement);
  setSubstep('verify_restored_target_document_absent');
  assertRecoveryCondition('restored_target_document_present', legacyAnnouncement(target, target.legacyAnnouncementId) === '');
  setSubstep('verify_restored_worker_hold');
  try { assertWorkerHeld(target); } catch (error) {
    if (error instanceof FixtureFailure) throw error;
    assertRecoveryCondition('restored_worker_hold_failed', false);
  }
  const targetAfter = snapshot(target, 'first_target_after');
  const sourceAfter = snapshot(source, 'first_source_after');
  setSubstep('compare_restored_stores');
  assertRecoverySnapshots(sourceAfter, targetAfter);
  restoreAcceptanceProgress.first.fullSnapshotComparisonPassed = true;
  setSubstep('compare_target_before_after');
  assertRecoverySnapshots(targetBefore, targetAfter, { changed: true });
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
  setStage('second_actual_restore');
  const secondTargetBefore = snapshot(target, 'second_target_before');
  coordinator(target, target.project, 'restore', target.payloadRelease, secondName);
  restoreAcceptanceProgress.second.coordinatorReturnedSuccessfully = true;
  setSubstep('verify_restored_authority');
  assertRecoveryCondition('restored_authority_mismatch', databaseAuthority(target) === 'legacy/1');
  setSubstep('verify_restored_worker_hold');
  try { assertWorkerHeld(target); } catch (error) {
    if (error instanceof FixtureFailure) throw error;
    assertRecoveryCondition('restored_worker_hold_failed', false);
  }
  const secondTargetAfter = snapshot(target, 'second_target_after');
  const secondSourceAfter = snapshot(source, 'second_source_after');
  setSubstep('compare_restored_stores');
  assertRecoverySnapshots(secondSourceAfter, secondTargetAfter);
  restoreAcceptanceProgress.second.fullSnapshotComparisonPassed = true;
  setSubstep('compare_target_before_after');
  assertRecoverySnapshots(secondTargetBefore, secondTargetAfter, { changed: true });
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
    recoveryProgress: createRecoveryProgressReport(recoveryProgress),
    restoreAcceptanceProgress,
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
  // Coordinator restore normally reopens before returning. A later fixture
  // acceptance error must not leave disposable writers/admission active. This
  // does not claim a production pre-open gate and never masks the primary error.
  const fixtureFailureHold = restoreAcceptanceProgress.first.coordinatorReturnedSuccessfully
    ? await holdFailedRecoveryFixtures(runtimeRefs, runtime => {
      const output = withLease(runtime, runtime.project, 'bash', ['-c', postRestoreFixtureHoldScript,
        'payload-fixture-failure-hold', path.join(runtime.directory, 'payload-operations-guard'), runtime.payloadRelease,
        '/usr/bin/env', '-i', `PATH=${hostPath}`, 'HOME=/root', 'docker', 'compose',
        ...composeArgs(runtime.project, runtime.payloadRelease, runtime, [])], {
        substep: 'post_restore_fixture_failure_hold', failureCode: 'post_restore_fixture_hold_failed',
        timeout: POST_RESTORE_HOLD_TIMEOUT_MS, preservePrivateErrorEvidence: true,
        fixtureFailureHoldContext: POST_RESTORE_HOLD_CONTEXT,
      });
      return parseFixtureFailureHold(output, { status: 0 });
    }) : [];
  const privateRunnerErrorEvidenceRetained = await persistPrivateCommandEvidence(
    fixtureRoot, privateCommandEvidence,
  ).catch(() => false);
  const privateSnapshotEvidenceRetained = await privateSnapshotEvidence.persist(fixtureRoot).catch(() => false);
  const commandSubstep = error instanceof FixtureFailure ? error.diagnostic?.substep : null;
  const primarySubstep = commandSubstep && commandSubstep !== 'unclassified_command'
    ? commandSubstep : activeSubstep;
  const failureFields = failureReportFields || createRecoveryFailureReportFields({
    primaryError: error,
    primarySubstep,
  });
  report = {
    schemaVersion: 1, status: 'failed', run: runIdentity,
    images, failedStage: stage,
    ...failureFields,
    checks: safeChecks,
    recoveryProgress: createRecoveryProgressReport(recoveryProgress),
    restoreAcceptanceProgress,
    fixtureFailureHold,
    negativeCases,
    evidence: {
      kind: 'redacted-metadata-only',
      privateFixtureRetainedForRunnerLifetime: preserveFixture,
      privateRunnerErrorEvidenceRetained,
      privateSnapshotEvidenceRetained,
    },
  };
}

await writeReport(report);
if (report.status !== 'passed') {
  console.error(`Payload preauthority recovery acceptance failed at ${report.failedStage}; redacted report written.`);
  process.exitCode = 1;
} else {
  console.log('Payload four-store preauthority recovery acceptance passed.');
}

import path from 'node:path';

// The source-only conversion gate and the three-fixture resume gate share exact
// path/Compose validation. Roles are a hardcoded caller policy, never stdin.
export function assertRecoveryFixtureConfiguration(configuration, environment, roles = ['source']) {
  const p = path.posix;
  const reject = reason => { throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: reason }); };
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
      || Object.keys(configuration).sort().join(',') !== 'commit,composeArgs,project,python,runtimeDirectory') reject('configuration_shape_invalid');
  if (typeof configuration.runtimeDirectory !== 'string'
      || !p.isAbsolute(configuration.runtimeDirectory) || p.resolve(configuration.runtimeDirectory) !== configuration.runtimeDirectory
      || p.basename(configuration.runtimeDirectory) !== 'runtime'
      || !roles.includes(p.basename(p.dirname(configuration.runtimeDirectory)))) reject('configuration_runtime_invalid');
  const role = p.basename(p.dirname(configuration.runtimeDirectory));
  const suffix = { source: 'source', target: 'target', 'lease-target': 'lease' }[role];
  if (!suffix || typeof configuration.project !== 'string'
      || !new RegExp(`^payload-preauth-[a-z0-9-]+-${suffix}$`, 'u').test(configuration.project)) reject('configuration_project_invalid');
  if (typeof configuration.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(configuration.commit)) reject('configuration_commit_invalid');
  if (environment?.PAYLOAD_RECOVERY_COMMIT !== configuration.commit) reject('configuration_commit_mismatch');
  if (environment?.COMPOSE_PROJECT_NAME !== configuration.project) reject('configuration_project_mismatch');
  if (environment?.PORTAL_OPERATION_LOCK !== p.join(configuration.runtimeDirectory, 'deploy.lock')) reject('configuration_lock_mismatch');
  if (environment?.PORTAL_OPERATION_LOCK_HELD !== environment.PORTAL_OPERATION_LOCK) reject('configuration_lease_mismatch');
  if (typeof configuration.python !== 'string' || !configuration.python || configuration.python.includes('\0')) reject('configuration_python_invalid');
  const release = p.join(p.dirname(configuration.runtimeDirectory), 'releases', configuration.commit);
  const expected = ['--profile', 'notifications', '--env-file', p.join(configuration.runtimeDirectory, 'fixture.runtime.conf'),
    '--env-file', p.join(release, '.image-env'), '-f', p.join(release, 'docker-compose.yml'),
    '-f', p.join(release, 'docker-compose.payload.yml'), '-f', p.join(configuration.runtimeDirectory, 'compose.fixture.yaml'),
    '-f', p.join(configuration.runtimeDirectory, 'compose.payload.production.yaml'), '--project-name', configuration.project,
    '--project-directory', release];
  const args = configuration.composeArgs;
  if (!Array.isArray(args) || args.length !== expected.length || !args.every(value => typeof value === 'string')) reject('configuration_compose_shape_invalid');
  if ([0,1,2,4,6,8,10,12,14,16].some(index => args[index] !== expected[index])) reject('configuration_compose_options_mismatch');
  if (args[3] !== expected[3]) reject('configuration_compose_environment_mismatch');
  if ([5,7,9,17].some(index => args[index] !== expected[index])) reject('configuration_compose_release_mismatch');
  if ([11,13].some(index => args[index] !== expected[index])) reject('configuration_compose_override_mismatch');
  if (args[15] !== expected[15]) reject('configuration_compose_project_mismatch');
}

// Pure producers extracted unchanged from the recovery runner so serialization
// tests execute its actual path/Compose/environment contract, not a test copy.
export function recoveryPayloadRelease(releases, commit) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) throw new Error('invalid_recovery_commit');
  return path.join(releases, commit);
}

export function recoveryComposeArgs(project, release, runtime, actionArgs) {
  const paths = runtime.inventory.document.paths;
  return ['--profile', 'notifications', '--env-file', paths.environmentFile,
    '--env-file', path.join(release, '.image-env'), '-f', path.join(release, 'docker-compose.yml'),
    '-f', path.join(release, 'docker-compose.payload.yml'), '-f', paths.composeOverride,
    '-f', paths.payloadOverride, '--project-name', project, '--project-directory', release, ...actionArgs];
}

export function recoveryFixtureEnvironment(project, runtime, hostPath) {
  return { PATH: hostPath, HOME: '/root', COMPOSE_PROJECT_NAME: project,
    PORTAL_OPERATION_LOCK: runtime.inventory.document.paths.lock,
    PAYLOAD_OPERATIONS_GUARD: path.join(runtime.directory, 'payload-operations-guard'),
    COMPOSE_ENV_FILE: runtime.inventory.document.paths.environmentFile,
    COMPOSE_OVERRIDE: runtime.inventory.document.paths.composeOverride,
    BACKUP_DIR: runtime.inventory.document.paths.backupRoots[0],
    PRE_RESTORE_BACKUP_DIR: runtime.inventory.document.paths.preRestoreBackupRoot,
    RESTORE_BASE_URL: runtime.baseUrl, SMOKE_ATTEMPTS: '8' };
}

export function conversionProbeCommandInput(runtime, { commit, python }) {
  return {
    input: JSON.stringify({ project: runtime.project, runtimeDirectory: runtime.directory, commit,
      python, composeArgs: recoveryComposeArgs(runtime.project, runtime.payloadRelease, runtime, []) }),
    // The approved parent run identity is explicit even in the stripped env.
    // It is independent of paths and never learned from a Compose argument.
    env: { PAYLOAD_RECOVERY_COMMIT: commit },
  };
}

export function writerRestartCommandInput(runtime, { commit, python, mode, identities = null }) {
  const wire = conversionProbeCommandInput(runtime, { commit, python });
  return { env: wire.env, input: JSON.stringify({ configuration: JSON.parse(wire.input), mode, identities }) };
}

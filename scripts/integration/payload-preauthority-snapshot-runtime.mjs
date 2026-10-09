import path from 'node:path';

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

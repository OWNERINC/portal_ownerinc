import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function nativeCommand(program, args, options) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: options.timeout, maxBuffer: 8192, killSignal: 'SIGKILL' });
  if (result.error || result.signal || result.status !== 0) {
    const diagnostic = (result.stderr || '').trim();
    throw new Error(/^isolated_b0_recovery_qualification_failed:(preflight|create_resources|capture_baseline|unsupported_schema_negative|damage_fixture|recover_database_interruption|recover_uploads_interruption|recover_final|verify_preserved_evidence|complete|none|guard);cleanup:(none|refused)$/u.test(diagnostic)
      ? diagnostic : 'isolated_b0_recovery_native_failed');
  }
  return result.stdout;
}

export function guard(env = process.env, platform = process.platform) {
  assert.equal(platform, 'linux');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.PAYLOAD_B0_RECOVERY_DISPOSABLE, '1');
  assert.ok(!env.DOCKER_HOST && !env.DOCKER_CONTEXT);
}

export async function qualify({ env = process.env, platform = process.platform, command = nativeCommand } = {}) {
  guard(env, platform);
  // Fixed isolated creator only. No paths, identities, SQL, credentials or signed
  // requests from CLI/env select a restore target. Native code creates its own.
  const helper = fileURLToPath(new URL('../../ops/payload-install-recovery-isolated.py', import.meta.url));
  const raw = await command('sudo', ['-n', '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/root',
    'GITHUB_ACTIONS=true', 'RUNNER_ENVIRONMENT=github-hosted', 'PAYLOAD_B0_RECOVERY_DISPOSABLE=1',
    'python3', '-I', '-S', '-B', helper, '--qualify'], { timeout: 290000 });
  assert.ok(Buffer.byteLength(raw) <= 1024);
  const proof = JSON.parse(raw);
  assert.equal(proof.kind, 'isolated-b0-recovery-proof');
  for (const name of ['dataVerified', 'admissionClosed', 'readinessPending', 'databaseAndUploadsInterruptionsReconciled', 'unrelatedEvidencePreserved', 'ownedResourcesRemoved']) assert.equal(proof[name], true);
  for (const name of ['productionAuthorized', 'applicationRollbackExecuted', 'applicationCompatibilityQualified']) assert.equal(proof[name], false);
  assert.equal(Object.keys(proof).length, 10);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) process.exitCode = 1;
  else qualify().then(proof => console.log(JSON.stringify(proof))).catch(error => {
    console.error(/^isolated_b0_recovery_qualification_failed:(preflight|create_resources|capture_baseline|unsupported_schema_negative|damage_fixture|recover_database_interruption|recover_uploads_interruption|recover_final|verify_preserved_evidence|complete|none|guard);cleanup:(none|refused)$/u.test(error.message)
      ? error.message : 'isolated_b0_recovery_native_failed'); process.exitCode = 1;
  });
}

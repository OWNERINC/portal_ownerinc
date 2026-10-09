import { randomUUID } from 'node:crypto';
import { fstatSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FixtureFailure, runFixtureCommand, persistPrivateCommandEvidence } from './payload-preauthority-command.mjs';
import { logicalSnapshotScript, LOGICAL_SNAPSHOT_MAX_BYTES } from './payload-logical-snapshot.mjs';
import { assertRecoverySnapshots } from './payload-preauthority-snapshot.mjs';
import { CONVERSION_PROBE_SUCCESS, encodeConversionProbeFailure, conversionProbeReasons, conversionCliLaunchReason } from './payload-logical-snapshot-probe-protocol.mjs';
import { assertRecoveryFixtureConfiguration } from './payload-preauthority-snapshot-runtime.mjs';

/** Exact arguments of the existing source fixture, never an arbitrary Compose
 * project/release accepted merely because the environment says "source". */
export function assertConversionFixtureConfiguration(configuration, environment) {
  return assertRecoveryFixtureConfiguration(configuration, environment, ['source']);
}

/** The creation flag is set only after successful actual DDL. No DROP IF EXISTS
 * or cleanup of a pre-existing object. A cleanup failure never replaces the
 * original rejection/capture failure. Linux capability absence is a failure. */
export async function verifyLinuxConversionPrerequisite(operations) {
  const name = `fixture_conversion_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let cleaned = false;
  let primary = null;
  let primaryStep = null;
  let step = 'conversion_baseline';
  let baseline;
  const failureStep = () => operations.failureStep?.() || step;
  try {
    operations.step(step);
    await operations.assertStopped();
    baseline = await operations.snapshot();
    step = 'conversion_create'; operations.step(step);
    await operations.create(name);
    created = true;
    step = 'conversion_catalog_presence'; operations.step(step);
    if (await operations.present(name) !== true) throw new FixtureFailure('logical_snapshot_conversion_presence_failed');
    step = 'conversion_require_rejection'; operations.step(step);
    let rejected = false;
    try { await operations.captureActual(); }
    catch (error) {
      if (!(error instanceof FixtureFailure) || error.diagnostic?.commandExitCode !== 2
          || error.diagnostic?.commandError || error.diagnostic?.commandSignal
          || error.diagnostic?.logicalSnapshotErrorIdentifier !== 'logical_snapshot_unsupported_object') throw error;
      rejected = true;
    }
    if (!rejected) throw new FixtureFailure('logical_snapshot_conversion_not_rejected');
  } catch (error) { primary = error; primaryStep = failureStep(); }
  if (created) {
    try {
      step = 'conversion_cleanup';
      operations.step('conversion_cleanup');
      await operations.remove(name);
      cleaned = true;
    } catch (error) {
      if (!primary) { primary = error; primaryStep = failureStep(); }
    }
  }
  // Even after a primary failure, successful cleanup must verify the original
  // six-component baseline. A comparison/cleanup error never masks that primary.
  if (baseline && (!created || cleaned)) {
    try {
      step = 'conversion_compare_all_stores';
      operations.step('conversion_compare_all_stores');
      await operations.assertStopped();
      const restored = await operations.snapshot();
      operations.step('conversion_compare_all_stores');
      assertRecoverySnapshots(baseline, restored);
    } catch (error) {
      if (!primary) { primary = error; primaryStep = failureStep(); }
    }
  }
  if (primary) {
    operations.step(primaryStep);
    throw primary;
  }
}

export function conversionProbeFailure(error, phase) {
  const codes = {
    invalid_probe_configuration: 'configuration_invalid',
    logical_snapshot_conversion_writers_active: 'writers_active',
    logical_snapshot_conversion_presence_failed: 'catalog_absent',
    logical_snapshot_conversion_not_rejected: 'conversion_not_rejected',
    invalid_probe_snapshot: 'snapshot_result_invalid',
    recovery_snapshot_shape_invalid: 'snapshot_shape_invalid',
    restored_snapshot_mismatch: 'snapshot_mismatch',
  };
  const code = error?.code || error?.message;
  const reason = conversionProbeReasons.includes(error?.probeReason) ? error.probeReason : codes[code] || 'internal_error';
  return { phase, reason,
    sqlState: reason === 'psql_failed' ? error?.diagnostic?.sqlState || null : null,
    logicalError: reason === 'cli_failed' ? error?.diagnostic?.logicalSnapshotErrorIdentifier || null : null,
    mismatch: reason === 'snapshot_mismatch' ? error?.snapshotMismatch || null : null };
}

async function main() {
  let configuration;
  let evidenceDirectory;
  let step = 'conversion_validate_fixture';
  const privateEvidence = [];
  try {
    let input = '';
    for await (const part of process.stdin) {
      input += part.toString('utf8');
      if (input.length > 64 * 1024) throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: 'configuration_input_limit_exceeded' });
    }
    try { configuration = JSON.parse(input); }
    catch { throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: 'configuration_json_invalid' }); }
    assertConversionFixtureConfiguration(configuration, process.env);
    step = 'conversion_validate_lease';
    if (process.platform !== 'linux' || process.getuid() !== 0) {
      throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: 'platform_or_uid_invalid' });
    }
    const lockPath = process.env.PORTAL_OPERATION_LOCK;
    let lease; let lock;
    try { lease = fstatSync(9, { bigint: true }); lock = lstatSync(lockPath, { bigint: true }); }
    catch { throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: 'lease_unavailable' }); }
    if (lease.dev !== lock.dev || lease.ino !== lock.ino || !lock.isFile() || !lease.isFile()) {
      throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: 'lease_identity_mismatch' });
    }
    if (lock.uid !== 0n || (lock.mode & 0o022n) !== 0n) {
      throw Object.assign(new Error('invalid_probe_configuration'), { probeReason: 'lease_permissions_invalid' });
    }
    evidenceDirectory = configuration.runtimeDirectory;
    const repository = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' };
    const run = (command, args, options = {}, failureReason = 'compose_failed') => {
      const evidenceCount = privateEvidence.length;
      try {
        return runFixtureCommand(command, args, {
          env, ...options, substep: step, privateCommandEvidence: privateEvidence, preservePrivateErrorEvidence: true,
        });
      } catch (error) {
        const ownEvidence = privateEvidence.length > evidenceCount ? privateEvidence.at(-1) : null;
        error.probeReason = error.diagnostic?.commandError
          || (error.diagnostic?.commandSignal ? 'command_signaled' : conversionCliLaunchReason(ownEvidence?.stderr, {
            context: options.logicalSnapshotCommandContext, status: error.diagnostic?.commandExitCode,
          }) || failureReason);
        throw error;
      }
    };
    const compose = (args, options, failureReason) => run('docker', ['compose', ...configuration.composeArgs, ...args], options, failureReason);
    const sql = statement => compose(['exec', '-T', 'postgres', 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
      '-v', 'VERBOSITY=sqlstate', '--dbname=portal', '--username=portal_admin'], { input: statement, sqlCommandContext: true }, 'psql_failed');
    const database = (service, db, user, prefix, component) => {
      step = prefix === 'reject' ? 'conversion_reject_sql' : `conversion_${prefix}_${component}_sql`;
      const capture = compose(['exec', '-T', service, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
        '-v', 'VERBOSITY=sqlstate', `--dbname=${db}`, `--username=${user}`], {
        input: logicalSnapshotScript, maxBuffer: LOGICAL_SNAPSHOT_MAX_BYTES, sqlCommandContext: true,
      }, 'psql_failed');
      step = prefix === 'reject' ? 'conversion_reject_cli' : `conversion_${prefix}_${component}_cli`;
      const result = run(process.execPath, ['--import',
        pathToFileURL(path.join(repository, 'cms', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
        path.join(repository, 'scripts', 'integration', 'payload-logical-snapshot-cli.mjs')], {
        input: capture, maxBuffer: 64 * 1024, logicalSnapshotCommandContext: 'logical-snapshot-cli',
      }, 'cli_failed');
      let parsed;
      try { parsed = JSON.parse(result.toString('utf8')); }
      catch { throw new Error('invalid_probe_snapshot'); }
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'data,schema'
          || !/^[0-9a-f]{64}$/u.test(parsed.data) || !/^[0-9a-f]{64}$/u.test(parsed.schema)) throw new Error('invalid_probe_snapshot');
      return parsed;
    };
    const storage = (service, directory, prefix, component) => {
      step = `conversion_${prefix}_${component}_archive`;
      const archive = compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'tar', service, '-cf', '-', '-C', directory, '.']);
      const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('conversion_storage',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(module._tar_tree(sys.stdin.buffer,compressed=False))`;
      step = `conversion_${prefix}_${component}_storage`;
      return run(configuration.python, ['-c', code, path.join(configuration.runtimeDirectory, 'payload-control-runtime.py')], { input: archive }, 'storage_failed').toString('utf8').trim();
    };
    const assertStopped = () => {
      step = step === 'conversion_baseline' ? 'conversion_baseline_writers' : 'conversion_compare_writers';
      const running = compose(['ps', '--status', 'running', '--services']).toString('utf8').trim().split(/\r?\n/u);
      if (running.some(service => ['api','cron','cms','cms-worker'].includes(service))) throw new FixtureFailure('logical_snapshot_conversion_writers_active');
    };
    const snapshot = () => {
      const prefix = step.startsWith('conversion_baseline') ? 'baseline' : 'compare';
      const portal = database('postgres', 'portal', 'portal_admin', prefix, 'portal');
      const cms = database('cms-postgres', 'ownerinc_cms', 'cms_admin', prefix, 'cms');
      return { portalDatabase: portal.data, portalSchema: portal.schema, cmsDatabase: cms.data, cmsSchema: cms.schema,
        portalUploads: storage('api', '/app/uploads', prefix, 'portal'), cmsUploads: storage('cms', '/var/lib/ownerinc-cms/media', prefix, 'cms') };
    };
    await verifyLinuxConversionPrerequisite({
      step: value => { step = value; }, failureStep: () => step, assertStopped, snapshot,
      create: name => sql(`CREATE CONVERSION public."${name}" FOR 'UTF8' TO 'LATIN1' FROM pg_catalog.utf8_to_iso8859_1;`),
      present: name => sql(`SELECT count(*)::text FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname='public' AND c.conname='${name}' AND c.conforencoding=pg_char_to_encoding('UTF8')
          AND c.contoencoding=pg_char_to_encoding('LATIN1') AND c.conproc='pg_catalog.utf8_to_iso8859_1'::regproc;`).toString('utf8').trim() === '1',
      captureActual: () => database('postgres', 'portal', 'portal_admin', 'reject', 'portal'),
      remove: name => sql(`DROP CONVERSION public."${name}";`),
    });
    process.stdout.write(CONVERSION_PROBE_SUCCESS);
  } catch (error) {
    if (evidenceDirectory) await persistPrivateCommandEvidence(evidenceDirectory, privateEvidence).catch(() => false);
    // Only finite stage metadata leaves the probe; driver/DDL details stay private.
    if (step === 'conversion_validate_fixture' && !conversionProbeReasons.includes(error?.probeReason)) error.probeReason = 'configuration_invalid';
    process.stderr.write(encodeConversionProbeFailure(conversionProbeFailure(error, step)));
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();

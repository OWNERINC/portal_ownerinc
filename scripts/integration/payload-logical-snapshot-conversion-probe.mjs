import { randomUUID } from 'node:crypto';
import { fstatSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FixtureFailure, runFixtureCommand, persistPrivateCommandEvidence } from './payload-preauthority-command.mjs';
import { logicalSnapshotScript, LOGICAL_SNAPSHOT_MAX_BYTES } from './payload-logical-snapshot.mjs';
import { assertRecoverySnapshots } from './payload-preauthority-snapshot.mjs';

/** Exact arguments of the existing source fixture, never an arbitrary Compose
 * project/release accepted merely because the environment says "source". */
export function assertConversionFixtureConfiguration(configuration, environment) {
  const p = path.posix;
  if (!configuration || typeof configuration.runtimeDirectory !== 'string'
      || !p.isAbsolute(configuration.runtimeDirectory) || p.resolve(configuration.runtimeDirectory) !== configuration.runtimeDirectory
      || p.basename(configuration.runtimeDirectory) !== 'runtime'
      || p.basename(p.dirname(configuration.runtimeDirectory)) !== 'source'
      || typeof configuration.project !== 'string' || !/^payload-preauth-[a-z0-9-]+-source$/u.test(configuration.project)
      || environment.COMPOSE_PROJECT_NAME !== configuration.project
      || environment.PORTAL_OPERATION_LOCK !== p.join(configuration.runtimeDirectory, 'deploy.lock')
      || environment.PORTAL_OPERATION_LOCK_HELD !== environment.PORTAL_OPERATION_LOCK
      || typeof configuration.python !== 'string' || !configuration.python || configuration.python.includes('\0')) {
    throw new Error('invalid_probe_configuration');
  }
  const release = p.join(p.dirname(configuration.runtimeDirectory), 'releases', 'payload-candidate');
  const expected = ['--profile', 'notifications', '--env-file', p.join(configuration.runtimeDirectory, 'fixture.runtime.conf'),
    '--env-file', p.join(release, '.image-env'), '-f', p.join(release, 'docker-compose.yml'),
    '-f', p.join(release, 'docker-compose.payload.yml'), '-f', p.join(configuration.runtimeDirectory, 'compose.fixture.yaml'),
    '-f', p.join(configuration.runtimeDirectory, 'compose.payload.production.yaml'), '--project-name', configuration.project,
    '--project-directory', release];
  if (!Array.isArray(configuration.composeArgs) || configuration.composeArgs.length !== expected.length
      || expected.some((value, index) => configuration.composeArgs[index] !== value)) throw new Error('invalid_probe_configuration');
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
          || error.diagnostic?.commandError || error.diagnostic?.logicalSnapshotErrorIdentifier !== 'logical_snapshot_unsupported_object') throw error;
      rejected = true;
    }
    if (!rejected) throw new FixtureFailure('logical_snapshot_conversion_not_rejected');
  } catch (error) { primary = error; primaryStep = step; }
  if (created) {
    try {
      operations.step('conversion_cleanup');
      await operations.remove(name);
      cleaned = true;
    } catch (error) {
      if (!primary) { primary = error; primaryStep = 'conversion_cleanup'; }
    }
  }
  // Even after a primary failure, successful cleanup must verify the original
  // six-component baseline. A comparison/cleanup error never masks that primary.
  if (baseline && (!created || cleaned)) {
    try {
      operations.step('conversion_compare_all_stores');
      await operations.assertStopped();
      const restored = await operations.snapshot();
      assertRecoverySnapshots(baseline, restored);
    } catch (error) {
      if (!primary) { primary = error; primaryStep = 'conversion_compare_all_stores'; }
    }
  }
  if (primary) {
    operations.step(primaryStep);
    throw primary;
  }
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
      if (input.length > 64 * 1024) throw new Error('invalid_probe_configuration');
    }
    configuration = JSON.parse(input);
    assertConversionFixtureConfiguration(configuration, process.env);
    const lockPath = process.env.PORTAL_OPERATION_LOCK;
    const lease = fstatSync(9); const lock = lstatSync(lockPath);
    if (process.platform !== 'linux' || process.getuid() !== 0
        || lease.dev !== lock.dev || lease.ino !== lock.ino || lock.uid !== 0
        || !lock.isFile() || !lease.isFile() || (lock.mode & 0o022) !== 0) throw new Error('invalid_probe_configuration');
    evidenceDirectory = configuration.runtimeDirectory;
    const repository = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' };
    const run = (command, args, options = {}) => runFixtureCommand(command, args, {
      env, ...options, substep: step, privateCommandEvidence: privateEvidence, preservePrivateErrorEvidence: true,
    });
    const compose = (args, options) => run('docker', ['compose', ...configuration.composeArgs, ...args], options);
    const sql = statement => compose(['exec', '-T', 'postgres', 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
      '-v', 'VERBOSITY=sqlstate', '--dbname=portal', '--username=portal_admin'], { input: statement, sqlCommandContext: true });
    const database = (service, db, user) => {
      const capture = compose(['exec', '-T', service, 'psql', '-XAtq', '-v', 'ON_ERROR_STOP=1',
        '-v', 'VERBOSITY=sqlstate', `--dbname=${db}`, `--username=${user}`], {
        input: logicalSnapshotScript, maxBuffer: LOGICAL_SNAPSHOT_MAX_BYTES, sqlCommandContext: true,
      });
      const result = run(process.execPath, ['--import',
        pathToFileURL(path.join(repository, 'cms', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href,
        path.join(repository, 'scripts', 'integration', 'payload-logical-snapshot-cli.mjs')], {
        input: capture, maxBuffer: 64 * 1024, logicalSnapshotCommandContext: 'logical-snapshot-cli',
      });
      const parsed = JSON.parse(result.toString('utf8'));
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'data,schema'
          || !/^[0-9a-f]{64}$/u.test(parsed.data) || !/^[0-9a-f]{64}$/u.test(parsed.schema)) throw new Error('invalid_probe_snapshot');
      return parsed;
    };
    const storage = (service, directory) => {
      const archive = compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'tar', service, '-cf', '-', '-C', directory, '.']);
      const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('conversion_storage',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(module._tar_tree(sys.stdin.buffer,compressed=False))`;
      return run(configuration.python, ['-c', code, path.join(configuration.runtimeDirectory, 'payload-control-runtime.py')], { input: archive }).toString('utf8').trim();
    };
    const assertStopped = () => {
      const running = compose(['ps', '--status', 'running', '--services']).toString('utf8').trim().split(/\r?\n/u);
      if (running.some(service => ['api','cron','cms','cms-worker'].includes(service))) throw new FixtureFailure('logical_snapshot_conversion_writers_active');
    };
    const snapshot = () => {
      const portal = database('postgres', 'portal', 'portal_admin');
      const cms = database('cms-postgres', 'ownerinc_cms', 'cms_admin');
      return { portalDatabase: portal.data, portalSchema: portal.schema, cmsDatabase: cms.data, cmsSchema: cms.schema,
        portalUploads: storage('api', '/app/uploads'), cmsUploads: storage('cms', '/var/lib/ownerinc-cms/media') };
    };
    await verifyLinuxConversionPrerequisite({
      step: value => { step = value; }, assertStopped, snapshot,
      create: name => sql(`CREATE CONVERSION public."${name}" FOR 'UTF8' TO 'LATIN1' FROM pg_catalog.utf8_to_iso8859_1;`),
      present: name => sql(`SELECT count(*)::text FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname='public' AND c.conname='${name}' AND c.conforencoding=pg_char_to_encoding('UTF8')
          AND c.contoencoding=pg_char_to_encoding('LATIN1') AND c.conproc='pg_catalog.utf8_to_iso8859_1'::regproc;`).toString('utf8').trim() === '1',
      captureActual: () => database('postgres', 'portal', 'portal_admin'),
      remove: name => sql(`DROP CONVERSION public."${name}";`),
    });
    process.stdout.write('PAYLOAD_LINUX_CONVERSION_PREREQUISITE passed\n');
  } catch (error) {
    if (evidenceDirectory) await persistPrivateCommandEvidence(evidenceDirectory, privateEvidence).catch(() => false);
    // Only finite stage metadata leaves the probe; driver/DDL details stay private.
    process.stderr.write(`PAYLOAD_LINUX_CONVERSION_PREREQUISITE failed step=${step}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
